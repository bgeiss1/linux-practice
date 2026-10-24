// Moving around and changing files: pwd, cd, ls, mkdir, touch, rm, cp, mv, chmod, find.

import { ShellError, VFS, basename, dirname } from '../vfs.js';
import { globToRegExp } from '../parser.js';
import { parseArgs, fmtDate, fmtMode, human, sizeOf, classOf, missingTip } from './util.js';

export function pwd(ctx) {
  ctx.out(ctx.sh.cwd + '\n');
}

export function cd(ctx) {
  const { sh } = ctx;
  const { rest } = parseArgs(ctx.args);
  if (rest.length > 1) {
    ctx.err('bash: cd: too many arguments\n');
    ctx.coach('cd-many', 'A folder name with a space needs quotes: `cd "run 1"`.');
    return 1;
  }
  let target = rest[0] ?? '~';
  if (target === '-') {
    if (!sh.prevCwd) { ctx.err('bash: cd: OLDPWD not set\n'); return 1; }
    target = sh.prevCwd;
    ctx.out(target + '\n');
  }
  const abs = sh.resolve(target);
  const node = sh.vfs.get(abs);
  if (!node) {
    ctx.err(`bash: cd: ${rest[0]}: No such file or directory\n`);
    missingTip(ctx, rest[0]);
    return 1;
  }
  if (node.type !== 'dir') {
    ctx.err(`bash: cd: ${rest[0]}: Not a directory\n`);
    ctx.coach('cd-file', `\`${rest[0]}\` is a file, not a folder. Read files with \`cat\` or \`less\`, and enter folders with \`cd\`.`);
    return 1;
  }
  sh.prevCwd = sh.cwd;
  sh.cwd = abs;
}

export function ls(ctx) {
  const { sh } = ctx;
  const { flags, rest } = parseArgs(ctx.args);
  const all = flags.has('a');
  const almost = flags.has('A');
  const long = flags.has('l');
  const one = flags.has('1') || ctx.piped;
  const targets = rest.length ? rest : ['.'];
  let code = 0;

  const sortNames = (dirNode, names) => {
    if (flags.has('t')) names.sort((a, b) => dirNode.children[b].mtime - dirNode.children[a].mtime);
    if (flags.has('S')) names.sort((a, b) => sizeOf(dirNode.children[b]) - sizeOf(dirNode.children[a]));
    if (flags.has('r')) names.reverse();
    return names;
  };

  const printEntries = (entries) => {
    if (long) {
      const blocks = entries.reduce((n, e) => n + Math.ceil(sizeOf(e.node) / 4096) * 4, 0);
      if (entries.showTotal) ctx.out(`total ${blocks}\n`);
      for (const { name, node } of entries) {
        const size = flags.has('h') ? human(sizeOf(node)) : String(sizeOf(node));
        ctx.out(`${fmtMode(node)} 1 ${sh.user} mip662 ${size.padStart(flags.has('h') ? 5 : 8)} ${fmtDate(node.mtime)} `);
        ctx.out(name, classOf(node));
        ctx.out('\n');
      }
      return;
    }
    entries.forEach(({ name, node }, i) => {
      ctx.out(name, classOf(node));
      ctx.out(one || i === entries.length - 1 ? '\n' : '  ');
    });
  };

  const listDir = (abs, label, showHeader) => {
    const dirNode = sh.vfs.get(abs);
    let names = Object.keys(dirNode.children).sort((a, b) => a.localeCompare(b));
    if (!all && !almost) names = names.filter((n) => !n.startsWith('.'));
    names = sortNames(dirNode, names);
    const entries = names.map((name) => ({ name, node: dirNode.children[name] }));
    if (all) {
      entries.unshift({ name: '..', node: sh.vfs.get(dirname(abs)) }, { name: '.', node: dirNode });
      [entries[0], entries[1]] = [entries[1], entries[0]];
    }
    entries.showTotal = true;
    if (showHeader) ctx.out(`${label}:\n`);
    printEntries(entries);
    if (flags.has('R')) {
      for (const name of names) {
        if (dirNode.children[name].type === 'dir') {
          ctx.out('\n');
          listDir(abs === '/' ? '/' + name : abs + '/' + name, label === '.' ? './' + name : label.replace(/\/$/, '') + '/' + name, true);
        }
      }
    }
  };

  const files = [];
  const dirs = [];
  for (const t of targets) {
    const abs = sh.resolve(t);
    const node = sh.vfs.get(abs);
    if (!node) {
      ctx.err(`ls: cannot access '${t}': No such file or directory\n`);
      missingTip(ctx, t);
      code = 2;
    } else if (node.type === 'dir' && !flags.has('d')) {
      dirs.push({ t, abs });
    } else {
      files.push({ name: t, node });
    }
  }
  if (files.length) printEntries(files);
  const many = targets.length > 1 || flags.has('R');
  dirs.forEach(({ t, abs }, i) => {
    if (i > 0 || files.length) ctx.out('\n');
    listDir(abs, t, many);
  });
  return code;
}

