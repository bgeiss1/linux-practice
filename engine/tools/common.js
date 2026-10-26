// Shared pieces for the design-tool stand-ins: argument reading, input checks,
// writing outputs, repeatable "random" numbers, and the memory and time a run
// uses inside a Slurm job.

import { basename, dirname } from '../vfs.js';
import { missingTip } from '../commands/util.js';

export const stem = (p) => basename(p).replace(/\.[^.]+$/, '');

// The same name always gives the same number, so a scenario can know ahead of
// time what score or energy a tool will print.
export function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// A number between lo and hi picked by key, rounded to `places` decimals.
export function pick(key, lo, hi, places = 1) {
  const x = (hash(key) % 100000) / 100000;
  return Number((lo + x * (hi - lo)).toFixed(places));
}

// Options like --pdb_path X, --pdb_path=X and Hydra-style key=value.
export function readArgs(args, { flags = [] } = {}) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) opts[k] = v;
      else if (flags.includes(k)) opts[k] = true;
      else opts[k] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true;
    } else if (/^[~+]?[\w.]+=/.test(a)) {
      const [k, v] = a.split(/=(.*)/s);
      opts[k] = v;
    } else rest.push(a);
  }
  return { opts, rest };
}

// GROMACS-style single-dash options: -f in.pdb -o out.gro -c -d 1.0
export function readDashArgs(args, valueOpts) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const k = a.replace(/^--?/, '');
    if (a.startsWith('-') && valueOpts.includes(k) && args[i + 1] !== undefined) opts[k] = args[++i];
    else if (a.startsWith('-') && !/^-\d/.test(a)) opts[k] = true;
    else rest.push(a);
  }
  return { opts, rest };
}

// An input file that must exist. Prints the tool's error and returns null if not.
export function needInput(ctx, path, label, { python = true } = {}) {
  if (!path || path === true) {
    ctx.err(`${ctx.name}: error: ${label} is required\n`);
    return null;
  }
  const abs = ctx.sh.resolve(path);
  if (!ctx.sh.vfs.get(abs)) {
    ctx.err(python ? `FileNotFoundError: [Errno 2] No such file or directory: '${path}'\n` : `${ctx.name}: ${path}: No such file or directory\n`);
    missingTip(ctx, path);
    return null;
  }
  return abs;
}

export function readText(ctx, abs) {
  const node = ctx.sh.vfs.get(abs);
  return node?.type === 'file' ? node.content : '';
}

// Write an output file, making its folder first. Binary outputs (.npz, .tpr,
// .edr) get a placeholder body and a tip for when a student tries to read them.
export function write(ctx, path, content, { binary = null, size = null, meta = null } = {}) {
  const { sh } = ctx;
  sh.vfs.mkdir(dirname(path), { parents: true, mtime: sh.cluster.clock() });
  const node = sh.vfs.writeFile(path, binary ? '\u0000\u0000(binary data)\u0000\n' : content, { mtime: sh.cluster.clock() });
  if (binary) node.binary = binary;
  if (size) node.size = size;
  if (meta) node.meta = meta;
  return node;
}

// Thrown when Slurm stops a batch job: it used more memory than --mem, or ran
// past --time. Shell.runJob catches it and records the job's end state.
export class JobKill extends Error {
  constructor(result) {
    super(result);
    this.result = result;
  }
}

// Inside a job, a run counts against what the job asked for. Returns false if
// an interactive job's memory ran out (the tool has been killed). Batch jobs
// throw JobKill. onTimeout(fraction) lets a tool save a checkpoint first.
export function useResources(ctx, { memGB = 1, minutes = 1, onTimeout } = {}) {
  const { sh } = ctx;
  const job = sh.cluster.interactive;
  if (!job) return true;
  if (job.batch) {
    const usage = sh.jobUsage;
    usage.memGB = Math.max(usage.memGB, Math.min(memGB, job.memGB));
    if (memGB > job.memGB) {
      usage.minutes += minutes * 0.1;
      throw new JobKill('OUT_OF_MEMORY');
    }
    const left = job.timeMin - usage.minutes;
    if (minutes > left) {
      onTimeout?.(Math.max(0, left / minutes));
      usage.minutes = job.timeMin;
      throw new JobKill('TIMEOUT');
    }
    usage.minutes += minutes;
    return true;
  }
  if (memGB > job.memGB) {
    ctx.err('Killed\n');
    ctx.coach('tool-oom', `This run needed about ${Math.ceil(memGB)} GB, but your interactive job has ${job.memGB} GB. \`exit\`, then start a new one with more, like \`srun --gres=gpu:${job.gpus || 1} --mem=${Math.ceil(memGB / 8) * 8 + 8}G --pty bash\`.`);
    ctx.sh.oomKilled = true;
    return false;
  }
  return true;
}

// True if this run has a GPU from Slurm (an interactive job or a batch job).
export const hasGpu = (ctx) => ctx.sh.cluster.interactive?.gpus > 0;

export function noGpu(ctx, error = 'RuntimeError: No CUDA GPUs are available') {
  const { cluster } = ctx.sh;
  ctx.err(error + '\n');
  ctx.coach('tool-gpu', cluster.interactive?.batch
    ? 'This job script never asked for a GPU. Add `#SBATCH --gres=gpu:1` near the top and submit it again.'
    : cluster.interactive
      ? 'Your interactive job has no GPU. `exit`, then start one with `srun --gres=gpu:1 --mem=32G --pty bash`.'
      : 'Geiss-01 only gives you a GPU through Slurm. Start an interactive job with `srun --gres=gpu:1 --mem=32G --pty bash`, or submit a job script with `sbatch`.');
  return 1;
}

// Timestamped log lines like Python's logging module prints.
export function stamp(ctx, seconds = 0) {
  const d = new Date(ctx.sh.cluster.clock() + seconds * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())},${p(hash(ctx.sh.cluster.step) % 1000, 3)}`;
}

// FASTA records: [{ name, seq }]. The name is the header up to the first space.
export function parseFasta(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) records.push({ header: line.slice(1).trim(), name: line.slice(1).trim().split(/\s/)[0], seq: '' });
    else if (records.length) records.at(-1).seq += line.trim();
  }
  return records;
}
