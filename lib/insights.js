// Reading across papers: the study table and the synthesised answer.
//
// The offline half pulls study design, sample size, population and the key
// finding out of an abstract with patterns. It is quick and needs no key, and
// it is right often enough to sort a result list by strength of evidence. The
// model half reads the same abstracts and writes a cited answer with each
// paper's stance on the question; its prompt and its parser live here too.
//
// Pure, with no Node imports, so the browser loads it as well.

import { splitSentences } from './sentences.js';

// Strongest evidence first. The first pattern that matches wins, so order matters.
export const DESIGNS = [
  { id: 'meta-analysis', label: 'Meta-analysis', rank: 1, re: /meta-?analy[sz]/i },
  { id: 'systematic-review', label: 'Systematic review', rank: 2, re: /systematic(ally)? review|scoping review|umbrella review/i },
  { id: 'rct', label: 'Randomised controlled trial', rank: 3, re: /randomi[sz]ed[\w\s,-]{0,40}\b(trial|crossover|design)|\bRCTs?\b|random(ly)? assigned|random allocation/i },
  { id: 'controlled', label: 'Controlled study', rank: 4, re: /quasi-experiment|non-?randomi[sz]ed|controlled (trial|study)|control group/i },
  { id: 'cohort', label: 'Cohort study', rank: 5, re: /\bcohort\b|longitudinal|prospective(ly)?|follow(ed)?[- ]up (study|of)|\bwaves?\b/i },
  { id: 'case-control', label: 'Case-control study', rank: 6, re: /case[- ]control/i },
  { id: 'cross-sectional', label: 'Cross-sectional study', rank: 7, re: /cross-sectional|survey(ed)?\b|questionnaire/i },
  { id: 'experiment', label: 'Experiment', rank: 7, re: /\bexperiment(s|al)?\b|laboratory study|in vitro|in vivo|mice|rats\b/i },
  { id: 'qualitative', label: 'Qualitative study', rank: 8, re: /qualitative|semi-structured|interviews?\b|focus groups?|thematic analysis|ethnograph/i },
  { id: 'review', label: 'Narrative review', rank: 8, re: /\b(literature |narrative )?review\b|we review|this review/i },
  { id: 'modelling', label: 'Modelling study', rank: 9, re: /simulat(ion|ed)|computational model|mathematical model|machine learning model/i },
  { id: 'case-report', label: 'Case report', rank: 10, re: /case (study|report|series)/i },
];

const UNITS = 'participants|patients|subjects|adults|children|students|pupils|individuals|people|respondents|women|men|mothers|adolescents|infants|volunteers|households|cases|controls|employees|workers|nurses|teachers|athletes|veterans|smokers|twins|pairs|schools|hospitals|firms|countries|mice|rats';
const COUNT_RE = new RegExp(`\\b(\\d{1,3}(?:,\\d{3})+|\\d+)\\s+((?:[a-z-]+\\s+){0,2}(?:${UNITS}))\\b([^.;]{0,50})`, 'i');
const N_RE = /\b[Nn]\s*=\s*(\d{1,3}(?:,\d{3})+|\d+)/;
const STUDIES_RE = /\b(\d{1,3}(?:,\d{3})*|\d+)\s+((?:[a-z-]+\s+){0,2}(?:studies|trials|articles|papers|RCTs|cohorts|samples))\b/i;

const FINDING_VERBS = /\b(suggest|conclude|indicate|show|found|find|demonstrat|reveal|associated|linked|predict|reduc|increas|improv|decreas|impair|no (significant )?(effect|difference|association)|did not|was not|were not|effective|outperform)/i;

const toNumber = (s) => Number(String(s).replace(/,/g, ''));

/** Pulls what a reader scans for from an abstract. Missing fields are null, never guessed. */
export function extractStudy(work) {
  const abstract = work?.abstract || '';
  const text = `${work?.title || ''}. ${abstract}`;
  const design = DESIGNS.find((d) => d.re.test(text))
    || (work?.type === 'review' ? DESIGNS.find((d) => d.id === 'review') : null);

  let sample = null;
  let population = null;
  const studies = abstract.match(STUDIES_RE);
  const count = abstract.match(COUNT_RE);
  const n = abstract.match(N_RE);
  if (design && ['meta-analysis', 'systematic-review', 'review'].includes(design.id) && studies) {
    sample = `${toNumber(studies[1]).toLocaleString('en')} ${studies[2].trim()}`;
  } else if (count && !(toNumber(count[1]) >= 1900 && toNumber(count[1]) <= 2100)) {
    sample = `${toNumber(count[1]).toLocaleString('en')} ${count[2].trim()}`;
    // "84 students aged 14 to 17 completed…" -> "students aged 14 to 17"
    const tail = count[3].match(/^\s*(aged [\d–-]+(?: to \d+)?(?: years)?|from [^,]{3,35}|in [^,]{3,35}|with [^,]{3,35})/i);
    population = `${count[2].trim()}${tail ? ` ${tail[1].trim()}` : ''}`;
  } else if (n) {
    sample = `n = ${toNumber(n[1]).toLocaleString('en')}`;
  } else if (studies) {
    sample = `${toNumber(studies[1]).toLocaleString('en')} ${studies[2].trim()}`;
  }

  return {
    design: design ? design.label : null,
    designRank: design ? design.rank : 99,
    sample,
    sampleSize: sample ? toNumber(sample.match(/[\d,]+/)?.[0] || 0) : 0,
    population,
    finding: keyFinding(abstract),
  };
}

