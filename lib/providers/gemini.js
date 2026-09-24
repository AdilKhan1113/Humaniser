// The Gemini provider, spoken to over its REST API rather than through
// @google/genai.
//
// Two reasons for raw fetch. The SDK requires Node 20 and this app supports 18,
// which is what several Ubuntu releases still ship; and it pulls in protobufjs
// and google-auth-library, where the whole project otherwise has one
// dependency. The REST surface here is a JSON body and an SSE stream, which is
// little enough code to own outright.
//
// The default model is the `-latest` alias on purpose. Gemini's version numbers
// move quickly, and an alias cannot go stale the way a pinned guess does. Ask
// listModels() for what a given key can actually reach.

import { HOUSE_STYLE, buildUserMessage } from '../prompt.js';

export const ID = 'gemini';
export const LABEL = 'Gemini';
export const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

// Gemini has no thinking-depth dial, so the same control drives sampling
// temperature instead. For a rewriting job that is the knob that matters:
// higher means more varied phrasing, which is most of what burstiness is.
export const EFFORT_LABEL = 'Variation';
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

const TEMPERATURE = { low: 0.3, medium: 0.7, high: 1.0, xhigh: 1.35 };

const API_ROOT = process.env.GEMINI_API_ROOT || 'https://generativelanguage.googleapis.com/v1beta';
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 32768);

export function hasKey() {
  return Boolean(apiKey());
}

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

/**
 * Builds the request body. Separate from the call so its shape can be asserted
 * in tests without spending a token.
 */
export function buildRequest(options) {
  const effort = EFFORT_LEVELS.includes(options.effort) ? options.effort : 'high';
  return {
    // The house style is a system instruction, so it is not mistaken for text
    // to be rewritten.
    // Other tasks (research paraphrasing) bring their own instructions.
    systemInstruction: { parts: [{ text: options.system || HOUSE_STYLE }] },
    contents: [{ role: 'user', parts: [{ text: options.userMessage || buildUserMessage(options) }] }],
    generationConfig: {
      temperature: TEMPERATURE[effort],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      candidateCount: 1,
    },
  };
}

