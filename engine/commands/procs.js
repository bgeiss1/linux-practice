// Processes: ps, top, htop, kill, pkill, pgrep. These work on programs
// running on the machine, which is a different thing from Slurm jobs
// (squeue / scancel). The process list itself lives in Cluster.processList.

import { NODE } from '../cluster.js';
import { endInteractive } from './slurm.js';

const MY_TTY = 'pts/0';

const procs = (sh) => sh.cluster.processList({ laptop: sh.kind === 'laptop' });

// The short program name ps shows in its CMD column.
const commOf = (p) => p.comm ?? p.command.split(/\s+/)[0].split('/').pop().replace(/^-/, '');

function fmtMem(gb) {
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : 1)}G`;
  return `${Math.max(1, Math.round(gb * 1024))}M`;
}

// CPU time used so far, from the CPU% and how long it has been running.
function cpuSeconds(sh, p) {
  const minutes = Math.max(0, sh.cluster.step - p.startStep);
  return Math.round((p.cpu / 100) * minutes * 60);
}

const two = (n) => String(n).padStart(2, '0');
function hms(secs) {
  return `${two(Math.floor(secs / 3600))}:${two(Math.floor(secs / 60) % 60)}:${two(secs % 60)}`;
}
function timePlus(secs) {
  return `${Math.floor(secs / 60)}:${two(secs % 60)}.${two((secs * 7) % 100)}`;
}
function startTime(sh, p) {
  const d = new Date(sh.cluster.start + p.startStep * 60_000);
  const daysAgo = (sh.cluster.clock() - d.getTime()) / 864e5;
  if (daysAgo >= 1) return d.toUTCString().slice(8, 11) + two(d.getUTCDate());
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

// ps and top cut long user names to fit their column and mark the cut with +.
const userCol = (u, w) => (u.length > w ? u.slice(0, w - 1) + '+' : u.padEnd(w));

const memPct = (p) => (p.memGB / NODE.memGB) * 100;

// The ps/top/htop process itself, so it shows up in its own listing like the real thing.
function selfProc(sh, name, args) {
  return { pid: 40_000 + sh.cluster.step * 3, ppid: 30412, user: sh.user, command: [name, ...args].join(' '), comm: name, tty: MY_TTY, state: 'R', cpu: 0, memGB: 0.004, startStep: sh.cluster.step };
}

export function ps(ctx) {
  const { sh } = ctx;
  let all = false;
  let full = false;
  let userFmt = false;
  let users = null;
  let pids = null;
  let mineAnyTty = false;
  const args = [...ctx.args];
  while (args.length) {
    const a = args.shift();
    if (a === '-e' || a === '-A' || a === '--everyone') all = true;
    else if (a === '-f') full = true;
    else if (a === '-ef' || a === '-fe' || a === '-eF') { all = true; full = true; }
    else if (a === '-u' || a === '-U' || a === '--user') users = (args.shift() ?? '').split(',');
    else if (/^-[uU]./.test(a)) users = a.slice(2).split(',');
    else if (a.startsWith('--user=')) users = a.slice(7).split(',');
    else if (a === '-p' || a === '--pid') pids = (args.shift() ?? '').split(',').map(Number);
    else if (/^-p\d/.test(a)) pids = a.slice(2).split(',').map(Number);
    else if (/^[aux]+$/.test(a)) {
      // BSD style without a dash: a = everyone's, x = not only this terminal, u = user columns.
      if (a.includes('u')) userFmt = true;
      if (a.includes('a') && a.includes('x')) all = true;
      else if (a.includes('x')) mineAnyTty = true;
      else if (a.includes('a')) all = true;
    } else if (/^\d+$/.test(a)) pids = [...(pids ?? []), Number(a)];
    else {
      ctx.err(`error: unsupported option ${a}\n\nThe practice ps knows: ps, ps -u USER, ps ux, ps aux, ps -ef, ps -p PID\n`);
      return 1;
    }
  }
  let list = [...procs(sh), selfProc(sh, 'ps', ctx.args)].sort((a, b) => a.pid - b.pid);
  if (pids) list = list.filter((p) => pids.includes(p.pid));
  else if (users) list = list.filter((p) => users.includes(p.user) || users.includes(String(uidOf(p.user, sh))));
  else if (mineAnyTty) list = list.filter((p) => p.user === sh.user);
  else if (!all) {
    list = list.filter((p) => p.user === sh.user && p.tty === MY_TTY);
    if (procs(sh).some((p) => p.user === sh.user && p.tty === '?' && p.proc)) {
      ctx.coach('ps-tty', `Plain \`ps\` only lists programs started from this terminal. To see every process of yours, run \`ps -u ${sh.user}\` or \`ps ux\`, or open \`htop\`.`);
    }
  }
  let code = 0;
  if (pids && !list.length) code = 1;

  if (userFmt) {
    ctx.out('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n');
    for (const p of list) {
      const rssK = Math.round(p.memGB * 1024 * 1024);
      const vszK = Math.round(rssK * 1.15 + 9_000);
      const secs = cpuSeconds(sh, p);
      ctx.out(`${userCol(p.user, 8)} ${String(p.pid).padStart(7)} ${p.cpu.toFixed(1).padStart(4)} ${memPct(p).toFixed(1).padStart(4)} ${String(vszK).padStart(6)} ${String(rssK).padStart(5)} ${p.tty.padEnd(8)} ${(p.state + (p.ppid === 1 || p.login ? 's' : '')).padEnd(4)} ${startTime(sh, p).padStart(5)} ${`${Math.floor(secs / 60)}:${two(secs % 60)}`.padStart(6)} ${p.command}\n`);
    }
  } else if (full) {
    ctx.out('UID          PID    PPID  C STIME TTY          TIME CMD\n');
    for (const p of list) {
      ctx.out(`${userCol(p.user, 8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)} ${String(Math.min(99, Math.round(p.cpu))).padStart(2)} ${startTime(sh, p).padStart(5)} ${p.tty.padEnd(8)} ${hms(cpuSeconds(sh, p))} ${p.command}\n`);
    }
  } else {
    ctx.out('    PID TTY          TIME CMD\n');
    for (const p of list) ctx.out(`${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} ${hms(cpuSeconds(sh, p))} ${commOf(p)}\n`);
  }
  return code;
}

