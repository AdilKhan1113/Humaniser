// Full text. Finds a free PDF for a paper, reads it, and splits it into the
// sections a reader cares about, with the page each paragraph sits on so a
// quote can be cited with its page number.
//
// PDF parsing is PDF.js (pdfjs-dist), loaded on first use like the Anthropic
// SDK, so the rest of the app still starts if it is missing.
//
// Server only: fetching a URL that came from outside has to be done
// carefully, and a browser could not fetch most publishers' PDFs anyway.

import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_PAGES = 80;
const FETCH_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 5;
const CACHE_SIZE = 60;

// ---------------------------------------------------------------- PDF -> text

let pdfjsPromise = null;
async function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => {
      pdfjsPromise = null;
      throw Object.assign(new Error('The PDF reader is not installed. Run: npm install'), { status: 503 });
    });
  }
  return pdfjsPromise;
}

/** Where PDF.js keeps its font and character-map data, as a directory path. */
function assetDir(name) {
  try {
    const require = createRequire(import.meta.url);
    return `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), name)}/`;
  } catch {
    return undefined;
  }
}

// What the headings of a paper are called, and what each section is for.
const SECTION_KINDS = [
  ['abstract', /^(abstract|summary)$/],
  ['introduction', /^(introduction|background|introduction and background|rationale)$/],
  ['methods', /^(materials? and methods?|methods?( and materials?)?|methodology|study design|participants|experimental( procedures| design| section)?|data and methods?|patients and methods?)$/],
  ['results', /^(results?|findings|results and discussion)$/],
  ['discussion', /^(discussion|general discussion|interpretation)$/],
  ['limitations', /^(limitations?|strengths and limitations)$/],
  ['conclusion', /^(conclusions?|concluding remarks|summary and conclusions?|implications)$/],
  ['references', /^(references|bibliography|literature cited|works cited|reference list)$/],
  ['back', /^(acknowledge?ments?|funding|conflicts? of interest|declaration of (competing )?interests?|competing interests|author contributions|data availability( statement)?|ethics statement|supplementary (material|information)|appendix( [a-z])?|abbreviations)$/],
];