/** Lists the models this key can actually reach, newest aliases first. */
export async function listModels(signal) {
  if (!hasKey()) throw noKey();
  const res = await fetch(`${API_ROOT}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey() },
    signal,
  });
  if (!res.ok) throw await describeHttpError(res);

  const body = await res.json();
  return (body.models || [])
    // Only models that can generate text at all.
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({
      id: String(m.name || '').replace(/^models\//, ''),
      label: m.displayName || m.name,
      inputTokenLimit: m.inputTokenLimit,
      outputTokenLimit: m.outputTokenLimit,
    }))
    .filter((m) => m.id && !/embedding|aqa|imagen|veo|tts/i.test(m.id))
    .sort((a, b) => Number(b.id.endsWith('latest')) - Number(a.id.endsWith('latest')) || a.id.localeCompare(b.id));
}

// Google answers 503 "overloaded" and 429 "rate limited" often, above all on
// free-tier keys and on the newest model, which is what the -latest alias
// points at. A person pressing the button again a few seconds later usually
// gets through, so the provider does that itself: it retries with growing
// waits, honouring any delay Google asks for, then tries lighter models.
// Nothing is retried once text has started to arrive.
const RETRIES = Math.max(0, Number(process.env.GEMINI_RETRIES ?? 3));
let retryBaseMs = Number(process.env.GEMINI_RETRY_BASE_MS || 1500);
const RETRY_CAP_MS = 20000;

/** Tests shorten the waits. */
export function setRetryTiming(ms) { retryBaseMs = ms; }

/**
 * Backup models, tried in order when the main one stays busy. Each model has
 * its own free-tier quota, so a backup also helps when one is used up.
 * GEMINI_FALLBACK_MODELS=none turns this off.
 */
export function fallbackModels() {
  const raw = process.env.GEMINI_FALLBACK_MODELS;
  if (raw && raw.trim().toLowerCase() === 'none') return [];
  if (raw) return raw.split(',').map((m) => m.trim()).filter(Boolean);
  return ['gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
}

function backoff(attempt, askedMs) {
  if (askedMs) return Math.min(askedMs, RETRY_CAP_MS);
  const base = retryBaseMs * (2 ** attempt + attempt); // 1.5 s, 4.5 s, 10.5 s by default
  return Math.min(base + Math.random() * retryBaseMs * 0.3, RETRY_CAP_MS);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

/**
 * Rewrites text with Gemini, yielding events as they arrive.
 * Yields: {type:'delta', text} | {type:'done', ...}
 * Busy and rate-limited answers are retried, then passed to backup models.
 */
export async function* rewrite(options, signal) {
  if (!hasKey()) throw noKey();
  const primary = options.model || MODEL;
  const models = [primary, ...fallbackModels().filter((m) => m !== primary)];
  let lastError = null;
  const tried = [];

  for (let m = 0; m < models.length; m += 1) {
    const model = models[m];
    const attempts = m === 0 ? RETRIES + 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let started = false;
      try {
        for await (const event of attemptOnce(model, options, signal)) {
          if (event.type === 'delta') started = true;
          if (event.type === 'done') {
            event.fallbackUsed = model !== primary;
            event.requestedModel = primary;
            if (model !== primary) console.warn(`[gemini] ${primary} was busy; answered with ${model} instead.`);
          }
          yield event;
        }
        return;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        // A backup model this key cannot reach is skipped, not reported.
        if (m > 0 && (error.status === 404 || error.status === 400)) { break; }
        if (started || !error.retryable) throw error;
        lastError = error;
        if (!tried.includes(model)) tried.push(model);
        // A used-up daily quota will not come back in seconds: move on.
        if (error.dailyQuota) break;
        if (attempt < attempts - 1) {
          const wait = backoff(attempt, error.retryAfterMs);
          console.warn(`[gemini] ${model} answered ${error.status}; retrying in ${(wait / 1000).toFixed(1)} s.`);
          await sleep(wait, signal);
        }
      }
    }
  }
  throw exhausted(lastError, tried);
}

/** One request to one model. */
async function* attemptOnce(model, options, signal) {
  const url = `${API_ROOT}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
      body: JSON.stringify(buildRequest(options)),
      signal,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    const err = new Error('Could not reach the Gemini API. Check your network connection.');
    err.code = 'NETWORK';
    throw err;
  }

  if (!res.ok || !res.body) throw await describeHttpError(res, model);

  let finishReason = null;
  let usage = null;
  let modelVersion = model;
  let produced = '';

  for await (const chunk of readServerSentEvents(res.body, signal)) {
    // Overload can also arrive inside the stream, as an error frame.
    if (chunk.error) throw httpError(Number(chunk.error.code) || 500, chunk.error.message || '', model);

    // A prompt rejected outright comes back as feedback rather than an error.
    if (chunk.promptFeedback?.blockReason) {
      throw blocked(`Gemini declined the request (${chunk.promptFeedback.blockReason}).`);
    }

    const candidate = (chunk.candidates || [])[0];
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.modelVersion) modelVersion = chunk.modelVersion;
    if (candidate?.finishReason) finishReason = candidate.finishReason;

    for (const part of candidate?.content?.parts || []) {
      if (typeof part.text === 'string' && part.text) {
        produced += part.text;
        yield { type: 'delta', text: part.text };
      }
    }
  }

  // STOP and MAX_TOKENS are ordinary endings. The rest mean the output is not
  // what was asked for, and saying which is more use than a blank pane.
  if (finishReason && !['STOP', 'MAX_TOKENS'].includes(finishReason)) {
    if (finishReason === 'RECITATION') {
      throw blocked(
        'Gemini stopped because the output was reproducing text it was trained on. '
        + 'Rewriting cannot launder a copied passage; write the point in your own words first.',
      );
    }
    throw blocked(`Gemini stopped early (${finishReason}).`);
  }
  if (!produced.trim()) throw blocked('Gemini returned nothing.');

  yield {
    type: 'done',
    model: modelVersion,
    stopReason: finishReason || 'STOP',
    truncated: finishReason === 'MAX_TOKENS',
    fallbackUsed: false,
    serverFallbackEnabled: false,
    usage: {
      input: usage?.promptTokenCount ?? 0,
      output: usage?.candidatesTokenCount ?? 0,
      cacheRead: usage?.cachedContentTokenCount ?? 0,
      cacheWrite: 0,
    },
  };
}

/**
 * Reads an SSE body into parsed JSON objects. Written out rather than reused
 * from the browser code because the two run in different places.
 */
