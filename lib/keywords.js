// Turns whatever the researcher typed into a search the index can use.
//
// A single word or a short phrase goes through untouched. A question or a
// sentence lifted from a draft is mostly glue ("what is the effect of … on …"),
// and full-text search ranks glue badly, so the content words are pulled out
// and quoted phrases are kept whole.

const STOP = new Set(`
a about above after again against all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each either else etc even ever
every few for from further had has have having he her here hers herself him himself his how however
i if in into is it its itself just let may me might more most much must my myself nor not now of off
often on once only or other our ours ourselves out over own per quite rather really same she should
since so some such than that the their theirs them themselves then there these they this those
though through thus to too under until up upon us very via was we were what whatever when where
whereas whether which while who whom whose why will with within without would yet you your yours
yourself yourselves
according affect affects affected effect effects impact impacts role relationship relation
research study studies studied paper papers article articles literature evidence evident show shows
showed shown find finds found findings result results suggest suggests suggested indicate indicates
indicated demonstrate demonstrates demonstrated examine examines examined investigate investigates
investigated explore explores explored know known understand use used using based regarding toward
towards among amongst whilst therefore hence moreover furthermore additionally overall significant
significantly important importantly particularly especially generally recent recently new current
currently many several various different certain like likely unlikely one two three first second
`.split(/\s+/).filter(Boolean));

// Kept even though they look like glue: they carry the direction of a claim.
const KEEP = new Set(['increase', 'decrease', 'reduce', 'improve', 'risk', 'associated', 'cause', 'causes', 'outcome', 'outcomes']);

const QUESTION_START = /^(what|how|why|when|where|who|which|does|do|is|are|can|could|should|would|will|has|have|did)\b/i;

/** Guesses what kind of input this is, unless the page said. */
export function detectMode(text) {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (t.endsWith('?') || QUESTION_START.test(t)) return 'question';
  if (words.length >= 7 || /[.;:]\s*$/.test(t)) return 'sentence';
  return 'keywords';
}

/** Content words, in the order they appeared, with duplicates and glue removed. */
export function contentTerms(text) {
  const seen = new Set();
  const terms = [];
  const cleaned = text
    .replace(/"[^"]+"/g, ' ')
    .replace(/\([^)]*\d{4}[^)]*\)/g, ' ') // drop "(Smith, 2020)" style citations
    .replace(/\[[\d,\s–-]+\]/g, ' '); // and "[3, 4]"
  for (const raw of cleaned.split(/[^\p{L}\p{N}'-]+/u)) {
    const word = raw.replace(/^['-]+|['-]+$/g, '');
    const lower = word.toLowerCase();
    if (!word || (lower.length < 3 && !/^[A-Z0-9]{2,}$/.test(word))) continue;
    if (STOP.has(lower) && !KEEP.has(lower)) continue;
    if (/^\d+$/.test(word) && word.length !== 4) continue; // years stay, other numbers go
    if (seen.has(lower)) continue;
    seen.add(lower);
    terms.push(word);
  }
  return terms;
}

/**
 * @param {string} text   what was typed
 * @param {string} [mode] 'keywords' | 'question' | 'sentence' | 'auto'
 * @returns {{mode:string, terms:string[], phrases:string[], search:string}}
 */
export function toQuery(text, mode = 'auto') {
  const raw = String(text || '').trim();
  const chosen = ['keywords', 'question', 'sentence'].includes(mode) ? mode : detectMode(raw);
  const phrases = [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);

  if (chosen === 'keywords') {
    return { mode: chosen, terms: contentTerms(raw), phrases, search: raw.replace(/\s+/g, ' ') };
  }

  // Long sentences dilute ranking; the first eight content words carry the claim.
  const terms = contentTerms(raw).slice(0, 8);
  const search = [...phrases.map((p) => `"${p}"`), ...terms].join(' ') || raw;
  return { mode: chosen, terms: [...phrases, ...terms], phrases, search };
}

// Words that fill a paper without saying what it is about.
const PAPER_GLUE = new Set(`
participants participant sample samples data analysis analyses method methods approach approaches model models
table tables figure figures fig fig. et al group groups level levels total mean means score scores measure measures
measured measurement test tests tested condition conditions time times year years day days week weeks month months
number numbers rate rates percent per cent case cases present previous prior following follow high higher low lower
large larger small smaller greater less significant difference differences compared comparison control controls
also however within across without although whether thus therefore author authors journal copyright license
university department doi http https www org com pp vol respectively table total including include includes included
effect effects associated association value values range ratio ci p n sd se df
`.split(/\s+/).filter(Boolean));

const isContent = (w) => w.length > 2 && !STOP.has(w) && !PAPER_GLUE.has(w) && !/^\d/.test(w);

/**
 * What a paper is about, from its own words: the phrases it repeats most.
 * Two-word phrases score above single words, because "working memory" says
 * more than "memory". Offline, no model.
 * @returns {string[]} up to `limit` phrases, most characteristic first
 */
export function topicTerms(text, limit = 6) {
  const words = String(text || '').toLowerCase()
    .replace(/[“”"()[\]{}]/g, ' ')
    .split(/[^\p{L}\p{N}-]+/u)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  const singles = new Map();
  const pairs = new Map();
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (!isContent(w)) continue;
    singles.set(w, (singles.get(w) || 0) + 1);
    const next = words[i + 1];
    if (next && isContent(next)) pairs.set(`${w} ${next}`, (pairs.get(`${w} ${next}`) || 0) + 1);
  }
  const scored = [
    ...[...pairs].filter(([, c]) => c >= 2).map(([t, c]) => [t, c * 2.2]),
    ...[...singles].filter(([, c]) => c >= 2).map(([t, c]) => [t, c]),
  ].sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [term] of scored) {
    // A single word already inside a chosen phrase adds nothing.
    if (out.some((t) => t.split(' ').includes(term) || term.split(' ').every((p) => t.includes(p)))) continue;
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}
