// Students' own Python scripts. Nothing really runs: a script's imports are
// checked against the Python that would run it, simple print-only scripts
// print, and a scenario's "pythonRules" give everything else realistic
// output, usage errors and tracebacks.
//
//   "pythonRules": [{
//     "match": "count_residues.py",            the script (end of its path)
//     "args": 1, "usage": "usage: ...",        too few arguments: argparse-style error
//     "inputs": [1], "outDir": 2,              argument N must be a file / an existing folder
//     "out": "Read $1: 120 residues\n",        what it prints ($1, $2 = its arguments)
//     "creates": { "$2/a.fa": ">a\nMK\n" },    files it writes (relative to the folder it ran in)
//     "error": { "line": 14, "type": "KeyError", "message": "'pLDDT'" }   it crashes
//   }]

import { CONDA_ENVS } from '../cluster.js';

const STDLIB = new Set(['sys', 'os', 're', 'csv', 'json', 'math', 'glob', 'argparse', 'pathlib', 'collections', 'random', 'time', 'subprocess', 'shutil', 'itertools', 'statistics', 'string', 'datetime', 'gzip', 'typing', 'functools', 'textwrap', 'io', 'tempfile', 'logging', 'pickle', 'copy', 'operator', 'heapq', 'bisect', 'zipfile', 'tarfile', 'urllib', 'hashlib', '__future__', 'dataclasses', 'enum', 'pprint', 'warnings', 'traceback', 'fnmatch', 'unittest']);

// What each Python can import besides the standard library.
const ANACONDA = ['numpy', 'pandas', 'Bio', 'matplotlib', 'scipy', 'seaborn', 'sklearn', 'requests', 'yaml', 'tqdm'];

export function packagesFor(cluster) {
  if (cluster.condaEnv && cluster.condaEnv !== 'base') return new Set(CONDA_ENVS[cluster.condaEnv]?.packages ?? []);
  if (cluster.condaEnv === 'base' || cluster.modules.includes('anaconda')) return new Set(ANACONDA);
  return new Set(); // /usr/bin/python3: the standard library only
}

// The modules a script imports, with the line each import is on.
function importsOf(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*(?:import\s+([\w.]+(?:\s*,\s*[\w.]+)*)|from\s+([\w.]+)\s+import\b)/);
    if (!m) return;
    for (const name of (m[1] ?? m[2]).split(',')) found.push({ module: name.trim().split('.')[0], line: i + 1, text: line.trim() });
  });
  return found;
}

function traceback(ctx, file, line, source, type, message) {
  ctx.err(`Traceback (most recent call last):\n  File "${file}", line ${line}, in <module>\n${source ? `    ${source}\n` : ''}${type}: ${message}\n`);
  return 1;
}

const sub = (text, args) => String(text).replace(/\$(\d)/g, (_, n) => args[Number(n) - 1] ?? '');

