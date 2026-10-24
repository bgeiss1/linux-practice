// Logic behind the instructor dashboard that doesn't touch the page:
// comparing drafts with the live site, import/export bundles, a tiny zip
// writer, and reading Canvas exports. Kept separate so tests can run it.

import { verify, WORDS } from '../engine/passphrase.js';

// ---------- working copy ----------

// A "copy" is { manifest, files } where files maps "track/NN-name" to a scenario.
export function cloneCopy(copy) {
  return { manifest: structuredClone(copy.manifest), files: Object.fromEntries(Object.entries(copy.files).map(([k, v]) => [k, structuredClone(v)])) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What publishing would change: scenario files added, changed, removed, and
// whether tracks.json changed (order, titles, salt).
export function diffCopies(published, work) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [path, def] of Object.entries(work.files)) {
    if (!(path in published.files)) added.push(path);
    else if (!same(def, published.files[path])) changed.push(path);
  }
  for (const path of Object.keys(published.files)) if (!(path in work.files)) removed.push(path);
  const strip = (m) => ({ ...m, version: undefined });
  const manifestChanged = !same(strip(published.manifest), strip(work.manifest));
  return { added, changed, removed, manifestChanged, count: added.length + changed.length + removed.length + (manifestChanged ? 1 : 0) };
}

export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scenario';
}

// A file path for a new scenario in a track, e.g. "bash/13-loop-again".
export function newPath(work, track, title) {
  const t = work.manifest.tracks.find((x) => x.id === track);
  const n = (t?.scenarios.length ?? 0) + 1;
  let path = `${track}/${String(n).padStart(2, '0')}-${slugify(title)}`;
  while (path in work.files) path += '-2';
  return path;
}

// Keep each scenario's "order" in step with its place in the track list.
export function renumber(work, trackId) {
  const t = work.manifest.tracks.find((x) => x.id === trackId);
  t.scenarios.forEach((path, i) => {
    const def = work.files[path];
    if (def && def.order !== i + 1) def.order = i + 1;
  });
}

export function addScenario(work, def) {
  const path = newPath(work, def.track, def.title);
  work.files[path] = def;
  work.manifest.tracks.find((x) => x.id === def.track).scenarios.push(path);
  renumber(work, def.track);
  return path;
}

export function removeScenario(work, path) {
  const def = work.files[path];
  delete work.files[path];
  for (const t of work.manifest.tracks) {
    const i = t.scenarios.indexOf(path);
    if (i >= 0) t.scenarios.splice(i, 1);
  }
  if (def) renumber(work, def.track);
}

export function moveScenario(work, path, delta) {
  const t = work.manifest.tracks.find((x) => x.scenarios.includes(path));
  const i = t.scenarios.indexOf(path);
  const j = i + delta;
  if (j < 0 || j >= t.scenarios.length) return;
  [t.scenarios[i], t.scenarios[j]] = [t.scenarios[j], t.scenarios[i]];
  renumber(work, t.id);
}

export function blankScenario(track, id) {
  return {
    id,
    track,
    order: 1,
    tier: 1,
    title: 'New scenario',
    story: 'Describe the situation and what the student should do.',
    vars: { project: ['binder_design', 'il7r_binders'] },
    machines: { cluster: { cwd: '~', files: { '~/{{project}}/notes.txt': 'Hello from {{project}}\n' } } },
    tasks: [{ text: 'Go into {{project}}', check: { cwd: '~/{{project}}' } }],
    hints: ['`cd NAME` moves into a folder.', '`cd {{project}}`', 'Type `cd {{project}}` and press Enter.'],
    solution: ['cd {{project}}'],
  };
}

// ---------- bundles ----------

export const BUNDLE_FORMAT = 'linux-practice-bundle';

// Everything, or one track: { format, tracks: [...track entries], salt, scenarios: { path: def } }.
export function makeBundle(work, trackId = null) {
  const tracks = work.manifest.tracks.filter((t) => !trackId || t.id === trackId);
  const scenarios = {};
  for (const t of tracks) for (const p of t.scenarios) scenarios[p] = work.files[p];
  return { format: BUNDLE_FORMAT, version: 1, salt: trackId ? undefined : work.manifest.passphraseSalt, tracks: structuredClone(tracks), scenarios: structuredClone(scenarios) };
}

