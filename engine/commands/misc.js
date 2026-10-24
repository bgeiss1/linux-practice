// Everything else: help, history, who/where am I, scripts, and friendly
// stand-ins for things the practice server doesn't do.

import { parse } from '../parser.js';
import { endInteractive } from './slurm.js';
import { MODULES, CONDA_ENVS, NODE } from '../cluster.js';
import { HELP, MANUAL } from './help.js';

export function help(ctx) {
  ctx.out(HELP);
}

export function man(ctx) {
  const topic = ctx.args[0];
  if (!topic) { ctx.out('What manual page do you want?\nFor example, try \'man ls\'.\n'); return 1; }
  const page = MANUAL[topic];
  if (!page) { ctx.err(`No manual entry for ${topic}\n`); return 16; }
  ctx.out(page.trimStart());
  return 0;
}

export function clear(ctx) {
  ctx.clear();
}

export function history(ctx) {
  ctx.sh.history.forEach((h, i) => ctx.out(`${String(i + 1).padStart(5)}  ${h}\n`));
}

export function whoami(ctx) {
  ctx.out(ctx.sh.user + '\n');
}

export function hostname(ctx) {
  ctx.out(NODE.name + '\n');
}

export function id(ctx) {
  ctx.out(`uid=5012(${ctx.sh.user}) gid=662(mip662) groups=662(mip662)\n`);
}

