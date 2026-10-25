import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Shell } from '../engine/shell.js';
import { fromLibrary } from '../engine/library.js';
import { parse } from '../engine/parser.js';
import { WORDS, wordsFor, passphrase, verify } from '../engine/passphrase.js';

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

test('passphrase words are stable, distinct, and verifiable', () => {
  const tracks = ['session', 'navigate', 'find', 'read', 'manage', 'bash', 'slurm', 'transfer'];
  assert.ok(WORDS.length >= 200);
  const a = wordsFor('ABC123', tracks, 'salt');
  assert.deepEqual(a, wordsFor(' abc123 ', tracks, 'salt'));
  assert.equal(new Set(Object.values(a)).size, tracks.length);
  assert.notDeepEqual(a, wordsFor('xyz789', tracks, 'salt'));
  const phrase = passphrase('abc123', tracks, 'salt', ['navigate', 'read']);
  assert.equal(phrase, `${a.navigate}-${a.read}`);
  assert.deepEqual(verify('abc123', tracks, 'salt', phrase.toUpperCase().replace('-', ' ')).tracks, ['navigate', 'read']);
  assert.deepEqual(verify('xyz789', tracks, 'salt', phrase).tracks.length < 2, true);
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
  sh.run('srun --gres=gpu:1 --pty bash');
  assert.match(errors(sh.run('colabfold_batch a.fasta out')), /Killed/); // the default 4 GB isn't enough
  sh.run('exit');
  sh.run('srun --gres=gpu:1 --mem=32G --pty bash');
  sh.run('colabfold_batch a.fasta out');
  assert.ok(sh.vfs.get('/home/student/proj/out/binder.done.txt'));
  assert.match(sh.vfs.readFile('/home/student/proj/out/log.txt'), /rank_001_alphafold2_ptm_model_\d_seed_000 pLDDT=/);
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
