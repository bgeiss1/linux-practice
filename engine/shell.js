// The pretend shell: runs parsed command lines against the virtual file
// system and the simulated cluster, and collects output for the terminal.

import { VFS, ShellError, basename, dirname } from './vfs.js';
import { parse, tokenize, globToRegExp, splitStatements } from './parser.js';
import { Cluster } from './cluster.js';
import { COMMANDS } from './commands/index.js';
import { toolFor, runTool } from './commands/tools.js';

export const HOST = 'geiss-01';

// Commands that only exist on Geiss-01, not on the student's laptop.
const CLUSTER_ONLY = new Set(['module', 'ml', 'conda', 'sbatch', 'squeue', 'scancel', 'sacct', 'seff', 'sinfo', 'srun', 'nvidia-smi']);

export class Shell {
  // kind is 'cluster' (Geiss-01) or 'laptop' (the student's own computer).
  // remotes maps host names to other shells, for scp.
  constructor({ vfs = new VFS(), user = 'student', cwd, cluster, kind = 'cluster', host = HOST, home } = {}) {
    this.vfs = vfs;
    this.user = user;
    this.kind = kind;
    this.host = host;
    this.remotes = {};
    this.home = home ?? `/home/${user}`;
    this.cwd = cwd ?? this.home;
    this.prevCwd = null;
    this.history = [];
    this.events = []; // every command run, for task checks
    this.answers = [];
    this.cluster = cluster ?? new Cluster({ user, now: vfs.now });
    this.vars = {};
  }

  get env() {
    return {
      HOME: this.home,
      USER: this.user,
      LOGNAME: this.user,
      HOSTNAME: this.host,
      PWD: this.cwd,
      OLDPWD: this.prevCwd ?? '',
      SHELL: '/bin/bash',
      PATH: this.cluster.path(),
      CONDA_DEFAULT_ENV: this.cluster.condaEnv ?? '',
      ...this.vars,
    };
  }

  prompt() {
    const env = this.cluster.condaEnv ? `(${this.cluster.condaEnv}) ` : '';
    return { env, user: `${this.user}@${this.host}`, path: this.displayPath(this.cwd) };
  }

  displayPath(path) {
    if (path === this.home) return '~';
    if (path.startsWith(this.home + '/')) return '~' + path.slice(this.home.length);
    return path;
  }

  resolve(path) {
    return this.vfs.resolve(path, this.cwd, this.home);
  }

  // Expand one glob word into matching paths, shown the way the student typed them.
  glob(pattern) {
    const absolute = pattern.startsWith('/');
    const parts = pattern.split('/').filter((p, i) => p || i === 0);
    let found = [{ shown: absolute ? '' : null, abs: absolute ? '/' : this.cwd }];
    if (absolute) parts.shift();
    for (const [idx, part] of parts.entries()) {
      const last = idx === parts.length - 1;
      const next = [];
      for (const { shown, abs } of found) {
        const node = this.vfs.get(abs);
        if (!node || node.type !== 'dir') continue;
        const join = (name) => ({
          shown: shown === null ? name : (shown === '' ? '/' : shown + '/') + name,
          abs: abs === '/' ? '/' + name : abs + '/' + name,
        });
        if (part === '.' || part === '..') {
          next.push({ shown: shown === null ? part : shown + '/' + part, abs: this.vfs.resolve(part, abs) });
        } else if (/[*?]/.test(part)) {
          const re = globToRegExp(part);
          for (const name of Object.keys(node.children).sort()) {
            if (name.startsWith('.') && !part.startsWith('.')) continue;
            if (re.test(name) && (last || node.children[name].type === 'dir')) next.push(join(name));
          }
        } else if (part in node.children) {
          next.push(join(part));
        }
      }
      found = next;
    }
    return found.map((f) => f.shown).filter(Boolean);
  }

  // The shell for a host name like "geiss-01" or "geiss-01.colostate.edu".
  remoteFor(host) {
    const name = host.toLowerCase();
    return Object.entries(this.remotes).find(([h]) => name === h || name.startsWith(h + '.'))?.[1] ?? null;
  }

  // Closest existing name, for "did you mean" tips.
  suggest(path) {
    const abs = this.resolve(path);
    const parent = this.vfs.get(dirname(abs));
    if (!parent || parent.type !== 'dir') return null;
    const want = basename(abs).toLowerCase();
    const names = Object.keys(parent.children);
    return (
      names.find((n) => n.toLowerCase() === want) ||
      names.find((n) => n.toLowerCase().startsWith(want.slice(0, 3)) && want.length >= 3) ||
      null
    );
  }

