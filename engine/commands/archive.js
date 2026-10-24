// Bundling and measuring files: tar, gzip, gunzip, du.
//
// An archive is a file node whose `archive` field holds copies of the files
// it contains. Its content is a placeholder, so reading it shows the student
// that archives aren't plain text.

import { VFS, joinPath, dirname } from '../vfs.js';
import { human, missingTip } from './util.js';

export const BINARY = '\u0000\u0000(binary data)\u0000\n';
const HEADER = 512;

function entrySize(entries) {
  return entries.reduce((n, e) => n + HEADER + (e.node.type === 'file' ? VFS.sizeOf(e.node) : 0), HEADER * 2);
}

// tar flags may come bundled without a dash ("czvf out.tar.gz dir").
function parseTar(args) {
  const flags = new Set();
  const opts = {};
  const rest = [];
  const list = [...args];
  if (list.length && !list[0].startsWith('-')) list[0] = '-' + list[0];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (k === 'file' || k === 'directory') opts[k[0].replace('d', 'C')] = v ?? list[++i];
      else flags.add(k);
      continue;
    }
    if (!a.startsWith('-') || a === '-') { rest.push(a); continue; }
    for (let j = 1; j < a.length; j++) {
      const f = a[j];
      if (f === 'f' || f === 'C') {
        opts[f] = a.slice(j + 1) || list[++i];
        break;
      }
      flags.add(f);
    }
  }
  return { flags, opts, rest };
}

