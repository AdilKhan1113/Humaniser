// Chooses which model provider is in play, and gives the server one shape to
// call regardless of the answer.
//
// Selection is by key, not by preference: whichever key is in the environment
// is the one that gets used. HUMANISER_PROVIDER forces the choice when both are
// present. Neither being present is a normal state — the offline engine is the
// default and needs no key at all.

import * as anthropic from './providers/anthropic.js';
import * as gemini from './providers/gemini.js';

const PROVIDERS = { anthropic, gemini };
const REQUESTED = (process.env.HUMANISER_PROVIDER || 'auto').toLowerCase();

/** The provider module in force, or null when no key is configured. */
export function activeProvider() {
  if (PROVIDERS[REQUESTED]) {
    // Named explicitly: return it even with no key, so the error names the
    // variable that is missing rather than silently falling back.
    return PROVIDERS[REQUESTED];
  }
  if (gemini.hasKey()) return gemini;
  if (anthropic.hasKey()) return anthropic;
  return null;
}

/** What the page needs to know. Never includes a key. */
export function providerStatus() {
  const provider = activeProvider();
  if (!provider) {
    return {
      id: null,
      label: null,
      model: null,
      keyInEnv: false,
      efforts: [],
      effortLabel: null,
      available: Object.values(PROVIDERS).map((p) => ({ id: p.ID, label: p.LABEL })),
    };
  }
  return {
    id: provider.ID,
    label: provider.LABEL,
    model: provider.MODEL,
    keyInEnv: provider.hasKey(),
    efforts: provider.EFFORT_LEVELS,
    effortLabel: provider.EFFORT_LABEL,
    canListModels: typeof provider.listModels === 'function',
    available: Object.values(PROVIDERS).map((p) => ({ id: p.ID, label: p.LABEL })),
  };
}

/** True when a rewrite could actually be attempted. */
export function hasKey() {
  const provider = activeProvider();
  return Boolean(provider && provider.hasKey());
}

/**
 * Rewrites text with whichever provider is configured.
 * Yields the same event shapes either way: delta, thinking, done.
 */
export async function* rewrite(options, signal) {
  const provider = activeProvider();
  if (!provider) {
    const err = new Error(
      'No model API key is set. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY) to a .env file '
      + 'and restart, or stay on the offline engine, which needs no key.',
    );
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  yield* provider.rewrite(options, signal);
}

/** Models the configured key can actually reach, when the provider can say. */
export async function listModels(signal) {
  const provider = activeProvider();
  if (!provider || typeof provider.listModels !== 'function') return [];
  return provider.listModels(signal);
}
