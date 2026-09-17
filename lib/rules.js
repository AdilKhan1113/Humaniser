// The offline rewriter. Every transform here is one of the house rules turned
// into something a computer can check, and every edit it makes is logged so the
// change list in the UI can show its work.
//
// The guiding rule: when a transform cannot be certain, it does nothing and
// leaves the case to the report. A missed fix is a footnote. A wrong fix is a
// sentence the writer has to untangle.

import {
  AI_TELLS, INFLATED, NOMINALIZATIONS, HEDGES, HEDGES_SAFE_TO_CUT, EXPANSIONS,
  CONTRACTION_EXPANSIONS, hedgeIsLoadBearing,
} from './lexicon.js';
import { splitSentences, findCommaSplices, looksIndependent } from './analyze.js';
import { flipPassiveClause } from './passive.js';
import { isKnownParticiple } from './verbs.js';

export const PROFILES = {
  light: {
    label: 'Light touch',
    description: 'Only the changes no one could argue with: stock phrases, inflated words, the comma rule.',
    steps: { tells: true, inflated: true, nominals: true, splices: true },
    contractionRatio: 0,
    splitAt: Infinity,
  },
  balanced: {
    label: 'Balanced',
    description: 'The full house style: active voice, shorter sentences, contractions, no padding.',
    steps: { tells: true, inflated: true, nominals: true, splices: true, passive: true, contractions: true, hedges: true, split: true },
    contractionRatio: 2 / 3,
    splitAt: 22,
  },
  bold: {
    label: 'Bold',
    description: 'Same rules, pushed harder. Shorter sentences, contractions wherever they fit.',
    steps: { tells: true, inflated: true, nominals: true, splices: true, passive: true, contractions: true, hedges: true, split: true },
    contractionRatio: 1,
    splitAt: 18,
  },
};

// Private-use characters, so masked spans cannot collide with real text and
// cannot be matched by \w or \b.
const MASK_OPEN = '';
const MASK_CLOSE = '';

/**
 * Hides the spans no style rule should touch: fenced code, inline code, URLs and
 * markdown links. They come back untouched at the end.
 */
