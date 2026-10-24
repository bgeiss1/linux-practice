// Environment and job commands: module, conda, sbatch, squeue, scancel,
// sacct, seff, sinfo, srun, nvidia-smi.

import { MODULES, CONDA_ENVS, NODE, PARTITIONS } from '../cluster.js';
import { basename } from '../vfs.js';
import { parseArgs, missingTip } from './util.js';

const STATE_NAMES = { PD: 'PENDING', R: 'RUNNING', CD: 'COMPLETED', F: 'FAILED', TO: 'TIMEOUT', OOM: 'OUT_OF_MEMORY', CA: 'CANCELLED' };

// ---------- modules ----------

export function module(ctx) {
  const { cluster } = ctx.sh;
  const [sub, ...names] = ctx.args;
  const full = (m) => `${m.name}/${m.version}`;
  switch (sub) {
    case 'avail':
    case 'av':
    case 'spider': {
      const list = MODULES.filter((m) => !names.length || names.some((n) => m.name.startsWith(n.split('/')[0])));
      ctx.out('\n------------------------------ /opt/modulefiles ------------------------------\n');
      ctx.out('   ' + list.map((m) => full(m) + (cluster.modules.includes(m.name) ? ' (L)' : '')).join('    ') + '\n\n');
      ctx.out('  Where:\n   L:  Module is loaded\n\n');
      return 0;
    }
    case 'list': {
      if (!cluster.modules.length) { ctx.out('No modules loaded\n'); return 0; }
      const items = cluster.modules.map((n, i) => `${i + 1}) ${full(MODULES.find((m) => m.name === n))}`);
      ctx.out('\nCurrently Loaded Modules:\n  ' + items.join('   ') + '\n\n');
      return 0;
    }
    case 'load':
    case 'add': {
      if (!names.length) { ctx.err('module load: missing module name\n'); return 1; }
      const unknown = [];
      for (const n of names) {
        const m = cluster.findModule(n);
        if (!m) { unknown.push(n); continue; }
        const clash = (m.conflicts ?? []).find((c) => cluster.modules.includes(c));
        if (clash) {
          ctx.err(`Lmod has detected the following error:  Cannot load module "${full(m)}" because these module(s) are loaded:\n   ${clash}\n`);
          ctx.coach('module-conflict', 'Two modules clash. `module purge` unloads everything so you can load just what you need.');
          continue;
        }
        if (!cluster.modules.includes(m.name)) cluster.modules.push(m.name);
      }
      if (unknown.length) {
        ctx.err(`Lmod has detected the following error:  The following module(s) are unknown: ${unknown.map((u) => `"${u}"`).join(' ')}\n\nPlease check the spelling or version number. Also try "module spider ..."\n`);
        ctx.coach('module-unknown', 'Module names must match `module avail` exactly, including lowercase letters.');
        return 1;
      }
      return 0;
    }
    case 'unload':
    case 'rm':
      for (const n of names) {
        const name = n.split('/')[0];
        cluster.modules = cluster.modules.filter((m) => m !== name);
        if (name === 'anaconda') cluster.condaEnv = null;
      }
      return 0;
    case 'purge':
      cluster.modules = [];
      cluster.condaEnv = null;
      return 0;
    case 'show':
    case 'whatis': {
      const m = cluster.findModule(names[0] ?? '');
      if (!m) { ctx.err(`Lmod has detected the following error:  Unable to find: "${names[0] ?? ''}"\n`); return 1; }
      ctx.out(`${full(m)}: provides ${m.provides.join(', ') || 'libraries'}\n`);
      return 0;
    }
    default:
      ctx.out('Usage: module [avail | list | load NAME | unload NAME | purge | show NAME]\n');
      return sub ? 1 : 0;
  }
}

// ---------- conda ----------