async function* readServerSentEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; the last piece may be partial.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            yield JSON.parse(payload);
          } catch {
            // A frame that is not JSON is not worth failing the whole stream.
          }
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function describeHttpError(res, model = MODEL) {
  let detail = '';
  let reason = '';
  let retryAfterMs = 0;
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
    const details = body?.error?.details || [];
    reason = details.map((d) => d.reason).find(Boolean) || '';
    // RetryInfo says how long Google wants us to wait, as "12s" or "0.5s".
    const delay = details.map((d) => d.retryDelay).find(Boolean);
    if (delay) retryAfterMs = Math.round(parseFloat(delay) * 1000) || 0;
  } catch {
    detail = await res.text().catch(() => '');
  }
  if (!retryAfterMs && res.headers?.get?.('retry-after')) {
    retryAfterMs = (Number(res.headers.get('retry-after')) || 0) * 1000;
  }

  // An invalid Gemini key comes back as 400 INVALID_ARGUMENT, not 401 or 403,
  // so status alone would report it as a malformed request.
  if (reason === 'API_KEY_INVALID' || /API key not valid|API key expired/i.test(detail)) {
    const err = new Error('Gemini rejected the API key. Check GEMINI_API_KEY in your .env file.');
    err.code = 'AUTH';
    return err;
  }
  if (reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(detail)) {
    const err = new Error(
      'That key exists but the Generative Language API is not enabled for its project. '
      + 'Enable it in Google AI Studio, or make a fresh key there.',
    );
    err.code = 'AUTH';
    return err;
  }

  return httpError(res.status, detail, model, retryAfterMs);
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** An error for an HTTP status, tagged with whether trying again could help. */
function httpError(status, detail, model, retryAfterMs = 0) {
  const messages = {
    400: `Gemini rejected the request: ${detail || 'bad request'}`,
    401: 'Gemini rejected the credentials. Check GEMINI_API_KEY.',
    403: detail?.includes('API key')
      ? 'Gemini rejected the API key. Check GEMINI_API_KEY, and that the Generative Language API is enabled for it.'
      : `Gemini refused the request: ${detail || 'forbidden'}`,
    404: `No such model: ${model}. Set GEMINI_MODEL to one your key can reach: ${detail || ''}`.trim(),
    429: 'Gemini rate limited the request. Wait a moment and try again.',
    500: 'Gemini had a server error. Try again.',
    502: 'Gemini had a server error. Try again.',
    503: 'Gemini is overloaded. Try again in a moment.',
    504: 'Gemini took too long to answer. Try again.',
  };

  const err = new Error(messages[status] || `Gemini error ${status}: ${detail}`);
  err.code = status === 401 || status === 403 ? 'AUTH' : String(status);
  err.status = status;
  err.model = model;
  err.detail = detail;
  err.retryable = RETRYABLE.has(status);
  err.retryAfterMs = retryAfterMs;
  err.dailyQuota = status === 429 && /per ?day|PerDay|daily/i.test(detail);
  return err;
}

/** What to tell a person once every retry and backup model has been busy. */
function exhausted(error, tried) {
  const list = tried.length ? tried.join(', ') : MODEL;
  let message;
  if (error?.status === 429) {
    message = error.dailyQuota
      ? `Your Gemini key has used up its free daily allowance on ${list}. It resets each day (midnight Pacific time). `
        + 'To keep going now, turn on billing for the key in Google AI Studio, or set GEMINI_MODEL in .env to a model with allowance left.'
      : `Gemini's free-tier limit was hit on ${list}: it allows only a few requests a minute. Wait a minute and try again. `
        + 'Turning on billing for the key in Google AI Studio raises the limit a long way.';
  } else {
    message = `Gemini is busy right now. Google answered "overloaded" for ${list}, even after retrying for several seconds. `
      + 'That is on Google\'s side and usually clears within a few minutes. Free-tier keys are served last when it is busy; '
      + 'a key with billing turned on in Google AI Studio gets priority.';
  }
  const err = new Error(message);
  err.code = String(error?.status || 503);
  err.status = error?.status || 503;
  return err;
}

function noKey() {
  const err = new Error(
    'Gemini mode needs an API key, and there is none set. Stay on the offline engine, '
    + 'or add GEMINI_API_KEY to a .env file and restart.',
  );
  err.code = 'NO_CREDENTIALS';
  return err;
}

function blocked(message) {
  const err = new Error(message);
  err.code = 'REFUSED';
  return err;
}
