// Task checks. Each check looks at the result of what the student did, not
// the exact keystrokes, so any correct route passes.
//
// A check is an object with one key naming its type, for example
//   { "cwd": "~/projects/binder_design" }
//   { "ran": "ls", "flags": "a" }
//   { "all": [ {...}, {...} ] }

function norm(sh, path) {
  return sh.vfs.resolve(path, sh.home, sh.home);
}

function eventsSince(sh, since) {
  return sh.events.slice(since);
}

const CHECKS = {
  // Student is in this folder.
  cwd: (sh, v) => sh.cwd === norm(sh, v),

  exists: (sh, v) => !!sh.vfs.get(norm(sh, v)),
  notExists: (sh, v) => !sh.vfs.get(norm(sh, v)),
  isDir: (sh, v) => sh.vfs.get(norm(sh, v))?.type === 'dir',
  isFile: (sh, v) => sh.vfs.get(norm(sh, v))?.type === 'file',
  executable: (sh, v) => !!(sh.vfs.get(norm(sh, v))?.mode & 0o100),

  // { "fileContains": { "path": "~/notes.txt", "text": "helix" } }
  fileContains: (sh, v) => {
    const node = sh.vfs.get(norm(sh, v.path));
    return node?.type === 'file' && node.content.includes(v.text);
  },

  // { "dirHas": { "path": "~/review", "names": ["a.pdb", "b.pdb"], "only": true } }
  dirHas: (sh, v) => {
    const node = sh.vfs.get(norm(sh, v.path));
    if (node?.type !== 'dir') return false;
    const names = Object.keys(node.children);
    if (!v.names.every((n) => names.includes(n))) return false;
    return !v.only || names.length === v.names.length;
  },

  moduleLoaded: (sh, v) => sh.cluster.modules.includes(v),
  condaEnv: (sh, v) => sh.cluster.condaEnv === v,
  inInteractiveJob: (sh, v) => !!sh.cluster.interactive && (v === true || sh.cluster.interactive.gpus >= v),
  notInInteractiveJob: (sh) => !sh.cluster.interactive,

  // { "jobSubmitted": { "name": "mpnn" } }  (name optional)
  jobSubmitted: (sh, v) => sh.cluster.jobs.some((j) => j.user === sh.user && (!v?.name || j.name === v.name)),
  // { "jobState": { "name": "mpnn", "state": "CD" } }
  jobState: (sh, v) => sh.cluster.jobs.some((j) => j.user === sh.user && (!v.name || j.name === v.name) && j.state === v.state),

  // The student ran a command (optionally with flags or an argument).
  // { "ran": "ls", "flags": "a", "arg": "~/inputs", "argHas": "..", "ok": true, "inDir": "~/x" }
  // "arg" is compared as a path, resolved from the folder the command ran in.
  ran: (sh, v, ctx) => matchRan(sh, v, ctx),

  // The student used the answer command with this value (case-insensitive).
  answer: (sh, v) => sh.answers.some((a) => a.trim().toLowerCase() === String(v).trim().toLowerCase()),

  all: (sh, v, ctx) => v.every((c) => evaluate(c, sh, ctx)),
  any: (sh, v, ctx) => v.some((c) => evaluate(c, sh, ctx)),
  not: (sh, v, ctx) => !evaluate(v, sh, ctx),
};

function matchRan(sh, spec, ctx) {
  const v = typeof spec === 'string' ? { ran: spec } : spec;
  const names = Array.isArray(v.ran) ? v.ran : [v.ran];
  return eventsSince(sh, ctx?.since ?? 0).some(
    (e) =>
      names.includes(e.cmd) &&
      (!v.flags || [...v.flags].every((f) => e.flags.includes(f))) &&
      (!v.arg || e.args.some((a) => a === v.arg || (e.cwd && sh.vfs.resolve(a, e.cwd, sh.home) === norm(sh, v.arg)))) &&
      (!v.argHas || e.args.some((a) => a.includes(v.argHas))) &&
      (v.ok === undefined || (e.code === 0) === v.ok) &&
      (!v.inDir || e.cwd === norm(sh, v.inDir)),
  );
}

export const CHECK_TYPES = Object.keys(CHECKS);

// The "ran" check reads extra keys from the same object as its type key.
export function evaluate(check, sh, ctx = {}) {
  const keys = Object.keys(check);
  const type = keys.find((k) => k in CHECKS);
  if (!type) throw new Error(`Unknown check: ${JSON.stringify(check)}`);
  if (type === 'ran') return CHECKS.ran(sh, check, ctx);
  return CHECKS[type](sh, check[type], ctx);
}
