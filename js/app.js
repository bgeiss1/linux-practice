// Student site: track list, scenario list, and the practice terminal.

import { Session, TIERS } from '../engine/scenario.js';
import { Terminal, esc, fmt, h } from './terminal.js';
import { wordsFor, passphrase } from '../engine/passphrase.js';

const app = document.getElementById('app');
const STORE_KEY = 'linux-practice:v1';

// ---------- progress (this browser only) ----------

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && typeof saved === 'object') return { studentId: '', done: {}, ...saved };
  } catch {
    // Private windows and blocked storage land here; start fresh.
  }
  return { studentId: '', done: {} };
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
}

const trackIds = () => manifest.tracks.map((t) => t.id);
const isDone = (id) => !!progress.done[id];
const trackDone = (t) => t.defs.length > 0 && t.defs.every((d) => isDone(d.id));
const finishedTracks = () => manifest.tracks.filter(trackDone).map((t) => t.id);

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
  const words = progress.studentId ? wordsFor(progress.studentId, trackIds(), manifest.passphraseSalt) : null;
  const phrase = progress.studentId ? passphrase(progress.studentId, trackIds(), manifest.passphraseSalt, done) : '';

  app.replaceChildren(
    h(`
    <section class="home">
      <div class="intro">
        <h1>Practice the command line without breaking anything</h1>
        <p class="lede">Each track is a ladder of short scenarios on a pretend copy of Geiss-01. Early ones walk you through every step. Later ones give you a goal and get out of the way. Finish a track to earn a word for your passphrase.</p>
        <div class="row"><a class="btn" href="#/sandbox">Free play terminal</a></div>
      </div>

      <section class="pass" aria-labelledby="pass-title">
        <div class="pass-head">
          <h2 id="pass-title">Your passphrase</h2>
          <span class="muted">${done.length} of ${manifest.tracks.length} words earned</span>
        </div>
        ${
          progress.studentId
            ? `<div class="slots">${manifest.tracks
                .map((t) => {
                  const got = done.includes(t.id);
                  return `<div class="slot ${got ? 'earned' : ''}"><span class="label">${esc(t.title)}</span><span class="word">${got ? esc(words[t.id]) : '———'}</span></div>`;
                })
                .join('')}</div>
              ${
                phrase
                  ? `<div class="row"><code class="phrase" id="phrase">${esc(phrase)}</code><button type="button" id="copy-phrase">Copy</button></div>
                     <p class="muted">Paste this into the Linux Practice assignment in Canvas. You can resubmit as you earn more words.</p>`
                  : `<p class="muted">Finish every scenario in a track to earn its word.</p>`
              }
              <p class="muted">Words for CSU ID <strong>${esc(progress.studentId)}</strong>. <button type="button" id="change-id">Change ID</button></p>`
            : `<p>Your words are tied to your CSU ID, so enter it before you start. It stays in this browser.</p>
               <form class="id-form" id="id-form">
                 <label for="student-id" class="label">CSU ID</label>
                 <input type="text" id="student-id" autocomplete="off" inputmode="text" placeholder="e.g. 830123456" required>
                 <button type="submit" class="primary">Save</button>
               </form>`
        }
      </section>

      <section style="display:grid;gap:14px" aria-labelledby="tracks-title">
        <h2 id="tracks-title">Tracks</h2>
        <div class="tracks">
          ${manifest.tracks.map(trackCard).join('')}
        </div>
      </section>
    </section>`),
  );

  document.getElementById('id-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = document.getElementById('student-id').value.trim();
    if (!v) return;
    progress.studentId = v;
    saveProgress();
    renderHome();
  });
  document.getElementById('change-id')?.addEventListener('click', () => {
    progress.studentId = '';
    saveProgress();
    renderHome();
  });
  document.getElementById('copy-phrase')?.addEventListener('click', async (e) => {
    const ok = await copyText(phrase, document.getElementById('phrase'));
    e.target.textContent = ok ? 'Copied' : 'Press Ctrl+C';
  });
}

