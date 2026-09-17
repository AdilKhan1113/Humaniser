// Reading a marking guide.
//
// A rubric holds two kinds of requirement. Some are checkable by counting:
// word limits, required sections, referencing style, whether the draft mentions
// the concepts the guide keeps naming. Others need a marker's judgement —
// "evaluates critically", "demonstrates深 understanding" — and no amount of
// regex touches those. This module handles the first kind and says nothing
// about the second.
//
// The important part is the style constraints. Academic guides often demand the
// opposite of this app's house style: no contractions, third person only,
// formal register. Left alone the rewriter would push a draft further from its
// own marking guide, so a detected constraint switches the offending rule off.

import { isCommonWord } from './common-words.js';
import { CONTRACTION_RE } from './lexicon.js';

const NUM = String.raw`(\d[\d,]*)`;

/** Pulls a word limit out of the guide, in any of the usual phrasings. */
function findWordLimit(text) {
  const clean = text.replace(/,(?=\d{3}\b)/g, '');
  const patterns = [
    // 2000-2500 words
    { re: new RegExp(String.raw`(\d[\d]*)\s*(?:-|–|—|to)\s*(\d[\d]*)\s*words`, 'i'), take: (m) => ({ min: +m[1], max: +m[2] }) },
    // no more than / maximum of / up to 2000 words
    { re: new RegExp(String.raw`(?:no more than|not exceed(?:ing)?|maximum(?: of)?|max(?: of)?|up to|within)\s*${NUM}\s*words`, 'i'), take: (m) => ({ max: +m[1] }) },
    // at least / minimum of 1000 words
    { re: new RegExp(String.raw`(?:at least|no fewer than|minimum(?: of)?|min(?: of)?)\s*${NUM}\s*words`, 'i'), take: (m) => ({ min: +m[1] }) },
    // word limit: 2000 / word count: 2000
    { re: new RegExp(String.raw`word\s*(?:limit|count|length)\s*(?:is|of|:|=)?\s*${NUM}`, 'i'), take: (m) => ({ target: +m[1] }) },
    // 2000 words
    { re: new RegExp(String.raw`${NUM}\s*words`, 'i'), take: (m) => ({ target: +m[1] }) },
  ];

  for (const { re, take } of patterns) {
    const m = clean.match(re);
    if (m) {
      const limit = take(m);
      // A stated tolerance turns a single target into a range.
      const tol = clean.match(/(?:±|\+\/-|plus or minus)\s*(\d+)\s*%/i)
        || clean.match(/within\s*(\d+)\s*%/i);
      if (tol && limit.target) {
        const slack = Math.round(limit.target * (Number(tol[1]) / 100));
        return { target: limit.target, min: limit.target - slack, max: limit.target + slack, tolerance: Number(tol[1]) };
      }
      return limit;
    }
  }
  return null;
}

