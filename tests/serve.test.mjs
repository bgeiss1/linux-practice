import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, gitStatus, publishLive } from '../serve.mjs';

async function withServer(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'lp-serve-'));
  await mkdir(path.join(root, 'scenarios/basics'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<h1>hi</h1>');
  await writeFile(path.join(root, 'scenarios/basics/01-old.json'), '{}');
  const server = createServer(root).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, root);
  } finally {
    server.close();
  }
}

const save = (base, body) => fetch(`${base}/__local/save`, { method: 'POST', body: JSON.stringify(body) });

test('serves files and says it is local', async () => {
  await withServer(async (base) => {
    assert.equal(await (await fetch(`${base}/`)).text(), '<h1>hi</h1>');
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status, 403);
    assert.deepEqual((await (await fetch(`${base}/__local`)).json()).local, true);
  });
});

test('saves and removes scenario files', async () => {
  await withServer(async (base, root) => {
    const res = await save(base, { write: { 'scenarios/tracks.json': '{"version":2}\n', 'scenarios/basics/02-new.json': '{"title":"x"}\n' }, remove: ['scenarios/basics/01-old.json'] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).saved, 3);
    assert.equal(await readFile(path.join(root, 'scenarios/basics/02-new.json'), 'utf8'), '{"title":"x"}\n');
    await assert.rejects(access(path.join(root, 'scenarios/basics/01-old.json')));
  });
});

test('saves tutorial files', async () => {
  await withServer(async (base, root) => {
    const res = await save(base, { write: { 'tutorials/navigate.json': '{"track":"navigate","lessons":[]}\n' } });
    assert.equal(res.status, 200);
    assert.match(await readFile(path.join(root, 'tutorials/navigate.json'), 'utf8'), /navigate/);
    assert.equal((await save(base, { write: { 'tutorials/a/b.json': '{}' } })).status, 400);
  });
});

test('refuses anything but scenario JSON', async () => {
  await withServer(async (base, root) => {
    for (const body of [{ write: { 'index.html': 'x' } }, { write: { 'scenarios/../serve.mjs': '{}' } }, { remove: ['scenarios/basics'] }, { write: { 'scenarios/a/b.json': 'not json' } }]) {
      assert.equal((await save(base, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), '<h1>hi</h1>');
  });
});

test('publishes saved content to main and local-sync through git', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'lp-git-'));
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const mine = path.join(base, 'mine');
  g(base, 'init', '--quiet', '--bare', '-b', 'main', origin);
  g(base, 'init', '--quiet', '-b', 'main', seed);
  g(seed, 'config', 'user.email', 't@example.com');
  g(seed, 'config', 'user.name', 'T');
  await mkdir(path.join(seed, 'scenarios'), { recursive: true });
  await writeFile(path.join(seed, 'scenarios/tracks.json'), '{"version":1}\n');
  await writeFile(path.join(seed, 'app.js'), 'old\n');
  g(seed, 'add', '-A');
  g(seed, 'commit', '--quiet', '-m', 'seed');
  g(seed, 'remote', 'add', 'origin', origin);
  g(seed, 'push', '--quiet', 'origin', 'main', 'main:local-sync');
  g(base, 'clone', '--quiet', '-b', 'local-sync', origin, mine);
  g(mine, 'config', 'user.email', 'b@example.com');
  g(mine, 'config', 'user.name', 'B');
  // Someone else updates main on GitHub (like a merged pull request).
  await writeFile(path.join(seed, 'README.md'), 'hi\n');
  g(seed, 'add', '-A');
  g(seed, 'commit', '--quiet', '-m', 'readme');
  g(seed, 'push', '--quiet', 'origin', 'main');
  // The dashboard saved a change here.
  await writeFile(path.join(mine, 'scenarios/tracks.json'), '{"version":2}\n');
  await mkdir(path.join(mine, 'tutorials'));
  await writeFile(path.join(mine, 'tutorials/navigate.json'), '{}\n');
  const before = await gitStatus(mine);
  assert.deepEqual(before.files.sort(), ['scenarios/tracks.json', 'tutorials/navigate.json']);
  assert.equal(before.behind, 1);
  const r = await publishLive(mine);
  assert.equal(r.committed, 2);
  for (const b of ['main', 'local-sync']) {
    assert.equal(g(origin, 'show', `${b}:scenarios/tracks.json`), '{"version":2}\n');
    assert.equal(g(origin, 'show', `${b}:README.md`), 'hi\n');
  }
  const after = await gitStatus(mine);
  assert.deepEqual(after.files, []);
  assert.equal(after.ahead, 0);
  // Publishing again with nothing new is harmless.
  assert.equal((await publishLive(mine)).committed, 0);
});
