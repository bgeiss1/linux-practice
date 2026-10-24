// Stand-ins for the design tools. Module tools (colabfold_batch, run_alphafold.py,
// Rosetta's relax.linuxgccrelease) are on PATH once their module is loaded.
// ProteinMPNN and RFdiffusion are scripts in repos under /opt that run with the
// python of their conda environment. GPU tools need a GPU from Slurm, and every
// tool writes small placeholder outputs so later steps have something to find.

import { MODULES, REPO_SCRIPTS } from '../cluster.js';
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
  'protein_mpnn_run.py': {
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
  'run_inference.py': {
    gpu: true,
    run(ctx, { opts }) {
      const prefix = opts['inference.output_prefix'];
      if (!prefix) {
        ctx.err('Error: inference.output_prefix must be set, e.g. inference.output_prefix=outputs/binder\n');
        return 1;
      }
      if (!opts['contigmap.contigs']) {
        ctx.err("Error: contigmap.contigs must be set, e.g. 'contigmap.contigs=[A1-150/0 70-100]'\n");
        ctx.coach('rfd-contigs', 'RFdiffusion needs a contig map saying which target residues to keep and how long the binder is. Put it in single quotes because it has a space and brackets.');
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
  'relax.linuxgccrelease': {
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
TOOLS['rosetta_scripts.linuxgccrelease'] = TOOLS['relax.linuxgccrelease'];
TOOLS['run_alphafold.py'] = {
  gpu: true,
  run(ctx, { opts }) {
    const fasta = needInput(ctx, opts.fasta_paths, '--fasta_paths');
    if (!fasta) return 1;
    if (!opts.output_dir) { ctx.err('FATAL Flags parsing error: flag --output_dir=None: Flag --output_dir must have a value other than None.\n'); return 1; }
    const out = ctx.sh.resolve(joinPath(opts.output_dir, stem(fasta)));
    write(ctx, joinPath(out, 'ranked_0.pdb'), LIBRARY['pdb:small']());
    ctx.out(`I1024 run_alphafold.py] Predicting ${stem(fasta)}\nI1024 run_alphafold.py] Final timings for ${stem(fasta)}: predict 512.3 s\n`);
    return 0;
  },
};

// A module tool by command name, and whether its module is loaded.
export function toolFor(name, cluster) {
  const mod = MODULES.find((m) => m.provides.includes(name));
  if (!mod || !TOOLS[name]) return null;
  return { tool: TOOLS[name], available: cluster.modules.includes(mod.name) };
}

// A repo script (absolute path) run with python: its conda environment must be active.
export function runRepoScript(ctx, path, args) {
  const env = REPO_SCRIPTS[path];
  const { cluster } = ctx.sh;
  if (cluster.condaEnv !== env) {
    ctx.err(`Traceback (most recent call last):\n  File "${path}", line 1, in <module>\n    import torch\nModuleNotFoundError: No module named 'torch'\n`);
    ctx.coach('python-env', `This script needs the \`${env}\` conda environment: \`conda activate ${env}\`.`);
    return 1;
  }
  return runTool(ctx, path.split('/').pop(), args);
}

export function runTool(ctx, name, args) {
  const { cluster } = ctx.sh;
  const tool = TOOLS[name];
  if (tool.gpu && !(cluster.interactive?.gpus > 0)) {
    ctx.err('RuntimeError: No CUDA GPUs are available\n');
    ctx.coach('tool-gpu', cluster.interactive
      ? 'Your interactive job has no GPU. `exit`, then start one with `srun --gres=gpu:1 --pty bash`.'
      : 'Geiss-01 only gives you a GPU through Slurm. Start an interactive job with `srun --gres=gpu:1 --pty bash`, or submit a job script with `sbatch`.');
    return 1;
  }
  const rest = [];
  const opts = {};
  if (name.endsWith('.linuxgccrelease')) {
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-') && !args[i].startsWith('--')) opts[args[i].slice(1)] = args[++i];
      else rest.push(args[i]);
    }
    return tool.run({ ...ctx, name }, { opts, rest });
  }
  return tool.run({ ...ctx, name }, readArgs(args));
}
