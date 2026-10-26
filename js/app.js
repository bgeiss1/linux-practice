// Student site: track list, each track's ladder of lessons and practice
// scenarios, the lesson pages, and the practice terminal.

import { Session, TIERS } from '../engine/scenario.js';
import { Terminal, esc, fmt, h, lessonHTML } from './terminal.js';
import { guideHTML } from './guide.js';
import { makePassphrase } from '../engine/passphrase.js';
import { ladder, tryDef, trackOpen } from '../engine/tutorial.js';
import { lessonPageHTML, wireLesson } from './lesson.js';

const app = document.getElementById('app');
const STORE_KEY = 'linux-practice:v1';

// ---------- progress (this browser only) ----------

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && typeof saved === 'object') return { done: {}, phrases: {}, lessons: {}, ...saved };
  } catch {
    // Private windows and blocked storage land here; start fresh.
  }
  return { done: {}, phrases: {}, lessons: {} };
}

const progress = loadProgress();

function saveProgress() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(progress));
  } catch {
    // Nothing to do: progress just won't survive a reload.
  }
}

// ---------- data ----------

let manifest;
const scenarios = new Map(); // id -> def

async function loadData() {
  const res = await fetch('scenarios/tracks.json', { cache: 'no-cache' });
  manifest = await res.json();
  const v = encodeURIComponent(manifest.version ?? '');
  await Promise.all(
    manifest.tracks.flatMap((t) =>
      t.scenarios.map(async (path) => {
        const def = await (await fetch(`scenarios/${path}.json?v=${v}`, { cache: 'no-cache' })).json();
        scenarios.set(def.id, def);
        (t.defs ??= []).push(def);
      }),
    ),
  );
  for (const t of manifest.tracks) (t.defs ??= []).sort((a, b) => a.order - b.order);
  // Tutorials are optional: a track without one is just its scenarios.
  await Promise.all(
    manifest.tracks.map(async (t) => {
      try {
        const res = await fetch(`tutorials/${t.id}.json?v=${v}`, { cache: 'no-cache' });
        if (res.ok) t.tutorial = await res.json();
      } catch {
        // No tutorial for this track.
      }
    }),
  );
}

// ?preview on the address shows every track, open or not, for instructors.
const preview = new URLSearchParams(location.search).has('preview');
const isOpen = (t) => preview || trackOpen(t);
const lessonsRequired = () => manifest.lessonsRequired !== false;

const lessonKey = (t, lesson) => `${t.id}/${lesson.id}`;
const lessonDone = (t, lesson) => !!progress.lessons[lessonKey(t, lesson)];
const steps = (t) => ladder(t.defs, t.tutorial);
const stepDone = (t, s) => (s.kind === 'lesson' ? lessonDone(t, s.lesson) : isDone(s.def.id));
const stepHref = (t, s) => (s.kind === 'lesson' ? `#/learn/${esc(t.id)}/${esc(s.lesson.id)}` : `#/s/${esc(s.def.id)}`);
const stepTitle = (s) => (s.kind === 'lesson' ? `Lesson: ${s.lesson.title}` : s.def.title);

// A step opens once every step before it is done. Lessons only hold up the
// practice after them when the instructor requires them.
function stepOpen(t, i) {
  const all = steps(t);
  return all.slice(0, i).every((s) => stepDone(t, s) || (s.kind === 'lesson' && !lessonsRequired()));
}

// The first step in a track that isn't done yet.
function nextStep(t) {
  const all = steps(t);
  const i = all.findIndex((s) => !stepDone(t, s));
  return i < 0 ? null : { step: all[i], i };
}

const isDone = (id) => !!progress.done[id];
const trackDone = (t) => t.defs.length > 0 && t.defs.every((d) => isDone(d.id));
const finishedTracks = () => manifest.tracks.filter(trackDone).map((t) => t.id);

