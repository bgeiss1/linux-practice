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

  // { "archiveHas": { "path": "~/run.tar.gz", "names": ["run/a.pdb"], "only": false, "gz": true } }
  // Names are compared without trailing slashes, so "run" matches the entry "run/".
  archiveHas: (sh, v) => {
    const node = sh.vfs.get(norm(sh, v.path));
    if (!node?.archive) return false;
    if (v.gz !== undefined && node.archive.gz !== v.gz) return false;
    const strip = (n) => n.replace(/\/$/, '');
    const names = node.archive.entries.map((e) => strip(e.path));
    const want = (v.names ?? []).map(strip);
    if (!want.every((n) => names.includes(n))) return false;
    // "only": every file in the archive is one of the names.
    return !v.only || node.archive.entries.every((e) => e.node.type === 'dir' || want.includes(e.path));
  },
  isCompressed: (sh, v) => !!sh.vfs.get(norm(sh, v))?.gz,
  modeIs: (sh, v) => (sh.vfs.get(norm(sh, v.path))?.mode & 0o777) === parseInt(v.mode, 8),

  moduleLoaded: (sh, v) => sh.cluster.modules.includes(v),
  condaEnv: (sh, v) => sh.cluster.condaEnv === v,
  // true, a GPU count, or { "gpus": 2, "memGB": 64, "timeMin": 180 } (at least that much of each).
  inInteractiveJob: (sh, v) => {
    const session = sh.cluster.interactive;
    if (!session) return false;
    if (v === true) return true;
    if (typeof v !== 'object') return session.gpus >= Number(v);
    const job = sh.cluster.jobs.find((j) => j.id === session.jobId);
    return session.gpus >= Number(v.gpus ?? 0) && (job?.memGB ?? 0) >= Number(v.memGB ?? 0) && (job?.timeMin ?? 0) >= Number(v.timeMin ?? 0);
  },
  notInInteractiveJob: (sh) => !sh.cluster.interactive,

  // { "jobSubmitted": { "name": "mpnn", "gpus": 1, "memGB": 32, "timeMin": 120, "partition": "gpu",
  //                    "array": 4, "dependency": true, "after": "rfd" } }  Every key is optional; numbers are minimums.
  jobSubmitted: (sh, v) => sh.cluster.jobs.some((j) => matchJob(sh, j, v ?? {})),
  // { "jobState": { "name": "mpnn", "state": "CD" } } takes the same keys plus a state.
  jobState: (sh, v) => sh.cluster.jobs.some((j) => matchJob(sh, j, v) && j.state === v.state),

  // The student ran a command (optionally with flags or an argument).
  // { "ran": "ls", "flags": "a", "arg": "~/inputs", "argHas": "..", "ok": true, "inDir": "~/x" }
  // "arg" is compared as a path, resolved from the folder the command ran in.
  // "lineHas" looks at the whole line as typed, before globs expand (e.g. "*.pdb").
  ran: (sh, v, ctx) => matchRan(sh, v, ctx),

  // The student typed this value in the answer box on the page (case-insensitive).
  // Numbers match by value, so "017" and "17" both count.
  answer: (sh, v) =>
    sh.answers.some((a) => {
      const given = a.trim().toLowerCase();
      const want = String(v).trim().toLowerCase();
      return given === want || (/^-?\d+(\.\d+)?$/.test(given) && /^-?\d+(\.\d+)?$/.test(want) && Number(given) === Number(want));
    }),

  // { "laptop": { "isFile": "~/Downloads/a.pdb" } } checks the student's laptop instead.
  // On the laptop, ~ is /Users/student.
  laptop: (sh, v, ctx) => !!ctx?.machines?.laptop && evaluate(v, ctx.machines.laptop, ctx),

  all: (sh, v, ctx) => v.every((c) => evaluate(c, sh, ctx)),
  any: (sh, v, ctx) => v.some((c) => evaluate(c, sh, ctx)),
  not: (sh, v, ctx) => !evaluate(v, sh, ctx),
};

function matchJob(sh, j, v) {
  if (j.user !== sh.user || j.interactive) return false;
  const base = String(j.id).split('_')[0];
  const tasks = sh.cluster.jobs.filter((x) => String(x.id).split('_')[0] === base).length;
  return (
    (!v.name || j.name === v.name) &&
    (v.gpus === undefined || j.gpus >= Number(v.gpus)) &&
    (v.memGB === undefined || j.memGB >= Number(v.memGB)) &&
    (v.timeMin === undefined || j.timeMin >= Number(v.timeMin)) &&
    (!v.partition || j.partition === v.partition) &&
    (v.array === undefined || (String(j.id).includes('_') && tasks >= Number(v.array))) &&
    (v.dependency === undefined || !!j.afterJob === v.dependency) &&
    // "after": the name of the job this one waits for.
    (!v.after || sh.cluster.jobs.some((d) => d.name === v.after && String(j.afterJob ?? '').split(':').slice(1).includes(String(d.id))))
  );
}

function matchRan(sh, spec, ctx) {
  const v = typeof spec === 'string' ? { ran: spec } : spec;
  const names = Array.isArray(v.ran) ? v.ran : [v.ran];
  return eventsSince(sh, ctx?.since ?? 0).some(
    (e) =>
      names.includes(e.cmd) &&
      (!v.flags || [...v.flags].every((f) => e.flags.includes(f))) &&
      (!v.arg || e.args.some((a) => a === v.arg || (e.cwd && sh.vfs.resolve(a, e.cwd, sh.home) === norm(sh, v.arg)))) &&
      (!v.argHas || e.args.some((a) => a.includes(v.argHas))) &&
      (!v.lineHas || (e.line ?? '').includes(v.lineHas)) &&
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
