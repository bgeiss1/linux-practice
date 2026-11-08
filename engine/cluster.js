// Simulated Geiss-01: one machine with 8 GPUs and ~190 GB RAM, Slurm,
// environment modules, and conda. Time moves forward one step per command.

export const NODE = {
  name: 'geiss-01',
  gpus: 8,
  gpuModel: 'NVIDIA RTX PRO 6000 Blackwell',
  gpuMemMiB: 97887,
  memGB: 190,
  // Slurm keeps 16 GB for the system (MemSpecLimit), so jobs share the rest.
  jobMemGB: 174,
  cpus: 64,
  // Memory a job gets without --mem: 16 GB per GPU (DefMemPerGPU), 4 GB with no GPU.
  defMemPerGpuGB: 16,
  defMemGB: 4,
};

export const defaultMemGB = (gpus) => (gpus > 0 ? gpus * NODE.defMemPerGpuGB : NODE.defMemGB);

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
  { name: 'gromacs', version: '2024.4', provides: ['gmx'] },
];

// Conda environments. Some put commands on PATH when active (chai-lab,
// rfd4-generate); ProteinMPNN is a GitHub repo cloned into /opt whose scripts
// you run with the python from its environment.
export const CONDA_ENVS = {
  base: {},
  proteinmpnn: {
    scripts: [
      '/opt/ProteinMPNN/protein_mpnn_run.py',
      '/opt/ProteinMPNN/helper_scripts/parse_multiple_chains.py',
      '/opt/ProteinMPNN/helper_scripts/assign_fixed_chains.py',
      '/opt/ProteinMPNN/helper_scripts/make_fixed_positions_dict.py',
    ],
  },
  chai: { commands: ['chai-lab'] },
  rfd4: { commands: ['rfd4-generate', 'rfd4-evaluate'] },
};

export const REPO_SCRIPTS = Object.fromEntries(
  Object.entries(CONDA_ENVS).flatMap(([env, e]) => (e.scripts ?? []).map((p) => [p, env])),
);
export const repoScriptNamed = (name) => Object.keys(REPO_SCRIPTS).find((p) => p.endsWith('/' + name.split('/').pop()));
// The conda environment that provides a command, if any.
export const envForCommand = (name) => Object.keys(CONDA_ENVS).find((env) => CONDA_ENVS[env].commands?.includes(name)) ?? null;

const MINUTE = 60_000;

