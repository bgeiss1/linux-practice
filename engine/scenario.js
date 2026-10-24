// Turns a scenario file into a live practice session: draws random values,
// builds the starting files, and tracks tasks, hints, and stars.

import { VFS } from './vfs.js';
import { Shell } from './shell.js';
import { Cluster } from './cluster.js';
import { fromLibrary } from './library.js';
import { evaluate } from './checks.js';
import { BINARY } from './commands/archive.js';

export const TIERS = {
  1: { name: 'Guided', maxHints: 3, gated: false, coach: 'all' },
  2: { name: 'Practice', maxHints: 2, gated: false, coach: 'all' },
  3: { name: 'Applied', maxHints: 1, gated: false, coach: 'errors' },
  4: { name: 'Independent', maxHints: 1, gated: true, coach: 'none' },
};

// Coach messages that explain something rather than react to a mistake.
const INFO_COACH = new Set(['sbatch-ok', 'cat-sbatch', 'less', 'tail-f', 'srun-in', 'exit-job', 'exit', 'smi-host', 'cut-d', 'editor-nano']);

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// vars: { name: [choices] | { pick, from, excluding } | { fromVar } | { range: [a, b] } }
export function drawVars(spec = {}, rand) {
  const out = {};
  for (const [name, v] of Object.entries(spec)) {
    if (Array.isArray(v)) {
      out[name] = v[Math.floor(rand() * v.length)];
    } else if (v.range) {
      const [a, b] = v.range;
      out[name] = a + Math.floor(rand() * (b - a + 1));
    } else if (v.fromVar) {
      const pool = [out[v.fromVar]].flat();
      out[name] = pool[Math.floor(rand() * pool.length)];
    } else if (v.from) {
      const excluded = [v.excluding ?? []].flat().flatMap((x) => [out[x]].flat());
      const pool = shuffle(v.from.filter((x) => !excluded.includes(x)), rand);
      out[name] = v.pick ? pool.slice(0, v.pick) : pool[0];
    } else {
      out[name] = v;
    }
  }
  return out;
}

export function fill(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
      const [name, idx] = key.split('.');
      if (!(name in vars)) return m;
      const v = vars[name];
      if (idx !== undefined) return Array.isArray(v) ? String(v[Number(idx)] ?? m) : m;
      return Array.isArray(v) ? v.join(' ') : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [fill(k, vars), fill(v, vars)]));
  }
  return value;
}

function parseAge(s) {
  if (!s) return 0;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/);
  if (!m) throw new Error(`Bad age "${s}" (use 30m, 2h, 3d)`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]];
}

function parseSize(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)([KMG]?)$/);
  if (!m) throw new Error(`Bad size "${s}" (use 500K, 150M, 2G)`);
  return Math.round(Number(m[1]) * { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2]]);
}

export function buildFiles(vfs, files, home, now) {
  for (const [rawKey, rawVal] of Object.entries(files ?? {})) {
    const val = rawVal && typeof rawVal === 'object' ? rawVal : rawVal === null ? {} : { content: rawVal };
    const count = Number(val.count ?? 0);
    const keys = count ? Array.from({ length: count }, (_, i) => [rawKey.replace(/\{\{i\}\}/g, String(i + 1).padStart(2, '0')), i + 1]) : [[rawKey, null]];
    for (const [key, i] of keys) {
      const path = vfs.resolve(key, home, home);
      const mtime = now - parseAge(val.age);
      if (key.endsWith('/') || (val.content === undefined && !val.lib && !val.repeat && !val.archive && typeof rawVal !== 'string')) {
        vfs.mkdir(path, { parents: true, mtime });
        continue;
      }
      vfs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { parents: true, mtime });
      let content = val.lib ? fromLibrary(val.lib) : val.content ?? '';
      if (val.repeat) {
        // { "repeat": { "n": 12, "text": ">design_{{n}}\nMSEE...\n", "before": "header\n", "after": "" } }
        const r = val.repeat;
        const body = Array.from({ length: Number(r.n) }, (_, k) => r.text.replace(/\{\{n\}\}/g, String(k + 1)));
        // "insert": { "at": 40, "text": "WARNING ...\n" } drops one line in after repeat line 40.
        if (r.insert) body.splice(Number(r.insert.at), 0, r.insert.text);
        content = (r.before ?? '') + body.join('') + (r.after ?? '');
      }
      if (i !== null) content = content.replace(/\{\{i\}\}/g, String(i).padStart(2, '0'));
      const node = vfs.writeFile(path, content, { mtime, mode: val.exec ? 0o755 : 0o644 });
      if (val.size) node.size = parseSize(val.size);
      // { "archive": { "gz": true, "files": { "run/a.pdb": { "lib": "pdb:small" } } } }
      if (val.archive) packArchive(node, val.archive, now);
    }
  }
}

