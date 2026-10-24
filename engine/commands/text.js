// Reading and filtering text: cat, less, head, tail, wc, grep, sort, uniq, cut, diff, echo.

import { parseArgs, readInputs, lines, toRegExp } from './util.js';

export function cat(ctx) {
  const { flags, rest } = parseArgs(ctx.args);
  const inputs = readInputs(ctx, rest);
  let n = 1;
  for (const { text } of inputs) {
    if (flags.has('n')) {
      for (const l of lines(text)) ctx.out(`${String(n++).padStart(6)}\t${l}\n`);
    } else {
      ctx.out(text);
    }
  }
  if (inputs.some(({ text }) => text.includes('#SBATCH'))) {
    ctx.coach('cat-sbatch', 'Lines starting with `#SBATCH` ask Slurm for resources: GPUs, memory, and time.');
  }
  return ctx.failed ? 1 : 0;
}

export function less(ctx) {
  const code = cat(ctx);
  if (!ctx.piped) {
    ctx.coach('less', `On the real server \`${ctx.name}\` opens a scrolling viewer: arrows or space to move, \`/word\` to search, \`q\` to quit. Here it prints the whole file.`);
  }
  return code;
}

function headTail(ctx, fromEnd) {
  const { opts, rest } = parseArgs(ctx.args, ['n', 'c']);
  const spec = String(opts.n ?? '10');
  const inputs = readInputs(ctx, rest);
  for (const [i, { name, text }] of inputs.entries()) {
    if (inputs.length > 1) ctx.out(`${i ? '\n' : ''}==> ${name} <==\n`);
    const all = lines(text);
    let pick;
    if (fromEnd) {
      pick = spec.startsWith('+') ? all.slice(Number(spec.slice(1)) - 1) : all.slice(-Number(spec) || all.length);
      if (Number(spec) === 0) pick = [];
    } else {
      pick = spec.startsWith('-') ? all.slice(0, Number(spec)) : all.slice(0, Number(spec));
    }
    if (pick.length) ctx.out(pick.join('\n') + '\n');
  }
  if (fromEnd && (opts.f || ctx.args.includes('-f'))) {
    ctx.coach('tail-f', 'On the real server `tail -f` keeps printing new lines as they arrive. Press Ctrl+C to stop. Here it shows the lines written so far.');
  }
  return ctx.failed ? 1 : 0;
}

export const head = (ctx) => headTail(ctx, false);
export const tail = (ctx) => {
  // -f takes no value but parseArgs would treat it as a flag, which is what we want.
  return headTail(ctx, true);
};

export function wc(ctx) {
  const { flags, rest } = parseArgs(ctx.args);
  const which = ['l', 'w', 'c'].filter((f) => flags.has(f) || (f === 'c' && flags.has('m')));
  const show = which.length ? which : ['l', 'w', 'c'];
  const inputs = readInputs(ctx, rest);
  const totals = { l: 0, w: 0, c: 0 };
  const row = (counts, name) => {
    const nums = show.map((f) => String(counts[f]).padStart(show.length > 1 || rest.length > 1 ? 7 : 1));
    ctx.out(nums.join(' ') + (name ? ' ' + name : '') + '\n');
  };
  for (const { name, text } of inputs) {
    const counts = {
      l: (text.match(/\n/g) || []).length,
      w: text.split(/\s+/).filter(Boolean).length,
      c: new TextEncoder().encode(text).length,
    };
    for (const k in totals) totals[k] += counts[k];
    row(counts, name === '(standard input)' ? '' : name);
  }
  if (inputs.length > 1) row(totals, 'total');
  return ctx.failed ? 1 : 0;
}

