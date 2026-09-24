// The research workspace. No framework and no build step, like the rewriter.
//
// Papers come from the server (/api/research/*), which fronts OpenAlex and
// Crossref. Projects live in this browser's localStorage. Citation formatting
// and the overlap check are the same modules the server uses, loaded as-is.

import { STYLES, inText, reference, referenceList, bibtex, ris, toPlain } from '/shared/cite.js';
import { overlap } from '/shared/overlap.js';
import { splitSentences } from '/shared/sentences.js';
import {
  extractStudy, keyFinding, strongestFinding, studiesCsv, digest, paperText, MAX_SYNTHESIS_PAPERS,
} from '/shared/insights.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const uid = () => Math.random().toString(36).slice(2, 10);
const nf = new Intl.NumberFormat();

// ---------------------------------------------------------------- storage

const STORE_KEY = 'humaniser.research.v1';
const INBOX = 'inbox';

function blankProject(name = 'My research') {
  return {
    id: uid(),
    name,
    created: Date.now(),
    sources: {}, // workId -> { work, tags: [], addedAt }
    sourceOrder: [], // order of first save, which numeric styles use
    findings: {}, // id -> { id, kind, text, sourceId, page, placement, created }
    themes: [{ id: INBOX, name: 'Unsorted', items: [] }],
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.projects && Object.keys(data.projects).length) return data;
    }
  } catch { /* private window or blocked storage: run in memory */ }
  const first = blankProject();
  return { version: 1, currentId: first.id, style: 'apa', projects: { [first.id]: first } };
}

const store = loadStore();
let storageWarned = false;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    if (!storageWarned) {
      storageWarned = true;
      toast('This browser is not keeping your project. Back it up from the project menu.');
    }
  }
}

const project = () => store.projects[store.currentId] || Object.values(store.projects)[0];
const style = () => (STYLES[store.style] ? store.style : 'apa');
const savedWorks = () => project().sourceOrder.map((id) => project().sources[id]?.work).filter(Boolean);

// ---------------------------------------------------------------- server

let status = { model: { keyInEnv: false, accessCodeRequired: false } };

