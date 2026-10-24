// Simulated Geiss-01: one machine with 8 GPUs and ~356 GB RAM, Slurm,
// environment modules, and conda. Time moves forward one step per command.

export const NODE = {
  name: 'geiss-01',
  gpus: 8,
  gpuModel: 'NVIDIA RTX PRO 6000 Blackwell',
  gpuMemMiB: 97887,
  memGB: 356,
  cpus: 64,
};

export const PARTITIONS = {
  gpu: { limitMin: 48 * 60, default: true },
  short: { limitMin: 60, default: false },
};

export const MODULES = [
  { name: 'anaconda', version: '2025.06', provides: ['conda'] },
  { name: 'cuda', version: '12.8', provides: ['nvcc'] },
  { name: 'rosetta', version: '3.14', provides: ['relax.linuxgccrelease', 'rosetta_scripts.linuxgccrelease'] },
  { name: 'pyrosetta', version: '2025.03', provides: [] },
  { name: 'alphafold', version: '2.3.2', provides: ['run_alphafold.py'] },
  { name: 'colabfold', version: '1.5.5', provides: ['colabfold_batch'] },
];

export const CONDA_ENVS = {
  base: [],
  proteinmpnn: ['/opt/ProteinMPNN/protein_mpnn_run.py'],
  rfdiffusion: ['/opt/RFdiffusion/scripts/run_inference.py'],
};

// ProteinMPNN and RFdiffusion are GitHub repos cloned into /opt, not commands on
// PATH. You run their scripts with the python from their conda environment.
export const REPO_SCRIPTS = Object.fromEntries(
  Object.entries(CONDA_ENVS).flatMap(([env, paths]) => paths.map((p) => [p, env])),
);
export const repoScriptNamed = (name) => Object.keys(REPO_SCRIPTS).find((p) => p.endsWith('/' + name.split('/').pop()));

const MINUTE = 60_000;

export class Cluster {
  constructor({ user = 'student', now = Date.now(), modules = [], conda = null, jobs = [], gpusBusy = 2, jobRules = [] } = {}) {
    // jobRules let a scenario decide how a submitted script behaves, e.g.
    // { "match": "run_mpnn.sh", "needsGpu": true, "needsTimeMin": 90, "creates": ["outputs/seqs.fa"] }
    this.jobRules = jobRules;
    this.user = user;
    this.start = now;
    this.step = 0;
    this.modules = [...modules];
    this.condaEnv = conda;
    this.nextJobId = 48213;
    this.jobs = [];
    this.background = [];
    this.interactive = null; // an srun session: { jobId, gpus }
    // Other people's jobs keep some GPUs busy so the queue looks real.
    const others = [
      { user: 'ahernandez', name: 'rfdiff', gpus: 1 },
      { user: 'kpatel', name: 'af2_screen', gpus: 1 },
      { user: 'mlee', name: 'colabfold', gpus: 2 },
      { user: 'jnguyen', name: 'relax', gpus: 1 },
    ];
    let busy = 0;
    for (const o of others) {
      if (busy + o.gpus > gpusBusy) break;
      busy += o.gpus;
      this.jobs.push(this.makeJob({ ...o, state: 'R', startStep: -30, runSteps: 10_000, timeMin: 24 * 60, memGB: 64 }));
    }
    for (const j of jobs) this.jobs.push(this.makeJob({ user, ...j }));
  }

  clock() {
    return this.start + this.step * MINUTE;
  }

  makeJob(spec) {
    return {
      id: spec.id ?? this.nextJobId++,
      name: spec.name ?? 'job',
      user: spec.user ?? this.user,
      partition: spec.partition ?? 'gpu',
      state: spec.state ?? 'PD',
      gpus: spec.gpus ?? 0,
      memGB: spec.memGB ?? 4,
      timeMin: spec.timeMin ?? 60,
      submitStep: spec.submitStep ?? this.step,
      startStep: spec.startStep ?? null,
      runSteps: spec.runSteps ?? 3,
      result: spec.result ?? 'COMPLETED',
      exitCode: spec.exitCode ?? null,
      output: spec.output ?? null,
      log: spec.log ?? null,
      creates: spec.creates ?? [],
      cwd: spec.cwd ?? null,
      reason: spec.reason ?? null,
      memUsedGB: spec.memUsedGB ?? null,
      dependency: spec.dependency ?? null,
      afterJob: spec.dependency ?? null, // kept after the dependency is met
      interactive: spec.interactive ?? false,
    };
  }

  gpusInUse() {
    return this.jobs.filter((j) => j.state === 'R').reduce((n, j) => n + j.gpus, 0);
  }