function uidOf(user, sh) {
  if (user === 'root') return 0;
  if (user === sh.user) return 5012;
  return null;
}

function readUserFilter(ctx, name) {
  const args = [...ctx.args];
  let user = null;
  while (args.length) {
    const a = args.shift();
    if (a === '-u' || a === '-U' || a === '--user') user = args.shift() ?? null;
    else if (a.startsWith('--user=')) user = a.slice(7);
    else if (/^-u./.test(a)) user = a.slice(2);
    else if (a === '-b' || a === '-n' || a === '-d' || /^-[bnd]\d*$/.test(a)) { if (/^-[nd]$/.test(a)) args.shift(); }
    else if (a === '-h' || a === '--help') return { help: true };
    else return { bad: a };
  }
  if (user === '') return { bad: '-u' };
  return { user };
}

function snapshot(sh, name, args, user) {
  const all = [...procs(sh), selfProc(sh, name, args)];
  const usedGB = all.reduce((n, p) => n + p.memGB, 0) + 3.4;
  const cpuTotal = all.reduce((n, p) => n + p.cpu, 0);
  const shown = (user ? all.filter((p) => p.user === user) : all).sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
  const running = all.filter((p) => p.state === 'R').length;
  const load = cpuTotal / 100;
  return { all, shown, usedGB, cpuPct: Math.min(100, cpuTotal / NODE.cpus), running, load };
}

const bar = (frac, width) => '|'.repeat(Math.round(Math.min(1, frac) * width)).padEnd(width);