function packArchive(node, spec, now) {
  const tmp = new VFS(now);
  buildFiles(tmp, spec.files, '/', now);
  const entries = [];
  for (const { path, node: n } of tmp.walk('/')) {
    if (path === '/') continue;
    const name = path.slice(1);
    entries.push({ path: n.type === 'dir' ? name + '/' : name, node: n.type === 'dir' ? { type: 'dir', children: {}, mode: n.mode, mtime: n.mtime } : n });
  }
  node.content = BINARY;
  node.archive = { entries, gz: spec.gz !== false };
  node.size = entries.reduce((s, e) => s + 512 + (e.node.type === 'file' ? VFS.sizeOf(e.node) : 0), 1024);
  if (node.archive.gz) node.size = Math.max(200, Math.round(node.size * 0.3));
}

export class Session {
  constructor(def, { seed = Date.now(), now = Date.now(), user = 'student' } = {}) {
    this.seed = seed;
    this.vars = { user, home: `/home/${user}`, ...drawVars(def.vars, rng(seed)) };
    this.def = fill({ ...def, vars: undefined }, this.vars);
    const tier = Number(this.def.tier) || 1;
    this.tier = TIERS[tier] ? tier : 1;

    const machine = this.def.machines?.cluster ?? {};
    const vfs = new VFS(now);
    const home = `/home/${user}`;
    vfs.mkdir(home, { parents: true });
    vfs.mkdir('/tmp');
    vfs.mkdir(`/scratch/${user}`, { parents: true });
    vfs.writeFile(`${home}/.bashrc`, '# ~/.bashrc\nexport PATH=$HOME/bin:$PATH\nalias ll="ls -la"\n', { mtime: now - 864e5 * 40 });
    buildFiles(vfs, machine.files, home, now);
    const cluster = new Cluster({
      user,
      now,
      modules: machine.modules ?? [],
      conda: machine.conda ?? null,
      jobs: machine.jobs ?? [],
      gpusBusy: Number(machine.gpusBusy ?? 2),
      jobRules: machine.jobRules ?? [],
    });
    this.shell = new Shell({ vfs, user, cwd: vfs.resolve(machine.cwd ?? '~', home, home), cluster });
    this.machines = { cluster: this.shell };

    // Optional second machine: the student's own laptop, for scp practice.
    const lap = this.def.machines?.laptop;
    if (lap) {
      const lapHome = `/Users/${user}`;
      const lvfs = new VFS(now);
      for (const d of ['Desktop', 'Documents', 'Downloads']) lvfs.mkdir(`${lapHome}/${d}`, { parents: true });
      buildFiles(lvfs, lap.files, lapHome, now);
      this.laptop = new Shell({ vfs: lvfs, user, kind: 'laptop', host: 'laptop', home: lapHome, cwd: lvfs.resolve(lap.cwd ?? '~', lapHome, lapHome), cluster: new Cluster({ user, now, gpusBusy: 0 }) });
      this.laptop.remotes['geiss-01'] = this.shell;
      this.machines.laptop = this.laptop;
    }

    this.tasks = (this.def.tasks ?? []).map((t) => ({ text: t.text, check: t.check, done: false }));
    this.hints = this.def.hints ?? [];
    this.hintsUsed = 0;
    this.hintRequests = 0;
    this.mistakes = 0;
    this.complete = false;
  }

  get current() {
    return this.tasks.findIndex((t) => !t.done);
  }

  // Run one command line on a machine ('cluster' or 'laptop') and report what changed.
  run(line, machine = 'cluster') {
    const sh = this.machines[machine] ?? this.shell;
    const result = sh.run(line);
    if (result.output.some((s) => s.cls === 'err') || sh.lastCode) this.mistakes++;
    result.coach = result.coach.filter((c) => this.coachAllowed(c.key));
    result.newlyDone = this.updateTasks();
    result.complete = this.complete;
    return result;
  }

  // Save the editor's buffer (from nano) and report what changed.
  save(path, text, machine = 'cluster') {
    (this.machines[machine] ?? this.shell).saveEdit(path, text);
    return { newlyDone: this.updateTasks(), complete: this.complete };
  }

  coachAllowed(key) {
    const mode = TIERS[this.tier].coach;
    if (mode === 'all') return true;
    if (mode === 'errors') return !INFO_COACH.has(key);
    return false;
  }

  // Tasks complete in order and stay complete once done.
  updateTasks() {
    const done = [];
    for (const [i, task] of this.tasks.entries()) {
      if (task.done) continue;
      if (!evaluate(task.check, this.shell, { machines: this.machines })) break;
      task.done = true;
      done.push(i);
    }
    if (this.tasks.length && this.tasks.every((t) => t.done)) this.complete = true;
    return done;
  }

  get maxHints() {
    return Math.min(TIERS[this.tier].maxHints, this.hints.length);
  }

  // Returns { text } for the next hint, or { message } explaining why not.
  nextHint() {
    this.hintRequests++;
    if (this.hintsUsed >= this.maxHints) {
      return { message: this.maxHints ? 'That was the last hint for this one.' : 'No hints for this one. You can do it.' };
    }
    if (TIERS[this.tier].gated && this.hintsUsed === 0 && this.mistakes === 0 && this.hintRequests < 2) {
      return { message: 'Give it a try first. Ask again if you\'re still stuck.' };
    }
    return { text: this.hints[this.hintsUsed++] };
  }

  get stars() {
    return this.hintsUsed === 0 ? 3 : this.hintsUsed === 1 ? 2 : 1;
  }
}
