// Instructor dashboard: edit and test scenarios, import/export, publish to
// GitHub, browse history, and check passphrases from a Canvas export.

import { Session, TIERS } from '../engine/scenario.js';
import { validate } from '../engine/validate.js';
import { wordsFor } from '../engine/passphrase.js';
import { Terminal, esc, fmt, h, lessonHTML } from './terminal.js';
import {
  cloneCopy, diffCopies, addScenario, removeScenario, moveScenario, blankScenario, renumber,
  makeBundle, mergeImport, makeZip, parseCSV, detectColumns, gradeRows, gradesCSV,
  repoFromLocation, decodeBase64, scenarioText,
} from './admin-core.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const DRAFT_KEY = 'linux-practice:admin:v1';
const TOKEN_KEY = 'linux-practice:admin:token';
const DEFAULT_REPO = 'bgeiss1/linux-practice';

// ---------- storage ----------

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: drafts last until the tab closes.
  }
}

// ---------- data ----------

let published; // what the live site serves: { manifest, files }
let work; // drafts: { manifest, files }
let settings; // { repo, branch, baseVersion }
let localMode = false; // served by serve.mjs: publishing saves to this computer

async function fetchCopy(base = 'scenarios/', opts = { cache: 'no-cache' }) {
  const manifest = await (await fetch(`${base}tracks.json`, opts)).json();
  const files = {};
  await Promise.all(
    manifest.tracks.flatMap((t) =>
      t.scenarios.map(async (p) => {
        files[p] = await (await fetch(`${base}${p}.json`, opts)).json();
      }),
    ),
  );
  return { manifest, files };
}

async function loadData() {
  try {
    localMode = !!(await (await fetch('__local', { cache: 'no-cache' })).json()).local;
  } catch {
    localMode = false;
  }
  published = await fetchCopy();
  const saved = load(DRAFT_KEY);
  work = saved?.work ? saved.work : cloneCopy(published);
  settings = {
    repo: saved?.repo ?? repoFromLocation(location) ?? DEFAULT_REPO,
    branch: saved?.branch ?? 'main',
    baseVersion: saved?.baseVersion ?? published.manifest.version,
  };
}

function saveWork() {
  const diff = diffCopies(published, work);
  // With no drafts left, follow the live site again.
  if (!diff.count) settings.baseVersion = published.manifest.version;
  store(DRAFT_KEY, { work: diff.count ? work : null, ...settings });
  renderNav();
}

const trackIds = () => work.manifest.tracks.map((t) => t.id);
const trackOf = (path) => work.manifest.tracks.find((t) => t.scenarios.includes(path));
const changes = () => diffCopies(published, work);

// ---------- validation cache ----------

const checked = new Map(); // path -> { key, errors, warnings, seeds }

function check(path, seeds = 20) {
  const def = work.files[path];
  const key = JSON.stringify(def);
  const prev = checked.get(path);
  if (prev && prev.key === key && prev.seeds >= seeds) return prev;
  let result;
  try {
    result = validate(structuredClone(def), { seeds });
  } catch (e) {
    result = { errors: [`crashed: ${e.message}`], warnings: [] };
  }
  const dup = Object.entries(work.files).find(([p, d]) => p !== path && d.id === def.id);
  if (dup) result.errors.unshift(`id "${def.id}" is also used by ${dup[0]}`);
  if (def.track !== trackOf(path)?.id) result.errors.unshift(`"track" says ${def.track} but it is listed under ${trackOf(path)?.id}`);
  const entry = { key, seeds, ...result };
  checked.set(path, entry);
  return entry;
}

// Quick checks of every scenario in the background, for the list badges.
function checkAllSoon() {
  const queue = Object.keys(work.files).filter((p) => checked.get(p)?.key !== JSON.stringify(work.files[p]));
  const step = () => {
    const p = queue.shift();
    if (!p) return;
    if (work.files[p]) check(p, 4);
    const badge = document.querySelector(`[data-badge="${CSS.escape(p)}"]`);
    if (badge) badge.outerHTML = statusBadge(p);
    setTimeout(step, 0);
  };
  setTimeout(step, 50);
}

// ---------- helpers ----------

