// A tutorial lesson page: explanations, command cards, option tables,
// examples, small live terminals ("Try it"), and quick checks. The lesson is
// done when every Try it is finished and every check answered correctly.

import { Session } from '../engine/scenario.js';
import { blockType } from '../engine/tutorial.js';
import { Terminal, esc, fmt } from './terminal.js';

const paras = (text) =>
  String(text)
    .split(/\n\s*\n/)
    .map((p) => `<p>${fmt(p.trim())}</p>`)
    .join('');

function blockHTML(block, bi) {
  const type = blockType(block);
  const v = block[type];
  switch (type) {
    case 'text':
      return `<div class="lz-text">${paras(v)}</div>`;
    case 'command':
      return `<div class="lz-cmd">
        <div class="lz-cmd-head"><code class="lz-cmd-name">${esc(v.name)}</code><span class="lz-stands">${esc(v.stands)}</span></div>
        <div class="lz-syntax"><span class="label">Form</span> <code>${esc(v.syntax)}</code></div>
        ${v.what ? `<div>${paras(v.what)}</div>` : ''}
      </div>`;
    case 'flags':
      return `<div class="table-scroll"><table class="lz-flags">
        <thead><tr><th scope="col">Write</th><th scope="col">Short for</th><th scope="col">What it does</th></tr></thead>
        <tbody>${v.map(([f, s, w]) => `<tr><td><code>${esc(f)}</code></td><td class="muted">${esc(s)}</td><td>${fmt(w)}</td></tr>`).join('')}</tbody>
      </table></div>`;
    case 'example':
      return `<figure class="lz-example">
        <pre class="bd-cmd">${v.cmd ? `<span class="lz-prompt">$</span> ${esc(v.cmd)}${v.out ? '\n' : ''}` : ''}${v.out ? `<span class="lz-out">${esc(v.out)}</span>` : ''}</pre>
        ${v.note ? `<figcaption>${fmt(v.note)}</figcaption>` : ''}
      </figure>`;
    case 'try': {
      const tasks = v.tasks ?? [{ text: v.text }];
      return `<div class="lz-try" data-try="${bi}">
        <div class="lz-try-head"><span class="label">Try it</span><span class="lz-status" aria-live="polite"></span></div>
        ${v.tasks && v.text ? `<p>${fmt(v.text)}</p>` : ''}
        ${tasks.length > 1 ? `<ol class="tasks">${tasks.map((tk) => `<li><span class="box"></span><span>${fmt(tk.text)}</span></li>`).join('')}</ol>` : `<p>${fmt(tasks[0].text)}</p>`}
        <div class="term lz-term">
          <div class="term-bar"><span>${v.on === 'laptop' ? 'Your laptop' : 'student@geiss-01'}</span><span>practice copy</span></div>
          <div class="screen" data-machine="${v.on === 'laptop' ? 'laptop' : 'cluster'}">
            <div class="log"></div>
            <div class="inrow"><span class="prompt"></span><input class="cmd" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Practice terminal for this step"></div>
          </div>
        </div>
        <p class="lz-coach small" aria-live="polite"></p>
        ${v.hint ? `<div class="row"><button type="button" class="lz-hint-btn">Hint</button><span class="lz-hint muted" hidden>${fmt(v.hint)}</span></div>` : ''}
      </div>`;
    }
    case 'quiz':
      return `<div class="lz-quiz" data-quiz="${bi}" role="group" aria-label="Quick check">
        <span class="label">Quick check</span>
        <p><strong>${fmt(v.q)}</strong></p>
        <div class="lz-options">${v.options.map((o, i) => `<button type="button" data-opt="${i}">${fmt(o)}</button>`).join('')}</div>
        <p class="lz-why" aria-live="polite"></p>
      </div>`;
    case 'tip':
      return `<div class="lz-note tip"><span class="label">Tip</span><div>${paras(v)}</div></div>`;
    case 'warn':
      return `<div class="lz-note warn"><span class="label">Careful</span><div>${paras(v)}</div></div>`;
    default:
      return '';
  }
}