// A script that only prints string literals (or sys.argv[N]) can run for real.
function simplePrints(text, args, file) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^(import|from)\s/.test(line)) continue;
    if (/^print\(\s*\)$/.test(line)) { out.push(''); continue; }
    const lit = line.match(/^print\(\s*(?:f)?(['"])(.*)\1\s*\)$/);
    if (lit) { out.push(lit[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t')); continue; }
    const num = line.match(/^print\(\s*([\d\s+\-*/().]+)\s*\)$/);
    if (num && /\d/.test(num[1])) {
      try {
        const v = Function(`"use strict"; return (${num[1]});`)();
        out.push(Number.isInteger(v) && !num[1].includes('/') ? String(v) : String(Number.isInteger(v) ? v.toFixed(1) : v));
        continue;
      } catch {
        return null;
      }
    }
    const argv = line.match(/^print\(\s*sys\.argv\[(\d+)\]\s*\)$/);
    if (argv && !/^\s*import\s+sys\b/m.test(text)) {
      return { error: { line: text.split('\n').indexOf(raw) + 1, source: line, type: 'NameError', message: "name 'sys' is not defined" } };
    }
    if (argv) {
      const n = Number(argv[1]);
      if (n === 0) { out.push(file); continue; }
      if (args[n - 1] === undefined) return { error: { line: text.split('\n').indexOf(raw) + 1, source: line, type: 'IndexError', message: 'list index out of range' } };
      out.push(args[n - 1]);
      continue;
    }
    return null;
  }
  return { out };
}

// Run a script the student wrote or was given. file is the path as typed.
export function runUserScript(ctx, abs, file, args) {
  const { sh } = ctx;
  const { cluster } = sh;
  const text = sh.vfs.get(abs)?.content ?? '';

  // Imports first: that's where a script fails if the wrong Python runs it.
  const have = packagesFor(cluster);
  for (const imp of importsOf(text)) {
    if (STDLIB.has(imp.module) || have.has(imp.module)) continue;
    traceback(ctx, file, imp.line, imp.text, 'ModuleNotFoundError', `No module named '${imp.module}'`);
    const fix = ANACONDA.includes(imp.module)
      ? `\`${imp.module}\` isn't installed for this Python. It comes with anaconda: run \`module load anaconda\` (and \`conda activate base\` if another environment is active), then run the script again.`
      : `No Python here has \`${imp.module}\`. Check which environment the script needs.`;
    ctx.coach('py-module', fix);
    return 1;
  }

  const rule = (cluster.pythonRules ?? []).find((r) => abs.endsWith('/' + r.match) || abs === r.match || file === r.match);
  if (rule) return runRule(ctx, rule, file, args);

  const simple = simplePrints(text, args, file);
  if (simple?.error) return traceback(ctx, file, simple.error.line, simple.error.source, simple.error.type, simple.error.message);
  if (simple) {
    ctx.out(simple.out.map((l) => l + '\n').join(''));
    return 0;
  }
  ctx.out(`(practice site: Python code doesn't really run here, so ${file.split('/').pop()} printed nothing. Its imports were fine.)\n`, 'dim');
  return 0;
}

function runRule(ctx, rule, file, args) {
  const { sh } = ctx;
  const name = file.split('/').pop();
  const need = Number(rule.args ?? 0);
  if (args.length < need || args.some((a) => a === '-h' || a === '--help')) {
    const usage = rule.usage ?? `usage: ${name} ${Array.from({ length: need }, (_, i) => `ARG${i + 1}`).join(' ')}`;
    if (args.some((a) => a === '-h' || a === '--help')) {
      ctx.out(usage + '\n' + (rule.help ? '\n' + rule.help + '\n' : ''));
      return 0;
    }
    const names = usage.replace(/^usage:\s*\S+\s*/, '').replace(/\[[^\]]*\]\s*/g, '').trim().split(/\s+/).slice(args.length);
    ctx.err(`${usage}\n${name}: error: the following arguments are required: ${names.join(', ')}\n`);
    ctx.coach('py-args', `${name} needs ${need} argument${need === 1 ? '' : 's'} after its name. The usage line shows what goes where; \`python3 ${file} -h\` prints the help.`);
    return 2;
  }
  for (const n of rule.inputs ?? []) {
    const p = args[n - 1];
    const node = sh.vfs.get(sh.resolve(p));
    if (!node || node.type !== 'file') {
      const lines = (sh.vfs.get(sh.resolve(file))?.content ?? '').split('\n');
      const at = rule.openLine ?? Math.max(1, lines.findIndex((l) => /open\(|\.parse\(|read_csv\(|\.read\(/.test(l)) + 1);
      traceback(ctx, file, at, (lines[at - 1] ?? '').trim(), node ? 'IsADirectoryError' : 'FileNotFoundError', `[Errno ${node ? 21 : 2}] ${node ? 'Is a directory' : 'No such file or directory'}: '${p}'`);
      ctx.coach('py-input', `The script couldn't open \`${p}\`. Check the name with \`ls\`; paths are relative to the folder you're in (${sh.cwd.replace(sh.home, '~')}).`);
      return 1;
    }
  }
  if (rule.outDir) {
    const p = args[rule.outDir - 1];
    const node = sh.vfs.get(sh.resolve(p));
    if (node?.type !== 'dir') {
      const first = Object.keys(rule.creates ?? {})[0];
      const target = first ? sub(first, args) : `${p}/out.txt`;
      const lines = (sh.vfs.get(sh.resolve(file))?.content ?? '').split('\n');
      const at = rule.writeLine ?? Math.max(1, lines.findIndex((l) => /open\(.*['"]w/.test(l)) + 1);
      traceback(ctx, file, at, (lines[at - 1] ?? '').trim(), 'FileNotFoundError', `[Errno 2] No such file or directory: '${target}'`);
      ctx.coach('py-outdir', `Python won't create the folder \`${p}\` for you. Make it with \`mkdir -p ${p}\`, then run the script again.`);
      return 1;
    }
  }
  if (rule.out) ctx.out(sub(rule.out, args));
  for (const [path, content] of Object.entries(rule.creates ?? {})) {
    sh.vfs.writeFile(sh.resolve(sub(path, args)), sub(content, args), { mtime: sh.cluster.clock() });
  }
  if (rule.error) {
    const lines = (sh.vfs.get(sh.resolve(file))?.content ?? '').split('\n');
    return traceback(ctx, file, rule.error.line, (lines[rule.error.line - 1] ?? '').trim(), rule.error.type ?? 'Exception', rule.error.message ?? '');
  }
  return Number(rule.code ?? 0);
}

// python -c "print('hi')"
export function runSnippet(ctx, code, args) {
  const simple = simplePrints(code.replace(/;\s*/g, '\n'), args, '-c');
  for (const imp of importsOf(code.replace(/;\s*/g, '\n'))) {
    if (STDLIB.has(imp.module) || packagesFor(ctx.sh.cluster).has(imp.module)) continue;
    return traceback(ctx, '<string>', 1, '', 'ModuleNotFoundError', `No module named '${imp.module}'`);
  }
  if (simple?.out) { ctx.out(simple.out.map((l) => l + '\n').join('')); return 0; }
  ctx.out('(practice site: only print("...") one-liners run with -c here)\n', 'dim');
  return 0;
}
