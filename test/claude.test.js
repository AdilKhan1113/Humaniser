import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequest, withFallback, MODEL, EFFORT_LEVELS } from '../lib/claude.js';
import { HOUSE_STYLE, buildUserMessage } from '../lib/prompt.js';

// These assert the request shape rather than making a call. Several of them
// guard against parameters Opus 5 rejects outright with a 400, which is the
// kind of mistake that is cheap to catch here and expensive to catch live.

test('targets the current Opus model', () => {
  assert.equal(MODEL, 'claude-opus-5');
  assert.equal(buildRequest({ text: 'hi' }).model, 'claude-opus-5');
});

test('sends no sampling parameters, which this model rejects', () => {
  const request = buildRequest({ text: 'hi' });
  for (const banned of ['temperature', 'top_p', 'top_k', 'budget_tokens']) {
    assert.equal(banned in request, false, `${banned} must not be sent`);
  }
});

test('asks for adaptive thinking with a summary', () => {
  const { thinking } = buildRequest({ text: 'hi' });
  assert.deepEqual(thinking, { type: 'adaptive', display: 'summarized' });
});

test('effort is validated and defaults to high', () => {
  assert.equal(buildRequest({ text: 'hi' }).output_config.effort, 'high');
  assert.equal(buildRequest({ text: 'hi', effort: 'low' }).output_config.effort, 'low');
  assert.equal(buildRequest({ text: 'hi', effort: 'nonsense' }).output_config.effort, 'high');
  for (const level of EFFORT_LEVELS) {
    assert.equal(buildRequest({ text: 'hi', effort: level }).output_config.effort, level);
  }
});

test('leaves room for a long rewrite', () => {
  assert.ok(buildRequest({ text: 'hi' }).max_tokens >= 16000);
});

test('caches the house style, since it never varies', () => {
  const { system } = buildRequest({ text: 'hi' });
  assert.equal(system.length, 1);
  assert.equal(system[0].text, HOUSE_STYLE);
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
});

test('keeps the variable parts out of the cached prefix', () => {
  const a = buildRequest({ text: 'one', strength: 'bold', notes: 'keep it short' });
  const b = buildRequest({ text: 'two', strength: 'light' });
  assert.equal(a.system[0].text, b.system[0].text);
  assert.notEqual(a.messages[0].content, b.messages[0].content);
});

test('wraps the text in markers and asks for the rewrite alone', () => {
  const message = buildUserMessage({ text: 'Hello there.' });
  assert.match(message, /<text>\nHello there\.\n<\/text>/);
  assert.match(message, /Return the rewrite alone/);
});

test('passes the writer audience and notes through', () => {
  const message = buildUserMessage({ text: 'x', audience: 'nurses', notes: 'no jokes' });
  assert.match(message, /Written for: nurses/);
  assert.match(message, /no jokes/);
});

test('opts into server-side refusal fallback with the matching beta', () => {
  const request = withFallback(buildRequest({ text: 'hi' }));
  assert.deepEqual(request.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(request.fallbacks, 'default');
});

test('the house style states the rules the offline engine cannot check', () => {
  for (const rule of [/active voice/i, /burstiness/i, /contractions/i, /6 and 20/, /No self-references/i]) {
    assert.match(HOUSE_STYLE, rule);
  }
  assert.match(HOUSE_STYLE, /Return only the rewritten text/);
});