  ruleFor(scriptPath, scriptText) {
    return this.jobRules.find((r) => !r.match || scriptPath.endsWith(r.match) || scriptText.includes(r.match)) ?? {};
  }

  path() {
    const bins = ['/usr/local/bin', '/usr/bin', '/bin'];
    for (const m of this.modules) bins.unshift(`/opt/modules/${m}/${this.findModule(m)?.version}/bin`);
    if (this.condaEnv) bins.unshift(`/opt/conda/envs/${this.condaEnv}/bin`);
    return bins.join(':');
  }

  findModule(spec) {
    const [name, version] = spec.split('/');
    return MODULES.find((m) => m.name === name && (!version || m.version === version)) ?? null;
  }

  missingCommandTip(cmd) {
    if (cmd === 'conda') return 'The `conda` command appears only after its module is loaded. Try `module load anaconda`.';
    const mod = MODULES.find((m) => m.provides.includes(cmd));
    if (mod) return `\`${cmd}\` comes from a module. Try \`module avail\`, then \`module load ${mod.name}\`.`;
    const script = repoScriptNamed(cmd);
    if (script) return `\`${cmd.split('/').pop()}\` is a Python script in ${script.slice(0, script.lastIndexOf('/'))}. Activate the \`${REPO_SCRIPTS[script]}\` environment, then run \`python ${script}\`.`;
    return null;
  }

  startBackground(name, args) {
    const pid = 31000 + this.background.length * 7 + this.step;
    this.background.push({ pid, command: [name, ...args].join(' '), doneStep: this.step + 3 });
    return pid;
  }

  // Advance simulated time by one step after every command.
  tick(sh) {
    this.step++;
    for (const job of this.jobs) {
      if (job.user !== this.user) continue;
      if (job.state === 'PD' && job.dependency) {
        const [kind, depId] = job.dependency.split(':');
        const dep = this.jobs.find((j) => String(j.id) === depId);
        if (!dep || ['F', 'TO', 'OOM', 'CA'].includes(dep.state)) job.reason = 'DependencyNeverSatisfied';
        else if (dep.state === 'CD' || (kind === 'afterany' && dep.endStep)) { job.dependency = null; job.submitStep = this.step - 1; }
        else job.reason = 'Dependency';
        if (job.dependency) continue;
        if (job.reason === 'Dependency') job.reason = null;
      }
      if (job.state === 'PD' && this.step - job.submitStep >= 2) {
        const gpuFree = NODE.gpus - this.gpusInUse() >= job.gpus;
        if (job.reason === 'Resources') job.reason = null;
        if (gpuFree && !job.reason) {
          job.state = 'R';
          job.startStep = this.step;
        } else {
          job.reason = job.reason ?? 'Resources';
        }
      } else if (job.state === 'R' && this.step - job.startStep >= job.runSteps) {
        this.finish(job, sh);
      }
    }
  }

  finish(job, sh) {
    const states = { COMPLETED: ['CD', 0], FAILED: ['F', 1], TIMEOUT: ['TO', 0], OUT_OF_MEMORY: ['OOM', 0] };
    const [state, code] = states[job.result] ?? ['CD', 0];
    job.state = state;
    job.exitCode = job.exitCode ?? code;
    job.endStep = this.step;
    if (job.output && sh) {
      const tail = {
        COMPLETED: '',
        FAILED: 'Error: job script exited with status 1\n',
        TIMEOUT: `slurmstepd: error: *** JOB ${job.id} ON geiss-01 CANCELLED DUE TO TIME LIMIT ***\n`,
        OUT_OF_MEMORY: `slurmstepd: error: Detected 1 oom_kill event in StepId=${job.id}.batch. Some of the step tasks have been OOM Killed.\n`,
      }[job.result] ?? '';
      try {
        sh.vfs.writeFile(job.output, (job.log ?? '') + tail, { mtime: this.clock() });
        for (const path of job.creates) {
          if (job.result === 'COMPLETED') {
            sh.vfs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { parents: true, mtime: this.clock() });
            sh.vfs.writeFile(path, '', { mtime: this.clock() });
          }
        }
      } catch {
        // Output folder was deleted; real Slurm would silently lose the log too.
      }
    }
  }

  fmtElapsed(job) {
    if (job.startStep === null) return '0:00';
    const end = job.endStep ?? this.step;
    const secs = Math.max(0, end - job.startStep) * 37;
    const m = Math.floor(secs / 60);
    const h = Math.floor(m / 60);
    const s = String(secs % 60).padStart(2, '0');
    return h ? `${h}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
}
