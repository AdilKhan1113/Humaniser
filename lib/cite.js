// Citation formatting. Pure functions with no Node imports, so the browser
// loads this same file (served at /shared/cite.js) and the reference list
// updates as you type without a round trip.
//
// A Work is the shape lib/scholar.js produces: authors [{family, given, name}],
// year, title, venue, volume, issue, pages, doi, url, publisher, type.

export const STYLES = {
  apa: { label: 'APA 7th', numeric: false },
  mla: { label: 'MLA 9th', numeric: false },
  chicago: { label: 'Chicago (author-date)', numeric: false },
  harvard: { label: 'Harvard', numeric: false },
  ieee: { label: 'IEEE', numeric: true },
  vancouver: { label: 'Vancouver', numeric: true },
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const it = (s) => `<i>${esc(s)}</i>`;
/** Plain text from the HTML form, for the clipboard and for .txt exports. */
export const toPlain = (html) => unesc(String(html).replace(/<[^>]+>/g, ''));

const endStop = (s) => (/[.?!]$/.test(s) ? s : `${s}.`);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** "Mary Jane" -> "M. J.", "Jean-Paul" -> "J.-P.". */
export function initials(given, { dots = true, space = true } = {}) {
  const parts = clean(given).split(/\s+/).filter(Boolean);
  const dot = dots ? '.' : '';
  return parts.map((p) => p.split('-').map((h) => (h ? h[0].toUpperCase() + dot : '')).join('-'))
    .join(space ? ' ' : '');
}

function family(a) { return clean(a.family || a.name || ''); }
function yearOf(w, suffix = '') { return w.year ? `${w.year}${suffix}` : `n.d.${suffix ? `-${suffix}` : ''}`; }

function joinList(items, { and = 'and', serial = true } = {}) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} ${and} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}${serial ? ',' : ''} ${and} ${items[items.length - 1]}`;
}

/** "12" -> "p. 12", "12-14" -> "pp. 12–14". */
function locator(page, { prefix = true } = {}) {
  const p = clean(page).replace(/-/g, '–');
  if (!p) return '';
  if (!prefix || /^(p|pp|para|ch|sec|fig|table|§)\.?\s/i.test(p)) return p;
  return /[–,]/.test(p) ? `pp. ${p}` : `p. ${p}`;
}

/** Fills the gaps a hand-entered or half-indexed record leaves. */
function norm(w) {
  return {
    ...w,
    title: w.title || 'Untitled',
    authors: Array.isArray(w.authors) ? w.authors : [],
    pages: w.pages ? clean(w.pages).replace(/\s*-+\s*/g, '–') : w.pages,
  };
}

/** "e0123" or "zsaa101": an electronic article number, not a page. */
const isArticleNumber = (pages) => /^[a-z]+\d+$|^\d{5,}$/i.test(pages);

const doiUrl = (w) => (w.doi ? `https://doi.org/${w.doi}` : (w.url || ''));

// ---------------------------------------------------------------- authors

function apaAuthors(authors) {
  const fmt = (a) => (a.given ? `${family(a)}, ${initials(a.given)}` : family(a));
  if (authors.length === 1) return fmt(authors[0]);
  if (authors.length <= 20) return `${authors.slice(0, -1).map(fmt).join(', ')}, & ${fmt(authors[authors.length - 1])}`;
  return `${authors.slice(0, 19).map(fmt).join(', ')}, . . . ${fmt(authors[authors.length - 1])}`;
}

function harvardAuthors(authors) {
  const fmt = (a) => (a.given ? `${family(a)}, ${initials(a.given, { space: false })}` : family(a));
  if (authors.length >= 4) return `${fmt(authors[0])} et al.`;
  return joinList(authors.map(fmt), { serial: false });
}

function mlaAuthors(authors) {
  const first = (a) => (a.given ? `${family(a)}, ${clean(a.given)}` : family(a));
  const rest = (a) => clean(`${a.given || ''} ${family(a)}`);
  if (authors.length === 1) return first(authors[0]);
  if (authors.length === 2) return `${first(authors[0])}, and ${rest(authors[1])}`;
  return `${first(authors[0])}, et al.`;
}

function chicagoAuthors(authors) {
  const first = (a) => (a.given ? `${family(a)}, ${clean(a.given)}` : family(a));
  const rest = (a) => clean(`${a.given || ''} ${family(a)}`);
  const shown = authors.length > 10 ? authors.slice(0, 7) : authors;
  const names = [first(shown[0]), ...shown.slice(1).map(rest)];
  if (authors.length > 10) return `${names.join(', ')}, et al.`;
  if (names.length === 2) return `${names[0]}, and ${names[1]}`;
  return joinList(names);
}