export function conda(ctx) {
  const { cluster } = ctx.sh;
  if (!cluster.modules.includes('anaconda')) {
    ctx.err('bash: conda: command not found\n');
    ctx.coach('conda-module', 'The `conda` command appears only after its module is loaded. Try `module load anaconda`.');
    return 127;
  }
  const [sub, ...rest] = ctx.args;
  if ((sub === 'env' && rest[0] === 'list') || (sub === 'info' && rest.includes('--envs'))) {
    ctx.out('# conda environments:\n#\n');
    for (const name of Object.keys(CONDA_ENVS)) {
      const active = (cluster.condaEnv ?? 'base') === name ? '*' : ' ';
      const path = name === 'base' ? '/opt/conda' : `/opt/conda/envs/${name}`;
      ctx.out(`${name.padEnd(22)}${active}  ${path}\n`);
    }
    ctx.out('\n');
    return 0;
  }
  if (sub === 'activate') {
    const name = rest[0] ?? 'base';
    if (!(name in CONDA_ENVS)) {
      ctx.err(`\nEnvironmentNameNotFound: Could not find conda environment: ${name}\nYou can list all discoverable environments with \`conda info --envs\`.\n\n`);
      return 1;
    }
    cluster.condaEnv = name;
    return 0;
  }
  if (sub === 'deactivate') {
    cluster.condaEnv = cluster.condaEnv && cluster.condaEnv !== 'base' ? 'base' : null;
    return 0;
  }
  if (sub === 'list') {
    ctx.out(`# packages in environment at /opt/conda/envs/${cluster.condaEnv ?? 'base'}:\n#\npython                    3.11.9\nnumpy                     1.26.4\ntorch                     2.5.1\n`);
    return 0;
  }
  if (sub === 'create' || sub === 'install') {
    ctx.err('CondaError: environment changes are disabled on this practice server.\n');
    ctx.coach('conda-create', 'On Geiss-01 the course environments are already built. Use `conda env list` to see them.');
    return 1;
  }
  ctx.out('usage: conda [env list | activate NAME | deactivate | list]\n');
  return sub ? 1 : 0;
}

// ---------- Slurm ----------

function parseTime(s) {
  if (!s) return null;
  let days = 0;
  let rest = String(s);
  if (rest.includes('-')) { [days, rest] = rest.split('-'); days = Number(days); }
  const parts = rest.split(':').map(Number);
  if (parts.some(Number.isNaN)) return NaN;
  let min;
  if (parts.length === 1) min = parts[0];
  else if (parts.length === 2) min = s.includes('-') ? parts[0] * 60 + parts[1] : parts[0] + parts[1] / 60;
  else min = parts[0] * 60 + parts[1] + parts[2] / 60;
  return days * 1440 + min;
}

function parseMem(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+(?:\.\d+)?)([KMGT]?)B?$/i);
  if (!m) return NaN;
  const unit = { K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024, '': 1 / 1024 }[m[2].toUpperCase()];
  return Number(m[1]) * unit;
}

function fmtTime(min) {
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = Math.floor(min % 60);
  const hms = `${String(h).padStart(d ? 2 : 1, '0')}:${String(m).padStart(2, '0')}:00`;
  return d ? `${d}-${hms}` : hms;
}

// Collect Slurm options from "--opt=value", "--opt value" and "-x value" forms.
const BOOLEAN_OPTS = new Set(['pty', 'exclusive', 'me', 'parsable', 'test-only', 'x11', 'help']);

function readOptions(tokens, into) {
  const short = { J: 'job-name', p: 'partition', t: 'time', o: 'output', e: 'error', G: 'gpus', c: 'cpus-per-task', n: 'ntasks', N: 'nodes', a: 'array', d: 'dependency' };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const [k, v] = t.slice(2).split(/=(.*)/s);
      if (v !== undefined) into[k] = v;
      else if (BOOLEAN_OPTS.has(k)) into[k] = true;
      else if (tokens[i + 1] && !tokens[i + 1].startsWith('-')) into[k] = tokens[++i];
      else into[k] = true;
    } else if (/^-[A-Za-z]$/.test(t) && short[t[1]]) {
      into[short[t[1]]] = tokens[++i];
    } else if (/^-[A-Za-z]./.test(t) && short[t[1]]) {
      into[short[t[1]]] = t.slice(2);
    } else {
      return tokens.slice(i);
    }
  }
  return [];
}

