// Local web server for the practice site and the instructor dashboard.
//
//   node serve.mjs            # http://localhost:8000 and http://localhost:8000/admin.html
//   PORT=9000 node serve.mjs
//
// Serves the repo folder as-is, to this computer only. The dashboard sees it is
// running here and saves published drafts straight into scenarios/ and tutorials/ instead of
// committing them to GitHub, and keeps the passphrase history file in
// records/ (left out of git: it has student names). No packages needed, just
// Node 18 or newer.
//
// When this folder is a git clone, the dashboard can also publish to the live site:
//   GET  /__local/git      what saved changes the live site doesn't have yet
//   POST /__local/publish  commit saved scenarios/ and tutorials/, then push to main
//                          (which GitHub Pages deploys) and to local-sync.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Only these can be written: scenarios/tracks.json, scenarios/<track>/<name>.json,
// tutorials/<track>.json, and the passphrase history file.
const WRITABLE = /^(scenarios\/(tracks|[a-z0-9_-]+\/[a-z0-9_-]+)|tutorials\/[a-z0-9_-]+|records\/passphrases)\.json$/i;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Writes { write: { path: text }, remove: [path] } into root. Every path is
// checked before anything is touched, so a bad request changes nothing.
export async function saveScenarios(root, { write = {}, remove = [] }) {
  const all = [...Object.keys(write), ...remove];
  const bad = all.filter((p) => !WRITABLE.test(p));
  if (bad.length) throw new Error(`not a file the dashboard may write: ${bad.join(', ')}`);
  for (const [p, text] of Object.entries(write)) {
    if (p.endsWith('.json')) JSON.parse(text); // refuse to save broken JSON
    const abs = path.join(root, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  }
  for (const p of remove) await fs.rm(path.join(root, p), { force: true });
  return all.length;
}

// ---------- publishing through git ----------

const LIVE = 'main'; // GitHub Pages deploys this branch
const SYNC = 'local-sync'; // the branch this copy is kept in step with
const CONTENT = ['scenarios', 'tutorials'];

function git(root, args) {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd: root, timeout: 120000 }, (e, out, err) => (e ? reject(new Error(String(err || out || e.message).trim())) : resolve(String(out)))),
  );
}

const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

// What publishing would send: saved content files that differ from the live
// site, and how many commits of site code come along.
export async function gitStatus(root, { fetch = true } = {}) {
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { git: false };
  }
  let fetched = true;
  if (fetch) {
    try {
      await git(root, ['fetch', '--quiet', 'origin', LIVE]);
    } catch {
      fetched = false;
    }
  }
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  let files = [];
  let behind = 0;
  let ahead = 0;
  try {
    files = lines(await git(root, ['diff', '--name-only', `origin/${LIVE}`, '--', ...CONTENT]));
    ahead = Number((await git(root, ['rev-list', '--count', `origin/${LIVE}..HEAD`])).trim());
    behind = Number((await git(root, ['rev-list', '--count', `HEAD..origin/${LIVE}`])).trim());
  } catch {
    // No origin/main yet.
  }
  const untracked = lines(await git(root, ['ls-files', '--others', '--exclude-standard', '--', ...CONTENT]));
  files = [...new Set([...files, ...untracked])];
  const code = ahead ? lines(await git(root, ['diff', '--name-only', `origin/${LIVE}`, 'HEAD'])).filter((f) => !CONTENT.some((c) => f.startsWith(`${c}/`))).length : 0;
  return { git: true, fetched, branch, files, ahead, behind, codeFiles: code };
}

// Commits saved content, brings in anything newer on GitHub, and pushes to the
// live branch and the sync branch. Stops without pushing if the two copies
// can't be combined automatically.
export async function publishLive(root, { message = 'Update scenarios and lessons from the dashboard' } = {}) {
  await git(root, ['rev-parse', '--is-inside-work-tree']);
  const email = await git(root, ['config', 'user.email']).catch(() => '');
  if (!email.trim()) throw new Error('git doesn\'t know who you are yet, so it can\'t make a commit. In Terminal, in the site folder, run: git config user.name "Your Name" and git config user.email "you@example.com", then publish again.');
  await git(root, ['add', '-A', '--', ...CONTENT]);
  const staged = lines(await git(root, ['diff', '--cached', '--name-only', '--', ...CONTENT]));
  if (staged.length) await git(root, ['commit', '--quiet', '-m', message, '--', ...CONTENT]);
  for (const b of [LIVE, SYNC]) {
    try {
      await git(root, ['fetch', '--quiet', 'origin', b]);
    } catch {
      continue; // that branch doesn't exist on GitHub yet
    }
    try {
      await git(root, ['merge-base', '--is-ancestor', `origin/${b}`, 'HEAD']);
    } catch {
      try {
        await git(root, ['merge', '--quiet', '--no-edit', `origin/${b}`]);
      } catch (e) {
        await git(root, ['merge', '--abort']).catch(() => {});
        throw new Error(`Your copy and GitHub's ${b} branch both changed the same files, so nothing was pushed. (${e.message.split('\n')[0]})`);
      }
    }
  }
  await git(root, ['push', '--quiet', 'origin', `HEAD:${LIVE}`, `HEAD:${SYNC}`]);
  const commit = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
  const remote = (await git(root, ['remote', 'get-url', 'origin'])).trim();
  const repo = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1] ?? null;
  return { committed: staged.length, commit, repo };
}

export function createServer(root) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/__local') return send(res, 200, { local: true, root });
      if (url.pathname === '/__local/save') {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
        const n = await saveScenarios(root, JSON.parse(await readBody(req)));
        return send(res, 200, { saved: n });
      }
      if (url.pathname === '/__local/git') return send(res, 200, await gitStatus(root));
      if (url.pathname === '/__local/publish') {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
        const body = JSON.parse((await readBody(req)) || '{}');
        return send(res, 200, await publishLive(root, { message: body.message || undefined }));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'read only' });
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const abs = path.join(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
      const body = await fs.readFile(abs);
      send(res, 200, req.method === 'HEAD' ? '' : body, TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') return send(res, 404, 'not found', 'text/plain');
      send(res, 400, { error: e.message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const port = Number(process.env.PORT) || 8000;
  createServer(root).listen(port, '127.0.0.1', () => {
    console.log(`Practice site:         http://localhost:${port}/`);
    console.log(`Instructor dashboard:  http://localhost:${port}/admin.html`);
    console.log('Publishing from the dashboard saves into scenarios/ and tutorials/ on this computer. Ctrl+C stops the server.');
  });
}
