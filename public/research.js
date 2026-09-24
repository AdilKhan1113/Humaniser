// The research workspace. No framework and no build step, like the rewriter.
//
// Papers come from the server (/api/research/*), which fronts OpenAlex and
// Crossref. Projects live in this browser's localStorage. Citation formatting
// and the overlap check are the same modules the server uses, loaded as-is.

import { STYLES, inText, reference, referenceList, bibtex, ris, toPlain } from '/shared/cite.js';
import { overlap } from '/shared/overlap.js';
import { splitSentences } from '/shared/sentences.js';
import { extractStudy, studiesCsv, MAX_SYNTHESIS_PAPERS } from '/shared/insights.js';

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
  synthesize: (question, works) => api('/api/research/synthesize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': accessCode() },
    body: JSON.stringify({ question, works }),
  }),
};

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

const MODE_WORDS = { keywords: 'keywords', question: 'a question', sentence: 'a sentence', doi: 'a DOI' };

function showSearch(appended = null) {
  const s = lastSearch;
  ui.head.hidden = false;
  ui.back.hidden = true;
  ui.title.innerHTML = `<strong>${nf.format(s.total)}</strong> ${s.total === 1 ? 'paper' : 'papers'} · read as ${esc(MODE_WORDS[s.interpreted.mode] || s.interpreted.mode)}`;
  const terms = s.interpreted.mode === 'keywords' ? [] : s.interpreted.terms;
  ui.interpreted.innerHTML = terms.length
    ? `<span class="chip">Searching for</span>${terms.map((t) => `<span class="chip"><strong>${esc(t)}</strong></span>`).join('')}`
    : '';
  const list = appended || s.results;
  const html = list.map((w) => workCard(w, terms)).join('');
  if (appended) ui.results.insertAdjacentHTML('beforeend', html);
  else ui.results.innerHTML = html || '<div class="empty"><p class="empty-title">Nothing matched.</p><p class="empty-note">Try fewer words, loosen the filters, or switch off “Peer-reviewed journals only” to include books, conference papers and preprints.</p></div>';
  ui.pager.hidden = s.results.length >= s.total || s.results.length >= 500;
  $('insight').hidden = !s.results.length;
  $('answer-btn').innerHTML = s.interpreted.mode === 'keywords' ? '✦ Summarise these papers' : '✦ Answer from these papers';
  renderAnswer();
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
    <div class="abstract" hidden></div>
    <div class="actions">
      <button type="button" class="ghost${saved ? ' on' : ''}" data-act="save" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save'}</button>
      <button type="button" class="ghost" data-act="cite">Cite</button>
      <button type="button" class="ghost" data-act="abstract" aria-expanded="false" ${w.abstract ? '' : 'disabled title="No abstract in the index"'}>Abstract &amp; paraphrase</button>
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
  const box = card.querySelector('.abstract');
  const menu = box.querySelector('.sentence-menu');
  box.querySelectorAll('.sentence.active').forEach((s) => s.classList.remove('active'));
  span.classList.add('active');
  const text = span.textContent;
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
    if (act === 'paraphrase') openParaphrase(w, text, w.abstract);
    if (act === 'copy') copy(quoteWithCitation(text, w, ''), 'Quote copied with its citation');
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
      addFinding({ kind: 'quote', text, sourceId: w.id, themeId });
      syncSavedButtons();
    }
  };
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

ui.results.addEventListener('click', (e) => {
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
  if (['related', 'citing', 'references'].includes(act)) toggleConnected(card, w, act, btn);
});

ui.results.addEventListener('keydown', (e) => {
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

function openParaphrase(w, text, context = '') {
  para = { work: w, context };
  $('para-work').textContent = `${authorsShort(w)} (${w.year || 'n.d.'}). ${w.title}`;
  $('para-source').value = text;
  $('para-page').value = '';
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
    const x = extractStudy(work);
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
      <p class="table-note">${synthesis ? '✦ marks rows read by the AI from the abstract. ' : ''}Read from abstracts, not full texts. Check anything you rely on.</p>
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
            <td class="t-finding">${cell(r.finding)}</td>
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
  const answerHtml = esc(d.answer).replace(/\[([\d,\s]+)\]/g, (m, inner) => `<sup class="refs">${inner.split(',').map((n) => `<button type="button" class="ref" data-ref="${n.trim()}" title="${esc(workCache.get(d.ids[Number(n) - 1])?.title || '')}">${n.trim()}</button>`).join('')}</sup>`);
  box.hidden = false;
  box.innerHTML = `
    ${meter}
    <p class="answer-text">${answerHtml}</p>
    <p class="answer-foot">Written by ${esc(status.model.label || 'the AI')} from the abstracts of ${d.ids.length} papers, not their full texts. Follow each citation before you rely on it.</p>
    <div class="row-actions">
      <button type="button" class="ghost" data-ans="copy">Copy with citations</button>
      <button type="button" class="ghost" data-ans="save">Save as a finding</button>
      <button type="button" class="ghost" data-ans="table">See the study table</button>
    </div>`;
}

$('answer').addEventListener('click', async (e) => {
  const ref = e.target.closest('[data-ref]');
  if (ref) {
    const id = synthesis.data.ids[Number(ref.dataset.ref) - 1];
    setResultView('list');
    const card = ui.results.querySelector(`.work[data-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1600);
    }
    return;
  }
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
  $('answer').innerHTML = `<p class="answer-loading">Reading ${works.length} abstracts…</p>`;
  const question = lastSearch.query;
  try {
    const data = await backend.synthesize(question, works.map((w) => ({
      id: w.id, title: w.title, year: w.year, venue: w.venue, abstract: w.abstract, authors: w.authors,
    })));
    if (lastSearch.query !== question) return; // a new search came in meanwhile
    synthesis = { data, question };
    renderAnswer();
    if (resultView === 'table') renderTable();
  } catch (error) {
    $('answer').innerHTML = `<p class="answer-error">${esc(error.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
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
    // One file, no server: no model, and nowhere to keep a key.
    $('answer-btn').hidden = true;
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
