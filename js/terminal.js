// The practice terminal and its nano look-alike, shared by the student site
// and the instructor dashboard's preview.

import { COMMANDS } from '../engine/commands/index.js';

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Escape, then show `backticks` as code.
export function fmt(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

// A command taken apart: each part gets a number under it and a note below.
// parts: [{ "code": "--gres=gpu:1", "note": "..." }]. With lines, each part is
// its own line (for #SBATCH headers); otherwise they read as one command.
export function breakdownHTML(parts, { lines = false } = {}) {
  const tokens = parts
    .map((p, i) => `<span class="bd-part"><span class="bd-tok">${esc(p.code)}</span><span class="bd-num" aria-hidden="true">${i + 1}</span></span>`)
    .join(lines ? '\n' : ' ');
  return `<div class="breakdown">
    <pre class="bd-cmd${lines ? ' bd-lines' : ''}" aria-label="${esc(parts.map((p) => p.code).join(lines ? '; ' : ' '))}">${tokens}</pre>
    <ol class="bd-notes">${parts.map((p) => `<li><code>${esc(p.code)}</code> ${fmt(p.note)}</li>`).join('')}</ol>
  </div>`;
}

// The "how this works" card at the top of a scenario, from its "lesson" field:
// { title, intro?, parts, lines?, why?, without? }.
export function lessonHTML(lesson, { open = true } = {}) {
  if (!lesson?.parts?.length) return '';
  return `<details class="lesson"${open ? ' open' : ''}>
    <summary><span class="label">How it works</span> ${fmt(lesson.title)}</summary>
    <div class="lesson-body">
      ${lesson.intro ? `<p>${fmt(lesson.intro)}</p>` : ''}
      ${breakdownHTML(lesson.parts, { lines: lesson.lines })}
      ${lesson.why ? `<p><strong>Why:</strong> ${fmt(lesson.why)}</p>` : ''}
      ${lesson.without ? `<p><strong>Leave it out and:</strong> ${fmt(lesson.without)}</p>` : ''}
      <p><a href="./#/guide">Guide: asking Slurm for GPUs, memory and time</a></p>
    </div>
  </details>`;
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
}

export class Terminal {
  // afterRun(result, wasComplete) runs after each command and editor save.
  constructor(screen, { session, machine = 'cluster', afterRun = () => {} }) {
    this.screen = screen;
    this.session = session;
    this.machine = machine;
    this.afterRun = afterRun;
    this.log = screen.querySelector('.log');
    this.input = screen.querySelector('.cmd');
    this.promptEl = screen.querySelector('.prompt');
    this.hi = 0;
    this.renderPrompt();
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    screen.addEventListener('click', () => {
      if (!getSelection().toString()) this.focus();
    });
  }

  get shell() {
    return this.session.machines[this.machine];
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  promptHTML() {
    const p = this.shell.prompt();
    return `${p.env ? esc(p.env) : ''}<span class="p-user">${esc(p.user)}</span>:<span class="p-path">${esc(p.path)}</span>$`;
  }

  renderPrompt() {
    this.promptEl.innerHTML = this.promptHTML();
  }

  echo(line) {
    const div = document.createElement('div');
    div.className = 'ln';
    div.innerHTML = `${this.promptHTML()} ${esc(line)}`;
    this.log.appendChild(div);
  }

  write(segments) {
    if (!segments.length) return;
    const div = document.createElement('div');
    div.className = 'ln out';
    for (const seg of segments) {
      const span = document.createElement('span');
      if (seg.cls) span.className = `t-${seg.cls}`;
      span.textContent = seg.cls === 'dim' ? seg.text.replace(/`/g, '') : seg.text;
      div.appendChild(span);
    }
    this.log.appendChild(div);
  }

  scroll() {
    this.screen.scrollTop = this.screen.scrollHeight;
  }

  run(line) {
    this.echo(line);
    const wasComplete = this.session.complete;
    const r = this.session.run(line, this.machine);
    if (r.clear) this.log.replaceChildren();
    this.write(r.output);
    this.afterRun(r, wasComplete);
    if (r.edit) {
      new Editor(this, r.edit);
      return;
    }
    this.hi = this.shell.history.length;
    this.renderPrompt();
    this.scroll();
  }

  onKey(e) {
    const { input } = this;
    if (e.key === 'Enter') {
      e.preventDefault(); // or the Enter can land in the editor if this line opens nano
      const v = input.value;
      input.value = '';
      this.run(v);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.complete();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.hi > 0) input.value = this.shell.history[--this.hi];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.hi < this.shell.history.length) input.value = this.shell.history[++this.hi] ?? '';
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      this.log.replaceChildren();
    } else if (e.key === 'c' && e.ctrlKey && !getSelection().toString()) {
      e.preventDefault();
      this.echo(input.value + '^C');
      input.value = '';
      this.scroll();
    }
  }

  complete() {
    const { input } = this;
    const v = input.value;
    const m = v.match(/(\S*)$/);
    const w = m[1];
    const before = v.slice(0, v.length - w.length);
    if (!before.trim()) {
      const opts = Object.keys(COMMANDS).filter((c) => !c.startsWith('__') && c.startsWith(w)).sort();
      if (opts.length === 1) input.value = opts[0] + ' ';
      else if (opts.length > 1 && w) this.showOptions(v, opts, before, '', w);
      return;
    }
    const unescaped = w.replace(/\\ /g, ' ');
    const slash = unescaped.lastIndexOf('/');
    const dirPart = slash >= 0 ? unescaped.slice(0, slash + 1) : '';
    const base = slash >= 0 ? unescaped.slice(slash + 1) : unescaped;
    const dir = this.shell.vfs.get(this.shell.resolve(dirPart || '.'));
    if (!dir || dir.type !== 'dir') return;
    const opts = Object.keys(dir.children)
      .filter((k) => k.startsWith(base) && (base.startsWith('.') || !k.startsWith('.')))
      .sort();
    const escName = (s) => s.replace(/ /g, '\\ ');
    if (opts.length === 1) {
      const k = opts[0];
      input.value = before + escName(dirPart + k) + (dir.children[k].type === 'dir' ? '/' : ' ');
    } else if (opts.length > 1) {
      this.showOptions(v, opts, before, dirPart, base, escName);
    }
  }

  showOptions(v, opts, before, dirPart, base, escName = (s) => s) {
    this.echo(v);
    this.write([{ text: opts.join('  ') + '\n' }]);
    let common = opts[0];
    for (const o of opts) while (!o.startsWith(common)) common = common.slice(0, -1);
    if (common.length > (base ?? '').length) this.input.value = before + escName(dirPart + common);
    this.scroll();
  }
}


// A small nano look-alike. It covers the terminal until the student exits.
class Editor {
  constructor(term, edit) {
    this.term = term;
    this.edit = edit;
    this.saved = edit.content;
    this.asking = false;
    const box = term.screen.parentElement;
    this.el = h(`
      <div class="nano" role="dialog" aria-label="nano editor">
        <div class="nano-bar"><span>GNU nano 7.2</span><span>${esc(edit.file)}${edit.isNew ? ' (new file)' : ''}</span><span class="nano-mod"></span></div>
        <textarea class="nano-text" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="File contents"></textarea>
        <div class="nano-status" aria-live="polite"></div>
        <div class="nano-keys">
          <button type="button" data-k="save"><kbd>^O</kbd> Write Out</button>
          <button type="button" data-k="exit"><kbd>^X</kbd> Exit</button>
          <span class="nano-tip">Ctrl+S also saves</span>
        </div>
      </div>`).firstElementChild;
    this.text = this.el.querySelector('textarea');
    this.status = this.el.querySelector('.nano-status');
    this.mod = this.el.querySelector('.nano-mod');
    this.text.value = edit.content;
    term.screen.hidden = true;
    box.appendChild(this.el);
    this.text.addEventListener('keydown', (e) => this.onKey(e));
    this.text.addEventListener('input', () => this.markModified());
    this.el.querySelector('[data-k=save]').addEventListener('click', () => this.save());
    this.el.querySelector('[data-k=exit]').addEventListener('click', () => this.exit());
    setTimeout(() => {
      this.text.focus();
      this.text.setSelectionRange(0, 0);
    });
  }

  get modified() {
    return this.text.value !== this.saved;
  }

  markModified() {
    this.mod.textContent = this.modified ? 'Modified' : '';
  }

  say(msg) {
    this.status.textContent = msg;
  }

  save() {
    const { session } = this.term;
    const wasComplete = session.complete;
    let text = this.text.value;
    if (text && !text.endsWith('\n')) text += '\n';
    const r = session.save(this.edit.path, text, this.term.machine);
    this.saved = this.text.value;
    this.markModified();
    const n = text ? text.split('\n').length - 1 : 0;
    this.say(`[ Wrote ${n} line${n === 1 ? '' : 's'} ]`);
    this.term.afterRun(r, wasComplete);
  }

  exit() {
    if (this.modified) {
      this.asking = true;
      this.say('Save modified buffer?  Y Yes   N No   ^C Cancel');
      return;
    }
    this.close();
  }

  close() {
    this.el.remove();
    this.term.screen.hidden = false;
    this.term.renderPrompt();
    this.term.scroll();
    this.term.focus();
  }

  onKey(e) {
    const key = e.key.toLowerCase();
    if (this.asking) {
      e.preventDefault();
      if (key === 'y') { this.save(); this.close(); }
      else if (key === 'n') this.close();
      else if (key === 'escape' || (e.ctrlKey && key === 'c')) { this.asking = false; this.say('Cancelled'); }
      return;
    }
    if (e.ctrlKey && (key === 'o' || key === 's')) { e.preventDefault(); this.save(); }
    else if (e.ctrlKey && key === 'x') { e.preventDefault(); this.exit(); }
    else if (key === 'tab') {
      e.preventDefault();
      this.text.setRangeText('    ', this.text.selectionStart, this.text.selectionEnd, 'end');
      this.markModified();
    }
  }
}
