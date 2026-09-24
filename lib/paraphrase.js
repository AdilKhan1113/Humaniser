// Paraphrasing a sentence from a paper, so a researcher has a starting point
// to write over rather than a blank line or a copied one.
//
// The offline engine is deliberately modest: it moves the attribution, swaps
// the reporting verbs and stock academic phrases, turns "we" into "the
// authors", reorders clauses and flips simple passives. That changes structure
// as well as vocabulary, which is what separates a paraphrase from a synonym
// swap. It still needs a human pass, and the overlap check says how much.
//
// A model engine (when a key is set) does the judgement part; its prompt is
// here too so both engines follow the same rules.

import { overlap } from './overlap.js';
import { splitSentences } from './sentences.js';
import { findPassives, flipPassiveClause } from './passive.js';

// Longest first: the matcher takes the first hit at each position.
const PHRASES = [
  ['a growing body of evidence suggests that', 'more and more studies indicate that'],
  ['the results of this study suggest that', 'these findings point to the conclusion that'],
  ['the results suggest that', 'the findings point to the conclusion that'],
  ['the results indicate that', 'the findings suggest that'],
  ['the results showed that', 'the analysis revealed that'],
  ['the findings suggest that', 'the evidence points to the conclusion that'],
  ['it was found that', 'the evidence showed that'],
  ['it is suggested that', 'one interpretation is that'],
  ['plays an important role in', 'is central to'],
  ['plays a key role in', 'is central to'],
  ['plays a crucial role in', 'is essential to'],
  ['a significant increase in', 'a marked rise in'],
  ['a significant decrease in', 'a marked fall in'],
  ['a significant reduction in', 'a substantial drop in'],
  ['significantly associated with', 'strongly linked to'],
  ['is associated with', 'is linked to'],
  ['are associated with', 'are linked to'],
  ['was associated with', 'was linked to'],
  ['were associated with', 'were linked to'],
  ['in comparison with', 'relative to'],
  ['in comparison to', 'relative to'],
  ['compared with', 'relative to'],
  ['compared to', 'relative to'],
  ['as well as', 'along with'],
  ['in addition,', 'beyond this,'],
  ['furthermore,', 'what is more,'],
  ['moreover,', 'beyond this,'],
  ['however,', 'even so,'],
  ['therefore,', 'as a result,'],
  ['thus,', 'consequently,'],
  ['in contrast,', 'by contrast,'],
  ['for example,', 'for instance,'],
  ['due to', 'because of'],
  ['in order to', 'to'],
  ['a large number of', 'many'],
  ['the majority of', 'most'],
  ['a wide range of', 'many different'],
  ['with respect to', 'regarding'],
  ['in terms of', 'regarding'],
  ['has been shown to', 'is known to'],
  ['have been shown to', 'are known to'],
  ['there is evidence that', 'evidence indicates that'],
  ['little is known about', 'research has paid little attention to'],
  ['remains unclear', 'is still not well understood'],
  ['remain unclear', 'are still not well understood'],
];

const WORDS = new Map(Object.entries({
  demonstrated: 'showed', demonstrate: 'show', demonstrates: 'shows',
  showed: 'demonstrated', shows: 'indicates', show: 'indicate',
  examined: 'investigated', examine: 'investigate', examines: 'investigates',
  investigated: 'examined', investigate: 'examine', investigates: 'examines',
  explored: 'analysed', explore: 'analyse',
  revealed: 'showed', reveal: 'show', reveals: 'shows',
  indicated: 'suggested', indicates: 'suggests', indicate: 'suggest',
  suggest: 'imply', suggests: 'implies', suggested: 'implied',
  observed: 'found', observe: 'find',
  increased: 'rose', increases: 'rises',
  decreased: 'fell', decreases: 'falls',
  reduced: 'lowered', reduces: 'lowers', reduce: 'lower',
  enhanced: 'strengthened', enhances: 'strengthens', enhance: 'strengthen',
  improved: 'boosted', improves: 'boosts',
  utilized: 'used', utilised: 'used', utilize: 'use', utilise: 'use', utilizing: 'using', utilising: 'using',
  approximately: 'roughly', numerous: 'many', individuals: 'people',
  substantial: 'considerable', considerable: 'substantial',
  significant: 'notable', significantly: 'markedly',
  crucial: 'vital', essential: 'vital', vital: 'essential',
  important: 'key', key: 'central',
  novel: 'new', robust: 'strong', consistent: 'steady',
  subsequently: 'later', previously: 'earlier', additionally: 'also', frequently: 'often',
  commonly: 'widely', primarily: 'mainly', predominantly: 'mostly', particularly: 'especially',
  obtain: 'gain', obtained: 'gained', require: 'need', requires: 'needs', required: 'needed',
  facilitate: 'ease', facilitates: 'eases', facilitated: 'eased',
  impact: 'effect', impacts: 'effects', impacted: 'affected',
  outcome: 'result', outcomes: 'results', method: 'approach', methods: 'approaches',
  factors: 'drivers', aim: 'goal', aims: 'goals', objective: 'goal',
  evaluated: 'assessed', evaluate: 'assess', assessed: 'evaluated', assess: 'evaluate',
  determine: 'establish', determined: 'established',
  highlight: 'underline', highlights: 'underlines', highlighted: 'underlined',
  participants: 'respondents',
}));

