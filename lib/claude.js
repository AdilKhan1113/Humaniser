// Claude-powered rewriting. The offline engine handles the mechanical rules;
// this handles the ones that need judgement, such as rhythm, metaphor and
// knowing when a sentence should simply be shorter.

import { HOUSE_STYLE, buildUserMessage } from './prompt.js';

export const MODEL = process.env.HUMANISER_MODEL || 'claude-opus-5';
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

// Streaming keeps a long rewrite from bumping into the request timeout, and
// lets the text appear as it is written.
const MAX_TOKENS = 64000;

let clientPromise = null;

/**
 * Loads the SDK on first use, so the app still starts and the offline engine
 * still works when dependencies are missing.
 */
async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      let Anthropic;
      try {
        ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
      } catch (cause) {
        const err = new Error('The Anthropic SDK is not installed. Run: npm install');
        err.code = 'SDK_MISSING';
        throw err;
      }
      // No apiKey argument: the SDK resolves ANTHROPIC_API_KEY, then
      // ANTHROPIC_AUTH_TOKEN, then a profile saved by `ant auth login`.
      return { client: new Anthropic(), Anthropic };
    })();
  }
  return clientPromise;
}

/** Whether a key is sitting in the environment. A CLI profile can still work without one. */
export function hasApiKeyInEnv() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Rewrites text with Claude, yielding events as they arrive.
 *
 * Yields: {type:'thinking', text} | {type:'delta', text} | {type:'done', ...}
 * @param {{text:string, strength?:string, effort?:string, audience?:string, notes?:string}} options
 * @param {AbortSignal} [signal]
 */
/**
 * Builds the request body. Separate from the call itself so the shape can be
 * asserted in tests without spending a token.
 */
export function buildRequest(options) {
  const effort = EFFORT_LEVELS.includes(options.effort) ? options.effort : 'high';
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Opus 5 rejects temperature, top_p and top_k outright. Thinking depth is
    // the knob that replaced them.
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort },
    // The house style never changes, so it caches and later requests only pay
    // for the text being rewritten.
    system: [{ type: 'text', text: HOUSE_STYLE, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserMessage(options) }],
  };
}

/**
 * Opus 5's safety classifiers can decline a request outright. Server-side
 * fallback re-runs it on another model inside the same call instead of handing
 * back a refusal, with the substitute picked by refusal category.
 */
export function withFallback(request) {
  return { ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
}

export async function* rewriteWithClaude(options, signal) {
  const { client, Anthropic } = await getClient();
  const request = buildRequest(options);
  const betaRequest = withFallback(request);

  let stream;
  let usedFallbackParam = true;
  try {
    if (typeof client.beta?.messages?.stream === 'function') {
      stream = client.beta.messages.stream(betaRequest, { signal });
    } else {
      usedFallbackParam = false;
      stream = client.messages.stream(request, { signal });
    }
  } catch (error) {
    throw describeError(error, Anthropic);
  }

  try {
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') {
        yield { type: 'delta', text: event.delta.text };
      } else if (event.delta.type === 'thinking_delta') {
        yield { type: 'thinking', text: event.delta.thinking };
      }
    }

    const final = await stream.finalMessage();

    // A refusal arrives as a normal 200 response, so stop_reason has to be read
    // before the content is trusted.
    if (final.stop_reason === 'refusal') {
      const detail = final.stop_details || {};
      const err = new Error(
        `Claude declined this request${detail.category ? ` (${detail.category})` : ''}. ` +
        'The offline rules engine still works on this text.',
      );
      err.code = 'REFUSED';
      throw err;
    }

    yield {
      type: 'done',
      model: final.model,
      stopReason: final.stop_reason,
      truncated: final.stop_reason === 'max_tokens',
      fallbackUsed: (final.content || []).some((b) => b.type === 'fallback'),
      serverFallbackEnabled: usedFallbackParam,
      usage: {
        input: final.usage?.input_tokens ?? 0,
        output: final.usage?.output_tokens ?? 0,
        cacheRead: final.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: final.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (error) {
    if (error.code === 'REFUSED') throw error;
    throw describeError(error, Anthropic);
  }
}

/** Turns an SDK error into something worth showing a person. */
function describeError(error, Anthropic) {
  if (!Anthropic) return error;
  if (error instanceof Anthropic.AuthenticationError) {
    const err = new Error('Claude rejected the credentials. Check ANTHROPIC_API_KEY in your .env file.');
    err.code = 'AUTH';
    return err;
  }
  if (error instanceof Anthropic.RateLimitError) {
    const err = new Error('Rate limited by the API. Wait a moment and try again.');
    err.code = 'RATE_LIMIT';
    return err;
  }
  if (error instanceof Anthropic.BadRequestError) {
    const err = new Error(`The API rejected the request: ${error.message}`);
    err.code = 'BAD_REQUEST';
    return err;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    const err = new Error('Could not reach the API. Check your network connection.');
    err.code = 'NETWORK';
    return err;
  }
  if (error instanceof Anthropic.APIError) {
    const err = new Error(`API error ${error.status}: ${error.message}`);
    err.code = 'API';
    return err;
  }
  return error;
}