export function mkdir(ctx) {
  const { sh } = ctx;
  const { flags, rest } = parseArgs(ctx.args);
  if (!rest.length) { ctx.err('mkdir: missing operand\n'); return 1; }
  let code = 0;
  for (const p of rest) {
    const abs = sh.resolve(p);
    try {
      if (flags.has('p') && sh.vfs.get(abs)?.type === 'dir') continue;
      sh.vfs.mkdir(abs, { parents: flags.has('p'), mtime: sh.cluster.clock() });
      if (flags.has('v')) ctx.out(`mkdir: created directory '${p}'\n`);
    } catch (e) {
      ctx.err(`mkdir: cannot create directory '${p}': ${e.message}\n`);
      if (e.code === 'ENOENT') ctx.coach('mkdir-p', 'The folder above it doesn\'t exist yet. `mkdir -p` creates every missing folder along the path.');
      code = 1;
    }
  }
  return code;
}

export function rmdir(ctx) {
  const { sh } = ctx;
  let code = 0;
  for (const p of parseArgs(ctx.args).rest) {
    const abs = sh.resolve(p);
    const node = sh.vfs.get(abs);
    if (!node) { ctx.err(`rmdir: failed to remove '${p}': No such file or directory\n`); code = 1; continue; }
    if (node.type !== 'dir') { ctx.err(`rmdir: failed to remove '${p}': Not a directory\n`); code = 1; continue; }
    if (Object.keys(node.children).length) {
      ctx.err(`rmdir: failed to remove '${p}': Directory not empty\n`);
      ctx.coach('rmdir', '`rmdir` only removes empty folders. `rm -r` removes a folder and everything in it, so check with `ls` first.');
      code = 1;
      continue;
    }
    sh.vfs.remove(abs);
  }
  return code;
}

export function touch(ctx) {
  const { sh } = ctx;
  const { rest } = parseArgs(ctx.args);
  if (!rest.length) { ctx.err('touch: missing file operand\n'); return 1; }
  let code = 0;
  for (const p of rest) {
    const abs = sh.resolve(p);
    const node = sh.vfs.get(abs);
    if (node) { node.mtime = sh.cluster.clock(); continue; }
    try {
      sh.vfs.writeFile(abs, '', { mtime: sh.cluster.clock() });
    } catch (e) {
      ctx.err(`touch: cannot touch '${p}': ${e.message}\n`);
      code = 1;
    }
  }
  return code;
}

export function rm(ctx) {
  const { sh } = ctx;
  const { flags, rest } = parseArgs(ctx.args);
  const recursive = flags.has('r') || flags.has('R');
  if (!rest.length) { ctx.err('rm: missing operand\n'); return 1; }
  let code = 0;
  for (const p of rest) {
    const abs = sh.resolve(p);
    if (abs === '/' || abs === '/home') {
      ctx.err(`rm: it is dangerous to operate recursively on '${abs}'\nrm: use --no-preserve-root to override this failsafe\n`);
      ctx.coach('rm-root', 'On a shared server this would try to delete everyone\'s files. Nothing happened here, but never run it for real.');
      code = 1;
      continue;
    }
    const node = sh.vfs.get(abs);
    if (!node) {
      if (!flags.has('f')) { ctx.err(`rm: cannot remove '${p}': No such file or directory\n`); code = 1; }
      continue;
    }
    if (node.type === 'dir' && !recursive) {
      ctx.err(`rm: cannot remove '${p}': Is a directory\n`);
      ctx.coach('rm-dir', 'Folders need `rm -r`. Linux has no trash can, so check what\'s inside with `ls` first.');
      code = 1;
      continue;
    }
    if (abs === sh.home || sh.home.startsWith(abs + '/')) {
      node.children = {};
      ctx.coach('rm-home', 'You just deleted everything in your home folder. On Geiss-01 that would be permanent. Click Reset to bring it back here.');
      continue;
    }
    sh.vfs.remove(abs);
    if (sh.cwd === abs || sh.cwd.startsWith(abs + '/')) {
      ctx.coach('rm-cwd', 'You deleted the folder you\'re standing in. `cd ~` takes you somewhere that still exists.');
    }
    if (flags.has('v')) ctx.out(`removed '${p}'\n`);
  }
  return code;
}

