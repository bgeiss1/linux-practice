import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressFile, readProgressFile, mergeProgress, emptyProgress } from '../js/progress.js';

test('progress files round-trip and refuse other files', () => {
  const p = { done: { a: { stars: 2, at: 'x' } }, phrases: { nav: { keyword: 'otter', phrase: 'otter-a-b-c' } }, lessons: { 'nav/cd': { at: 'y' } } };
  assert.deepEqual(readProgressFile(progressFile(p)), p);
  assert.throws(() => readProgressFile('not json'), /progress file/);
  assert.throws(() => readProgressFile('{"format":"linux-practice-bundle"}'), /progress file/);
  assert.deepEqual(readProgressFile('{"format":"linux-practice-progress","done":[]}'), emptyProgress());
});

test('restoring merges without losing anything', () => {
  const mine = { done: { a: { stars: 1 }, b: { stars: 3 } }, phrases: { nav: { phrase: 'mine' } }, lessons: { x: {} } };
  const file = { done: { a: { stars: 3 }, b: { stars: 1 }, c: { stars: 2 } }, phrases: { nav: { phrase: 'theirs' }, find: { phrase: 'f' } }, lessons: { y: {} } };
  const m = mergeProgress(mine, file);
  assert.deepEqual(Object.fromEntries(Object.entries(m.done).map(([k, v]) => [k, v.stars])), { a: 3, b: 3, c: 2 });
  assert.equal(m.phrases.nav.phrase, 'mine');
  assert.equal(m.phrases.find.phrase, 'f');
  assert.deepEqual(Object.keys(m.lessons).sort(), ['x', 'y']);
});
