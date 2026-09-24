import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildStandalone, OUTPUT_PATH } from '../tools/build-standalone.js';

const built = buildStandalone();

test('the committed humaniser.html matches a fresh build', () => {
  assert.ok(fs.existsSync(OUTPUT_PATH), 'humaniser.html is missing; run npm run build');
  assert.equal(
    fs.readFileSync(OUTPUT_PATH, 'utf8'),
    built,
    'humaniser.html is out of date with lib/ or public/; run npm run build',
  );
});

test('it loads nothing from elsewhere', () => {
  // It has to open from file://, so every asset is inline. This checks
  // fetchable positions only: a URL inside a comment is inert.
  assert.doesNotMatch(built, /<script[^>]*\ssrc=/i);
  assert.doesNotMatch(built, /<link[^>]+href="(?!data:)/i);
  assert.doesNotMatch(built, /<(?:img|iframe|video|audio|source|embed)[^>]*\ssrc="(?!data:)/i);
  assert.doesNotMatch(built, /^import\s/m);
  assert.doesNotMatch(built, /@import/i);
  assert.doesNotMatch(built, /url\(\s*['"]?https?:/i);
  assert.doesNotMatch(built, /new\s+(?:XMLHttpRequest|WebSocket|EventSource)/);
});

test('the only services it talks to are the two scholarly indexes', () => {
  // The rewriter stays fully offline. Research searches OpenAlex and looks up
  // DOIs at Crossref, and nothing else: no analytics, no model, no fonts.
  const apiHosts = new Set([...built.matchAll(/'https:\/\/(api\.[a-z.]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...apiHosts].sort(), ['api.crossref.org', 'api.openalex.org']);
  assert.doesNotMatch(built, /fetch\(\s*['"`]https?:/i);
  assert.match(built, /research: \{/);
});

test('carries the engine and the offline bridge', () => {
  assert.match(built, /window\.HUMANISER_OFFLINE/);
  for (const symbol of ['function analyze(', 'function humanise(', 'function flipPassiveClause(', 'PARTICIPLES']) {
    assert.ok(built.includes(symbol), `missing ${symbol}`);
  }
});

test('each module is namespaced, so nothing collides', () => {
  // analyze.js and rules.js both declare INFLATED_KEYS and INFLATED_RE at the
  // top level, which is why plain concatenation is not an option.
  for (const ns of ['NS_lexicon', 'NS_common_words', 'NS_verbs', 'NS_passive', 'NS_analyze', 'NS_rules',
    'NS_sentences', 'NS_keywords', 'NS_overlap', 'NS_cite', 'NS_scholar', 'NS_insights', 'NS_paraphrase']) {
    assert.match(built, new RegExp(`const ${ns} = \\(\\(\\) => \\{`));
  }
  assert.equal((built.match(/const INFLATED_KEYS/g) || []).length, 2);
});

test('the inlined script is syntactically valid', () => {
  const match = built.match(/<script>\n([\s\S]*?)\n<\/script>/);
  assert.ok(match, 'no inline script found');
  // Throws a SyntaxError if the concatenation produced anything invalid.
  assert.doesNotThrow(() => new Function(match[1]));
});