// Terms that are the author's precise vocabulary. Swapping them changes meaning.
const PROTECTED = /^(p|n|r|ci|or|hr|rr|sd|se|df|anova|rct|mean|median|variance|regression|correlation|cohort|placebo|randomi[sz]ed|significant(ly)?)$/i;

/** First-person plural in a paper means the authors. A paraphrase has to say so. */
const FIRST_PERSON = [
  [/\bWe\b/g, 'The authors'], [/\bwe\b/g, 'the authors'],
  [/\bOur\b/g, 'Their'], [/\bour\b/g, 'their'],
  [/\bUs\b/g, 'Them'], [/\bus\b/g, 'them'],
  [/\bourselves\b/g, 'themselves'],
];

const keepCase = (from, to) => (from[0] === from[0].toUpperCase() && from[0] !== from[0].toLowerCase()
  ? to.charAt(0).toUpperCase() + to.slice(1) : to);
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) && !/^(I|[A-Z]{2,})\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const tidy = (s) => s.replace(/\s+([,.;:!?])(?!\d)/g, '$1').replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').trim();

function swapPhrases(text, changes) {
  let out = text;
  for (const [from, to] of PHRASES) {
    const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
    out = out.replace(re, (m) => {
      changes.push({ rule: 'phrase', from: m, to });
      return keepCase(m, to);
    });
  }
  return out;
}

function swapWords(text, changes, limit = 6) {
  let swapped = 0;
  const used = new Set();
  return text.replace(/\b[A-Za-z]+\b/g, (word, offset, whole) => {
    if (swapped >= limit) return word;
    const lower = word.toLowerCase();
    if (PROTECTED.test(lower) && !/^significant/.test(lower)) return word;
    // "statistically significant" is a technical claim, not an adjective to vary.
    if (/^significant/.test(lower) && /statistically\s+$/i.test(whole.slice(Math.max(0, offset - 16), offset))) return word;
    const to = WORDS.get(lower);
    if (!to || used.has(lower)) return word;
    // After "is", "was", "has been" the word is a participle, and "is rose" is
    // not English. Only a target that works as a participle is allowed there.
    const before = whole.slice(Math.max(0, offset - 12), offset);
    if (/\b(is|are|was|were|be|been|being|has|have|had|get|got)\s+$/i.test(before)
      && !(/ed$/.test(to) && to !== 'showed') && !['found', 'shown', 'known'].includes(to)) return word;
    used.add(lower);
    used.add(to);
    swapped += 1;
    changes.push({ rule: 'word', from: word, to });
    return keepCase(word, to);
  });
}

function thirdPerson(text, changes) {
  let out = text;
  for (const [re, to] of FIRST_PERSON) {
    out = out.replace(re, (m) => { changes.push({ rule: 'attribution', from: m, to }); return to; });
  }
  // "the authors was" never happens, but "the authors has" can after other swaps.
  return out.replace(/\b(the authors) (has|is|was)\b/gi, (m, a, v) => `${a} ${{ has: 'have', is: 'are', was: 'were' }[v.toLowerCase()]}`);
}

// "A because B." -> "Because B, A."  One reorder per sentence at most.
const FRONTABLE = /^(.{12,}?),?\s+\b(because|although|while|whereas|when|if|since|unless|after|before)\b\s+(.{8,}?)([.!?])?$/i;

function frontClause(sentence, changes) {
  const m = sentence.match(FRONTABLE);
  if (!m) return sentence;
  const [, main, conj, sub, stop = '.'] = m;
  if (/[,;:]/.test(sub) || main.split(/\s+/).length > 22) return sentence;
  changes.push({ rule: 'reorder', from: `… ${conj} …`, to: `${capFirst(conj.toLowerCase())} …, …` });
  return `${capFirst(conj.toLowerCase())} ${sub.replace(/[.!?]$/, '')}, ${lowerFirst(main.replace(/,$/, ''))}${stop}`;
}

// "X showed that Y." -> "Y, as X showed."  Moves the attribution to the end.
const REPORTING = /^(.{3,80}?)\s+(showed|shows?|found|finds?|demonstrated|demonstrates?|reported|reports?|observed|concluded|argued|argues?|noted|notes?|suggested|suggests?|revealed|reveals?|established|confirmed|confirms?|indicated|indicates?)\s+that\s+(.{10,}?)([.!?])?$/i;

