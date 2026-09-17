import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8899;
const base = `http://127.0.0.1:${PORT}`;

let server;

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: '' },
    stdio: 'ignore',
  });
  // Poll until it answers rather than sleeping a fixed amount.
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/api/status`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the server never came up');
});

test.after(() => { if (server) server.kill(); });

const postJson = (route, body) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('serves the page', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<title>Humaniser<\/title>/);
});

test('serves the stylesheet and the script', async () => {
  for (const [file, type] of [['styles.css', /text\/css/], ['app.js', /javascript/]]) {
    const res = await fetch(`${base}/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), type, file);
  }
});

test('reports what the engines can do', async () => {
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.offline, true);
  assert.equal(status.claude.model, 'claude-opus-5');
  assert.deepEqual(status.claude.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(status.profiles.length, 3);
});

test('scores text without changing it', async () => {
  const res = await postJson('/api/analyze', { text: 'It is important to note that the data was analyzed by the committee.' });
  assert.equal(res.status, 200);
  const { report } = await res.json();
  assert.ok(report.score >= 0 && report.score <= 100);
  assert.ok(report.issues.length > 0);
});

test('rewrites and returns both reports', async () => {
  const res = await postJson('/api/humanise', {
    text: 'It is important to note that the report was written by Sarah, and we do not have the data.',
    strength: 'balanced',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.text, /Sarah wrote the report/);
  assert.match(body.text, /don't/);
  assert.ok(body.changes.length > 0);
  assert.ok(body.after.score > body.before.score);
  assert.equal(body.profile, 'balanced');
});

test('rejects empty text', async () => {
  const res = await postJson('/api/analyze', { text: '   ' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /text/i);
});

test('rejects malformed JSON', async () => {
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

test('rejects text beyond the size limit', async () => {
  const res = await postJson('/api/analyze', { text: 'word '.repeat(60_000) });
  assert.equal(res.status, 413);
});

test('refuses to serve files outside public/', async () => {
  for (const attempt of ['/../server.js', '/../package.json', '/..%2Fserver.js']) {
    const res = await fetch(`${base}${attempt}`);
    assert.ok(res.status === 403 || res.status === 404, `${attempt} returned ${res.status}`);
    assert.doesNotMatch(await res.text(), /createServer/);
  }
});

test('unknown routes 404', async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await postJson('/api/nope', {})).status, 404);
});

test('claude mode fails with a clear message when there is no key', async () => {
  const res = await postJson('/api/humanise/claude', { text: 'The report was written by Sarah.' });
  assert.equal(res.status, 200); // the stream opens, then reports the failure inside
  const body = await res.text();
  assert.match(body, /^data: /m);
  const events = body.split('\n\n').filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, '')));
  const error = events.find((e) => e.type === 'error');
  assert.ok(error, `expected an error event, got ${JSON.stringify(events)}`);
  assert.match(error.message, /key|credential|auth/i);
});