// The single-file build has no server. It injects this bridge, which calls
// OpenAlex straight from the page and runs the offline engines in place.
const bridge = typeof window !== 'undefined' ? window.HUMANISER_OFFLINE?.research || null : null;

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new Error('Could not reach the server. Is it still running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

/** Every call Research makes, one shape for both builds. */
const backend = {
  search: (params) => (bridge ? bridge.search(params) : api(`/api/research/search?${new URLSearchParams(params)}`)),
  connected: (id, kind) => (bridge
    ? bridge.connected(id, kind, { perPage: 10 })
    : api(`/api/research/connected?${new URLSearchParams({ id, kind, perPage: '10' })}`)),
  work: (id) => (bridge ? bridge.work(id).then((work) => ({ work })) : api(`/api/research/work?${new URLSearchParams({ id })}`)),
  paraphrase: (text) => (bridge ? Promise.resolve(bridge.paraphrase(text)) : api('/api/research/paraphrase', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, engine: 'offline' }),
  })),
  // The rewriter's engine under academic rules: no contractions, no "you", no "we".
  polish: (text) => (bridge ? Promise.resolve({ text: bridge.polish(text) }) : api('/api/humanise', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, strength: 'light', constraints: ACADEMIC }),
  }).then((r) => ({ text: r.text }))),
  synthesize: (question, works, readFullText) => api('/api/research/synthesize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': accessCode() },
    body: JSON.stringify({ question, works, readFullText }),
  }),
  fulltext: (id) => api(`/api/research/fulltext?${new URLSearchParams({ id })}`),
  upload: (file, identify = false) => api(`/api/research/fulltext/upload${identify ? '?identify=1' : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: file,
  }),
  similar: (body) => (bridge ? bridge.similar(body) : api('/api/research/similar', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })),
  scan: (title, text) => api('/api/research/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': accessCode() },
    body: JSON.stringify({ title, text }),
  }),
};

/** POSTs and reads a server-sent event stream, handing each text delta to onDelta. */
async function streamPost(path, body, onDelta) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': accessCode() },
    body: JSON.stringify(body),
  }).catch(() => { throw new Error('Could not reach the server. Is it still running?'); });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `The server answered ${res.status}.`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, cut).replace(/^data: /, '');
      buffer = buffer.slice(cut + 2);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'delta') onDelta(event.text);
      if (event.type === 'done') return;
    }
  }
}

// Full texts read this session, by work id. Kept in memory only: a paper's
// whole text is too big for browser storage, and cheap to fetch again.
const fullTexts = new Map();

const ACADEMIC = { noContractions: true, noFirstPerson: true, noSecondPerson: true, formalRegister: true };

/** The model's access code, entered once in whichever dialog asked for it. */
function accessCode() {
  try { return sessionStorage.getItem('humaniser.code') || $('para-code').value || ''; } catch { return $('para-code').value || ''; }
}
async function ensureAccessCode() {
  if (!status.model.accessCodeRequired || accessCode()) return true;
  const code = await ask({ title: 'Access code', sub: 'Whoever runs this server set one for the AI features.', okLabel: 'Continue' });
  if (!code) return false;
  $('para-code').value = code;
  try { sessionStorage.setItem('humaniser.code', code); } catch { /* fine */ }
  return true;
}

// ---------------------------------------------------------------- small UI helpers

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    // Clipboard needs a secure context; fall back to a selection.
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    toast(ok ? what : 'Could not reach the clipboard. Select the text and copy it.');
  }
}

function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A small modal prompt. Resolves to the value, or null on cancel. */
function ask({ title, sub = '', value = '', options = null, okLabel = 'OK' }) {
  const dlg = $('ask-dialog');
  $('ask-h').textContent = title;
  $('ask-sub').textContent = sub;
  $('ask-sub').hidden = !sub;
  $('ask-ok').textContent = okLabel;
  const input = $('ask-input');
  const select = $('ask-select');
  input.hidden = Boolean(options);
  select.hidden = !options;
  if (options) {
    select.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    select.value = value || options[0]?.value;
  } else {
    input.value = value;
  }
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve(options ? select.value : input.value.trim());
    }, { once: true });
    dlg.showModal();
    (options ? select : input).focus();
  });
}
$('ask-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('ask-dialog').close('ok'); }
});

const authorsShort = (w) => {
  const names = (w.authors || []).map((a) => a.family || a.name);
  if (!names.length) return 'Unknown author';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
};

function highlight(text, terms = []) {
  let html = esc(text);
  const stems = [...new Set(terms.map((t) => t.toLowerCase().replace(/(ies|es|s|ing|ed)$/, '')).filter((t) => t.length > 2))];
  if (!stems.length) return html;
  const re = new RegExp(`\\b(${stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[\\p{L}-]*`, 'giu');
  html = html.replace(re, (m) => `<mark>${m}</mark>`);
  return html;
}

// ---------------------------------------------------------------- citing helpers

function citeFor(work, { page = '', narrative = false } = {}) {
  return inText(work, style(), { page, narrative, library: savedWorksIncluding(work) });
}

/** The reference list with this work in it, so numbers and 2020a/b labels line up. */
function savedWorksIncluding(work) {
  const list = savedWorks();
  return list.some((w) => w.id === work.id) ? list : [...list, work];
}

/** Puts an in-text citation into a sentence the way the chosen placement asks. */
function attachCitation(text, work, { page = '', placement = 'end' } = {}) {
  const body = String(text || '').trim();
  if (!body) return '';
  if (placement === 'narrative') {
    const numeric = STYLES[style()].numeric;
    const lead = numeric
      ? `${narrativeNames(work)} ${citeFor(work, { page })}`
      : citeFor(work, { page, narrative: true });
    return `According to ${lead}, ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  }
  const cite = citeFor(work, { page });
  const m = body.match(/^(.*?)([.!?]["”’]?)?$/s);
  return `${m[1]} ${cite}${m[2] || '.'}`;
}

function narrativeNames(work) {
  const a = work.authors || [];
  if (!a.length) return 'the authors';
  if (a.length === 1) return a[0].family;
  if (a.length === 2) return `${a[0].family} and ${a[1].family}`;
  return `${a[0].family} et al.`;
}

function quoteWithCitation(text, work, page) {
  const body = String(text || '').trim().replace(/^["“]|["”]$/g, '').replace(/[.]$/, '');
  return `“${body}” ${citeFor(work, { page })}.`;
}

// ---------------------------------------------------------------- saving sources

function isSaved(id) { return Boolean(project().sources[id]); }

function saveWork(work) {
  const p = project();
  if (!p.sources[work.id]) {
    p.sources[work.id] = { work, tags: [], addedAt: Date.now() };
    p.sourceOrder.push(work.id);
    save();
    toast('Saved to sources');
  }
  refreshWorkspace();
  syncSavedButtons();
}

function unsaveWork(id) {
  const p = project();
  const used = Object.values(p.findings).filter((f) => f.sourceId === id).length;
  if (used && !window.confirm(`${used} finding${used === 1 ? '' : 's'} cite this paper. Remove it anyway? The findings stay, without a citation.`)) return;
  delete p.sources[id];
  p.sourceOrder = p.sourceOrder.filter((x) => x !== id);
  save();
  refreshWorkspace();
  syncSavedButtons();
}

function addFinding({ kind, text, sourceId = null, page = '', placement = 'end', themeId = INBOX }) {
  const p = project();
  const id = uid();
  p.findings[id] = { id, kind, text, sourceId, page, placement, created: Date.now() };
  const theme = p.themes.find((t) => t.id === themeId) || p.themes[0];
  theme.items.push(id);
  save();
  refreshWorkspace();
  toast(`Saved to ${theme.name}`);
  return id;
}

/** Saving a finding from a paper also saves the paper, or the citation has nothing to point at. */
function ensureSaved(work) {
  if (!isSaved(work.id)) {
    const p = project();
    p.sources[work.id] = { work, tags: [], addedAt: Date.now() };
    p.sourceOrder.push(work.id);
  }
}

async function pickTheme() {
  const themes = project().themes;
  if (themes.length === 1) return themes[0].id;
  return ask({
    title: 'Which theme?',
    options: themes.map((t) => ({ value: t.id, label: t.name })),
    okLabel: 'Save',
  });
}

// ---------------------------------------------------------------- search

const ui = {
  form: $('search-form'),
  q: $('q'),
  results: $('results'),
  head: $('result-head'),
  title: $('result-title'),
  interpreted: $('interpreted'),
  pager: $('pager'),
  more: $('more-btn'),
  back: $('back-btn'),
};

// Cards live in the results and in the paper view, so the card listeners sit
// on the column that holds both.
const discover = document.querySelector('.discover');

let lastSearch = null; // { params, page, total, results }
const workCache = new Map();

function searchParams() {
  const mode = new FormData(ui.form).get('mode') || 'auto';
  return {
    q: ui.q.value.trim(),
    mode,
    sort: $('f-sort').value,
    peerReviewed: $('f-peer').checked ? '1' : '0',
    openAccess: $('f-oa').checked ? '1' : '0',
    fromYear: $('f-from').value,
    toYear: $('f-to').value,
    minCitations: $('f-cites').value,
  };
}

function updateFilterSummary() {
  const bits = [];
  bits.push($('f-peer').checked ? 'peer-reviewed' : 'all types');
  if ($('f-oa').checked) bits.push('free to read');
  if ($('f-from').value || $('f-to').value) bits.push(`${$('f-from').value || '…'}–${$('f-to').value || 'now'}`);
  if (Number($('f-cites').value) > 0) bits.push(`≥${$('f-cites').value} citations`);
  if ($('f-sort').value !== 'relevance') bits.push($('f-sort').selectedOptions[0].textContent.toLowerCase());
  $('filter-summary').textContent = `· ${bits.join(', ')}`;
}

async function runSearch({ page = 1, params = searchParams() } = {}) {
  if (!params.q) { ui.q.focus(); return; }
  const append = page > 1;
  if (!append) {
    if (!params.similar) closePaperView();
    synthesis = null;
    $('answer-note').hidden = true;
    ui.results.hidden = false;
    $('table-view').hidden = true;
    ui.results.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    ui.head.hidden = true;
    ui.pager.hidden = true;
  } else {
    ui.more.disabled = true;
    ui.more.textContent = 'Loading…';
  }
  $('search-btn').disabled = true;
  try {
    const data = await backend.search({ ...params, page: String(page) });
    data.results.forEach((w) => workCache.set(w.id, w));
    lastSearch = {
      params,
      page: data.page,
      total: data.total,
      results: append ? [...lastSearch.results, ...data.results] : data.results,
      interpreted: data.interpreted,
      query: data.query,
    };
    showSearch(append ? data.results : null);
  } catch (error) {
    if (!append) ui.results.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
    else toast(error.message);
  } finally {
    $('search-btn').disabled = false;
    ui.more.disabled = false;
    ui.more.textContent = 'Load more';
  }
}

const MODE_WORDS = { keywords: 'keywords', question: 'a question', sentence: 'a sentence', doi: 'a DOI', similar: 'the topic of one paper' };

function showSearch(appended = null) {
  const s = lastSearch;
  ui.head.hidden = false;
  ui.back.hidden = true;
  ui.title.innerHTML = `<strong>${nf.format(s.total)}</strong> ${s.total === 1 ? 'paper' : 'papers'} · read as ${esc(MODE_WORDS[s.interpreted.mode] || s.interpreted.mode)}`;
  const terms = s.interpreted.mode === 'keywords' ? [] : s.interpreted.terms;
  ui.interpreted.innerHTML = '';
  const list = appended || s.results;
  const html = list.map((w) => workCard(w, terms)).join('');
  if (appended) ui.results.insertAdjacentHTML('beforeend', html);
  else ui.results.innerHTML = html || '<div class="empty"><p class="empty-title">Nothing matched.</p><p class="empty-note">Try fewer words, loosen the filters, or switch off “Peer-reviewed journals only” to include books, conference papers and preprints.</p></div>';
  ui.pager.hidden = s.results.length >= s.total || s.results.length >= 500;
  $('insight').hidden = !s.results.length;
  $('answer-btn').innerHTML = s.interpreted.mode === 'keywords' ? '✦ Summarise these papers' : '✦ Answer from these papers';
  renderAnswer();
  renderInsight();
  setResultView(resultView);
}

function badges(w) {
  const out = [];
  if (w.retracted) out.push('<span class="badge retracted">Retracted</span>');
  if (w.peerReviewed) out.push('<span class="badge peer" title="Journal article or review with a DOI">Peer-reviewed journal</span>');
  else if (w.type === 'preprint') out.push('<span class="badge preprint" title="Not yet peer reviewed">Preprint</span>');
  else if (w.type) out.push(`<span class="badge">${esc(w.type.replace(/-/g, ' '))}</span>`);
  out.push(`<span class="badge cites" title="Times cited, per OpenAlex">Cited by ${nf.format(w.citedBy || 0)}</span>`);
  if (w.openAccess) out.push('<span class="badge oa">Free to read</span>');
  if (w.field) out.push(`<span class="badge">${esc(w.field)}</span>`);
  return out.join('');
}

function workCard(w, terms = []) {
  const saved = isSaved(w.id);
  const link = w.url || (w.doi ? `https://doi.org/${w.doi}` : '#');
  const evidence = (w.evidence || []).length
    ? `<ul class="evidence" aria-label="Where the abstract matches">${w.evidence.map((e) => `<li>${highlight(e.text, terms)}</li>`).join('')}</ul>`
    : '';
  const canConnect = /^W\d+$/.test(w.id);
  return `
  <article class="work${saved ? ' saved' : ''}" data-id="${esc(w.id)}">
    <h3 class="work-title"><a href="${esc(link)}" target="_blank" rel="noopener">${esc(w.title)}</a></h3>
    <p class="work-meta">${esc(authorsShort(w))} · ${w.venue ? `<span class="venue">${esc(w.venue)}</span> · ` : ''}${esc(w.year || 'n.d.')}</p>
    <div class="badges">${badges(w)}</div>
    ${evidence}
    <div class="abstract reader" hidden></div>
    <div class="fulltext reader" hidden></div>
    <div class="actions">
      <button type="button" class="ghost${saved ? ' on' : ''}" data-act="save" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save'}</button>
      <button type="button" class="ghost" data-act="cite">Cite</button>
      <button type="button" class="ghost" data-act="abstract" aria-expanded="false" ${w.abstract ? '' : 'disabled title="No abstract in the index"'}>Abstract &amp; paraphrase</button>
      ${bridge ? '' : `<button type="button" class="ghost${fullTexts.has(w.id) ? ' on' : ''}" data-act="fulltext" aria-expanded="false" title="${w.openAccess ? 'Read the free PDF' : 'No free copy listed: upload the PDF if you have access'}">${fullTexts.has(w.id) ? '📄 Full text' : w.openAccess ? 'Read full text' : 'Full text (upload)'}</button>`}
      <button type="button" class="ghost" data-act="similar" title="Papers on the same topic as this one">More like this</button>
      ${bridge ? '' : '<button type="button" class="ghost" data-act="ask" title="Ask questions about this paper, answered from its text with page numbers">✦ Ask this paper</button>'}
      ${canConnect ? `<button type="button" class="ghost" data-act="related">Related</button>
      <button type="button" class="ghost" data-act="citing">Cited by</button>
      <button type="button" class="ghost" data-act="references">References</button>` : ''}
      ${w.oaUrl ? `<a class="ghost-btn" href="${esc(w.oaUrl)}" target="_blank" rel="noopener">Read free copy ↗</a>` : ''}
    </div>
    <div class="connected" hidden></div>
  </article>`;
}

function syncSavedButtons() {
  document.querySelectorAll('.work').forEach((card) => {
    const saved = isSaved(card.dataset.id);
    card.classList.toggle('saved', saved);
    const btn = card.querySelector('[data-act="save"]');
    if (btn) {
      btn.classList.toggle('on', saved);
      btn.setAttribute('aria-pressed', String(saved));
      btn.textContent = saved ? '★ Saved' : '☆ Save';
    }
  });
  document.querySelectorAll('[data-mini-save]').forEach((btn) => {
    const saved = isSaved(btn.dataset.miniSave);
    btn.textContent = saved ? '★' : '☆';
    btn.title = saved ? 'Saved' : 'Save to sources';
  });
}

function toggleAbstract(card, w, btn) {
  const box = card.querySelector('.abstract');
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  btn.classList.toggle('on', open);
  if (!open || box.dataset.ready) return;
  box.dataset.ready = '1';
  const sentences = splitSentences(w.abstract);
  box.innerHTML = `<p class="abstract-hint">Click a sentence to paraphrase it, quote it, or find papers that say the same.</p>
    <p>${sentences.map((s, i) => `<span class="sentence" tabindex="0" role="button" data-i="${i}">${esc(s)}</span>`).join(' ')}</p>
    <div class="sentence-menu" hidden></div>`;
  box.dataset.sentences = JSON.stringify(sentences);
}

function sentenceMenu(card, w, span) {
  const box = span.closest('.reader');
  const menu = box.querySelector('.sentence-menu');
  card.querySelectorAll('.sentence.active').forEach((s) => s.classList.remove('active'));
  card.querySelectorAll('.sentence-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
  span.classList.add('active');
  const text = span.textContent;
  // A sentence from the full text knows its page, so its citation can too.
  const page = span.dataset.page || '';
  const context = box.classList.contains('fulltext') ? span.closest('.ft-para')?.textContent || '' : w.abstract;
  menu.hidden = false;
  menu.innerHTML = `
    <button type="button" class="primary small" data-s="paraphrase">Paraphrase</button>
    <button type="button" class="ghost" data-s="quote">Save as quote</button>
    <button type="button" class="ghost" data-s="copy">Copy with citation</button>
    <button type="button" class="ghost" data-s="find">Find papers that say this</button>`;
  span.after(menu);
  menu.onclick = async (e) => {
    const act = e.target.closest('[data-s]')?.dataset.s;
    if (!act) return;
    if (act === 'paraphrase') openParaphrase(w, text, context, page);
    if (act === 'copy') copy(quoteWithCitation(text, w, page), 'Quote copied with its citation');
    if (act === 'find') {
      ui.q.value = text;
      ui.form.querySelector('input[value="sentence"]').checked = true;
      runSearch();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (act === 'quote') {
      const themeId = await pickTheme();
      if (!themeId) return;
      ensureSaved(w);
      addFinding({ kind: 'quote', text, sourceId: w.id, page, themeId });
      syncSavedButtons();
    }
  };
}

// ---------------------------------------------------------------- full text

/**
 * PDF page 2 of a paper printed on pages 112–120 is page 113, and that is the
 * number a citation wants. Falls back to the PDF page when the index has no
 * numeric range or the PDF is longer than the range (a preprint, say).
 */
function printedPage(w, pdfPage) {
  const m = String(w.pages || '').match(/^(\d+)\s*[–-]\s*(\d+)$/);
  if (!m) return String(pdfPage);
  const [first, last] = [Number(m[1]), Number(m[2])];
  const page = first + Number(pdfPage) - 1;
  return page <= last ? String(page) : String(pdfPage);
}

const OPEN_SECTIONS = new Set(['abstract', 'results', 'discussion', 'conclusion']);

async function toggleFullText(card, w, btn) {
  const box = card.querySelector('.fulltext');
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  btn.classList.toggle('on', open);
  if (!open || box.dataset.ready) return;
  if (fullTexts.has(w.id)) { renderFullText(box, w); return; }
  if (!w.openAccess) { renderUploadOnly(box, w, 'The index lists no free copy of this paper.'); return; }
  box.innerHTML = '<p class="ft-status">Finding and reading the free PDF… this can take up to half a minute.</p>';
  try {
    fullTexts.set(w.id, await backend.fulltext(w.id));
    renderFullText(box, w);
    markFullText(card, w);
  } catch (error) {
    renderUploadOnly(box, w, error.message);
  }
}

function uploadControl(w) {
  return `<label class="ghost-btn ft-upload">Upload the PDF<input type="file" accept="application/pdf,.pdf" data-upload="${esc(w.id)}" hidden></label>`;
}

function renderUploadOnly(box, w, message) {
  box.innerHTML = `<p class="ft-status">${esc(message)}</p>
    <p class="panel-note">Got it through your library? Upload the PDF and it is read here: sections, page numbers, and a better study table and answer. The file is read and discarded, never stored.</p>
    ${uploadControl(w)}`;
}

function markFullText(card, w) {
  const btn = card.querySelector('[data-act="fulltext"]');
  if (btn) btn.textContent = '📄 Full text';
  if (!card.querySelector('.badge.ft')) card.querySelector('.badges')?.insertAdjacentHTML('beforeend', '<span class="badge ft">Full text read</span>');
  if (resultView === 'table') renderTable();
}

function renderFullText(box, w) {
  const ft = fullTexts.get(w.id);
  box.dataset.ready = '1';
  const source = ft.via === 'upload' ? 'your upload' : ft.source ? `<a href="${esc(ft.source)}" target="_blank" rel="noopener">the free copy</a>` : 'the free copy';
  box.innerHTML = `
    <p class="ft-status">Full text from ${source} · ${ft.pages} page${ft.pages === 1 ? '' : 's'}${ft.pagesRead < ft.pages ? ` (first ${ft.pagesRead} read)` : ''} · ${nf.format(ft.words)} words. Click a sentence to paraphrase or quote it: the page number comes with it.</p>
    ${ft.sections.map((sec) => `
      <details class="ft-section"${OPEN_SECTIONS.has(sec.kind) ? ' open' : ''}>
        <summary>${esc(sec.title)}</summary>
        ${sec.paragraphs.map((p) => {
    const printed = printedPage(w, p.page);
    return `<p class="ft-para"><span class="ft-page" title="${printed === String(p.page) ? `Page ${p.page} of the PDF` : `Printed page ${printed}, page ${p.page} of the PDF`}">p. ${printed}</span> ${splitSentences(p.text).map((t) => `<span class="sentence" tabindex="0" role="button" data-page="${printed}">${esc(t)}</span>`).join(' ')}</p>`;
  }).join('')}
      </details>`).join('')}
    <div class="sentence-menu" hidden></div>
    <p class="panel-note">Wrong or incomplete? ${uploadControl(w)}</p>`;
}

discover.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-upload]');
  if (!input || !input.files[0]) return;
  const card = input.closest('.work');
  const w = workCache.get(input.dataset.upload);
  const box = card.querySelector('.fulltext');
  box.innerHTML = '<p class="ft-status">Reading your PDF…</p>';
  try {
    fullTexts.set(w.id, await backend.upload(input.files[0]));
    renderFullText(box, w);
    markFullText(card, w);
  } catch (error) {
    renderUploadOnly(box, w, error.message);
  }
});

/** What the study table reads: methods text improves design and sample; the conclusion states the finding. */
function studyFor(work) {
  const ft = fullTexts.get(work.id);
  if (!ft) return { ...extractStudy(work), source: 'abstract' };
  const text = (kinds) => ft.sections.filter((x) => kinds.includes(x.kind)).map((x) => x.paragraphs.map((p) => p.text).join(' ')).join(' ');
  const x = extractStudy({ ...work, abstract: `${work.abstract || ''} ${text(['methods'])}` });
  const conclusion = text(['conclusion']) || text(['discussion']);
  return { ...x, finding: (conclusion && keyFinding(conclusion)) || extractStudy(work).finding, source: 'full text' };
}

const CONNECT_LABEL = {
  related: 'Similar papers',
  citing: 'Newer papers that cite this',
  references: 'What this paper cites',
};

async function toggleConnected(card, w, kind, btn) {
  const box = card.querySelector('.connected');
  const same = box.dataset.kind === kind && !box.hidden;
  card.querySelectorAll('[data-act="related"],[data-act="citing"],[data-act="references"]').forEach((b) => b.classList.remove('on'));
  if (same) { box.hidden = true; return; }
  btn.classList.add('on');
  box.hidden = false;
  box.dataset.kind = kind;
  box.innerHTML = `<p class="connected-head">${CONNECT_LABEL[kind]}</p><p class="mini-meta">Loading…</p>`;
  try {
    const data = await backend.connected(w.id, kind);
    data.results.forEach((r) => workCache.set(r.id, r));
    if (box.dataset.kind !== kind) return;
    box.innerHTML = `<p class="connected-head">${CONNECT_LABEL[kind]} · ${nf.format(data.total)}</p>${
      data.results.length ? data.results.map(miniRow).join('') : '<p class="mini-meta">None in the index.</p>'}`;
  } catch (error) {
    box.innerHTML = `<p class="connected-head">${CONNECT_LABEL[kind]}</p><p class="mini-meta">${esc(error.message)}</p>`;
  }
}

function miniRow(w) {
  return `<div class="mini" data-mini="${esc(w.id)}">
    <div>
      <div class="mini-title">${esc(w.title)}</div>
      <div class="mini-meta">${esc(authorsShort(w))} · ${esc(w.year || 'n.d.')} · cited by ${nf.format(w.citedBy || 0)}${w.peerReviewed ? ' · peer-reviewed' : ''}${w.retracted ? ' · <strong>retracted</strong>' : ''}</div>
    </div>
    <div class="mini-actions">
      <button type="button" class="ghost" data-mini-open="${esc(w.id)}" title="Open here">Open</button>
      <button type="button" class="ghost" data-mini-save="${esc(w.id)}" title="${isSaved(w.id) ? 'Saved' : 'Save to sources'}">${isSaved(w.id) ? '★' : '☆'}</button>
    </div>
  </div>`;
}

/** Shows one paper on its own, with a way back to the results. */
function openSingle(w) {
  $('insight').hidden = true;
  $('table-view').hidden = true;
  ui.results.hidden = false;
  ui.head.hidden = false;
  ui.back.hidden = !lastSearch;
  ui.title.innerHTML = '<strong>One paper</strong>';
  ui.interpreted.innerHTML = '';
  ui.results.innerHTML = workCard(w);
  ui.pager.hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// The study table handles its own clicks.
const outsideTable = (e) => !e.target.closest('#table-view');

discover.addEventListener('click', (e) => {
  if (!outsideTable(e)) return;
  const miniOpen = e.target.closest('[data-mini-open]');
  if (miniOpen) { openSingle(workCache.get(miniOpen.dataset.miniOpen)); return; }
  const miniSave = e.target.closest('[data-mini-save]');
  if (miniSave) {
    const w = workCache.get(miniSave.dataset.miniSave);
    if (isSaved(w.id)) unsaveWork(w.id); else saveWork(w);
    return;
  }
  const example = e.target.closest('[data-example]');
  if (example) { useExample(example.dataset.example); return; }

  const card = e.target.closest('.work');
  if (!card) return;
  const w = workCache.get(card.dataset.id);
  const span = e.target.closest('.sentence');
  if (span) { sentenceMenu(card, w, span); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'save') { if (isSaved(w.id)) unsaveWork(w.id); else saveWork(w); }
  if (act === 'cite') openCite(w);
  if (act === 'abstract') toggleAbstract(card, w, btn);
  if (act === 'fulltext') toggleFullText(card, w, btn);
  if (act === 'similar') explorePaper(w);
  if (act === 'ask') openChat(w);
  if (['related', 'citing', 'references'].includes(act)) toggleConnected(card, w, act, btn);
});

discover.addEventListener('keydown', (e) => {
  const span = e.target.closest('.sentence');
  if (span && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    const card = span.closest('.work');
    sentenceMenu(card, workCache.get(card.dataset.id), span);
  }
});

ui.back.addEventListener('click', () => { $('insight').hidden = false; showSearch(); });
ui.more.addEventListener('click', () => runSearch({ page: (lastSearch?.page || 1) + 1, params: lastSearch.params }));

ui.form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
ui.q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runSearch(); }
});
['f-peer', 'f-oa', 'f-from', 'f-to', 'f-cites', 'f-sort'].forEach((id) => $(id).addEventListener('change', updateFilterSummary));

const EXAMPLES = {
  keywords: 'microplastics freshwater',
  question: 'Does sleep deprivation affect working memory in adolescents?',
  sentence: 'Regular physical activity reduces symptoms of depression in older adults.',
};
function useExample(kind) {
  ui.q.value = EXAMPLES[kind];
  ui.form.querySelector(`input[value="${kind}"]`).checked = true;
  runSearch();
}

// ---------------------------------------------------------------- cite dialog

let citing = null;

function openCite(w) {
  citing = w;
  $('cite-work').textContent = `${authorsShort(w)} (${w.year || 'n.d.'}). ${w.title}`;
  $('cite-style').value = style();
  $('cite-page').value = '';
  renderCite();
  $('cite-dialog').showModal();
}

function renderCite() {
  const w = citing;
  if (!w) return;
  const page = $('cite-page').value.trim();
  const lib = savedWorksIncluding(w);
  const s = $('cite-style').value;
  const entry = referenceList(lib, s).find((r) => r.id === w.id) || reference(w, s);
  const rows = [
    ['Reference list', entry.html, entry.text],
    ['In text, end of a sentence', esc(inText(w, s, { page, library: lib })), inText(w, s, { page, library: lib })],
    ['In text, named in the sentence', esc(inText(w, s, { page, narrative: true, library: lib })), inText(w, s, { page, narrative: true, library: lib })],
    ['BibTeX', esc(bibtex([w])), bibtex([w]), true],
  ];
  $('cite-rows').innerHTML = rows.map(([label, html, , code], i) => `
    <div class="cite-row">
      <p class="cite-label">${label}</p>
      <p class="cite-text${code ? ' code' : ''}">${html}</p>
      <div class="row-actions"><button type="button" class="ghost" data-copy="${i}">Copy</button></div>
    </div>`).join('');
  $('cite-rows').onclick = (e) => {
    const i = e.target.closest('[data-copy]')?.dataset.copy;
    if (i !== undefined) copy(rows[i][2]);
  };
  if (STYLES[s].numeric && !isSaved(w.id)) {
    $('cite-rows').insertAdjacentHTML('beforeend', '<p class="panel-note">Numbers follow the order you save sources in. Save this paper to fix its number.</p>');
  }
}
$('cite-style').addEventListener('change', renderCite);
$('cite-page').addEventListener('input', renderCite);

// ---------------------------------------------------------------- paraphrase dialog

let para = null; // { work, context }

function openParaphrase(w, text, context = '', page = '') {
  para = { work: w, context };
  $('para-work').textContent = `${authorsShort(w)} (${w.year || 'n.d.'}). ${w.title}`;
  $('para-source').value = text;
  $('para-page').value = page;
  $('para-variants').innerHTML = '';
  $('para-status').textContent = '';
  $('para-status').classList.remove('error');
  renderQuote();
  $('para-dialog').showModal();
  runParaphrase();
}

function renderQuote() {
  if (!para) return;
  $('quote-text').textContent = quoteWithCitation($('para-source').value, para.work, $('para-page').value.trim());
}

async function runParaphrase() {
  const text = $('para-source').value.trim();
  if (!text || !para) return;
  const engine = $('para-engine').value;
  const statusLine = $('para-status');
  statusLine.classList.remove('error');
  $('para-run').disabled = true;
  try {
    if (engine === 'model') {
      if (!(await ensureAccessCode())) { statusLine.textContent = ''; return; }
      statusLine.textContent = 'Writing…';
      const variants = await paraphraseWithModel(text);
      showVariants(variants, text);
      statusLine.textContent = 'Three versions. Edit any of them; the overlap check follows your edits.';
    } else {
      statusLine.textContent = '';
      const data = await backend.paraphrase(text);
      showVariants(data.variants, text);
      statusLine.textContent = data.variants.length
        ? 'Starting points, not finished sentences. Rework the one closest to what you mean.'
        : 'The offline engine found nothing it could safely change. Try the model, or write it yourself below.';
      if (!data.variants.length) showVariants([{ label: 'Your own version', text: '', overlap: overlap(text, '') }], text);
    }
  } catch (error) {
    statusLine.textContent = error.message;
    statusLine.classList.add('error');
  } finally {
    $('para-run').disabled = false;
  }
}

async function paraphraseWithModel(text) {
  const res = await fetch('/api/research/paraphrase', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': accessCode() },
    body: JSON.stringify({ text, engine: 'model', context: para.context || '' }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `The server answered ${res.status}.`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let written = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, cut).replace(/^data: /, '');
      buffer = buffer.slice(cut + 2);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'delta') {
        written += event.text;
        $('para-status').textContent = `Writing… ${written.split(/\s+/).length} words`;
      }
      if (event.type === 'done') return event.variants;
    }
  }
  throw new Error('The model stopped before finishing. Try again.');
}