export function grep(ctx) {
  const { sh } = ctx;
  const { flags, opts, rest } = parseArgs(ctx.args, ['e', 'm', 'A', 'B', 'C']);
  const pattern = opts.e ?? rest.shift();
  if (pattern === undefined) {
    ctx.err('Usage: grep [OPTION]... PATTERNS [FILE]...\n');
    return 2;
  }
  let source = pattern;
  if (!flags.has('E') && !flags.has('P')) source = source.replace(/\\\|/g, '|').replace(/\\([(){}+?])/g, '$1');
  if (flags.has('F')) source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (flags.has('w')) source = `\\b(?:${source})\\b`;
  if (flags.has('x')) source = `^(?:${source})$`;
  const re = toRegExp(source, flags.has('i') ? 'i' : '');

  let inputs;
  if (flags.has('r') || flags.has('R')) {
    inputs = [];
    for (const start of rest.length ? rest : ['.']) {
      const abs = sh.resolve(start);
      if (!sh.vfs.get(abs)) { ctx.err(`grep: ${start}: No such file or directory\n`); continue; }
      for (const { path, node } of sh.vfs.walk(abs)) {
        if (node.type !== 'file') continue;
        const rel = path.slice(abs.length).replace(/^\//, '');
        const shown = rel ? (start === '.' && !rest.length ? rel : start.replace(/\/$/, '') + '/' + rel) : start;
        inputs.push({ name: shown, text: node.content });
      }
    }
  } else {
    inputs = [];
    for (const f of rest.length ? rest : []) {
      const node = sh.vfs.get(sh.resolve(f));
      if (!node) { ctx.err(`grep: ${f}: No such file or directory\n`); ctx.failed = true; continue; }
      if (node.type === 'dir') {
        ctx.err(`grep: ${f}: Is a directory\n`);
        ctx.coach('grep-dir', 'To search every file inside a folder, add `-r`: `grep -r "text" folder/`.');
        continue;
      }
      inputs.push({ name: f, text: node.content });
    }
    if (!rest.length) inputs = readInputs(ctx, []);
  }

  const prefix = inputs.length > 1 || flags.has('r') || flags.has('R');
  const prefixName = prefix && !flags.has('h');
  let matched = false;
  const max = opts.m ? Number(opts.m) : Infinity;
  for (const { name, text } of inputs) {
    let count = 0;
    for (const [i, l] of lines(text).entries()) {
      if (count >= max) break;
      if (re.test(l) !== flags.has('v')) {
        count++;
        matched = true;
        if (flags.has('c') || flags.has('l') || flags.has('q')) continue;
        ctx.out((prefixName ? name + ':' : '') + (flags.has('n') ? `${i + 1}:` : '') + l + '\n');
      }
    }
    if (flags.has('c')) ctx.out((prefixName ? name + ':' : '') + count + '\n');
    if (flags.has('l') && count) ctx.out(name + '\n');
  }
  if (ctx.failed) return 2;
  return matched ? 0 : 1;
}

export function sort(ctx) {
  const { flags, opts, rest } = parseArgs(ctx.args, ['k', 't', 'o']);
  const inputs = readInputs(ctx, rest);
  let all = inputs.flatMap((i) => lines(i.text));
  const sep = opts.t;
  const keyCol = opts.k ? parseInt(opts.k, 10) : null;
  const numeric = flags.has('n') || flags.has('g') || /n|g/.test(opts.k ?? '');
  const reverse = flags.has('r') || /r/.test(opts.k ?? '');
  const key = (l) => {
    if (!keyCol) return l;
    const fields = sep ? l.split(sep) : l.trim().split(/\s+/);
    return fields[keyCol - 1] ?? '';
  };
  all.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (numeric) {
      const d = (parseFloat(ka) || 0) - (parseFloat(kb) || 0);
      if (d) return d;
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  if (reverse) all.reverse();
  if (flags.has('u')) all = all.filter((l, i) => i === 0 || key(l) !== key(all[i - 1]));
  const text = all.length ? all.join('\n') + '\n' : '';
  if (opts.o) ctx.sh.vfs.writeFile(ctx.sh.resolve(opts.o), text, { mtime: ctx.sh.cluster.clock() });
  else ctx.out(text);
  return ctx.failed ? 2 : 0;
}

export function uniq(ctx) {
  const { flags, rest } = parseArgs(ctx.args);
  const inputs = readInputs(ctx, rest.slice(0, 1));
  const all = inputs.flatMap((i) => lines(i.text));
  const groups = [];
  for (const l of all) {
    if (groups.length && groups.at(-1).line === l) groups.at(-1).n++;
    else groups.push({ line: l, n: 1 });
  }
  for (const g of groups) {
    if (flags.has('d') && g.n < 2) continue;
    if (flags.has('u') && g.n > 1) continue;
    ctx.out((flags.has('c') ? String(g.n).padStart(7) + ' ' : '') + g.line + '\n');
  }
  return ctx.failed ? 1 : 0;
}

export function cut(ctx) {
  const { opts, rest } = parseArgs(ctx.args, ['d', 'f', 'c']);
  if (!opts.f && !opts.c) {
    ctx.err('cut: you must specify a list of bytes, characters, or fields\n');
    return 1;
  }
  const ranges = String(opts.f ?? opts.c).split(',').map((r) => {
    const [a, b] = r.split('-');
    return [a ? Number(a) : 1, b === undefined ? Number(a) : b ? Number(b) : Infinity];
  });
  const want = (n) => ranges.some(([a, b]) => n >= a && n <= b);
  const sep = opts.d ?? '\t';
  for (const { text } of readInputs(ctx, rest)) {
    for (const l of lines(text)) {
      if (opts.c) {
        ctx.out([...l].filter((_, i) => want(i + 1)).join('') + '\n');
      } else if (!l.includes(sep)) {
        ctx.out(l + '\n');
      } else {
        ctx.out(l.split(sep).filter((_, i) => want(i + 1)).join(sep) + '\n');
      }
    }
  }
  if (!opts.d && !opts.c) {
    ctx.coach('cut-d', 'Without `-d`, `cut` splits on tabs. For files separated by spaces or commas, add `-d " "` or `-d ","`.');
  }
  return ctx.failed ? 1 : 0;
}

export function diff(ctx) {
  const { rest } = parseArgs(ctx.args);
  if (rest.length !== 2) { ctx.err(`diff: missing operand after '${rest[0] ?? 'diff'}'\n`); return 2; }
  const inputs = readInputs(ctx, rest);
  if (inputs.length !== 2) return 2;
  const a = lines(inputs[0].text);
  const b = lines(inputs[1].text);
  // Longest common subsequence, then print changed hunks in normal diff format.
  const m = a.length;
  const n = b.length;
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0;
  let j = 0;
  let same = true;
  const range = (s, e) => (e - s > 1 ? `${s + 1},${e}` : `${e}`);
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { i++; j++; continue; }
    const si = i;
    const sj = j;
    while ((i < m || j < n) && !(i < m && j < n && a[i] === b[j])) {
      if (j >= n || (i < m && L[i + 1][j] >= L[i][j + 1])) i++;
      else j++;
    }
    same = false;
    const op = si === i ? 'a' : sj === j ? 'd' : 'c';
    const left = op === 'a' ? `${si}` : range(si, i);
    const right = op === 'd' ? `${sj}` : range(sj, j);
    ctx.out(`${left}${op}${right}\n`);
    for (let k = si; k < i; k++) ctx.out(`< ${a[k]}\n`, 'err');
    if (op === 'c') ctx.out('---\n');
    for (let k = sj; k < j; k++) ctx.out(`> ${b[k]}\n`, 'ok');
  }
  return same ? 0 : 1;
}

export function echo(ctx) {
  let args = ctx.args;
  let newline = true;
  if (args[0] === '-n') { newline = false; args = args.slice(1); }
  ctx.out(args.join(' ') + (newline ? '\n' : ''));
}
