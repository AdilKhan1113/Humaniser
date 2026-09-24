#!/usr/bin/env node
// Builds humaniser.html: the whole app in one file you can double-click, with
// no Node, no server and no install. The rewriter runs entirely offline;
// Research talks to OpenAlex and Crossref directly from the page, since both
// allow it, and nothing else.
//
// It is generated from the same lib/ and public/ sources the server uses, never
// hand-maintained, so the two builds cannot drift apart. Run `npm run build`
// after changing anything under lib/ or public/.
//
// The transform is narrow on purpose. Every module here exports only
// `export const` and `export function`, and imports only named bindings from
// sibling files, so each module becomes an IIFE returning its exports and each
// import becomes a destructure of that namespace. Concatenating the files
// directly would collide: analyze.js and rules.js both declare INFLATED_KEYS
// and INFLATED_RE at the top level.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

// Dependency order. Each module may only import from ones already listed.
const MODULES = [
  'lexicon', 'common-words', 'verbs', 'passive', 'analyze', 'rules', 'rubric', 'docx',
  'sentences', 'keywords', 'overlap', 'cite', 'scholar', 'insights', 'paraphrase',
];

const namespaceFor = (name) => `NS_${name.replace(/-/g, '_')}`;

const IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*'\.\/([^']+)\.js';?[ \t]*\n/gm;
// Handles `export async function` and `export function*` as well as the plain
// forms. Missing a modifier here drops the binding from the namespace silently,
// which is what happened to `export async function extractDocxText`, so the
// count is verified against the number of export keywords below.
const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_KEYWORD_RE = /^export\s/gm;

/** Rewrites one ES module into a self-contained IIFE assigned to a namespace. */
function toNamespacedIife(name) {
  const source = read('lib', `${name}.js`);
  const exported = [...source.matchAll(EXPORT_DECL_RE)].map((m) => m[1]);

  if (exported.length === 0) {
    throw new Error(`${name}.js exports nothing; the transform expects named exports`);
  }

  // Every `export` must have yielded a name. A modifier the pattern does not
  // know would otherwise drop that binding from the namespace with no error,
  // and the failure only shows up as "not a function" at runtime.
  const keywordCount = (source.match(EXPORT_KEYWORD_RE) || []).length;
  if (keywordCount !== exported.length) {
    throw new Error(
      `${name}.js has ${keywordCount} export statements but ${exported.length} were parsed `
      + `(${exported.join(', ')}). Extend EXPORT_DECL_RE for the form it missed.`,
    );
  }
  for (const form of ['export default', 'export *', 'export {']) {
    if (source.includes(form)) {
      throw new Error(`${name}.js uses "${form}", which this transform does not handle`);
    }
  }

  let body = source.replace(IMPORT_RE, (whole, names, from) => {
    if (!MODULES.includes(from)) {
      throw new Error(`${name}.js imports './${from}.js', which is not in the module list`);
    }
    if (MODULES.indexOf(from) >= MODULES.indexOf(name)) {
      throw new Error(`${name}.js imports './${from}.js', which is not built before it`);
    }
    const bindings = names.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
    return `const { ${bindings} } = ${namespaceFor(from)};\n`;
  });

  if (/^import\b/m.test(body)) {
    throw new Error(`${name}.js has an import this transform did not rewrite`);
  }

  body = body.replace(/^export\s+/gm, '');

  return `// ---- lib/${name}.js ----\nconst ${namespaceFor(name)} = (() => {\n${body}\nreturn { ${exported.join(', ')} };\n})();\n`;
}

