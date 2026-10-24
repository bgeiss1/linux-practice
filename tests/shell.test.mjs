import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Shell } from '../engine/shell.js';
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
