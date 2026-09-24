// Scholarly search. OpenAlex is the index: 250 million works, free, no key,
// with citation counts, venues, open-access links and a "related works" graph.
// Crossref fills in when a DOI is all you have.
//
// Everything is normalised into one Work shape so the rest of the app, and the
// citation formatter in particular, never sees either API's raw JSON.

import { toQuery, topicTerms, contentTerms } from './keywords.js';
import { splitSentences } from './sentences.js';

const OPENALEX = 'https://api.openalex.org';
const CROSSREF = 'https://api.crossref.org';
// The "polite pool": OpenAlex and Crossref both answer faster, and more
// reliably, when a request carries a contact address.
// This file also runs in the single-file build, where there is no process.
const ENV = typeof process !== 'undefined' && process.env ? process.env : {};
const CONTACT = ENV.SCHOLAR_EMAIL || ENV.OPENALEX_EMAIL || '';
const IN_BROWSER = typeof window !== 'undefined';
const TIMEOUT_MS = 15_000;
const PER_PAGE_MAX = 50;

// Only the fields the app uses. Cuts an OpenAlex response by about 80%.
const SELECT = [
  'id', 'doi', 'title', 'display_name', 'publication_year', 'publication_date', 'type',
  'authorships', 'primary_location', 'best_oa_location', 'open_access', 'biblio',
  'cited_by_count', 'abstract_inverted_index', 'is_retracted', 'related_works',
  'referenced_works_count', 'keywords', 'primary_topic', 'language', 'locations',
].join(',');

/** The peer-review signal OpenAlex can give: journal articles and reviews with a DOI. */
const PEER_REVIEWED = ['type:article|review', 'primary_location.source.type:journal', 'has_doi:true'];

let fetchImpl = (...args) => fetch(...args);
/** Tests swap the network out. */
export function setFetch(fn) { fetchImpl = fn || ((...args) => fetch(...args)); }

function withContact(url) {
  if (CONTACT) url.searchParams.set('mailto', CONTACT);
  return url;
}

async function getJson(url, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : (signal || timeout);
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      signal: combined,
      // A browser refuses to set user-agent, and asking for it costs a CORS
      // preflight, so only the server sends one.
      headers: IN_BROWSER
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'user-agent': `Humaniser-Research/1.0${CONTACT ? ` (mailto:${CONTACT})` : ''}` },
    });
  } catch (cause) {
    const err = new Error(cause.name === 'TimeoutError'
      ? 'The scholarly index took too long to answer. Try again in a moment.'
      : 'Could not reach the scholarly index. Check the network connection.');
    err.status = 502;
    throw err;
  }
  if (res.status === 404) {
    throw Object.assign(new Error('No record found for that paper.'), { status: 404 });
  }
  if (res.status === 429) {
    throw Object.assign(new Error('The scholarly index is rate limiting us. Wait a minute and try again.'), { status: 429 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`The scholarly index answered ${res.status}.`), { status: 502 });
  }
  return res.json();
}

/** OpenAlex stores abstracts as word -> positions, for licensing reasons. This puts them back. */
export function rebuildAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const p of positions) words[p] = word;
  }
  return words.filter((w) => w !== undefined).join(' ').replace(/\s+([,.;:!?)])(?!\d)/g, '$1').trim();
}