export function date(ctx) {
  const d = new Date(ctx.sh.cluster.clock());
  ctx.out(d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 UTC $4') + '\n');
}

export function answer(ctx) {
  const text = ctx.args.join(' ').trim();
  if (!text) {
    ctx.err('answer: type your answer after the word answer, for example: answer design_003\n');
    return 1;
  }
  ctx.sh.answers.push(text);
  ctx.out(`Answer recorded: ${text}\n`, 'ok');
  return 0;
}

export function exit(ctx) {
  const { sh } = ctx;
  if (sh.cluster.interactive) {
    endInteractive(sh);
    ctx.out('exit\n');
    ctx.coach('exit-job', 'You left the interactive job and gave its GPUs back.');
    return 0;
  }
  ctx.out(`logout\nConnection to ${NODE.name} closed.\n`);
  ctx.coach('exit', 'On a real terminal you\'d now be back on your own computer. Here the session stays open so you can keep practicing.');
  return 0;
}

export function which(ctx) {
  const { cluster } = ctx.sh;
  let code = 0;
  for (const name of ctx.args) {
    const path = locate(name, cluster);
    if (path) ctx.out(path + '\n');
    else {
      ctx.err(`which: no ${name} in (${cluster.path()})\n`);
      code = 1;
    }
  }
  return code;
}

function locate(name, cluster) {
  if (name === 'conda') return cluster.modules.includes('anaconda') ? '/opt/conda/bin/conda' : null;
  if (name === 'python' || name === 'python3') {
    if (cluster.condaEnv) return `/opt/conda/envs/${cluster.condaEnv === 'base' ? '' : cluster.condaEnv + '/'}bin/${name}`.replace('/envs/bin', '/bin');
    return name === 'python3' ? '/usr/bin/python3' : null;
  }
  for (const m of MODULES) {
    if (m.provides.includes(name)) return cluster.modules.includes(m.name) ? `/opt/modules/${m.name}/${m.version}/bin/${name}` : null;
  }
  for (const [env, tools] of Object.entries(CONDA_ENVS)) {
    if (tools.includes(name)) return cluster.condaEnv === env ? `/opt/conda/envs/${env}/bin/${name}` : null;
  }
  return COMMANDS_ON_PATH.has(name) ? `/usr/bin/${name}` : null;
}

const COMMANDS_ON_PATH = new Set(['ls', 'cat', 'grep', 'find', 'sort', 'head', 'tail', 'wc', 'cut', 'uniq', 'diff', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'chmod', 'less', 'more', 'sbatch', 'squeue', 'scancel', 'sacct', 'sinfo', 'srun', 'seff', 'nvidia-smi', 'bash', 'ssh', 'scp', 'date', 'hostname', 'whoami', 'which', 'man']);

export function python(ctx) {
  const { cluster } = ctx.sh;
  if (ctx.args[0] === '--version' || ctx.args[0] === '-V') {
    ctx.out(cluster.condaEnv ? 'Python 3.11.9\n' : 'Python 3.9.18\n');
    return 0;
  }
  if (ctx.name === 'python' && !cluster.condaEnv) {
    ctx.err('bash: python: command not found\n');
    ctx.coach('python', 'There is no `python` until a conda environment is active. Try `module load anaconda` and then `conda activate`.');
    return 127;
  }
  ctx.err(`${ctx.name}: design tools don't run directly on this practice server\n`);
  ctx.coach('python-slurm', 'Heavy work on Geiss-01 goes through Slurm so the 8 GPUs are shared fairly. Put the command in a job script and submit it with `sbatch`.');
  return 1;
}

export function sudo(ctx) {
  ctx.err(`[sudo] password for ${ctx.sh.user}: \n${ctx.sh.user} is not in the sudoers file.  This incident will be reported.\n`);
  ctx.coach('sudo', 'Students never get administrator rights on a shared server. Software comes from `module load` and `conda activate` instead.');
  return 1;
}

export function editor(ctx) {
  ctx.err(`${ctx.name}: the text editor isn't available in this lesson yet.\n`);
  ctx.coach('editor', 'To write a short file without an editor, use `echo "some text" > notes.txt`. Use `>>` to add a line to the end.');
  return 1;
}

export function ssh(ctx) {
  const target = ctx.args.find((a) => !a.startsWith('-')) ?? '';
  if (target.includes(NODE.name) || target.includes('geiss')) {
    ctx.out(`You're already logged in to ${NODE.name}.\n`, 'dim');
    return 0;
  }
  ctx.err(`ssh: Could not resolve hostname ${target.split('@').pop() || '(none)'}: Name or service not known\n`);
  return 255;
}

export function scp(ctx) {
  ctx.err('ssh: connect to host my-laptop port 22: Connection refused\nscp: Connection closed\n');
  ctx.coach('scp-side', 'Your laptop can reach Geiss-01, but Geiss-01 can\'t reach your laptop. Run `scp` in a terminal on your own computer.');
  return 1;
}

export function sleep() {
  return 0;
}

export const yes = () => 0;
export const trueCmd = () => 0;
export const falseCmd = () => 1;

export function jobs(ctx) {
  const { cluster } = ctx.sh;
  cluster.background.forEach((b, i) => {
    const done = cluster.step >= b.doneStep;
    ctx.out(`[${i + 1}]${i === cluster.background.length - 1 ? '+' : '-'}  ${done ? 'Done   ' : 'Running'}                 ${b.command}\n`);
  });
}

export function exportCmd(ctx) {
  for (const a of ctx.args) {
    const m = a.match(/^([A-Za-z_]\w*)=(.*)$/s);
    if (m) ctx.sh.vars[m[1]] = m[2];
  }
}

export function env(ctx) {
  for (const [k, v] of Object.entries(ctx.sh.env)) ctx.out(`${k}=${v}\n`);
}

// bash script.sh [args]  or  ./script.sh [args]
export function bash(ctx) {
  const [path, ...args] = ctx.args;
  if (!path) {
    ctx.out('(You\'re already in bash. Give it a script file to run, like `bash hello.sh`.)\n', 'dim');
    return 0;
  }
  return runScript(ctx, path, args, false);
}

export function script(ctx, name) {
  return runScript(ctx, name, ctx.args, true);
}

function runScript(ctx, path, args, needExec) {
  const { sh } = ctx;
  const node = sh.vfs.get(sh.resolve(path));
  const label = needExec ? `bash: ${path}` : `bash: ${path}`;
  if (!node) {
    ctx.err(`${label}: No such file or directory\n`);
    return 127;
  }
  if (node.type === 'dir') {
    ctx.err(`${label}: Is a directory\n`);
    return 126;
  }
  if (needExec && !(node.mode & 0o100)) {
    ctx.err(`${label}: Permission denied\n`);
    ctx.coach('noexec', `The file isn't marked as runnable. Either run \`bash ${path}\`, or make it executable with \`chmod +x ${path}\` first.`);
    return 126;
  }
  if ((sh.scriptDepth ?? 0) > 3) {
    ctx.err(`${label}: too many nested scripts\n`);
    return 1;
  }
  // A script runs in its own copy of the environment: cd, module load and
  // conda activate inside it don't change the student's shell afterwards.
  const saved = { cwd: sh.cwd, modules: [...sh.cluster.modules], conda: sh.cluster.condaEnv, vars: { ...sh.vars } };
  sh.scriptDepth = (sh.scriptDepth ?? 0) + 1;
  const positional = { 0: path, '#': String(args.length), '@': args.join(' ') };
  args.forEach((a, i) => { positional[i + 1] = a; });
  let code = 0;
  try {
    for (const line of node.content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (t === 'set -e' || t.startsWith('set ')) continue;
      let lists;
      try {
        lists = parse(t, { ...sh.env, ...positional });
      } catch (e) {
        ctx.err(`${path}: line: ${e.message}\n`);
        code = 2;
        break;
      }
      const result = { output: [], coach: [], clear: false };
      for (const [i, list] of lists.entries()) {
        const prev = lists[i - 1];
        if (prev?.connector === '&&' && code !== 0) continue;
        if (prev?.connector === '||' && code === 0) continue;
        code = sh.runPipeline(list, result);
      }
      for (const seg of result.output) {
        if (seg.cls === 'err') ctx.err(seg.text);
        else ctx.out(seg.text, seg.cls);
      }
      if (code !== 0 && node.content.includes('set -e')) break;
    }
  } finally {
    sh.scriptDepth--;
    sh.cwd = saved.cwd;
    sh.cluster.modules = saved.modules;
    sh.cluster.condaEnv = saved.conda;
    sh.vars = saved.vars;
  }
  return code;
}