// The bridge the shared front end looks for. Its presence is what puts app.js
// into offline mode, so the same app.js serves both builds.
const BRIDGE = `
// ---- offline bridge ----
// public/app.js checks for this. When it is here, the page calls straight into
// the rules engine instead of talking to a server.
window.HUMANISER_OFFLINE = {
  build: 'standalone',
  analyze: (text, constraints) => NS_analyze.analyze(text, { constraints }),
  humanise(text, strength, constraints) {
    const result = NS_rules.humanise(text, { strength, constraints });
    return {
      text: result.text,
      changes: result.changes,
      byRule: result.byRule,
      profile: result.profile,
      before: NS_analyze.analyze(text, { constraints }),
      after: NS_analyze.analyze(result.text, { constraints }),
    };
  },
  parseRubric: (text) => NS_rubric.parseRubric(text),
  checkRubric: (draft, rubric) => NS_rubric.checkAgainstRubric(draft, rubric),
  extractDocxText: (buffer) => NS_docx.extractDocxText(buffer),
  profiles: Object.entries(NS_rules.PROFILES).map(([id, p]) => ({
    id, label: p.label, description: p.description,
  })),
  // public/research.js checks for this one. The page's controls arrive as
  // strings, the way the server receives them, so they are read the same way.
  research: {
    search: (p) => NS_scholar.searchWorks({
      ...p,
      peerReviewed: !/^(0|false)$/.test(String(p.peerReviewed)),
      openAccess: /^(1|true)$/.test(String(p.openAccess)),
    }),
    connected: (id, kind, opts) => NS_scholar.connectedWorks(id, kind, opts),
    work: (id) => NS_scholar.getWork(id),
    paraphrase: (text) => NS_paraphrase.paraphraseOffline(text),
    polish: (text) => NS_rules.humanise(text, {
      strength: 'light',
      constraints: { noContractions: true, noFirstPerson: true, noSecondPerson: true, formalRegister: true },
    }).text,
  },
};
`;

const SHARED_IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*'\/shared\/([^']+)\.js';?[ \t]*\n/gm;

/** public/research.js imports the shared modules by URL; here they are namespaces. */
function inlineResearch() {
  const source = read('public', 'research.js');
  const body = source.replace(SHARED_IMPORT_RE, (whole, names, from) => {
    if (!MODULES.includes(from)) throw new Error(`research.js imports /shared/${from}.js, which is not built`);
    return `const { ${names.split(',').map((x) => x.trim()).filter(Boolean).join(', ')} } = ${namespaceFor(from)};\n`;
  });
  if (/^import\b/m.test(body) || /^export\b/m.test(body)) {
    throw new Error('public/research.js has an import or export the inliner does not handle');
  }
  return body;
}

export function buildStandalone() {
  const modules = MODULES.map(toNamespacedIife).join('\n');
  const app = read('public', 'app.js');
  const css = read('public', 'styles.css');
  const researchCss = read('public', 'research.css');
  const research = inlineResearch();
  let html = read('public', 'index.html');

  if (/^import\b/m.test(app) || /^export\b/m.test(app)) {
    throw new Error('public/app.js is no longer a plain script; the inliner needs updating');
  }

  // Both replacements pass a function, not a string. A replacement string
  // treats $&, $' and $1 as patterns, and the inlined code contains '\\$&'
  // inside a regex in lexicon.js, which expanded into the matched script tag
  // and corrupted the output.
  html = html.replace(
    '<link rel="stylesheet" href="styles.css">',
    () => `<style>\n${css}\n</style>`,
  );
  html = html.replace(
    '<link rel="stylesheet" href="research.css">',
    () => `<style>\n${researchCss}\n</style>`,
  );
  html = html.replace('<script type="module" src="research.js"></script>\n', '');
  html = html.replace(
    '<script type="module" src="app.js"></script>',
    // Each front-end script keeps its own scope: both declare helpers such as
    // \`ui\` and \`esc\`, and they talk through DOM events, not shared names.
    () => `<script>\n(() => {\n'use strict';\n${modules}\n${BRIDGE}\n(() => {\n${app}\n})();\n(() => {\n${research}\n})();\n})();\n</script>`,
  );

  // Nothing may be loaded from elsewhere: this file has to open from file://.
  const leftovers = [
    [/<link[^>]+href="(?!data:)/i, 'an external stylesheet or link'],
    [/<script[^>]+src=/i, 'an external script'],
    [/\bfrom\s+'\.\//, 'an unrewritten module import'],
  ];
  for (const [pattern, what] of leftovers) {
    if (pattern.test(html)) throw new Error(`the generated file still references ${what}`);
  }

  const banner = '<!-- Generated by tools/build-standalone.js from lib/ and public/. '
    + 'Do not edit by hand: run `npm run build` instead. -->\n';
  return banner + html;
}

export const OUTPUT_PATH = path.join(root, 'humaniser.html');

// Writes only when run directly, so a test can build in memory and compare
// against the committed file without overwriting it.
const runDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runDirectly) {
  const output = buildStandalone();
  fs.writeFileSync(OUTPUT_PATH, output);
  const kb = (Buffer.byteLength(output) / 1024).toFixed(0);
  console.log(`humaniser.html written — ${kb} KB, ${MODULES.length} modules inlined, no external references`);
}
