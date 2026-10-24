// Stand-ins for the design tools. They only exist once their module or conda
// environment is loaded, need a GPU from Slurm when the real tool would, and
// write small placeholder outputs so later steps have something to find.

import { MODULES, CONDA_ENVS } from '../cluster.js';
import { basename, dirname, joinPath } from '../vfs.js';
import { missingTip } from './util.js';
import { LIBRARY } from '../library.js';

const stem = (p) => basename(p).replace(/\.[^.]+$/, '');

// Options like --pdb_path X, --pdb_path=X and Hydra-style key=value.
function readArgs(args) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      opts[k] = v ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    } else if (/^[\w.]+=/.test(a)) {
      const [k, v] = a.split(/=(.*)/s);
      opts[k] = v;
    } else rest.push(a);
  }
  return { opts, rest };
}

function needInput(ctx, path, label) {
  if (!path) {
    ctx.err(`${ctx.name}: error: ${label} is required\n`);
    return null;
  }
  const abs = ctx.sh.resolve(path);
  if (!ctx.sh.vfs.get(abs)) {
    ctx.err(`FileNotFoundError: [Errno 2] No such file or directory: '${path}'\n`);
    missingTip(ctx, path);
    return null;
  }
  return abs;
}

function write(ctx, path, content) {
  const { sh } = ctx;
  sh.vfs.mkdir(dirname(path), { parents: true, mtime: sh.cluster.clock() });
  sh.vfs.writeFile(path, content, { mtime: sh.cluster.clock() });
}

const TOOLS = {
  protein_mpnn_run: {
    gpu: true,
    run(ctx, { opts }) {
      const pdb = needInput(ctx, opts.pdb_path, '--pdb_path');
      if (!pdb) return 1;
      if (!opts.out_folder) { ctx.err('protein_mpnn_run.py: error: --out_folder is required\n'); return 1; }
      const n = Number(opts.num_seq_per_target ?? 4);
      const out = ctx.sh.resolve(joinPath(opts.out_folder, 'seqs', stem(pdb) + '.fa'));
      const seqs = Array.from({ length: n }, (_, k) => `>T=${opts.sampling_temp ?? 0.1}, sample=${k + 1}, score=${(0.9 + k * 0.03).toFixed(4)}\nMSEELLKKAEELIKRAKELGDPELVKRAL\n`);
      write(ctx, out, `>${stem(pdb)}, score=1.6214, designed_chains=['B']\nMKVLAEELLKRAGG\n` + seqs.join(''));
      ctx.out(`Designing protein from this path: ${opts.pdb_path}\nGenerating sequences for: ${stem(pdb)}\n${n} sequences of length 29 generated in 1.4 seconds\n`);
      return 0;
    },
  },
  run_inference: {
    gpu: true,
    run(ctx, { opts }) {
      const prefix = opts['inference.output_prefix'];
      if (!prefix) {
        ctx.err('Error: inference.output_prefix must be set, e.g. inference.output_prefix=outputs/binder\n');
        return 1;
      }
      if (opts['inference.input_pdb'] && !needInput(ctx, opts['inference.input_pdb'], 'inference.input_pdb')) return 1;
      const n = Math.min(Number(opts['inference.num_designs'] ?? 1), 20);
      for (let k = 0; k < n; k++) {
        write(ctx, ctx.sh.resolve(`${prefix}_${k}.pdb`), LIBRARY['pdb:complex']());
        ctx.out(`[RFdiffusion] Making design ${prefix}_${k}\n[RFdiffusion] Finished design in 0.81 minutes\n`);
      }
      return 0;
    },
  },
  colabfold_batch: {
    gpu: true,
    run(ctx, { rest }) {
      if (rest.length < 2) {
        ctx.err('usage: colabfold_batch INPUT RESULTS_DIR\n');
        ctx.coach('colabfold-args', 'Give it a FASTA file and a folder for results: `colabfold_batch input.fasta results/`.');
        return 2;
      }
      const input = needInput(ctx, rest[0], 'input');
      if (!input) return 1;
      const out = ctx.sh.resolve(rest[1]);
      write(ctx, joinPath(out, `${stem(input)}_unrelaxed_rank_001_alphafold2_ptm_model_1_seed_000.pdb`), LIBRARY['pdb:small']());
      write(ctx, joinPath(out, 'log.txt'), `Query 1/1: ${stem(input)} (length 29)\nrank_001 pLDDT=88.4 pTM=0.71\nDone\n`);
      ctx.out(`Running colabfold 1.5.5\nQuery 1/1: ${stem(input)} (length 29)\nrank_001_alphafold2_ptm_model_1_seed_000 pLDDT=88.4 pTM=0.71\nDone\n`);
      return 0;
    },
  },
  relax: {
    gpu: false,
    run(ctx, { opts, rest }) {
      const s = opts.s ?? rest[rest.indexOf('-s') + 1];
      const pdb = needInput(ctx, s, '-s');
      if (!pdb) return 1;
      write(ctx, joinPath(ctx.sh.cwd, `${stem(pdb)}_0001.pdb`), LIBRARY['pdb:small']());
      write(ctx, joinPath(ctx.sh.cwd, 'score.sc'), `SEQUENCE:\nSCORE: total_score description\nSCORE: -312.48 ${stem(pdb)}_0001\n`);
      ctx.out(`core.init: Rosetta version 3.14\nprotocols.relax.FastRelax: Total score: -312.48\nprotocols.jd2.JobDistributor: ${stem(pdb)}_0001 reported success\n`);
      return 0;
    },
  },
};
TOOLS.rosetta_scripts = TOOLS.relax;
TOOLS['run_alphafold.sh'] = TOOLS.colabfold_batch;

// Which module or conda environment provides a tool, and whether it's loaded.
export function toolFor(name, cluster) {
  const key = name.replace(/\.py$/, '');
  const tool = TOOLS[key] ?? TOOLS[name];
  if (!tool) return null;
  const fromModule = MODULES.find((m) => m.provides.includes(name));
  const fromConda = Object.entries(CONDA_ENVS).find(([, t]) => t.includes(name));
  const available = (fromModule && cluster.modules.some((m) => m.split('/')[0] === fromModule.name)) || (fromConda && cluster.condaEnv === fromConda[0]);
  return { tool, available };
}

export function runTool(ctx, name, args) {
  const { cluster } = ctx.sh;
  const found = toolFor(name, cluster);
  if (found.tool.gpu && !(cluster.interactive?.gpus > 0)) {
    ctx.err('RuntimeError: No CUDA GPUs are available\n');
    ctx.coach('tool-gpu', cluster.interactive
      ? 'Your interactive job has no GPU. `exit`, then start one with `srun --gres=gpu:1 --pty bash`.'
      : 'Geiss-01 only gives you a GPU through Slurm. Start an interactive job with `srun --gres=gpu:1 --pty bash`, or submit a job script with `sbatch`.');
    return 1;
  }
  const rest = [];
  const opts = {};
  if (name === 'relax' || name === 'rosetta_scripts') {
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-') && !args[i].startsWith('--')) opts[args[i].slice(1)] = args[++i];
      else rest.push(args[i]);
    }
    return found.tool.run({ ...ctx, name }, { opts, rest });
  }
  return found.tool.run({ ...ctx, name }, readArgs(args));
}
