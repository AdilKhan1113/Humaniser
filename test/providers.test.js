import test from 'node:test';
import assert from 'node:assert/strict';

import * as anthropic from '../lib/providers/anthropic.js';
import * as gemini from '../lib/providers/gemini.js';
import { HOUSE_STYLE, buildUserMessage } from '../lib/prompt.js';

const { buildRequest, withFallback, MODEL, EFFORT_LEVELS } = anthropic;

// These assert each provider's request shape rather than making a call. Several
// guard against parameters the API rejects outright with a 400, which is cheap
// to catch here and expensive to catch live.

// ---------- Anthropic ----------

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
  for (const rule of [
    /active voice/i, /burstiness/i, /contractions/i, /under 10 words/, /20 words or more/,
    /three sentences of similar length/i, /paragraph size/i, /delve, tapestry, pivotal, moreover, furthermore/,
    /spearhead/, /not only X, but also Y/, /em dash/i, /first or second person/i, /sensory/i, /imperfection/i,
    /No self-references/i,
  ]) {
    assert.match(HOUSE_STYLE, rule);
  }
  assert.match(HOUSE_STYLE, /Return only the rewritten text/);
});

// ---------- Gemini ----------

test('gemini targets a model alias, so it cannot go stale', () => {
  // Google's own examples use the -latest aliases. A pinned version number
  // would 404 the week it is retired.
  assert.match(gemini.MODEL, /-latest$/);
  assert.equal(gemini.ID, 'gemini');
});

test('gemini puts the house style in systemInstruction, not in the text', () => {
  const request = gemini.buildRequest({ text: 'Draft here.' });
  assert.equal(request.systemInstruction.parts[0].text, HOUSE_STYLE);
  assert.equal(request.contents.length, 1);
  assert.equal(request.contents[0].role, 'user');
  assert.match(request.contents[0].parts[0].text, /<text>\nDraft here\.\n<\/text>/);
  // The style must not be duplicated into the user turn.
  assert.equal(request.contents[0].parts[0].text.includes(HOUSE_STYLE), false);
});

test('gemini maps the effort control onto temperature', () => {
  // Gemini has no thinking-depth dial, so the same control varies sampling.
  const at = (effort) => gemini.buildRequest({ text: 'x', effort }).generationConfig.temperature;
  assert.ok(at('low') < at('medium'));
  assert.ok(at('medium') < at('high'));
  assert.ok(at('high') < at('xhigh'));
  assert.equal(at('nonsense'), at('high'), 'an unknown level falls back to high');
  for (const level of gemini.EFFORT_LEVELS) {
    const t = at(level);
    assert.ok(t > 0 && t <= 2, `${level} gave ${t}, outside the accepted range`);
  }
});

test('gemini asks for one candidate and a real output ceiling', () => {
  const { generationConfig } = gemini.buildRequest({ text: 'x' });
  assert.equal(generationConfig.candidateCount, 1);
  assert.ok(generationConfig.maxOutputTokens >= 8192);
});

test('gemini refuses to call without a key', async () => {
  const saved = { g: process.env.GEMINI_API_KEY, o: process.env.GOOGLE_API_KEY };
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    assert.equal(gemini.hasKey(), false);
    await assert.rejects(() => gemini.rewrite({ text: 'x' }).next(), /needs an API key/);
  } finally {
    if (saved.g) process.env.GEMINI_API_KEY = saved.g;
    if (saved.o) process.env.GOOGLE_API_KEY = saved.o;
  }
});

test('both providers expose the same interface', () => {
  for (const provider of [anthropic, gemini]) {
    for (const key of ['ID', 'LABEL', 'MODEL', 'EFFORT_LABEL', 'EFFORT_LEVELS']) {
      assert.ok(provider[key] !== undefined, `${provider.ID} is missing ${key}`);
    }
    for (const fn of ['hasKey', 'rewrite', 'buildRequest']) {
      assert.equal(typeof provider[fn], 'function', `${provider.ID} is missing ${fn}()`);
    }
  }
});

test('the selector follows whichever key is set', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.HUMANISER_PROVIDER;

    // Imported fresh each time: the module reads the environment at load.
    const bust = () => `../lib/provider.js?v=${Math.random()}`;
    let mod = await import(bust());
    assert.equal(mod.providerStatus().id, null, 'no keys means no provider');
    assert.equal(mod.hasKey(), false);

    process.env.GEMINI_API_KEY = 'fake';
    mod = await import(bust());
    assert.equal(mod.providerStatus().id, 'gemini');
    assert.equal(mod.providerStatus().effortLabel, 'Variation');

    process.env.ANTHROPIC_API_KEY = 'fake';
    process.env.HUMANISER_PROVIDER = 'anthropic';
    mod = await import(bust());
    assert.equal(mod.providerStatus().id, 'anthropic', 'an explicit choice wins');
    assert.equal(mod.providerStatus().effortLabel, 'Thinking');
  } finally {
    for (const key of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'HUMANISER_PROVIDER']) {
      if (saved[key]) process.env[key] = saved[key]; else delete process.env[key];
    }
  }
});

test('a status payload never carries a key', () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'AIzaSy-super-secret-value';
  try {
    const json = JSON.stringify(gemini.buildRequest({ text: 'x' }));
    assert.equal(json.includes('AIzaSy-super-secret-value'), false);
  } finally {
    if (saved) process.env.GEMINI_API_KEY = saved; else delete process.env.GEMINI_API_KEY;
  }
});

// ---------- other tasks ----------