function copyOrMove(ctx, move) {
  const { sh } = ctx;
  const name = move ? 'mv' : 'cp';
  const { flags, rest } = parseArgs(ctx.args);
  const recursive = flags.has('r') || flags.has('R') || flags.has('a');
  if (rest.length < 2) {
    ctx.err(rest.length ? `${name}: missing destination file operand after '${rest[0]}'\n` : `${name}: missing file operand\n`);
    ctx.coach(`${name}-args`, `\`${name}\` needs a source and a destination: \`${name} from to\`.`);
    return 1;
  }
  const dest = rest.pop();
  const destAbs = sh.resolve(dest);
  const destNode = sh.vfs.get(destAbs);
  const destIsDir = destNode?.type === 'dir';
  if (rest.length > 1 && !destIsDir) {
    ctx.err(`${name}: target '${dest}' is not a directory\n`);
    return 1;
  }
  let code = 0;
  for (const src of rest) {
    const srcAbs = sh.resolve(src);
    const node = sh.vfs.get(srcAbs);
    if (!node) {
      ctx.err(`${name}: cannot stat '${src}': No such file or directory\n`);
      missingTip(ctx, src);
      code = 1;
      continue;
    }
    if (node.type === 'dir' && !move && !recursive) {
      ctx.err(`cp: -r not specified; omitting directory '${src}'\n`);
      ctx.coach('cp-r', 'Copying a folder needs `cp -r`.');
      code = 1;
      continue;
    }
    const target = destIsDir ? (destAbs === '/' ? '' : destAbs) + '/' + basename(srcAbs) : destAbs;
    if (target === srcAbs) {
      ctx.err(`${name}: '${src}' and '${dest}' are the same file\n`);
      code = 1;
      continue;
    }
    if (node.type === 'dir' && (target + '/').startsWith(srcAbs + '/')) {
      ctx.err(`${name}: cannot ${move ? 'move' : 'copy'} a directory, '${src}', into itself\n`);
      code = 1;
      continue;
    }
    try {
      const copy = move ? node : VFS.clone(node);
      if (!move) touchTree(copy, sh.cluster.clock(), flags.has('p') || flags.has('a'));
      sh.vfs.put(target, copy);
      if (move) sh.vfs.remove(srcAbs);
      if (flags.has('v')) ctx.out(`'${src}' -> '${sh.displayPath(target)}'\n`);
    } catch (e) {
      ctx.err(`${name}: cannot create '${dest}': ${e.message}\n`);
      code = 1;
    }
  }
  return code;
}

function touchTree(node, mtime, preserve) {
  if (preserve) return;
  node.mtime = mtime;
  if (node.type === 'dir') for (const c of Object.values(node.children)) touchTree(c, mtime, preserve);
}

export const cp = (ctx) => copyOrMove(ctx, false);
export const mv = (ctx) => copyOrMove(ctx, true);

export function chmod(ctx) {
  const { sh } = ctx;
  const args = ctx.args.filter((a) => a !== '-R' && a !== '-v');
  const [spec, ...paths] = args;
  if (!spec || !paths.length) { ctx.err('chmod: missing operand\n'); return 1; }
  let code = 0;
  for (const p of paths) {
    const node = sh.vfs.get(sh.resolve(p));
    if (!node) { ctx.err(`chmod: cannot access '${p}': No such file or directory\n`); code = 1; continue; }
    const mode = applyMode(node.mode, spec);
    if (mode === null) { ctx.err(`chmod: invalid mode: '${spec}'\n`); return 1; }
    node.mode = mode;
  }
  return code;
}

