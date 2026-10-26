// Tutorials: in-depth lessons that sit between a track's practice scenarios.
// Each track can have tutorials/<track>.json:
//
//   { "track": "navigate", "lessons": [
//     { "id": "pwd-ls", "title": "Where am I?", "before": "navigate-01-where-am-i",
//       "summary": "...", "blocks": [ ... ] } ] }
//
// A lesson appears in the track just before the scenario named in "before"
// (or after every scenario when "before" is left out). Blocks, in order:
//
//   { "text": "Paragraph with `code`. A blank line starts a new paragraph." }
//   { "command": { "name": "cd", "stands": "change directory", "syntax": "cd [FOLDER]", "what": "..." } }
//   { "flags": [["-a", "all", "Also list hidden files"], ...] }
//   { "example": { "cmd": "ls -a", "out": "...", "note": "..." } }   (no "cmd": a diagram)
//   { "try": { "text": "Type `pwd`", "cwd": "~", "files": {...}, "check": {...},
//              "hint": "...", "solution": ["pwd"] } }      a small live terminal
//   { "quiz": { "q": "...", "options": ["..."], "answer": 1, "why": "..." } }
//   { "tip": "..." }  { "warn": "..." }
//
// A "try" takes the same files, checks and solution steps as a scenario (see
// docs/scenarios.md), plus optional "machines" for Slurm jobs or a laptop;
// "on": "laptop" puts its terminal on the laptop.

import { validate } from './validate.js';

export const BLOCK_TYPES = ['text', 'command', 'flags', 'example', 'try', 'quiz', 'tip', 'warn'];

export const blockType = (block) => Object.keys(block ?? {}).find((k) => BLOCK_TYPES.includes(k));

// The scenario a "try" block runs as.
export function tryDef(track, lesson, index, t) {
  const machines = t.machines ?? { cluster: { cwd: t.cwd ?? '~', files: t.files ?? {}, ...(t.jobRules ? { jobRules: t.jobRules } : {}), ...(t.liveJobs ? { liveJobs: true } : {}) } };
  return {
    id: `tutorial-${track}-${lesson.id}-${index + 1}`,
    track,
    order: index + 1,
    tier: 1,
    title: lesson.title,
    story: '',
    vars: t.vars ?? {},
    machines,
    tasks: t.tasks ?? [{ text: t.text, check: t.check }],
    hints: t.hint ? [t.hint] : [],
    solution: t.solution ?? [],
  };
}

// The track as students walk it: lessons and scenarios in order.
// Returns [{ kind: 'lesson', lesson } | { kind: 'scenario', def }].
export function ladder(defs, tutorial) {
  const lessons = tutorial?.lessons ?? [];
  const out = [];
  for (const def of defs) {
    for (const lesson of lessons.filter((l) => l.before === def.id)) out.push({ kind: 'lesson', lesson });
    out.push({ kind: 'scenario', def });
  }
  const placed = new Set(defs.map((d) => d.id));
  for (const lesson of lessons.filter((l) => !l.before || !placed.has(l.before))) out.push({ kind: 'lesson', lesson });
  return out;
}

// Problems with a tutorial file. scenarioIds: the ids in its track.
export function validateTutorial(tut, scenarioIds, { seeds = 5 } = {}) {
  const errors = [];
  if (!Array.isArray(tut?.lessons) || !tut.lessons.length) return ['needs a "lessons" list'];
  const ids = new Set();
  tut.lessons.forEach((lesson, li) => {
    const where = `lesson ${li + 1} (${lesson.id ?? 'no id'})`;
    if (!/^[a-z0-9-]+$/.test(lesson.id ?? '')) errors.push(`${where}: "id" must be lowercase letters, digits and dashes`);
    if (ids.has(lesson.id)) errors.push(`${where}: duplicate id`);
    ids.add(lesson.id);
    if (!lesson.title) errors.push(`${where}: missing "title"`);
    if (lesson.before && !scenarioIds.includes(lesson.before)) errors.push(`${where}: "before" names ${lesson.before}, which isn't in this track`);
    if (!Array.isArray(lesson.blocks) || !lesson.blocks.length) {
      errors.push(`${where}: needs "blocks"`);
      return;
    }
    lesson.blocks.forEach((b, bi) => {
      const at = `${where} block ${bi + 1}`;
      const type = blockType(b);
      if (!type) return errors.push(`${at}: unknown block ${JSON.stringify(b).slice(0, 60)}. Known: ${BLOCK_TYPES.join(', ')}`);
      const v = b[type];
      if (type === 'command' && !(v?.name && v?.stands && v?.syntax)) errors.push(`${at}: a command needs "name", "stands" and "syntax"`);
      if (type === 'flags' && !(Array.isArray(v) && v.every((r) => Array.isArray(r) && r.length === 3))) errors.push(`${at}: flags are rows of [flag, stands for, what it does]`);
      if (type === 'example' && !v?.cmd && !v?.out) errors.push(`${at}: an example needs "cmd" or "out"`);
      if (type === 'quiz') {
        if (!v?.q || !Array.isArray(v.options) || v.options.length < 2) errors.push(`${at}: a quiz needs "q" and at least two "options"`);
        else if (!(Number.isInteger(v.answer) && v.answer >= 0 && v.answer < v.options.length)) errors.push(`${at}: "answer" must be the index of the right option, from 0`);
        if (!v?.why) errors.push(`${at}: a quiz needs "why"`);
      }
      if (type === 'try') {
        if (!v?.text && !v?.tasks) errors.push(`${at}: a try needs "text"`);
        const r = validate(tryDef(tut.track, lesson, bi, v), { seeds });
        for (const e of r.errors) errors.push(`${at}: ${e}`);
      }
    });
  });
  return errors;
}

// Whether students can open a track today. "available": false closes it;
// "opens": "YYYY-MM-DD" opens it on that day.
export function trackOpen(track, today = new Date()) {
  if (track.available !== false) return true;
  if (!track.opens) return false;
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return iso >= track.opens;
}