function overlapHtml(o) {
  const word = { fresh: 'Your own words', close: 'Close to the source', 'too-close': 'Too close' }[o.verdict];
  return `<span class="overlap ${o.verdict}" title="${o.score}% of the source's three-word sequences survive; longest copied run is ${o.longestRun.length} words">
      <span class="overlap-track"><span class="overlap-fill" style="width:${Math.max(4, o.score)}%"></span></span>
      <span class="overlap-word">${word}</span> <span>${o.score}%</span>
    </span>`;
}

function showVariants(variants, source) {
  const box = $('para-variants');
  box.innerHTML = variants.map((v, i) => `
    <div class="variant" data-i="${i}">
      <div class="variant-head">
        <span class="variant-label">${esc(v.label)}</span>
        <span class="overlap-slot">${overlapHtml(v.overlap)}</span>
      </div>
      <textarea rows="3" aria-label="${esc(v.label)} paraphrase, editable">${esc(v.text)}</textarea>
      <p class="overlap-advice">${esc(v.overlap.advice)}</p>
      <p class="with-cite"></p>
      <div class="row-actions">
        <button type="button" class="ghost" data-v="polish" title="Smooth the wording under academic rules: no contractions, no first or second person">Polish</button>
        <button type="button" class="ghost" data-v="copy">Copy with citation</button>
        <button type="button" class="primary small" data-v="save">Save as finding</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('.variant').forEach((card) => refreshVariant(card, source));
}

function refreshVariant(card, source = $('para-source').value) {
  const text = card.querySelector('textarea').value;
  const o = overlap(source, text);
  card.querySelector('.overlap-slot').innerHTML = overlapHtml(o);
  card.querySelector('.overlap-advice').textContent = text.trim() ? o.advice : 'Write your version here.';
  const cited = attachCitation(text, para.work, { page: $('para-page').value.trim(), placement: $('para-place').value });
  card.querySelector('.with-cite').innerHTML = cited ? `<strong>In your draft:</strong> ${esc(cited)}` : '';
}

$('para-variants').addEventListener('input', (e) => {
  const card = e.target.closest('.variant');
  if (card) refreshVariant(card);
});

$('para-variants').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-v]')?.dataset.v;
  if (!act) return;
  const card = e.target.closest('.variant');
  const text = card.querySelector('textarea').value.trim();
  if (!text) { toast('Write something first.'); return; }
  if (act === 'polish') {
    try {
      const { text: polished } = await backend.polish(text);
      card.querySelector('textarea').value = polished;
      refreshVariant(card);
      toast(polished === text ? 'Already reads cleanly.' : 'Polished');
    } catch (error) { toast(error.message); }
    return;
  }
  const page = $('para-page').value.trim();
  const placement = $('para-place').value;
  if (act === 'copy') copy(attachCitation(text, para.work, { page, placement }), 'Copied with its citation');
  if (act === 'save') {
    const o = overlap($('para-source').value, text);
    if (o.verdict === 'too-close' && !window.confirm('This still reads as the source’s wording. Save it anyway? It will be marked so you rework it before submitting.')) return;
    const themeId = await pickTheme();
    if (!themeId) return;
    ensureSaved(para.work);
    addFinding({ kind: 'paraphrase', text, sourceId: para.work.id, page, placement, themeId });
    syncSavedButtons();
  }
});

['para-page', 'para-place'].forEach((id) => $(id).addEventListener('input', () => {
  document.querySelectorAll('#para-variants .variant').forEach((c) => refreshVariant(c));
  renderQuote();
}));
$('para-source').addEventListener('input', renderQuote);
$('para-run').addEventListener('click', runParaphrase);
$('para-engine').addEventListener('change', () => {
  $('para-code-field').hidden = !($('para-engine').value === 'model' && status.model.accessCodeRequired);
});
$('quote-copy').addEventListener('click', () => copy($('quote-text').textContent, 'Quote copied with its citation'));
$('quote-save').addEventListener('click', async () => {
  const themeId = await pickTheme();
  if (!themeId) return;
  ensureSaved(para.work);
  addFinding({ kind: 'quote', text: $('para-source').value.trim(), sourceId: para.work.id, page: $('para-page').value.trim(), themeId });
  syncSavedButtons();
});

// ---------------------------------------------------------------- workspace

const tabs = document.querySelectorAll('.workspace .tab');
tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
function showTab(name) {
  tabs.forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    $(`panel-${t.dataset.tab}`).hidden = !on;
  });
  try { localStorage.setItem('humaniser.research.tab', name); } catch { /* fine */ }
}

function refreshWorkspace() {
  renderProjects();
  renderSources();
  renderFindings();
  renderReferences();
  $('count-sources').textContent = project().sourceOrder.length;
  $('count-findings').textContent = Object.keys(project().findings).length;
}

function renderProjects() {
  $('project').innerHTML = Object.values(store.projects)
    .sort((a, b) => a.created - b.created)
    .map((p) => `<option value="${esc(p.id)}"${p.id === store.currentId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
}

function renderSources() {
  const p = project();
  const filter = $('source-filter').value.trim().toLowerCase();
  const items = p.sourceOrder.map((id) => p.sources[id]).filter(Boolean).filter(({ work, tags }) => !filter
    || `${work.title} ${authorsShort(work)} ${work.venue || ''} ${work.year || ''} ${tags.join(' ')}`.toLowerCase().includes(filter));
  if (!p.sourceOrder.length) {
    $('sources').innerHTML = '<div class="empty">Papers you save show up here, ready to cite. Use ☆ Save on any result.</div>';
    return;
  }
  const uses = {};
  Object.values(p.findings).forEach((f) => { if (f.sourceId) uses[f.sourceId] = (uses[f.sourceId] || 0) + 1; });
  $('sources').innerHTML = items.map(({ work: w, tags }) => `
    <div class="source" data-id="${esc(w.id)}">
      <p class="source-title">${esc(w.title)}</p>
      <p class="source-meta">${esc(authorsShort(w))} · ${esc(w.year || 'n.d.')}${w.venue ? ` · ${esc(w.venue)}` : ''} · cited by ${nf.format(w.citedBy || 0)}${uses[w.id] ? ` · used in ${uses[w.id]} finding${uses[w.id] === 1 ? '' : 's'}` : ''}</p>
      ${tags.length ? `<div class="source-tags">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="actions">
        <button type="button" class="ghost" data-src="open">Open</button>
        <button type="button" class="ghost" data-src="cite">Cite</button>
        <button type="button" class="ghost" data-src="note">Add note</button>
        <button type="button" class="ghost" data-src="tag">Tags</button>
        <button type="button" class="ghost" data-src="remove" aria-label="Remove from sources">Remove</button>
      </div>
    </div>`).join('') || '<div class="empty">No saved source matches that filter.</div>';
}

$('sources').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-src]')?.dataset.src;
  if (!act) return;
  const id = e.target.closest('.source').dataset.id;
  const entry = project().sources[id];
  const w = entry.work;
  workCache.set(w.id, w);
  if (act === 'open') openSingle(w);
  if (act === 'cite') openCite(w);
  if (act === 'remove') unsaveWork(id);
  if (act === 'tag') {
    const value = await ask({ title: 'Tags', sub: 'Separate with commas, e.g. method, counter-evidence, chapter 2', value: entry.tags.join(', ') });
    if (value === null) return;
    entry.tags = value.split(',').map((t) => t.trim()).filter(Boolean);
    save();
    renderSources();
  }
  if (act === 'note') {
    const text = await ask({ title: 'Note on this paper', sub: w.title, okLabel: 'Save' });
    if (!text) return;
    const themeId = await pickTheme();
    if (themeId) addFinding({ kind: 'note', text, sourceId: id, themeId });
  }
});
$('source-filter').addEventListener('input', renderSources);

$('add-manual').addEventListener('click', async () => {
  const value = await ask({ title: 'Add a paper by DOI', sub: 'Paste a DOI or a doi.org link.', okLabel: 'Look it up' });
  if (!value) return;
  try {
    const { work } = await backend.work(/^W\d+$/i.test(value) ? value : `doi:${value}`);
    workCache.set(work.id, work);
    saveWork(work);
  } catch (error) {
    toast(error.message);
  }
});

// Findings -------------------------------------------------------

function findingCitation(f) {
  const src = f.sourceId && project().sources[f.sourceId];
  if (!src) return f.sourceId ? 'Source removed; re-save it to cite.' : '';
  return citeFor(src.work, { page: f.page });
}

/** The finding as it would sit in a draft, citation attached. */
function findingInDraft(f) {
  const src = f.sourceId && project().sources[f.sourceId];
  if (!src) return f.text;
  if (f.kind === 'quote') return quoteWithCitation(f.text, src.work, f.page);
  if (f.kind === 'paraphrase') return attachCitation(f.text, src.work, { page: f.page, placement: f.placement });
  return `${f.text} ${citeFor(src.work, { page: f.page })}`;
}

function renderFindings() {
  const p = project();
  const kindLabel = { quote: 'Quote', paraphrase: 'Paraphrase', note: 'Note' };
  $('findings').innerHTML = p.themes.map((t, ti) => `
    <section class="theme" data-theme="${esc(t.id)}">
      <div class="theme-head">
        <h3 class="theme-name">${esc(t.name)} <span class="pill">${t.items.length}</span></h3>
        <div class="row-actions">
          ${t.items.length ? '<button type="button" class="ghost" data-th="write" title="Open these findings in the rewriter as a paragraph">Write up</button>' : ''}
          ${ti > 1 ? `<button type="button" class="ghost" data-th="up" aria-label="Move theme up">↑</button>` : ''}
          ${t.id !== INBOX ? `<button type="button" class="ghost" data-th="rename">Rename</button><button type="button" class="ghost" data-th="delete">Delete</button>` : ''}
        </div>
      </div>
      <div class="theme-body">
        ${t.items.map((id) => p.findings[id]).filter(Boolean).map((f) => {
          const cite = findingCitation(f);
          const src = f.sourceId && p.sources[f.sourceId];
          const close = f.kind === 'paraphrase' && src && src.work.abstract
            && overlap(bestSourceSentence(src.work.abstract, f.text), f.text).verdict === 'too-close';
          return `<div class="finding" draggable="true" data-f="${esc(f.id)}">
            <span class="finding-kind ${f.kind}">${kindLabel[f.kind] || f.kind}${close ? ' · rework: still close to the source' : ''}</span>
            <p class="finding-text">${f.kind === 'quote' ? `“${esc(f.text)}”` : esc(f.text)}</p>
            ${cite ? `<p class="finding-cite">${esc(cite)}${src ? ` · ${esc(src.work.title.slice(0, 70))}${src.work.title.length > 70 ? '…' : ''}` : ''}</p>` : ''}
            <div class="actions">
              <button type="button" class="ghost" data-fa="copy">Copy for draft</button>
              <button type="button" class="ghost" data-fa="edit">Edit</button>
              <button type="button" class="ghost" data-fa="move">Move</button>
              <button type="button" class="ghost" data-fa="find">Find more</button>
              <button type="button" class="ghost" data-fa="delete" aria-label="Delete finding">Delete</button>
            </div>
          </div>`;
        }).join('') || '<p class="theme-empty">Drag findings here.</p>'}
      </div>
    </section>`).join('');
}

/** The abstract sentence a paraphrase most likely came from, for the overlap flag. */
function bestSourceSentence(abstract, text) {
  let best = { s: '', score: -1 };
  for (const s of splitSentences(abstract)) {
    const score = overlap(s, text).score;
    if (score > best.score) best = { s, score };
  }
  return best.s;
}

function moveFinding(id, toTheme, beforeId = null) {
  const p = project();
  p.themes.forEach((t) => { t.items = t.items.filter((x) => x !== id); });
  const theme = p.themes.find((t) => t.id === toTheme) || p.themes[0];
  const at = beforeId ? theme.items.indexOf(beforeId) : -1;
  if (at >= 0) theme.items.splice(at, 0, id); else theme.items.push(id);
  save();
  renderFindings();
}

$('findings').addEventListener('click', async (e) => {
  const p = project();
  const th = e.target.closest('[data-th]')?.dataset.th;
  if (th) {
    const id = e.target.closest('.theme').dataset.theme;
    const i = p.themes.findIndex((t) => t.id === id);
    if (th === 'write') {
      const text = p.themes[i].items.map((fid) => p.findings[fid]).filter(Boolean).map(findingInDraft).join(' ');
      document.dispatchEvent(new CustomEvent('humaniser:rewrite', {
        detail: { text, academic: true, citationStyle: STYLES[style()].label },
      }));
      return;
    }
    if (th === 'up' && i > 1) [p.themes[i - 1], p.themes[i]] = [p.themes[i], p.themes[i - 1]];
    if (th === 'rename') {
      const name = await ask({ title: 'Rename theme', value: p.themes[i].name, okLabel: 'Rename' });
      if (!name) return;
      p.themes[i].name = name;
    }
    if (th === 'delete') {
      if (!window.confirm(`Delete “${p.themes[i].name}”? Its findings move to Unsorted.`)) return;
      p.themes[0].items.push(...p.themes[i].items);
      p.themes.splice(i, 1);
    }
    save();
    renderFindings();
    return;
  }
  const act = e.target.closest('[data-fa]')?.dataset.fa;
  if (!act) return;
  const card = e.target.closest('.finding');
  const f = p.findings[card.dataset.f];
  if (act === 'copy') copy(findingInDraft(f), 'Copied with its citation');
  if (act === 'delete') {
    delete p.findings[f.id];
    p.themes.forEach((t) => { t.items = t.items.filter((x) => x !== f.id); });
    save();
    refreshWorkspace();
  }
  if (act === 'move') {
    const to = await ask({ title: 'Move to', options: p.themes.map((t) => ({ value: t.id, label: t.name })), okLabel: 'Move' });
    if (to) moveFinding(f.id, to);
  }
  if (act === 'find') {
    ui.q.value = f.text;
    ui.form.querySelector('input[value="sentence"]').checked = true;
    runSearch();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  if (act === 'edit') {
    const text = await ask({ title: 'Edit finding', value: f.text, okLabel: 'Save' });
    if (text === null || !text) return;
    f.text = text;
    save();
    renderFindings();
  }
});

// Drag and drop between themes. Keyboard users have "Move".
let dragId = null;
$('findings').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.finding');
  if (!card) return;
  dragId = card.dataset.f;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', findingInDraft(project().findings[dragId]));
});
$('findings').addEventListener('dragend', (e) => {
  e.target.closest('.finding')?.classList.remove('dragging');
  document.querySelectorAll('.theme.drop').forEach((t) => t.classList.remove('drop'));
  dragId = null;
});
$('findings').addEventListener('dragover', (e) => {
  const theme = e.target.closest('.theme');
  if (!theme || !dragId) return;
  e.preventDefault();
  document.querySelectorAll('.theme.drop').forEach((t) => t !== theme && t.classList.remove('drop'));
  theme.classList.add('drop');
});
$('findings').addEventListener('drop', (e) => {
  const theme = e.target.closest('.theme');
  if (!theme || !dragId) return;
  e.preventDefault();
  const before = e.target.closest('.finding')?.dataset.f;
  moveFinding(dragId, theme.dataset.theme, before && before !== dragId ? before : null);
});

$('add-theme').addEventListener('click', async () => {
  const name = await ask({ title: 'New theme', sub: 'A theme, an argument, or a section of your paper: “Methods”, “Gaps in the literature”…', okLabel: 'Add' });
  if (!name) return;
  project().themes.push({ id: uid(), name, items: [] });
  save();
  renderFindings();
});

$('add-note').addEventListener('click', async () => {
  const text = await ask({ title: 'Add a note', sub: 'Your own idea, a question to chase, a connection between papers.', okLabel: 'Next' });
  if (!text) return;
  const themeId = await pickTheme();
  if (themeId) addFinding({ kind: 'note', text, themeId });
});

$('export-findings').addEventListener('click', () => {
  const p = project();
  const lines = [`# ${p.name}`, ''];
  for (const t of p.themes) {
    const items = t.items.map((id) => p.findings[id]).filter(Boolean);
    if (!items.length) continue;
    lines.push(`## ${t.name}`, '');
    for (const f of items) lines.push(`- ${f.kind === 'note' && !f.sourceId ? f.text : findingInDraft(f)}${f.kind === 'note' ? ' _(note)_' : ''}`);
    lines.push('');
  }
  const used = usedWorks();
  if (used.length) {
    lines.push(`## References (${STYLES[style()].label})`, '');
    referenceList(used, style()).forEach((r) => lines.push(r.text, ''));
  }
  download(`${slug(p.name)}-outline.md`, lines.join('\n'), 'text/markdown');
});

// References -----------------------------------------------------

function usedWorks() {
  const p = project();
  const used = new Set(Object.values(p.findings).map((f) => f.sourceId).filter(Boolean));
  return p.sourceOrder.filter((id) => used.has(id)).map((id) => p.sources[id]?.work).filter(Boolean);
}

function listedWorks() { return $('refs-cited-only').checked ? usedWorks() : savedWorks(); }

function renderReferences() {
  const works = listedWorks();
  const list = $('references');
  list.classList.toggle('numeric', STYLES[style()].numeric);
  list.innerHTML = works.length
    ? referenceList(works, style()).map((r) => `<li>${r.html}</li>`).join('')
    : `<li class="empty">${$('refs-cited-only').checked ? 'No finding cites a source yet.' : 'Save papers and the list builds itself here, in the style you pick at the top.'}</li>`;
}

$('refs-cited-only').addEventListener('change', renderReferences);
$('copy-refs').addEventListener('click', () => {
  const works = listedWorks();
  if (!works.length) { toast('Nothing to copy yet.'); return; }
  copy(referenceList(works, style()).map((r) => r.text).join('\n\n'), 'Reference list copied');
});
$('dl-bib').addEventListener('click', () => download(`${slug(project().name)}.bib`, bibtex(listedWorks()), 'application/x-bibtex'));
$('dl-ris').addEventListener('click', () => download(`${slug(project().name)}.ris`, ris(listedWorks()), 'application/x-research-info-systems'));
$('dl-txt').addEventListener('click', () => download(`${slug(project().name)}-references.txt`, referenceList(listedWorks(), style()).map((r) => r.text).join('\n\n')));

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'research';

// Projects -------------------------------------------------------

$('project').addEventListener('change', () => {
  store.currentId = $('project').value;
  save();
  refreshWorkspace();
  syncSavedButtons();
});

const menu = $('project-menu');
$('project-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  $('project-menu-btn').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) {
    menu.hidden = true;
    $('project-menu-btn').setAttribute('aria-expanded', 'false');
  }
});

