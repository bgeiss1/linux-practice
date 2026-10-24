// Realistic file contents scenarios can reuse with { "lib": "name" }.
// Keep these short: students should be able to read them in the terminal.

const ATOMS = [
  ['N', 'MET', 1, 27.34, 24.43, 2.614],
  ['CA', 'MET', 1, 26.266, 25.413, 2.842],
  ['C', 'MET', 1, 26.913, 26.639, 3.531],
  ['O', 'MET', 1, 27.886, 26.463, 4.263],
  ['N', 'LYS', 2, 26.335, 27.77, 3.258],
  ['CA', 'LYS', 2, 26.85, 29.021, 3.898],
  ['C', 'LYS', 2, 26.1, 29.253, 5.202],
  ['O', 'LYS', 2, 24.865, 29.024, 5.33],
  ['N', 'GLU', 3, 26.849, 29.656, 6.217],
  ['CA', 'GLU', 3, 26.235, 30.058, 7.497],
];

function pdbLines(chain = 'A', offset = 0) {
  return ATOMS.map(([atom, res, num, x, y, z], i) => {
    const serial = String(i + 1 + offset).padStart(5);
    const name = (atom.length < 4 ? ' ' + atom : atom).padEnd(4);
    const coords = [x, y + offset, z].map((v) => v.toFixed(3).padStart(8)).join('');
    return `ATOM  ${serial} ${name} ${res} ${chain}${String(num).padStart(4)}    ${coords}  1.00 10.00           ${atom[0]}`;
  });
}

export const LIBRARY = {
  'pdb:small': () =>
    [
      'HEADER    DE NOVO PROTEIN                         24-OCT-26   XXXX',
      'TITLE     DESIGN TARGET (TEACHING EXAMPLE)',
      'REMARK   2 RESOLUTION. 2.10 ANGSTROMS.',
      ...pdbLines('A'),
      'TER',
      'END',
    ].join('\n') + '\n',

  'pdb:complex': () =>
    [
      'HEADER    PROTEIN BINDING                         24-OCT-26   XXXX',
      'TITLE     TARGET (CHAIN A) WITH DESIGNED BINDER (CHAIN B)',
      ...pdbLines('A'),
      'TER',
      ...pdbLines('B', 10),
      'TER',
      'END',
    ].join('\n') + '\n',

  'fasta:designs': () =>
    [
      '>design_001 score=-1.42',
      'MSEELLKKAEELIKRAKELGDPELVKRAL',
      '>design_002 score=-1.18',
      'MSKEELIRKAAELAKKLLEGNPELAKEAL',
      '>design_003 score=-1.67',
      'MTEEALRLAEEALRLAKEGDLEKVKEIL',
    ].join('\n') + '\n',

  'text:readme': () =>
    [
      'Welcome to Geiss-01.',
      '',
      'This is a practice copy of the MIP662 server. Nothing here is real,',
      'so experiment freely. If you get lost, the Reset button puts every',
      'file back the way it started.',
    ].join('\n') + '\n',

  'slurm:mpnn': () =>
    [
      '#!/bin/bash',
      '#SBATCH --job-name=mpnn',
      '#SBATCH --partition=gpu',
      '#SBATCH --gres=gpu:1',
      '#SBATCH --time=00:30:00',
      '#SBATCH --mem=16G',
      '#SBATCH --output=slurm-%j.out',
      '',
      'module load anaconda',
      'conda activate proteinmpnn',
      '',
      'python protein_mpnn_run.py \\',
      '  --pdb_path inputs/target.pdb \\',
      '  --out_folder outputs/ \\',
      '  --num_seq_per_target 8',
    ].join('\n') + '\n',

  'log:finished': () =>
    [
      'Job started on geiss-01',
      'Loading model weights',
      'Designing 8 sequences',
      'Wrote outputs/seqs/target.fa',
      'Job finished in 41.2 s',
    ].join('\n') + '\n',
};

export function fromLibrary(name) {
  const make = LIBRARY[name];
  if (!make) throw new Error(`Unknown library file "${name}"`);
  return make();
}