// Merge an uploaded bundle or single scenario into a copy of the work.
// Returns { next, added, changed, removed, errors }.
export function mergeImport(work, data) {
  const next = cloneCopy(work);
  const added = [];
  const changed = [];
  const removed = [];
  const errors = [];
  const put = (path, def) => {
    if (!(path in next.files)) added.push(path);
    else if (!same(next.files[path], def)) changed.push(path);
    next.files[path] = def;
  };
  if (data?.format === BUNDLE_FORMAT) {
    for (const t of data.tracks ?? []) {
      const mine = next.manifest.tracks.find((x) => x.id === t.id);
      if (!mine) {
        errors.push(`Unknown track "${t.id}" skipped. Tracks are fixed because each one earns a passphrase word.`);
        continue;
      }
      for (const p of mine.scenarios) if (!t.scenarios.includes(p)) { removed.push(p); delete next.files[p]; }
      for (const p of t.scenarios) {
        if (!data.scenarios?.[p]) { errors.push(`${p} is listed but missing from the file`); continue; }
        put(p, data.scenarios[p]);
      }
      Object.assign(mine, { title: t.title ?? mine.title, blurb: t.blurb ?? mine.blurb, commands: t.commands ?? mine.commands, scenarios: t.scenarios.filter((p) => data.scenarios?.[p]) });
    }
    if (data.salt) next.manifest.passphraseSalt = data.salt;
  } else if (data && typeof data === 'object' && data.id && data.track) {
    const t = next.manifest.tracks.find((x) => x.id === data.track);
    if (!t) errors.push(`Unknown track "${data.track}".`);
    else {
      const existing = Object.keys(next.files).find((p) => next.files[p].id === data.id);
      if (existing) put(existing, data);
      else {
        const path = newPath(next, data.track, data.title ?? data.id);
        put(path, data);
        t.scenarios.push(path);
        renumber(next, t.id);
      }
    }
  } else {
    errors.push('This file is not a scenario or a Linux Practice bundle.');
  }
  return { next, added, changed, removed, errors };
}

// ---------- zip (stored, no compression) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ path, text }] -> Uint8Array of a .zip
export function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const data = enc.encode(f.text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

// ---------- class progress ----------

// RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export function toCSV(rows) {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n') + '\n';
}

const WORD_SET = new Set(WORDS);

function looksLikePhrase(cell) {
  const words = String(cell).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.length > 0 && words.filter((w) => WORD_SET.has(w)).length / words.length >= 0.5;
}

// Guess which columns hold the ID, the name, and the passphrase.
export function detectColumns(header, rows) {
  const find = (re) => header.findIndex((h) => re.test(h.trim()));
  let id = find(/^(sis[ _]?(user[ _]?)?id|csu[ _]?id|student[ _]?id)$/i);
  if (id < 0) id = find(/sis|csu.?id|student.?id|^id$/i);
  let name = find(/^(name|student|student name)$/i);
  if (name < 0) name = find(/name/i);
  let phrase = -1;
  let best = 0;
  header.forEach((_, c) => {
    const hits = rows.filter((r) => looksLikePhrase(r[c] ?? '')).length;
    if (hits > best) { best = hits; phrase = c; }
  });
  return { id, name, phrase };
}

// One result per student row: which tracks their passphrase proves.
export function gradeRows(rows, cols, trackIds, salt) {
  return rows
    .filter((r) => String(r[cols.id] ?? '').trim())
    .map((r) => {
      const id = String(r[cols.id]).trim();
      const given = String(r[cols.phrase] ?? '').trim();
      const { tracks, unknown } = verify(id, trackIds, salt, given);
      let note = '';
      if (!given) note = 'No passphrase';
      else if (!tracks.length && unknown.some((w) => WORD_SET.has(w))) note = 'Words are real but not this ID\'s. Check which ID the student typed.';
      else if (unknown.length) note = `Not recognized: ${unknown.join(', ')}`;
      return { name: cols.name >= 0 ? String(r[cols.name] ?? '') : '', id, given, tracks, note };
    });
}

export function gradesCSV(results, trackIds) {
  return toCSV([
    ['name', 'id', 'tracks_completed', ...trackIds, 'passphrase', 'note'],
    ...results.map((r) => [r.name, r.id, r.tracks.length, ...trackIds.map((t) => (r.tracks.includes(t) ? 1 : 0)), r.given, r.note]),
  ]);
}

// ---------- GitHub ----------

// "owner/repo" when the dashboard is served from GitHub Pages.
export function repoFromLocation(loc) {
  const m = loc.hostname.match(/^([\w-]+)\.github\.io$/i);
  const repo = loc.pathname.split('/').filter(Boolean)[0];
  return m && repo && !repo.endsWith('.html') ? `${m[1]}/${repo}` : null;
}

// Base64 of UTF-8 text, as the GitHub contents API returns it.
export function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function scenarioText(def) {
  return JSON.stringify(def, null, 2) + '\n';
}