function download(name, data, type = 'application/json') {
  const blob = new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function statusOf(path) {
  if (!(path in published.files)) return 'new';
  return JSON.stringify(published.files[path]) === JSON.stringify(work.files[path]) ? 'live' : 'changed';
}

function statusBadge(path) {
  const s = statusOf(path);
  const c = checked.get(path);
  const bad = c && c.key === JSON.stringify(work.files[path]) && c.errors.length;
  const parts = [];
  if (s === 'new') parts.push('<span class="badge new">New</span>');
  if (s === 'changed') parts.push('<span class="badge changed">Changed</span>');
  if (bad) parts.push('<span class="badge bad">Errors</span>');
  return `<span class="badges" data-badge="${esc(path)}">${parts.join('')}</span>`;
}

function flash(msg, kind = 'ok') {
  const el = h(`<div class="flash ${kind}" role="status">${msg}</div>`).firstElementChild;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

const editHref = (path) => `#/edit/${path}`;

// ---------- nav ----------

function renderNav() {
  const route = location.hash.replace(/^#\/?/, '').split('/')[0] || 'list';
  const n = changes().count;
  const items = [
    ['list', '#/', 'Scenarios'],
    ['import', '#/import', 'Import & export'],
    ['publish', '#/publish', `Publish${n ? ` <span class="count">${n}</span>` : ''}`],
    ['history', '#/history', 'History'],
    ['progress', '#/progress', 'Class progress'],
  ];
  nav.innerHTML = items
    .map(([id, href, label]) => `<a href="${href}"${route === id || (id === 'list' && route === 'edit') ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('');
}

// ---------- scenario list ----------

function renderList() {
  const n = changes().count;
  const q = (sessionStorage.getItem('admin-q') ?? '').toLowerCase();
  app.replaceChildren(
    h(`
    <section class="admin-page">
      <div class="page-head">
        <div>
          <h1>Scenarios</h1>
          <p class="muted">Each track needs its scenarios finished in order to earn the student a passphrase word.</p>
        </div>
        <input type="search" id="q" placeholder="Search titles and stories" value="${esc(q)}" aria-label="Search scenarios">
      </div>
      ${n ? `<div class="notice">You have ${n} unpublished change${n === 1 ? '' : 's'}. Students won't see ${n === 1 ? 'it' : 'them'} until you publish. <a class="btn primary" href="#/publish">Review and publish</a></div>` : ''}
      ${settings.baseVersion !== published.manifest.version && n ? `<div class="notice warn">The live site was updated (version ${esc(published.manifest.version)}) after you started these drafts. Publishing checks for conflicts first.</div>` : ''}
      <section class="card course">
        <div>
          <h2>Passphrase salt</h2>
          <p class="muted">Every student's words come from their CSU ID plus this text. Change it each semester so last term's passphrases stop working.</p>
        </div>
        <div class="row"><input type="text" id="salt" value="${esc(work.manifest.passphraseSalt)}" aria-label="Passphrase salt"><button type="button" id="salt-save">Save</button></div>
      </section>
      ${work.manifest.tracks.map((t) => trackBlock(t, q)).join('')}
    </section>`),
  );
  app.querySelector('#q').addEventListener('input', (e) => {
    sessionStorage.setItem('admin-q', e.target.value);
    const pos = e.target.selectionStart;
    renderList();
    const q2 = app.querySelector('#q');
    q2.focus();
    q2.setSelectionRange(pos, pos);
  });
  app.querySelector('#salt-save').addEventListener('click', () => {
    const v = app.querySelector('#salt').value.trim();
    if (!v) return flash('The salt can\'t be empty.', 'bad');
    work.manifest.passphraseSalt = v;
    saveWork();
    flash('Salt saved as a draft. Publish to use it.');
  });
  checkAllSoon();
}

function trackBlock(t, q) {
  const rows = t.scenarios
    .map((path, i) => ({ path, i, def: work.files[path] }))
    .filter(({ def }) => !q || `${def.title} ${def.id} ${def.story}`.toLowerCase().includes(q));
  if (q && !rows.length) return '';
  return `<section class="card track-admin" aria-labelledby="t-${esc(t.id)}">
    <div class="track-head">
      <div><h2 id="t-${esc(t.id)}">${esc(t.title)}</h2><p class="muted">${esc(t.blurb)} · ${t.scenarios.length} scenarios</p></div>
      <div class="row">
        <button type="button" data-act="new" data-track="${esc(t.id)}">New scenario</button>
        <button type="button" data-act="dl-track" data-track="${esc(t.id)}">Download track</button>
      </div>
    </div>
    <table class="scen-table">
      <thead><tr><th scope="col">#</th><th scope="col">Title</th><th scope="col">Tier</th><th scope="col">Status</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
      <tbody>
        ${rows
          .map(
            ({ path, i, def }) => `<tr>
          <td class="num">${String(i + 1).padStart(2, '0')}</td>
          <td><a href="${editHref(esc(path))}">${esc(def.title)}</a><div class="muted small mono">${esc(def.id)}</div></td>
          <td><span class="pill">${esc(def.tier)} · ${esc(TIERS[def.tier]?.name ?? '?')}</span></td>
          <td>${statusBadge(path)}</td>
          <td class="acts">
            <button type="button" class="icon" data-act="up" data-path="${esc(path)}" aria-label="Move ${esc(def.title)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon" data-act="down" data-path="${esc(path)}" aria-label="Move ${esc(def.title)} down" ${i === t.scenarios.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" data-act="dup" data-path="${esc(path)}">Duplicate</button>
            <button type="button" data-act="remove" data-path="${esc(path)}">Remove</button>
          </td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </section>`;
}

function onListClick(e) {
  if (!app.querySelector('.track-admin')) return;
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, path, track } = btn.dataset;
  if (act === 'up' || act === 'down') {
    moveScenario(work, path, act === 'up' ? -1 : 1);
    saveWork();
    renderList();
  } else if (act === 'dup') {
    const def = structuredClone(work.files[path]);
    def.id = uniqueId(`${def.id}-copy`);
    def.title = `${def.title} (copy)`;
    const p = addScenario(work, def);
    saveWork();
    location.hash = editHref(p);
  } else if (act === 'remove') {
    if (!confirm(`Remove "${work.files[path].title}"? Students won't see it after you publish. You can undo this from Publish before then.`)) return;
    removeScenario(work, path);
    saveWork();
    renderList();
  } else if (act === 'new') {
    const t = work.manifest.tracks.find((x) => x.id === track);
    const def = blankScenario(track, uniqueId(`${track}-${String(t.scenarios.length + 1).padStart(2, '0')}-new`));
    const p = addScenario(work, def);
    saveWork();
    location.hash = editHref(p);
  } else if (act === 'dl-track') {
    download(`linux-practice-${track}.json`, JSON.stringify(makeBundle(work, track), null, 2));
  }
}

function uniqueId(base) {
  const ids = new Set(Object.values(work.files).map((d) => d.id));
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  return id;
}

// ---------- editor ----------

let editing = null; // { path, def, tab, preview }

function renderEditor(path) {
  if (!work.files[path]) {
    app.replaceChildren(h(`<section class="admin-page"><p>That scenario isn't in your drafts. <a href="#/">Back to the list</a></p></section>`));
    return;
  }
  editing = { path, tab: editing?.path === path ? editing.tab : 'form', seed: null };
  const def = work.files[path];
  const t = trackOf(path);
  app.replaceChildren(
    h(`
    <section class="admin-page">
      <nav class="crumbs"><a href="#/">Scenarios</a> / ${esc(t.title)} / ${t.scenarios.indexOf(path) + 1}</nav>
      <div class="page-head">
        <div><h1 id="ed-title">${esc(def.title)}</h1><p class="muted mono small">scenarios/${esc(path)}.json ${statusBadge(path)}</p></div>
        <div class="row">
          <button type="button" id="ed-dl">Download JSON</button>
          ${path in published.files ? '<button type="button" id="ed-revert">Revert to live version</button>' : ''}
        </div>
      </div>
      <div class="editor">
        <div class="ed-left">
          <div class="tabs-row" role="tablist">
            <button type="button" role="tab" data-tab="form" aria-selected="${editing.tab === 'form'}">Form</button>
            <button type="button" role="tab" data-tab="json" aria-selected="${editing.tab === 'json'}">JSON</button>
          </div>
          <div id="ed-body"></div>
        </div>
        <div class="ed-right">
          <section class="card" aria-labelledby="val-h"><h2 id="val-h">Validator</h2><div id="val"></div></section>
          <section class="card preview" aria-labelledby="pv-h">
            <div class="track-head"><h2 id="pv-h">Preview</h2>
              <div class="row"><button type="button" id="pv-play">Play as student</button><button type="button" id="pv-sol" class="primary">Run solution</button></div>
            </div>
            <div id="pv"></div>
          </section>
        </div>
      </div>
    </section>`),
  );
  app.querySelector('#ed-dl').addEventListener('click', () => download(`${work.files[path].id}.json`, scenarioText(work.files[path])));
  app.querySelector('#ed-revert')?.addEventListener('click', () => {
    if (!confirm('Throw away your changes to this scenario?')) return;
    work.files[path] = structuredClone(published.files[path]);
    saveWork();
    renderEditor(path);
  });
  for (const tab of app.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => {
      editing.tab = tab.dataset.tab;
      for (const x of app.querySelectorAll('[data-tab]')) x.setAttribute('aria-selected', String(x === tab));
      renderEditorBody();
    });
  }
  app.querySelector('#pv-play').addEventListener('click', () => startPreview());
  app.querySelector('#pv-sol').addEventListener('click', () => runSolution());
  renderEditorBody();
  renderValidation();
  startPreview();
}

const SIMPLE = ['id', 'title', 'tier', 'story'];

function renderEditorBody() {
  const body = app.querySelector('#ed-body');
  const def = work.files[editing.path];
  if (editing.tab === 'json') {
    body.replaceChildren(
      h(`<div class="field"><label for="f-json" class="label">Whole scenario</label>
        <textarea id="f-json" class="code tall" spellcheck="false">${esc(JSON.stringify(def, null, 2))}</textarea>
        <p class="field-err" id="e-json"></p></div>`),
    );
    body.querySelector('#f-json').addEventListener('input', (e) => {
      const err = body.querySelector('#e-json');
      try {
        const next = JSON.parse(e.target.value);
        err.textContent = '';
        update(() => {
          work.files[editing.path] = next;
        });
      } catch (x) {
        err.textContent = `Not valid JSON yet: ${x.message}`;
      }
    });
    return;
  }
  const solutionText = (def.solution ?? []).map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join('\n');
  body.replaceChildren(
    h(`
    <div class="form">
      <div class="grid2">
        <div class="field"><label for="f-id" class="label">ID</label><input type="text" id="f-id" class="mono" value="${esc(def.id)}"></div>
        <div class="field"><label for="f-tier" class="label">Tier</label>
          <select id="f-tier">${[1, 2, 3, 4].map((n) => `<option value="${n}"${Number(def.tier) === n ? ' selected' : ''}>${n} · ${TIERS[n].name}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="f-title" class="label">Title</label><input type="text" id="f-title" value="${esc(def.title)}"></div>
      <div class="field"><label for="f-story" class="label">Story</label><textarea id="f-story" rows="4">${esc(def.story)}</textarea>
        <p class="help">Use {{name}} for variables and \`backticks\` for commands.</p></div>

      <fieldset><legend class="label">Tasks, in order</legend>
        <div id="tasks">${(def.tasks ?? []).map(taskRow).join('')}</div>
        <button type="button" id="add-task">Add task</button>
      </fieldset>

      <fieldset><legend class="label">Hints, vague to specific</legend>
        <div id="hints">${(def.hints ?? []).map(hintRow).join('')}</div>
        <button type="button" id="add-hint">Add hint</button>
        <p class="help">Tier ${esc(def.tier)} shows at most ${TIERS[def.tier]?.maxHints ?? 3}.</p>
      </fieldset>

      <div class="field"><label for="f-solution" class="label">Solution, one step per line</label>
        <textarea id="f-solution" class="code" rows="6" spellcheck="false">${esc(solutionText)}</textarea>
        <p class="help">Lines starting with { are JSON steps, like {"nano": "run.sh", "text": "…"}, {"laptop": "scp …"}, or {"answer": "17"}.</p>
        <p class="field-err" id="e-solution"></p></div>

      <div class="field"><label for="f-vars" class="label">Variables (JSON)</label>
        <textarea id="f-vars" class="code" rows="6" spellcheck="false">${esc(JSON.stringify(def.vars ?? {}, null, 2))}</textarea>
        <p class="field-err" id="e-vars"></p></div>

      <div class="field"><label for="f-machines" class="label">Machines and starting files (JSON)</label>
        <textarea id="f-machines" class="code tall" spellcheck="false">${esc(JSON.stringify(def.machines ?? {}, null, 2))}</textarea>
        <p class="help">See <a href="https://github.com/${esc(settings.repo)}/blob/main/docs/scenarios.md" target="_blank" rel="noopener">the scenario guide</a> for file, check, and job rule formats.</p>
        <p class="field-err" id="e-machines"></p></div>
    </div>`),
  );
  const on = (sel, fn) => body.querySelector(sel).addEventListener('input', fn);
  for (const k of SIMPLE) {
    on(`#f-${k}`, (e) => update((d) => {
      d[k] = k === 'tier' ? Number(e.target.value) : e.target.value;
      if (k === 'title') app.querySelector('#ed-title').textContent = e.target.value;
    }));
  }
  body.querySelector('#f-tier').addEventListener('change', (e) => update((d) => { d.tier = Number(e.target.value); }));
  const jsonField = (sel, errSel, apply) =>
    on(sel, (e) => {
      try {
        const v = JSON.parse(e.target.value || '{}');
        body.querySelector(errSel).textContent = '';
        update((d) => apply(d, v));
      } catch (x) {
        body.querySelector(errSel).textContent = `Not valid JSON yet: ${x.message}`;
      }
    });
  jsonField('#f-vars', '#e-vars', (d, v) => { d.vars = v; });
  jsonField('#f-machines', '#e-machines', (d, v) => { d.machines = v; });
  on('#f-solution', (e) => {
    try {
      const steps = e.target.value.split('\n').filter((l) => l.trim()).map((l) => (l.trim().startsWith('{') ? JSON.parse(l) : l));
      body.querySelector('#e-solution').textContent = '';
      update((d) => { d.solution = steps; });
    } catch (x) {
      body.querySelector('#e-solution').textContent = `A JSON step isn't valid yet: ${x.message}`;
    }
  });
  const tasks = body.querySelector('#tasks');
  tasks.addEventListener('input', () => readTasks(tasks));
  tasks.addEventListener('click', (e) => listButton(e, 'tasks'));
  body.querySelector('#add-task').addEventListener('click', () => {
    update((d) => { (d.tasks ??= []).push({ text: 'New task', check: { cwd: '~' } }); });
    renderEditorBody();
  });
  const hints = body.querySelector('#hints');
  hints.addEventListener('input', () => update((d) => { d.hints = [...hints.querySelectorAll('textarea')].map((x) => x.value); }));
  hints.addEventListener('click', (e) => listButton(e, 'hints'));
  body.querySelector('#add-hint').addEventListener('click', () => {
    update((d) => { (d.hints ??= []).push(''); });
    renderEditorBody();
  });
}

function taskRow(t, i) {
  return `<div class="item" data-i="${i}">
    <div class="item-head"><span class="label">Task ${i + 1}</span>${itemButtons(i)}</div>
    <input type="text" class="t-text" aria-label="Task ${i + 1} text" value="${esc(t.text)}">
    <textarea class="code t-check" rows="3" spellcheck="false" aria-label="Task ${i + 1} check (JSON)">${esc(JSON.stringify(t.check))}</textarea>
    <p class="field-err"></p>
  </div>`;
}

function hintRow(text, i) {
  return `<div class="item" data-i="${i}">
    <div class="item-head"><span class="label">Hint ${i + 1}</span>${itemButtons(i)}</div>
    <textarea rows="2" aria-label="Hint ${i + 1}">${esc(text)}</textarea>
  </div>`;
}

function itemButtons(i) {
  return `<span class="row"><button type="button" class="icon" data-move="-1" data-i="${i}" aria-label="Move up">↑</button><button type="button" class="icon" data-move="1" data-i="${i}" aria-label="Move down">↓</button><button type="button" class="icon" data-del="${i}" aria-label="Delete">×</button></span>`;
}

function readTasks(container) {
  const next = [];
  let ok = true;
  for (const row of container.querySelectorAll('.item')) {
    const err = row.querySelector('.field-err');
    try {
      next.push({ text: row.querySelector('.t-text').value, check: JSON.parse(row.querySelector('.t-check').value) });
      err.textContent = '';
    } catch (x) {
      err.textContent = `Check isn't valid JSON yet: ${x.message}`;
      ok = false;
    }
  }
  if (ok) update((d) => { d.tasks = next; });
}

function listButton(e, key) {
  const b = e.target.closest('button');
  if (!b) return;
  const list = work.files[editing.path][key];
  if (b.dataset.del !== undefined) {
    update(() => list.splice(Number(b.dataset.del), 1));
  } else if (b.dataset.move) {
    const i = Number(b.dataset.i);
    const j = i + Number(b.dataset.move);
    if (j < 0 || j >= list.length) return;
    update(() => { [list[i], list[j]] = [list[j], list[i]]; });
  } else return;
  renderEditorBody();
}

let validateTimer;

// Apply an edit to the scenario being edited, save the draft, re-check soon.
function update(fn) {
  const path = editing.path;
  fn(work.files[path]);
  renumber(work, trackOf(path).id);
  saveWork();
  const badge = app.querySelector(`[data-badge="${CSS.escape(path)}"]`);
  if (badge) badge.outerHTML = statusBadge(path);
  clearTimeout(validateTimer);
  validateTimer = setTimeout(renderValidation, 500);
}

function renderValidation() {
  const box = app.querySelector('#val');
  if (!box || !editing) return;
  const r = check(editing.path, 20);
  box.innerHTML = r.errors.length
    ? `<p class="bad-text"><strong>${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}.</strong> This scenario can't be published until ${r.errors.length === 1 ? 'it is' : 'they are'} fixed.</p><ul class="issues">${r.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : `<p class="good-text"><strong>Ready.</strong> The solution finishes the scenario for 20 random draws.</p>`;
  if (r.warnings.length) box.innerHTML += `<ul class="issues warn">${r.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

// ---------- preview ----------

let preview = null; // { session, terms, busy }

function startPreview(seed = (Math.random() * 2 ** 32) >>> 0) {
  const box = app.querySelector('#pv');
  let session;
  try {
    session = new Session(structuredClone(work.files[editing.path]), { seed });
  } catch (e) {
    box.innerHTML = `<p class="bad-text">Can't start the scenario: ${esc(e.message)}</p>`;
    return;
  }
  const laptop = !!session.laptop;
  box.replaceChildren(
    h(`
    <div class="pv-panel">
      <p class="story small">${fmt(session.def.story)}</p>
      ${lessonHTML(session.def.lesson, { open: false })}
      <ol class="tasks" id="pv-tasks"></ol>
      <div class="coach small" id="pv-coach">Type here as a student would, or press Run solution.</div>
    </div>
    <div class="term pv-term">
      <div class="term-bar">${laptop ? '<div class="tabs" role="tablist"><button type="button" role="tab" data-m="cluster" aria-selected="true">Geiss-01</button><button type="button" role="tab" data-m="laptop" aria-selected="false">Laptop</button></div>' : '<span>student@geiss-01</span>'}<span>seed ${seed}</span></div>
      ${screen('cluster')}${laptop ? screen('laptop', true) : ''}
    </div>`),
  );
  const opts = {
    session,
    afterRun: (r) => {
      renderPreviewTasks();
      const tip = r.coach?.at(-1);
      if (tip) coach(fmt(tip.text));
      else if (r.complete) coach('<strong>Complete.</strong>');
    },
  };
  const terms = { cluster: new Terminal(box.querySelector('#pv-cluster'), { ...opts, machine: 'cluster' }) };
  if (laptop) {
    terms.laptop = new Terminal(box.querySelector('#pv-laptop'), { ...opts, machine: 'laptop' });
    for (const tab of box.querySelectorAll('[role=tab]')) tab.addEventListener('click', () => showMachine(tab.dataset.m));
  }
  preview = { session, terms, busy: false };
  renderPreviewTasks();
}

function screen(machine, hidden = false) {
  return `<div class="screen" id="pv-${machine}"${hidden ? ' hidden' : ''}><div class="log"></div><div class="inrow"><span class="prompt"></span><input class="cmd" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Preview ${machine} terminal"></div></div>`;
}

function showMachine(m) {
  const box = app.querySelector('#pv');
  for (const t of box.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t.dataset.m === m));
  for (const [k, t] of Object.entries(preview.terms)) t.screen.hidden = k !== m;
}

function coach(html) {
  const el = app.querySelector('#pv-coach');
  if (el) el.innerHTML = html;
}

function renderPreviewTasks() {
  const el = app.querySelector('#pv-tasks');
  if (!el) return;
  const s = preview.session;
  el.innerHTML = s.tasks
    .map((t, i) => `<li class="${t.done ? 'done' : i === s.current ? 'current' : ''}"><span class="box">${t.done ? '✓' : ''}</span><span>${fmt(t.text)}${
      i === s.current && s.wantsAnswer ? '<form class="answer-form" id="pv-answer" autocomplete="off"><input placeholder="Type your answer" aria-label="Preview answer" spellcheck="false"><button type="submit">Check</button></form>' : ''
    }</span></li>`)
    .join('');
  el.querySelector('#pv-answer')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = e.target.querySelector('input').value;
    previewAnswer(value);
  });
}

function previewAnswer(value) {
  const r = preview.session.submitAnswer(value);
  renderPreviewTasks();
  coach(r.correct ? (r.complete ? '<strong>Complete.</strong>' : `Answer <strong>${esc(value)}</strong> accepted.`) : `<strong>${esc(value)}</strong> isn't the expected answer.`);
}

async function runSolution() {
  if (preview?.busy) return;
  startPreview();
  preview.busy = true;
  const { session, terms } = preview;
  for (const step of session.def.solution ?? []) {
    await new Promise((r) => setTimeout(r, 350));
    if (!app.querySelector('#pv')) return; // left the page
    if (typeof step === 'object' && 'answer' in step) {
      previewAnswer(String(step.answer));
    } else if (typeof step === 'string' || step.laptop) {
      const m = typeof step === 'string' ? 'cluster' : 'laptop';
      if (terms[m]) showMachine(m);
      (terms[m] ?? terms.cluster).run(typeof step === 'string' ? step : step.laptop);
    } else if (step.nano) {
      const t = terms.cluster;
      t.echo(`nano ${step.nano}`);
      const r = session.run(`nano ${step.nano}`);
      if (r.edit) {
        const res = session.save(r.edit.path, step.text);
        t.write([{ text: `(saved ${step.text.split('\n').length - 1} lines in nano)\n`, cls: 'dim' }]);
        t.afterRun({ ...res, coach: [] }, false);
      } else t.write(r.output);
      t.renderPrompt();
      t.scroll();
    }
  }
  preview.busy = false;
  coach(session.complete ? '<strong>Complete.</strong> The solution finished every task with this draw.' : '<strong>Not complete.</strong> The solution stopped before the last task. See the validator.');
}

// ---------- import and export ----------

let pendingImport = null;

function renderImport() {
  app.replaceChildren(
    h(`
    <section class="admin-page">
      <div class="page-head"><div><h1>Import &amp; export</h1><p class="muted">Share scenarios with TAs, keep backups, or move work between computers.</p></div></div>
      <section class="card">
        <h2>Download</h2>
        <div class="row">
          <button type="button" id="dl-all" class="primary">Everything (bundle)</button>
          <button type="button" id="dl-zip">Everything as files (.zip)</button>
        </div>
        <p class="muted small">A bundle is one JSON file you can import here. The .zip has the same folder layout as the repo. To download one track or one scenario, use the buttons on the Scenarios page or in the editor.</p>
      </section>
      <section class="card">
        <h2>Upload</h2>
        <label class="drop" id="drop">
          <input type="file" id="file" accept=".json,application/json" multiple>
          <span><strong>Choose files</strong> or drop them here: a bundle, a track, or single scenario JSON files.</span>
        </label>
        <div id="imp"></div>
      </section>
    </section>`),
  );
  app.querySelector('#dl-all').addEventListener('click', () => download('linux-practice-bundle.json', JSON.stringify(makeBundle(work), null, 2)));
  app.querySelector('#dl-zip').addEventListener('click', () => download('linux-practice-scenarios.zip', makeZip(allFiles(work)), 'application/zip'));
  const input = app.querySelector('#file');
  input.addEventListener('change', () => readImports(input.files));
  const drop = app.querySelector('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    readImports(e.dataTransfer.files);
  });
}

function allFiles(copy, only = null) {
  const out = [{ path: 'scenarios/tracks.json', text: JSON.stringify(copy.manifest, null, 2) + '\n' }];
  for (const [p, def] of Object.entries(copy.files)) if (!only || only.includes(p)) out.push({ path: `scenarios/${p}.json`, text: scenarioText(def) });
  return out;
}

async function readImports(fileList) {
  let next = cloneCopy(work);
  const summary = { added: [], changed: [], removed: [], errors: [] };
  for (const f of fileList) {
    try {
      const r = mergeImport(next, JSON.parse(await f.text()));
      next = r.next;
      for (const k of Object.keys(summary)) summary[k].push(...r[k].map((x) => (k === 'errors' ? `${f.name}: ${x}` : x)));
    } catch (e) {
      summary.errors.push(`${f.name}: not valid JSON (${e.message})`);
    }
  }
  pendingImport = next;
  const list = (label, items) => (items.length ? `<h3>${label} (${items.length})</h3><ul class="issues plain">${items.map((p) => `<li class="mono small">${esc(p)}</li>`).join('')}</ul>` : '');
  const nothing = !summary.added.length && !summary.changed.length && !summary.removed.length;
  app.querySelector('#imp').innerHTML = `
    ${summary.errors.length ? `<ul class="issues">${summary.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${list('New', summary.added)}${list('Changed', summary.changed)}${list('Removed', summary.removed)}
    ${nothing ? '<p class="muted">Nothing new in these files.</p>' : '<div class="row"><button type="button" id="imp-apply" class="primary">Add to my drafts</button><button type="button" id="imp-cancel">Cancel</button></div><p class="muted small">Nothing reaches students until you publish.</p>'}`;
  app.querySelector('#imp-apply')?.addEventListener('click', () => {
    work = pendingImport;
    pendingImport = null;
    saveWork();
    flash('Imported into your drafts.');
    location.hash = '#/';
  });
  app.querySelector('#imp-cancel')?.addEventListener('click', () => {
    pendingImport = null;
    app.querySelector('#imp').innerHTML = '';
  });
}

// ---------- GitHub ----------

function token() {
  return load(TOKEN_KEY) ?? '';
}

async function gh(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (auth && token()) headers.Authorization = `Bearer ${token()}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg += ` ${(await res.json()).message}`;
    } catch {
      // keep the status code
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function explainGitHubError(e) {
  if (e.status === 401) return 'GitHub didn\'t accept the token. It may have expired; make a new one.';
  if (e.status === 403 || e.status === 404) return `GitHub refused (${esc(e.message)}). Check that the token has access to ${esc(settings.repo)} with Contents: Read and write.`;
  if (e.status === 409 || e.status === 422) return `GitHub refused the update (${esc(e.message)}). The branch may be protected or changed while publishing. Reload and try again.`;
  return `Couldn't reach GitHub: ${esc(e.message)}`;
}

// ---------- publish ----------

function renderPublish() {
  const d = changes();
  const items = [
    ...d.added.map((p) => ({ p, kind: 'New' })),
    ...d.changed.map((p) => ({ p, kind: 'Changed' })),
    ...d.removed.map((p) => ({ p, kind: 'Removed' })),
  ];
  const results = items.filter((x) => x.kind !== 'Removed').map((x) => ({ ...x, r: check(x.p, 20) }));
  const broken = results.filter((x) => x.r.errors.length);
  const tk = token();
  app.replaceChildren(
    h(`
    <section class="admin-page">
      <div class="page-head"><div><h1>Publish</h1><p class="muted">${localMode ? 'Publishing saves your drafts into the scenarios folder on this computer. Reload the practice site to see them.' : 'Publishing commits your drafts to GitHub. The site updates in about two minutes, after the tests pass.'}</p></div></div>
      <section class="card">
        <h2>Your changes</h2>
        ${
          d.count
            ? `<table class="scen-table"><tbody>
              ${items
                .map((x) => {
                  const r = results.find((y) => y.p === x.p)?.r;
                  const def = work.files[x.p] ?? published.files[x.p];
                  return `<tr><td><span class="badge ${x.kind === 'Removed' ? 'bad' : x.kind === 'New' ? 'new' : 'changed'}">${x.kind}</span></td>
                    <td>${x.kind === 'Removed' ? esc(def.title) : `<a href="${editHref(esc(x.p))}">${esc(def.title)}</a>`}<div class="muted small mono">${esc(x.p)}</div></td>
                    <td>${r ? (r.errors.length ? `<span class="bad-text">${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}</span>` : '<span class="good-text">Ready</span>') : ''}</td>
                    <td class="acts"><button type="button" data-undo="${esc(x.p)}">Undo</button></td></tr>`;
                })
                .join('')}
              ${d.manifestChanged ? `<tr><td><span class="badge changed">Changed</span></td><td>Track order, titles, or the passphrase salt<div class="muted small mono">tracks.json</div></td><td></td><td class="acts"><button type="button" data-undo="__manifest">Undo</button></td></tr>` : ''}
              </tbody></table>`
            : '<p class="muted">No changes. Edit a scenario or import some, and they\'ll show up here.</p>'
        }
        ${broken.length ? `<p class="bad-text">Fix the scenarios with problems before publishing. Open one to see what the validator found.</p>` : ''}
      </section>

      ${localMode ? localPublishCard(d, broken) : `<section class="card">
        <h2>Publish to GitHub</h2>
        <div class="grid2">
          <div class="field"><label for="p-repo" class="label">Repository</label><input type="text" id="p-repo" class="mono" value="${esc(settings.repo)}"></div>
          <div class="field"><label for="p-branch" class="label">Branch</label><input type="text" id="p-branch" class="mono" value="${esc(settings.branch)}"></div>
        </div>
        ${
          tk
            ? `<p class="muted">A GitHub token is saved in this browser. <button type="button" id="p-forget">Forget token</button></p>`
            : `<details class="howto"><summary>Set up publishing (once per computer)</summary>
              <ol>
                <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Fine-grained token</a>.</li>
                <li>Repository access: <strong>Only select repositories</strong> → ${esc(settings.repo.split('/')[1] ?? 'linux-practice')}.</li>
                <li>Permissions → Repository permissions → <strong>Contents: Read and write</strong>. Nothing else.</li>
                <li>Generate, copy the token, and paste it below. It stays in this browser and is never added to the repo.</li>
              </ol></details>
              <div class="field"><label for="p-token" class="label">GitHub token</label><div class="row"><input type="password" id="p-token" class="mono" autocomplete="off" placeholder="github_pat_…"><button type="button" id="p-save-token">Save</button></div></div>`
        }
        <div class="field"><label for="p-note" class="label">What changed (for the history)</label><input type="text" id="p-note" placeholder="e.g. Easier hints in Find files 3"></div>
        <div class="row"><button type="button" id="p-go" class="primary" ${!d.count || broken.length || !tk ? 'disabled' : ''}>Publish ${d.count} change${d.count === 1 ? '' : 's'}</button><span class="muted small" id="p-why">${!tk && d.count ? 'Save a token first.' : ''}</span></div>
        <ol class="log-lines" id="p-log"></ol>
      </section>

      <section class="card">
        <h2>No token?</h2>
        <p class="muted">Download your changed files, unzip them, and drag the <code>scenarios</code> folder onto the repo's <a href="https://github.com/${esc(settings.repo)}/upload/${esc(settings.branch)}" target="_blank" rel="noopener">Upload files</a> page. Removed scenarios still need deleting on GitHub by hand.</p>
        <button type="button" id="p-zip" ${d.count ? '' : 'disabled'}>Download changes (.zip)</button>
      </section>

      <section class="card"><h2>Live site</h2><div id="p-live" class="muted">Checking…</div></section>`}
    </section>`),
  );
  if (localMode) {
    for (const b of app.querySelectorAll('[data-undo]')) b.addEventListener('click', () => undoChange(b.dataset.undo));
    app.querySelector('#p-go').addEventListener('click', () => saveLocal());
    return;
  }
  app.querySelector('#p-repo').addEventListener('change', (e) => { settings.repo = e.target.value.trim(); saveWork(); });
  app.querySelector('#p-branch').addEventListener('change', (e) => { settings.branch = e.target.value.trim() || 'main'; saveWork(); });
  app.querySelector('#p-forget')?.addEventListener('click', () => { store(TOKEN_KEY, null); renderPublish(); });
  app.querySelector('#p-save-token')?.addEventListener('click', () => {
    const v = app.querySelector('#p-token').value.trim();
    if (!v) return;
    store(TOKEN_KEY, v);
    renderPublish();
  });
  app.querySelector('#p-zip').addEventListener('click', () => {
    const files = allFiles(work, [...d.added, ...d.changed]);
    download('linux-practice-changes.zip', makeZip(files), 'application/zip');
  });
  for (const b of app.querySelectorAll('[data-undo]')) {
    b.addEventListener('click', () => undoChange(b.dataset.undo));
  }
  app.querySelector('#p-go').addEventListener('click', () => publish(app.querySelector('#p-note').value.trim()));
  showLive();
}

function undoChange(path) {
  if (path === '__manifest') {
    const lists = Object.fromEntries(work.manifest.tracks.map((t) => [t.id, t.scenarios]));
    work.manifest = structuredClone(published.manifest);
    // Keep scenario lists that include drafts; only titles and salt revert.
    for (const t of work.manifest.tracks) t.scenarios = lists[t.id] ?? t.scenarios;
  } else if (path in published.files) {
    work.files[path] = structuredClone(published.files[path]);
    for (const t of work.manifest.tracks) {
      const was = published.manifest.tracks.find((x) => x.id === t.id);
      if (was.scenarios.includes(path) && !t.scenarios.includes(path)) {
        t.scenarios.splice(Math.min(was.scenarios.indexOf(path), t.scenarios.length), 0, path);
        renumber(work, t.id);
      }
    }
  } else {
    removeScenario(work, path);
  }
  saveWork();
  renderPublish();
}

async function showLive() {
  const el = app.querySelector('#p-live');
  try {
    const [o, r] = settings.repo.split('/');
    const commits = await gh(`/repos/${o}/${r}/commits?path=scenarios&sha=${encodeURIComponent(settings.branch)}&per_page=1`);
    const c = commits[0];
    el.innerHTML = `This page loaded version <strong>${esc(published.manifest.version)}</strong> of the scenarios. Last scenario change on GitHub: ${c ? `${esc(new Date(c.commit.author.date).toLocaleString())}, “${esc(c.commit.message.split('\n')[0])}”` : 'none yet'}. <a href="https://github.com/${esc(settings.repo)}/actions" target="_blank" rel="noopener">Deploy status</a>`;
  } catch (e) {
    el.textContent = `This page loaded version ${published.manifest.version}. Couldn't reach GitHub for more (${e.message}).`;
  }
}

async function publish(note) {
  const d = changes();
  const log = app.querySelector('#p-log');
  const go = app.querySelector('#p-go');
  const say = (text, cls = '') => log.insertAdjacentHTML('beforeend', `<li class="${cls}">${text}</li>`);
  go.disabled = true;
  log.innerHTML = '';
  const [o, r] = settings.repo.split('/');
  const base = `/repos/${o}/${r}`;
  try {
    say('Reading the current version on GitHub…');
    const ref = await gh(`${base}/git/ref/heads/${encodeURIComponent(settings.branch)}`);
    const head = ref.object.sha;
    const headCommit = await gh(`${base}/git/commits/${head}`);

    // Refuse to overwrite edits someone else published after this page loaded.
    const touched = [...d.changed, ...d.removed].map((p) => `scenarios/${p}.json`);
    const conflicts = [];
    for (const path of ['scenarios/tracks.json', ...touched]) {
      try {
        const file = await gh(`${base}/contents/${path}?ref=${head}`);
        const remote = JSON.parse(decodeBase64(file.content));
        const mine = path === 'scenarios/tracks.json' ? published.manifest : published.files[path.slice(10, -5)];
        if (JSON.stringify(remote) !== JSON.stringify(mine)) conflicts.push(path);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    if (conflicts.length) {
      say(`Someone published changes to ${conflicts.map(esc).join(', ')} after you opened this page. Reload the dashboard to get them (your drafts stay), check your edits, and publish again.`, 'bad-text');
      go.disabled = false;
      return;
    }

    const manifest = structuredClone(work.manifest);
    manifest.version = (Number(published.manifest.version) || 0) + 1;
    const tree = [
      { path: 'scenarios/tracks.json', mode: '100644', type: 'blob', content: JSON.stringify(manifest, null, 2) + '\n' },
      ...[...d.added, ...d.changed].map((p) => ({ path: `scenarios/${p}.json`, mode: '100644', type: 'blob', content: scenarioText(work.files[p]) })),
      ...d.removed.map((p) => ({ path: `scenarios/${p}.json`, mode: '100644', type: 'blob', sha: null })),
    ];
    say(`Uploading ${tree.length} file${tree.length === 1 ? '' : 's'}…`);
    const newTree = await gh(`${base}/git/trees`, { method: 'POST', body: { base_tree: headCommit.tree.sha, tree } });
    const summary = [d.added.length && `${d.added.length} new`, d.changed.length && `${d.changed.length} changed`, d.removed.length && `${d.removed.length} removed`].filter(Boolean).join(', ');
    const message = `${note || 'Update scenarios'}\n\n${summary || 'Track settings'} (scenario version ${manifest.version}). Published from the instructor dashboard.`;
    const commit = await gh(`${base}/git/commits`, { method: 'POST', body: { message, tree: newTree.sha, parents: [head] } });
    await gh(`${base}/git/refs/heads/${encodeURIComponent(settings.branch)}`, { method: 'PATCH', body: { sha: commit.sha } });

    work.manifest = manifest;
    published = cloneCopy(work);
    settings.baseVersion = manifest.version;
    saveWork();
    say(`Published as <a href="https://github.com/${esc(settings.repo)}/commit/${commit.sha}" target="_blank" rel="noopener">${commit.sha.slice(0, 7)}</a>. Students see it in about two minutes, once the <a href="https://github.com/${esc(settings.repo)}/actions" target="_blank" rel="noopener">tests and deploy</a> finish.`, 'good-text');
    setTimeout(renderPublishKeepLog(log.innerHTML), 0);
  } catch (e) {
    say(explainGitHubError(e), 'bad-text');
    go.disabled = false;
  }
}

function localPublishCard(d, broken) {
  return `<section class="card">
        <h2>Save to this computer</h2>
        <p class="muted">This dashboard is running from the local server, so nothing goes to GitHub. Saved files land in <code>scenarios/</code> in this copy of the repo.</p>
        <div class="row"><button type="button" id="p-go" class="primary" ${!d.count || broken.length ? 'disabled' : ''}>Save ${d.count} change${d.count === 1 ? '' : 's'}</button></div>
        <ol class="log-lines" id="p-log"></ol>
      </section>`;
}

async function saveLocal() {
  const d = changes();
  const log = app.querySelector('#p-log');
  const go = app.querySelector('#p-go');
  const say = (text, cls = '') => log.insertAdjacentHTML('beforeend', `<li class="${cls}">${text}</li>`);
  go.disabled = true;
  log.innerHTML = '';
  try {
    // Refuse to overwrite files changed on disk (by hand, or in another tab) after this page loaded.
    const disk = await fetchCopy();
    const conflicts = [
      ...(JSON.stringify(disk.manifest) !== JSON.stringify(published.manifest) ? ['tracks.json'] : []),
      ...[...d.changed, ...d.removed].filter((p) => p in disk.files && JSON.stringify(disk.files[p]) !== JSON.stringify(published.files[p])).map((p) => `${p}.json`),
    ];
    if (conflicts.length) {
      say(`${conflicts.map(esc).join(', ')} changed on disk after you opened this page. Reload the dashboard to get the new version (your drafts stay), check your edits, and save again.`, 'bad-text');
      go.disabled = false;
      return;
    }
    const manifest = structuredClone(work.manifest);
    manifest.version = (Number(published.manifest.version) || 0) + 1;
    const write = { 'scenarios/tracks.json': JSON.stringify(manifest, null, 2) + '\n' };
    for (const p of [...d.added, ...d.changed]) write[`scenarios/${p}.json`] = scenarioText(work.files[p]);
    const res = await fetch('__local/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ write, remove: d.removed.map((p) => `scenarios/${p}.json`) }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? res.status);
    work.manifest = manifest;
    published = cloneCopy(work);
    settings.baseVersion = manifest.version;
    saveWork();
    say(`Saved ${out.saved} file${out.saved === 1 ? '' : 's'} (scenario version ${manifest.version}). Reload the <a href="./" target="_blank">practice site</a> to see the changes.`, 'good-text');
    setTimeout(renderPublishKeepLog(log.innerHTML), 0);
  } catch (e) {
    say(`Couldn't save: ${esc(e.message)}. Is the local server still running?`, 'bad-text');
    go.disabled = false;
  }
}

function renderPublishKeepLog(html) {
  return () => {
    renderPublish();
    app.querySelector('#p-log').innerHTML = html;
  };
}

// ---------- history ----------

async function renderHistory() {
  app.replaceChildren(
    h(`
    <section class="admin-page">
      <div class="page-head"><div><h1>History</h1><p class="muted">Every publish is a commit on GitHub. Load an older version into your drafts to roll back, then publish it.</p></div></div>
      <section class="card"><div id="hist" class="muted">Loading from GitHub…</div></section>
    </section>`),
  );
  const box = app.querySelector('#hist');
  const [o, r] = settings.repo.split('/');
  try {
    const commits = await gh(`/repos/${o}/${r}/commits?path=scenarios&sha=${encodeURIComponent(settings.branch)}&per_page=25`);
    box.classList.remove('muted');
    box.innerHTML = commits.length
      ? `<table class="scen-table"><tbody>${commits
          .map(
            (c) => `<tr><td class="mono small"><a href="${esc(c.html_url)}" target="_blank" rel="noopener">${c.sha.slice(0, 7)}</a></td>
              <td>${esc(c.commit.message.split('\n')[0])}<div class="muted small">${esc(c.commit.author.name)} · ${esc(new Date(c.commit.author.date).toLocaleString())}</div></td>
              <td class="acts"><button type="button" data-sha="${c.sha}">Load as drafts</button></td></tr>`,
          )
          .join('')}</tbody></table>`
      : '<p class="muted">No scenario commits yet.</p>';
    for (const b of box.querySelectorAll('[data-sha]')) {
      b.addEventListener('click', async () => {
        if (changes().count && !confirm('This replaces your current drafts. Continue?')) return;
        b.disabled = true;
        b.textContent = 'Loading…';
        try {
          const old = await fetchCopy(`https://raw.githubusercontent.com/${o}/${r}/${b.dataset.sha}/scenarios/`, {});
          old.manifest.version = published.manifest.version;
          work = old;
          saveWork();
          flash('Loaded. Review it, then publish to roll the site back.');
          location.hash = '#/publish';
        } catch (e) {
          flash(`Couldn't load that version: ${esc(e.message)}`, 'bad');
          b.disabled = false;
          b.textContent = 'Load as drafts';
        }
      });
    }
  } catch (e) {
    box.innerHTML = `<p class="bad-text">${explainGitHubError(e)}</p>`;
  }
}

// ---------- class progress ----------

let grading = null; // { header, rows, cols, salt }

function renderProgress() {
  const ids = trackIds();
  app.replaceChildren(
    h(`
    <section class="admin-page">
      <div class="page-head"><div><h1>Class progress</h1><p class="muted">Check the passphrases students submitted in Canvas. Files you load here never leave this browser.</p></div></div>
      <section class="card">
        <h2>Load submissions</h2>
        <details class="howto"><summary>Getting a CSV from Canvas</summary>
          <ol>
            <li>Collect passphrases with a Canvas quiz that has one essay or fill-in question, "Paste your Linux Practice passphrase". Students can retake it as they earn words.</li>
            <li>After the deadline: Quiz → <strong>Quiz Statistics</strong> → <strong>Student Analysis</strong>, and download the CSV. (In New Quizzes: Build → Reports → Student Analysis.)</li>
            <li>Load that file here. It has each student's SIS ID, which should be the CSU ID they typed on the site.</li>
          </ol>
          <p class="muted small">Any CSV with an ID column and a passphrase column works. You can also paste lines like <code>830123456, helix-ribbon-zinc</code>.</p>
        </details>
        <div class="row"><input type="file" id="g-file" accept=".csv,text/csv"><span class="muted">or</span></div>
        <textarea id="g-paste" rows="4" placeholder="ID, passphrase (one student per line)" aria-label="Paste IDs and passphrases"></textarea>
        <div class="grid2">
          <div class="field"><label for="g-salt" class="label">Salt</label><input type="text" id="g-salt" class="mono" value="${esc(work.manifest.passphraseSalt)}"><p class="help">The current one, unless you're checking an older semester.</p></div>
          <div class="field" id="g-cols"></div>
        </div>
        <button type="button" id="g-run" class="primary">Check passphrases</button>
      </section>
      <section class="card" id="g-out" hidden></section>
      <section class="card">
        <h2>Look up one student</h2>
        <p class="muted">Shows the word each track gives this ID, for answering "what was my word?"</p>
        <div class="row"><input type="text" id="l-id" placeholder="CSU ID" aria-label="CSU ID"><button type="button" id="l-go">Show words</button></div>
        <div id="l-out"></div>
      </section>
    </section>`),
  );
  const loadRows = (text) => {
    const all = parseCSV(text);
    const looksHeaderless = all[0] && all[0].length >= 2 && /^\s*[\w.-]+\s*$/.test(all[0][0]) && !/[a-z]{3,}.*id|name|sis/i.test(all[0].join(' ')) && /[a-z]+[-\s][a-z]+/i.test(all[0][1] ?? '');
    const header = looksHeaderless ? all[0].map((_, i) => (i === 0 ? 'ID' : i === 1 ? 'Passphrase' : `Column ${i + 1}`)) : all[0] ?? [];
    const rows = looksHeaderless ? all : all.slice(1);
    const cols = detectColumns(header, rows);
    if (looksHeaderless) Object.assign(cols, { id: 0, phrase: 1, name: -1 });
    grading = { header, rows, cols };
    renderColumnPickers();
  };
  app.querySelector('#g-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) loadRows(await f.text());
  });
  app.querySelector('#g-paste').addEventListener('input', (e) => loadRows(e.target.value));
  app.querySelector('#g-run').addEventListener('click', () => {
    if (!grading?.rows.length) return flash('Load a CSV or paste some lines first.', 'bad');
    const salt = app.querySelector('#g-salt').value.trim();
    for (const k of ['id', 'name', 'phrase']) {
      const sel = app.querySelector(`#c-${k}`);
      if (sel) grading.cols[k] = Number(sel.value);
    }
    if (grading.cols.id < 0 || grading.cols.phrase < 0) return flash('Pick the ID and passphrase columns.', 'bad');
    showGrades(gradeRows(grading.rows, grading.cols, ids, salt), ids);
  });
  app.querySelector('#l-go').addEventListener('click', () => {
    const id = app.querySelector('#l-id').value.trim();
    if (!id) return;
    const words = wordsFor(id, ids, app.querySelector('#g-salt').value.trim());
    app.querySelector('#l-out').innerHTML = `<table class="scen-table"><tbody>${work.manifest.tracks.map((t) => `<tr><td>${esc(t.title)}</td><td class="mono">${esc(words[t.id])}</td></tr>`).join('')}</tbody></table>`;
  });
}

function renderColumnPickers() {
  const box = app.querySelector('#g-cols');
  const { header, cols, rows } = grading;
  const pick = (k, label, allowNone) => `<label class="label" for="c-${k}">${label}</label><select id="c-${k}">${allowNone ? '<option value="-1">(none)</option>' : ''}${header.map((hd, i) => `<option value="${i}"${cols[k] === i ? ' selected' : ''}>${esc(hd || `Column ${i + 1}`)}</option>`).join('')}</select>`;
  box.innerHTML = `<div class="pickers">${pick('id', 'ID column', false)}${pick('name', 'Name column', true)}${pick('phrase', 'Passphrase column', false)}</div><p class="help">${rows.length} row${rows.length === 1 ? '' : 's'} loaded.</p>`;
}

function showGrades(results, ids) {
  const out = app.querySelector('#g-out');
  out.hidden = false;
  const titles = Object.fromEntries(work.manifest.tracks.map((t) => [t.id, t.title]));
  const perTrack = ids.map((t) => results.filter((r) => r.tracks.includes(t)).length);
  out.innerHTML = `
    <div class="track-head"><h2>Results</h2><button type="button" id="g-csv" class="primary">Download CSV for the gradebook</button></div>
    <p class="muted">${results.length} students. All ${ids.length} tracks: ${results.filter((r) => r.tracks.length === ids.length).length}. Notes: ${results.filter((r) => r.note).length}.</p>
    <div class="table-scroll"><table class="scen-table grades">
      <thead><tr><th scope="col">Student</th>${ids.map((t) => `<th scope="col" title="${esc(titles[t])}">${esc(t)}</th>`).join('')}<th scope="col">Total</th><th scope="col">Note</th></tr></thead>
      <tbody>${results
        .map(
          (r) => `<tr><td>${esc(r.name || r.id)}${r.name ? `<div class="muted small mono">${esc(r.id)}</div>` : ''}</td>
          ${ids.map((t) => `<td class="mark">${r.tracks.includes(t) ? '<span class="good-text" aria-label="earned">✓</span>' : '<span class="muted" aria-label="not earned">·</span>'}</td>`).join('')}
          <td class="num">${r.tracks.length}</td><td class="small ${r.note ? 'warn-text' : ''}">${esc(r.note)}</td></tr>`,
        )
        .join('')}</tbody>
      <tfoot><tr><td class="muted">Earned</td>${perTrack.map((n) => `<td class="num">${n}</td>`).join('')}<td></td><td></td></tr></tfoot>
    </table></div>`;
  out.querySelector('#g-csv').addEventListener('click', () => download('linux-practice-progress.csv', gradesCSV(results, ids), 'text/csv'));
}

// ---------- routing ----------

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = hash.split('/');
  renderNav();
  if (kind === 'edit') renderEditor(decodeURIComponent(rest.join('/')));
  else if (kind === 'import') renderImport();
  else if (kind === 'publish') renderPublish();
  else if (kind === 'history') renderHistory();
  else if (kind === 'progress') renderProgress();
  else renderList();
  if (kind !== 'edit') editing = null;
  window.scrollTo(0, 0);
}

loadData()
  .then(() => {
    window.addEventListener('hashchange', route);
    app.addEventListener('click', onListClick);
    route();
  })
  .catch((e) => {
    app.replaceChildren(h(`<p class="loading">Couldn't load the scenarios (${esc(e.message)}). Try reloading the page.</p>`));
  });
