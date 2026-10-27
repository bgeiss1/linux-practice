// The "Asking Slurm for resources" guide: what each option asks for, why it
// matters on a shared machine, and what happens when you leave it out.

import { breakdownHTML, esc, fmt } from './terminal.js';

const INTERACTIVE = [
  { code: 'srun', note: 'Ask Slurm to run something for you as soon as the resources are free. It waits in the queue like any job, then runs.' },
  { code: '--gres=gpu:2', note: '"Generic resource": GPUs, and how many. Slurm sets aside 2 of the 8 GPUs for you alone, and your programs can only see those 2.' },
  { code: '--mem=48G', note: 'Memory (RAM) for the whole job. Go over it and Slurm kills the job. `G` means gigabytes; `M` means megabytes.' },
  { code: '--pty', note: 'Connect the job to your keyboard and screen, so you can type in it.' },
  { code: 'bash', note: 'The program to run inside the job: a new shell. Your prompt comes back, but now you are inside the job until you type `exit`.' },
];

const BATCH = [
  { code: '#!/bin/bash', note: 'The script runs with bash.' },
  { code: '#SBATCH --job-name=fold', note: 'The name you see in `squeue` and `sacct`.' },
  { code: '#SBATCH --partition=gpu', note: 'Which queue. `gpu` allows 2 days; `short` allows 1 hour.' },
  { code: '#SBATCH --gres=gpu:1', note: 'One GPU. Leave it out and the job gets none.' },
  { code: '#SBATCH --mem=32G', note: 'Up to 32 GB of RAM.' },
  { code: '#SBATCH --time=02:00:00', note: 'Stop the job after 2 hours, finished or not.' },
  { code: '#SBATCH --output=slurm-%j.out', note: 'Where the printed output goes. `%j` becomes the job ID.' },
];

const OPTIONS = [
  ['--gres=gpu:N', 'N GPUs', 'No GPU. GPU tools stop with "No CUDA GPUs are available".', 'Waits until N GPUs are free, and holds GPUs classmates could use.'],
  ['--mem=NG', 'N GB of RAM', 'The default: 16 GB for each GPU, or 4 GB with no GPU. Bigger jobs die with OUT_OF_MEMORY.', 'Waits longer, and that memory sits unused. There\'s only about 20 GB per GPU when all 8 are busy.'],
  ['--time=HH:MM:SS', 'A time limit', 'The default (1 hour here). Longer jobs die with TIMEOUT.', 'Allowed up to the partition limit, but short jobs can start sooner.'],
  ['--partition=NAME', 'A queue', 'The default queue, gpu.', 'Asking `short` for over 1 hour leaves the job pending forever (PartitionTimeLimit).'],
  ['--cpus-per-task=N', 'N CPU cores', '1 core. Fine for most GPU tools.', 'Cores sit idle unless the program uses threads.'],
  ['--job-name=NAME', 'A label', 'The script name.', 'Nothing bad; it just helps you find the job.'],
];

const SIZES = [
  ['ColabFold', '1', '32G (48G for big complexes)', '01:00:00–03:00:00'],
  ['Chai-1', '1', '32G', '01:00:00'],
  ['ProteinMPNN', '0 or 1', '16G', '01:00:00'],
  ['RFD4-Proteina', '1', '32G', '01:00:00–02:00:00'],
  ['GROMACS mdrun', '1', '8G', 'Depends on the length: about 4 minutes per ns here'],
  ['AlphaFold', '1', '48G', '04:00:00'],
  ['Rosetta relax', '0', '16G and up', '02:00:00'],
];

const ERRORS = [
  ['RuntimeError: No CUDA GPUs are available', 'You asked for no GPU.', 'Add `--gres=gpu:1`.'],
  ['State OUT_OF_MEMORY in sacct', 'The job used more than `--mem`.', 'Raise `--mem`. `seff JOBID` shows how much it used.'],
  ['State TIMEOUT', 'The job ran past `--time`.', 'Raise `--time`, within the partition limit.'],
  ['Pending with reason (PartitionTimeLimit)', '`--time` is longer than the partition allows.', 'Shorten `--time`, or pick the `gpu` partition.'],
  ['Requested node configuration is not available', 'You asked for more than Geiss-01 can give one job (8 GPUs, about 174 GB).', 'Ask for less.'],
  ['Pending with reason (Resources)', 'Not enough is free right now.', 'Wait, or ask for less if you can.'],
];

