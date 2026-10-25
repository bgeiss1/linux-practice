// chai-lab (Chai-1, from `conda activate chai`).
// chai-lab fold [OPTIONS] FASTA_FILE OUTPUT_DIR. Every FASTA header names an
// entity type and a name, like >protein|name=binder or >ligand|name=ATP, and a
// ligand's "sequence" is its SMILES string.

import { joinPath } from '../vfs.js';
import { readArgs, needInput, write, useResources, hasGpu, noGpu } from './common.js';

const FLAGS = ['help', 'use-msa-server', 'no-use-msa-server', 'use-templates-server', 'no-use-templates-server', 'use-esm-embeddings', 'no-use-esm-embeddings', 'low-memory', 'no-low-memory'];
const TYPES = ['protein', 'ligand', 'dna', 'rna', 'glycan'];

export const MAIN_HELP = `
 Usage: chai-lab [OPTIONS] COMMAND [ARGS]...

╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --help          Show this message and exit.                                  │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Commands ───────────────────────────────────────────────────────────────────╮
│ fold         Run Chai-1 to fold a complex.                                   │
│ a3m-to-pqt   Convert all a3m files in a directory for a *single sequence*   │
│              into a aligned parquet file.                                    │
│ citation     Print citation information                                      │
╰──────────────────────────────────────────────────────────────────────────────╯

`;

export const FOLD_HELP = `
 Usage: chai-lab fold [OPTIONS] FASTA_FILE OUTPUT_DIR

 Run Chai-1 to fold a complex.

╭─ Arguments ──────────────────────────────────────────────────────────────────╮
│ *    fasta_file      PATH  [required]                                        │
│ *    output_dir      PATH  [required]                                        │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --use-esm-embeddings    --no-use-esm-embeddings      [default: use-esm-emb…] │
│ --use-msa-server        --no-use-msa-server          [default:               │
│                                                      no-use-msa-server]      │
│ --msa-server-url                               TEXT     [default:            │
│                                                         https://api.colabfo… │
│ --msa-directory                                PATH     [default: None]      │
│ --constraint-path                              PATH     [default: None]      │
│ --use-templates-server  --no-use-templates-server    [default:               │
│                                                      no-use-templates-serv…] │
│ --num-trunk-recycles                           INTEGER  [default: 3]         │
│ --num-diffn-timesteps                          INTEGER  [default: 200]       │
│ --num-diffn-samples                            INTEGER  [default: 5]         │
│ --seed                                         INTEGER  [default: None]      │
│ --device                                       TEXT     [default: None]      │
│ --low-memory            --no-low-memory              [default: low-memory]   │
│ --help                                                  Show this message    │
│                                                         and exit.            │
╰──────────────────────────────────────────────────────────────────────────────╯

`;

function usageError(ctx, message) {
  ctx.err(`Usage: chai-lab fold [OPTIONS] FASTA_FILE OUTPUT_DIR\nTry 'chai-lab fold --help' for help.\n╭─ Error ─────────────────────────────────────────────╮\n│ ${message.padEnd(52)}│\n╰─────────────────────────────────────────────────────╯\n`);
  return 2;
}

// Chai-1 FASTA: [{ type, name, seq }], or a string saying what's wrong.
export function parseChaiFasta(text) {
  const entities = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      const header = line.slice(1);
      const [type, ...rest] = header.split('|');
      const name = rest.join('|').match(/^name=(\S+)$/)?.[1];
      if (!TYPES.includes(type.toLowerCase()) || !name) {
        return `ValueError: Could not parse FASTA header '>${header}'. Headers must look like '>protein|name=NAME', where the first part is one of: ${TYPES.join(', ')}`;
      }
      entities.push({ type: type.toLowerCase(), name, seq: '' });
    } else if (entities.length) {
      entities.at(-1).seq += line;
    } else {
      return 'ValueError: FASTA file must start with a header line beginning with ">"';
    }
  }
  if (!entities.length) return 'ValueError: No sequences found in FASTA file';
  for (const e of entities) {
    if (e.type === 'protein' && !/^[ACDEFGHIKLMNPQRSTVWYX]+$/.test(e.seq)) return `ValueError: Protein '${e.name}' has letters that aren't amino acids: ${e.seq.slice(0, 30)}`;
  }
  return entities;
}

const tokensOf = (entities) => entities.reduce((n, e) => n + (e.type === 'ligand' ? (e.seq.match(/[A-Z]/gi) ?? []).length : e.seq.length), 0);

