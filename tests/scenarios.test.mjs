// Every scenario must be well formed and solvable by its reference solution
// for many random draws. GitHub Actions runs this before the site updates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate } from '../engine/validate.js';

const root = new URL('../scenarios/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('tracks.json', root)));
const seen = new Set();

for (const track of manifest.tracks) {
  for (const path of track.scenarios) {
    test(`${path}`, () => {
      const def = JSON.parse(readFileSync(new URL(`${path}.json`, root)));
      assert.equal(def.track, track.id, 'scenario "track" must match the track it is listed under');
      assert.ok(!seen.has(def.id), `duplicate scenario id ${def.id}`);
      seen.add(def.id);
      const { errors } = validate(def, { seeds: 25 });
      assert.deepEqual(errors, []);
    });
  }
}

test('track ids are unique', () => {
  const ids = manifest.tracks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every track has its own usable passphrase keyword', async () => {
  const { keywordProblem } = await import('../engine/passphrase.js');
  const kws = manifest.tracks.map((t) => t.keyword);
  manifest.tracks.forEach((t, i) => assert.equal(keywordProblem(t.keyword, kws.filter((_, j) => j !== i)), '', t.id));
  assert.ok(manifest.term, 'tracks.json names the term');
});

test('answers go in the answer box, not the terminal', async () => {
  const { Session } = await import('../engine/scenario.js');
  const def = JSON.parse(readFileSync(new URL('find/02-wildcard.json', root)));
  const s = new Session(def, { seed: 7 });
  assert.match(s.run('answer 3').output.map((o) => o.text).join(''), /command not found/);
  for (const step of s.def.solution) if (typeof step === 'string') s.run(step);
  assert.ok(s.wantsAnswer);
  assert.equal(s.submitAnswer('999').correct, false);
  assert.equal(s.submitAnswer(s.def.solution.at(-1).answer).correct, true);
  assert.ok(s.complete);
});
