import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cloneCopy, diffCopies, addScenario, removeScenario, moveScenario, blankScenario,
  makeBundle, mergeImport, makeZip, parseCSV, detectColumns, gradeRows, gradesCSV,
  addToHistory, emptyHistory, keywordTerms,
} from '../js/admin-core.js';
import { makePassphrase } from '../engine/passphrase.js';

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

test('Canvas CSVs are graded by track keyword, and copies are flagged', () => {
  const tracks = manifest.tracks;
  const ids = tracks.map((t) => t.id);
  const kw = Object.fromEntries(tracks.map((t) => [t.id, t.keyword]));
  const nav = makePassphrase(kw.navigate);
  const find = makePassphrase(kw.find);
  const read = makePassphrase(kw.read);
  const csv = [
    'name,id,sis_id,section,"1: Navigate passphrase",1,"2: Find files passphrase",2',
    `"Lovelace, Ada",11,830111222,A,${nav},1,${find},1`,
    `Turing,12,830999000,A,${nav.toUpperCase().replace(/-/g, ' ')},1,"${read}",1`,
    'Hopper,13,830555444,A,,0,,0',
    `Curie,14,830777666,A,${kw.manage}-foo-bar-baz,1,,0`,
  ].join('\n');
  const [header, ...rows] = parseCSV(csv);
  const cols = detectColumns(header, rows, Object.values(kw));
  assert.deepEqual(cols, { id: 2, name: 0, phrases: [4, 6] });
  const results = gradeRows(rows, cols, tracks, { term: 'Fall 2026' });
  assert.equal(results[0].name, 'Lovelace, Ada');
  assert.deepEqual(results[0].tracks, ['navigate', 'find']);
  assert.match(results[0].note, /Navigate: same words as Turing/);
  assert.deepEqual(results[1].tracks, ['navigate', 'read']);
  assert.match(results[1].note, /same words as Lovelace, Ada/);
  assert.equal(results[2].note, 'No passphrase');
  assert.deepEqual(results[3].tracks, ['manage']);
  assert.match(results[3].note, /not site words \(foo, bar, baz\)/);
  assert.match(gradesCSV(results, ids), /^name,id,tracks_completed,session/);

  // The history file remembers this term; next term the same words are flagged.
  const { history, added } = addToHistory(emptyHistory(), results, { term: 'Fall 2026', tracks, date: '2026-12-15' });
  assert.equal(added, 5);
  assert.equal(addToHistory(history, results, { term: 'Fall 2026', tracks, date: '2026-12-16' }).added, 0);
  assert.deepEqual(keywordTerms(history, kw.navigate, 'Spring 2027'), ['Fall 2026']);
  const later = gradeRows([['Babbage', find]], { id: -1, name: 0, phrases: [1] }, tracks, { term: 'Spring 2027', history: history.entries });
  assert.match(later[0].note, /words already used in Fall 2026 by Lovelace, Ada/);
});
