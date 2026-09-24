import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The real server, with OpenAlex answered from fixtures by a preload, so the
// routes are exercised end to end without touching the network.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8898;
const base = `http://127.0.0.1:${PORT}`;
let server;

test.before(async () => {
  server = spawn(process.execPath, ['--import', './test/fixtures/offline-scholar.js', 'server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', HUMANISER_PROVIDER: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the server never came up');
});

test.after(() => { if (server) server.kill(); });

test('one page carries both tools, and the old address still works', async () => {
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /id="view-research"/);
  assert.match(page, /id="view-rewriter"/);
  assert.match(page, /src="research\.js"/);
  const old = await fetch(`${base}/research`, { redirect: 'manual' });
  assert.equal(old.status, 302);
  assert.equal(old.headers.get('location'), '/#research');
});

test('serves the shared modules', async () => {
  for (const mod of ['cite', 'overlap', 'sentences', 'insights']) {
    const res = await fetch(`${base}/shared/${mod}.js`);
    assert.equal(res.status, 200, mod);
    assert.match(res.headers.get('content-type'), /javascript/);
  }
  assert.equal((await fetch(`${base}/shared/scholar.js`)).status, 404, 'only the allowlisted modules are exposed');
});

test('search answers with normalised works', async () => {
  const res = await fetch(`${base}/api/research/search?q=${encodeURIComponent('Does sleep affect memory?')}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.interpreted.mode, 'question');
  assert.equal(data.results[0].id, 'W1001');
  assert.ok(Array.isArray(data.results[0].evidence));
});

test('search without a query is a 400', async () => {
  const res = await fetch(`${base}/api/research/search?q=`);
  assert.equal(res.status, 400);
});

test('related, citing and single-work lookups', async () => {
  const rel = await (await fetch(`${base}/api/research/connected?id=W1001&kind=related`)).json();
  assert.deepEqual(rel.results.map((w) => w.id), ['W1002', 'W1003']);
  const one = await (await fetch(`${base}/api/research/work?id=W1003`)).json();
  assert.equal(one.work.venue, 'SLEEP');
  const bad = await fetch(`${base}/api/research/connected?id=W1001&kind=sideways`);
  assert.equal(bad.status, 400);
});

test('offline paraphrase over HTTP, and the model path needs a key', async () => {
  const post = (body) => fetch(`${base}/api/research/paraphrase`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const ok = await post({ text: 'We found that sleep restriction reduced accuracy.' });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.ok(data.variants.length >= 1);
  assert.match(data.variants[0].text, /the authors/i);

  const tooLong = await post({ text: 'word '.repeat(1000) });
  assert.equal(tooLong.status, 413);

  const model = await post({ text: 'We found that sleep helps.', engine: 'model' });
  const body = await model.text();
  assert.match(body, /NO_CREDENTIALS|No model API key/);
});

test('answers need a key, and say so', async () => {
  const res = await fetch(`${base}/api/research/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Does sleep help memory?', works: [{ id: 'W1', title: 'T', abstract: 'A' }] }),
  });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /API key/);
  const empty = await fetch(`${base}/api/research/synthesize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'x', works: [] }),
  });
  assert.equal(empty.status, 400);
});

test('full text: a free PDF is found and read, an upload is read, a non-PDF is refused', async () => {
  const free = await fetch(`${base}/api/research/fulltext?id=W1001`);
  assert.equal(free.status, 200);
  const ft = await free.json();
  assert.equal(ft.via, 'open access');
  assert.ok(ft.sections.some((s) => s.kind === 'results'));

  const none = await fetch(`${base}/api/research/fulltext?id=W1002`);
  assert.equal(none.status, 404);

  const pdf = fs.readFileSync(path.join(root, 'test', 'fixtures', 'paper.pdf'));
  const up = await fetch(`${base}/api/research/fulltext/upload`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdf });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).via, 'upload');

  const bad = await fetch(`${base}/api/research/fulltext/upload`, { method: 'POST', body: 'hello' });
  assert.equal(bad.status, 422);
});

test('an uploaded paper is identified, and papers on its topic come back', async () => {
  const pdf = fs.readFileSync(path.join(root, 'test', 'fixtures', 'paper.pdf'));
  const up = await (await fetch(`${base}/api/research/fulltext/upload?identify=1`, { method: 'POST', body: pdf })).json();
  assert.equal(up.work.id, 'W1001', 'matched by its title');
  assert.ok(up.terms.includes('working memory'));
  const sim = await (await fetch(`${base}/api/research/similar`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'W1001' }),
  })).json();
  assert.equal(sim.interpreted.mode, 'similar');
  assert.ok(!sim.results.some((w) => w.id === 'W1001'));
});

test('scanning and asking need a key, and say so', async () => {
  const text = 'word '.repeat(80);
  const scan = await fetch(`${base}/api/research/scan`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'T', text }),
  });
  assert.equal(scan.status, 503);
  const ask = await fetch(`${base}/api/research/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Why?', text }),
  });
  assert.match(await ask.text(), /"type":"error".*API key/);
  const empty = await fetch(`${base}/api/research/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Why?', text: '' }),
  });
  assert.equal(empty.status, 400);
});
