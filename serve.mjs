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

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