menu.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  menu.hidden = true;
  const p = project();
  if (act === 'new') {
    const name = await ask({ title: 'New project', sub: 'One per paper, thesis chapter or literature review.', okLabel: 'Create' });
    if (!name) return;
    const np = blankProject(name);
    store.projects[np.id] = np;
    store.currentId = np.id;
  }
  if (act === 'rename') {
    const name = await ask({ title: 'Rename project', value: p.name, okLabel: 'Rename' });
    if (!name) return;
    p.name = name;
  }
  if (act === 'delete') {
    if (!window.confirm(`Delete “${p.name}” and everything in it? Back it up first if you might want it.`)) return;
    delete store.projects[p.id];
    if (!Object.keys(store.projects).length) {
      const np = blankProject();
      store.projects[np.id] = np;
    }
    store.currentId = Object.keys(store.projects)[0];
  }
  if (act === 'export') {
    download(`${slug(p.name)}-backup.json`, JSON.stringify({ app: 'humaniser-research', version: 1, project: p }, null, 2), 'application/json');
    return;
  }
  if (act === 'import') { $('import-file').click(); return; }
  save();
  refreshWorkspace();
  syncSavedButtons();
});

$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0];
  $('import-file').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const p = data.project;
    if (!p || typeof p !== 'object' || !p.sources || !p.themes || !p.findings) throw new Error('bad shape');
    p.id = uid(); // never overwrite a project already here
    if (Object.values(store.projects).some((x) => x.name === p.name)) p.name = `${p.name} (restored)`;
    if (!p.themes.some((t) => t.id === INBOX)) p.themes.unshift({ id: INBOX, name: 'Unsorted', items: [] });
    p.sourceOrder = (p.sourceOrder || Object.keys(p.sources)).filter((id) => p.sources[id]);
    store.projects[p.id] = p;
    store.currentId = p.id;
    save();
    refreshWorkspace();
    syncSavedButtons();
    toast(`Restored “${p.name}”`);
  } catch {
    toast('That file is not a Research backup.');
  }
});

