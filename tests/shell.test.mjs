import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Shell } from '../engine/shell.js';
import { fromLibrary } from '../engine/library.js';
import { parse } from '../engine/parser.js';
import { WORDS, makePassphrase, readSubmission, keywordProblem, SUGGESTED_KEYWORDS } from '../engine/passphrase.js';

function shell() {
  const sh = new Shell();
  sh.vfs.mkdir('/home/student/proj/inputs', { parents: true });
  sh.vfs.writeFile('/home/student/proj/inputs/a.pdb', 'ATOM 1\nATOM 2\nHETATM 3\n');
  sh.vfs.writeFile('/home/student/proj/inputs/b.pdb', 'ATOM 1\n');
  sh.vfs.writeFile('/home/student/proj/run.sh', '#!/bin/bash\n#SBATCH --gres=gpu:1\necho "arg=$1"\n');
  return sh;
}

const text = (r) => r.output.map((s) => s.text).join('');
const errors = (r) => r.output.filter((s) => s.cls === 'err').map((s) => s.text).join('');

test('parser handles quotes, pipes, redirects and connectors', () => {
  const lists = parse('cd "run 1" && grep -c ATOM *.pdb | sort -n > out.txt; echo done');
  assert.equal(lists.length, 3);
  assert.equal(lists[0].commands[0].argv[1].text, 'run 1');
  assert.equal(lists[1].commands.length, 2);
  assert.deepEqual(lists[1].commands[1].redirects, [{ fd: 1, append: false, target: 'out.txt' }]);
});

test('cd, pwd, cd - and ..', () => {
  const sh = shell();
  sh.run('cd proj/inputs');
  assert.equal(text(sh.run('pwd')), '/home/student/proj/inputs\n');
  sh.run('cd ../..');
  assert.equal(sh.cwd, '/home/student');
  assert.equal(text(sh.run('cd -')), '/home/student/proj/inputs\n');
});

test('globs, pipes and redirects', () => {
  const sh = shell();
  sh.run('cd proj/inputs');
  assert.equal(text(sh.run('ls *.pdb')), 'a.pdb  b.pdb\n');
  assert.equal(text(sh.run('cat *.pdb | grep -c ATOM')), '3\n');
  sh.run('grep ATOM a.pdb > atoms.txt');
  assert.equal(sh.vfs.readFile('/home/student/proj/inputs/atoms.txt'), 'ATOM 1\nATOM 2\n');
  sh.run('echo extra >> atoms.txt');
  assert.equal(text(sh.run('wc -l atoms.txt')), '3 atoms.txt\n');
});

test('find by name and type', () => {
  const sh = shell();
  assert.equal(text(sh.run('find . -name "*.pdb"')), './proj/inputs/a.pdb\n./proj/inputs/b.pdb\n');
  assert.equal(text(sh.run('find proj -type d')), 'proj\nproj/inputs\n');
});

test('errors match bash and give a tip', () => {
  const sh = shell();
  const r = sh.run('cd Proj');
  assert.equal(errors(r), 'bash: cd: Proj: No such file or directory\n');
  assert.match(r.coach[0].text, /Did you mean `proj`/);
  assert.equal(errors(sh.run('frobnicate')), 'bash: frobnicate: command not found\n');
});

test('scripts need execute permission and get arguments', () => {
  const sh = shell();
  sh.run('cd proj');
  assert.match(errors(sh.run('./run.sh')), /Permission denied/);
  sh.run('chmod +x run.sh');
  assert.equal(text(sh.run('./run.sh hello')), 'arg=hello\n');
});

test('rm protects / and rm -r removes folders', () => {
  const sh = shell();
  assert.match(errors(sh.run('rm -rf /')), /dangerous/);
  assert.match(errors(sh.run('rm proj')), /Is a directory/);
  sh.run('rm -r proj');
  assert.equal(sh.vfs.get('/home/student/proj'), null);
});

test('conda needs its module; jobs move through the queue', () => {
  const sh = shell();
  assert.match(errors(sh.run('conda activate proteinmpnn')), /command not found/);
  sh.run('module load anaconda');
  sh.run('conda activate proteinmpnn');
  assert.equal(sh.cluster.condaEnv, 'proteinmpnn');
  sh.run('cd proj');
  assert.equal(text(sh.run('sbatch run.sh')).trim(), `Submitted batch job ${sh.cluster.nextJobId - 1}`);
  assert.match(text(sh.run('squeue --me')), / PD /);
  for (let i = 0; i < 6; i++) sh.run('true');
  assert.match(text(sh.run('sacct')), /COMPLETED/);
});