/** The sentence that states the result: the last one that reads like a conclusion. */
export function keyFinding(abstract) {
  const sentences = splitSentences(abstract);
  if (!sentences.length) return null;
  const tail = sentences.slice(Math.floor(sentences.length / 3));
  const concluding = [...tail].reverse().find((s) => /^(these|our|the) (results|findings|data)|^(in )?conclusion|^overall|^taken together/i.test(s));
  if (concluding) return concluding;
  const withVerb = [...tail].reverse().find((s) => FINDING_VERBS.test(s) && !/^(we|this study) (aim|sought|examined|investigated|explored)/i.test(s));
  return withVerb || sentences[sentences.length - 1];
}

// ---------------------------------------------------------------- model synthesis

export const MAX_SYNTHESIS_PAPERS = 12;

export const SYNTHESIS_SYSTEM = `You help a researcher understand what the literature says. You are given their question and a numbered set of papers. For some papers you have the full text (methods, results, discussion); for the rest, only the abstract. Each paper is labelled with which. Work only from what you are given.

Rules:
- Every claim in your answer cites the papers it rests on with bracketed numbers, like [2] or [1, 4]. Never cite a number that was not given.
- Do not use outside knowledge, do not invent findings, sample sizes or designs. If a paper does not say, write null.
- Weigh the evidence: say when findings conflict, when evidence is thin, observational only, or from a narrow population. Stronger designs (meta-analyses, randomised trials) count for more. Prefer figures from full texts over abstracts.
- If the papers do not answer the question, say so plainly.
- Formal, plain academic English. No hype, no hedging beyond what the evidence needs.

Stance: for a question that can be answered yes or no, give each paper's stance on it: "yes", "possibly", "no", or "unclear" (the paper does not address it). For an open question ("how", "what are"), use "unclear" for every paper and set consensus to "not-applicable".

Focus: break the question down so the researcher can see exactly what is being looked for. Use the PICO roles where they fit (population, exposure or intervention, comparison, outcome); for questions that are not about an effect, fill "topic" and "context" instead and leave the others null. "evidenceNeeded" says in one sentence what kind of study would settle the question. "nextSearches" gives two or three short, specific follow-up searches (a narrower population, a key mechanism, a gap these papers leave).

Reply with one JSON object and nothing else, no markdown fences:
{
  "takeaway": "the single most important point, one sentence of at most 30 words, with [n] citations",
  "focus": {
    "question": "the question restated precisely",
    "population": "string or null", "exposure": "string or null", "comparison": "string or null", "outcome": "string or null",
    "topic": "string or null", "context": "string or null",
    "evidenceNeeded": "one sentence",
    "nextSearches": ["search 1", "search 2"]
  },
  "answer": "3 to 5 sentences answering the question, with [n] citations",
  "consensus": "yes" | "mostly-yes" | "mixed" | "mostly-no" | "no" | "not-applicable" | "insufficient",
  "papers": [
    { "n": 1, "stance": "yes" | "possibly" | "no" | "unclear", "finding": "the paper's main finding relevant to the question, at most 25 words", "design": "study design or null", "population": "who or what was studied, or null", "sample": "sample size as stated, or null", "limitation": "the main limitation the paper states, at most 15 words, or null" }
  ]
}`;

/** The user turn: the question, then the numbered papers, full text where there is one. */
export function buildSynthesisMessage(question, works) {
  const papers = works.slice(0, MAX_SYNTHESIS_PAPERS).map((w, i) => {
    const who = (w.authors || []).slice(0, 3).map((a) => a.family || a.name).join(', ') || 'Unknown';
    const head = `[${i + 1}] ${who} (${w.year || 'n.d.'}). ${w.title}${w.venue ? `. ${w.venue}` : ''}.`;
    if (w.fulltext) return `${head}\n(FULL TEXT, condensed)\n${String(w.fulltext).slice(0, 9000)}`;
    return `${head}\n(ABSTRACT ONLY)\n${String(w.abstract || '(no abstract available)').slice(0, 1800)}`;
  });
  return `Question: ${String(question).trim()}\n\nPapers:\n\n${papers.join('\n\n')}`;
}

const STANCES = ['yes', 'possibly', 'no', 'unclear'];
const CONSENSUS = ['yes', 'mostly-yes', 'mixed', 'mostly-no', 'no', 'not-applicable', 'insufficient'];
const FOCUS_ROLES = ['population', 'exposure', 'comparison', 'outcome', 'topic', 'context'];
const str = (v, max = 300) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim().slice(0, max) : null);