export function chaiLab(ctx) {
  const [sub, ...args] = ctx.args;
  if (!sub || sub === '--help') {
    ctx.out(MAIN_HELP);
    return sub ? 0 : 2;
  }
  if (sub === 'citation') {
    ctx.out('Chai Discovery team. Chai-1: Decoding the molecular interactions of life. bioRxiv (2024). doi:10.1101/2024.10.10.615955\n');
    return 0;
  }
  if (sub !== 'fold') {
    ctx.err(`Usage: chai-lab [OPTIONS] COMMAND [ARGS]...\nTry 'chai-lab --help' for help.\n\nError: No such command '${sub}'.\n`);
    return 2;
  }
  const { opts, rest } = readArgs(args, { flags: FLAGS });
  if (opts.help) {
    ctx.out(FOLD_HELP);
    return 0;
  }
  const known = ['msa-server-url', 'msa-directory', 'constraint-path', 'num-trunk-recycles', 'num-diffn-timesteps', 'num-diffn-samples', 'seed', 'device', 'template-hits-path', 'recycle-msa-subsample', 'num-trunk-samples', ...FLAGS];
  const unknown = Object.keys(opts).find((k) => !known.includes(k));
  if (unknown) return usageError(ctx, `No such option: --${unknown}`);
  if (!rest[0]) return usageError(ctx, "Missing argument 'FASTA_FILE'.");
  if (!rest[1]) return usageError(ctx, "Missing argument 'OUTPUT_DIR'.");
  const fasta = needInput(ctx, rest[0], 'FASTA_FILE');
  if (!fasta) return 1;
  const outDir = ctx.sh.resolve(rest[1]);
  const existing = ctx.sh.vfs.get(outDir);
  if (existing?.type === 'dir' && Object.keys(existing.children).length) {
    ctx.err(`Traceback (most recent call last):\n  File "/opt/conda/envs/chai/lib/python3.11/site-packages/chai_lab/chai1.py", line 641, in run_inference\n    assert not any(output_dir.iterdir()), f"Output directory {output_dir} is not empty."\nAssertionError: Output directory ${rest[1].replace(/\/$/, '')} is not empty.\n`);
    ctx.coach('chai-empty', 'Chai-1 refuses to write into a folder that already has files, so old results never get mixed with new ones. Pick a new folder name.');
    return 1;
  }
  const entities = parseChaiFasta(ctx.sh.vfs.get(fasta).content);
  if (typeof entities === 'string') {
    ctx.err(`Traceback (most recent call last):\n  File "/opt/conda/envs/chai/lib/python3.11/site-packages/chai_lab/data/parsing/fasta.py", line 48, in read_fasta\n${entities}\n`);
    ctx.coach('chai-header', 'Every Chai-1 header says what the molecule is and names it, like `>protein|name=binder`.');
    return 1;
  }
  if (opts.device === 'cpu') {
    ctx.out('(practice site: Chai-1 on a CPU would take many hours, so the run stops here. Leave out --device and run it on a GPU.)\n', 'dim');
    return 1;
  }
  if (!hasGpu(ctx)) return noGpu(ctx);
  const samples = Number(opts['num-diffn-samples'] ?? 5);
  const recycles = Number(opts['num-trunk-recycles'] ?? 3);
  const steps = Number(opts['num-diffn-timesteps'] ?? 200);
  const tokens = tokensOf(entities);
  const memGB = 8 + tokens / 50;
  const minutes = 2 + (tokens / 100) * (recycles * 0.5 + (samples * steps) / 400);
  if (!useResources(ctx, { memGB, minutes })) return 137;

  const msa = opts['use-msa-server'] && !opts['no-use-msa-server'];
  ctx.out(`Loading Chai-1 model weights (cached in /opt/chai-lab/downloads)\n`);
  ctx.out(entities.map((e) => `Entity ${e.name}: ${e.type}, ${e.type === 'ligand' ? `SMILES ${e.seq}` : `length ${e.seq.length}`}\n`).join(''));
  const proteins = entities.filter((e) => e.type === 'protein');
  if (msa) {
    ctx.out(`Generating MSAs for ${proteins.length} protein chain${proteins.length === 1 ? '' : 's'} with ${opts['msa-server-url'] ?? 'https://api.colabfold.com'}\n`);
    for (const p of proteins) write(ctx, joinPath(outDir, 'msas', `${p.name}.aligned.pqt`), null, { binary: 'parquet', size: 81234 + p.seq.length * 410 });
  } else if (!opts['msa-directory']) {
    ctx.out('Running in single sequence mode. This may lead to lower quality predictions. Use --use-msa-server for better results.\n');
  }
  ctx.out(`Running trunk: ${recycles} recycles\nRunning diffusion: ${samples} samples x ${steps} steps${opts.seed !== undefined ? `, seed ${opts.seed}` : ''}\n`);
  for (let i = 0; i < samples; i++) {
    write(ctx, joinPath(outDir, `pred.model_idx_${i}.cif`), `data_pred.model_idx_${i}\n#\n_entry.id pred.model_idx_${i}\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\n_atom_site.type_symbol\n_atom_site.label_atom_id\n_atom_site.label_comp_id\n_atom_site.label_asym_id\n_atom_site.label_seq_id\n_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\nATOM 1 N N MET A 1 1.404 -0.767 -0.600\nATOM 2 C CA MET A 1 2.300 0.000 0.000\n#\n`);
    write(ctx, joinPath(outDir, `scores.model_idx_${i}.npz`), null, { binary: 'npz', size: 2210 + tokens * 8 });
  }
  ctx.out(`Wrote ${samples} structure${samples === 1 ? '' : 's'} to ${rest[1]}\n`);
  return 0;
}