test('jobs asking for more than Geiss-01 has are rejected', () => {
  const sh = shell();
  sh.vfs.writeFile('/home/student/big.sh', '#!/bin/bash\n#SBATCH --gres=gpu:9\n');
  assert.match(errors(sh.run('sbatch big.sh')), /Requested node configuration is not available/);
  sh.vfs.writeFile('/home/student/mem.sh', '#!/bin/bash\n#SBATCH --mem=500G\n');
  assert.match(errors(sh.run('sbatch mem.sh')), /Memory specification/);
});

test('passphrases mix the track keyword with three random words', () => {
  assert.ok(WORDS.length >= 200);
  const kws = Object.values(SUGGESTED_KEYWORDS);
  for (const k of kws) assert.equal(keywordProblem(k, kws.filter((x) => x !== k)), '');
  assert.match(keywordProblem('helix', []), /random words/);
  assert.match(keywordProblem('otter', ['otter']), /already/);
  assert.match(keywordProblem('two words', []), /one word/);
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const p = makePassphrase('otter');
    const w = p.split('-');
    assert.equal(w.length, 4);
    assert.equal(w.filter((x) => x === 'otter').length, 1);
    assert.equal(new Set(w).size, 4);
    seen.add(w.indexOf('otter'));
  }
  assert.equal(seen.size, 4, 'the keyword lands in every position');
  const keywords = { navigate: 'otter', read: 'owl' };
  const a = makePassphrase('otter');
  const b = makePassphrase('owl');
  const parts = readSubmission(`${a.toUpperCase()}, ${b}`, keywords);
  assert.deepEqual(parts.map((x) => x.track), ['navigate', 'read']);
  assert.deepEqual(parts[0].fillers, a.split('-').filter((x) => x !== 'otter'));
  // Typed with spaces, two passphrases in a row still split at the keywords.
  const spaced = readSubmission('comet otter maple ribbon zinc owl helix fiber', keywords);
  assert.deepEqual(spaced.map((x) => [x.track, x.fillers.length]), [['navigate', 3], ['read', 3]]);
  assert.deepEqual(readSubmission('otter-foo-maple-ribbon', keywords)[0].odd, ['foo']);
});

test('tar, gzip and du', () => {
  const sh = shell();
  sh.run('tar -czf proj.tar.gz proj');
  assert.match(text(sh.run('tar -tzf proj.tar.gz')), /proj\/inputs\/a\.pdb/);
  sh.run('mkdir out');
  sh.run('tar -xzf proj.tar.gz -C out');
  assert.equal(sh.vfs.readFile('/home/student/out/proj/inputs/b.pdb'), 'ATOM 1\n');
  sh.run('gzip proj/run.sh');
  assert.ok(sh.vfs.get('/home/student/proj/run.sh.gz'));
  sh.run('gunzip proj/run.sh.gz');
  assert.ok(sh.vfs.get('/home/student/proj/run.sh'));
  assert.match(text(sh.run('du -sh proj')), /\tproj\n$/);
});

test('variables, for loops and $( )', () => {
  const sh = shell();
  assert.equal(text(sh.run('X=pdl1; echo "target $X"')), 'target pdl1\n');
  assert.equal(text(sh.run('for f in proj/inputs/*.pdb; do basename $f .pdb; done')), 'a\nb\n');
  assert.equal(text(sh.run('n=$(ls proj/inputs | wc -l); echo $n')), '2\n');
  sh.vfs.writeFile('/home/student/loop.sh', '#!/bin/bash\nfor f in "$@"\ndo\n  echo "got $f"\ndone\necho "$# args"\n', { mode: 0o755 });
  assert.equal(text(sh.run('./loop.sh a b')), 'got a\ngot b\n2 args\n');
  assert.match(errors(sh.run('for x in 1 2')), /needs `; do COMMANDS; done`/);
});

test('nano opens an editor and saving writes the file', () => {
  const sh = shell();
  const r = sh.run('nano notes.txt');
  assert.equal(r.edit.path, '/home/student/notes.txt');
  sh.saveEdit(r.edit.path, 'hello\n');
  assert.equal(sh.vfs.readFile('/home/student/notes.txt'), 'hello\n');
});

