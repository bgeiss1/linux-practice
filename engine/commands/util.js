// Helpers shared by the command implementations.

import { VFS, basename } from '../vfs.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Split arguments into single-letter flags, options with values, and operands.
// valueOpts lists flags that take a value, e.g. ['n'] lets "-n 5" and "-n5" work.
export function parseArgs(args, valueOpts = []) {
  const flags = new Set();
  const opts = {};
  const rest = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (endOfFlags || a === '-' || !a.startsWith('-')) { rest.push(a); continue; }
    if (a === '--') { endOfFlags = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      opts[k] = v ?? true;
      continue;
    }
    if (/^-\d+$/.test(a)) { opts.n = a.slice(1); continue; }
    for (let j = 1; j < a.length; j++) {
      const f = a[j];
      if (valueOpts.includes(f)) {
        opts[f] = a.slice(j + 1) || args[++i];
        break;
      }
      flags.add(f);
    }
  }
  return { flags, opts, rest };
}

export function fmtDate(ms) {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${hh}:${mm}`;
}

export function fmtMode(node) {
  const bits = node.mode;
  const rwx = (n) => (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-');
  const other = rwx(bits & 7);
  // The sticky bit (as on /tmp) shows as t in the last place.
  return (node.type === 'dir' ? 'd' : '-') + rwx((bits >> 6) & 7) + rwx((bits >> 3) & 7) + (bits & 0o1000 ? other.slice(0, 2) + 't' : other);
}

export function human(bytes) {
  if (bytes < 1024) return String(bytes);
  const units = ['K', 'M', 'G', 'T'];
  let v = bytes;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + units[u];
}

export function sizeOf(node) {
  return VFS.sizeOf(node);
}

export function classOf(node) {
  if (node.type === 'dir') return 'dir';
  if (node.mode & 0o111) return 'exe';
  return undefined;
}

// Tell the student about a missing path, with a "did you mean" when we can.
export function missingTip(ctx, arg) {
  const guess = ctx.sh.suggest(arg);
  const name = basename(arg) || arg;
  if (guess && guess !== name) {
    ctx.coach('enoent', `There's nothing called \`${name}\` there. Did you mean \`${guess}\`? Linux names are case-sensitive.`);
  } else {
    ctx.coach('enoent', `There's nothing called \`${arg}\`. Use \`ls\` to see what's in \`${ctx.sh.displayPath(ctx.sh.cwd)}\`.`);
  }
}

// Read named files, or stdin when none are given. Returns [{ name, text }].
export function readInputs(ctx, files) {
  if (!files.length || (files.length === 1 && files[0] === '-')) {
    if (ctx.stdin === null) {
      ctx.coach('stdin', `\`${ctx.name}\` is waiting for input. Give it a file name, like \`${ctx.name} notes.txt\`.`);
      return [];
    }
    return [{ name: '(standard input)', text: ctx.stdin }];
  }
  const inputs = [];
  for (const f of files) {
    const node = ctx.sh.vfs.get(ctx.sh.resolve(f));
    if (!node) {
      ctx.err(`${ctx.name}: ${f}: No such file or directory\n`);
      missingTip(ctx, f);
      ctx.failed = true;
      continue;
    }
    if (node.type === 'dir') {
      ctx.err(`${ctx.name}: ${f}: Is a directory\n`);
      ctx.failed = true;
      continue;
    }
    if (node.archive || node.gz) {
      ctx.coach('binary', node.archive
        ? `\`${f}\` is an archive, not text. \`tar -tzf ${f}\` lists what's inside.`
        : `\`${f}\` is compressed. \`gunzip ${f}\` turns it back into a normal file.`);
    }
    inputs.push({ name: f, text: node.content });
  }
  return inputs;
}

export function lines(text) {
  if (!text) return [];
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  return all;
}

export function toRegExp(pattern, flags = '') {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}
