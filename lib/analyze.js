// Reads a piece of writing and reports where it still sounds like a machine.
// Nothing here rewrites anything; the report drives the dashboard and tells the
// rules engine's output apart from its input.

import {
  AI_TELLS, SELF_REFERENCE, INFLATED, NOMINALIZATIONS, HEDGES, EXPANSIONS,
  COORDINATING_CONJUNCTIONS, SUBJECT_STARTERS, FINITE_VERBS, DETERMINERS,
  NATURAL_TRANSITIONS, FLAG_ONLY, CONTRACTION_RE,
} from './lexicon.js';
import { isCommonWord } from './common-words.js';
import { VERB_FORMS } from './verbs.js';
import { findPassives } from './passive.js';

// Sentence-length window the house style asks for.
export const MIN_WORDS = 6;
export const MAX_WORDS = 20;

// Headings, list items and blockquotes stand alone as units. A line that is not
// one of these and does not end in punctuation is a wrap, not a sentence.
const STRUCTURAL_LINE = /^\s*(?:[-*+]|\d+[.)]|>+|#{1,6})\s/;

// These never end a sentence, whatever follows them.
const NEVER_FINAL = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'inc', 'ltd', 'co',
  'dept', 'est', 'fig', 'approx', 'vol', 'no', 'al', 'cf', 'ca', 'pp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

/**
 * Splits text into sentences, keeping each one's offset so the UI can highlight
 * the exact span. Abbreviations and decimals do not end sentences.
 * @returns {Array<{text:string, start:number, end:number, words:string[]}>}
 */