test('ProteinMPNN needs its environment and runs on a CPU', () => {
  const sh = shell();
  sh.vfs.writeFile('/home/student/proj/inputs/c.pdb', fromLibrary('pdb:chains A:30,B:20'));
  sh.run('cd proj');
  const mpnn = 'python /opt/ProteinMPNN/protein_mpnn_run.py --pdb_path inputs/c.pdb --out_folder out --num_seq_per_target 3 --pdb_path_chains B --seed 5';
  assert.match(errors(sh.run('protein_mpnn_run.py --pdb_path inputs/c.pdb --out_folder out')), /command not found/);
  assert.match(errors(sh.run(mpnn)), /python: command not found/);
  sh.run('module load anaconda');
  assert.match(errors(sh.run(mpnn)), /No module named 'torch'/);
  sh.run('conda activate proteinmpnn');
  assert.match(errors(sh.run('python protein_mpnn_run.py --pdb_path inputs/c.pdb --out_folder out')), /can't open file/);
  assert.equal(errors(sh.run(mpnn)), '');
  const fa = sh.vfs.readFile('/home/student/proj/out/seqs/c.fa');
  assert.match(fa, /fixed_chains=\['A'\], designed_chains=\['B'\]/);
  assert.match(fa, /sample=3, score=/);
  assert.match(errors(sh.run('python /opt/ProteinMPNN/protein_mpnn_run.py --pdb_path inputs/c.pdb --out_folder out --pdb_path_chains C')), /seq_chain_C/);
});

test('GPU tools need a GPU and enough memory from Slurm', () => {
  const sh = shell();
  sh.vfs.writeFile('/home/student/proj/a.fasta', '>binder\nMSEELLKKAEELIKRAKELGDPELVKRAL\n');
  sh.run('cd proj');
  sh.run('module load colabfold');
  assert.match(text(sh.run('colabfold_batch a.fasta out')), /no GPU detected/);
  sh.run('srun --gres=gpu:1 --mem=4G --pty bash');
  assert.match(errors(sh.run('colabfold_batch a.fasta out')), /Killed/); // 4 GB isn't enough
  sh.run('exit');
  sh.run('srun --gres=gpu:1 --pty bash'); // the default, 16 GB per GPU, is
  sh.run('colabfold_batch a.fasta out');
  assert.ok(sh.vfs.get('/home/student/proj/out/binder.done.txt'));
  assert.match(sh.vfs.readFile('/home/student/proj/out/log.txt'), /rank_001_alphafold2_ptm_model_\d_seed_000 pLDDT=/);
});

test('Geiss-01 has 190 GB, 174 GB of it for jobs, and 16 GB per GPU by default', () => {
  const sh = shell();
  sh.run('srun --gres=gpu:2 --pty bash');
  assert.equal(sh.cluster.interactive.memGB, 32);
  sh.run('exit');
  sh.run('srun --pty bash');
  assert.equal(sh.cluster.interactive.memGB, 4);
  sh.run('exit');
  assert.match(errors(sh.run('srun --gres=gpu:1 --mem=175G --pty bash')), /Requested node configuration is not available/);
  sh.run('srun --gres=gpu:1 --mem=174G --pty bash');
  assert.equal(sh.cluster.interactive.memGB, 174);
  sh.run('exit');
  assert.match(text(sh.run('sinfo -o "%m"')), /190000/);
});

test('chai-lab needs Chai-1 headers and an empty output folder', () => {
  const sh = shell();
  sh.vfs.writeFile('/home/student/proj/x.fasta', '>binder\nMSEELLKK\n');
  sh.run('cd proj');
  assert.match(errors(sh.run('chai-lab fold x.fasta out')), /command not found/);
  sh.run('module load anaconda');
  sh.run('conda activate chai');
  sh.run('srun --gres=gpu:1 --mem=32G --pty bash');
  assert.match(errors(sh.run('chai-lab fold x.fasta out')), /Could not parse FASTA header/);
  sh.vfs.writeFile('/home/student/proj/x.fasta', '>protein|name=binder\nMSEELLKK\n');
  sh.run('chai-lab fold x.fasta out');
  assert.ok(sh.vfs.get('/home/student/proj/out/pred.model_idx_4.cif'));
  assert.match(errors(sh.run('chai-lab fold x.fasta out')), /is not empty/);
});

test('GROMACS checks atom counts and charge like the real grompp', () => {
  const sh = shell();
  sh.vfs.writeFile('/home/student/proj/p.pdb', fromLibrary('pdb:1aki'));
  sh.vfs.writeFile('/home/student/proj/em.mdp', 'integrator = steep\nnsteps = 500\ncoulombtype = PME\n');
  sh.run('cd proj');
  sh.run('module load gromacs');
  sh.run('gmx pdb2gmx -f p.pdb -o p.gro -water spce -ff amber99sb-ildn');
  assert.match(sh.vfs.readFile('/home/student/proj/topol.top'), /qtot 8/);
  sh.run('gmx editconf -f p.gro -o box.gro -c -d 1.0 -bt cubic');
  sh.run('gmx solvate -cp box.gro -cs spc216.gro -o solv.gro');
  assert.match(errors(sh.run('gmx grompp -f em.mdp -c solv.gro -p topol.top -o em.tpr')), /does not match topology/);
  sh.run('gmx solvate -cp box.gro -cs spc216.gro -o solv.gro -p topol.top');
  assert.ok(sh.vfs.get('/home/student/proj/#solv.gro.1#'), 'GROMACS backs up files it overwrites');
  assert.match(errors(sh.run('gmx grompp -f em.mdp -c solv.gro -p topol.top -o em.tpr')), /Too many warnings/);
  // grompp refused, so make the tpr with -maxwarn just for genion
  sh.run('gmx grompp -f em.mdp -c solv.gro -p topol.top -o ions.tpr -maxwarn 1');
  assert.match(text(sh.run('gmx genion -s ions.tpr -o ions.gro -p topol.top -neutral')), /can't type answers/);
  sh.run('echo SOL | gmx genion -s ions.tpr -o ions.gro -p topol.top -pname NA -nname CL -neutral');
  assert.match(sh.vfs.readFile('/home/student/proj/topol.top'), /\nCL\s+8\n/);
  assert.equal(errors(sh.run('gmx grompp -f em.mdp -c ions.gro -p topol.top -o em.tpr')), '');
  sh.run('gmx mdrun -v -deffnm em');
  assert.match(text(sh.run('echo Potential | gmx energy -f em.edr')), /Potential\s+-\d+/);
});

test('live batch jobs run their script with what they asked for', () => {
  const sh = shell();
  sh.cluster.liveJobs = true;
  sh.vfs.writeFile('/home/student/proj/a.fasta', '>binder\nMSEELLKKAEELIKRAKELGDPELVKRAL\n');
  sh.vfs.writeFile('/home/student/proj/fold.sh', '#!/bin/bash\n#SBATCH --gres=gpu:1\n#SBATCH --mem=32G\nmodule load colabfold\ncolabfold_batch a.fasta out\necho "job $SLURM_JOB_ID done"\n');
  sh.run('cd proj');
  sh.run('sbatch fold.sh');
  sh.run('sbatch --mem=2G fold.sh');
  sh.run('sbatch --gres=gpu:0 --wrap="module load colabfold; colabfold_batch a.fasta out2"');
  for (let i = 0; i < 6; i++) sh.run('squeue --me');
  const [ok, oom, cpu] = sh.cluster.jobs.filter((j) => j.user === 'student');
  assert.equal(ok.state, 'CD');
  assert.match(sh.vfs.readFile(`/home/student/proj/slurm-${ok.id}.out`), new RegExp(`Done\\njob ${ok.id} done`));
  assert.ok(sh.vfs.get('/home/student/proj/out/binder.done.txt'));
  assert.equal(oom.state, 'OOM');
  assert.equal(cpu.state, 'F');
  assert.equal(cpu.name, 'wrap');
  assert.ok(!sh.events.some((e) => e.cmd === 'colabfold_batch'), 'job commands are not the student\'s');
  assert.equal(sh.cluster.modules.length, 0, 'the job\'s module load stays in the job');
});

test('Rosetta and AlphaFold come from modules', () => {
  const sh = shell();
  sh.run('cd proj');
  assert.match(errors(sh.run('relax.linuxgccrelease -s inputs/a.pdb')), /command not found/);
  sh.run('module load rosetta');
  sh.run('relax.linuxgccrelease -s inputs/a.pdb');
  assert.ok(sh.vfs.get('/home/student/proj/a_0001.pdb'));
});

test('scp copies between the laptop and Geiss-01', () => {
  const server = shell();
  const laptop = new Shell({ kind: 'laptop', host: 'laptop', home: '/Users/student' });
  laptop.vfs.mkdir('/Users/student/Downloads', { parents: true });
  laptop.remotes['geiss-01'] = server;
  laptop.run('scp student@geiss-01:~/proj/inputs/a.pdb ~/Downloads/');
  assert.ok(laptop.vfs.get('/Users/student/Downloads/a.pdb'));
  assert.match(errors(laptop.run('scp student@geiss-01:proj ~/Downloads/')), /not a regular file/);
  laptop.run('scp -r student@geiss-01:proj ~/Downloads/');
  assert.ok(laptop.vfs.get('/Users/student/Downloads/proj/inputs/b.pdb'));
  laptop.run('scp ~/Downloads/a.pdb geiss-01:copy.pdb');
  assert.ok(server.vfs.get('/home/student/copy.pdb'));
  assert.match(errors(laptop.run('scp bob@geiss-01:x .')), /Permission denied/);
  assert.match(errors(server.run('scp a.pdb laptop:')), /Connection refused/);
  assert.match(errors(laptop.run('sbatch run.sh')), /command not found/);
});

test('ps, htop and kill work on processes; scancel works on Slurm jobs', () => {
  const sh = new Shell();
  // Other people's jobs show up as processes owned by them.
  assert.match(text(sh.run('ps aux')), /kpatel .*python run_alphafold\.py/);
  // On screen, htop and top take over the terminal and redraw until q.
  assert.deepEqual(sh.run('htop -u student').live, { kind: 'htop', user: 'student', args: ['-u', 'student'] });
  assert.equal(sh.run('top').live.kind, 'top');
  // Piped, or top -b, they print one frame.
  assert.match(text(sh.run('htop | cat')), /PID USER .*CPU% MEM%/);
  assert.match(text(sh.run('top -b -n 1 -u student')), /student .* bash/);
  // A background job: listed by ps and jobs, stopped by kill %1.
  const pid = text(sh.run('sleep 600 &')).match(/\[1\] (\d+)/)[1];
  assert.match(text(sh.run('ps')), new RegExp(`${pid} pts/0 .* sleep`));
  assert.match(text(sh.run('pgrep sleep')), new RegExp(pid));
  assert.match(text(sh.run('kill %1')), /Terminated\s+sleep 600/);
  assert.match(text(sh.run('jobs')), /Terminated/);
  assert.doesNotMatch(text(sh.run('ps')), /sleep/);
  assert.match(errors(sh.run(`kill ${pid}`)), /No such process/);
  // Not your process, or not a process at all.
  assert.match(errors(sh.run('kill 1121')), /Operation not permitted/);
  const r = sh.run('kill 48213');
  assert.match(errors(r), /No such process/);
  assert.ok(r.coach.some((c) => /scancel 48213/.test(c.text)));
  assert.ok(sh.run('scancel 30412').coach.some((c) => /kill 30412/.test(c.text)));
  assert.match(errors(sh.run('kill -FOO 1')), /invalid signal/);
  assert.match(text(sh.run('kill -l')), /SIGKILL/);
});

test('a process that ignores TERM needs kill -9; killing a batch job fails it', async () => {
  const { Cluster } = await import('../engine/cluster.js');
  const cluster = new Cluster({ processes: [{ pid: 32203, command: 'python train_loop.py', cpu: 100, ignoresTerm: true }], gpusBusy: 0 });
  const sh = new Shell({ cluster });
  assert.doesNotMatch(text(sh.run('ps')), /train_loop/, 'plain ps only shows this terminal');
  assert.match(text(sh.run('ps -u student')), /32203/);
  sh.run('kill 32203');
  assert.match(text(sh.run('ps ux')), /train_loop/);
  sh.run('kill -9 32203');
  assert.doesNotMatch(text(sh.run('ps ux')), /train_loop/);

  sh.vfs.writeFile('/home/student/long.sh', '#!/bin/bash\n#SBATCH --gres=gpu:1\n#SBATCH --job-name=long\nsleep 9999\n');
  sh.run('sbatch long.sh');
  const job = cluster.jobs.find((j) => j.name === 'long');
  job.runSteps = 1000;
  for (let i = 0; i < 3; i++) sh.run('true');
  assert.equal(job.state, 'R');
  const line = text(sh.run('ps ux')).split('\n').find((l) => l.includes('slurm_script'));
  const r = sh.run(`kill ${line.split(/\s+/)[1]}`);
  assert.equal(job.state, 'F');
  assert.ok(r.coach.some((c) => /scancel/.test(c.text)));
});

test('the live htop redraws, and killing from it removes the process', async () => {
  const { Session } = await import('../engine/scenario.js');
  const { htopFrame, topFrame } = await import('../engine/commands/procs.js');
  const def = JSON.parse((await import('node:fs')).readFileSync(new URL('../scenarios/slurm/04b-stubborn.json', import.meta.url)));
  const s = new Session(def, { seed: 11 });
  const pid = Number(s.vars.pid);
  const rows = (f) => f.segments.map((x) => x.text).join('');
  const one = htopFrame(s.shell, { frame: 0, selected: pid });
  const two = htopFrame(s.shell, { frame: 1, selected: pid });
  assert.notEqual(rows(one), rows(two), 'later frames move on');
  assert.ok(one.segments.some((x) => x.cls === 'sel' && x.text.includes('train_loop')));
  assert.ok(one.pids.includes(pid));
  assert.equal(s.signal(pid, 15).result, 'ok');
  assert.ok(htopFrame(s.shell).pids.includes(pid), 'it ignores TERM');
  assert.equal(s.signal(29_999, 9).result, 'ESRCH');
  assert.equal(s.signal(1121, 9).result, 'EPERM');
  s.submitAnswer(String(pid));
  const r = s.signal(pid, 9);
  assert.ok(r.complete);
  assert.ok(!htopFrame(s.shell).pids.includes(pid));
  assert.ok(!topFrame(s.shell).pids.includes(pid));
});

test('a background command that fails at once is not left running', () => {
  const sh = new Shell();
  sh.run('python3 missing.py &');
  assert.doesNotMatch(text(sh.run('ps')), /python3/);
});

test('a looping python script started with & runs until killed', () => {
  const sh = new Shell();
  sh.vfs.writeFile('/home/student/spin.py', 'n = 0\nwhile True:\n    n += 1\n');
  assert.match(text(sh.run('python3 spin.py')), /loops forever/);
  const pid = text(sh.run('python3 spin.py &')).match(/\[1\] (\d+)/)[1];
  for (let i = 0; i < 20; i++) sh.run('true');
  assert.match(text(sh.run('htop | cat')), /python3 spin\.py/);
  sh.run(`kill ${pid}`);
  assert.doesNotMatch(text(sh.run('htop | cat')), /spin\.py/);
});

test('python scripts: arguments, imports, tracebacks and ./script.py', () => {
  const sh = new Shell();
  sh.vfs.writeFile('/home/student/hi.py', 'import sys\nprint("hi")\nprint(sys.argv[1])\n');
  assert.equal(text(sh.run('python3 hi.py there')), 'hi\nthere\n');
  assert.match(errors(sh.run('python3 hi.py')), /IndexError: list index out of range/);
  assert.equal(text(sh.run('python3 -c "print(6*7)"')), '42\n');
  sh.vfs.writeFile('/home/student/gc.py', '#!/usr/bin/env python3\nimport sys\nfrom Bio import SeqIO\n');
  sh.cluster.pythonRules = [{ match: 'gc.py', args: 1, usage: 'usage: gc.py FASTA', inputs: [1], out: 'read $1\n' }];
  assert.match(errors(sh.run('python3 gc.py a.fa')), /line 3, in <module>\n    from Bio import SeqIO\nModuleNotFoundError: No module named 'Bio'/);
  assert.match(errors(sh.run('./gc.py')), /Permission denied/);
  sh.run('chmod +x gc.py');
  sh.run('module load anaconda');
  assert.match(errors(sh.run('./gc.py')), /required: FASTA/);
  assert.match(errors(sh.run('./gc.py a.fa')), /FileNotFoundError: \[Errno 2\] No such file or directory: 'a.fa'/);
  sh.run('touch a.fa');
  assert.equal(text(sh.run('./gc.py a.fa')), 'read a.fa\n');
  sh.run('conda activate proteinmpnn');
  assert.match(errors(sh.run('python gc.py a.fa')), /No module named 'Bio'/);
});