function mask(text) {
  const vault = [];
  const patterns = [
    /```[\s\S]*?```/g,
    /`[^`\n]+`/g,
    /!?\[[^\]]*\]\([^)]*\)/g,
    /\bhttps?:\/\/[^\s)]+/g,
    /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  ];
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (m) => {
      vault.push(m);
      return `${MASK_OPEN}${vault.length - 1}${MASK_CLOSE}`;
    });
  }
  return { text: out, vault };
}

function unmask(text, vault) {
  return text.replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g'),
    (m, i) => vault[Number(i)] ?? m,
  );
}

/** Copies the capitalisation of the original onto the replacement. */
function matchCase(original, replacement) {
  if (!replacement) return replacement;
  if (original === original.toUpperCase() && original.length > 1) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

class ChangeLog {
  constructor() { this.entries = []; }

  add(rule, from, to, note) {
    const cleanFrom = from.replace(/\s+/g, ' ').trim();
    const cleanTo = to.replace(/\s+/g, ' ').trim();
    if (cleanFrom === cleanTo) return;
    this.entries.push({ rule, from: cleanFrom, to: cleanTo, note: note || null });
  }

  get byRule() {
    const tally = {};
    for (const e of this.entries) tally[e.rule] = (tally[e.rule] || 0) + 1;
    return tally;
  }
}

function applyRule(text, find, use, log, rule, note) {
  const re = new RegExp(find.source, find.flags.includes('g') ? find.flags : `${find.flags}g`);
  return text.replace(re, (...args) => {
    const whole = args[0];
    const replacement = typeof use === 'function' ? use(...args) : matchCase(whole, use);
    log.add(rule, whole, replacement, note);
    return replacement;
  });
}

// --- individual transforms -------------------------------------------------

function stripAiTells(text, log) {
  let out = text;
  for (const { find, use, label } of AI_TELLS) {
    out = applyRule(out, find, use, log, 'stock phrase', label);
  }
  return out;
}

const INFLATED_KEYS = [...INFLATED.keys()].sort((a, b) => b.length - a.length);
const INFLATED_RE = new RegExp(
  `\\b(${INFLATED_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi',
);

const BE_BEFORE = /\b(?:is|are|was|were|be|been|being|has been|have been|had been)\s+$/i;

function simplifyWords(text, log) {
  return text.replace(INFLATED_RE, (whole, _g, offset, full) => {
    const key = whole.toLowerCase();
    const simpler = INFLATED.get(key);
    if (!simpler) return whole;
    // "was demonstrated" is a passive participle. Swapping in the past tense of
    // the simpler verb would give "was showed", so leave it for activeVoice and
    // the report to handle.
    const looksParticiple = key.endsWith('ed') || isKnownParticiple(key);
    if (looksParticiple && BE_BEFORE.test(full.slice(Math.max(0, offset - 14), offset))) {
      return whole;
    }
    const replacement = matchCase(whole, simpler);
    log.add('plainer word', whole, replacement);
    return replacement;
  });
}

function unburyVerbs(text, log) {
  let out = text;
  for (const { find, use } of NOMINALIZATIONS) {
    out = applyRule(out, find, use, log, 'buried verb');
  }
  return out;
}

/**
 * Flips agentful passives, one clause at a time. A sentence like "X was done by
 * us, and Y was published" holds two passives, and handling the sentence whole
 * would mean refusing both; splitting on the conjunction lets the half that can
 * be fixed get fixed.
 */
function activeVoice(text, log, allowFirstPerson = true) {
  const sentences = splitSentences(text);
  let out = text;
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const s = sentences[i];
    if (s.text.includes(';')) continue;
    const rebuilt = flipClauses(s.text);
    // "The data was analysed by us" becomes "We analysed the data", which is
    // exactly what a third-person-only marking guide forbids. Leave it passive
    // and let the report mention it.
    if (rebuilt && !allowFirstPerson && /^\s*(?:I|We|Our|My|Us)\b/.test(rebuilt)) continue;
    if (!rebuilt || rebuilt === s.text) continue;
    log.add('active voice', s.text, rebuilt);
    out = out.slice(0, s.start) + rebuilt + out.slice(s.end);
  }
  return out;
}

const CLAUSE_SPLIT = /(,\s+(?:and|but|so|yet|or|nor)\s+)/i;

// A leading bullet, number, blockquote arrow or heading hash belongs to the
// document's structure. Left in place it ends up inside the rewritten clause,
// as in "A bad merge broke - The build".
const LEADING_MARKER = /^(\s*(?:[-*+]|\d+[.)]|>+|#{1,6})\s+)/;

function flipClauses(sentence) {
  const markerMatch = sentence.match(LEADING_MARKER);
  const marker = markerMatch ? markerMatch[1] : '';
  const withoutMarker = marker ? sentence.slice(marker.length) : sentence;

  const m = withoutMarker.match(/^([\s\S]*?)([.!?]*["')\]]*)$/);
  const body = m ? m[1] : withoutMarker;
  const trailingPunctuation = m ? m[2] : '';

  const parts = body.split(CLAUSE_SPLIT);
  let changed = false;
  const rebuilt = parts.map((part, index) => {
    if (index % 2 === 1) return part; // the ", and " separator itself
    const clause = part.trim();
    if (!clause) return part;
    // Only the first clause starts the sentence, so only it takes a capital.
    const flipped = flipPassiveClause(clause, { capitalise: index === 0 });
    if (!flipped || flipped === clause) return part;
    changed = true;
    // Spliced by index rather than String.replace: a replacement string treats
    // $&, $' and $1 as patterns, so text containing them would be mangled.
    const at = part.indexOf(clause);
    return part.slice(0, at) + flipped + part.slice(at + clause.length);
  });

  return changed ? marker + rebuilt.join('') + trailingPunctuation : null;
}

/**
 * Breaks a long sentence at a semicolon or a coordinating conjunction. "But" and
 * "So" stay on as sentence openers, which is how people actually write; "and"
 * just goes.
 */
function splitLongSentences(text, log, limit) {
  let out = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const sentences = splitSentences(out);
    let changed = false;
    for (let i = sentences.length - 1; i >= 0; i -= 1) {
      const s = sentences[i];
      if (s.words.length <= limit) continue;
      const split = findSplitPoint(s.text);
      if (!split) continue;
      log.add('shorter sentences', s.text, split);
      out = out.slice(0, s.start) + split + out.slice(s.end);
      changed = true;
    }
    if (!changed) break;
  }
  return out;
}

function findSplitPoint(sentence) {
  const semi = sentence.indexOf('; ');
  if (semi > 0) {
    const left = sentence.slice(0, semi);
    const right = sentence.slice(semi + 2);
    if (wordCount(left) >= 4 && wordCount(right) >= 4) {
      return `${left}. ${capitalise(right)}`;
    }
  }

  const re = /,\s+(and|but|so|yet|for)\s+/gi;
  let m;
  while ((m = re.exec(sentence)) !== null) {
    const rest = sentence.slice(m.index + m[0].length);
    if (!looksIndependent(rest)) continue;
    const left = sentence.slice(0, m.index);
    if (wordCount(left) < 4 || wordCount(rest) < 4) continue;
    const conj = m[1].toLowerCase();
    const keep = conj === 'and' ? '' : `${capitalise(conj)} `;
    return `${left}. ${keep}${keep ? rest : capitalise(rest)}`;
  }
  return null;
}

function wordCount(s) {
  return (s.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
}

function capitalise(s) {
  const trimmed = s.replace(/^\s+/, '');
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Slices text for display, snapped outwards to whole words. */
function wordSlice(text, from, to) {
  let a = Math.max(0, from);
  let b = Math.min(text.length, to);
  while (a > 0 && /\S/.test(text[a - 1])) a -= 1;
  while (b < text.length && /\S/.test(text[b])) b += 1;
  return text.slice(a, b).replace(/\s+/g, ' ').trim();
}

/** The house comma rule: no comma before a conjunction joining two full clauses. */
function fixCommaSplices(text, log) {
  const splices = findCommaSplices(text);
  let out = text;
  for (let i = splices.length - 1; i >= 0; i -= 1) {
    const s = splices[i];
    const context = wordSlice(out, s.index - 20, s.index + 24);
    out = out.slice(0, s.index) + out.slice(s.index + 1);
    log.add('comma rule', context, context.replace(`, ${s.conjunction}`, ` ${s.conjunction}`), `before "${s.conjunction}"`);
  }
  return out;
}

/**
 * Adds contractions. Negations always contract; pronoun forms are rationed by
 * the profile and capped at two per sentence, because wall-to-wall contractions
 * read as sloppy rather than relaxed.
 */
function addContractions(text, log, ratio) {
  let out = text;

  for (const entry of EXPANSIONS.filter((e) => e.always)) {
    out = applyRule(out, entry.find, entry.use, log, 'contraction');
  }
  if (ratio <= 0) return out;

  const rationed = EXPANSIONS.filter((e) => !e.always);
  const candidates = [];
  for (const entry of rationed) {
    const re = new RegExp(entry.find.source, entry.find.flags.includes('g') ? entry.find.flags : `${entry.find.flags}g`);
    let m;
    while ((m = re.exec(out)) !== null) {
      const single = new RegExp(entry.find.source, entry.find.flags.replace('g', ''));
      candidates.push({
        start: m.index,
        end: m.index + m[0].length,
        from: m[0],
        to: m[0].replace(single, entry.use),
      });
    }
  }
  candidates.sort((a, b) => a.start - b.start);

  const sentences = splitSentences(out);
  const perSentence = new Map();
  const keep = [];
  let seen = 0;
  let lastEnd = -1;

  for (const c of candidates) {
    if (c.start < lastEnd) continue; // overlapping match, already claimed
    const sentenceIndex = sentences.findIndex((s) => c.start >= s.start && c.start < s.end);
    const used = perSentence.get(sentenceIndex) || 0;
    if (used >= 2) continue;
    seen += 1;
    // ratio 2/3 means "skip every third opportunity", deterministically.
    if (ratio < 1 && seen % 3 === 0) continue;
    perSentence.set(sentenceIndex, used + 1);
    keep.push(c);
    lastEnd = c.end;
  }

  for (let i = keep.length - 1; i >= 0; i -= 1) {
    const c = keep[i];
    out = out.slice(0, c.start) + c.to + out.slice(c.end);
    log.add('contraction', c.from, c.to);
  }
  return out;
}

/**
 * Cuts intensifiers that add nothing, in two passes with different risk.
 *
 * Followed by a comma the word is a sentence adverb ("Clearly, the plan
 * works"), which is padding whichever word it is. Followed by a space it sits
 * against the next word, and there the four manner adverbs are left alone:
 * cutting "clearly" out of "speak clearly and slowly" removes the point of the
 * sentence. Either way the context is checked, because deleting the "rather"
 * in "rather than" changes what the sentence says.
 */
/** Writes contractions out in full, for guides that require it. */
function expandContractions(text, log) {
  let out = text;
  for (const { find, use } of CONTRACTION_EXPANSIONS) {
    out = applyRule(out, find, use, log, 'contraction removed');
  }
  return out;
}

function trimPadding(text, log) {
  const cut = (out, group, pattern) => {
    const re = new RegExp(`\\b(${group})${pattern}`, 'gi');
    return out.replace(re, (whole, word, offset, full) => {
      const before = full.slice(Math.max(0, offset - 16), offset);
      const after = full.slice(offset + whole.length, offset + whole.length + 16);
      if (hedgeIsLoadBearing(word, before, after)) return whole;
      log.add('cut padding', whole, '');
      return '';
    });
  };

  let out = cut(text, HEDGES.join('|'), ',\\s+');
  out = cut(out, HEDGES_SAFE_TO_CUT.join('|'), '\\s+(?=[a-z])');
  return out;
}

/** Repairs capitals and spacing left behind by the transforms above. */
function tidy(text) {
  let out = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/^[ \t]*[,;:]\s*/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  // A quotation opening mid-sentence starts a sentence of its own.
  out = out.replace(/([,:]\s*["“'])\s*([a-z])/g, (m, lead, letter) => lead + letter.toUpperCase());

  // Sentence-initial capitals, which phrase removal often knocks out. The
  // position has to be a real sentence opening — the start of the text, after a
  // blank line, or after sentence punctuation — and never the far side of a
  // line wrap, which would put a capital in the middle of a sentence.
  for (const s of splitSentences(out).reverse()) {
    const first = out[s.start];
    if (!first || !/[a-z]/.test(first)) continue;
    const preceding = out.slice(0, s.start);
    const opensBlock = preceding.trim() === ''
      || /\n[ \t]*\n[ \t]*$/.test(preceding)
      || /[.!?]["')\]]*[ \t]*$/.test(preceding);
    if (!opensBlock) continue;
    out = out.slice(0, s.start) + first.toUpperCase() + out.slice(s.start + 1);
  }
  return out.replace(/\bi\b(?!\.)/g, 'I').trim();
}

// --- pipeline --------------------------------------------------------------

/**
 * Rewrites text with the offline rules engine.
 * @param {string} input
 * @param {{strength?: 'light'|'balanced'|'bold'}} options
 * @returns {{text:string, changes:Array, byRule:Object, profile:string}}
 */
export function humanise(input, options = {}) {
  const strength = PROFILES[options.strength] ? options.strength : 'balanced';
  const profile = PROFILES[strength];
  const constraints = options.constraints || {};
  const log = new ChangeLog();

  const masked = mask(String(input || ''));
  let text = masked.text;

  // Order is deliberate: passives are flipped while their participles are still
  // intact, and the comma rule runs after splitting, which can create new joins.
  if (profile.steps.tells) text = stripAiTells(text, log);
  if (profile.steps.passive) text = activeVoice(text, log, !constraints.noFirstPerson);
  if (profile.steps.inflated) text = simplifyWords(text, log);
  if (profile.steps.nominals) text = unburyVerbs(text, log);
  if (profile.steps.split) text = splitLongSentences(text, log, profile.splitAt);
  if (profile.steps.splices) text = fixCommaSplices(text, log);

  // A marking guide that bans contractions reverses this rule rather than
  // merely disabling it: the draft's existing contractions are written out.
  if (constraints.noContractions) {
    text = expandContractions(text, log);
  } else if (profile.steps.contractions) {
    text = addContractions(text, log, profile.contractionRatio);
  }

  if (profile.steps.hedges) text = trimPadding(text, log);

  text = tidy(text);

  return {
    text: unmask(text, masked.vault),
    changes: log.entries,
    byRule: log.byRule,
    profile: strength,
    constraints,
  };
}