function gpusFrom(opts) {
  if (opts.gpus) return Number(String(opts.gpus).split(':').pop());
  if (opts.gres) {
    const m = String(opts.gres).match(/gpu(?::[\w-]+)?:(\d+)$/) || String(opts.gres).match(/^gpu$/);
    return m ? Number(m[1] ?? 1) : 0;
  }
  return 0;
}

// Check requested resources the way Slurm would. Returns an error string or null.
function validate(opts) {
  if (opts.partition && !(opts.partition in PARTITIONS)) return `sbatch: error: invalid partition specified: ${opts.partition}\nsbatch: error: Batch job submission failed: Invalid partition name specified`;
  const gpus = gpusFrom(opts);
  if (gpus > NODE.gpus) return 'sbatch: error: Batch job submission failed: Requested node configuration is not available';
  const mem = parseMem(opts.mem);
  if (Number.isNaN(mem)) return `sbatch: error: Invalid --mem specification`;
  if (mem > NODE.memGB) return 'sbatch: error: Memory specification can not be satisfied\nsbatch: error: Batch job submission failed: Requested node configuration is not available';
  const time = parseTime(opts.time);
  if (Number.isNaN(time)) return 'sbatch: error: Invalid time limit specification';
  return null;
}

function submit(ctx, opts, { scriptPath, scriptText, command }) {
  const { sh } = ctx;
  const { cluster } = sh;
  const name = opts['job-name'] ?? (scriptPath ? basename(scriptPath) : command?.split(' ')[0] ?? 'wrap');
  const partition = opts.partition ?? 'gpu';
  const gpus = gpusFrom(opts);
  const memGB = parseMem(opts.mem) ?? 4;
  const timeMin = parseTime(opts.time) ?? 60;
  const rule = cluster.ruleFor(scriptPath ?? command ?? '', scriptText ?? '');

  let result = rule.result ?? 'COMPLETED';
  let log = rule.log ?? `Job started on ${NODE.name}\nJob finished\n`;
  if (rule.needsGpu && gpus === 0) {
    result = 'FAILED';
    log = (rule.logStart ?? '') + 'RuntimeError: No CUDA GPUs are available\n';
  } else if (rule.needsMemGB && memGB < rule.needsMemGB) {
    result = 'OUT_OF_MEMORY';
    log = rule.logStart ?? '';
  } else if (rule.needsTimeMin && timeMin < rule.needsTimeMin) {
    result = 'TIMEOUT';
    log = rule.logStart ?? '';
  }

  const base = cluster.nextJobId++;
  const tasks = opts.array ? expandArray(String(opts.array)) : [null];
  const cwd = sh.cwd;
  const created = [];
  for (const task of tasks) {
    const id = task === null ? base : `${base}_${task}`;
    const pattern = opts.output ?? (task === null ? 'slurm-%j.out' : 'slurm-%A_%a.out');
    const out = pattern.replace(/%j/g, task === null ? base : `${base}_${task}`).replace(/%A/g, base).replace(/%a/g, task ?? '').replace(/%x/g, name);
    const output = sh.vfs.resolve(out, cwd, sh.home);
    const subst = (s) => s.replace(/\{\{task\}\}/g, task ?? '').replace(/\{\{job\}\}/g, base);
    created.push(
      cluster.makeJob({
        id,
        name,
        partition,
        gpus,
        memGB,
        timeMin,
        runSteps: rule.runSteps ?? 3,
        result,
        log: subst(log),
        output,
        creates: result === 'COMPLETED' ? (rule.creates ?? []).map((c) => sh.vfs.resolve(subst(c), cwd, sh.home)) : [],
        cwd,
        memUsedGB: rule.memUsedGB ?? Math.min(memGB, 3.2),
        dependency: opts.dependency ?? null,
        reason: timeMin > PARTITIONS[partition].limitMin ? 'PartitionTimeLimit' : null,
      }),
    );
  }
  cluster.jobs.push(...created);
  return { base, jobs: created };
}

function expandArray(spec) {
  const ids = [];
  for (const part of spec.split('%')[0].split(',')) {
    const [range, step] = part.split(':');
    const [a, b] = range.split('-').map(Number);
    for (let i = a; i <= (b ?? a); i += Number(step ?? 1)) ids.push(i);
  }
  return ids;
}

