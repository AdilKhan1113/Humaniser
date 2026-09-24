// Sentence splitting for scientific prose, shared by the server and the page
// (served at /shared/sentences.js).
//
// Abstracts are full of full stops that do not end a sentence: "0.62",
// "et al.", "e.g.", "Fig. 2", "U.S.". A naive split on /[.!?]/ either breaks
// there or, worse, silently drops the text around it.

const ABBREVIATIONS = /\b(?:et al|e\.g|i\.e|cf|vs|approx|ca|Fig|Figs|Eq|Eqs|Ref|Refs|No|Vol|pp|Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|resp|incl|min|max|sec|ch)\.$/i;

/** @returns {string[]} */
export function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  let start = 0;
  // A boundary is terminal punctuation, optional closing quote or bracket,
  // whitespace, then something that can open a sentence.
  const boundary = /[.!?]+["”’)\]]*\s+(?=["“‘(\[]?[A-Z0-9])/g;
  let m;
  while ((m = boundary.exec(clean)) !== null) {
    const end = m.index + m[0].trimEnd().length;
    const candidate = clean.slice(start, end);
    // "et al. 2019", "Fig. 3", "e.g. Smith": not an ending.
    if (ABBREVIATIONS.test(candidate) || /\b[A-Z]\.$/.test(candidate)) continue;
    out.push(candidate.trim());
    start = m.index + m[0].length;
  }
  const rest = clean.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}