export function htop(ctx) {
  const { sh } = ctx;
  const f = readUserFilter(ctx, 'htop');
  if (f.bad) { ctx.err(`htop: unrecognized option '${f.bad}'\nThe practice htop knows: htop, htop -u USER\n`); return 1; }
  if (f.help) { ctx.out('htop [-u USER]   show running processes, busiest first. q quits.\n'); return 0; }
  const s = snapshot(sh, 'htop', ctx.args, f.user);
  const uptime = '12 days, 04:13:22';
  ctx.out(`  CPU[${bar(s.cpuPct / 100, 30)}${s.cpuPct.toFixed(1).padStart(5)}%]   Tasks: ${s.all.length}, ${s.all.length * 4 + 37} thr; ${s.running} running\n`);
  ctx.out(`  Mem[${bar(s.usedGB / NODE.memGB, 23)}${`${s.usedGB.toFixed(1)}G/${NODE.memGB}G`.padStart(12)}]   Load average: ${s.load.toFixed(2)} ${(s.load * 0.94).toFixed(2)} ${(s.load * 0.88).toFixed(2)}\n`);
  ctx.out(`  Swp[${''.padEnd(25)}${'0K/8.00G'.padStart(10)}]   Uptime: ${uptime}\n`);
  ctx.out(`  (${NODE.cpus} cores in one bar here; real htop draws a bar for every core)\n\n`, 'dim');
  ctx.out('    PID USER       PRI  NI  VIRT   RES   SHR S  CPU% MEM%   TIME+  Command\n', 'hl');
  for (const p of s.shown) {
    const virt = fmtMem(p.memGB * 1.12 + 0.3);
    const shr = fmtMem(Math.min(p.memGB, 0.05 + p.memGB * 0.04));
    ctx.out(`${String(p.pid).padStart(7)} ${userCol(p.user, 10)}  20   0 ${virt.padStart(5)} ${fmtMem(p.memGB).padStart(5)} ${shr.padStart(5)} ${p.state} ${p.cpu.toFixed(1).padStart(5)} ${memPct(p).toFixed(1).padStart(4)} ${timePlus(cpuSeconds(sh, p)).padStart(9)}  ${p.command}\n`);
  }
  ctx.out('\nF1Help  F2Setup F3Search F4Filter F5Tree  F6SortBy F7Nice- F8Nice+ F9Kill  F10Quit\n', 'hl');
  ctx.out('(practice site: real htop keeps redrawing until you press q or F10. To stop a process, note its PID and use kill, or select it in htop and press F9.)\n', 'dim');
  ctx.coach('htop', 'Busiest processes are at the top. The PID column is what `kill` needs, and USER tells you whose process it is.');
  return 0;
}

export function top(ctx) {
  const { sh } = ctx;
  const f = readUserFilter(ctx, 'top');
  if (f.bad) { ctx.err(`top: unknown option '${f.bad}'\nThe practice top knows: top, top -u USER, top -b -n 1\n`); return 1; }
  if (f.help) { ctx.out('top [-u USER]   show running processes, busiest first. q quits.\n'); return 0; }
  const s = snapshot(sh, 'top', ctx.args, f.user);
  const d = new Date(sh.cluster.clock());
  const totalMiB = NODE.memGB * 1024;
  const usedMiB = s.usedGB * 1024;
  const cache = 21_480.3;
  ctx.out(`top - ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} up 12 days,  4:13,  3 users,  load average: ${s.load.toFixed(2)}, ${(s.load * 0.94).toFixed(2)}, ${(s.load * 0.88).toFixed(2)}\n`);
  ctx.out(`Tasks: ${String(s.all.length).padStart(3)} total, ${String(s.running).padStart(3)} running, ${String(s.all.length - s.running).padStart(3)} sleeping,   0 stopped,   0 zombie\n`);
  ctx.out(`%Cpu(s): ${s.cpuPct.toFixed(1).padStart(4)} us,  0.4 sy,  0.0 ni, ${(99.6 - s.cpuPct).toFixed(1).padStart(4)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st\n`);
  ctx.out(`MiB Mem : ${totalMiB.toFixed(1).padStart(8)} total, ${(totalMiB - usedMiB - cache).toFixed(1).padStart(8)} free, ${usedMiB.toFixed(1).padStart(8)} used, ${cache.toFixed(1).padStart(8)} buff/cache\n`);
  ctx.out(`MiB Swap:   8192.0 total,   8192.0 free,      0.0 used. ${(totalMiB - usedMiB).toFixed(1).padStart(8)} avail Mem\n\n`);
  ctx.out('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n', 'hl');
  for (const p of s.shown) {
    const rss = p.memGB * 1024 * 1024;
    const k = (n) => (n >= 1e7 ? `${(n / 1024 / 1024).toFixed(1)}g` : String(Math.round(n)));
    ctx.out(`${String(p.pid).padStart(7)} ${userCol(p.user, 9)} 20   0 ${k(rss * 1.12 + 300_000).padStart(7)} ${k(rss).padStart(6)} ${k(Math.min(rss, 50_000 + rss * 0.04)).padStart(6)} ${p.state} ${p.cpu.toFixed(1).padStart(5)} ${memPct(p).toFixed(1).padStart(5)} ${timePlus(cpuSeconds(sh, p)).padStart(9)} ${commOf(p)}\n`);
  }
  ctx.out('\n(practice site: real top redraws every few seconds until you press q. Press k inside top to kill a PID, or quit and use kill.)\n', 'dim');
  return 0;
}

