// How close a paraphrase sits to its source. Pure, so the browser loads it too
// (served at /shared/overlap.js) and re-checks as the researcher edits.
//
// Two measures, because each misses what the other catches:
//   - the longest run of words copied verbatim, which is what a marker spots
//   - the share of the source's three-word sequences that survived, which is
//     what similarity checkers such as Turnitin count
// Neither is a plagiarism verdict. They say whether the wording is still the
// author's, so the researcher knows to rework it or to quote it instead.

const words = (text) => String(text || '').toLowerCase()
  .replace(/[’']/g, "'")
  .split(/[^\p{L}\p{N}'%.-]+/u)
  .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ''))
  .filter(Boolean);

// Runs made only of these do not count as copying: every English sentence
// shares "of the" with every other.
const GLUE = new Set('a an the of in on at to for and or but by with from as is are was were be been that this these those it its their there which who than into'.split(' '));

function grams(list, n) {
  const out = new Set();
  for (let i = 0; i + n <= list.length; i += 1) out.add(list.slice(i, i + n).join(' '));
  return out;
}

/** The longest stretch of consecutive words the two texts share. */
export function longestSharedRun(source, draft) {
  const a = words(source);
  const b = words(draft);
  let best = { length: 0, text: '' };
  // Plain dynamic programming. Sentences are short, so O(n·m) is nothing.
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev[j - 1] + 1;
        if (row[j] > best.length) {
          const run = a.slice(i - row[j], i);
          // Only a run with real content counts.
          if (run.some((w) => !GLUE.has(w))) best = { length: row[j], text: run.join(' ') };
        }
      }
    }
    prev = row;
  }
  return best;
}

/**
 * @returns {{score:number, sharedTrigrams:number, longestRun:{length:number,text:string},
 *   verdict:'fresh'|'close'|'too-close', advice:string}}
 *   score is 0-100: the share of the source's trigrams still present.
 */
export function overlap(source, draft) {
  const a = words(source);
  const b = words(draft);
  const run = longestSharedRun(source, draft);
  if (!a.length || !b.length) {
    return { score: 0, sharedTrigrams: 0, longestRun: run, verdict: 'fresh', advice: '' };
  }
  const src = grams(a, 3);
  const dst = grams(b, 3);
  let shared = 0;
  for (const g of src) if (dst.has(g)) shared += 1;
  const score = src.size ? Math.round((shared / src.size) * 100) : 0;

  let verdict = 'fresh';
  let advice = 'Different enough in wording and structure to count as your own paraphrase. Keep the citation.';
  if (run.length >= 7 || score >= 45) {
    verdict = 'too-close';
    advice = `Still reads as the source's wording${run.length >= 5 ? ` (“${run.text}”)` : ''}. Rework it further, or quote it with a page number.`;
  } else if (run.length >= 5 || score >= 25) {
    verdict = 'close';
    advice = `Close to the original${run.length >= 4 ? `: “${run.text}” is copied word for word` : ''}. Change the structure, not just the words.`;
  }
  return { score, sharedTrigrams: shared, longestRun: run, verdict, advice };
}