// Each constraint is a house rule the guide forbids. `rule` names what gets
// switched off in the rewriter.
const STYLE_RULES = [
  {
    key: 'noContractions',
    label: 'No contractions',
    rule: 'contractions',
    patterns: [
      /avoid(?:\s+the\s+use\s+of)?\s+contractions/i,
      /(?:do\s*n[o']?t|don't|never)\s+use\s+contractions/i,
      /no\s+contractions/i,
      /contractions\s+(?:are\s+)?(?:should\s+be\s+)?(?:not\s+)?(?:avoided|discouraged|unacceptable)/i,
      /write\s+(?:words\s+)?in\s+full/i,
    ],
  },
  {
    key: 'noFirstPerson',
    label: 'Third person only',
    rule: 'firstPerson',
    patterns: [
      /avoid(?:\s+the\s+use\s+of)?\s+(?:the\s+)?first[-\s]person/i,
      /(?:do\s*n[o']?t|don't|never)\s+use\s+(?:the\s+)?first[-\s]person/i,
      /no\s+first[-\s]person/i,
      /third[-\s]person\s+(?:only|throughout|perspective|voice)/i,
      /writ(?:e|ten)\s+in\s+the\s+third[-\s]person/i,
      /avoid\s+(?:using\s+)?["“']?I["”']?\s+and\s+["“']?we["”']?/i,
    ],
  },
  {
    key: 'noSecondPerson',
    label: 'Do not address the reader',
    rule: 'secondPerson',
    patterns: [
      /avoid(?:\s+the\s+use\s+of)?\s+(?:the\s+)?second[-\s]person/i,
      /(?:do\s*n[o']?t|don't|never)\s+address\s+the\s+reader/i,
      /avoid\s+(?:using\s+)?["“']?you["”']?/i,
      /no\s+second[-\s]person/i,
    ],
  },
  {
    key: 'formalRegister',
    label: 'Formal academic register',
    rule: 'informal',
    patterns: [
      /formal\s+(?:academic\s+)?(?:tone|register|style|language|writing)/i,
      /academic\s+(?:tone|register|style)/i,
      /avoid\s+(?:colloquial|informal|conversational|casual)/i,
      /avoid\s+slang/i,
      /scholarly\s+(?:tone|register|style)/i,
    ],
  },
  {
    key: 'noBulletPoints',
    label: 'Continuous prose, no bullet points',
    rule: 'bullets',
    patterns: [
      /avoid\s+bullet\s*points?/i,
      /no\s+bullet\s*points?/i,
      /continuous\s+prose/i,
      /(?:do\s*n[o']?t|don't)\s+use\s+(?:bullet\s*points?|lists)/i,
    ],
  },
];

const CITATION_STYLES = [
  { name: 'APA', re: /\bAPA\b\s*(\d+(?:th)?)?/i },
  { name: 'Harvard', re: /\bHarvard\b/i },
  { name: 'MLA', re: /\bMLA\b/i },
  { name: 'Chicago', re: /\bChicago\b/i },
  { name: 'Vancouver', re: /\bVancouver\b/i },
  { name: 'IEEE', re: /\bIEEE\b/i },
  { name: 'OSCOLA', re: /\bOSCOLA\b/i },
];

const SECTION_NAMES = [
  'abstract', 'introduction', 'background', 'literature review', 'method',
  'methods', 'methodology', 'participants', 'materials', 'procedure',
  'results', 'findings', 'analysis', 'discussion', 'conclusion',
  'recommendations', 'references', 'reference list', 'bibliography',
  'appendix', 'appendices', 'executive summary',
];

/** Lines that read as a criterion: bullets, numbers, or a "marks" allocation. */
function findCriteria(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 12 && line.length < 300)
    .filter((line) => /^(?:[-*•▪]|\d+[.)]|\(\w\))\s/.test(line) || /\(\s*\d+\s*(?:marks?|points?|%)\s*\)/i.test(line))
    .map((line) => line.replace(/^(?:[-*•▪]|\d+[.)]|\(\w\))\s*/, ''))
    .slice(0, 25);
}

/**
 * Concepts the guide leans on: uncommon words it uses more than once, or that
 * appear inside a criterion. These become a coverage check against the draft.
 */
function findKeyTerms(text, criteria) {
  const criteriaText = criteria.join(' ').toLowerCase();
  const counts = new Map();
  const words = text.match(/[A-Za-z][A-Za-z-]{3,}/g) || [];

  for (const raw of words) {
    const word = raw.toLowerCase();
    if (isCommonWord(word)) continue;
    if (SECTION_NAMES.includes(word)) continue;
    if (RUBRIC_JARGON.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([word, n]) => n >= 2 || criteriaText.includes(word))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word]) => word);
}

// Words a rubric uses to talk about marking rather than about the subject.
const RUBRIC_JARGON = new Set([
  'rubric', 'criteria', 'criterion', 'marks', 'marking', 'grade', 'grades',
  'grading', 'assessment', 'assessed', 'submission', 'submit', 'deadline',
  'weighting', 'excellent', 'satisfactory', 'unsatisfactory', 'distinction',
  'credit', 'fail', 'pass', 'demonstrates', 'demonstrate', 'demonstrated',
  'evidences', 'articulates', 'coherent', 'coherence', 'cohesion', 'clarity',
  'accurate', 'accurately', 'appropriate', 'appropriately', 'relevant',
  'relevance', 'thorough', 'thoroughly', 'critically', 'critical', 'analysis',
  'analyse', 'analyze', 'evaluate', 'evaluation', 'synthesis', 'synthesise',
  'referencing', 'citation', 'citations', 'cited', 'sources', 'formatting',
  'structure', 'structured', 'argument', 'arguments', 'assignment', 'essay',
  'report', 'student', 'students', 'learning', 'outcomes', 'understanding',
  'knowledge', 'application', 'applied', 'concepts', 'concept', 'theory',
  'theories', 'theoretical', 'discussion', 'conclusion', 'introduction',
  'paragraph', 'paragraphs', 'sentence', 'sentences', 'words', 'word',
  // Instruction verbs: a guide says "identifies X accurately", and the concept
  // is X, not "identifies".
  'avoid', 'avoids', 'applies', 'apply', 'applied', 'identifies', 'identify',
  'identified', 'evaluates', 'evaluated', 'describes', 'describe', 'described',
  'discusses', 'discuss', 'discussed', 'explains', 'explain', 'explained',
  'outlines', 'outline', 'outlined', 'compares', 'compare', 'compared',
  'contrasts', 'contrast', 'considers', 'consider', 'considered', 'examines',
  'examine', 'examined', 'includes', 'include', 'included', 'provides',
  'provide', 'provided', 'refers', 'refer', 'referred', 'shows', 'states',
  'presents', 'present', 'addresses', 'reflects', 'reflect', 'links', 'link',
  'integrates', 'integrate', 'justifies', 'justify', 'supports', 'argues',
  'argue', 'defines', 'define', 'explores', 'explore', 'summarises',
  'summarizes', 'interprets', 'interpret', 'uses', 'using', 'used', 'makes',
  'ensure', 'ensures', 'should', 'must', 'throughout', 'clearly', 'accurately',
  'edition', 'limit', 'guide', 'peer-reviewed', 'reviewed',
]);

/**
 * Reads a marking guide.
 * @param {string} text the guide's plain text
 */
export function parseRubric(text) {
  const clean = String(text || '');
  if (!clean.trim()) return null;

  const criteria = findCriteria(clean);
  const constraints = {};
  const applied = [];

  for (const rule of STYLE_RULES) {
    const hit = rule.patterns.find((re) => re.test(clean));
    if (!hit) continue;
    constraints[rule.key] = true;
    applied.push({ key: rule.key, label: rule.label, rule: rule.rule, evidence: excerptFor(clean, hit) });
  }

  // A formal register implies the two it does not always spell out.
  if (constraints.formalRegister) {
    constraints.noContractions = true;
    constraints.noSecondPerson = true;
  }

  const citation = CITATION_STYLES.find((s) => s.re.test(clean));
  const sources = clean.match(/at least\s*(\d+)\s*(?:peer[-\s]reviewed\s*)?(?:sources|references|articles|journal)/i)
    || clean.match(/minimum(?: of)?\s*(\d+)\s*(?:peer[-\s]reviewed\s*)?(?:sources|references|articles)/i);

  const lower = clean.toLowerCase();
  const sections = SECTION_NAMES.filter((name) => {
    const re = new RegExp(`(?:^|[\\n\\s(,;:])${name.replace(/ /g, '\\s+')}(?:[\\s):,;.]|$)`, 'i');
    return re.test(lower);
  });

  return {
    wordLimit: findWordLimit(clean),
    constraints,
    appliedConstraints: applied,
    citationStyle: citation ? citation.name : null,
    minSources: sources ? Number(sources[1]) : null,
    sections,
    keyTerms: findKeyTerms(clean, criteria),
    criteria,
    length: clean.length,
  };
}

function excerptFor(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const start = Math.max(0, m.index - 30);
  const end = Math.min(text.length, m.index + m[0].length + 30);
  return `…${text.slice(start, end).replace(/\s+/g, ' ').trim()}…`;
}

/**
 * Checks a draft against a parsed guide. Every check here is countable; nothing
 * pretends to judge the writing's quality.
 *
 * @returns {Array<{label:string, status:'pass'|'warn'|'fail'|'info', detail:string}>}
 */
export function checkAgainstRubric(draft, rubric) {
  if (!rubric) return [];
  const text = String(draft || '');
  const words = (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
  const lower = text.toLowerCase();
  const checks = [];

  // --- word count ---
  const limit = rubric.wordLimit;
  if (limit) {
    const { min, max, target, tolerance } = limit;
    const stated = target
      ? `${target.toLocaleString()}${tolerance ? ` ±${tolerance}%` : ''}`
      : [min && `min ${min.toLocaleString()}`, max && `max ${max.toLocaleString()}`].filter(Boolean).join(', ');
    let status = 'pass';
    let detail = `${words.toLocaleString()} words against ${stated}.`;
    if (max && words > max) {
      status = 'fail';
      detail = `${words.toLocaleString()} words is ${(words - max).toLocaleString()} over the ${max.toLocaleString()} limit.`;
    } else if (min && words < min) {
      status = 'fail';
      detail = `${words.toLocaleString()} words is ${(min - words).toLocaleString()} short of ${min.toLocaleString()}.`;
    } else if (target && !min && !max) {
      const drift = Math.abs(words - target) / target;
      status = drift > 0.1 ? 'warn' : 'pass';
      detail = `${words.toLocaleString()} words against a target of ${target.toLocaleString()}.`;
    }
    checks.push({ label: 'Word count', status, detail });
  }

  // --- style constraints the guide imposes ---
  if (rubric.constraints.noContractions) {
    const found = text.match(CONTRACTION_RE) || [];
    checks.push({
      label: 'No contractions',
      status: found.length ? 'fail' : 'pass',
      detail: found.length
        ? `${found.length} found: ${[...new Set(found)].slice(0, 5).join(', ')}.`
        : 'None found.',
    });
  }

  if (rubric.constraints.noFirstPerson) {
    // Case-insensitive, or a sentence opening with "We" slips past. "US" in
    // capitals is the country, not the pronoun, so it is dropped again.
    const found = (text.match(/\b(?:I|I['’](?:m|ve|ll|d)|me|my|mine|myself|we|we['’](?:re|ve|ll|d)|us|our|ours|ourselves)\b/gi) || [])
      .filter((word) => word !== 'US');
    checks.push({
      label: 'Third person only',
      status: found.length ? 'fail' : 'pass',
      detail: found.length
        ? `${found.length} first-person word${found.length === 1 ? '' : 's'}: ${[...new Set(found)].slice(0, 5).join(', ')}.`
        : 'None found.',
    });
  }

  if (rubric.constraints.noSecondPerson) {
    const found = text.match(/\b(?:you|your|yours|you're|you've)\b/gi) || [];
    checks.push({
      label: 'Does not address the reader',
      status: found.length ? 'fail' : 'pass',
      detail: found.length ? `${found.length} use${found.length === 1 ? '' : 's'} of "you".` : 'None found.',
    });
  }

  if (rubric.constraints.noBulletPoints) {
    const bullets = (text.match(/^\s*(?:[-*•▪]|\d+[.)])\s+/gm) || []).length;
    checks.push({
      label: 'Continuous prose',
      status: bullets ? 'fail' : 'pass',
      detail: bullets ? `${bullets} list item${bullets === 1 ? '' : 's'} found.` : 'No lists found.',
    });
  }

  // --- references ---
  if (rubric.minSources) {
    // Author-date citations, e.g. (Baker et al., 2021) or (Kariou & Lee, 2019).
    const citations = text.match(/\([^)]*\b(?:19|20)\d{2}[a-z]?\b[^)]*\)/g) || [];
    const distinct = new Set(citations.map((c) => c.replace(/\s+/g, ' ').toLowerCase()));
    checks.push({
      label: `At least ${rubric.minSources} sources`,
      status: distinct.size >= rubric.minSources ? 'pass' : 'warn',
      detail: `${distinct.size} distinct in-text citation${distinct.size === 1 ? '' : 's'} found. Counted from the text, so a reference list is not included.`,
    });
  }

  if (rubric.citationStyle) {
    checks.push({
      label: `${rubric.citationStyle} referencing`,
      status: 'info',
      detail: 'The guide names this style. Formatting is not something this app can verify.',
    });
  }

  // --- required sections ---
  if (rubric.sections.length >= 2) {
    const missing = rubric.sections.filter((name) => !lower.includes(name));
    checks.push({
      label: 'Sections named in the guide',
      status: missing.length === 0 ? 'pass' : 'warn',
      detail: missing.length === 0
        ? `All ${rubric.sections.length} appear: ${rubric.sections.join(', ')}.`
        : `Not mentioned: ${missing.join(', ')}.`,
    });
  }

  // --- concept coverage ---
  if (rubric.keyTerms.length) {
    const missing = rubric.keyTerms.filter((term) => !lower.includes(term));
    const covered = rubric.keyTerms.length - missing.length;
    checks.push({
      label: 'Concepts the guide emphasises',
      status: missing.length === 0 ? 'pass' : missing.length > rubric.keyTerms.length / 2 ? 'warn' : 'info',
      detail: missing.length === 0
        ? `All ${covered} appear in the draft.`
        : `${covered} of ${rubric.keyTerms.length} appear. Not mentioned: ${missing.join(', ')}.`,
    });
  }

  if (rubric.criteria.length) {
    checks.push({
      label: `${rubric.criteria.length} criteria read from the guide`,
      status: 'info',
      detail: 'Whether the writing meets them is a marker\'s judgement, not something counting can settle.',
    });
  }

  return checks;
}