export function lessonPageHTML(track, lesson, n, { done = false } = {}) {
  return `<article class="lz">
    <nav class="crumbs"><a href="#/">Tracks</a> / <a href="#/track/${esc(track.id)}">${esc(track.title)}</a> / Lesson ${n}</nav>
    <header class="lz-head">
      <span class="label">Lesson ${n}${done ? ' · done' : ''}</span>
      <h1>${esc(lesson.title)}</h1>
      ${lesson.summary ? `<p class="lede">${esc(lesson.summary)}</p>` : ''}
    </header>
    ${lesson.blocks.map(blockHTML).join('')}
    <div class="lz-end" id="lesson-end"></div>
  </article>`;
}

// Starts the terminals and checks. onComplete runs once every one is done.
export function wireLesson(root, lesson, { makeDef, onComplete, done = false }) {
  const pending = new Set();
  const finishOne = (key) => {
    if (!pending.delete(key)) return;
    updateEnd();
  };
  const updateEnd = () => {
    const end = root.querySelector('#lesson-end');
    if (!pending.size) onComplete();
    else end.innerHTML = `<p class="muted">${pending.size} step${pending.size === 1 ? '' : 's'} left in this lesson: finish each Try it and Quick check above.</p>`;
  };

  lesson.blocks.forEach((block, bi) => {
    const type = blockType(block);
    if (type === 'try') {
      const key = `try${bi}`;
      if (!done) pending.add(key);
      const box = root.querySelector(`[data-try="${bi}"]`);
      const session = new Session(makeDef(bi, block[type]), { seed: (Math.random() * 2 ** 32) >>> 0 });
      const status = box.querySelector('.lz-status');
      const ticks = [...box.querySelectorAll('.tasks li')];
      const show = () => {
        session.tasks.forEach((tk, i) => {
          if (!ticks[i]) return;
          ticks[i].className = tk.done ? 'done' : i === session.current ? 'current' : '';
          ticks[i].querySelector('.box').textContent = tk.done ? '✓' : '';
        });
        if (session.complete) {
          box.classList.add('ok');
          status.textContent = 'Done ✓';
          finishOne(key);
        }
      };
      new Terminal(box.querySelector('.screen'), { session, machine: block[type].on === 'laptop' ? 'laptop' : 'cluster', afterRun: (r) => {
        const tip = r.coach?.at(-1);
        box.querySelector('.lz-coach').innerHTML = tip && !session.complete ? fmt(tip.text) : '';
        show();
      } });
      show();
      box.querySelector('.lz-hint-btn')?.addEventListener('click', (e) => {
        e.target.hidden = true;
        box.querySelector('.lz-hint').hidden = false;
      });
    } else if (type === 'quiz') {
      const key = `quiz${bi}`;
      if (!done) pending.add(key);
      const box = root.querySelector(`[data-quiz="${bi}"]`);
      const q = block.quiz;
      for (const b of box.querySelectorAll('[data-opt]')) {
        b.addEventListener('click', () => {
          const right = Number(b.dataset.opt) === q.answer;
          b.classList.add(right ? 'right' : 'wrong');
          const why = box.querySelector('.lz-why');
          if (right) {
            for (const o of box.querySelectorAll('[data-opt]')) o.disabled = true;
            why.innerHTML = `<span class="good-text">Right.</span> ${fmt(q.why)}`;
            finishOne(key);
          } else {
            why.innerHTML = '<span class="warn-text">Not quite.</span> Try another answer.';
          }
        });
      }
    }
  });

  if (!pending.size && !done) {
    // Nothing to do on this page but read it.
    const end = root.querySelector('#lesson-end');
    end.innerHTML = '<button type="button" class="primary" id="lesson-read">I\'ve read this</button>';
    end.querySelector('#lesson-read').addEventListener('click', onComplete);
  } else {
    updateEnd();
  }
}
