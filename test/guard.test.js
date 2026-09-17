import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These run a real server with a code and a low limit, because the protections
// only mean anything end to end.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8951;
const base = `http://127.0.0.1:${PORT}`;
const CODE = 'test-code-123';

let server;

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key',
      HUMANISER_ACCESS_CODE: CODE,
      RATE_LIMIT_CLAUDE: '3',
      RATE_LIMIT_AUTH: '5',
      TRUST_PROXY: '1',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the server never came up');
});

test.after(() => { if (server) server.kill(); });

const claude = (headers = {}) => fetch(`${base}/api/humanise/model`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ text: 'The report was written by Sarah.' }),
});

test('answers a health check', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('says a code is required without revealing it', async () => {
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.model.accessCodeRequired, true);
  assert.equal(JSON.stringify(status).includes(CODE), false);
  assert.equal(status.limits.claude, 3);
});

test('the key and the code never reach the browser', async () => {
  for (const route of ['/', '/app.js', '/styles.css', '/api/status']) {
    const body = await (await fetch(`${base}${route}`)).text();
    assert.equal(body.includes('sk-ant-not-a-real-key'), false, route);
    assert.equal(body.includes(CODE), false, route);
  }
});

test('model mode refuses a missing or wrong code', async () => {
  assert.equal((await claude()).status, 401);
  assert.equal((await claude({ 'x-access-code': 'wrong' })).status, 401);
});

test('a wrong code does not consume the model allowance', async () => {
  // Five rejected attempts, on their own client identity.
  const ip = '10.0.0.1';
  for (let i = 0; i < 5; i += 1) {
    await claude({ 'x-access-code': 'wrong', 'x-forwarded-for': ip });
  }
  // The limit is 3, and it should still be fully available.
  const codes = [];
  for (let i = 0; i < 4; i += 1) {
    codes.push((await claude({ 'x-access-code': CODE, 'x-forwarded-for': ip })).status);
  }
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200], 'three should have been allowed');
  assert.equal(codes[3], 429, 'the fourth should hit the limit');
});

test('the hourly limit is per client', async () => {
  const other = '10.0.0.2';
  assert.equal((await claude({ 'x-access-code': CODE, 'x-forwarded-for': other })).status, 200);
});

test('a path that is not a valid URL gets a 400 and does not kill the server', async () => {
  // "//" makes new URL throw. Outside a try that became an unhandled
  // rejection, which ended the process: one request took the site down.
  for (const bad of ['//', '///']) {
    assert.equal((await fetch(`${base}${bad}`)).status, 400, bad);
  }
  assert.equal((await fetch(`${base}/healthz`)).status, 200, 'still serving');
});

test('a junk Host header does not kill the server either', async () => {
  const res = await fetch(`${base}/`, { headers: { host: 'not a host!!' } });
  assert.ok(res.status === 400 || res.status === 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200, 'still serving');
});

test('survives hostile paths', async () => {
  for (const bad of ['/../../.env', '/api/../server.js', '/%%%', '/api/humanise/../../package.json']) {
    const res = await fetch(`${base}${bad}`);
    assert.ok(res.status === 403 || res.status === 404 || res.status === 400, `${bad} gave ${res.status}`);
    assert.doesNotMatch(await res.text(), /ANTHROPIC_API_KEY|createServer/);
  }
  assert.equal((await fetch(`${base}/healthz`)).status, 200, 'still serving');
});
