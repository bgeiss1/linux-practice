// Everything else: help, history, who/where am I, scripts, and friendly
// stand-ins for things the practice server doesn't do.

import { splitStatements } from '../parser.js';
import { dirname, basename } from '../vfs.js';
import { toolFor, runTool } from './tools.js';
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
  ctx.out(ctx.sh.host + '\n');
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
  const script = ctx.args[0] && basename(ctx.args[0]);
  const found = script && toolFor(script, cluster);
  if (found?.available) return runTool(ctx, script, ctx.args.slice(1));
  if (found) {
    ctx.err(`${ctx.name}: can't open file '${ctx.args[0]}': [Errno 2] No such file or directory\n`);
    ctx.coach('python-env', cluster.missingCommandTip(script) ?? 'Activate the conda environment that has this tool first.');
    return 2;
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

// Opens the in-page editor. The page shows it and calls Shell.saveEdit on save.
export function editor(ctx) {
  const { sh } = ctx;
  const file = ctx.args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
  if (ctx.piped) {
    ctx.err(`${ctx.name}: an editor needs the whole screen, so it can't be piped\n`);
    return 1;
  }
  if (!file) {
    ctx.err(`${ctx.name}: give it a file name, like ${ctx.name} notes.txt\n`);
    ctx.coach('editor-name', `Name the file to open: \`nano run.sh\`. If it doesn't exist yet, nano creates it when you save.`);
    return 1;
  }
  const abs = sh.resolve(file);
  const node = sh.vfs.get(abs);
  if (node?.type === 'dir') {
    ctx.err(`${ctx.name}: ${file} is a directory\n`);
    return 1;
  }
  const parent = sh.vfs.get(dirname(abs));
  if (!parent || parent.type !== 'dir') {
    ctx.err(`${ctx.name}: ${file}: No such file or directory (the folder doesn't exist)\n`);
    ctx.coach('editor-dir', `Make the folder first with \`mkdir -p ${dirname(file) || '.'}\`.`);
    return 1;
  }
  if (node?.archive || node?.gz) {
    ctx.err(`${ctx.name}: ${file} is binary, not text\n`);
    return 1;
  }
  if (ctx.name !== 'nano') {
    ctx.coach('editor-nano', `This practice server opens every editor as nano. Real ${ctx.name} works very differently.`);
  }
  ctx.edit({ path: abs, file, content: node?.content ?? '', isNew: !node });
  return 0;
}

export function ssh(ctx) {
  const target = ctx.args.find((a) => !a.startsWith('-')) ?? '';
  const host = target.split('@').pop();
  if (ctx.sh.kind === 'laptop' && host && ctx.sh.remoteFor(host)) {
    ctx.out(`(This app keeps Geiss-01 in its own tab. Switch to the Geiss-01 tab to work there.)\n`, 'dim');
    ctx.coach('ssh-tab', 'On a real laptop, `ssh` would log you in right here. In this app, use the Geiss-01 tab instead.');
    return 0;
  }
  if (ctx.sh.kind === 'cluster' && (target.includes(NODE.name) || target.includes('geiss'))) {
    ctx.out(`You're already logged in to ${NODE.name}.\n`, 'dim');
    return 0;
  }
  ctx.err(`ssh: Could not resolve hostname ${host || '(none)'}: Name or service not known\n`);
  return 255;
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
  const positional = { 0: path, '#': String(args.length), '@': args.join(' '), argv: args };
  args.forEach((a, i) => { positional[i + 1] = a; });
  let code = 0;
  try {
    const stmts = splitStatements(node.content).filter((t) => !/^set\s/.test(t));
    const result = { output: [], coach: [], clear: false };
    code = sh.execStatements(stmts, result, { extraEnv: positional, stopOnError: /^set -e/m.test(node.content) });
    for (const seg of result.output) {
      if (seg.cls === 'err') ctx.err(seg.text);
      else ctx.out(seg.text, seg.cls);
    }
    for (const c of result.coach) ctx.coach(c.key, c.text);
  } finally {
    sh.scriptDepth--;
    sh.cwd = saved.cwd;
    sh.cluster.modules = saved.modules;
    sh.cluster.condaEnv = saved.conda;
    sh.vars = saved.vars;
  }
  return code;
}

export function basenameCmd(ctx) {
  const [path, suffix] = ctx.args;
  if (path === undefined) { ctx.err('basename: missing operand\n'); return 1; }
  let b = path.replace(/\/+$/, '').split('/').pop() || '/';
  if (suffix && b.endsWith(suffix) && b !== suffix) b = b.slice(0, -suffix.length);
  ctx.out(b + '\n');
}

export function dirnameCmd(ctx) {
  if (!ctx.args.length) { ctx.err('dirname: missing operand\n'); return 1; }
  ctx.out(dirname(ctx.args[0].replace(/\/+$/, '')).replace(/^$/, '.') + '\n');
}
