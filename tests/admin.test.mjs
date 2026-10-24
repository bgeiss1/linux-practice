import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cloneCopy, diffCopies, addScenario, removeScenario, moveScenario, blankScenario,
  makeBundle, mergeImport, makeZip, parseCSV, detectColumns, gradeRows, gradesCSV,
} from '../js/admin-core.js';
import { wordsFor } from '../engine/passphrase.js';

const root = new URL('../scenarios/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('tracks.json', root)));
const files = {};
for (const t of manifest.tracks) for (const p of t.scenarios) files[p] = JSON.parse(readFileSync(new URL(`${p}.json`, root)));
const live = { manifest, files };

test('edits, additions, removals and reordering show up as changes', () => {
  const work = cloneCopy(live);
  assert.equal(diffCopies(live, work).count, 0);
  const first = manifest.tracks[1].scenarios[0];
  work.files[first].title = 'Changed';
  const added = addScenario(work, blankScenario('navigate', 'navigate-new'));
  removeScenario(work, manifest.tracks[2].scenarios[0]);
  const d = diffCopies(live, work);
  assert.deepEqual(d.changed.includes(first), true);
  assert.deepEqual(d.added, [added]);
  assert.equal(d.removed.length, 1);
  assert.ok(d.manifestChanged);
  // Removing renumbers the rest of the find track.
  assert.equal(work.files[work.manifest.tracks[2].scenarios[0]].order, 1);
  moveScenario(work, added, -1);
  const nav = work.manifest.tracks[1].scenarios;
  assert.equal(nav.at(-2), added);
  assert.equal(work.files[added].order, nav.length - 1);
});

test('bundles round-trip and single scenarios import by id', () => {
  const work = cloneCopy(live);
  const bundle = makeBundle(work, 'read');
  bundle.scenarios[bundle.tracks[0].scenarios[0]].title = 'From a TA';
  const r = mergeImport(work, JSON.parse(JSON.stringify(bundle)));
  assert.deepEqual(r.errors, []);
  assert.equal(r.changed.length, 1);
  const single = { ...files[manifest.tracks[3].scenarios[2]], hints: ['new hint'] };
  const r2 = mergeImport(work, single);
  assert.equal(r2.changed.length, 1);
  const fresh = { ...blankScenario('bash', 'bash-99-fresh'), title: 'Fresh one' };
  const r3 = mergeImport(work, fresh);
  assert.equal(r3.added.length, 1);
  assert.ok(r3.next.manifest.tracks.find((t) => t.id === 'bash').scenarios.includes(r3.added[0]));
  assert.match(mergeImport(work, { hello: 1 }).errors[0], /not a scenario/);
});

test('zip files have the right structure', () => {
  const zip = makeZip([{ path: 'scenarios/a.json', text: '{}\n' }, { path: 'scenarios/b.json', text: '[]\n' }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 12, true), 2);
});

test('Canvas CSVs are graded by ID and passphrase', () => {
  const ids = manifest.tracks.map((t) => t.id);
  const w = wordsFor('830111222', ids, 'salt');
  const other = wordsFor('830999000', ids, 'salt');
  const csv = `name,id,sis_id,section,"1234: Paste your passphrase",1234\n"Lovelace, Ada",11,830111222,A,"${w.navigate}-${w.find}",1\nTuring,12,830999000,A,${other.read.toUpperCase()} ${w.find},1\nHopper,13,830555444,A,,0\n`;
  const [header, ...rows] = parseCSV(csv);
  const cols = detectColumns(header, rows);
  assert.deepEqual(cols, { id: 2, name: 0, phrase: 4 });
  const results = gradeRows(rows, cols, ids, 'salt');
  assert.equal(results[0].name, 'Lovelace, Ada');
  assert.deepEqual(results[0].tracks, ['navigate', 'find']);
  assert.deepEqual(results[1].tracks, ['read']);
  assert.match(results[1].note, /Not recognized/);
  assert.equal(results[2].note, 'No passphrase');
  assert.match(gradesCSV(results, ids), /^name,id,tracks_completed,session/);
});