export function tar(ctx) {
  const { sh } = ctx;
  const { flags, opts, rest } = parseTar(ctx.args);
  const mode = ['c', 'x', 't'].filter((m) => flags.has(m));
  if (mode.length !== 1) {
    ctx.err('tar: You must specify one of the \'-ctx\' options\n');
    ctx.coach('tar-mode', 'Tell tar what to do: `c` creates, `t` lists, `x` extracts. For example `tar -czf out.tar.gz folder/`.');
    return 2;
  }
  if (!opts.f) {
    ctx.err('tar: Refusing to read archive contents from terminal (missing -f option?)\n');
    ctx.coach('tar-f', '`f` names the archive file, and it must come last in the flags: `tar -czf name.tar.gz folder/`.');
    return 2;
  }
  const archivePath = sh.resolve(opts.f);
  const verbose = flags.has('v');

  if (mode[0] === 'c') {
    if (!rest.length) {
      ctx.err('tar: Cowardly refusing to create an empty archive\n');
      ctx.coach('tar-empty', 'Name what goes in the archive after its file name: `tar -czf out.tar.gz folder/`.');
      return 2;
    }
    const base = opts.C ? sh.resolve(opts.C) : sh.cwd;
    const entries = [];
    let code = 0;
    for (const src of rest) {
      const abs = sh.vfs.resolve(src, base, sh.home);
      if (!sh.vfs.get(abs)) {
        ctx.err(`tar: ${src}: Cannot stat: No such file or directory\n`);
        missingTip(ctx, src);
        code = 2;
        continue;
      }
      const shownBase = src.replace(/\/+$/, '').replace(/^\/+/, '') || '.';
      if (src.startsWith('/')) ctx.err('tar: Removing leading `/\' from member names\n');
      for (const { path, node } of sh.vfs.walk(abs)) {
        if (path === archivePath) continue;
        const rel = path.slice(abs.length).replace(/^\//, '');
        const name = rel ? joinPath(shownBase, rel) : shownBase;
        entries.push({ path: node.type === 'dir' ? name + '/' : name, node: node.type === 'dir' ? { type: 'dir', children: {}, mode: node.mode, mtime: node.mtime } : VFS.clone(node) });
        if (verbose) ctx.out((node.type === 'dir' ? name + '/' : name) + '\n');
      }
    }
    if (code && !entries.length) {
      ctx.err('tar: Exiting with failure status due to previous errors\n');
      return code;
    }
    const gz = flags.has('z');
    const raw = entrySize(entries);
    try {
      const node = sh.vfs.writeFile(archivePath, BINARY, { mtime: sh.cluster.clock() });
      node.archive = { entries, gz };
      node.size = gz ? Math.max(200, Math.round(raw * 0.3)) : raw;
    } catch (e) {
      ctx.err(`tar: ${opts.f}: Cannot open: ${e.message}\n`);
      return 2;
    }
    if (gz && !/\.(tar\.gz|tgz)$/.test(opts.f)) {
      ctx.coach('tar-name', 'Compressed archives usually end in `.tar.gz` so others know how to open them.');
    }
    return code;
  }

  const node = sh.vfs.get(archivePath);
  if (!node) {
    ctx.err(`tar: ${opts.f}: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n`);
    missingTip(ctx, opts.f);
    return 2;
  }
  if (!node.archive) {
    ctx.err('tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n');
    return 2;
  }
  if (mode[0] === 't') {
    for (const e of node.archive.entries) ctx.out(e.path + '\n');
    return 0;
  }
  const dest = opts.C ? sh.resolve(opts.C) : sh.cwd;
  if (!sh.vfs.get(dest)) {
    ctx.err(`tar: ${opts.C}: Cannot open: No such file or directory\n`);
    return 2;
  }
  for (const e of node.archive.entries) {
    const target = joinPath(dest, e.path);
    if (e.node.type === 'dir') sh.vfs.mkdir(target, { parents: true, mtime: e.node.mtime });
    else {
      sh.vfs.mkdir(dirname(target), { parents: true });
      sh.vfs.put(target, VFS.clone(e.node));
    }
    if (verbose) ctx.out(e.path + '\n');
  }
  return 0;
}

function gzipOne(ctx, f, undo) {
  const { sh } = ctx;
  const abs = sh.resolve(f);
  const node = sh.vfs.get(abs);
  const name = undo ? 'gunzip' : 'gzip';
  if (!node) {
    ctx.err(`${name}: ${f}: No such file or directory\n`);
    missingTip(ctx, f);
    return 1;
  }
  if (node.type === 'dir') {
    ctx.err(`${name}: ${f} is a directory -- ignored\n`);
    if (!undo) ctx.coach('gzip-dir', '`gzip` squeezes one file at a time. To bundle a folder, use `tar -czf name.tar.gz folder/`.');
    return 1;
  }
  if (undo) {
    if (!abs.endsWith('.gz') || !node.gz) {
      ctx.err(`gunzip: ${f}: not in gzip format\n`);
      return 1;
    }
    if (node.archive) {
      ctx.coach('gunzip-tar', 'This is a compressed tar archive. `tar -xzf` unpacks it in one step.');
    }
    sh.vfs.put(abs.slice(0, -3), node.gz);
  } else {
    if (abs.endsWith('.gz')) {
      ctx.err(`gzip: ${f} already has .gz suffix -- unchanged\n`);
      return 1;
    }
    const packed = { type: 'file', content: BINARY, mode: node.mode, mtime: node.mtime, size: Math.max(30, Math.round(VFS.sizeOf(node) * 0.3)), gz: node };
    sh.vfs.put(abs + '.gz', packed);
  }
  sh.vfs.remove(abs);
  return 0;
}

export function gzip(ctx) {
  const undo = ctx.name === 'gunzip' || ctx.args.includes('-d');
  const files = ctx.args.filter((a) => !a.startsWith('-'));
  if (!files.length) {
    ctx.err(`${ctx.name}: compressed data not written to a terminal.\n`);
    ctx.coach('gzip-args', `Name the file: \`${ctx.name} file\`.`);
    return 1;
  }
  let code = 0;
  for (const f of files) code = gzipOne(ctx, f, undo) || code;
  return code;
}

// du counts disk blocks, not bytes: every file takes whole 4 KiB blocks.
function treeSize(node) {
  if (node.type === 'file') return Math.ceil(VFS.sizeOf(node) / 4096) * 4096;
  return Object.values(node.children).reduce((n, c) => n + treeSize(c), 4096);
}

export function du(ctx) {
  const { sh } = ctx;
  const flags = new Set(ctx.args.filter((a) => /^-[a-z]+$/i.test(a)).flatMap((a) => [...a.slice(1)]));
  const depthArg = ctx.args.find((a) => a.startsWith('--max-depth='));
  const maxDepth = depthArg ? Number(depthArg.split('=')[1]) : flags.has('s') ? 0 : Infinity;
  const targets = ctx.args.filter((a) => !a.startsWith('-'));
  if (!targets.length) targets.push('.');
  const fmt = (bytes) => (flags.has('h') ? human(bytes) : String(Math.ceil(bytes / 1024)));
  let code = 0;
  for (const t of targets) {
    const abs = sh.resolve(t);
    const node = sh.vfs.get(abs);
    if (!node) {
      ctx.err(`du: cannot access '${t}': No such file or directory\n`);
      missingTip(ctx, t);
      code = 1;
      continue;
    }
    const rows = [];
    const walk = (n, shown, depth) => {
      if (n.type === 'dir') {
        for (const name of Object.keys(n.children).sort()) {
          const c = n.children[name];
          if (c.type === 'dir' || flags.has('a')) walk(c, shown.replace(/\/$/, '') + '/' + name, depth + 1);
        }
      }
      if (depth <= maxDepth) rows.push(`${fmt(treeSize(n))}\t${shown}\n`);
    };
    walk(node, t, 0);
    for (const r of rows) ctx.out(r);
  }
  return code;
}