  run(line) {
    const result = { output: [], coach: [], clear: false };
    const trimmed = line.trim();
    if (!trimmed) return result;
    this.history.push(trimmed);

    const code = this.execStatements(splitStatements(trimmed), result, { line: trimmed });
    this.lastCode = code;
    this.cluster.tick(this);
    return result;
  }

  // Run statements in order. Handles "for NAME in WORDS; do ...; done" loops;
  // everything else goes through the parser one statement at a time, so a
  // loop variable is filled in fresh on every pass.
  execStatements(stmts, result, { line = '', extraEnv = {}, stopOnError = false } = {}) {
    let code = 0;
    for (let s = 0; s < stmts.length; s++) {
      const stmt = stmts[s];
      const loop = stmt.match(/^for\s+([A-Za-z_]\w*)(?:\s+in\s+(.*))?$/s);
      if (loop) {
        const end = findDone(stmts, s);
        if (end < 0 || !/^do(\s|$)/.test(stmts[s + 1] ?? '')) {
          result.output.push({ text: 'bash: syntax error: a for loop needs `; do COMMANDS; done`\n', cls: 'err' });
          return 2;
        }
        const body = stmts.slice(s + 1, end);
        body[0] = body[0].replace(/^do\s*/, '');
        if (!body[0]) body.shift();
        let words = [];
        try {
          // "$@" in a loop means each script argument as its own word.
          const quote = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
          const list = (loop[2] ?? '').replace(/"\$@"|\$@/g, () => (extraEnv.argv ?? []).map(quote).join(' '));
          for (const w of tokenize(list, { ...this.env, ...extraEnv }, (inner) => this.capture(inner, extraEnv))) {
            if (w.type !== 'word') continue;
            const matches = w.glob ? this.glob(w.text) : [];
            words.push(...(matches.length ? matches : [w.text]));
          }
        } catch (e) {
          result.output.push({ text: `bash: ${e.message}\n`, cls: 'err' });
          return 2;
        }
        for (const value of words.slice(0, 500)) {
          this.vars[loop[1]] = value;
          code = this.execStatements(body, result, { line, extraEnv, stopOnError });
          if (code && stopOnError) return code;
        }
        s = end;
        continue;
      }
      if (/^(do|done)(\s|$)/.test(stmt)) {
        result.output.push({ text: `bash: syntax error near unexpected token \`${stmt.split(/\s/)[0]}'\n`, cls: 'err' });
        return 2;
      }
      let lists;
      try {
        lists = parse(stmt, { ...this.env, '?': String(this.lastCode ?? 0), ...extraEnv }, (inner) => this.capture(inner, extraEnv));
      } catch (e) {
        result.output.push({ text: `bash: ${e.message}\n`, cls: 'err' });
        code = 2;
        if (stopOnError) return code;
        continue;
      }
      for (const [i, list] of lists.entries()) {
        const prev = lists[i - 1];
        if (prev?.connector === '&&' && code !== 0) continue;
        if (prev?.connector === '||' && code === 0) continue;
        code = this.runPipeline(list, result, line);
      }
      this.lastCode = code;
      if (code && stopOnError) return code;
    }
    return code;
  }

  // Output of a command, for $( ... ). Errors still reach the screen.
  capture(inner, extraEnv = {}) {
    if ((this.substDepth ?? 0) > 3) return '';
    this.substDepth = (this.substDepth ?? 0) + 1;
    const result = { output: [], coach: [], clear: false };
    try {
      this.execStatements(splitStatements(inner), result, { extraEnv });
    } finally {
      this.substDepth--;
    }
    this.pendingErrors = [...(this.pendingErrors ?? []), ...result.output.filter((seg) => seg.cls === 'err')];
    return result.output.filter((seg) => seg.cls !== 'err').map((seg) => seg.text).join('');
  }

  // The editor (nano) hands its buffer back here when the student saves.
  saveEdit(path, text) {
    this.vfs.writeFile(path, text, { mtime: this.cluster.clock() });
    this.events.push({ cmd: 'save', args: [path], flags: '', code: 0, cwd: this.cwd, line: '' });
  }

