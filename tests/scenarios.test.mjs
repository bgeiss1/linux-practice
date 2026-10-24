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
