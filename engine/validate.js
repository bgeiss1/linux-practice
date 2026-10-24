// Checks a scenario before students see it: required fields, known check
// types, every {{variable}} defined, and the reference solution actually
// finishing the scenario for many random draws. Used by the test suite and
// the instructor dashboard.

import { Session } from './scenario.js';
import { CHECK_TYPES } from './checks.js';

const REQUIRED = ['id', 'track', 'order', 'tier', 'title', 'story', 'tasks', 'hints', 'solution'];

function checkShape(check, path, errors) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    errors.push(`${path}: a check must be an object`);
    return;
  }
  const type = Object.keys(check).find((k) => CHECK_TYPES.includes(k));
  if (!type) {
    errors.push(`${path}: unknown check ${JSON.stringify(check)}. Known: ${CHECK_TYPES.join(', ')}`);
    return;
  }
  if (type === 'all' || type === 'any') check[type].forEach((c, i) => checkShape(c, `${path}.${type}[${i}]`, errors));
  if (type === 'not' || type === 'laptop') checkShape(check[type], `${path}.${type}`, errors);
}

export function validate(def, { seeds = 20 } = {}) {
  const errors = [];
  const warnings = [];
  for (const key of REQUIRED) if (def[key] === undefined) errors.push(`missing "${key}"`);
  if (errors.length) return { errors, warnings };
  if (![1, 2, 3, 4].includes(Number(def.tier))) errors.push('"tier" must be 1, 2, 3 or 4');
  if (!Array.isArray(def.tasks) || !def.tasks.length) errors.push('needs at least one task');
  if (!Array.isArray(def.hints)) errors.push('"hints" must be a list');
  if (!Array.isArray(def.solution) || !def.solution.length) errors.push('"solution" must list the commands that solve it');
  (def.tasks ?? []).forEach((t, i) => {
    if (!t.text) errors.push(`task ${i + 1}: missing "text"`);
    checkShape(t.check, `task ${i + 1}`, errors);
  });
  const maxHints = { 1: 3, 2: 2, 3: 1, 4: 1 }[def.tier];
  if (def.hints?.length > maxHints) warnings.push(`tier ${def.tier} shows at most ${maxHints} hint(s); extra hints are never shown`);
  if (errors.length) return { errors, warnings };

  for (let seed = 1; seed <= seeds; seed++) {
    let session;
    try {
      session = new Session(def, { seed: seed * 7919, now: Date.UTC(2026, 9, 24, 15) });
    } catch (e) {
      errors.push(`seed ${seed}: could not build the scenario: ${e.message}`);
      break;
    }
    // {{i}} and {{n}} are counters for "count" and "repeat", filled in when files are built.
    // {{task}} and {{job}} are filled in by Slurm for each job (see jobRules).
    const leftover = JSON.stringify(session.def).match(/\{\{\s*(?!(?:i|n|task|job)\s*\}\})[\w.]+\s*\}\}/g);
    if (leftover) {
      errors.push(`undefined variable(s) ${[...new Set(leftover)].join(', ')}`);
      break;
    }
    if (session.updateTasks().length) {
      errors.push(`seed ${seed}: task 1 is already done before the student types anything`);
      break;
    }
    const failedLines = [];
    for (const step of session.def.solution) {
      // { "nano": "run.sh", "text": "..." } opens the editor and saves that text.
      // { "laptop": "scp ..." } runs a line in the laptop's terminal.
      // { "answer": "17" } types 17 in the answer box.
      if (typeof step === 'object' && 'answer' in step) {
        if (!session.submitAnswer(step.answer).correct) failedLines.push(`answer "${step.answer}" was not accepted`);
        continue;
      }
      const line = typeof step === 'string' ? step : step.laptop ?? `nano ${step.nano}`;
      const r = session.run(line, step.laptop ? 'laptop' : 'cluster');
      if (typeof step === 'object' && step.nano) {
        if (!r.edit) failedLines.push(`"${line}" did not open the editor`);
        else session.save(r.edit.path, step.text);
      }
      if (r.output.some((s) => s.cls === 'err')) failedLines.push(`"${line}" printed an error: ${r.output.filter((s) => s.cls === 'err').map((s) => s.text.trim()).join(' ')}`);
    }
    if (!session.complete) {
      const stuck = session.tasks[session.current];
      errors.push(`seed ${seed}: the solution doesn't finish the scenario (stuck on "${stuck.text}")${failedLines.length ? '. ' + failedLines[0] : ''}`);
      break;
    }
    if (failedLines.length && !warnings.length) warnings.push(`solution ${failedLines[0]}`);
  }
  return { errors, warnings };
}