  runPipeline(list, result, line = '') {
    let stdin = null;
    let code = 0;
    for (const [i, cmd] of list.commands.entries()) {
      const isLast = i === list.commands.length - 1;
      const args = [];
      for (const word of cmd.argv) {
        const matches = word.glob ? this.glob(word.text) : [];
        if (matches.length) args.push(...matches);
        else args.push(word.text);
      }
      const name = args.shift();
      const out = [];
      const err = [];
      const both = []; // in order, for when nothing is redirected
      const ctx = {
        sh: this,
        name,
        args,
        stdin,
        piped: !isLast || cmd.redirects.some((r) => r.fd === 1),
        background: list.background,
        out: (text, cls) => { out.push({ text, cls }); both.push({ text, cls }); },
        err: (text) => { err.push({ text, cls: 'err' }); both.push({ text, cls: 'err' }); },
        coach: (key, text) => result.coach.push({ key, text }),
        clear: () => { result.clear = true; },
        edit: (edit) => { result.edit = edit; },
      };

      if (this.pendingErrors?.length) {
        result.output.push(...this.pendingErrors);
        this.pendingErrors = [];
      }
      const cwdBefore = this.cwd;
      code = this.exec(name, ctx);
      // cwd is where the command was typed, so "ran cd X inDir Y" checks work.
      this.events.push({ cmd: name, args, flags: flagsOf(args), code, cwd: cwdBefore, line });

      if (list.background && isLast) {
        const id = this.cluster.startBackground(name, args);
        result.output.push({ text: `[1] ${id}\n` });
      }

      const stdoutText = out.map((s) => s.text).join('');
      let errSegs = err;
      for (const r of cmd.redirects) {
        if (r.toStdout) continue;
        const text = r.fd === 1 ? stdoutText : err.map((s) => s.text).join('');
        try {
          if (r.target !== '/dev/null') this.vfs.writeFile(this.resolve(r.target), text, { append: r.append, mtime: this.cluster.clock() });
        } catch (e) {
          result.output.push({ text: `bash: ${r.target}: ${e.message}\n`, cls: 'err' });
          code = 1;
        }
        if (r.fd === 2) errSegs = [];
      }
      const mergeErr = cmd.redirects.some((r) => r.toStdout);
      if (isLast && !cmd.redirects.length) {
        result.output.push(...both);
        continue;
      }
      result.output.push(...(mergeErr ? [] : errSegs));
      if (isLast) {
        if (!cmd.redirects.some((r) => r.fd === 1)) result.output.push(...out, ...(mergeErr ? errSegs : []));
      } else {
        stdin = stdoutText + (mergeErr ? err.map((s) => s.text).join('') : '');
      }
    }
    return code;
  }

  exec(name, ctx) {
    // NAME=value sets a shell variable.
    const assign = name.match(/^([A-Za-z_]\w*)=(.*)$/s);
    if (assign && !ctx.args.length) {
      this.vars[assign[1]] = assign[2];
      return 0;
    }
    // Running a script by path: ./run.sh or scripts/run.sh
    if (name.includes('/')) return COMMANDS.__script(ctx, name);
    if (this.kind === 'laptop' && (CLUSTER_ONLY.has(name) || toolFor(name, this.cluster))) {
      ctx.err(`zsh: command not found: ${name}\n`);
      ctx.coach('laptop-only', `\`${name}\` runs on Geiss-01, not on your laptop. Switch to the Geiss-01 tab.`);
      return 127;
    }
    const fn = Object.hasOwn(COMMANDS, name) && !name.startsWith('__') ? COMMANDS[name] : null;
    if (!fn && this.kind === 'cluster' && toolFor(name, this.cluster)?.available) return runTool(ctx, name, ctx.args);
    if (!fn) {
      ctx.err(`bash: ${name}: command not found\n`);
      const local = this.vfs.get(this.resolve(name));
      const tip = local?.type === 'file'
        ? `To run a script in this folder, put \`./\` in front: \`./${name}\`. Or run \`bash ${name}\`.`
        : this.cluster.missingCommandTip(name);
      ctx.coach('notfound', tip ?? `\`${name}\` isn't a command this server knows. Type \`help\` to see the list.`);
      return 127;
    }
    try {
      return fn(ctx) ?? 0;
    } catch (e) {
      if (e instanceof ShellError) {
        ctx.err(`${name}: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  }
}

// Index of the "done" that closes the loop starting at stmts[start].
function findDone(stmts, start) {
  let depth = 0;
  for (let i = start; i < stmts.length; i++) {
    if (/^for\s/.test(stmts[i])) depth++;
    if (/^done$/.test(stmts[i])) depth--;
    if (depth === 0) return i;
  }
  return -1;
}

function flagsOf(args) {
  let flags = '';
  for (const a of args) {
    if (/^-[A-Za-z]+$/.test(a)) flags += a.slice(1);
  }
  return flags;
}
