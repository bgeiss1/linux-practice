// colabfold_batch (ColabFold 1.5.5, from `module load colabfold`).
// colabfold_batch [options] INPUT RESULTS: INPUT is a FASTA file (one query per
// record, named by its header) or a folder of .fasta/.a3m files (one query per
// file, named by the file). A ":" in a sequence joins chains into a complex.

import { joinPath } from '../vfs.js';
import { proteinPdb } from '../library.js';
import { stem, pick, readArgs, needInput, readText, write, useResources, hasGpu, stamp, parseFasta } from './common.js';

const FLAGS = ['amber', 'templates', 'use-gpu-relax', 'overwrite-existing-results', 'zip', 'help', 'save-all', 'save-recycles', 'disable-unified-memory'];

export const HELP = `usage: colabfold_batch [-h] [--msa-mode {mmseqs2_uniref_env,mmseqs2_uniref,single_sequence}]
                       [--num-models {1,2,3,4,5}] [--num-recycle NUM_RECYCLE]
                       [--num-seeds NUM_SEEDS] [--random-seed RANDOM_SEED]
                       [--model-type {auto,alphafold2,alphafold2_ptm,alphafold2_multimer_v1,alphafold2_multimer_v2,alphafold2_multimer_v3}]
                       [--rank {auto,plddt,ptm,iptm,multimer}] [--templates]
                       [--amber] [--num-relax NUM_RELAX] [--use-gpu-relax]
                       [--overwrite-existing-results] [--zip]
                       input results

positional arguments:
  input                 Can be one of the following: Directory with fasta/a3m
                        files, a csv/tsv file, a fasta file or an a3m file
  results               Directory to write the results to

options:
  -h, --help            show this help message and exit
  --msa-mode            Query a server for the MSA (default), or skip it with
                        single_sequence
  --num-models          Number of models to use for structure prediction.
                        Reducing the number of models speeds up the
                        prediction but results in lower quality. (default: 5)
  --num-recycle         Number of prediction recycles. Increasing recycles
                        can improve the quality but slows down the
                        prediction. (default: 3, or 20 for multimers)
  --num-seeds           Number of seeds to try. Will iterate from range(random_seed,
                        random_seed+num_seeds). (default: 1)
  --rank                rank models by auto, plddt or ptmscore (default: auto)
  --templates           Use templates from pdb
  --amber               Use amber for structure refinement. To control number
                        of top ranked structures are relaxed set --num-relax.
  --num-relax           specify how many of the top ranked structures to relax
                        using amber.
  --use-gpu-relax       run amber on GPU instead of CPU
  --overwrite-existing-results
                        Redo predictions that already have a .done.txt file
`;

// Every query from the input: [{ job, seq }].
export function queriesFrom(ctx, abs) {
  const node = ctx.sh.vfs.get(abs);
  if (node.type === 'dir') {
    return Object.keys(node.children).sort()
      .filter((n) => /\.(fasta|fa|faa|a3m)$/.test(n))
      .map((n) => ({ job: stem(n), seq: parseFasta(readText(ctx, joinPath(abs, n)))[0]?.seq ?? '' }))
      .filter((q) => q.seq);
  }
  return parseFasta(node.content).map((r) => ({ job: r.header.replace(/[^\w.-]+/g, '_'), seq: r.seq }));
}

// Seconds for one recycle of one model on a GPU: grows with the square of the length.
const perRecycle = (seq) => 1.5 + 0.4 * (seq.replace(/:/g, '').length / 100) ** 2;

