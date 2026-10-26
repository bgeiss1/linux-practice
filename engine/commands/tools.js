// The design tools a student can run. Module tools (colabfold_batch, gmx,
// Rosetta, AlphaFold) are on PATH once their module is loaded; chai-lab and
// rfd4-generate once their conda environment is active. ProteinMPNN is a repo
// in /opt whose scripts run with the python of its conda environment. Each
// stand-in lives in engine/tools/ and writes small, realistic outputs so later
// steps have something to find.

import { MODULES, REPO_SCRIPTS, envForCommand } from '../cluster.js';
import { joinPath } from '../vfs.js';
import { LIBRARY } from '../library.js';
import { stem, readArgs, needInput, write, hasGpu, noGpu } from '../tools/common.js';
import { colabfold } from '../tools/colabfold.js';
import { chaiLab } from '../tools/chai.js';
import { MPNN_RUNNERS } from '../tools/mpnn.js';
import { rfd4Generate, rfd4Evaluate } from '../tools/rfd4.js';
import { gmx } from '../tools/gromacs.js';

const TOOLS = {
  colabfold_batch: colabfold,
  'chai-lab': chaiLab,
  'rfd4-generate': rfd4Generate,
  'rfd4-evaluate': rfd4Evaluate,
  gmx,
  'relax.linuxgccrelease': rosetta,
  'rosetta_scripts.linuxgccrelease': rosetta,
  'run_alphafold.py': alphafold,
};

// Rosetta flags are single-dash: relax.linuxgccrelease -s in.pdb
function rosetta(ctx) {
  const i = ctx.args.indexOf('-s');
  const pdb = needInput(ctx, i >= 0 ? ctx.args[i + 1] : null, '-s');
  if (!pdb) return 1;
  write(ctx, joinPath(ctx.sh.cwd, `${stem(pdb)}_0001.pdb`), LIBRARY['pdb:small']());
  write(ctx, joinPath(ctx.sh.cwd, 'score.sc'), `SEQUENCE:\nSCORE: total_score description\nSCORE: -312.48 ${stem(pdb)}_0001\n`);
  ctx.out(`core.init: Rosetta version 3.14\nprotocols.relax.FastRelax: Total score: -312.48\nprotocols.jd2.JobDistributor: ${stem(pdb)}_0001 reported success\n`);
  return 0;
}

function alphafold(ctx) {
  if (!hasGpu(ctx)) return noGpu(ctx);
  const { opts } = readArgs(ctx.args);
  const fasta = needInput(ctx, opts.fasta_paths, '--fasta_paths');
  if (!fasta) return 1;
  if (!opts.output_dir) { ctx.err('FATAL Flags parsing error: flag --output_dir=None: Flag --output_dir must have a value other than None.\n'); return 1; }
  const out = ctx.sh.resolve(joinPath(opts.output_dir, stem(fasta)));
  write(ctx, joinPath(out, 'ranked_0.pdb'), LIBRARY['pdb:small']());
  ctx.out(`I1024 run_alphafold.py] Predicting ${stem(fasta)}\nI1024 run_alphafold.py] Final timings for ${stem(fasta)}: predict 512.3 s\n`);
  return 0;
}

// A tool by command name, and whether its module is loaded or its conda
// environment is active.
export function toolFor(name, cluster) {
  if (!TOOLS[name]) return null;
  const mod = MODULES.find((m) => m.provides.includes(name));
  if (mod) return { run: TOOLS[name], available: cluster.modules.includes(mod.name) };
  const env = envForCommand(name);
  if (env) return { run: TOOLS[name], available: cluster.condaEnv === env };
  return null;
}

export function runTool(ctx, name, args) {
  return TOOLS[name]({ ...ctx, name, args });
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
  const name = path.split('/').pop();
  return MPNN_RUNNERS[name]({ ...ctx, name }, args);
}