/** "2.1. Materials and Methods" -> "materials and methods", or null if it is not a heading. */
export function headingKind(line) {
  const clean = String(line).trim()
    .replace(/^((\d+(\.\d+)*)|[IVX]+)\.?\s+/i, '')
    .replace(/[:.]$/, '')
    .toLowerCase();
  if (!clean || clean.length > 60) return null;
  for (const [kind, re] of SECTION_KINDS) if (re.test(clean)) return kind;
  return null;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Turns PDF bytes into { pages, sections, words }. Sections are
 * [{ title, kind, paragraphs: [{ text, page }] }], references dropped.
 */
export async function readPdf(bytes) {
  const { getDocument } = await pdfjs();
  // Always a copy. PDF.js takes ownership of the buffer it is given and
  // detaches it, and a Node Buffer's memory is often a slice of a shared pool.
  const data = new Uint8Array(bytes);
  if (!(data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46)) { // %PDF
    throw Object.assign(new Error('That file is not a PDF.'), { status: 422 });
  }
  let doc;
  let task;
  try {
    task = getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: assetDir('standard_fonts'),
      cMapUrl: assetDir('cmaps'),
      cMapPacked: true,
      verbosity: 0,
    });
    doc = await task.promise;
  } catch (error) {
    task?.destroy();
    const locked = /password/i.test(error?.name || error?.message || '');
    throw Object.assign(new Error(locked ? 'That PDF is password-protected.' : 'That PDF could not be read.'), { status: 422 });
  }

  // 1. Lines per page, with their font size and vertical position.
  const pages = [];
  const count = Math.min(doc.numPages, MAX_PAGES);
  for (let n = 1; n <= count; n += 1) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    const lines = [];
    let current = null;
    for (const item of items) {
      if (!('str' in item)) continue;
      const y = item.transform[5];
      const size = Math.abs(item.transform[3]) || item.height || 0;
      const sameLine = current && Math.abs(current.y - y) < Math.max(2, size * 0.4);
      if (!sameLine && item.str.trim()) {
        if (current && current.text.trim()) lines.push(current);
        current = { text: '', y, size, page: n };
      }
      if (current && item.str) {
        const needsSpace = current.text && !current.text.endsWith(' ') && !item.str.startsWith(' ');
        current.text += (needsSpace && sameLine ? ' ' : '') + item.str;
        current.size = Math.max(current.size, size);
      }
      if (item.hasEOL && current && current.text.trim()) {
        lines.push(current);
        current = null;
      }
    }
    if (current && current.text.trim()) lines.push(current);
    pages.push(lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })));
    page.cleanup();
  }
  const totalPages = doc.numPages;
  await task.destroy();

  // The title is usually the largest type on the first page.
  const first = pages[0] || [];
  const biggest = Math.max(0, ...first.map((l) => l.size));
  const titleLines = [];
  for (const l of first) {
    if (l.size >= biggest - 0.5 && !headingKind(l.text)) titleLines.push(l.text);
    else if (titleLines.length) break;
  }
  const title = titleLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400) || null;

  // 2. Running headers, footers and page numbers repeat; drop them.
  const shape = (t) => t.replace(/\d+/g, '#').toLowerCase();
  const seen = new Map();
  for (const lines of pages) {
    const edge = [...lines.slice(0, 2), ...lines.slice(-2)];
    for (const s of new Set(edge.map((l) => shape(l.text)))) seen.set(s, (seen.get(s) || 0) + 1);
  }
  const repeated = new Set([...seen].filter(([, c]) => pages.length >= 3 && c >= Math.ceil(pages.length / 2)).map(([s]) => s));
  const all = pages.flatMap((lines) => lines.filter((l) => !repeated.has(shape(l.text)) && !/^(page )?\d{1,4}( of \d+)?$/i.test(l.text)));

  // 3. Headings, paragraphs and sections.
  const body = median(all.map((l) => l.size)) || 10;
  const gaps = [];
  for (let i = 1; i < all.length; i += 1) {
    if (all[i].page === all[i - 1].page) gaps.push(all[i - 1].y - all[i].y);
  }
  const lineGap = median(gaps.filter((g) => g > 0)) || body * 1.3;

  const sections = [];
  let section = { title: 'Front matter', kind: 'front', paragraphs: [] };
  let para = null;
  const closePara = () => {
    if (para && para.text.trim()) section.paragraphs.push({ text: para.text.trim(), page: para.page });
    para = null;
  };
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i];
    const prev = all[i - 1];
    const kind = headingKind(line.text);
    const looksLikeHeading = kind && (line.size >= body * 1.05 || line.text.length < 40);
    if (looksLikeHeading) {
      closePara();
      if (section.paragraphs.length || section.kind !== 'front') sections.push(section);
      section = { title: line.text.replace(/[:.]$/, ''), kind, paragraphs: [] };
      continue;
    }
    const gap = prev && prev.page === line.page ? prev.y - line.y : 0;
    const newPara = !para || line.page !== para.lastPage || gap > lineGap * 1.45 || line.size > body * 1.25;
    if (newPara) {
      closePara();
      para = { text: line.text, page: line.page, lastPage: line.page };
    } else if (/[a-z]-$/.test(para.text) && /^[a-z]/.test(line.text)) {
      para.text = para.text.slice(0, -1) + line.text; // re-join a hyphenated word
    } else {
      para.text += ` ${line.text}`;
    }
  }
  closePara();
  sections.push(section);

  // Everything from the references on is citations and paperwork.
  const cut = sections.findIndex((s) => s.kind === 'references');
  const kept = (cut >= 0 ? sections.slice(0, cut) : sections).filter((s) => s.kind !== 'back' && s.paragraphs.length);
  const words = kept.reduce((n, s) => n + s.paragraphs.reduce((m, p) => m + p.text.split(/\s+/).length, 0), 0);
  if (words < 80) {
    throw Object.assign(new Error('That PDF has almost no text in it. It may be a scan, which needs OCR first.'), { status: 422 });
  }
  return { title, pages: totalPages, pagesRead: count, sections: kept, words };
}

// ---------------------------------------------------------------- fetching

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  // IPv4 wrapped in IPv6, which URL parsing rewrites to hex: ::ffff:c0a8:101.
  const mapped = v6.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * Refuses URLs that point inside the network this server sits on. The PDF
 * address comes from an index that anyone can publish to, so without this a
 * crafted record could make the server fetch its own admin pages.
 */