// Signals students meet: TERM asks a program to stop (the default),
// KILL forces it, INT is what Ctrl+C sends, HUP is "the terminal went away".
const SIGNALS = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, TERM: 15, STOP: 19, CONT: 18, USR1: 10, USR2: 12 };
const SIG_NAMES = Object.fromEntries(Object.entries(SIGNALS).map(([k, v]) => [v, k]));

function readSignal(text) {
  const t = text.toUpperCase().replace(/^SIG/, '');
  if (/^\d+$/.test(t)) return SIG_NAMES[Number(t)] ?? null;
  return SIGNALS[t] ? t : null;
}

// Send a signal to one process. Returns 'ok', 'ESRCH' (no such process) or 'EPERM'.
function signalProcess(ctx, p, sig) {
  const { sh } = ctx;
  const { cluster } = sh;
  if (p.user !== sh.user) return 'EPERM';
  if (sig === 'CONT' || sig === 'STOP' || sig === 'USR1' || sig === 'USR2') return 'ok';
  const forced = sig === 'KILL';
  if (p.login) {
    // An interactive bash ignores TERM. KILL would log you out.
    if (forced) {
      ctx.out(`Connection to ${NODE.name} closed.\n`);
      ctx.coach('kill-login', `PID ${p.pid} is your own login shell, so \`kill -9\` logged you out. On a real server you'd ssh back in; here the session stays open. Look for the PID of the program you meant in \`ps -u ${sh.user}\` or \`htop\`.`);
    }
    return 'ok';
  }
  if (p.interactive) {
    if (cluster.interactive) endInteractive(sh);
    ctx.out(`srun: forcing job termination\nsrun: error: ${NODE.name}: task 0: ${forced ? 'Killed' : 'Terminated'}\n`, 'err');
    ctx.coach('kill-srun', 'That ended your interactive Slurm job. Typing `exit` is the tidy way to leave one, and `scancel JOBID` works from anywhere.');
    return 'ok';
  }
  if (p.jobId !== undefined) {
    const job = cluster.jobs.find((j) => j.id === p.jobId);
    if (job && job.state === 'R') {
      job.result = 'FAILED';
      job.state = 'F';
      job.exitCode = forced ? 137 : 143;
      job.endStep = cluster.step;
      job.live = false;
    }
    ctx.coach('kill-batch', `That process was Slurm batch job ${p.jobId}, and killing it made the job fail. For anything Slurm started, use \`scancel ${p.jobId}\`: it stops every process in the job and gives back its GPUs and memory.`);
    return 'ok';
  }
  if (p.jobSpec) {
    const b = cluster.background[p.jobSpec - 1];
    b.signal = forced ? 'Killed' : 'Terminated';
    ctx.out(`[${p.jobSpec}]+  ${b.signal.padEnd(24)}${b.command}\n`);
    return 'ok';
  }
  if (p.proc) {
    if (p.proc.ignoresTerm && !forced) return 'ok'; // It caught the signal and kept going.
    p.proc.gone = sig;
    return 'ok';
  }
  return 'ok';
}

const KILL_USAGE = 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n';