function ieeeAuthors(authors) {
  const fmt = (a) => clean(`${initials(a.given)} ${family(a)}`);
  if (authors.length > 6) return `${fmt(authors[0])} et al.`;
  return joinList(authors.map(fmt));
}

function vancouverAuthors(authors) {
  const fmt = (a) => clean(`${family(a)} ${initials(a.given, { dots: false, space: false })}`);
  if (authors.length > 6) return `${authors.slice(0, 6).map(fmt).join(', ')}, et al`;
  return authors.map(fmt).join(', ');
}

// ---------------------------------------------------------------- references

function isJournal(w) { return Boolean(w.venue) && w.type !== 'book' && w.type !== 'book-chapter'; }

const REFERENCE = {
  apa(w, ctx) {
    const who = w.authors.length ? apaAuthors(w.authors) : null;
    const date = `(${yearOf(w, ctx.suffix)})`;
    const title = clean(w.title);
    let out = who ? `${esc(endStop(who))} ${date}. ${esc(endStop(title))}` : `${esc(endStop(title))} ${date}.`;
    if (isJournal(w)) {
      let src = it(w.venue);
      if (w.volume) src += `, ${it(w.volume)}`;
      if (w.issue) src += `(${esc(w.issue)})`;
      if (w.pages) src += `, ${isArticleNumber(w.pages) ? `Article ${esc(w.pages)}` : esc(w.pages)}`;
      out += ` ${src}.`;
    } else if (w.publisher) {
      out += ` ${esc(w.publisher)}.`;
    }
    const link = doiUrl(w);
    return link ? `${out} ${esc(link)}` : out;
  },

  mla(w) {
    const who = w.authors.length ? `${esc(endStop(mlaAuthors(w.authors)))} ` : '';
    let out = `${who}“${esc(endStop(clean(w.title)))}”`;
    const bits = [];
    if (w.venue) bits.push(it(w.venue));
    if (w.volume) bits.push(`vol. ${esc(w.volume)}`);
    if (w.issue) bits.push(`no. ${esc(w.issue)}`);
    if (w.year) bits.push(esc(w.year));
    if (w.pages) bits.push(`${/[–-]/.test(w.pages) ? 'pp.' : 'p.'} ${esc(w.pages)}`);
    if (bits.length) out += ` ${bits.join(', ')}`;
    const link = doiUrl(w);
    return `${endStop(out)}${link ? ` ${esc(link.replace(/^https?:\/\//, w.doi ? 'https://' : ''))}.` : ''}`;
  },

  chicago(w, ctx) {
    const who = w.authors.length ? `${esc(endStop(chicagoAuthors(w.authors)))} ` : '';
    let out = `${who}${yearOf(w, ctx.suffix)}. “${esc(endStop(clean(w.title)))}”`;
    if (w.venue) {
      out += ` ${it(w.venue)}`;
      if (w.volume) out += ` ${esc(w.volume)}`;
      if (w.issue) out += ` (${esc(w.issue)})`;
      if (w.pages) out += `: ${esc(w.pages)}`;
    }
    out = endStop(out);
    const link = doiUrl(w);
    return link ? `${out} ${esc(link)}.` : out;
  },

  harvard(w, ctx) {
    const who = w.authors.length ? esc(harvardAuthors(w.authors)) : esc(clean(w.title));
    let out = `${who} (${yearOf(w, ctx.suffix)})`;
    if (w.authors.length) out += ` ‘${esc(clean(w.title))}’`;
    if (w.venue) {
      out += `, ${it(w.venue)}`;
      if (w.volume) out += `, ${esc(w.volume)}${w.issue ? `(${esc(w.issue)})` : ''}`;
      if (w.pages) out += `, ${/[–-]/.test(w.pages) ? 'pp.' : 'p.'} ${esc(w.pages)}`;
    }
    out = endStop(out);
    const link = doiUrl(w);
    return link ? `${out} ${w.doi ? `doi:${esc(w.doi)}` : `Available at: ${esc(link)}`}.` : out;
  },

  ieee(w, ctx) {
    const who = w.authors.length ? `${esc(ieeeAuthors(w.authors))}, ` : '';
    let out = `[${ctx.number}] ${who}“${esc(clean(w.title))},”`;
    const bits = [];
    if (w.venue) bits.push(it(w.venue));
    if (w.volume) bits.push(`vol. ${esc(w.volume)}`);
    if (w.issue) bits.push(`no. ${esc(w.issue)}`);
    if (w.pages) bits.push(isArticleNumber(w.pages) ? `Art. no. ${esc(w.pages)}` : `${/[–-]/.test(w.pages) ? 'pp.' : 'p.'} ${esc(w.pages)}`);
    bits.push(w.year ? esc(w.year) : 'n.d.');
    out += ` ${bits.join(', ')}`;
    return w.doi ? `${out}, doi: ${esc(w.doi)}.` : `${endStop(out)}${w.url ? ` [Online]. Available: ${esc(w.url)}` : ''}`;
  },

  vancouver(w, ctx) {
    const who = w.authors.length ? `${esc(vancouverAuthors(w.authors))}. ` : '';
    let out = `${ctx.number}. ${who}${esc(endStop(clean(w.title)))}`;
    if (w.venue) {
      out += ` ${esc(w.venue)}. ${w.year || ''}`;
      if (w.volume) out += `;${esc(w.volume)}`;
      if (w.issue) out += `(${esc(w.issue)})`;
      if (w.pages) out += `:${esc(w.pages)}`;
      out = endStop(out);
    } else if (w.year) {
      out += ` ${w.year}.`;
    }
    return w.doi ? `${out} doi:${esc(w.doi)}` : out;
  },
};

// ---------------------------------------------------------------- ordering

function sortKey(w) {
  const lead = w.authors[0] ? family(w.authors[0]) : clean(w.title).replace(/^(the|a|an)\s+/i, '');
  return `${lead.toLowerCase()}\u0000${w.authors.map(family).join(' ').toLowerCase()}\u0000${w.year || 0}\u0000${clean(w.title).toLowerCase()}`;
}

/** Short key two works share when an author-date citation cannot tell them apart. */
function clashKey(w, style) {
  const names = w.authors.length >= (style === 'apa' ? 3 : 4)
    ? `${family(w.authors[0])} et al`
    : w.authors.map(family).join('|');
  return `${(names || clean(w.title)).toLowerCase()}#${w.year || 'nd'}`;
}

/**
 * Orders works the way the style wants and gives each its label.
 * Author-date styles sort alphabetically and add 2020a/2020b where needed;
 * numeric styles keep the order given, which should be order of first citation.
 * @returns {Array<{work, number:number, suffix:string}>}
 */
export function arrange(works, style = 'apa') {
  const list = (works || []).filter(Boolean).map((w) => (Array.isArray(w.authors) ? w : norm(w)));
  if (STYLES[style]?.numeric) return list.map((work, i) => ({ work, number: i + 1, suffix: '' }));
  const sorted = [...list].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const groups = new Map();
  for (const w of sorted) {
    const k = clashKey(w, style);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  return sorted.map((work, i) => {
    const group = groups.get(clashKey(work, style));
    const suffix = style !== 'mla' && group.length > 1 ? String.fromCharCode(97 + group.indexOf(work)) : '';
    return { work, number: i + 1, suffix };
  });
}

/** One reference-list entry. Returns both forms: html (italics) and text. */
export function reference(work, style = 'apa', ctx = {}) {
  const fn = REFERENCE[style] || REFERENCE.apa;
  const html = fn(norm(work), { number: ctx.number || 1, suffix: ctx.suffix || '' });
  return { html, text: toPlain(html) };
}

/** A whole reference list, ordered and labelled for the style. */
export function referenceList(works, style = 'apa') {
  return arrange(works, style).map((entry) => ({ id: entry.work.id, ...reference(entry.work, style, entry) }));
}

// ---------------------------------------------------------------- in-text

function authorDateNames(authors, style, title) {
  if (!authors.length) return `“${clean(title).split(/\s+/).slice(0, 4).join(' ')}”`;
  const and = style === 'apa' ? '&' : 'and';
  if (authors.length === 1) return family(authors[0]);
  if (authors.length === 2) return `${family(authors[0])} ${and} ${family(authors[1])}`;
  if (authors.length === 3 && (style === 'chicago' || style === 'harvard')) {
    return joinList(authors.map(family), { and, serial: style === 'chicago' });
  }
  return `${family(authors[0])} et al.`;
}

/**
 * An in-text citation for one or more works.
 *
 * @param {Array<object>|object} works
 * @param {string} style
 * @param {object} [opts]
 * @param {boolean} [opts.narrative]  "Smith (2020) found…" rather than "(Smith, 2020)"
 * @param {string}  [opts.page]       a page or range, e.g. "12" or "12-14"
 * @param {Array}   [opts.library]    every work in the reference list, so numbers
 *                                    and 2020a/b suffixes match the list
 */
export function inText(works, style = 'apa', opts = {}) {
  const list = (Array.isArray(works) ? works : [works]).filter(Boolean).map((w) => (Array.isArray(w.authors) ? w : norm(w)));
  if (!list.length) return '';
  const arranged = arrange(opts.library?.length ? opts.library : list, style);
  const labelFor = (w) => arranged.find((e) => e.work === w || (e.work.id && e.work.id === w.id)) || { number: 1, suffix: '' };
  const page = opts.page ? clean(opts.page) : '';

  if (STYLES[style]?.numeric) {
    const nums = list.map((w) => labelFor(w).number).sort((a, b) => a - b);
    const loc = page && list.length === 1 ? `, ${locator(page)}` : '';
    if (style === 'vancouver') return `(${runs(nums).map(([a, b]) => (a === b ? a : b === a + 1 ? `${a},${b}` : `${a}–${b}`)).join(',')}${loc})`;
    return runs(nums).map(([a, b]) => (a === b ? `[${a}${loc}]` : b === a + 1 ? `[${a}], [${b}]` : `[${a}]–[${b}]`)).join(', ');
  }

  const one = (w, withPage) => {
    const names = authorDateNames(w.authors, style, w.title);
    const { suffix } = labelFor(w);
    if (style === 'mla') {
      const loc = withPage && page ? ` ${locator(page, { prefix: false })}` : '';
      return { names, rest: loc.trim(), paren: `${names}${loc}` };
    }
    const year = yearOf(w, suffix);
    const sep = style === 'chicago' ? ' ' : ', ';
    const locSep = style === 'chicago' ? ', ' : ', ';
    const loc = withPage && page ? `${locSep}${style === 'chicago' ? locator(page, { prefix: false }) : locator(page)}` : '';
    return { names, rest: `${year}${loc}`, paren: `${names}${sep}${year}${loc}` };
  };

  const withPage = list.length === 1;
  if (opts.narrative) {
    return joinList(list.map((w) => {
      const c = one(w, withPage);
      return c.rest ? `${c.names} (${c.rest})` : c.names;
    }), { and: 'and' });
  }
  const ordered = style === 'mla' ? list : arrange(list, style).map((e) => e.work);
  return `(${ordered.map((w) => one(w, withPage).paren).join('; ')})`;
}

/** [1, 2, 3, 5] -> [[1, 3], [5, 5]]. */
function runs(nums) {
  const out = [];
  for (const n of [...new Set(nums)]) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

// ---------------------------------------------------------------- exports

function citeKey(w) {
  const lead = (w.authors[0] ? family(w.authors[0]) : clean(w.title).split(/\s+/)[0] || 'anon')
    .normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const word = (clean(w.title).toLowerCase().match(/[a-z]{4,}/g) || ['work'])
    .find((x) => !['with', 'from', 'that', 'this', 'their', 'into', 'what', 'when'].includes(x)) || 'work';
  return `${lead || 'anon'}${w.year || 'nd'}${word}`;
}

const bib = (s) => String(s).replace(/([{}])/g, '\\$1').replace(/&/g, '\\&').replace(/%/g, '\\%');

/** BibTeX for Zotero, Mendeley, EndNote, Overleaf. */
export function bibtex(works) {
  const used = new Map();
  return (works || []).map(norm).map((w) => {
    let key = citeKey(w);
    const n = used.get(key) || 0;
    used.set(key, n + 1);
    if (n) key += String.fromCharCode(97 + n);
    const kind = isJournal(w) ? 'article' : w.type === 'book' ? 'book' : 'misc';
    const fields = [
      ['author', w.authors.map((a) => (a.given ? `${family(a)}, ${clean(a.given)}` : `{${family(a)}}`)).join(' and ')],
      ['title', `{${clean(w.title)}}`],
      [kind === 'article' ? 'journal' : 'publisher', w.venue || w.publisher],
      ['year', w.year],
      ['volume', w.volume],
      ['number', w.issue],
      ['pages', w.pages && w.pages.replace('–', '--')],
      ['doi', w.doi],
      ['url', w.doi ? '' : w.url],
    ].filter(([, v]) => v);
    return `@${kind}{${key},\n${fields.map(([k, v]) => `  ${k} = {${k === 'title' ? v : bib(v)}}`).join(',\n')}\n}`;
  }).join('\n\n');
}

/** RIS, which every reference manager imports. */
export function ris(works) {
  return (works || []).map(norm).map((w) => {
    const lines = [['TY', isJournal(w) ? 'JOUR' : 'GEN']];
    for (const a of w.authors) lines.push(['AU', a.given ? `${family(a)}, ${clean(a.given)}` : family(a)]);
    lines.push(['TI', clean(w.title)]);
    if (w.venue) lines.push(['T2', w.venue]);
    if (w.year) lines.push(['PY', String(w.year)]);
    if (w.volume) lines.push(['VL', w.volume]);
    if (w.issue) lines.push(['IS', w.issue]);
    if (w.pages) {
      const [sp, ep] = w.pages.split('–');
      lines.push(['SP', sp]);
      if (ep) lines.push(['EP', ep]);
    }
    if (w.doi) lines.push(['DO', w.doi]);
    if (w.url) lines.push(['UR', w.url]);
    if (w.abstract) lines.push(['AB', w.abstract]);
    lines.push(['ER', '']);
    return lines.map(([k, v]) => `${k}  - ${v}`.trimEnd()).join('\n');
  }).join('\n\n');
}