// A finished track's passphrase. It's made once and kept, so the student sees
// the same one every time; a new keyword (next semester) gets a new passphrase.
function phraseFor(t) {
  if (!t.keyword || !trackDone(t)) return null;
  const kept = progress.phrases[t.id];
  if (kept?.keyword === t.keyword) return kept.phrase;
  const phrase = makePassphrase(t.keyword);
  progress.phrases[t.id] = { keyword: t.keyword, phrase };
  saveProgress();
  return phrase;
}

// ---------- helpers ----------

function starsHTML(n) {
  return `<span class="stars" aria-label="${n} of 3 stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(3 - n)}</span></span>`;
}

async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackEl) {
      const range = document.createRange();
      range.selectNodeContents(fallbackEl);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    return false;
  }
}

// ---------- home ----------

function renderHome() {
  const done = finishedTracks();
  const phrases = Object.fromEntries(manifest.tracks.map((t) => [t.id, phraseFor(t)]));
  const shown = manifest.tracks.filter((t) => isOpen(t) || phrases[t.id]);
  const upNext = manifest.tracks.filter(isOpen).map((t) => ({ t, n: nextStep(t) })).find((x) => x.n);

  app.replaceChildren(
    h(`
    <section class="home">
      <div class="intro">
        <h1>Practice the command line without breaking anything</h1>
        <p class="lede">Each track mixes short lessons, which explain what each command means and how its options work, with practice on a pretend copy of Geiss-01. Early practice walks you through every step. Later practice gives you a goal and gets out of the way. Finish a track to earn its passphrase.</p>
        <div class="row"><a class="btn" href="#/sandbox">Free play terminal</a></div>
      </div>

      ${upNext ? `<a class="up-next" href="${stepHref(upNext.t, upNext.n.step)}">
        <span style="display:grid;gap:2px"><span class="label">Up next · ${esc(upNext.t.title)}</span><strong>${esc(stepTitle(upNext.n.step))}</strong></span>
        <span class="btn primary" aria-hidden="true">Continue</span>
      </a>` : ''}

      <section class="pass" aria-labelledby="pass-title">
        <div class="pass-head">
          <h2 id="pass-title">Your passphrases</h2>
          <span class="muted">${done.length} of ${shown.length} tracks finished</span>
        </div>
        <div class="slots">${shown
          .map((t) => {
            const p = phrases[t.id];
            return `<div class="slot ${p ? 'earned' : ''}"><span class="label">${esc(t.title)}</span>${
              p ? `<code class="word" id="ph-${esc(t.id)}">${esc(p)}</code><button type="button" data-copy="${esc(t.id)}">Copy</button>` : '<span class="word">———</span>'
            }</div>`;
          })
          .join('')}</div>
        <p class="muted">${done.length ? 'Paste each passphrase into its track\'s question in the Linux Practice quiz in Canvas.' : 'Finish every scenario in a track to earn its passphrase.'} Your progress and passphrases are saved in this browser only, so keep using the same browser.</p>
      </section>

      ${GUIDE_LINK}

      <section style="display:grid;gap:14px" aria-labelledby="tracks-title">
        <h2 id="tracks-title">Linux and Slurm</h2>
        <div class="tracks">
          ${manifest.tracks.filter((t) => t.group !== 'tools').map(trackCard).join('')}
        </div>
      </section>

      ${manifest.tracks.some((t) => t.group === 'tools') ? `<section style="display:grid;gap:14px" aria-labelledby="tools-title">
        <h2 id="tools-title">Design tools</h2>
        <p class="muted">Each tool gets its own track. Finish Start a session and Run Slurm jobs first: these tracks assume you can get a GPU with srun and submit a job with sbatch.</p>
        <div class="tracks">
          ${manifest.tracks.filter((t) => t.group === 'tools').map(trackCard).join('')}
        </div>
      </section>` : ''}
    </section>`),
  );

  for (const b of app.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      const ok = await copyText(phrases[b.dataset.copy], document.getElementById(`ph-${b.dataset.copy}`));
      b.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    });
  }
}