function moveAttribution(sentence, changes) {
  const m = sentence.match(REPORTING);
  if (!m) return sentence;
  const [, who, verb, claim, stop = '.'] = m;
  if (/[;:]/.test(claim)) return sentence;
  changes.push({ rule: 'attribution', from: `${who} ${verb} that …`, to: `…, as ${who} ${verb}` });
  return `${capFirst(claim.replace(/[.!?]$/, ''))}, as ${lowerFirst(who)} ${verb.toLowerCase()}${stop}`;
}

function flipPassives(sentence, changes) {
  const body = sentence.replace(/([.!?])$/, '');
  const stop = sentence.slice(body.length) || '.';
  // "by Smith and colleagues" is one agent; the flipper would take only "Smith".
  if (findPassives(body).some((h) => /^\s*(and|or|&)\s/i.test(body.slice(h.index + h.length)))) return sentence;
  const flipped = flipPassiveClause(body);
  if (!flipped) return sentence;
  changes.push({ rule: 'voice', from: body, to: flipped });
  return `${flipped}${stop}`;
}

const STRATEGIES = {
  // Structure first, then wording: the version most likely to read as your own.
  restructure: (s, ch) => swapWords(swapPhrases(frontClause(moveAttribution(flipPassives(thirdPerson(s, ch), ch), ch), ch), ch), ch),
  // Keeps the order, changes the words.
  reword: (s, ch) => swapWords(swapPhrases(thirdPerson(s, ch), ch), ch, 10),
  // Light: attribution and stock phrases only. Closest to the source.
  light: (s, ch) => swapPhrases(thirdPerson(s, ch), ch),
};

export const STRATEGY_LABELS = {
  restructure: 'Restructured',
  reword: 'Reworded',
  light: 'Light touch',
};

/**
 * Offline paraphrases of a passage, one per strategy, each with its overlap
 * against the source.
 * @returns {{variants: Array<{strategy, label, text, changes, overlap}>}}
 */
export function paraphraseOffline(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const variants = [];
  const seen = new Set([source]);
  for (const [strategy, run] of Object.entries(STRATEGIES)) {
    const changes = [];
    const out = tidy(splitSentences(source).map((s) => capFirst(run(s, changes))).join(' '));
    if (seen.has(out)) continue;
    seen.add(out);
    variants.push({ strategy, label: STRATEGY_LABELS[strategy], text: out, changes, overlap: overlap(source, out) });
  }
  // Freshest first.
  variants.sort((a, b) => a.overlap.score - b.overlap.score || a.overlap.longestRun.length - b.overlap.longestRun.length);
  return { variants };
}

// ---------------------------------------------------------------- model

export const PARAPHRASE_SYSTEM = `You help a researcher paraphrase a passage from a scholarly paper so they can use the idea in their own writing, with a citation.

A good academic paraphrase:
- keeps the source's meaning exactly: every finding, figure, direction of effect, hedge ("may", "suggests") and scope limit survives. Never strengthen or weaken a claim.
- changes the sentence structure, not just the vocabulary: reorder clauses, change which idea leads, switch between active and passive, split or merge sentences.
- uses different wording, while keeping technical terms, variable names, statistics, units and proper nouns exactly as given. Do not replace a precise term with a vaguer one.
- attributes the work: first-person "we" or "our" in the source means the authors, so write "the authors", "the study" or "the researchers".
- adds nothing: no new claims, examples, interpretation or sources.
- holds a formal academic register. No contractions, no "you", no idiom.
- does not include a citation. The app adds the correct citation itself.

Return exactly three different paraphrases, from most to least restructured, each as its own paragraph separated by a blank line. No numbering, no labels, no commentary, no quotation marks around them.`;

export function buildParaphraseMessage({ text, context = '', discipline = '' }) {
  const parts = [];
  if (discipline.trim()) parts.push(`The researcher works in: ${discipline.trim()}.`);
  if (context.trim()) parts.push(`Surrounding text from the paper, for meaning only (do not paraphrase it):\n<context>\n${context.trim().slice(0, 3000)}\n</context>`);
  parts.push(`Paraphrase this passage:\n<passage>\n${text.trim()}\n</passage>`);
  return parts.join('\n\n');
}

/** Splits the model's reply into its three paraphrases and scores each. */
export function parseModelVariants(source, reply) {
  return String(reply || '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^\s*(\d+[.)]|[-*•])\s+/, '').replace(/^["“]|["”]$/g, '').trim())
    .filter((p) => p.length > 10)
    .slice(0, 3)
    .map((p, i) => ({ strategy: `model-${i + 1}`, label: ['Most restructured', 'Balanced', 'Closest'][i], text: p, changes: [], overlap: overlap(source, p) }));
}