/** "https://openalex.org/W123" -> "W123". */
export const shortId = (id) => (typeof id === 'string' ? id.replace(/^https?:\/\/openalex\.org\//, '') : '');
/** "https://doi.org/10.1/x" -> "10.1/x", lowercased as DOIs are case-insensitive. */
export const bareDoi = (doi) => (typeof doi === 'string'
  ? doi.trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '').toLowerCase()
  : '');

/** Splits "Mary Jane van der Berg" into the parts a citation style needs. */
export function splitName(full) {
  const clean = String(full || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { family: '', given: '' };
  if (clean.includes(',')) {
    const [family, given] = clean.split(',').map((s) => s.trim());
    return { family, given: given || '' };
  }
  const parts = clean.split(' ');
  if (parts.length === 1) return { family: parts[0], given: '' };
  // Particles belong with the surname: van, von, de, da, del, di, la, le, bin.
  let i = parts.length - 1;
  while (i > 1 && /^(van|von|de|da|del|della|der|den|di|du|la|le|bin|ibn|al|dos|das|ter)$/i.test(parts[i - 1])) i -= 1;
  return { family: parts.slice(i).join(' '), given: parts.slice(0, i).join(' ') };
}

/** One OpenAlex work -> the app's Work. */
export function normaliseOpenAlex(w) {
  const source = w.primary_location?.source || null;
  const biblio = w.biblio || {};
  const doi = bareDoi(w.doi);
  const oaUrl = w.best_oa_location?.pdf_url || w.best_oa_location?.landing_page_url || w.open_access?.oa_url || null;
  // Every free copy the index knows of: publisher, repository, preprint server.
  const oaLocations = [w.best_oa_location, ...(w.locations || []).filter((l) => l?.is_oa)].filter(Boolean);
  const unique = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && /^https?:\/\//.test(x)))];
  const type = w.type || 'article';
  const venueType = source?.type || null;
  return {
    id: shortId(w.id),
    doi,
    title: (w.display_name || w.title || 'Untitled').replace(/<[^>]+>/g, ''),
    authors: (w.authorships || []).map((a) => ({
      ...splitName(a.author?.display_name),
      name: a.author?.display_name || '',
      id: shortId(a.author?.id),
    })).filter((a) => a.name),
    year: w.publication_year || null,
    date: w.publication_date || null,
    type,
    venue: source?.display_name || null,
    venueType,
    publisher: source?.host_organization_name || null,
    volume: biblio.volume || null,
    issue: biblio.issue || null,
    pages: biblio.first_page ? [biblio.first_page, biblio.last_page].filter(Boolean).join('–') : null,
    citedBy: w.cited_by_count ?? 0,
    referenceCount: w.referenced_works_count ?? 0,
    abstract: rebuildAbstract(w.abstract_inverted_index),
    openAccess: Boolean(w.open_access?.is_oa),
    oaUrl,
    pdfUrls: unique(oaLocations.map((l) => l.pdf_url)).slice(0, 4),
    landingUrls: unique(oaLocations.map((l) => l.landing_page_url)).slice(0, 3),
    url: doi ? `https://doi.org/${doi}` : (w.primary_location?.landing_page_url || w.id || null),
    retracted: Boolean(w.is_retracted),
    peerReviewed: ['article', 'review'].includes(type) && venueType === 'journal' && Boolean(doi),
    topic: w.primary_topic?.display_name || null,
    field: w.primary_topic?.field?.display_name || null,
    keywords: (w.keywords || []).map((k) => k.display_name).filter(Boolean).slice(0, 8),
    related: (w.related_works || []).map(shortId),
  };
}

/** One Crossref message -> the app's Work. Used for DOI lookups OpenAlex has not indexed yet. */
export function normaliseCrossref(m) {
  const parts = m.issued?.['date-parts']?.[0] || m.published?.['date-parts']?.[0] || [];
  const doi = bareDoi(m.DOI);
  const typeMap = { 'journal-article': 'article', 'book-chapter': 'book-chapter', 'proceedings-article': 'article', 'posted-content': 'preprint' };
  const type = typeMap[m.type] || m.type || 'article';
  return {
    id: doi ? `doi:${doi}` : '',
    doi,
    title: (Array.isArray(m.title) ? m.title[0] : m.title || 'Untitled').replace(/<[^>]+>/g, ''),
    authors: (m.author || []).map((a) => ({
      family: a.family || a.name || '',
      given: a.given || '',
      name: [a.given, a.family].filter(Boolean).join(' ') || a.name || '',
      id: '',
    })).filter((a) => a.name),
    year: parts[0] || null,
    date: parts.length ? parts.map((p) => String(p).padStart(2, '0')).join('-') : null,
    type,
    venue: (m['container-title'] || [])[0] || null,
    venueType: m.type === 'journal-article' ? 'journal' : null,
    publisher: m.publisher || null,
    volume: m.volume || null,
    issue: m.issue || null,
    pages: m.page ? m.page.replace('-', '–') : null,
    citedBy: m['is-referenced-by-count'] ?? 0,
    referenceCount: m['references-count'] ?? 0,
    abstract: (m.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/^Abstract\s*/i, '').trim(),
    openAccess: false,
    oaUrl: null,
    pdfUrls: (m.link || []).filter((l) => /pdf/i.test(l['content-type'] || '') && l['intended-application'] !== 'text-mining').map((l) => l.URL).slice(0, 2),
    landingUrls: [],
    url: doi ? `https://doi.org/${doi}` : m.URL || null,
    retracted: false,
    peerReviewed: m.type === 'journal-article',
    topic: null,
    field: null,
    keywords: (m.subject || []).slice(0, 8),
    related: [],
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Builds the OpenAlex filter string from the page's controls. */
export function buildFilter(opts = {}) {
  const filters = [];
  if (opts.peerReviewed !== false) filters.push(...PEER_REVIEWED);
  if (opts.openAccess) filters.push('is_oa:true');
  const from = clampInt(opts.fromYear, 1500, 2100, null);
  const to = clampInt(opts.toYear, 1500, 2100, null);
  if (from) filters.push(`from_publication_date:${from}-01-01`);
  if (to) filters.push(`to_publication_date:${to}-12-31`);
  const minCites = clampInt(opts.minCitations, 0, 1_000_000, 0);
  if (minCites > 0) filters.push(`cited_by_count:>${minCites - 1}`);
  if (opts.excludeRetracted !== false) filters.push('is_retracted:false');
  return filters.join(',');
}

const SORTS = {
  relevance: null,
  cited: 'cited_by_count:desc',
  newest: 'publication_date:desc',
};

/**
 * Searches the literature. `q` can be a word, a phrase, a question or a whole
 * sentence from a draft; keywords.js turns the last two into a query.
 */
export async function searchWorks(opts = {}, signal) {
  const raw = String(opts.q || '').trim();
  if (!raw) throw Object.assign(new Error('Type a word, a question or a sentence to search for.'), { status: 400 });
  if (raw.length > 2000) throw Object.assign(new Error('That is a lot to search for. Try one or two sentences.'), { status: 413 });

  // A pasted DOI is a lookup, not a search.
  const doi = bareDoi(raw);
  if (/^10\.\d{4,9}\/\S+$/.test(doi)) {
    const work = await getWork(`doi:${doi}`, signal);
    return { query: raw, interpreted: { mode: 'doi', terms: [doi], search: doi }, total: 1, page: 1, results: [work] };
  }

  const interpreted = toQuery(raw, opts.mode);
  const url = withContact(new URL(`${OPENALEX}/works`));
  url.searchParams.set('search', interpreted.search);
  const filter = buildFilter(opts);
  if (filter) url.searchParams.set('filter', filter);
  if (SORTS[opts.sort]) url.searchParams.set('sort', SORTS[opts.sort]);
  url.searchParams.set('per-page', String(clampInt(opts.perPage, 1, PER_PAGE_MAX, 20)));
  url.searchParams.set('page', String(clampInt(opts.page, 1, 50, 1)));
  url.searchParams.set('select', SELECT);

  const data = await getJson(url, signal);
  let results = (data.results || []).map(normaliseOpenAlex);

  // A sentence or claim search also says where in each abstract the match is,
  // so a researcher can see the supporting line without opening the paper.
  if (interpreted.mode !== 'keywords') {
    results = results.map((w) => ({ ...w, evidence: bestSentences(w.abstract, interpreted.terms) }));
  }
  return {
    query: raw,
    interpreted,
    total: data.meta?.count ?? results.length,
    page: data.meta?.page ?? 1,
    results,
  };
}

/** The abstract sentences that share the most terms with the query, best first. */
export function bestSentences(abstract, terms, limit = 2) {
  if (!abstract || !terms?.length) return [];
  const stems = terms.map((t) => t.toLowerCase().replace(/(ies|es|s|ing|ed)$/, ''));
  const sentences = splitSentences(abstract);
  return sentences
    .map((s) => {
      const lower = s.toLowerCase();
      const hits = stems.filter((st) => st.length > 2 && lower.includes(st));
      return { text: s.trim(), score: hits.length, matched: hits };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** One work by OpenAlex id (W…), "doi:10…", or a bare DOI. */
export async function getWork(id, signal) {
  const key = String(id || '').trim();
  if (!key) throw Object.assign(new Error('Which paper?'), { status: 400 });
  const doi = bareDoi(key.replace(/^doi:/i, ''));
  const isDoi = /^doi:/i.test(key) || /^10\.\d{4,9}\//.test(doi);
  if (!isDoi && !/^W\d+$/i.test(key)) {
    throw Object.assign(new Error('That is not an OpenAlex id or a DOI.'), { status: 400 });
  }
  const path = isDoi ? `doi:${doi}` : key.toUpperCase();
  const url = withContact(new URL(`${OPENALEX}/works/${path}`));
  url.searchParams.set('select', SELECT);
  try {
    return normaliseOpenAlex(await getJson(url, signal));
  } catch (error) {
    if (!isDoi || error.status !== 404) throw error;
    // Very recent DOIs reach Crossref first.
    const cr = withContact(new URL(`${CROSSREF}/works/${encodeURIComponent(doi)}`));
    const data = await getJson(cr, signal);
    return normaliseCrossref(data.message || {});
  }
}

/**
 * Papers connected to one work.
 *   related    - OpenAlex's own similarity graph
 *   citing     - newer papers that cite it (who built on this?)
 *   references - what it cites (where did this come from?)
 */
export async function connectedWorks(id, kind = 'related', opts = {}, signal) {
  const key = shortId(String(id || '')).toUpperCase();
  if (!/^W\d+$/.test(key)) throw Object.assign(new Error('Connections need an OpenAlex id (W…).'), { status: 400 });
  const perPage = clampInt(opts.perPage, 1, PER_PAGE_MAX, 15);
  const url = withContact(new URL(`${OPENALEX}/works`));
  const filters = [];
  if (kind === 'citing') filters.push(`cites:${key}`);
  else if (kind === 'references') filters.push(`cited_by:${key}`);
  else if (kind === 'related') filters.push(`related_to:${key}`);
  else throw Object.assign(new Error('Unknown kind of connection.'), { status: 400 });
  if (opts.peerReviewed) filters.push(...PEER_REVIEWED);
  url.searchParams.set('filter', filters.join(','));
  url.searchParams.set('sort', kind === 'citing' && opts.sort !== 'cited' ? 'publication_date:desc' : 'cited_by_count:desc');
  url.searchParams.set('per-page', String(perPage));
  url.searchParams.set('select', SELECT);
  const data = await getJson(url, signal);
  return { kind, id: key, total: data.meta?.count ?? 0, results: (data.results || []).map(normaliseOpenAlex) };
}

// ---------------------------------------------------------------- one paper in, more like it out

/** The first DOI printed in a paper's opening pages, if any. */
export function findDoi(text) {
  const m = String(text || '').slice(0, 20000).match(/\b(10\.\d{4,9}\/[^\s"<>]+)/);
  return m ? bareDoi(m[1].replace(/[.,;:)\]]+$/, '')) : null;
}

/** How alike two titles are, 0 to 1, by shared content words. */
export function titleSimilarity(a, b) {
  const set = (t) => new Set(contentTerms(String(t || '')).map((w) => w.toLowerCase()));
  const x = set(a);
  const y = set(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.max(x.size, y.size);
}

/**
 * Finds the index record for a paper someone uploaded: by the DOI printed in
 * it first, then by its title. Returns null rather than a near miss.
 */
export async function identifyPaper({ doi, titles = [] } = {}, signal) {
  if (doi) {
    try { return await getWork(`doi:${doi}`, signal); } catch { /* fall through to the title */ }
  }
  for (const title of titles.filter((t) => t && t.length > 15).slice(0, 2)) {
    try {
      const found = await searchWorks({ q: title.slice(0, 300), mode: 'keywords', peerReviewed: false, perPage: 5 }, signal);
      const best = found.results
        .map((w) => ({ w, score: titleSimilarity(title, w.title) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.75) return best.w;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Papers on the same topic as one paper: the index's own similarity graph
 * where the paper is indexed, plus a search on the phrases the paper itself
 * repeats. Merged, the paper itself removed, graph matches first.
 */
export async function similarWorks({ work = null, text = '', terms = null, peerReviewed = true, perPage = 20 } = {}, signal) {
  const basis = [work?.title, work?.abstract, (work?.keywords || []).join('. '), text].filter(Boolean).join('\n');
  const phrases = (Array.isArray(terms) && terms.length ? terms : topicTerms(basis, 6))
    .map((t) => String(t).slice(0, 80)).filter(Boolean).slice(0, 6);
  if (!phrases.length && !/^W\d+$/.test(work?.id || '')) {
    throw Object.assign(new Error('Not enough text to tell what this paper is about.'), { status: 422 });
  }
  const [graph, searched] = await Promise.all([
    /^W\d+$/.test(work?.id || '')
      ? connectedWorks(work.id, 'related', { perPage: 10, peerReviewed }, signal).catch(() => ({ results: [] }))
      : { results: [] },
    phrases.length
      ? searchWorks({ q: phrases.slice(0, 4).join(' '), mode: 'keywords', peerReviewed, perPage }, signal).catch(() => ({ results: [], total: 0 }))
      : { results: [], total: 0 },
  ]);
  const seen = new Set([work?.id, work?.doi && `doi:${work.doi}`].filter(Boolean));
  const results = [];
  for (const w of [...graph.results, ...searched.results]) {
    if (seen.has(w.id) || (work?.doi && w.doi === work.doi)) continue;
    seen.add(w.id);
    results.push(w);
  }
  return {
    query: work?.title ? `Same topic as “${work.title}”` : 'Same topic as your paper',
    interpreted: { mode: 'similar', terms: phrases, search: phrases.slice(0, 4).join(' ') },
    total: results.length,
    page: 1,
    results,
    basis: work ? { id: work.id, title: work.title } : null,
  };
}
