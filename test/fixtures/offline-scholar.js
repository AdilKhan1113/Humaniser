// Preload for running the server with no network: node --import ./test/fixtures/offline-scholar.js server.js
// Answers OpenAlex requests from fixtures and passes everything else through.
import { WORKS, byId } from './openalex.js';

const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== 'api.openalex.org' && url.hostname !== 'api.crossref.org') return realFetch(input, init);
  if (url.hostname === 'api.crossref.org') return json({}, 404);
  const one = url.pathname.match(/^\/works\/(W\d+|doi:.+)$/);
  if (one) {
    const key = decodeURIComponent(one[1]);
    const work = key.startsWith('doi:')
      ? WORKS.find((w) => w.doi.toLowerCase().endsWith(key.slice(4).toLowerCase()))
      : byId(key);
    return work ? json(work) : json({ error: 'not found' }, 404);
  }
  const filter = url.searchParams.get('filter') || '';
  let results = WORKS;
  const rel = filter.match(/related_to:(W\d+)/);
  if (rel) results = WORKS.filter((w) => byId(rel[1])?.related_works.includes(w.id));
  if (/cites:|cited_by:/.test(filter)) results = WORKS.slice(1, 3);
  return json({ meta: { count: results.length, page: Number(url.searchParams.get('page') || 1) }, results });
};