function opensText(t) {
  if (!t.opens) return 'Not open yet';
  const d = new Date(`${t.opens}T00:00:00`);
  return `Opens ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function trackCard(t) {
  const total = t.defs.length;
  if (!total || !isOpen(t)) {
    return `<div class="track-card soon"><span class="label">${total ? opensText(t) : 'Coming soon'}</span><h3>${esc(t.title)}</h3><p class="muted">${esc(t.blurb)}</p><p class="cmds">${t.commands.map(esc).join(' · ')}</p></div>`;
  }
  const n = t.defs.filter((d) => isDone(d.id)).length;
  const lessons = t.tutorial?.lessons ?? [];
  const read = lessons.filter((l) => lessonDone(t, l)).length;
  const stars = t.defs.reduce((s, d) => s + (progress.done[d.id]?.stars ?? 0), 0);
  return `<a class="track-card ${n === total ? 'complete' : ''}" href="#/track/${esc(t.id)}">
    <span class="label">${n === total ? 'Complete' : `${lessons.length ? `${read} of ${lessons.length} lessons · ` : ''}${n} of ${total} practice`} · ${stars} ★</span>
    <h3>${esc(t.title)}</h3>
    <p class="muted">${esc(t.blurb)}</p>
    <p class="cmds">${t.commands.map(esc).join(' · ')}</p>
    <div class="bar"><span style="width:${(n / total) * 100}%"></span></div>
  </a>`;
}

const GUIDE_LINK = `<a class="guide-link" href="#/guide">
  <span style="display:grid;gap:2px"><span class="label">Guide</span><strong>Asking Slurm for GPUs, memory and time</strong><span class="muted">What --gres, --mem and --time mean, why they matter, and what happens if you leave them out.</span></span>
  <span aria-hidden="true">→</span>
</a>`;

// ---------- track ----------

function renderTrack(trackId) {
  const t = manifest.tracks.find((x) => x.id === trackId);
  if (!t || !t.defs.length || !isOpen(t)) return renderHome();
  const all = steps(t);
  let num = 0;
  let lessonNum = 0;
  const rows = all.map((s, i) => {
    const open = stepOpen(t, i);
    const done = stepDone(t, s);
    if (s.kind === 'lesson') {
      lessonNum++;
      const inner = `<span class="num">L${lessonNum}</span><span><strong>${esc(s.lesson.title)}</strong>${s.lesson.summary ? `<span class="muted small" style="display:block">${esc(s.lesson.summary)}</span>` : ''}</span><span class="pill lesson-pill">Lesson</span>${done ? '<span class="good-text">Done ✓</span>' : open ? '<span class="muted">Read</span>' : '<span class="muted">Locked</span>'}`;
      return `<li class="lesson-row">${open ? `<a class="scen" href="${stepHref(t, s)}">${inner}</a>` : `<div class="scen locked" aria-disabled="true">${inner}</div>`}</li>`;
    }
    num++;
    const d = s.def;
    const rec = progress.done[d.id];
    const inner = `<span class="num">${String(num).padStart(2, '0')}</span><span>${esc(d.title)}</span><span class="pill">Tier ${d.tier} · ${TIERS[d.tier].name}</span>${rec ? starsHTML(rec.stars) : open ? '<span class="muted">Start</span>' : '<span class="muted">Locked</span>'}`;
    return `<li>${open ? `<a class="scen" href="${stepHref(t, s)}">${inner}</a>` : `<div class="scen locked" aria-disabled="true">${inner}</div>`}</li>`;
  });
  app.replaceChildren(
    h(`
    <section class="track">
      <nav class="crumbs"><a href="#/">Tracks</a> / ${esc(t.title)}</nav>
      <div style="display:grid;gap:8px;max-width:68ch">
        <h1>${esc(t.title)}</h1>
        <p class="muted">${esc(t.blurb)} ${t.tutorial ? 'Each lesson explains the commands the practice after it uses.' : ''} Steps open in order, and hints get shorter as you climb.</p>
      </div>
      ${t.id === 'session' || t.id === 'slurm' || t.group === 'tools' ? GUIDE_LINK : ''}
      <ol class="scen-list">${rows.join('')}</ol>
    </section>`),
  );
}

// ---------- lesson ----------

function renderLesson(trackId, lessonId) {
  const t = manifest.tracks.find((x) => x.id === trackId);
  const all = t ? steps(t) : [];
  const i = all.findIndex((s) => s.kind === 'lesson' && s.lesson.id === lessonId);
  if (!t || i < 0 || !isOpen(t)) return renderHome();
  if (!stepOpen(t, i)) return renderTrack(t.id);
  const lesson = all[i].lesson;
  const n = all.slice(0, i + 1).filter((s) => s.kind === 'lesson').length;
  const next = all[i + 1];
  app.replaceChildren(h(lessonPageHTML(t, lesson, n, { done: lessonDone(t, lesson) })));
  const finish = () => {
    if (!lessonDone(t, lesson)) {
      progress.lessons[lessonKey(t, lesson)] = { at: new Date().toISOString() };
      saveProgress();
    }
    const box = document.getElementById('lesson-end');
    box.innerHTML = `<p class="good-text"><strong>Lesson done.</strong></p>${
      next ? `<a class="btn primary" href="${stepHref(t, next)}">Next: ${esc(stepTitle(next))}</a>` : `<a class="btn primary" href="#/track/${esc(t.id)}">Back to ${esc(t.title)}</a>`
    }`;
  };
  wireLesson(app, lesson, { makeDef: (bi, block) => tryDef(t.id, lesson, bi, block), onComplete: finish, done: lessonDone(t, lesson) });
}

// ---------- scenario ----------

const SANDBOX = {
  id: 'sandbox',
  track: null,
  tier: 1,
  title: 'Free play',
  story: 'No tasks, no score. Try anything: make folders, submit jobs, delete everything. Restart puts it all back.',
  vars: {},
  machines: {
    cluster: {
      cwd: '~',
      files: {
        '~/README.txt': { lib: 'text:readme' },
        '~/binder_design/inputs/target.pdb': { lib: 'pdb:complex' },
        '~/binder_design/inputs/designs.fasta': { lib: 'fasta:designs' },
        '~/binder_design/scripts/run_mpnn.sh': { lib: 'slurm:mpnn', exec: true },
        '~/binder_design/outputs/': {},
      },
      jobRules: [{ match: 'run_mpnn.sh', needsGpu: true, creates: ['outputs/seqs/target.fa'], log: 'Loading anaconda\nDesigning 8 sequences for inputs/target.pdb\nJob finished in 41.2 s\n' }],
    },
  },
  tasks: [],
  hints: [],
};

let current = null; // { def, session, track, index }

function renderScenario(id) {
  const def = id === 'sandbox' ? SANDBOX : scenarios.get(id);
  if (!def) return renderHome();
  const t = manifest.tracks.find((x) => x.id === def.track);
  const index = t ? t.defs.indexOf(def) : -1;
  if (t && !isOpen(t)) return renderHome();
  if (t && !stepOpen(t, steps(t).findIndex((s) => s.def === def))) return renderTrack(t.id);
  current = { def, track: t, index, session: new Session(def, { seed: (Math.random() * 2 ** 32) >>> 0 }) };

  app.replaceChildren(
    h(`
    <nav class="crumbs" style="padding-top:20px"><a href="#/">Tracks</a>${t ? ` / <a href="#/track/${esc(t.id)}">${esc(t.title)}</a> / ${index + 1}` : ' / Free play'}</nav>
    <div class="bench">
      <aside class="panel" id="panel"></aside>
      <div class="term">
        <div class="term-bar">${
          current.session.laptop
            ? `<div class="tabs" role="tablist"><button type="button" role="tab" data-m="cluster" aria-selected="true">Geiss-01</button><button type="button" role="tab" data-m="laptop" aria-selected="false">Laptop</button></div>`
            : '<span>student@geiss-01</span>'
        }<span>practice copy · safe to break</span></div>
        ${screenHTML('cluster')}
        ${current.session.laptop ? screenHTML('laptop', true) : ''}
      </div>
    </div>`),
  );
  const opts = { session: current.session, afterRun };
  const term = new Terminal(document.getElementById('screen-cluster'), { ...opts, machine: 'cluster' });
  renderPanel();
  term.write([{ text: 'Practice copy of Geiss-01. Type `help` to see commands. Stuck? Press the Hint button.\n', cls: 'dim' }]);
  if (current.session.laptop) {
    const lap = new Terminal(document.getElementById('screen-laptop'), { ...opts, machine: 'laptop' });
    lap.write([{ text: 'Your own laptop. Run `scp` here to copy files to and from Geiss-01.\n', cls: 'dim' }]);
    const terms = { cluster: term, laptop: lap };
    for (const tab of app.querySelectorAll('[role=tab]')) {
      tab.addEventListener('click', () => {
        for (const t of app.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t === tab));
        for (const [m, t] of Object.entries(terms)) t.screen.hidden = m !== tab.dataset.m;
        terms[tab.dataset.m].focus();
      });
    }
  }
  term.focus();
}

function screenHTML(machine, hidden = false) {
  return `<div class="screen" id="screen-${machine}" data-machine="${machine}"${hidden ? ' hidden' : ''}>
    <div class="log"></div>
    <div class="inrow"><span class="prompt"></span><input class="cmd" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="${machine === 'laptop' ? 'Laptop' : 'Geiss-01'} terminal command"></div>
  </div>`;
}

function renderPanel(coach = null) {
  const { def, session, track, index } = current;
  const panel = document.getElementById('panel');
  if (!panel) return;
  const tierInfo = TIERS[session.tier];
  const cur = session.current;
  const all = track ? steps(track) : [];
  const next = all[all.findIndex((s) => s.def === def) + 1];
  let doneCard = '';
  if (session.complete && track) {
    const finishedTrack = trackDone(track);
    const phrase = finishedTrack ? phraseFor(track) : null;
    doneCard = `<div class="done-card" role="status">
      <strong>Scenario complete</strong> ${starsHTML(session.stars)}
      ${phrase ? `<p>Track finished. Your passphrase: <span class="word">${esc(phrase)}</span></p><a class="btn" href="#/">See all your passphrases</a>` : ''}
      ${next ? `<a class="btn primary" href="${stepHref(track, next)}">Next: ${esc(stepTitle(next))}</a>` : track ? `<a class="btn" href="#/track/${esc(track.id)}">Back to ${esc(track.title)}</a>` : ''}
    </div>`;
  }
  panel.replaceChildren(
    h(`
    <div style="display:grid;gap:6px">
      ${track ? `<div class="row"><span class="pill">Tier ${session.tier} · ${tierInfo.name}</span><span class="label">${index + 1} of ${track.defs.length}</span></div>` : ''}
      <h2>${esc(session.def.title)}</h2>
    </div>
    <p class="story">${fmt(session.def.story)}</p>
    ${lessonHTML(session.def.lesson, { open: current.lessonOpen ?? (session.def.lesson?.open || session.tier <= 2) })}
    ${
      session.tasks.length
        ? `<div style="display:grid;gap:6px"><span class="label">Tasks</span><ol class="tasks">${session.tasks
            .map((tk, i) => `<li class="${tk.done ? 'done' : i === cur ? 'current' : ''}"><span class="box">${tk.done ? '✓' : ''}</span><span>${fmt(tk.text)}${i === cur && session.wantsAnswer ? answerFormHTML() : ''}</span></li>`)
            .join('')}</ol></div>`
        : ''
    }
    ${doneCard}
    <div style="display:grid;gap:6px">
      <span class="label">Coach</span>
      <div class="coach ${coach?.hint ? 'hint' : ''}" id="coach" aria-live="polite">${coach ? coach.html : session.complete ? 'Nice work.' : defaultCoach(session)}</div>
    </div>
    <div class="row">
      ${session.tasks.length ? `<button type="button" id="hint-btn">Hint (${session.hintsUsed}/${session.maxHints})</button>` : ''}
      <button type="button" id="restart-btn" title="Start over with new names and files">Restart</button>
    </div>`),
  );
  document.getElementById('answer-form')?.addEventListener('submit', onAnswer);
  // The panel redraws after every command, so remember whether the lesson is open.
  panel.querySelector('.lesson')?.addEventListener('toggle', (e) => { current.lessonOpen = e.target.open; });
  document.getElementById('hint-btn')?.addEventListener('click', () => showHint());
  document.getElementById('restart-btn').addEventListener('click', () => renderScenario(def.id));
}

// Tasks that ask what the student found take the answer here, not in the
// terminal: Linux has no command for reporting an answer.
function answerFormHTML() {
  return `<form class="answer-form" id="answer-form" autocomplete="off">
    <input id="answer-in" name="answer" placeholder="Type your answer" aria-label="Your answer" autocapitalize="off" spellcheck="false">
    <button type="submit">Check</button>
  </form>`;
}

function onAnswer(e) {
  e.preventDefault();
  const input = document.getElementById('answer-in');
  if (!input.value.trim()) return input.focus();
  const wasComplete = current.session.complete;
  const r = current.session.submitAnswer(input.value);
  if (r.correct) {
    afterRun({ ...r, coach: [] }, wasComplete);
    document.querySelector('.screen:not([hidden]) .cmd')?.focus({ preventScroll: true });
    return;
  }
  renderPanel({ html: `<strong>${esc(input.value.trim())}</strong> isn't it. Look again at what the terminal printed.` });
  const again = document.getElementById('answer-in');
  again.value = input.value;
  again.select();
}