const table = (head, rows, { codeFirst = true } = {}) => `<div class="table-wrap"><table>
  <thead><tr>${head.map((x) => `<th scope="col">${esc(x)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td>${i === 0 && codeFirst ? `<code>${esc(c)}</code>` : fmt(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`;

export function guideHTML() {
  return `<article class="guide">
    <nav class="crumbs"><a href="#/">Tracks</a> / Guide</nav>
    <header style="display:grid;gap:8px">
      <h1>Asking Slurm for GPUs, memory and time</h1>
      <p class="lede">Geiss-01 has 8 GPUs, about 190 GB of memory and 64 CPU cores, and the whole class shares them. Slurm hands them out. You get exactly what you ask for: nothing more, and nothing you forgot to ask for.</p>
    </header>

    <section aria-labelledby="g-why">
      <h2 id="g-why">Why you have to ask</h2>
      <ul>
        <li><strong>Ask for too little</strong> and Slurm stops your job: a GPU tool finds no GPU, or the job is killed for using too much memory or running too long.</li>
        <li><strong>Ask for too much</strong> and you wait longer for it to be free, while GPUs and memory sit idle that a classmate could have used.</li>
        <li>What you're given is yours alone until the job ends, so <code>exit</code> an interactive job as soon as you're done.</li>
      </ul>
    </section>

    <section aria-labelledby="g-budget">
      <h2 id="g-budget">Memory is the tightest resource</h2>
      <p>Each GPU has 96 GB of its own memory (VRAM), which comes with the GPU when you ask for <code>--gres=gpu:1</code>. <code>--mem</code> asks for the machine's main memory (RAM), and there is much less of it: about 190 GB for everyone. Slurm keeps 16 GB for the system, so jobs share about 174 GB. With all 8 GPUs busy, that's only about 20 GB of RAM per GPU.</p>
      <ul>
        <li>In this course each student can hold at most <strong>2 GPUs and 48 GB of RAM</strong> at a time.</li>
        <li>Leave out <code>--mem</code> and a job gets 16 GB for each GPU it asks for, or 4 GB with no GPU. That's enough for ProteinMPNN or a small fold.</li>
        <li>Ask for what the job needs, plus a little room. <code>seff JOBID</code> after a run shows how much it really used.</li>
      </ul>
    </section>

    <section aria-labelledby="g-srun">
      <h2 id="g-srun">One command, taken apart</h2>
      <p>This starts an interactive job with 2 GPUs and 48 GB of memory, and puts you inside it:</p>
      ${breakdownHTML(INTERACTIVE)}
      <p>Inside the job, <code>nvidia-smi</code> shows only your 2 GPUs. Type <code>exit</code> to leave and give them back. Anything you start there stops when you leave.</p>
    </section>

    <section aria-labelledby="g-sbatch">
      <h2 id="g-sbatch">The same requests in a job script</h2>
      <p>For long runs, write a script and submit it with <code>sbatch script.sh</code>. It runs without you, even after you log out. The <code>#SBATCH</code> lines at the top use the same options as <code>srun</code>:</p>
      ${breakdownHTML(BATCH, { lines: true })}
      <p>Options typed on the command line win over the script, so <code>sbatch --time=04:00:00 fold.sh</code> gives that run 4 hours.</p>
    </section>

    <section aria-labelledby="g-opts">
      <h2 id="g-opts">The options you'll use</h2>
      ${table(['Option', 'Asks for', 'If you leave it out', 'If you ask for too much'], OPTIONS)}
      <p class="muted">Short forms: <code>-p</code> is <code>--partition</code>, <code>-t</code> is <code>--time</code>, <code>-J</code> is <code>--job-name</code>, <code>-c</code> is <code>--cpus-per-task</code>. Time can be <code>MM</code>, <code>HH:MM:SS</code>, or <code>D-HH:MM:SS</code> for days.</p>
    </section>

    <section aria-labelledby="g-size">
      <h2 id="g-size">How much to ask for</h2>
      <p>These are the requests the exercises use. They're starting points: after a real run, <code>seff JOBID</code> shows how much memory and time the job actually used, so you can ask for that plus some headroom next time.</p>
      ${table(['Tool', 'GPUs', 'Memory', 'Time'], SIZES, { codeFirst: false })}
    </section>

    <section aria-labelledby="g-check">
      <h2 id="g-check">Checking what you got</h2>
      <ul>
        <li><code>squeue --me</code> lists your jobs. <code>R</code> means running, and <code>PD</code> means waiting, with the reason in brackets.</li>
        <li><code>nvidia-smi</code> inside an interactive job shows the GPUs you were given.</li>
        <li><code>sacct</code> shows how each finished job ended, and <code>seff JOBID</code> shows the memory and time it used.</li>
      </ul>
    </section>

    <section aria-labelledby="g-errors">
      <h2 id="g-errors">When a request goes wrong</h2>
      ${table(['You see', 'What it means', 'Fix'], ERRORS)}
    </section>

    <p><a class="btn" href="#/track/session">Practice: Start a session</a> <a class="btn" href="#/track/slurm">Practice: Run Slurm jobs</a></p>
  </article>`;
}