export function splitSentences(text) {
  const sentences = [];
  const re = /[^.!?\n]*[.!?]+["')\]]*|[^.!?\n]+(?=\n|$)/g;
  let pending = null;
  let m;

  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (!raw.trim()) continue;

    const piece = { text: raw, start: m.index, end: m.index + raw.length };
    if (pending) {
      pending.text += piece.text;
      pending.end = piece.end;
    } else {
      pending = piece;
    }

    const tail = pending.text.trimEnd();
    const lastWord = (tail.match(/([A-Za-z]+)\.$/) || [])[1] || '';
    const endsSentence = /[.!?]["')\]]*$/.test(tail);

    // A line break ends the unit only at a structural boundary: the end of the
    // text, a blank line between paragraphs, or a heading or list item on
    // either side of the break. A bare wrap mid-sentence must NOT end it —
    // text pasted from a PDF or a Word document is full of them, and treating
    // each wrapped line as a sentence capitalised the middle of every one.
    const rest = text.slice(re.lastIndex);
    const atStructuralBreak = re.lastIndex >= text.length
      || /^\n[ \t]*\n/.test(rest)
      || (rest.startsWith('\n')
        && (STRUCTURAL_LINE.test(pending.text.trimStart()) || STRUCTURAL_LINE.test(rest.slice(1))));

    // Sentence punctuation only counts when whitespace or the end of the text
    // follows it. Otherwise "https://example.com/x" is read as two sentences.
    const followedBySpace = re.lastIndex >= text.length || /\s/.test(text[re.lastIndex]);

    // A title or a bare initial always continues. A dotted abbreviation
    // ("p.m.", "e.g.") might genuinely end the sentence, so the next character
    // decides: a capital means a new sentence, lowercase means this one goes on.
    let keepGoing = !(endsSentence && followedBySpace) && !atStructuralBreak;
    if (endsSentence && lastWord) {
      const key = lastWord.toLowerCase();
      const dotted = /(?:[A-Za-z]\.){2,}$/.test(tail);
      if (NEVER_FINAL.has(key)) {
        keepGoing = true;
      } else if (dotted) {
        // "p.m." or "U.S." — ambiguous, so let the next character decide.
        const next = text.slice(re.lastIndex).match(/\S/);
        keepGoing = Boolean(next) && next[0] === next[0].toLowerCase();
      } else if (lastWord.length === 1) {
        // A lone initial, as in "J. R. Tolkien". A sentence practically never
        // ends on a single capital letter, so this always continues.
        keepGoing = true;
      }
    }
    if (keepGoing && re.lastIndex < text.length) continue;

    const trimmed = trimSpan(pending, text);
    if (trimmed) sentences.push(trimmed);
    pending = null;
  }

  if (pending) {
    const trimmed = trimSpan(pending, text);
    if (trimmed) sentences.push(trimmed);
  }
  return sentences;
}

function trimSpan(piece, text) {
  let { start, end } = piece;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (end <= start) return null;
  const body = text.slice(start, end);
  return { text: body, start, end, words: tokenise(body) };
}

export function tokenise(text) {
  return text.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
}

export function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function stdev(nums) {
  if (nums.length < 2) return 0;
  const mu = mean(nums);
  return Math.sqrt(mean(nums.map((n) => (n - mu) ** 2)));
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

function excerptAround(text, start, end, pad = 24) {
  const from = Math.max(0, start - pad);
  const to = Math.min(text.length, end + pad);
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '');
}

let issueSeq = 0;
function issue(text, { type, severity, title, detail, start, end, fix }) {
  issueSeq += 1;
  return {
    id: `i${issueSeq}`,
    type,
    severity,
    title,
    detail,
    start,
    end,
    fix: fix || null,
    excerpt: start != null ? excerptAround(text, start, end) : null,
  };
}

/** Comma splices before a coordinating conjunction, per the house comma rule. */
export function findCommaSplices(text) {
  const conj = COORDINATING_CONJUNCTIONS.join('|');
  const re = new RegExp(String.raw`,\s+(${conj})\s+([^,.;:!?]{0,80})`, 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (looksIndependent(m[2])) {
      hits.push({ index: m.index, length: 1, conjunction: m[1], clause: m[2].trim() });
    }
  }
  return hits;
}

/**
 * Rough test for an independent clause. A pronoun or "there" opening is a
 * giveaway; otherwise a determiner needs a finite verb close behind. Lists such
 * as "apples, and oranges" fail both tests, which is the point.
 */
export function looksIndependent(chunk) {
  const words = chunk.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const first = words[0].toLowerCase().replace(/[^a-z']/g, '');
  if (SUBJECT_STARTERS.has(first)) return true;
  if (DETERMINERS.has(first)) {
    return words.slice(1, 6).some((w) => {
      const word = w.toLowerCase().replace(/[^a-z']/g, '');
      if (!word) return false;
      // An auxiliary, a form the verb table recognises, or plain -ed shape.
      return FINITE_VERBS.has(word) || VERB_FORMS.has(word) || /[a-z]{3,}ed$/.test(word);
    });
  }
  return false;
}

/** Runs every regex list and collects matches with their offsets. */
function scanList(text, entries, build) {
  const found = [];
  for (const entry of entries) {
    const re = new RegExp(entry.find.source, entry.find.flags.includes('g') ? entry.find.flags : `${entry.find.flags}g`);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      found.push(build(m, entry));
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

const INFLATED_KEYS = [...INFLATED.keys()].sort((a, b) => b.length - a.length);
const INFLATED_RE = new RegExp(
  `\\b(${INFLATED_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi',
);

/**
 * Full report for a piece of text.
 * @param {string} text
 */
export function analyze(text, options = {}) {
  const clean = String(text || '');
  // A marking guide can forbid the very things the house style asks for. Where
  // it does, the report stops asking for them: an essay required to be formal
  // should not be marked down for having no contractions.
  const constraints = options.constraints || {};
  const sentences = splitSentences(clean);
  const words = tokenise(clean);
  const lengths = sentences.map((s) => s.words.length);
  const paragraphs = clean.split(/\n\s*\n/).filter((p) => p.trim()).length;
  const issues = [];

  // --- rhythm -------------------------------------------------------------
  const avg = mean(lengths);
  const sd = stdev(lengths);
  const cv = avg > 0 ? sd / avg : 0;
  const inRange = lengths.filter((n) => n >= MIN_WORDS && n <= MAX_WORDS).length;
  const longOnes = sentences.filter((s) => s.words.length > MAX_WORDS);

  for (const s of longOnes) {
    issues.push(issue(clean, {
      type: 'long-sentence',
      severity: s.words.length > 32 ? 'high' : 'medium',
      title: `${s.words.length}-word sentence`,
      detail: `Aim for ${MIN_WORDS}-${MAX_WORDS} words. Break it at a conjunction, or cut the padding.`,
      start: s.start,
      end: s.end,
    }));
  }

  if (sentences.length >= 4 && cv < 0.3) {
    issues.push(issue(clean, {
      type: 'flat-rhythm',
      severity: 'high',
      title: 'Sentences are all the same length',
      detail: `Lengths barely move (variation ${(cv * 100).toFixed(0)}%). Drop in a short, punchy one, then let the next breathe.`,
    }));
  }

  // --- openers ------------------------------------------------------------
  const openers = new Map();
  for (const s of sentences) {
    const first = (s.words[0] || '').toLowerCase();
    if (!first) continue;
    if (!openers.has(first)) openers.set(first, []);
    openers.get(first).push(s);
  }
  for (const [word, group] of openers) {
    if (group.length >= 3) {
      issues.push(issue(clean, {
        type: 'repeated-opener',
        severity: 'medium',
        title: `${group.length} sentences open with "${word}"`,
        detail: 'Start somewhere else: a dependent clause, a question, a single word.',
        start: group[1].start,
        end: group[1].end,
      }));
    }
  }

  // --- voice --------------------------------------------------------------
  const passives = findPassives(clean);
  for (const p of passives) {
    issues.push(issue(clean, {
      type: 'passive',
      severity: p.agent ? 'high' : 'medium',
      title: p.agent ? `Passive with a named actor: "${p.match.trim()}"` : `Passive: "${p.match.trim()}"`,
      detail: p.agent
        ? 'The actor is right there in the sentence. Put them in front of the verb.'
        : 'Who did this? Name them and the sentence gets shorter.',
      start: p.index,
      end: p.index + p.length,
      fix: p.rewrite ? `active: ${p.agent} ${p.rewrite} …` : null,
    }));
  }

  // --- machine phrasing ---------------------------------------------------
  const tells = scanList(clean, AI_TELLS, (m, entry) => ({
    start: m.index, end: m.index + m[0].length, match: m[0], label: entry.label,
  }));
  for (const t of tells) {
    issues.push(issue(clean, {
      type: 'ai-tell',
      severity: 'high',
      title: `Stock phrasing: "${t.match.trim()}"`,
      detail: `Reads as ${t.label}. Say the thing itself instead.`,
      start: t.start,
      end: t.end,
    }));
  }

  const selfRefs = scanList(clean, SELF_REFERENCE.map((find) => ({ find })), (m) => ({
    start: m.index, end: m.index + m[0].length, match: m[0],
  }));
  for (const r of selfRefs) {
    issues.push(issue(clean, {
      type: 'self-reference',
      severity: 'medium',
      title: `Talks about the writing: "${r.match.trim()}"`,
      detail: 'Cut the scaffolding and make the point directly.',
      start: r.start,
      end: r.end,
    }));
  }

  // --- plain words --------------------------------------------------------
  const inflated = [];
  INFLATED_RE.lastIndex = 0;
  let im;
  while ((im = INFLATED_RE.exec(clean)) !== null) {
    const key = im[0].toLowerCase();
    const simpler = INFLATED.get(key);
    if (!simpler) continue;
    inflated.push({ start: im.index, end: im.index + im[0].length, match: im[0], simpler });
  }
  for (const w of inflated) {
    issues.push(issue(clean, {
      type: 'inflated',
      severity: 'medium',
      title: `"${w.match}" → "${w.simpler}"`,
      detail: 'A shorter word carries the same meaning here.',
      start: w.start,
      end: w.end,
      fix: w.simpler,
    }));
  }

  const FLAG_ONLY_RE = new RegExp(
    `\\b(${[...FLAG_ONLY.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'gi',
  );
  let fm;
  while ((fm = FLAG_ONLY_RE.exec(clean)) !== null) {
    const advice = FLAG_ONLY.get(fm[0].toLowerCase());
    if (!advice) continue;
    issues.push(issue(clean, {
      type: 'jargon',
      severity: 'medium',
      title: `"${fm[0]}"`,
      detail: advice,
      start: fm.index,
      end: fm.index + fm[0].length,
    }));
  }

  const nominals = scanList(clean, NOMINALIZATIONS, (m, entry) => ({
    start: m.index, end: m.index + m[0].length, match: m[0], simpler: entry.use,
  }));
  for (const n of nominals) {
    issues.push(issue(clean, {
      type: 'nominalisation',
      severity: 'medium',
      title: `"${n.match}" → "${n.simpler}"`,
      detail: 'A buried verb. Let it do the work.',
      start: n.start,
      end: n.end,
      fix: n.simpler,
    }));
  }

  // --- comma rule ---------------------------------------------------------
  const splices = findCommaSplices(clean);
  for (const s of splices) {
    issues.push(issue(clean, {
      type: 'comma-splice',
      severity: 'medium',
      title: `Comma before "${s.conjunction}" joins two full clauses`,
      detail: 'House rule: no comma before and, but, for, or, nor, so, yet when both sides stand alone.',
      start: s.index,
      end: s.index + 1,
    }));
  }

  // --- padding ------------------------------------------------------------
  const hedgeRe = new RegExp(`\\b(${HEDGES.join('|')})\\b`, 'gi');
  const hedges = [];
  let hm;
  while ((hm = hedgeRe.exec(clean)) !== null) {
    // "would rather" is a preference, not an intensifier.
    const before = clean.slice(Math.max(0, hm.index - 12), hm.index);
    if (/\b(?:would|should|could|'d)\s+$/i.test(before) && /^rather$/i.test(hm[0])) continue;
    hedges.push({ start: hm.index, end: hm.index + hm[0].length, match: hm[0] });
  }
  if (hedges.length > Math.max(1, words.length / 120)) {
    issues.push(issue(clean, {
      type: 'hedge',
      severity: 'low',
      title: `${hedges.length} intensifiers doing no work`,
      detail: `Words like "${hedges.slice(0, 3).map((h) => h.match).join('", "')}" dilute the sentence. Cut them.`,
      start: hedges[0].start,
      end: hedges[0].end,
    }));
  }

  // --- contractions -------------------------------------------------------
  let contractionSlots = 0;
  for (const entry of EXPANSIONS) {
    const re = new RegExp(entry.find.source, entry.find.flags);
    contractionSlots += (clean.match(re) || []).length;
  }
  const contractionsUsed = (clean.match(CONTRACTION_RE) || []).length;
  if (contractionSlots >= 3 && contractionsUsed === 0 && !constraints.noContractions) {
    issues.push(issue(clean, {
      type: 'no-contractions',
      severity: 'high',
      title: `${contractionSlots} phrases could contract, none do`,
      detail: 'Nobody says "do not" out loud. "Don\'t" is how people talk.',
    }));
  }

  // --- repetition ---------------------------------------------------------
  const freq = new Map();
  for (const w of words) {
    const key = w.toLowerCase();
    if (key.length < 5 || isCommonWord(key)) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  const repeated = [...freq.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  for (const [word, n] of repeated) {
    const at = clean.toLowerCase().indexOf(word);
    issues.push(issue(clean, {
      type: 'repetition',
      severity: n >= 5 ? 'medium' : 'low',
      title: `"${word}" appears ${n} times`,
      detail: 'Reach for a synonym, or restructure so the word is not needed again.',
      start: at >= 0 ? at : null,
      end: at >= 0 ? at + word.length : null,
    }));
  }

  // --- reader connection --------------------------------------------------
  const secondPerson = (clean.match(/\b(?:you|your|you're|yours)\b/gi) || []).length;
  if (words.length > 80 && secondPerson === 0 && !constraints.noSecondPerson) {
    issues.push(issue(clean, {
      type: 'no-you',
      severity: 'medium',
      title: 'Never speaks to the reader',
      detail: 'One "you" turns a lecture into a conversation.',
    }));
  }

  const transitionCount = NATURAL_TRANSITIONS.reduce((n, t) => {
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    return n + (clean.match(re) || []).length;
  }, 0);
  if (sentences.length >= 5 && transitionCount === 0) {
    issues.push(issue(clean, {
      type: 'no-transitions',
      severity: 'low',
      title: 'No connective tissue between ideas',
      detail: 'A plain "However" or "For example" shows the reader how the parts fit.',
    }));
  }

  // --- vocabulary ---------------------------------------------------------
  const contentWords = words.filter((w) => w.length > 3).map((w) => w.toLowerCase());
  const ttr = contentWords.length ? new Set(contentWords).size / contentWords.length : 0;
  const rareShare = contentWords.length
    ? contentWords.filter((w) => !isCommonWord(w)).length / contentWords.length
    : 0;
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i += 1) {
    bigrams.push(`${words[i].toLowerCase()} ${words[i + 1].toLowerCase()}`);
  }
  const bigramRepeat = bigrams.length ? 1 - new Set(bigrams).size / bigrams.length : 0;

  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const flesch = sentences.length && words.length
    ? 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length)
    : 0;

  // --- scores -------------------------------------------------------------
  const perHundred = (n) => (words.length ? (n / words.length) * 100 : 0);
  const passiveShare = sentences.length ? passives.length / sentences.length : 0;

  const subscores = {
    rhythm: clamp(Math.round((cv / 0.55) * 100)),
    voice: clamp(Math.round(100 - passiveShare * 180)),
    plainness: clamp(Math.round(100 - (perHundred(tells.length) * 22 + perHundred(inflated.length) * 14 + perHundred(nominals.length) * 14))),
    // Smoothed so a 40-word note with one missed contraction is not scored as
    // harshly as an essay that never contracts anything.
    warmth: clamp(Math.round(
      ((contractionsUsed + 1) / (contractionsUsed + contractionSlots + 2)) * 70
      + Math.min(30, secondPerson * 10),
    )),
    variety: clamp(Math.round(ttr * 110 + rareShare * 40 - bigramRepeat * 120)),
    // An allowance of roughly one intensifier per 150 words, then a penalty.
    // A density-only measure would punish a 30-word note for a single "very".
    concision: clamp(Math.round(
      100
      - Math.max(0, avg - MAX_WORDS) * 4
      - Math.max(0, hedges.length - words.length / 150) * 6,
    )),
  };

  // Warmth is contractions plus direct address. A guide that bans both has made
  // it unscoreable, so it drops out and its weight is shared by the rest rather
  // than dragging the headline down for following instructions.
  const warmthApplies = !(constraints.noContractions && constraints.noSecondPerson);
  const baseWeights = { rhythm: 0.22, voice: 0.2, plainness: 0.2, warmth: 0.14, variety: 0.12, concision: 0.12 };
  const weights = { ...baseWeights };
  if (!warmthApplies) {
    delete weights.warmth;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    for (const key of Object.keys(weights)) weights[key] /= total;
  }
  const overall = Math.round(
    Object.entries(weights).reduce((sum, [k, w]) => sum + subscores[k] * w, 0),
  );

  const severityRank = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || (a.start ?? 0) - (b.start ?? 0));

  return {
    counts: {
      characters: clean.length,
      words: words.length,
      sentences: sentences.length,
      paragraphs,
      syllables,
    },
    sentences: sentences.map((s) => ({ start: s.start, end: s.end, words: s.words.length, text: s.text })),
    rhythm: {
      average: round1(avg),
      shortest: lengths.length ? Math.min(...lengths) : 0,
      longest: lengths.length ? Math.max(...lengths) : 0,
      stdev: round1(sd),
      burstiness: round2(cv),
      inRangeShare: lengths.length ? round2(inRange / lengths.length) : 0,
    },
    vocabulary: {
      typeTokenRatio: round2(ttr),
      rareWordShare: round2(rareShare),
      repeatedBigramShare: round2(bigramRepeat),
    },
    readability: {
      flesch: round1(flesch),
      label: fleschLabel(flesch),
    },
    tallies: {
      passive: passives.length,
      aiTells: tells.length,
      inflated: inflated.length,
      nominalisations: nominals.length,
      commaSplices: splices.length,
      hedges: hedges.length,
      contractionsUsed,
      contractionSlots,
      secondPerson,
      transitions: transitionCount,
      selfReferences: selfRefs.length,
    },
    subscores,
    // The dashboard greys out a subscore the guide has made meaningless.
    scoredQualities: Object.keys(weights),
    score: overall,
    verdict: verdictFor(overall),
    issues,
  };
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

function fleschLabel(score) {
  if (score >= 80) return 'very easy';
  if (score >= 70) return 'plain English';
  if (score >= 60) return 'fairly plain';
  if (score >= 50) return 'a bit heavy';
  if (score >= 30) return 'dense';
  return 'very dense';
}

function verdictFor(score) {
  if (score >= 85) return 'Sounds like a person';
  if (score >= 70) return 'Mostly human, a few tells';
  if (score >= 55) return 'Stiff in places';
  if (score >= 40) return 'Reads like a report';
  return 'Unmistakably machine-made';
}