function defaultCoach(session) {
  if (!session.tasks.length) return 'Anything goes here. Type `help` to see what this server understands.';
  if (session.tier === 1) return 'Type commands in the terminal and press Enter. Use the Hint button whenever you want.';
  if (session.tier === 4) return 'You\'re on your own for this one.';
  return 'Work through the tasks in order.';
}

function showHint() {
  const r = current.session.nextHint();
  renderPanel(r.text ? { html: `<strong>Hint:</strong> ${fmt(r.text)}`, hint: true } : { html: fmt(r.message) });
}

// Update the lesson panel after a command or an editor save.
function afterRun(r, wasComplete) {
  if (r.complete && !wasComplete) recordCompletion();
  const tip = r.coach?.at(-1);
  if (tip || r.newlyDone.length || (r.complete && !wasComplete)) {
    renderPanel(tip ? { html: fmt(tip.text) } : r.complete ? null : { html: `Done. Next: ${fmt(current.session.tasks[current.session.current]?.text ?? '')}${current.session.wantsAnswer ? ' (type it in the answer box)' : ''}` });
  }
}

function recordCompletion() {
  const { def, session } = current;
  if (!def.track) return;
  const prev = progress.done[def.id];
  if (!prev || session.stars > prev.stars) {
    progress.done[def.id] = { stars: session.stars, at: new Date().toISOString() };
    saveProgress();
  }
}

// ---------- routing ----------

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, id, sub] = hash.split('/');
  if (kind === 'track') renderTrack(id);
  else if (kind === 'learn') renderLesson(id, sub);
  else if (kind === 's') renderScenario(id);
  else if (kind === 'sandbox') renderScenario('sandbox');
  else if (kind === 'guide') app.replaceChildren(h(guideHTML()));
  else renderHome();
  window.scrollTo(0, 0);
}

loadData()
  .then(() => {
    window.addEventListener('hashchange', route);
    route();
  })
  .catch((e) => {
    app.replaceChildren(h(`<p class="loading">Couldn't load the scenarios (${esc(e.message)}). Try reloading the page.</p>`));
  });