/** Keeps [n] markers that point at a paper that was given; drops the rest. */
function keepValidCitations(text, count) {
  return text
    .replace(/\[([\d,\s–-]+)\]/g, (m, inner) => {
      const kept = inner.split(/\s*,\s*/).filter((x) => {
        const [a, b] = x.split(/[–-]/).map(Number);
        return a >= 1 && a <= count && (!b || (b >= a && b <= count));
      });
      return kept.length ? `[${kept.join(', ')}]` : '';
    })
    .replace(/\s+([.,;])/g, '$1');
}

/**
 * Reads the model's JSON, tolerating fences or a stray sentence around it, and
 * maps paper numbers back to work ids. Citations to numbers that were not
 * given are removed rather than trusted.
 */
export function parseSynthesis(reply, works) {
  const raw = String(reply || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw Object.assign(new Error('The model did not return an answer in the expected form. Try again.'), { status: 502 });
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('The model returned a malformed answer. Try again.'), { status: 502 });
  }
  const count = Math.min(works.length, MAX_SYNTHESIS_PAPERS);
  const answer = keepValidCitations(str(data.answer, 3000) || 'No answer was returned.', count);
  const takeaway = str(data.takeaway, 400);

  const f = data.focus && typeof data.focus === 'object' ? data.focus : {};
  const focus = {
    question: str(f.question, 400),
    evidenceNeeded: str(f.evidenceNeeded, 400),
    nextSearches: (Array.isArray(f.nextSearches) ? f.nextSearches : []).map((q) => str(q, 160)).filter(Boolean).slice(0, 3),
  };
  for (const role of FOCUS_ROLES) focus[role] = str(f[role], 200);

  const papers = [];
  for (const p of Array.isArray(data.papers) ? data.papers : []) {
    const n = Number(p?.n);
    if (!Number.isInteger(n) || n < 1 || n > count || papers.some((x) => x.n === n)) continue;
    papers.push({
      n,
      id: works[n - 1].id,
      stance: STANCES.includes(p.stance) ? p.stance : 'unclear',
      finding: str(p.finding),
      design: str(p.design, 80),
      population: str(p.population, 120),
      sample: str(p.sample, 60),
      limitation: str(p.limitation, 160),
      fullText: Boolean(works[n - 1].fulltext),
    });
  }
  const meter = { yes: 0, possibly: 0, no: 0, unclear: 0 };
  papers.forEach((p) => { meter[p.stance] += 1; });
  return {
    takeaway: takeaway ? keepValidCitations(takeaway, count) : null,
    focus,
    answer,
    consensus: CONSENSUS.includes(data.consensus) ? data.consensus : 'insufficient',
    papers,
    meter,
    ids: works.slice(0, count).map((w) => w.id),
    fullTextIds: works.slice(0, count).filter((w) => w.fulltext).map((w) => w.id),
  };
}

/**
 * Without a model: the finding from the strongest study in the results, so
 * the takeaway box still says something true. Strongest means best design,
 * then most cited. Returns null when no abstract states a finding.
 */
export function strongestFinding(works) {
  let best = null;
  for (const work of works || []) {
    const study = extractStudy(work);
    if (!study.finding) continue;
    const better = !best
      || study.designRank < best.study.designRank
      || (study.designRank === best.study.designRank && (work.citedBy || 0) > (best.work.citedBy || 0));
    if (better) best = { work, study };
  }
  return best;
}

// ---------------------------------------------------------------- full text

/** The whole text, section by section, for pattern matching. */
export const plainText = (ft) => ft.sections.map((s) => s.paragraphs.map((p) => p.text).join(' ')).join('\n');

/**
 * What the model reads for a full-text paper: the parts that carry the
 * evidence, trimmed to a budget so twelve papers still fit in one request.
 */
export function digest(ft, budget = 7000) {
  const shares = { abstract: 0.1, methods: 0.25, results: 0.3, discussion: 0.15, limitations: 0.08, conclusion: 0.12 };
  const out = [];
  for (const [kind, share] of Object.entries(shares)) {
    const text = ft.sections.filter((s) => s.kind === kind).map((s) => s.paragraphs.map((p) => p.text).join(' ')).join(' ');
    if (text) out.push(`${kind.toUpperCase()}: ${text.slice(0, Math.round(budget * share))}`);
  }
  // Papers with unusual headings: fall back to the text in order.
  if (out.join('').length < budget * 0.3) return plainText(ft).slice(0, budget);
  return out.join('\n');
}

/** A CSV of the study table, for a spreadsheet or a systematic-review log. */
export function studiesCsv(rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Titles come from outside. A cell starting with = + - @ is a formula to a
    // spreadsheet, so it is defused with a leading apostrophe.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Title', 'Authors', 'Year', 'Venue', 'DOI', 'Cited by', 'Design', 'Population', 'Sample', 'Key finding', 'Stance'];
  const lines = rows.map((r) => [
    r.work.title, (r.work.authors || []).map((a) => a.name || a.family).join('; '), r.work.year, r.work.venue,
    r.work.doi, r.work.citedBy, r.design, r.population, r.sample, r.finding, r.stance || '',
  ].map(cell).join(','));
  return [head.join(','), ...lines].join('\n');
}