export function kill(ctx) {
  const { sh } = ctx;
  const args = [...ctx.args];
  let sig = 'TERM';
  if (args[0] === '-l' || args[0] === '-L') {
    ctx.out(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t10) SIGUSR1\n12) SIGUSR2\t15) SIGTERM\t18) SIGCONT\t19) SIGSTOP\n');
    return 0;
  }
  if (args[0] === '-s' || args[0] === '-n') {
    args.shift();
    const name = args.shift();
    sig = name ? readSignal(name) : null;
    if (!sig) { ctx.err(`bash: kill: ${name ?? ''}: invalid signal specification\n`); return 1; }
  } else if (/^-./.test(args[0] ?? '') && args[0] !== '--') {
    const name = args.shift().slice(1);
    sig = readSignal(name);
    if (!sig) { ctx.err(`bash: kill: ${name}: invalid signal specification\n`); return 1; }
  }
  if (args[0] === '--') args.shift();
  if (!args.length) { ctx.err(KILL_USAGE); return 2; }
  const list = procs(sh);
  let code = 0;
  for (const target of args) {
    if (target.startsWith('%')) {
      const n = target === '%' || target === '%%' || target === '%+' ? sh.cluster.background.length : Number(target.slice(1));
      const p = list.find((x) => x.jobSpec === n);
      if (!p) { ctx.err(`bash: kill: ${target}: no such job\n`); code = 1; continue; }
      signalProcess(ctx, p, sig);
      continue;
    }
    if (!/^\d+$/.test(target)) { ctx.err(`bash: kill: ${target}: arguments must be process or job IDs\n`); code = 1; continue; }
    const pid = Number(target);
    const p = list.find((x) => x.pid === pid);
    if (!p) {
      ctx.err(`bash: kill: (${pid}) - No such process\n`);
      code = 1;
      const job = sh.cluster.jobs.find((j) => String(j.id).split('_')[0] === target);
      if (job) ctx.coach('kill-jobid', `${pid} is a Slurm job ID, not a process ID. Slurm jobs are stopped with \`scancel ${pid}\`. \`kill\` takes a PID from \`ps\` or \`htop\`.`);
      continue;
    }
    const r = signalProcess(ctx, p, sig);
    if (r === 'EPERM') {
      ctx.err(`bash: kill: (${pid}) - Operation not permitted\n`);
      ctx.coach('kill-other', `PID ${pid} belongs to ${p.user}, not you. You can only kill your own processes; check the USER column in \`htop\` or \`ps aux\`.`);
      code = 1;
    }
  }
  return code;
}

// pgrep and pkill: find processes by name. -f matches the whole command line.
function matchProcs(ctx, name) {
  const { sh } = ctx;
  const args = [...ctx.args];
  const o = { full: false, user: null, list: false, listFull: false, sig: 'TERM', pattern: null };
  while (args.length) {
    const a = args.shift();
    if (a === '-f' || a === '--full') o.full = true;
    else if (a === '-u' || a === '-U') o.user = args.shift() ?? '';
    else if (/^-u./.test(a)) o.user = a.slice(2);
    else if (a === '-l' && name === 'pgrep') o.list = true;
    else if (a === '-a' && name === 'pgrep') o.listFull = true;
    else if (a === '-la' || a === '-al') { o.list = true; o.listFull = true; }
    else if (a === '-s' || a === '--signal') o.sig = readSignal(args.shift() ?? '');
    else if (a.startsWith('-') && name === 'pkill' && readSignal(a.slice(1))) o.sig = readSignal(a.slice(1));
    else if (a.startsWith('-') && a.length > 1) return { error: `${name}: invalid option -- '${a.replace(/^-+/, '')}'` };
    else if (o.pattern === null) o.pattern = a;
    else return { error: `${name}: only one pattern can be provided` };
  }
  if (!o.sig) return { error: `${name}: invalid signal` };
  if (o.pattern === null && !o.user) return { error: `${name}: no matching criteria specified\nTry \`${name} --help' for more information.` };
  let re;
  try {
    re = new RegExp(o.pattern ?? '');
  } catch {
    return { error: `${name}: invalid regular expression` };
  }
  const found = procs(sh).filter((p) => (!o.user || p.user === o.user) && re.test(o.full ? p.command : commOf(p)));
  return { o, found };
}

export function pgrep(ctx) {
  const r = matchProcs(ctx, 'pgrep');
  if (r.error) { ctx.err(r.error + '\n'); return 2; }
  for (const p of r.found) ctx.out(`${p.pid}${r.o.listFull ? ' ' + p.command : r.o.list ? ' ' + commOf(p) : ''}\n`);
  return r.found.length ? 0 : 1;
}

export function pkill(ctx) {
  const r = matchProcs(ctx, 'pkill');
  if (r.error) { ctx.err(r.error + '\n'); return 2; }
  let killed = 0;
  for (const p of r.found) {
    if (p.login) continue; // pkill skips the shell that runs it
    if (signalProcess(ctx, p, r.o.sig) === 'EPERM') ctx.err(`pkill: killing pid ${p.pid} failed: Operation not permitted\n`);
    else killed++;
  }
  if (r.found.some((p) => p.user !== ctx.sh.user)) {
    ctx.coach('pkill-others', 'pkill matches everyone\'s processes by name and can only stop yours. `pkill -u ' + ctx.sh.user + ' NAME` limits it to your own.');
  }
  return killed ? 0 : 1;
}