export function sbatch(ctx) {
  const { sh } = ctx;
  const cli = {};
  const rest = readOptions(ctx.args, cli);
  let scriptPath = rest[0];
  let scriptText = null;
  if (cli.wrap) {
    const err = validate(cli);
    if (err) { ctx.err(err + '\n'); return 1; }
    const { base } = submit(ctx, cli, { command: cli.wrap });
    ctx.out(`Submitted batch job ${base}\n`);
    return 0;
  }
  if (!scriptPath) {
    ctx.err('sbatch: error: Batch job submission failed: No script given\n');
    ctx.coach('sbatch-none', 'Give `sbatch` the job script to run, for example `sbatch run.sh`.');
    return 1;
  }
  const abs = sh.resolve(scriptPath);
  const node = sh.vfs.get(abs);
  if (!node || node.type !== 'file') {
    ctx.err(`sbatch: error: Unable to open file ${scriptPath}\n`);
    missingTip(ctx, scriptPath);
    return 1;
  }
  scriptText = node.content;
  if (!scriptText.startsWith('#!')) {
    ctx.err('sbatch: error: This does not look like a batch script.  The first\nsbatch: error: line must start with #! followed by the path to an interpreter.\nsbatch: error: For instance: #!/bin/sh\n');
    return 1;
  }
  const opts = {};
  for (const line of scriptText.split('\n').slice(1)) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('#')) break;
    const m = t.match(/^#SBATCH\s+(.*)$/);
    if (m) readOptions(m[1].split(/\s+/), opts);
  }
  Object.assign(opts, cli);
  const err = validate(opts);
  if (err) {
    ctx.err(err + '\n');
    ctx.coach('sbatch-invalid', `Geiss-01 has ${NODE.gpus} GPUs and about ${NODE.memGB} GB of memory. A job can't ask for more than the machine has.`);
    return 1;
  }
  const { base } = submit(ctx, opts, { scriptPath: abs, scriptText });
  ctx.out(`Submitted batch job ${base}\n`);
  ctx.coach('sbatch-ok', 'Your job is in the queue. Check on it with `squeue -u student` (or `squeue --me`).');
  return 0;
}

function visibleJobs(cluster) {
  return cluster.jobs.filter((j) => j.state === 'PD' || j.state === 'R');
}

export function squeue(ctx) {
  const { cluster, user } = ctx.sh;
  const cli = {};
  readOptions(ctx.args.filter((a) => a !== '--me'), cli);
  let jobs = visibleJobs(cluster);
  const who = ctx.args.includes('--me') ? user : cli.user ?? (ctx.args.includes('-u') ? ctx.args[ctx.args.indexOf('-u') + 1] : null);
  if (who) jobs = jobs.filter((j) => j.user === who);
  const jid = ctx.args.includes('-j') ? ctx.args[ctx.args.indexOf('-j') + 1] : cli.jobs;
  if (jid) jobs = jobs.filter((j) => String(j.id) === String(jid) || String(j.id).startsWith(jid + '_'));
  ctx.out('             JOBID PARTITION     NAME     USER ST       TIME  NODES NODELIST(REASON)\n');
  for (const j of jobs) {
    const where = j.state === 'R' ? NODE.name : `(${j.reason ?? (j.dependency ? 'Dependency' : 'Priority')})`;
    ctx.out(
      `${String(j.id).padStart(18)} ${j.partition.padStart(9)} ${j.name.slice(0, 8).padStart(8)} ${j.user.slice(0, 8).padStart(8)} ${j.state.padStart(2)} ${cluster.fmtElapsed(j).padStart(10)} ${'1'.padStart(6)} ${where}\n`,
      j.user === user ? 'ok' : undefined,
    );
  }
  return 0;
}