function trackCard(t) {
  const total = t.defs.length;
  if (!total) {
    return `<div class="track-card soon"><span class="label">Coming soon</span><h3>${esc(t.title)}</h3><p class="muted">${esc(t.blurb)}</p><p class="cmds">${t.commands.map(esc).join(' · ')}</p></div>`;
  }
  const n = t.defs.filter((d) => isDone(d.id)).length;
  const stars = t.defs.reduce((s, d) => s + (progress.done[d.id]?.stars ?? 0), 0);
  return `<a class="track-card ${n === total ? 'complete' : ''}" href="#/track/${esc(t.id)}">
    <span class="label">${n === total ? 'Complete' : `${n} of ${total} done`} · ${stars} ★</span>
    <h3>${esc(t.title)}</h3>
    <p class="muted">${esc(t.blurb)}</p>
    <p class="cmds">${t.commands.map(esc).join(' · ')}</p>
    <div class="bar"><span style="width:${(n / total) * 100}%"></span></div>
  </a>`;
}

// ---------- track ----------

function unlocked(t, i) {
  return i === 0 || isDone(t.defs[i - 1].id);
}

function renderTrack(trackId) {
  const t = manifest.tracks.find((x) => x.id === trackId);
  if (!t || !t.defs.length) return renderHome();
  const groups = [1, 2, 3, 4].map((tier) => ({ tier, items: t.defs.map((d, i) => ({ d, i })).filter(({ d }) => Number(d.tier) === tier) })).filter((g) => g.items.length);
  app.replaceChildren(
    h(`
    <section class="track">
      <nav class="crumbs"><a href="#/">Tracks</a> / ${esc(t.title)}</nav>
      <div style="display:grid;gap:8px;max-width:68ch">
        <h1>${esc(t.title)}</h1>
        <p class="muted">${esc(t.blurb)} Scenarios unlock in order. Hints get shorter as you climb.</p>
      </div>
      ${groups
        .map(
          (g) => `<div class="tier-group">
            <span class="label">Tier ${g.tier} · ${TIERS[g.tier].name}</span>
            <ol class="scen-list">
              ${g.items
                .map(({ d, i }) => {
                  const open = unlocked(t, i);
                  const rec = progress.done[d.id];
                  const inner = `<span class="num">${String(i + 1).padStart(2, '0')}</span><span>${esc(d.title)}</span><span class="pill">Tier ${d.tier}</span>${rec ? starsHTML(rec.stars) : open ? '<span class="muted">Start</span>' : '<span class="muted">Locked</span>'}`;
                  return `<li>${open ? `<a class="scen" href="#/s/${esc(d.id)}">${inner}</a>` : `<div class="scen locked" aria-disabled="true">${inner}</div>`}</li>`;
                })
                .join('')}
            </ol>
          </div>`,
        )
        .join('')}
    </section>`),
  );
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
  if (t && !unlocked(t, index)) return renderTrack(t.id);
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
  const next = track && track.defs[index + 1];
  let doneCard = '';
  if (session.complete && track) {
    const finishedTrack = trackDone(track);
    const word = finishedTrack && progress.studentId ? wordsFor(progress.studentId, trackIds(), manifest.passphraseSalt)[track.id] : null;
    doneCard = `<div class="done-card" role="status">
      <strong>Scenario complete</strong> ${starsHTML(session.stars)}
      ${finishedTrack ? (word ? `<p>Track finished. Your word: <span class="word">${esc(word)}</span></p><a class="btn" href="#/">See your passphrase</a>` : `<p>Track finished. <a href="#/">Enter your CSU ID</a> to see your word.</p>`) : ''}
      ${next ? `<a class="btn primary" href="#/s/${esc(next.id)}">Next: ${esc(next.title)}</a>` : track ? `<a class="btn" href="#/track/${esc(track.id)}">Back to ${esc(track.title)}</a>` : ''}
    </div>`;
  }
  panel.replaceChildren(
    h(`
    <div style="display:grid;gap:6px">
      ${track ? `<div class="row"><span class="pill">Tier ${session.tier} · ${tierInfo.name}</span><span class="label">${index + 1} of ${track.defs.length}</span></div>` : ''}
      <h2>${esc(session.def.title)}</h2>
    </div>
    <p class="story">${fmt(session.def.story)}</p>
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
  const [kind, id] = hash.split('/');
  if (kind === 'track') renderTrack(id);
  else if (kind === 's') renderScenario(id);
  else if (kind === 'sandbox') renderScenario('sandbox');
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