// The scores ColabFold reports for one query, best first. Scenarios use this to
// know ahead of time which model ranks first and what its pLDDT is.
export function scoreQuery(job, seq, { numModels = 5, numRecycle = null, multimer = seq.includes(':') } = {}) {
  const recycles = numRecycle ?? (multimer ? 20 : 3);
  const base = pick(job + seq, 64, 91);
  const models = [];
  for (let m = 1; m <= numModels; m++) {
    const plddt = Math.min(96.4, Number((base + pick(`${job}:${m}`, -7, 3) + Math.min(recycles - 3, 6) * 0.3).toFixed(1)));
    const ptm = Number(((plddt / 100) * pick(`${job}:ptm${m}`, 0.78, 0.92, 2)).toFixed(3));
    const iptm = multimer ? Number(((plddt / 100) * pick(`${job}:iptm${m}`, 0.6, 0.95, 2)).toFixed(3)) : null;
    models.push({ model: m, plddt, ptm, iptm, score: multimer ? 0.8 * iptm + 0.2 * ptm : plddt });
  }
  return models.sort((a, b) => b.score - a.score).map((m, i) => ({ ...m, rank: i + 1 }));
}

export function colabfold(ctx) {
  const { opts, rest } = readArgs(ctx.args, { flags: FLAGS });
  if (opts.help || ctx.args.includes('-h')) {
    ctx.out(HELP);
    return 0;
  }
  if (rest.length < 2) {
    ctx.err(`usage: colabfold_batch [-h] [--msa-mode ...] [--num-models {1,2,3,4,5}] ... input results\ncolabfold_batch: error: the following arguments are required: ${rest.length ? 'results' : 'input, results'}\n`);
    ctx.coach('colabfold-args', 'Give it the input and a folder for results: `colabfold_batch input.fasta results/`.');
    return 2;
  }
  const input = needInput(ctx, rest[0], 'input');
  if (!input) return 1;
  const numModels = Number(opts['num-models'] ?? 5);
  if (!(numModels >= 1 && numModels <= 5)) {
    ctx.err(`colabfold_batch: error: argument --num-models: invalid choice: ${opts['num-models']} (choose from 1, 2, 3, 4, 5)\n`);
    return 2;
  }
  const out = ctx.sh.resolve(rest[1]);
  let clock = 0;
  const log = [];
  const say = (line, seconds = 0.4) => {
    clock += seconds;
    log.push(`${stamp(ctx, clock)} ${line}`);
    ctx.out(`${stamp(ctx, clock)} ${line}\n`);
  };
  say('Running colabfold 1.5.5');
  if (!hasGpu(ctx)) {
    say('WARNING: no GPU detected, will be using CPU');
    ctx.out('(practice site: on a CPU this would take many hours, so the run stops here. Get a GPU from Slurm and run it again.)\n', 'dim');
    ctx.coach('tool-gpu', ctx.sh.cluster.interactive?.batch
      ? 'Add `#SBATCH --gres=gpu:1` to the job script so the job gets a GPU.'
      : 'ColabFold needs a GPU from Slurm: `srun --gres=gpu:1 --mem=32G --pty bash`, then run it there.');
    return 1;
  }
  const queries = queriesFrom(ctx, input);
  if (!queries.length) {
    say(`No sequences found in ${rest[0]}. Input files must be FASTA (.fasta, .fa) or .a3m.`);
    return 1;
  }
  const longest = Math.max(...queries.map((q) => q.seq.replace(/:/g, '').length));
  const anyMultimer = queries.some((q) => q.seq.includes(':'));
  const numRecycle = opts['num-recycle'] !== undefined ? Number(opts['num-recycle']) : null;
  const memGB = 6 + longest / (anyMultimer ? 25 : 40);
  const minutes = queries.reduce((n, q) => n + 1 + (numModels * ((numRecycle ?? (q.seq.includes(':') ? 20 : 3)) + 1) * perRecycle(q.seq)) / 60, 0);
  if (!useResources(ctx, { memGB, minutes })) return 137;

  const relaxCount = opts.amber ? Number(opts['num-relax'] ?? numModels) : Number(opts['num-relax'] ?? 0);
  say(`Found 5 citations for tools or databases`);
  const config = { num_queries: queries.length, msa_mode: opts['msa-mode'] ?? 'mmseqs2_uniref_env', model_type: opts['model-type'] ?? 'auto', num_models: numModels, num_recycles: numRecycle, num_relax: relaxCount, use_templates: !!opts.templates, version: '1.5.5' };
  write(ctx, joinPath(out, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  write(ctx, joinPath(out, 'cite.bibtex'), '@article{Mirdita2022,\n  title = {ColabFold: making protein folding accessible to all},\n  journal = {Nature Methods},\n  year = {2022},\n}\n');
  queries.forEach((q, qi) => {
    const multimer = opts['model-type'] ? String(opts['model-type']).includes('multimer') : q.seq.includes(':');
    const type = multimer ? 'alphafold2_multimer_v3' : 'alphafold2_ptm';
    const chains = q.seq.split(':');
    const length = chains.map((c) => c.length).join(' + ');
    if (ctx.sh.vfs.get(joinPath(out, `${q.job}.done.txt`)) && !opts['overwrite-existing-results']) {
      say(`Skipping ${q.job} (already done)`);
      return;
    }
    say(`Query ${qi + 1}/${queries.length}: ${q.job} (length ${length})`, 1);
    clock += 40; // the first query loads the model weights
    if (config.msa_mode !== 'single_sequence') say('Running MMseqs2 search on the ColabFold server (api.colabfold.com)', 2);
    if (opts.templates) say('Searching templates from the PDB');
    const models = scoreQuery(q.job, q.seq, { numModels, numRecycle, multimer });
    const recycles = numRecycle ?? (multimer ? 20 : 3);
    for (const m of [...models].sort((a, b) => a.model - b.model)) {
      const took = perRecycle(q.seq) * (recycles + 1);
      say(`${type}_model_${m.model}_seed_000 took ${took.toFixed(1)}s (${recycles} recycles)`, took);
    }
    say(`reranking models by '${multimer ? 'multimer' : 'plddt'}' metric`);
    const pdb = proteinPdb({ title: `COLABFOLD PREDICTION ${q.job.toUpperCase()}`, chains: chains.map((seq, i) => ({ id: String.fromCharCode(65 + i), seq })) });
    for (const m of models) {
      const name = `rank_00${m.rank}_${type}_model_${m.model}_seed_000`;
      say(`${name} pLDDT=${m.plddt} pTM=${m.ptm}${multimer ? ` ipTM=${m.iptm}` : ''}`);
      write(ctx, joinPath(out, `${q.job}_unrelaxed_${name}.pdb`), pdb);
      write(ctx, joinPath(out, `${q.job}_scores_${name}.json`), JSON.stringify({ max_pae: 31.75, ptm: m.ptm, ...(multimer ? { iptm: m.iptm } : {}), plddt: `[${m.plddt}, ...]` }) + '\n');
      if (m.rank <= relaxCount) {
        write(ctx, joinPath(out, `${q.job}_relaxed_${name}.pdb`), pdb);
      }
    }
    if (relaxCount) say(`Relaxed ${Math.min(relaxCount, numModels)} structure${relaxCount === 1 ? '' : 's'} with amber (${opts['use-gpu-relax'] ? 'GPU' : 'CPU'})`);
    write(ctx, joinPath(out, `${q.job}.a3m`), `#${q.seq.length}\t1\n>101\n${q.seq.replace(/:/g, '')}\n`);
    for (const plot of ['coverage', 'pae', 'plddt']) write(ctx, joinPath(out, `${q.job}_${plot}.png`), null, { binary: 'image', size: 48213 + q.seq.length * 31 });
    write(ctx, joinPath(out, `${q.job}_predicted_aligned_error_v1.json`), '[{"predicted_aligned_error": [[0.25, 1.1, ...]], "max_predicted_aligned_error": 31.75}]\n');
    write(ctx, joinPath(out, `${q.job}.done.txt`), '');
  });
  say('Done');
  write(ctx, joinPath(out, 'log.txt'), log.join('\n') + '\n');
  return 0;
}
