// The pretend shell: runs parsed command lines against the virtual file
// system and the simulated cluster, and collects output for the terminal.

import { VFS, ShellError, basename, dirname } from './vfs.js';
import { parse, globToRegExp } from './parser.js';
import { Cluster } from './cluster.js';
import { COMMANDS } from './commands/index.js';

export const HOST = 'geiss-01';

export class Shell {
  constructor({ vfs = new VFS(), user = 'student', cwd, cluster } = {}) {
    this.vfs = vfs;
    this.user = user;
    this.home = `/home/${user}`;
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
      HOSTNAME: HOST,
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
    return { env, user: `${this.user}@${HOST}`, path: this.displayPath(this.cwd) };
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

    let lists;
    try {
      lists = parse(trimmed, this.env);
    } catch (e) {
      result.output.push({ text: `bash: ${e.message}\n`, cls: 'err' });
      return result;
    }

    let code = 0;
    for (const [i, list] of lists.entries()) {
      const prev = lists[i - 1];
      if (prev?.connector === '&&' && code !== 0) continue;
      if (prev?.connector === '||' && code === 0) continue;
      code = this.runPipeline(list, result, trimmed);
    }
    this.lastCode = code;
    this.cluster.tick(this);
    return result;
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
      const ctx = {
        sh: this,
        name,
        args,
        stdin,
        piped: !isLast || cmd.redirects.some((r) => r.fd === 1),
        background: list.background,
        out: (text, cls) => out.push({ text, cls }),
        err: (text) => err.push({ text, cls: 'err' }),
        coach: (key, text) => result.coach.push({ key, text }),
        clear: () => { result.clear = true; },
      };

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
          this.vfs.writeFile(this.resolve(r.target), text, { append: r.append, mtime: this.cluster.clock() });
        } catch (e) {
          result.output.push({ text: `bash: ${r.target}: ${e.message}\n`, cls: 'err' });
          code = 1;
        }
        if (r.fd === 2) errSegs = [];
      }
      const mergeErr = cmd.redirects.some((r) => r.toStdout);
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
    // Running a script by path: ./run.sh or scripts/run.sh
    if (name.includes('/')) return COMMANDS.__script(ctx, name);
    const fn = Object.hasOwn(COMMANDS, name) && !name.startsWith('__') ? COMMANDS[name] : null;
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

function flagsOf(args) {
  let flags = '';
  for (const a of args) {
    if (/^-[A-Za-z]+$/.test(a)) flags += a.slice(1);
  }
  return flags;
}