export function scancel(ctx) {
  const { cluster, user } = ctx.sh;
  const { opts, rest } = parseArgs(ctx.args, ['u', 'n']);
  let targets = [];
  if (opts.u) targets = cluster.jobs.filter((j) => j.user === opts.u);
  else if (opts.n) targets = cluster.jobs.filter((j) => j.name === opts.n && j.user === user);
  else {
    if (!rest.length) { ctx.err('scancel: error: No job identification provided\n'); return 1; }
    for (const id of rest) {
      const found = cluster.jobs.filter((j) => String(j.id) === id || String(j.id).startsWith(id + '_'));
      if (!found.length) { ctx.err(`scancel: error: Invalid job id ${id}\n`); return 1; }
      targets.push(...found);
    }
  }
  for (const j of targets) {
    if (j.user !== user) {
      ctx.err(`scancel: error: Kill job error on job id ${j.id}: Access/permission denied\n`);
      ctx.coach('scancel-other', 'You can only cancel your own jobs. Check the USER column in `squeue`.');
      return 1;
    }
    if (j.state === 'PD' || j.state === 'R') {
      j.state = 'CA';
      j.endStep = cluster.step;
    }
  }
  return 0;
}

export function sacct(ctx) {
  const { cluster, user } = ctx.sh;
  const jid = ctx.args.includes('-j') ? ctx.args[ctx.args.indexOf('-j') + 1] : null;
  let jobs = cluster.jobs.filter((j) => j.user === user);
  if (jid) jobs = jobs.filter((j) => String(j.id) === jid || String(j.id).startsWith(jid + '_'));
  ctx.out('JobID           JobName  Partition      State ExitCode    Elapsed\n------------ ---------- ---------- ---------- -------- ----------\n');
  for (const j of jobs) {
    const state = STATE_NAMES[j.state] ?? j.state;
    const code = j.exitCode === null ? '0:0' : `${j.exitCode}:0`;
    ctx.out(`${String(j.id).padEnd(12)} ${j.name.slice(0, 10).padStart(10)} ${j.partition.padStart(10)} ${state.slice(0, 10).padStart(10)} ${code.padStart(8)} ${cluster.fmtElapsed(j).padStart(10)}\n`);
  }
  return 0;
}

export function seff(ctx) {
  const { cluster, user } = ctx.sh;
  const id = ctx.args[0];
  const j = cluster.jobs.find((x) => String(x.id) === id && x.user === user);
  if (!j) { ctx.err(`Job not found.\n`); return 1; }
  const used = j.state === 'OOM' ? j.memGB : j.memUsedGB ?? 1;
  ctx.out(
    [
      `Job ID: ${j.id}`,
      `Cluster: geiss`,
      `User/Group: ${user}/mip662`,
      `State: ${STATE_NAMES[j.state] ?? j.state} (exit code ${j.exitCode ?? 0})`,
      `Job Wall-clock time: ${cluster.fmtElapsed(j)}`,
      `Memory Utilized: ${used.toFixed(2)} GB`,
      `Memory Efficiency: ${Math.min(100, (used / j.memGB) * 100).toFixed(2)}% of ${j.memGB.toFixed(2)} GB`,
    ].join('\n') + '\n',
  );
  return 0;
}

export function sinfo(ctx) {
  const { cluster } = ctx.sh;
  const used = cluster.gpusInUse();
  const state = used === 0 ? 'idle' : used >= NODE.gpus ? 'alloc' : 'mix';
  ctx.out('PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST\n');
  for (const [name, p] of Object.entries(PARTITIONS)) {
    ctx.out(`${(name + (p.default ? '*' : '')).padEnd(9)} ${'up'.padStart(5)} ${fmtTime(p.limitMin).padStart(10)} ${'1'.padStart(6)} ${state.padStart(6)} ${NODE.name}\n`);
  }
  if (ctx.args.join(' ').match(/gres|-G|%G/)) {
    ctx.out(`\nGRES: gpu:rtx_pro_6000:${NODE.gpus}  in use: ${used}  free: ${NODE.gpus - used}\n`);
  }
  return 0;
}

