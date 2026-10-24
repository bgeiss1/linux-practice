// scp between the student's laptop and Geiss-01. Remote paths look like
// student@geiss-01:~/project/file.pdb; a relative remote path starts in the
// remote home folder, as with real scp.

import { VFS, basename } from '../vfs.js';
import { missingTip } from './util.js';

function parseSpec(ctx, arg) {
  const m = arg.match(/^(?:([^@/:]+)@)?([^/:]+):(.*)$/s);
  if (!m) return { local: true, path: arg };
  const [, user, host, path] = m;
  return { local: false, user: user ?? ctx.sh.user, host, path, shown: arg };
}

// Returns { sh, path } with path absolute on that machine, or null after printing an error.
function locate(ctx, spec) {
  if (spec.local) return { sh: ctx.sh, abs: ctx.sh.resolve(spec.path), shown: spec.path };
  const remote = ctx.sh.remoteFor(spec.host);
  if (!remote) {
    ctx.err(`ssh: Could not resolve hostname ${spec.host}: nodename nor servname provided, or not known\nscp: Connection closed\n`);
    ctx.coach('scp-host', 'Check the server name. On Geiss-01, `hostname` prints it.');
    return null;
  }
  if (spec.user !== remote.user) {
    ctx.err(`${spec.user}@${spec.host}: Permission denied (publickey,password).\nscp: Connection closed\n`);
    ctx.coach('scp-user', `Your Geiss-01 user name is \`${remote.user}\`. On Geiss-01, \`whoami\` prints it.`);
    return null;
  }
  const abs = remote.vfs.resolve(spec.path || '~', remote.home, remote.home);
  return { sh: remote, abs, shown: spec.path };
}

export function scp(ctx) {
  const { sh } = ctx;
  if (sh.kind === 'cluster') {
    ctx.err('ssh: connect to host my-laptop port 22: Connection refused\nscp: Connection closed\n');
    ctx.coach('scp-side', 'Your laptop can reach Geiss-01, but Geiss-01 can\'t reach your laptop. Run `scp` in your laptop\'s terminal (the Laptop tab).');
    return 1;
  }
  const flags = new Set(ctx.args.filter((a) => /^-[a-zA-Z]+$/.test(a)).flatMap((a) => [...a.slice(1)]));
  const args = ctx.args.filter((a) => !/^-[a-zA-Z]+$/.test(a));
  if (args.length < 2) {
    ctx.err('usage: scp [-r] source ... target\n');
    ctx.coach('scp-args', 'scp needs a source and a destination, for example `scp student@geiss-01:~/results.tar.gz .`');
    return 1;
  }
  const specs = args.map((a) => parseSpec(ctx, a));
  if (specs.every((s) => s.local)) {
    ctx.coach('scp-colon', 'Neither path names a server. A remote path needs a colon: `student@geiss-01:path/on/server`.');
  }
  const dest = locate(ctx, specs.pop());
  if (!dest) return 1;
  const destNode = dest.sh.vfs.get(dest.abs);
  if (specs.length > 1 && destNode?.type !== 'dir') {
    ctx.err(`scp: ${dest.shown}: Not a directory\n`);
    return 1;
  }
  let code = 0;
  for (const spec of specs) {
    const src = locate(ctx, spec);
    if (!src) return 1;
    // A remote glob like student@geiss-01:~/run/*.pdb is expanded on the server.
    const matches = /[*?]/.test(spec.path) && !spec.local ? globOn(src.sh, spec.path) : [src.abs];
    if (!matches.length) {
      ctx.err(`scp: ${spec.path}: No such file or directory\n`);
      code = 1;
      continue;
    }
    for (const abs of matches) {
      const node = src.sh.vfs.get(abs);
      if (!node) {
        ctx.err(`scp: ${spec.path}: No such file or directory\n`);
        if (spec.local) missingTip(ctx, spec.path);
        else ctx.coach('scp-remote-path', 'Relative paths on the server start in your Geiss-01 home folder. On Geiss-01, `pwd` shows the full path to copy.');
        code = 1;
        continue;
      }
      if (node.type === 'dir' && !flags.has('r')) {
        ctx.err(`scp: ${spec.path}: not a regular file\n`);
        ctx.coach('scp-r', 'Copying a folder needs `scp -r`. Or bundle it on Geiss-01 first with `tar -czf`.');
        code = 1;
        continue;
      }
      const target = destNode?.type === 'dir' ? `${dest.abs === '/' ? '' : dest.abs}/${basename(abs)}` : dest.abs;
      try {
        const copy = VFS.clone(node);
        dest.sh.vfs.put(target, copy);
      } catch (e) {
        ctx.err(`scp: ${dest.shown}: ${e.message}\n`);
        code = 1;
        continue;
      }
      if (!flags.has('q')) {
        const size = VFS.sizeOf(node);
        const kb = size < 1024 ? `${size}` : `${Math.round(size / 1024)}KB`;
        ctx.out(`${basename(abs).padEnd(40)} 100% ${kb.padStart(8)}   1.2MB/s   00:00\n`);
      }
    }
  }
  return code;
}

function globOn(remote, pattern) {
  const saved = remote.cwd;
  remote.cwd = remote.home;
  try {
    return remote.glob(pattern.replace(/^~(?=\/|$)/, remote.home)).map((p) => remote.resolve(p));
  } finally {
    remote.cwd = saved;
  }
}