test('a task can bring its own instructions to either provider', () => {
  const options = { text: 'x', system: 'PARAPHRASE RULES', userMessage: 'Paraphrase this passage' };
  const a = anthropic.buildRequest(options);
  assert.equal(a.system[0].text, 'PARAPHRASE RULES');
  assert.equal(a.messages[0].content, 'Paraphrase this passage');
  const g = gemini.buildRequest(options);
  assert.equal(g.systemInstruction.parts[0].text, 'PARAPHRASE RULES');
  assert.equal(g.contents[0].parts[0].text, 'Paraphrase this passage');
  // And the rewriter's requests are unchanged.
  assert.equal(anthropic.buildRequest({ text: 'x' }).system[0].text, HOUSE_STYLE);
});

// ---------- Gemini when Google is busy ----------

function sse(text) {
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}
const busy = (status = 503, message = 'The model is overloaded. Please try again later.', details = []) => new Response(
  JSON.stringify({ error: { code: status, message, status: 'UNAVAILABLE', details } }), { status, headers: { 'content-type': 'application/json' } },
);

async function withGemini(responder, fn, { backups = null } = {}) {
  const saved = { fetch: globalThis.fetch, key: process.env.GEMINI_API_KEY, warn: console.warn, backups: process.env.GEMINI_FALLBACK_MODELS };
  const calls = [];
  process.env.GEMINI_API_KEY = 'test-key';
  if (backups) process.env.GEMINI_FALLBACK_MODELS = backups; else delete process.env.GEMINI_FALLBACK_MODELS;
  console.warn = () => {};
  gemini.setRetryTiming(1);
  globalThis.fetch = async (url) => {
    const model = decodeURIComponent(String(url).match(/models\/([^:]+):/)[1]);
    calls.push(model);
    return responder(model, calls.length);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    console.warn = saved.warn;
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.key;
    if (saved.backups === undefined) delete process.env.GEMINI_FALLBACK_MODELS; else process.env.GEMINI_FALLBACK_MODELS = saved.backups;
    gemini.setRetryTiming(1500);
  }
}

async function collect(gen) {
  const events = [];
  for await (const e of gen) events.push(e);
  return events;
}

test('gemini retries an overloaded model and gets through', async () => {
  await withGemini((model, n) => (n <= 2 ? busy() : sse('Done.')), async (calls) => {
    const events = await collect(gemini.rewrite({ text: 'x' }));
    assert.equal(events.find((e) => e.type === 'delta').text, 'Done.');
    assert.equal(calls.length, 3);
    assert.ok(calls.every((m) => m === gemini.MODEL), 'same model until it answers');
    assert.equal(events.at(-1).fallbackUsed, false);
  });
});

test('gemini uses Flash-Lite and nothing else by default', async () => {
  assert.equal(gemini.MODEL, 'gemini-flash-lite-latest');
  assert.deepEqual(gemini.fallbackModels(), []);
  await withGemini(() => busy(), async (calls) => {
    await assert.rejects(collect(gemini.rewrite({ text: 'x', model: 'gemini-pro-latest' })), /busy/);
    assert.ok(calls.length === 4 && calls.every((m) => m === 'gemini-flash-lite-latest'), calls.join(','));
  });
});

test('gemini moves to a backup model only when backups are listed', async () => {
  await withGemini((model) => (model === gemini.MODEL ? busy() : sse('From the backup.')), async (calls) => {
    const events = await collect(gemini.rewrite({ text: 'x' }));
    const done = events.at(-1);
    assert.equal(done.fallbackUsed, true);
    assert.equal(calls.filter((m) => m === gemini.MODEL).length, 4, 'the main model is tried four times first');
    assert.equal(calls.at(-1), 'gemini-flash-latest');
  }, { backups: 'gemini-flash-latest,gemini-2.5-flash' });
});

test('a backup model the key cannot reach is skipped', async () => {
  const [first, second] = ['gemini-old-model', 'gemini-flash-latest'];
  await withGemini((model) => {
    if (model === gemini.MODEL) return busy();
    if (model === first) return busy(404, 'not found');
    return sse('ok');
  }, async (calls) => {
    await collect(gemini.rewrite({ text: 'x' }));
    assert.equal(calls.at(-1), second);
  }, { backups: `${first},${second}` });
});

test('when everything is busy, the message says it is Google and what to do', async () => {
  await withGemini(() => busy(), async () => {
    await assert.rejects(collect(gemini.rewrite({ text: 'x' })), (e) => /Gemini is busy right now/.test(e.message)
      && /Google's side/.test(e.message) && e.status === 503);
  });
});

test('a used-up daily quota is explained, and does not waste retries', async () => {
  const quota = () => busy(429, 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 50 per day');
  await withGemini(quota, async (calls) => {
    await assert.rejects(collect(gemini.rewrite({ text: 'x' })), /free daily allowance/);
    assert.equal(calls.filter((m) => m === gemini.MODEL).length, 1, 'no point retrying a daily limit');
  });
});

test('Google\'s requested delay is honoured and a bad key is not retried', async () => {
  const retryInfo = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' }];
  await withGemini((m, n) => (n === 1 ? busy(429, 'Resource exhausted', retryInfo) : sse('ok')), async (calls) => {
    await collect(gemini.rewrite({ text: 'x' }));
    assert.equal(calls.length, 2);
  });
  await withGemini(() => busy(400, 'API key not valid.', [{ reason: 'API_KEY_INVALID' }]), async (calls) => {
    await assert.rejects(collect(gemini.rewrite({ text: 'x' })), /rejected the API key/);
    assert.equal(calls.length, 1);
  });
});