function applyMode(mode, spec) {
  if (/^[0-7]{3,4}$/.test(spec)) return parseInt(spec, 8) & 0o777;
  for (const clause of spec.split(',')) {
    const m = clause.match(/^([ugoa]*)([+\-=])([rwx]*)$/);
    if (!m) return null;
    const who = m[1] || 'a';
    let bits = 0;
    for (const p of m[3]) bits |= { r: 4, w: 2, x: 1 }[p];
    let mask = 0;
    if (who.includes('u') || who.includes('a')) mask |= bits << 6;
    if (who.includes('g') || who.includes('a')) mask |= bits << 3;
    if (who.includes('o') || who.includes('a')) mask |= bits;
    if (m[2] === '+') mode |= mask;
    else if (m[2] === '-') mode &= ~mask;
    else {
      let clear = 0;
      if (who.includes('u') || who.includes('a')) clear |= 0o700;
      if (who.includes('g') || who.includes('a')) clear |= 0o070;
      if (who.includes('o') || who.includes('a')) clear |= 0o007;
      mode = (mode & ~clear) | mask;
    }
  }
  return mode;
}

const DAY = 86_400_000;

export function find(ctx) {
  const { sh } = ctx;
  const args = [...ctx.args];
  const starts = [];
  while (args.length && !args[0].startsWith('-') && args[0] !== '!' && args[0] !== '(') starts.push(args.shift());
  if (!starts.length) starts.push('.');

  const tests = [];
  let maxdepth = Infinity;
  let mindepth = 0;
  const now = sh.cluster.clock();
  const cmp = (spec, value) => {
    const n = parseFloat(spec.replace(/^[+-]/, ''));
    if (spec.startsWith('+')) return value > n;
    if (spec.startsWith('-')) return value < n;
    return value === n;
  };
  while (args.length) {
    const opt = args.shift();
    const val = args[0];
    const needVal = () => {
      if (val === undefined) throw new ShellError('ARG', `missing argument to \`${opt}'`);
      return args.shift();
    };
    switch (opt) {
      case '-name': { const re = globToRegExp(needVal()); tests.push((p) => re.test(basename(p) || '/')); break; }
      case '-iname': { const re = new RegExp(globToRegExp(needVal()).source, 'i'); tests.push((p) => re.test(basename(p))); break; }
      case '-path': { const re = new RegExp(globToRegExp(needVal()).source.replace(/\[\^\/\]\*/g, '.*')); tests.push((p, n, shown) => re.test(shown)); break; }
      case '-type': { const t = needVal(); tests.push((p, n) => (t === 'd' ? n.type === 'dir' : n.type === 'file')); break; }
      case '-empty': tests.push((p, n) => (n.type === 'dir' ? !Object.keys(n.children).length : !n.content && !n.size)); break;
      case '-executable': tests.push((p, n) => n.type === 'file' && n.mode & 0o100); break;
      case '-mtime': { const s = needVal(); tests.push((p, n) => cmp(s, Math.floor((now - n.mtime) / DAY))); break; }
      case '-mmin': { const s = needVal(); tests.push((p, n) => cmp(s, Math.ceil((now - n.mtime) / 60_000))); break; }
      case '-size': {
        const s = needVal();
        const m = s.match(/^([+-]?)(\d+)([ckMG]?)$/);
        if (!m) throw new ShellError('ARG', `invalid -size type \`${s}'`);
        const unit = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3, '': 512 }[m[3]];
        tests.push((p, n) => n.type === 'file' && cmp(m[1] + m[2], Math.ceil(VFS.sizeOf(n) / unit)));
        break;
      }
      case '-maxdepth': maxdepth = Number(needVal()); break;
      case '-mindepth': mindepth = Number(needVal()); break;
      case '-print': break;
      default:
        ctx.err(`find: unknown predicate \`${opt}'\n`);
        ctx.coach('find-pred', 'This practice server supports `-name`, `-iname`, `-type`, `-size`, `-mtime`, `-mmin`, `-empty` and `-maxdepth`.');
        return 1;
    }
  }

  let code = 0;
  for (const start of starts) {
    const abs = sh.resolve(start);
    if (!sh.vfs.get(abs)) {
      ctx.err(`find: '${start}': No such file or directory\n`);
      code = 1;
      continue;
    }
    for (const { path, node, depth } of sh.vfs.walk(abs)) {
      if (depth > maxdepth || depth < mindepth) continue;
      const rel = path.slice(abs.length).replace(/^\//, '');
      const shown = rel ? (start.endsWith('/') ? start + rel : start + '/' + rel) : start;
      if (tests.every((t) => t(path, node, shown))) ctx.out(shown + '\n', classOf(node));
    }
  }
  return code;
}