export function nvidiaSmi(ctx) {
  const { cluster, user } = ctx.sh;
  const session = cluster.interactive;
  const owners = [];
  for (const j of cluster.jobs.filter((x) => x.state === 'R')) for (let i = 0; i < j.gpus; i++) owners.push(j);
  const count = session ? session.gpus : NODE.gpus;
  if (session && count === 0) {
    ctx.err('No devices were found\n');
    ctx.coach('smi-none', 'Your session has no GPUs. Ask for one with `--gres=gpu:1` when you start `srun`.');
    return 6;
  }
  const row = (a, b, c) => `| ${a.padEnd(39)} | ${b.padStart(22)} | ${c.padStart(20)} |`;
  const rule = (ch, joint) => joint + ch.repeat(41) + joint.replace('|', '+') + ch.repeat(24) + '+' + ch.repeat(22) + joint;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const busy = session ? null : owners[i];
    const mem = busy ? 41000 + i * 1373 : 0;
    const util = busy ? 87 - i * 3 : 0;
    rows.push(row(`${String(i).padStart(3)}  ${NODE.gpuModel}`, `${mem}MiB / ${NODE.gpuMemMiB}MiB`, `${util}%     Default`));
  }
  const top = '+' + '-'.repeat(89) + '+';
  ctx.out(
    [
      top,
      '| ' + 'NVIDIA-SMI 570.86.15        Driver Version: 570.86.15        CUDA Version: 12.8'.padEnd(88) + '|',
      rule('-', '|'),
      row('GPU  Name', 'Memory-Usage', 'GPU-Util  Compute M.'),
      rule('=', '|'),
      ...rows,
      top,
    ].join('\n') + '\n',
  );
  if (!session) {
    const free = NODE.gpus - cluster.gpusInUse();
    ctx.out(`${free} of ${NODE.gpus} GPUs are free right now.\n`, 'dim');
    if (user) ctx.coach('smi-host', 'This shows every GPU on Geiss-01, including ones other students are using. Ask Slurm for your own with `srun --gres=gpu:1 --pty bash`.');
  }
  return 0;
}

export function srun(ctx) {
  const { sh } = ctx;
  const { cluster } = sh;
  const opts = {};
  const command = readOptions(ctx.args, opts);
  if (!command.length) {
    ctx.err('srun: fatal: No command given to execute.\n');
    ctx.coach('srun-cmd', 'For an interactive shell, use `srun --pty bash`.');
    return 1;
  }
  if (cluster.interactive) {
    ctx.err('srun: error: You are already inside an interactive job. Type `exit` to leave it first.\n');
    return 1;
  }
  const err = validate(opts);
  if (err) { ctx.err(err.replace(/sbatch/g, 'srun') + '\n'); return 1; }
  const gpus = gpusFrom(opts);
  const id = cluster.nextJobId++;
  if (NODE.gpus - cluster.gpusInUse() < gpus) {
    ctx.err(`srun: job ${id} queued and waiting for resources\n`);
    ctx.coach('srun-wait', 'Every GPU is busy. On the real server srun would wait here until one frees up.');
    return 1;
  }
  const job = cluster.makeJob({ id, name: command[0], gpus, memGB: parseMem(opts.mem) ?? 4, timeMin: parseTime(opts.time) ?? 60, state: 'R', startStep: cluster.step, runSteps: Infinity });
  cluster.jobs.push(job);
  if (opts.pty !== undefined && /^(bash|sh)$/.test(command[0])) {
    cluster.interactive = { jobId: id, gpus };
    ctx.out(`srun: job ${id} queued and waiting for resources\nsrun: job ${id} has been allocated resources\n`);
    ctx.coach('srun-in', `You're in an interactive job with ${gpus} GPU${gpus === 1 ? '' : 's'}. Type \`exit\` when you're done so others can use ${gpus === 1 ? 'it' : 'them'}.`);
    return 0;
  }
  // Run one command inside a temporary allocation.
  cluster.interactive = { jobId: id, gpus };
  const code = sh.exec(command[0], { ...ctx, name: command[0], args: command.slice(1) });
  cluster.interactive = null;
  job.state = 'CD';
  job.endStep = cluster.step;
  return code;
}

export function endInteractive(sh) {
  const { cluster } = sh;
  const job = cluster.jobs.find((j) => j.id === cluster.interactive.jobId);
  if (job) { job.state = 'CD'; job.endStep = cluster.step; job.exitCode = 0; }
  cluster.interactive = null;
}