// Style ----------------------------------------------------------

function fillStyles(select) {
  select.innerHTML = Object.entries(STYLES).map(([id, s]) => `<option value="${id}">${esc(s.label)}</option>`).join('');
}
fillStyles($('style'));
fillStyles($('cite-style'));
$('style').value = style();
$('style').addEventListener('change', () => {
  store.style = $('style').value;
  save();
  renderFindings();
  renderReferences();
  if ($('para-dialog').open) document.querySelectorAll('#para-variants .variant').forEach((c) => refreshVariant(c));
});

// ---------------------------------------------------------------- across the results

let resultView = 'list';
let synthesis = null; // { data, question }
let tableSort = 'relevance';

function setResultView(view) {
  resultView = view;
  document.querySelectorAll('[data-rview]').forEach((b) => {
    const on = b.dataset.rview === view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  const table = view === 'table' && lastSearch?.results.length;
  $('table-view').hidden = !table;
  ui.results.hidden = Boolean(table);
  ui.pager.hidden = Boolean(table) || !lastSearch || lastSearch.results.length >= lastSearch.total;
  if (table) renderTable();
}
document.querySelectorAll('[data-rview]').forEach((b) => b.addEventListener('click', () => setResultView(b.dataset.rview)));

function tableRows() {
  return lastSearch.results.map((work, index) => {
    const x = studyFor(work);
    const m = synthesis?.data.papers.find((p) => p.id === work.id);
    return {
      work,
      index,
      design: m?.design || x.design,
      designRank: x.designRank,
      population: m?.population || x.population,
      sample: m?.sample || x.sample,
      sampleSize: x.sampleSize,
      finding: m?.finding || x.finding,
      stance: m?.stance || null,
      limitation: m?.limitation || null,
      source: m?.fullText || x.source === 'full text' ? 'Full text' : 'Abstract',
      ai: Boolean(m),
    };
  });
}

const SORTERS = {
  relevance: (a, b) => a.index - b.index,
  evidence: (a, b) => a.designRank - b.designRank || b.work.citedBy - a.work.citedBy,
  sample: (a, b) => b.sampleSize - a.sampleSize,
  cited: (a, b) => b.work.citedBy - a.work.citedBy,
  newest: (a, b) => (b.work.year || 0) - (a.work.year || 0),
};

const STANCE_LABEL = { yes: 'Yes', possibly: 'Possibly', no: 'No', unclear: 'Unclear' };

function renderTable() {
  const rows = tableRows().sort(SORTERS[tableSort] || SORTERS.relevance);
  const withStance = rows.some((r) => r.stance);
  const cell = (v) => (v ? esc(v) : '<span class="nil">not stated</span>');
  $('table-view').innerHTML = `
    <div class="table-tools">
      <div class="field">
        <label for="table-sort">Order</label>
        <select id="table-sort">
          <option value="relevance">Best match</option>
          <option value="evidence">Strongest evidence first</option>
          <option value="sample">Largest sample</option>
          <option value="cited">Most cited</option>
          <option value="newest">Newest</option>
        </select>
      </div>
      <button type="button" class="ghost" id="table-csv">Export CSV</button>
      <p class="table-note">${synthesis ? '✦ marks cells the AI read. ' : ''}Each row says whether it came from the full text or the abstract. Open a paper's full text to improve its row. Check anything you rely on.</p>
    </div>
    <div class="table-wrap">
      <table class="studies">
        <thead><tr><th scope="col">Paper</th><th scope="col">Design</th><th scope="col">Sample</th><th scope="col">Key finding</th>${withStance ? '<th scope="col">Answer</th>' : ''}<th scope="col"><span class="visually-hidden">Save</span></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr data-id="${esc(r.work.id)}">
            <td class="t-paper">
              <button type="button" class="linkish t-title" data-open="${esc(r.work.id)}">${esc(r.work.title)}</button>
              <span class="t-meta">${esc(authorsShort(r.work))} · ${esc(r.work.year || 'n.d.')} · cited by ${nf.format(r.work.citedBy || 0)}${r.work.retracted ? ' · <strong class="t-retracted">retracted</strong>' : ''}</span>
            </td>
            <td>${cell(r.design)}${r.ai ? ' <span class="ai-mark" title="Read by the AI">✦</span>' : ''}</td>
            <td>${cell(r.sample)}${r.population && r.population !== r.sample ? `<span class="t-meta">${esc(r.population)}</span>` : ''}</td>
            <td class="t-finding">${cell(r.finding)}${r.limitation ? `<span class="t-meta">Limitation: ${esc(r.limitation)}</span>` : ''}<span class="t-source ${r.source === 'Full text' ? 'full' : ''}">${r.source}</span></td>
            ${withStance ? `<td>${r.stance ? `<span class="stance ${r.stance}">${STANCE_LABEL[r.stance]}</span>` : ''}</td>` : ''}
            <td><button type="button" class="ghost" data-mini-save="${esc(r.work.id)}" title="${isSaved(r.work.id) ? 'Saved' : 'Save to sources'}">${isSaved(r.work.id) ? '★' : '☆'}</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  $('table-sort').value = tableSort;
  $('table-sort').onchange = () => { tableSort = $('table-sort').value; renderTable(); };
  $('table-csv').onclick = () => download(`studies-${slug(lastSearch.query).slice(0, 40)}.csv`, studiesCsv(tableRows()), 'text/csv');
}

$('table-view').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { openSingle(workCache.get(open.dataset.open)); return; }
  const star = e.target.closest('[data-mini-save]');
  if (star) {
    const w = workCache.get(star.dataset.miniSave);
    if (isSaved(w.id)) unsaveWork(w.id); else saveWork(w);
    renderTable();
  }
});

const CONSENSUS_LABEL = {
  yes: 'Yes', 'mostly-yes': 'Mostly yes', mixed: 'Mixed', 'mostly-no': 'Mostly no', no: 'No',
  insufficient: 'Not enough evidence in these papers',
};

/** The works an answer cites, in its numbering. */
const answerWorks = () => (synthesis ? synthesis.data.ids.map((id) => workCache.get(id)).filter(Boolean) : []);

/** Swaps the answer's [1, 3] markers for real in-text citations in the chosen style. */
function answerWithCitations() {
  const works = answerWorks();
  const cited = new Set();
  const groups = [];
  synthesis.data.answer.replace(/\[([\d,\s]+)\]/g, (m, inner) => {
    const ws = inner.split(',').map((n) => works[Number(n) - 1]).filter(Boolean);
    ws.forEach((w) => cited.add(w));
    groups.push(ws);
    return m;
  });
  const library = [...savedWorks(), ...[...cited].filter((w) => !isSaved(w.id))];
  let i = 0;
  const text = synthesis.data.answer.replace(/\s*\[([\d,\s]+)\]/g, () => {
    const ws = groups[i++];
    return ws.length ? ` ${inText(ws, style(), { library })}` : '';
  });
  return { text, cited: [...cited] };
}

function renderAnswer() {
  const box = $('answer');
  if (!synthesis) { box.hidden = true; box.innerHTML = ''; return; }
  const d = synthesis.data;
  const total = d.meter.yes + d.meter.possibly + d.meter.no;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const meter = d.consensus !== 'not-applicable' && total ? `
    <div class="meter-row">
      <p class="consensus"><span class="consensus-label">${esc(CONSENSUS_LABEL[d.consensus] || d.consensus)}</span> · ${total} of ${d.papers.length} papers take a position</p>
      <div class="cmeter" role="img" aria-label="Yes ${pct(d.meter.yes)}%, possibly ${pct(d.meter.possibly)}%, no ${pct(d.meter.no)}%">
        ${['yes', 'possibly', 'no'].map((k) => (d.meter[k] ? `<span class="cm ${k}" style="flex:${d.meter[k]}"></span>` : '')).join('')}
      </div>
      <p class="cmeter-legend">${['yes', 'possibly', 'no'].map((k) => `<span><i class="dot ${k}"></i>${STANCE_LABEL[k]} ${pct(d.meter[k])}%</span>`).join('')}</p>
    </div>` : (d.consensus === 'insufficient' ? `<p class="consensus"><span class="consensus-label">${CONSENSUS_LABEL.insufficient}</span></p>` : '');
  const answerHtml = refsHtml(d.answer, d.ids);
  box.hidden = false;
  box.innerHTML = `
    ${meter}
    <p class="answer-text">${answerHtml}</p>
    <p class="answer-foot">Written by ${esc(status.model.label || 'the AI')} from ${d.fullTextIds.length ? `the full texts of ${d.fullTextIds.length} and the abstracts of ${d.ids.length - d.fullTextIds.length}` : `the abstracts of ${d.ids.length}`} papers. Follow each citation before you rely on it.</p>
    <div class="row-actions">
      <button type="button" class="ghost" data-ans="copy">Copy with citations</button>
      <button type="button" class="ghost" data-ans="save">Save as a finding</button>
      <button type="button" class="ghost" data-ans="table">See the study table</button>
    </div>`;
}

/** Scrolls to a paper in the list and flashes it. */
function showPaper(id) {
  setResultView('list');
  const card = ui.results.querySelector(`.work[data-id="${CSS.escape(id)}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1600);
  }
}

/** "[1, 3]" in AI text becomes small buttons that jump to the paper. */
function refsHtml(text, ids) {
  return esc(text).replace(/\[([\d,\s]+)\]/g, (m, inner) => `<sup class="refs">${inner.split(',').map((n) => `<button type="button" class="ref" data-ref="${n.trim()}" title="${esc(workCache.get(ids[Number(n) - 1])?.title || '')}">${n.trim()}</button>`).join('')}</sup>`);
}

$('answer').addEventListener('click', async (e) => {
  const ref = e.target.closest('[data-ref]');
  if (ref) { showPaper(synthesis.data.ids[Number(ref.dataset.ref) - 1]); return; }
  const act = e.target.closest('[data-ans]')?.dataset.ans;
  if (act === 'table') setResultView('table');
  if (act === 'copy') copy(answerWithCitations().text, 'Answer copied with citations');
  if (act === 'save') {
    const themeId = await pickTheme();
    if (!themeId) return;
    const { cited } = answerWithCitations();
    cited.forEach(ensureSaved);
    // Recomputed after saving, so numeric styles number from the saved list.
    addFinding({ kind: 'note', text: answerWithCitations().text, themeId });
    syncSavedButtons();
  }
});

$('answer-btn').addEventListener('click', async () => {
  const note = $('answer-note');
  note.hidden = true;
  if (!status.model?.keyInEnv) {
    note.hidden = false;
    note.innerHTML = 'Answers need an AI key on the server. Add <code>GEMINI_API_KEY</code> to the <code>.env</code> file and restart. The study table works without one.';
    return;
  }
  if (!(await ensureAccessCode())) return;
  const works = lastSearch.results.filter((w) => w.abstract).slice(0, MAX_SYNTHESIS_PAPERS);
  if (!works.length) { toast('None of these papers has an abstract to read.'); return; }
  const btn = $('answer-btn');
  btn.disabled = true;
  $('answer').hidden = false;
  $('answer').innerHTML = `<p class="answer-loading">${$('read-full').checked
    ? `Fetching the free full texts and reading ${works.length} papers… up to a minute.`
    : `Reading ${works.length} papers…`}</p>`;
  const question = lastSearch.query;
  try {
    const readFull = $('read-full').checked;
    const data = await backend.synthesize(question, works.map((w) => ({
      id: w.id, title: w.title, year: w.year, venue: w.venue, abstract: w.abstract, authors: w.authors,
      doi: w.doi, oaUrl: w.oaUrl, pdfUrls: w.pdfUrls, landingUrls: w.landingUrls,
      fulltext: fullTexts.has(w.id) ? digest(fullTexts.get(w.id)) : undefined,
    })), readFull);
    if (lastSearch.query !== question) return; // a new search came in meanwhile
    synthesis = { data, question };
    renderAnswer();
    renderInsight();
    if (resultView === 'table') renderTable();
  } catch (error) {
    $('answer').innerHTML = `<p class="answer-error">${esc(error.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- one paper: explore and ask

let paperState = null; // { work, terms, uploaded, matched, scan, scanning }

function closePaperView() {
  paperState = null;
  $('paper-view').hidden = true;
  $('paper-view').innerHTML = '';
}

/** Text of a paper for the model: the full text with page markers, else the abstract. */
function modelTextFor(work) {
  const ft = fullTexts.get(work.id);
  if (ft) return { text: paperText(ft, (p) => printedPage(work, p)), full: true };
  return { text: work.abstract ? `## Abstract\n${work.abstract}` : '', full: false };
}

/**
 * The paper-first path: show the paper, what it is about, and papers on the
 * same topic. Used by Add a paper and by More like this on any card.
 */
async function explorePaper(work, { terms = null, uploaded = false, matched = true } = {}) {
  workCache.set(work.id, work);
  paperState = { work, terms, uploaded, matched, scan: null, scanning: false };
  renderPaperView();
  $('paper-view').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Full text makes the topics, the scan and the questions better. Fetch it
  // quietly when there is a free copy.
  if (!fullTexts.has(work.id) && work.openAccess && !bridge && /^W\d+$/.test(work.id)) {
    backend.fulltext(work.id).then((ft) => {
      fullTexts.set(work.id, ft);
      if (paperState?.work.id === work.id) renderPaperView();
    }).catch(() => { /* the abstract will do */ });
  }

  runSimilar(work, terms);
  if (status.model?.keyInEnv && !status.model.accessCodeRequired) scanPaper();
}

async function runSimilar(work, terms) {
  ui.results.hidden = false;
  $('table-view').hidden = true;
  ui.head.hidden = true;
  ui.results.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  $('insight').hidden = true;
  const ft = fullTexts.get(work.id);
  const params = { ...searchParams(), q: work.title, similar: true };
  try {
    const data = await backend.similar({
      id: /^W\d+$/.test(work.id) ? work.id : undefined,
      work: /^W\d+$/.test(work.id) ? undefined : { id: work.id, doi: work.doi, title: work.title, abstract: work.abstract, keywords: work.keywords },
      text: ft ? ft.sections.filter((x) => ['abstract', 'introduction', 'conclusion'].includes(x.kind)).map((x) => x.paragraphs.map((p) => p.text).join(' ')).join(' ') : '',
      terms,
      peerReviewed: params.peerReviewed,
    });
    if (paperState?.work.id !== work.id) return;
    data.results.forEach((w) => workCache.set(w.id, w));
    synthesis = null;
    lastSearch = { params, page: 1, total: data.total, results: data.results, interpreted: data.interpreted, query: data.query };
    showSearch();
    ui.title.innerHTML = `<strong>${nf.format(data.results.length)}</strong> papers on the same topic`;
    ui.pager.hidden = true;
    if (!paperState.terms) { paperState.terms = data.interpreted.terms; renderPaperView(); }
  } catch (error) {
    ui.results.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
  }
}

async function scanPaper() {
  if (!paperState || paperState.scanning) return;
  const { work } = paperState;
  const { text } = modelTextFor(work);
  if (text.length < 200) { toast('There is not enough of this paper to scan. Open its full text or upload it.'); return; }
  if (!(await ensureAccessCode())) return;
  paperState.scanning = true;
  renderPaperView();
  try {
    const scan = await backend.scan(work.title, text);
    if (paperState?.work.id !== work.id) return;
    paperState.scan = scan;
  } catch (error) {
    if (paperState?.work.id === work.id) paperState.scanError = error.message;
  } finally {
    if (paperState?.work.id === work.id) { paperState.scanning = false; renderPaperView(); }
  }
}

function renderPaperView() {
  const box = $('paper-view');
  if (!paperState) return;
  const { work, uploaded, matched, scan, scanning, scanError } = paperState;
  const ft = fullTexts.get(work.id);
  const study = studyFor(work);
  const terms = scan?.topics?.length ? scan.topics : (paperState.terms || []);
  const origin = uploaded
    ? (matched ? `Your PDF, matched to its record in the index${work.citedBy ? `: cited ${nf.format(work.citedBy)} times` : ''}.` : 'Your PDF. It was not found in the index, so citations use only what the PDF says. Add its DOI to cite it properly.')
    : 'Exploring this paper.';
  const chips = (xs, attr) => xs.map((t) => `<button type="button" class="chip chip-btn" ${attr}="${esc(t)}">${esc(t)}</button>`).join(' ');
  box.innerHTML = `
    <div class="pv-head">
      <p class="pv-label">${esc(origin)}</p>
      <button type="button" class="ghost" data-pv="close" aria-label="Close this paper">✕</button>
    </div>
    ${workCard(work)}
    <div class="pv-grid">
      <div class="pv-facts">
        <h3 class="pv-h">At a glance</h3>
        <dl class="focus-facts">
          <div><dt>Design</dt><dd>${esc(scan?.design || study.design || 'not stated')}</dd></div>
          <div><dt>Sample</dt><dd>${esc(scan?.sample || study.sample || 'not stated')}</dd></div>
          <div><dt>Read from</dt><dd>${ft ? `the full text, ${ft.pages} pages` : 'the abstract only'}</dd></div>
        </dl>
        ${study.finding && !scan ? `<p class="pv-finding"><strong>Key finding:</strong> ${esc(study.finding)}</p>` : ''}
        ${terms.length ? `<p class="pv-topics"><strong>About:</strong> ${chips(terms, 'data-topic')}</p>` : ''}
      </div>
      <div class="pv-ai">
        ${scan ? `
          <h3 class="pv-h">✦ Scan</h3>
          ${scan.summary ? `<p class="pv-summary">${esc(scan.summary)}</p>` : ''}
          ${scan.keyFindings.length ? `<p class="pv-sub">Key findings</p><ul class="pv-list">${scan.keyFindings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
          ${scan.limitations.length ? `<p class="pv-sub">Limitations</p><ul class="pv-list">${scan.limitations.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
          ${scan.searches.length ? `<p class="pv-sub">Search next</p><p>${chips(scan.searches, 'data-topic')}</p>` : ''}`
        : scanning ? '<p class="answer-loading">✦ Reading the paper…</p>'
        : status.model?.keyInEnv ? `<p class="pv-sub">${scanError ? esc(scanError) : 'Get a summary, key findings with pages, limitations and searches to run next.'}</p><button type="button" class="primary small" data-pv="scan">✦ Scan this paper</button>`
        : '<p class="pv-sub">Add a GEMINI_API_KEY to get a summary, key findings and suggested searches.</p>'}
        ${!bridge ? '<p class="pv-ask"><button type="button" class="ghost" data-pv="ask">✦ Ask this paper a question</button></p>' : ''}
      </div>
    </div>`;
}

$('paper-view').addEventListener('click', (e) => {
  const act = e.target.closest('[data-pv]')?.dataset.pv;
  if (act === 'close') { closePaperView(); if (lastSearch && !lastSearch.params.similar) showSearch(); return; }
  if (act === 'scan') { scanPaper(); return; }
  if (act === 'ask') { openChat(paperState.work); return; }
  const topic = e.target.closest('[data-topic]');
  if (topic) {
    ui.q.value = topic.dataset.topic;
    ui.form.querySelector('input[value="auto"]').checked = true;
    runSearch();
  }
});

// Add a paper -----------------------------------------------------

function setAddStatus(msg, error = false) {
  $('add-status').textContent = msg;
  $('add-status').classList.toggle('error', error);
}

$('add-paper-btn').addEventListener('click', () => {
  setAddStatus('');
  $('add-id').value = '';
  $('add-drop').hidden = Boolean(bridge);
  document.querySelector('.add-or').hidden = Boolean(bridge);
  $('add-dialog').showModal();
});

async function addFromPdf(file) {
  if (!file) return;
  if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) { setAddStatus('That is not a PDF.', true); return; }
  setAddStatus('Reading the PDF and looking it up in the index…');
  try {
    const data = await backend.upload(file, true);
    const { work: matched, terms, ...ft } = data;
    const abstract = ft.sections.find((x) => x.kind === 'abstract')?.paragraphs.map((p) => p.text).join(' ') || '';
    const work = matched || {
      id: `upload-${Date.now().toString(36)}`,
      doi: '',
      title: ft.title || file.name.replace(/\.pdf$/i, ''),
      authors: [],
      year: null,
      type: 'upload',
      abstract,
      citedBy: 0,
      keywords: [],
      openAccess: false,
      url: null,
    };
    fullTexts.set(work.id, ft);
    $('add-dialog').close();
    explorePaper(work, { terms, uploaded: true, matched: Boolean(matched) });
  } catch (error) {
    setAddStatus(error.message, true);
  }
}

$('add-file').addEventListener('change', () => addFromPdf($('add-file').files[0]));
$('add-drop').addEventListener('dragover', (e) => { e.preventDefault(); $('add-drop').classList.add('over'); });
$('add-drop').addEventListener('dragleave', () => $('add-drop').classList.remove('over'));
$('add-drop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('add-drop').classList.remove('over');
  addFromPdf(e.dataTransfer.files[0]);
});
$('add-id-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('add-id').value.trim();
  if (!value) return;
  setAddStatus('Looking it up…');
  try {
    const { work } = await backend.work(/^W\d+$/i.test(value) ? value : `doi:${value}`);
    $('add-dialog').close();
    explorePaper(work);
  } catch (error) {
    setAddStatus(error.message, true);
  }
});

// Ask this paper --------------------------------------------------

const chats = new Map(); // work id -> [{ q, a }]
let chatWork = null;

const SUGGESTIONS = [
  'What is the main finding?',
  'Who was studied, and how many?',
  'How were the key variables measured?',
  'What are the limitations?',
  'What future research do the authors suggest?',
  'Explain the method in plain terms.',
];

/** Light formatting for an answer: paragraphs, bullets, bold, and page references picked out. */
function answerHtml(text) {
  const blocks = esc(text).split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*([-*•]|\d+\.)\s+/, '')}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.join('<br>')}</p>`;
  }).join('');
  return blocks
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\((pp?\. [\d–-]+(?:, pp?\. [\d–-]+)*)\)/g, '<span class="pageref">($1)</span>');
}

function renderChat() {
  const log = chats.get(chatWork.id) || [];
  $('chat-log').innerHTML = log.length ? log.map((turn, i) => `
    <div class="turn">
      <p class="q">${esc(turn.q)}</p>
      <div class="a${turn.pending ? ' pending' : ''}${turn.error ? ' error' : ''}">${turn.error ? esc(turn.error) : answerHtml(turn.a || '…')}</div>
      ${turn.a && !turn.pending && !turn.error ? `<div class="row-actions"><button type="button" class="ghost" data-turn="${i}" data-chat="copy">Copy with citation</button><button type="button" class="ghost" data-turn="${i}" data-chat="save">Save as a finding</button></div>` : ''}
    </div>`).join('') : '<p class="chat-empty">Ask anything about this paper. Answers come only from its text, with page numbers.</p>';
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  $('chat-suggest').innerHTML = SUGGESTIONS.filter((q) => !log.some((t) => t.q === q))
    .slice(0, 4).map((q) => `<button type="button" class="chip chip-btn" data-suggest="${esc(q)}">${esc(q)}</button>`).join('');
}

function renderChatSource() {
  const ft = fullTexts.get(chatWork.id);
  $('chat-source').innerHTML = ft
    ? `Reading the full text: ${ft.pages} pages, ${nf.format(ft.words)} words.`
    : `Only the abstract is available, so answers will be thin. ${uploadControl(chatWork).replace('data-upload', 'data-chat-upload')}`;
}

async function openChat(work) {
  if (!status.model?.keyInEnv) { toast('Asking a paper needs an AI key. Add GEMINI_API_KEY to .env and restart.'); return; }
  if (!(await ensureAccessCode())) return;
  chatWork = work;
  workCache.set(work.id, work);
  $('chat-paper').textContent = `${authorsShort(work)} (${work.year || 'n.d.'}). ${work.title}`;
  renderChatSource();
  renderChat();
  $('chat-dialog').showModal();
  $('chat-input').focus();
  if (!fullTexts.has(work.id) && work.openAccess && /^W\d+$/.test(work.id)) {
    $('chat-source').textContent = 'Fetching the free full text…';
    try { fullTexts.set(work.id, await backend.fulltext(work.id)); } catch { /* abstract it is */ }
    if (chatWork?.id === work.id) renderChatSource();
  }
}

async function askPaper(question) {
  const q = question.trim();
  if (!q || !chatWork) return;
  const work = chatWork;
  const { text } = modelTextFor(work);
  if (text.length < 100) { toast('There is no text of this paper to answer from. Upload its PDF.'); return; }
  const log = chats.get(work.id) || [];
  chats.set(work.id, log);
  const turn = { q, a: '', pending: true };
  const history = log.filter((t) => t.a && !t.error).map(({ q: hq, a }) => ({ q: hq, a }));
  log.push(turn);
  $('chat-input').value = '';
  $('chat-send').disabled = true;
  renderChat();
  try {
    await streamPost('/api/research/ask', {
      question: q, text, history,
      paper: { title: work.title, year: work.year, authors: work.authors },
    }, (delta) => {
      turn.a += delta;
      if (chatWork?.id === work.id) renderChat();
    });
  } catch (error) {
    turn.error = error.message;
  } finally {
    turn.pending = false;
    $('chat-send').disabled = false;
    if (chatWork?.id === work.id) renderChat();
  }
}

$('chat-form').addEventListener('submit', (e) => { e.preventDefault(); askPaper($('chat-input').value); });
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askPaper($('chat-input').value); }
});
$('chat-suggest').addEventListener('click', (e) => {
  const q = e.target.closest('[data-suggest]')?.dataset.suggest;
  if (q) askPaper(q);
});
$('chat-log').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-chat]');
  if (!btn) return;
  const turn = chats.get(chatWork.id)[Number(btn.dataset.turn)];
  // The answer's own (p. 12) references become the style's page citation.
  const cited = `${turn.a.trim()}\n\n${citeFor(chatWork)}`;
  if (btn.dataset.chat === 'copy') copy(cited, 'Answer copied with its citation');
  if (btn.dataset.chat === 'save') {
    const themeId = await pickTheme();
    if (!themeId) return;
    ensureSaved(chatWork);
    addFinding({ kind: 'note', text: `${turn.q}\n${turn.a.trim()}`, sourceId: chatWork.id, themeId });
    syncSavedButtons();
  }
});
$('chat-dialog').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-chat-upload]');
  if (!input || !input.files[0]) return;
  $('chat-source').textContent = 'Reading your PDF…';
  try {
    fullTexts.set(chatWork.id, await backend.upload(input.files[0]));
    document.querySelectorAll(`.work[data-id="${CSS.escape(chatWork.id)}"]`).forEach((card) => markFullText(card, chatWork));
  } catch (error) {
    toast(error.message);
  }
  renderChatSource();
});

// ---------------------------------------------------------------- takeaway and focus

const MODE_LABEL = {
  keywords: 'Keywords', question: 'A question', sentence: 'A claim to find evidence for', doi: 'A DOI lookup',
  similar: 'The topic of one paper: its own key phrases, plus the index\'s similar-papers graph',
};

function filtersText(p) {
  const bits = [p.peerReviewed === '0' ? 'all publication types' : 'peer-reviewed journal articles and reviews'];
  if (p.openAccess === '1') bits.push('free to read');
  if (p.fromYear || p.toYear) bits.push(`published ${p.fromYear || 'any time'}–${p.toYear || 'now'}`);
  if (Number(p.minCitations) > 0) bits.push(`cited at least ${p.minCitations} times`);
  bits.push('retractions excluded');
  return bits.join(', ');
}

const SORT_LABEL = { relevance: 'best match first', cited: 'most cited first', newest: 'newest first' };

function renderInsight() {
  const s = lastSearch;
  const take = $('takeaway');
  const focus = $('focus');
  if (!s || !s.results.length) { take.hidden = true; focus.hidden = true; return; }

  // Key takeaway: the AI's, across the papers; otherwise the strongest study's own finding.
  const ai = synthesis?.data.takeaway;
  if (ai) {
    take.innerHTML = `
      <p class="takeaway-label">Key takeaway <span>across ${synthesis.data.ids.length} papers</span></p>
      <p class="takeaway-text">${refsHtml(ai, synthesis.data.ids)}</p>`;
  } else {
    const best = strongestFinding(s.results);
    take.innerHTML = best ? `
      <p class="takeaway-label">Key takeaway <span>the strongest evidence in these results</span></p>
      <p class="takeaway-text">${esc(best.study.finding)}</p>
      <p class="takeaway-src">From the ${esc((best.study.design || 'study').toLowerCase())} by ${esc(authorsShort(best.work))} (${esc(best.work.year || 'n.d.')}), cited ${nf.format(best.work.citedBy || 0)} times. <button type="button" class="linkish" data-show="${esc(best.work.id)}">Show it</button>${status.model?.keyInEnv ? ' · Press Answer for a takeaway across all the papers.' : ''}</p>`
      : '<p class="takeaway-label">Key takeaway</p><p class="takeaway-src">None of these abstracts states a finding clearly enough to pull out.</p>';
  }
  take.hidden = false;

  // What we are searching for: what the search engine was given, and, after
  // an answer, what the question is actually asking.
  const f = synthesis?.data.focus;
  const roles = f ? [
    ['Population', f.population], ['Exposure or intervention', f.exposure], ['Compared with', f.comparison],
    ['Outcome', f.outcome], ['Topic', f.topic], ['Context', f.context],
  ].filter(([, v]) => v) : [];
  const terms = s.interpreted.mode === 'keywords' ? [s.query] : s.interpreted.terms;
  const showing = s.params.similar
    ? `${nf.format(s.results.length)} papers, similar-papers graph first`
    : `${nf.format(s.results.length)} of ${nf.format(s.total)}, ${SORT_LABEL[s.params.sort] || 'best match first'}`;
  focus.innerHTML = `
    <h3 id="focus-h" class="focus-h">What we're searching for</h3>
    ${f?.question ? `<p class="focus-q">${esc(f.question)}</p>` : ''}
    ${roles.length ? `<dl class="focus-roles">${roles.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    ${f?.evidenceNeeded ? `<p class="focus-line"><strong>Evidence that would settle it:</strong> ${esc(f.evidenceNeeded)}</p>` : ''}
    <dl class="focus-facts">
      <div><dt>Read as</dt><dd>${esc(MODE_LABEL[s.interpreted.mode] || s.interpreted.mode)}</dd></div>
      <div><dt>Search terms</dt><dd class="chips">${terms.map((t) => `<span class="chip"><strong>${esc(t)}</strong></span>`).join('')}</dd></div>
      <div><dt>Looking in</dt><dd>${esc(filtersText(s.params))}</dd></div>
      <div><dt>Showing</dt><dd>${showing}</dd></div>
    </dl>
    ${f?.nextSearches?.length ? `<p class="focus-next"><strong>Try next:</strong> ${f.nextSearches.map((q) => `<button type="button" class="chip chip-btn" data-next="${esc(q)}">${esc(q)}</button>`).join(' ')}</p>`
      : (status.model?.keyInEnv && !synthesis ? '<p class="focus-hint">Press Answer to break the question into population, exposure and outcome, and get follow-up searches.</p>' : '')}`;
  focus.hidden = false;
}

$('takeaway').addEventListener('click', (e) => {
  const ref = e.target.closest('[data-ref]');
  if (ref) showPaper(synthesis.data.ids[Number(ref.dataset.ref) - 1]);
  const show = e.target.closest('[data-show]');
  if (show) showPaper(show.dataset.show);
});

$('focus').addEventListener('click', (e) => {
  const next = e.target.closest('[data-next]');
  if (!next) return;
  ui.q.value = next.dataset.next;
  ui.form.querySelector('input[value="auto"]').checked = true;
  runSearch();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// The rewriter asks for sources for a sentence in the draft.
document.addEventListener('humaniser:find', (e) => {
  ui.q.value = e.detail?.text || '';
  ui.form.querySelector('input[value="sentence"]').checked = true;
  runSearch();
  window.scrollTo({ top: 0 });
});

// ---------------------------------------------------------------- start

(async function start() {
  updateFilterSummary();
  refreshWorkspace();
  try {
    const tab = localStorage.getItem('humaniser.research.tab');
    if (tab && $(`panel-${tab}`)) showTab(tab);
  } catch { /* fine */ }

  if (bridge) {
    // One file, no server: no model, no PDF reader, and nowhere to keep a key.
    $('answer-btn').hidden = true;
    $('read-full-wrap').hidden = true;
  } else {
    try {
      status = await api('/api/status');
      const opt = $('para-engine').querySelector('option[value="model"]');
      if (status.model?.keyInEnv) {
        opt.disabled = false;
        opt.textContent = `${status.model.label} (better, slower)`;
        $('para-engine').value = 'model';
        $('para-engine').dispatchEvent(new Event('change'));
      }
    } catch { /* offline paraphrase still works */ }
    $('answer-btn').title = status.model?.keyInEnv
      ? `Reads the top ${MAX_SYNTHESIS_PAPERS} abstracts with ${status.model.label}`
      : 'Needs an AI key on the server';
  }

  // Deep links: /research?q=...
  const q = new URLSearchParams(location.search).get('q');
  if (q) { ui.q.value = q; runSearch(); }
}());