export async function assertPublicUrl(raw, lookup = dns.lookup) {
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('Not a valid address.'), { status: 422 }); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Only web addresses can be fetched.'), { status: 422 });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw Object.assign(new Error(`Could not find ${host}.`), { status: 502 });
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw Object.assign(new Error('That address is on a private network.'), { status: 422 });
  }
  return url;
}

let fetchImpl = (...args) => fetch(...args);
let lookupImpl = dns.lookup;
/** Tests swap the network out. */
export function setNetwork({ fetch: f, lookup } = {}) {
  fetchImpl = f || ((...args) => fetch(...args));
  lookupImpl = lookup || dns.lookup;
}

async function readCapped(res) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_PDF_BYTES) throw Object.assign(new Error('That PDF is too large to read here.'), { status: 413 });
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_PDF_BYTES) {
      reader.cancel().catch(() => {});
      throw Object.assign(new Error('That PDF is too large to read here.'), { status: 413 });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Fetches a URL, following redirects one hop at a time so each hop is checked. */
async function fetchPublic(raw, signal) {
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const checked = await assertPublicUrl(url, lookupImpl);
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const res = await fetchImpl(checked.toString(), {
      redirect: 'manual',
      signal: signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        accept: 'application/pdf,text/html;q=0.8,*/*;q=0.5',
        'user-agent': 'Mozilla/5.0 (compatible; Humaniser-Research/1.0; open-access reader)',
      },
    }).catch((cause) => {
      throw Object.assign(new Error(cause.name === 'TimeoutError' ? 'The PDF took too long to download.' : 'Could not reach the site holding the PDF.'), { status: 502 });
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), checked).toString();
      continue;
    }
    return { res, url: checked.toString() };
  }
  throw Object.assign(new Error('Too many redirects on the way to the PDF.'), { status: 502 });
}

/** Where a free PDF might be, best guess first. */
export function pdfCandidates(work) {
  const out = [];
  const add = (u) => { if (u && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u); };
  (work.pdfUrls || []).forEach(add);
  if (work.oaUrl) add(work.oaUrl);
  const arxiv = (work.doi || '').match(/^10\.48550\/arxiv\.(.+)$/i);
  if (arxiv) add(`https://arxiv.org/pdf/${arxiv[1]}`);
  (work.landingUrls || []).forEach(add);
  return out.slice(0, 5);
}

const cache = new Map();
function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return value;
}

/**
 * Finds and reads the free full text of an open-access work. Landing pages
 * are followed to the PDF they advertise in citation_pdf_url, which is where
 * most repositories put it.
 */
export async function fetchFullText(work, signal) {
  const candidates = pdfCandidates(work);
  // Keyed by where the text came from, never by the paper id alone: the
  // answer route takes URLs from the browser, and an id-keyed cache would let
  // one visitor plant a PDF under a real paper's id for everyone else.
  const key = candidates.join('|');
  if (key && cache.has(key)) return cache.get(key);
  if (!candidates.length) {
    throw Object.assign(new Error('There is no free copy of this paper in the index. If you have access, upload the PDF.'), { status: 404 });
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      let { res, url } = await fetchPublic(candidate, signal);
      if (!res.ok) throw Object.assign(new Error(`The site holding the PDF answered ${res.status}.`), { status: 502 });
      let type = res.headers.get('content-type') || '';
      if (/html/i.test(type)) {
        const html = (await readCapped(res)).toString('utf8');
        const meta = html.match(/<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i);
        if (!meta) throw Object.assign(new Error('The free copy is a web page with no PDF link.'), { status: 422 });
        ({ res, url } = await fetchPublic(new URL(meta[1].replace(/&amp;/g, '&'), url).toString(), signal));
        if (!res.ok) throw Object.assign(new Error(`The site holding the PDF answered ${res.status}.`), { status: 502 });
        type = res.headers.get('content-type') || '';
      }
      const bytes = await readCapped(res);
      const ft = await readPdf(bytes);
      return remember(key, { ...ft, source: url, via: 'open access' });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  const err = new Error(`${lastError?.message || 'The free copy could not be read.'} If you have the PDF, upload it instead.`);
  err.status = lastError?.status && lastError.status < 500 ? lastError.status : 502;
  throw err;
}