export class Cluster {
  constructor({ user = 'student', now = Date.now(), modules = [], conda = null, jobs = [], gpusBusy = 2, jobRules = [], liveJobs = false, processes = [] } = {}) {
    // jobRules let a scenario decide how a submitted script behaves, e.g.
    // { "match": "run_mpnn.sh", "needsGpu": true, "needsTimeMin": 90, "creates": ["outputs/seqs.fa"] }
    this.jobRules = jobRules;
    // With liveJobs, a job script no rule matches really runs when the job
    // ends: its commands write the log, and they decide how the job ends.
    this.liveJobs = liveJobs;
    this.user = user;
    this.start = now;
    this.step = 0;
    this.modules = [...modules];
    this.condaEnv = conda;
    this.nextJobId = 48213;
    this.jobs = [];
    this.background = [];
    this.interactive = null; // an srun session: { jobId, gpus }
    // Processes a scenario starts, e.g. a stuck script left running yesterday:
    // { "command": "python score.py", "pid": 31877, "cpu": 99.8, "memGB": 22, "ignoresTerm": true }
    // A process with no terminal (tty "?") only shows in ps -u / ps ux / htop.
    this.procs = processes.map((p, i) => ({
      pid: Number(p.pid ?? 32051 + i * 113),
      user: p.user ?? user,
      command: p.command,
      cpu: Number(p.cpu ?? 0),
      memGB: Number(p.memGB ?? 0.2),
      state: p.state ?? (Number(p.cpu ?? 0) > 5 ? 'R' : 'S'),
      tty: p.tty ?? '?',
      ignoresTerm: !!p.ignoresTerm,
      startStep: Number(p.startStep ?? -900),
      gone: null,
    }));
    // Other people's jobs keep some GPUs busy so the queue looks real.
    const others = [
      { user: 'ahernandez', name: 'rfdiff', gpus: 1, memGB: 16 },
      { user: 'kpatel', name: 'af2_screen', gpus: 1, memGB: 32 },
      { user: 'mlee', name: 'colabfold', gpus: 2, memGB: 48 },
      { user: 'jnguyen', name: 'relax', gpus: 1, memGB: 16 },
      { user: 'tbrooks', name: 'gmx_md', gpus: 1, memGB: 16 },
      { user: 'rsingh', name: 'chai_fold', gpus: 1, memGB: 24 },
    ];
    let busy = 0;
    for (const o of others) {
      if (busy + o.gpus > gpusBusy) break;
      busy += o.gpus;
      this.jobs.push(this.makeJob({ ...o, state: 'R', startStep: -30, runSteps: 10_000, timeMin: 24 * 60 }));
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
      memGB: spec.memGB ?? defaultMemGB(spec.gpus ?? 0),
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
      live: spec.live ?? false,
      script: spec.script ?? null,
      env: spec.env ?? null,
      cpus: spec.cpus ?? 1,
      elapsedMin: spec.elapsedMin ?? null,
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
    const env = envForCommand(cmd);
    if (env) return `\`${cmd}\` is installed in the \`${env}\` conda environment. Run \`module load anaconda\`, then \`conda activate ${env}\`.`;
    const script = repoScriptNamed(cmd);
    if (script) return `\`${cmd.split('/').pop()}\` is a Python script in ${script.slice(0, script.lastIndexOf('/'))}. Activate the \`${REPO_SCRIPTS[script]}\` environment, then run \`python ${script}\`.`;
    return null;
  }

  startBackground(name, args, code = 0) {
    const pid = 31000 + this.background.length * 7 + this.step;
    // Time moves one minute per command, so `sleep 600 &` runs for ten commands.
    const secs = name === 'sleep' ? parseFloat(args[0]) : NaN;
    // A command that failed straight away (missing file, typo) is already gone.
    const steps = code !== 0 ? 0 : this.foreverNext ? Infinity : Number.isFinite(secs) ? Math.max(1, Math.ceil(secs / 60)) : 3;
    this.foreverNext = false;
    this.background.push({ pid, command: [name, ...args].join(' '), startStep: this.step, doneStep: this.step + steps, signal: null });
    return pid;
  }

  // Every process on the machine right now, as ps, top and htop see it.
  // laptop: only the student's own shell and what they started.
  processList({ laptop = false } = {}) {
    const me = this.user;
    const list = [];
    const add = (p) => list.push({ ppid: 1, tty: '?', state: 'S', cpu: 0, memGB: 0.01, startStep: -17_000, ...p });
    if (!laptop) {
      add({ pid: 1, user: 'root', command: '/sbin/init splash', comm: 'systemd', memGB: 0.01 });
      add({ pid: 812, user: 'root', command: 'sshd: /usr/sbin/sshd -D [listener]', comm: 'sshd' });
      add({ pid: 1033, user: 'munge', command: '/usr/sbin/munged', comm: 'munged' });
      add({ pid: 1104, user: 'slurm', command: '/usr/sbin/slurmctld --systemd', comm: 'slurmctld', cpu: 0.3, memGB: 0.2 });
      add({ pid: 1121, user: 'root', command: '/usr/sbin/slurmd --systemd', comm: 'slurmd', cpu: 0.1, memGB: 0.05 });
      add({ pid: 1188, user: 'root', command: '/usr/bin/nvidia-persistenced --verbose', comm: 'nvidia-persistenced' });
      const PROGRAMS = {
        rfdiff: ['python run_inference.py inference.num_designs=200', 98.7],
        af2_screen: ['python run_alphafold.py --fasta_paths=screen.fasta', 101.2],
        colabfold: ['colabfold_batch batch.fasta out/', 187.5],
        relax: ['relax.linuxgccrelease -s design.pdb -nstruct 50', 99.9],
        gmx_md: ['gmx mdrun -deffnm md -nb gpu', 391.4],
        chai_fold: ['chai-lab fold complex.fasta out/', 96.3],
      };
      for (const job of this.jobs) {
        if (job.state !== 'R' || job.interactive) continue;
        const base = 20_000 + ((Number(String(job.id).split('_')[0]) * 37 + (String(job.id).split('_')[1] ?? 0) * 11) % 9_000);
        add({ pid: base, ppid: 1121, user: 'root', command: `slurmstepd: [${job.id}.batch]`, comm: 'slurmstepd', memGB: 0.01, startStep: job.startStep });
        if (job.user === me) {
          add({ pid: base + 3, ppid: base, user: me, command: `/bin/bash /var/spool/slurmd/job${job.id}/slurm_script`, comm: 'slurm_script', state: 'R', cpu: 97.6, memGB: Math.min(job.memGB, job.memUsedGB ?? 3.1), startStep: job.startStep, jobId: job.id });
        } else {
          const [command, cpu] = PROGRAMS[job.name] ?? [`python ${job.name}.py`, 99.1];
          add({ pid: base + 3, ppid: base, user: job.user, command, state: 'R', cpu, memGB: job.memGB * 0.62, startStep: job.startStep, jobId: job.id });
        }
      }
    }
    add({ pid: 30408, user: me, command: `sshd: ${me}@pts/0`, comm: 'sshd', ppid: 812, startStep: -2, session: true });
    add({ pid: 30412, user: me, command: '-bash', comm: 'bash', ppid: 30408, tty: 'pts/0', memGB: 0.005, startStep: -2, login: true });
    if (this.interactive && !this.interactive.batch) {
      const id = this.interactive.jobId;
      const srun = 33_000 + (Number(id) % 1_000) * 3;
      const job = this.jobs.find((j) => j.id === id);
      add({ pid: srun, ppid: 30412, user: me, command: `srun --gres=gpu:${this.interactive.gpus} --pty bash`, comm: 'srun', tty: 'pts/0', startStep: job?.startStep ?? 0, interactive: true });
      add({ pid: srun + 9, ppid: srun, user: me, command: '/bin/bash', comm: 'bash', tty: 'pts/1', startStep: job?.startStep ?? 0, interactive: true });
    }
    this.background.forEach((b, i) => {
      if (b.signal || this.step >= b.doneStep) return;
      const busy = !b.command.startsWith('sleep');
      add({ pid: b.pid, ppid: 30412, user: me, command: b.command, tty: 'pts/0', state: busy ? 'R' : 'S', cpu: busy ? 99.5 : 0, memGB: busy ? 1.4 : 0.001, startStep: b.startStep ?? this.step, jobSpec: i + 1 });
    });
    for (const p of this.procs) if (!p.gone) add({ ...p, ppid: 1, proc: p });
    return list.sort((a, b) => a.pid - b.pid);
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
    // A live job runs its script now; the commands decide how it ends.
    if (job.live && sh) Object.assign(job, sh.runJob(job));
    const states = { COMPLETED: ['CD', 0], FAILED: ['F', 1], TIMEOUT: ['TO', 0], OUT_OF_MEMORY: ['OOM', 0] };
    const [state, code] = states[job.result] ?? ['CD', 0];
    job.state = state;
    job.exitCode = job.exitCode ?? code;
    job.endStep = this.step;
    if (job.output && sh) {
      const tail = {
        COMPLETED: '',
        FAILED: job.live ? '' : 'Error: job script exited with status 1\n',
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
    const secs = job.endStep && job.elapsedMin !== null ? Math.round(job.elapsedMin * 60) : Math.max(0, end - job.startStep) * 37;
    const m = Math.floor(secs / 60);
    const h = Math.floor(m / 60);
    const s = String(secs % 60).padStart(2, '0');
    return h ? `${h}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
}
