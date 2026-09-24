// Front end. No framework and no build step: the browser loads this file as-is.

// The standalone single-file build injects this bridge, which is how one
// app.js serves both: with a server it talks to /api, without one it calls the
// rules engine that was inlined alongside it.
const offline = typeof window !== 'undefined' ? window.HUMANISER_OFFLINE || null : null;

const el = (id) => document.getElementById(id);

const ui = {
  mode: el('mode'),
  strength: el('strength'),
  effort: el('effort'),
  effortField: el('effort-field'),
  effortLabel: el('effort-label'),
  codeField: el('code-field'),
  accessCode: el('access-code'),
  run: el('run'),
  input: el('input'),
  output: el('output'),
  inCount: el('in-count'),
  outCount: el('out-count'),
  engineNote: el('engine-note'),
  streamStatus: el('stream-status'),
  dashboard: el('dashboard'),
  heroScore: el('hero-score'),
  heroDelta: el('hero-delta'),
  heroVerdict: el('hero-verdict'),
  meterFill: el('meter-fill'),
  facts: el('facts'),
  subscores: el('subscores'),
  rhythmChart: el('rhythm-chart'),
  rhythmTable: el('rhythm-table'),
  rhythmNote: el('rhythm-note'),
  toggleTable: el('toggle-table'),
  issues: el('issues'),
  changes: el('changes'),
  issuesCount: el('issues-count'),
  changesCount: el('changes-count'),
  tooltip: el('tooltip'),
  copy: el('copy'),
  use: el('use'),
  sample: el('sample'),
  guide: el('guide'),
  guideToggle: el('guide-toggle'),
  guideBody: el('guide-body'),
  guideText: el('guide-text'),
  guideFile: el('guide-file'),
  guidePick: el('guide-pick'),
  guideRead: el('guide-read'),
  guideClear: el('guide-clear'),
  guideStatus: el('guide-status'),
  guideSummary: el('guide-summary'),
  guideSub: el('guide-sub'),
  dropzone: el('dropzone'),
  rubricCard: el('rubric-card'),
  rubricChecks: el('rubric-checks'),
  clear: el('clear'),
  analyse: el('analyse'),
};

const state = {
  baseline: null,   // report for the text as it was typed
  current: null,    // report for whatever is on screen now
  changes: [],
  outputText: '',
  status: null,
  busy: false,
  rubric: null,       // the parsed guide
  rubricText: '',     // its raw text, which the model receives verbatim
};

// The house rules a guide can switch off, and what to call them on screen.
const OVERRIDE_LABELS = {
  noContractions: 'contractions are left expanded, and existing ones written out',
  noFirstPerson: 'no passive is flipped into "I" or "we"',
  noSecondPerson: 'no longer asks the writing to address the reader as "you"',
  formalRegister: 'idiom, humour and conversational asides are not suggested',
  noBulletPoints: 'no lists are introduced',
};

const constraintsNow = () => (state.rubric && state.rubric.constraints) || {};

const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high' };

const SAMPLE = `It is important to note that the utilization of data-driven methodologies was demonstrated by our team to be highly effective. In today's fast-paced world, organizations are required to leverage numerous analytical frameworks in order to ascertain optimal outcomes. Furthermore, the implementation of these paradigms facilitates the creation of significant value for stakeholders across the entire organization, and it is anticipated that additional benefits will be obtained subsequently.

The report was written by the strategy group prior to the quarterly review. Decisions were made by the committee regarding the aforementioned proposals. Moreover, it should be noted that the evaluation of these initiatives is conducted on a regular basis, and the results are subsequently communicated to all relevant parties. In conclusion, it is essential that stakeholders are cognizant of the fact that the reduction of operational expenditure remains a key priority.`;

const SUBSCORE_LABELS = {
  rhythm: 'Rhythm',
  voice: 'Active voice',
  plainness: 'Plain words',
  warmth: 'Warmth',
  variety: 'Vocabulary',
  concision: 'Concision',
};

const SUBSCORE_HELP = {
  rhythm: 'How much sentence lengths vary. Machines write at one speed.',
  voice: 'Share of sentences that name who is doing the thing.',
  plainness: 'Freedom from stock phrases and inflated words.',
  warmth: 'Contractions, and whether the writing talks to you.',
  variety: 'Range of vocabulary and how often phrasing repeats.',
  concision: 'Sentence length against the target, minus the padding.',
};

const wordCount = (text) => (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;

// ---------- network ----------

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: 'The server sent something unreadable.' }));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Yields one frame so a "Working…" label actually paints before the engine
// blocks the main thread. Only matters offline, where the work is synchronous.
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function getReport(text) {
  const constraints = constraintsNow();
  if (offline) {
    await nextFrame();
    return offline.analyze(text, constraints);
  }
  return (await postJson('/api/analyze', { text, constraints })).report;
}

async function getRewrite(text, strength) {
  const constraints = constraintsNow();
  if (offline) {
    await nextFrame();
    return offline.humanise(text, strength, constraints);
  }
  return postJson('/api/humanise', { text, strength, constraints });
}

/**
 * Reads a marking guide, from pasted text or a file. Offline the parsing
 * happens in the page; with a server it happens there, because a .docx has to
 * be unzipped either way and one implementation is enough.
 */
async function readGuide({ text, file }) {
  if (file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) {
      throw new Error('PDF text needs a parser this page deliberately does not carry. Open the PDF, select all, copy, and paste it below.');
    }
    if (/\.(doc|pages|odt)$/.test(name)) {
      throw new Error(`${name.match(/\.\w+$/)[0]} cannot be read here. Save it as .docx, or paste the text below.`);
    }
    if (file.size > 12_000_000) throw new Error('That file is too large.');

    if (name.endsWith('.docx')) {
      const buffer = await file.arrayBuffer();
      if (offline) {
        const extracted = await offline.extractDocxText(buffer);
        return { rubric: offline.parseRubric(extracted), text: extracted };
      }
      return postJson('/api/rubric', { docxBase64: bytesToBase64(new Uint8Array(buffer)) });
    }
    const asText = await file.text();
    return offline
      ? { rubric: offline.parseRubric(asText), text: asText }
      : postJson('/api/rubric', { text: asText });
  }

  if (!text.trim()) throw new Error('Paste the guide, or drop the file in.');
  return offline
    ? { rubric: offline.parseRubric(text), text }
    : postJson('/api/rubric', { text });
}

function bytesToBase64(bytes) {
  // Chunked, because spreading a megabyte into String.fromCharCode overflows
  // the argument limit.
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function loadStatus() {
  if (offline) {
    state.status = { offline: true, model: { keyInEnv: false } };
    // There is no server to proxy an API call through, so the engine choice is
    // not a choice. Drop the control rather than show a dead option.
    ui.mode.closest('.field').hidden = true;
    ui.effortField.hidden = true;
    ui.engineNote.textContent = 'Single-file build. Everything runs inside this page: '
      + 'no install, no server, no network, and your text never leaves the browser.';
    return;
  }

  try {
    const status = await fetch('/api/status').then((r) => r.json());
    state.status = status;

    const model = status.model || {};
    const option = ui.mode.querySelector('option[value="model"]');

    if (model.accessCodeRequired) {
      ui.codeField.hidden = ui.mode.value !== 'model';
      // Kept for this tab only, so a shared computer does not keep the code.
      try {
        const saved = sessionStorage.getItem('humaniser.accessCode');
        if (saved) ui.accessCode.value = saved;
      } catch { /* private mode can refuse storage */ }
    }

    if (model.keyInEnv) {
      // The control means different things per provider, so it is labelled by
      // whichever one is configured.
      option.textContent = `${model.label} rewrite`;
      if (model.effortLabel) ui.effortLabel.textContent = model.effortLabel;
      if (Array.isArray(model.efforts) && model.efforts.length) {
        const current = ui.effort.value;
        ui.effort.innerHTML = model.efforts
          .map((level) => `<option value="${level}">${EFFORT_NAMES[level] || level}</option>`)
          .join('');
        ui.effort.value = model.efforts.includes(current) ? current : 'high';
      }
      ui.engineNote.textContent = `${model.label} is ready (${model.model}).`
        + (model.accessCodeRequired ? ' It needs the access code from whoever runs this server.' : '')
        + ` Up to ${status.limits.claude} rewrites an hour. The offline rules need no key at all.`;
    } else {
      // Nothing to gain from letting someone pick an engine that cannot run.
      option.disabled = true;
      option.textContent = 'Model rewrite (needs an API key)';
      ui.engineNote.textContent = 'Running on the offline rules engine. It needs no key, no account '
        + 'and no network, and your text never leaves this machine.';
    }
  } catch {
    ui.engineNote.textContent = 'Could not reach the local server.';
  }
}

// ---------- rendering ----------

function setBusy(busy, label) {
  state.busy = busy;
  ui.run.disabled = busy;
  ui.run.innerHTML = busy ? 'Working…' : 'Humanise <kbd>⌘↵</kbd>';
  ui.output.setAttribute('aria-busy', String(busy));
  if (label !== undefined) setStatus(label);
}

function setStatus(text, isError = false) {
  ui.streamStatus.textContent = text || '';
  ui.streamStatus.classList.toggle('error', Boolean(isError));
}

function showOutput(text) {
  state.outputText = text;
  ui.output.textContent = text;
  ui.outCount.textContent = `${wordCount(text).toLocaleString()} words`;
  ui.copy.disabled = !text;
  ui.use.disabled = !text;
}

function renderDashboard(report, baseline) {
  state.current = report;
  ui.dashboard.hidden = false;

  ui.heroScore.textContent = report.score;
  ui.heroVerdict.textContent = report.verdict;
  ui.meterFill.style.width = `${report.score}%`;

  if (baseline && baseline !== report) {
    const diff = report.score - baseline.score;
    ui.heroDelta.textContent = diff === 0 ? 'no change' : `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff)} from ${baseline.score}`;
    ui.heroDelta.className = `delta ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`;
  } else {
    ui.heroDelta.textContent = '';
    ui.heroDelta.className = 'delta';
  }

  renderFacts(report);
  renderSubscores(report, baseline);
  renderRhythm(report);
  renderIssues(report);
  renderChanges(state.changes);
  renderRubricChecks(state.outputText || ui.input.value);
}

function renderFacts(report) {
  const rows = [
    ['Words', report.counts.words.toLocaleString()],
    ['Sentences', report.counts.sentences.toLocaleString()],
    ['Average length', `${report.rhythm.average} words`],
    ['Length spread', `${report.rhythm.shortest}–${report.rhythm.longest}`],
    ['Burstiness', report.rhythm.burstiness.toFixed(2)],
    ['Reading ease', `${report.readability.flesch} (${report.readability.label})`],
    ['Passive clauses', report.tallies.passive],
    ['Stock phrases', report.tallies.aiTells],
  ];
  ui.facts.innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(String(v))}</dd></div>`)
    .join('');
}

function renderSubscores(report, baseline) {
  ui.subscores.innerHTML = '';
  for (const [key, label] of Object.entries(SUBSCORE_LABELS)) {
    const value = report.subscores[key] ?? 0;
    const was = baseline && baseline !== report ? baseline.subscores[key] : null;

    const scored = !report.scoredQualities || report.scoredQualities.includes(key);
    const row = document.createElement('div');
    row.className = scored ? 'sub' : 'sub muted';
    row.innerHTML = `
      <span class="sub-name">${label}</span>
      <span class="sub-track"><span class="sub-bar" style="width:${value}%"></span></span>
      <span class="sub-value">${value}</span>`;

    let tip = was == null
      ? `${label}: ${value} of 100. ${SUBSCORE_HELP[key]}`
      : `${label}: ${was} \u2192 ${value}. ${SUBSCORE_HELP[key]}`;
    if (!scored) tip += ' Left out of the headline score: the marking guide forbids what it measures.';
    attachTooltip(row, tip);
    ui.subscores.appendChild(row);
  }
}

/* Columns of words-per-sentence in document order, with the 6-20 target band
   drawn behind them. Over-length bars also change colour, but the band and the
   axis already carry that reading, so colour is only reinforcement. */
function renderRhythm(report) {
  const data = report.sentences;
  if (!data.length) {
    ui.rhythmChart.innerHTML = '<p class="placeholder">No sentences yet.</p>';
    ui.rhythmTable.innerHTML = '';
    return;
  }

  const W = 960;
  const H = 220;
  const pad = { top: 16, right: 12, bottom: 26, left: 32 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const maxLen = Math.max(24, ...data.map((s) => s.words));
  const y = (v) => pad.top + plotH - (v / maxLen) * plotH;
  // A 2px surface gap between neighbours, and bars never thicker than 24px.
  const slot = plotW / data.length;
  const barW = Math.max(2, Math.min(24, slot - 2));

  const ticks = [0, Math.round(maxLen / 2), maxLen];
  const longest = data.reduce((a, b) => (b.words > a.words ? b : a), data[0]);

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Words per sentence, in document order. Target band 6 to 20 words.">`);

  // target band
  const bandTop = y(20);
  const bandBottom = y(6);
  parts.push(`<rect class="band" x="${pad.left}" y="${bandTop}" width="${plotW}" height="${bandBottom - bandTop}"></rect>`);
  parts.push(`<text class="band-label" x="${pad.left + 4}" y="${bandTop - 4}">target 6–20 words</text>`);

  for (const t of ticks) {
    parts.push(`<line class="grid-line" x1="${pad.left}" y1="${y(t)}" x2="${W - pad.right}" y2="${y(t)}"></line>`);
    parts.push(`<text class="tick" x="${pad.left - 6}" y="${y(t) + 3}" text-anchor="end">${t}</text>`);
  }

  data.forEach((s, i) => {
    const h = Math.max(1, plotH - (y(s.words) - pad.top));
    const x = pad.left + i * slot + (slot - barW) / 2;
    const over = s.words > 20;
    const radius = Math.min(4, barW / 2);
    parts.push(
      `<rect class="bar${over ? ' over' : ''}" x="${x.toFixed(1)}" y="${y(s.words).toFixed(1)}" `
      + `width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${radius}" `
      + `data-i="${i}"></rect>`,
    );
  });

  // One direct label, on the extreme. Never one per bar.
  const li = data.indexOf(longest);
  const lx = pad.left + li * slot + slot / 2;
  parts.push(`<text class="value-label" x="${lx.toFixed(1)}" y="${(y(longest.words) - 6).toFixed(1)}" text-anchor="middle">${longest.words}</text>`);

  parts.push(`<line class="axis-line" x1="${pad.left}" y1="${pad.top + plotH}" x2="${W - pad.right}" y2="${pad.top + plotH}"></line>`);
  parts.push(`<text class="tick" x="${pad.left}" y="${H - 8}">first sentence</text>`);
  parts.push(`<text class="tick" x="${W - pad.right}" y="${H - 8}" text-anchor="end">last</text>`);
  parts.push('</svg>');

  ui.rhythmChart.innerHTML = parts.join('');
  ui.rhythmNote.textContent = `${data.length} sentences, ${report.rhythm.shortest} to ${report.rhythm.longest} words. Burstiness ${report.rhythm.burstiness.toFixed(2)} (higher varies more).`;

  // Hover: the hit target is the bar plus its slot, so thin bars stay reachable.
  for (const rect of ui.rhythmChart.querySelectorAll('rect.bar')) {
    const s = data[Number(rect.dataset.i)];
    const label = `Sentence ${Number(rect.dataset.i) + 1}: ${s.words} words${s.words > 20 ? ' (over target)' : ''}\n${truncate(s.text, 110)}`;
    attachTooltip(rect, label);
    rect.addEventListener('click', () => selectInInput(s.start, s.end));
    rect.style.cursor = 'pointer';
  }

  ui.rhythmTable.innerHTML = `<table>
    <thead><tr><th>#</th><th>Words</th><th>Sentence</th></tr></thead>
    <tbody>${data.map((s, i) => `<tr><td class="num">${i + 1}</td><td class="num">${s.words}</td><td>${escape(truncate(s.text, 160))}</td></tr>`).join('')}</tbody>
  </table>`;
}

function renderIssues(report) {
  ui.issuesCount.textContent = report.issues.length;
  if (!report.issues.length) {
    ui.issues.innerHTML = '<p class="placeholder">Nothing flagged. This reads clean.</p>';
    return;
  }
  ui.issues.innerHTML = '';
  for (const issue of report.issues) {
    const node = document.createElement(issue.start != null ? 'button' : 'div');
    node.className = 'item';
    if (issue.start != null) node.type = 'button';
    node.innerHTML = `
      <span class="sev ${issue.severity}">${issue.severity}</span>
      <span>
        <p class="item-title">${escape(issue.title)}</p>
        <p class="item-detail">${escape(issue.detail)}</p>
        ${issue.excerpt ? `<p class="item-excerpt">${escape(issue.excerpt)}</p>` : ''}
      </span>`;
    if (issue.start != null) {
      node.addEventListener('click', () => selectInInput(issue.start, issue.end));
    }
    ui.issues.appendChild(node);
  }
}

function renderChanges(changes) {
  ui.changesCount.textContent = changes.length;
  if (!changes.length) {
    ui.changes.innerHTML = '<p class="placeholder">A model rewrites whole sentences, so there is no line-by-line list. Switch to the offline engine to see every edit.</p>';
    return;
  }
  ui.changes.innerHTML = changes.map((c) => `
    <div class="item">
      <span class="change-rule">${escape(c.rule)}</span>
      <span>
        <p class="item-title"><span class="change-from">${escape(truncate(c.from, 90)) || '—'}</span> → <span class="change-to">${escape(truncate(c.to, 90)) || '(removed)'}</span></p>
        ${c.note ? `<p class="item-detail">${escape(c.note)}</p>` : ''}
      </span>
    </div>`).join('');
}

/** Shows what was read out of the guide, and which house rules it switched off. */
function renderGuideSummary() {
  const rubric = state.rubric;
  if (!rubric) {
    ui.guideSummary.hidden = true;
    ui.guideSummary.innerHTML = '';
    ui.guideSub.textContent = "Give it your rubric and it follows the rubric's rules instead of its own where the two disagree.";
    return;
  }

  const chips = [];
  const limit = rubric.wordLimit;
  if (limit) {
    const stated = limit.target
      ? `${limit.target.toLocaleString()}${limit.tolerance ? ` \u00b1${limit.tolerance}%` : ''}`
      : [limit.min && `min ${limit.min.toLocaleString()}`, limit.max && `max ${limit.max.toLocaleString()}`].filter(Boolean).join(' \u00b7 ');
    chips.push(`Word limit <strong>${escape(stated)}</strong>`);
  }
  if (rubric.citationStyle) chips.push(`Referencing <strong>${escape(rubric.citationStyle)}</strong>`);
  if (rubric.minSources) chips.push(`Sources <strong>${rubric.minSources}+</strong>`);
  if (rubric.criteria.length) chips.push(`<strong>${rubric.criteria.length}</strong> criteria`);
  if (rubric.sections.length >= 2) chips.push(`<strong>${rubric.sections.length}</strong> sections named`);

  const overrides = Object.keys(rubric.constraints)
    .filter((key) => OVERRIDE_LABELS[key])
    .map((key) => `<li>${escape(OVERRIDE_LABELS[key])}</li>`);

  ui.guideSummary.innerHTML = `
    ${chips.length ? `<p class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</p>` : ''}
    ${overrides.length
      ? `<p class="card-label">House rules this guide switches off</p><ul class="overrides">${overrides.join('')}</ul>`
      : '<p class="overrides">Nothing in this guide conflicts with the house style, so all of it stays on.</p>'}
    ${rubric.keyTerms.length
      ? `<p class="guide-terms">Concepts it keeps naming: ${escape(rubric.keyTerms.join(', '))}.</p>`
      : ''}`;
  ui.guideSummary.hidden = false;

  const count = Object.keys(rubric.constraints).length;
  ui.guideSub.textContent = count
    ? `Guide loaded. ${count} house rule${count === 1 ? '' : 's'} switched off to match it.`
    : 'Guide loaded.';
}

const CHECK_MARKS = { pass: '\u2713', fail: '\u2715', warn: '!', info: 'i' };

function renderRubricChecks(draft) {
  if (!state.rubric || !draft) {
    ui.rubricCard.hidden = true;
    return;
  }
  const checks = offline ? offline.checkRubric(draft, state.rubric) : state.rubricChecks || [];
  if (!checks.length) {
    ui.rubricCard.hidden = true;
    return;
  }
  ui.rubricChecks.innerHTML = checks.map((c) => `
    <div class="check ${c.status}">
      <span class="check-mark" aria-hidden="true">${CHECK_MARKS[c.status] || 'i'}</span>
      <span>
        <p class="check-label">${escape(c.label)} <span class="sev ${c.status === 'fail' ? 'high' : c.status === 'warn' ? 'medium' : 'low'}">${c.status}</span></p>
        <p class="check-detail">${escape(c.detail)}</p>
      </span>
    </div>`).join('');
  ui.rubricCard.hidden = false;
}

// ---------- helpers ----------

function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function selectInInput(start, end) {
  ui.input.focus();
  ui.input.setSelectionRange(start, end);
  // Rough scroll: put the selected line near the middle of the box.
  const ratio = start / Math.max(1, ui.input.value.length);
  ui.input.scrollTop = Math.max(0, ratio * ui.input.scrollHeight - ui.input.clientHeight / 2);
}

function attachTooltip(node, text) {
  node.addEventListener('pointerenter', (event) => {
    ui.tooltip.textContent = text;
    ui.tooltip.hidden = false;
    moveTooltip(event);
  });
  node.addEventListener('pointermove', moveTooltip);
  node.addEventListener('pointerleave', () => { ui.tooltip.hidden = true; });
}

function moveTooltip(event) {
  const pad = 14;
  const rect = ui.tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
  ui.tooltip.style.left = `${Math.max(8, x)}px`;
  ui.tooltip.style.top = `${Math.max(8, y)}px`;
}

// ---------- actions ----------

async function runAnalyseOnly() {
  const text = ui.input.value;
  if (!text.trim()) { setStatus('Nothing to score yet.', true); return; }
  setBusy(true, 'Scoring…');
  try {
    const report = await getReport(text);
    state.baseline = report;
    state.changes = [];
    showOutput('');
    ui.output.innerHTML = '<p class="placeholder">Scored the original. Nothing rewritten.</p>';
    renderDashboard(report, null);
    setStatus('Scored the text as written.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function runLocal(text) {
  const result = await getRewrite(text, ui.strength.value);
  state.baseline = result.before;
  state.changes = result.changes;
  showOutput(result.text);
  renderDashboard(result.after, result.before);
  setStatus(result.changes.length
    ? `${result.changes.length} edit${result.changes.length === 1 ? '' : 's'} applied by the offline engine.`
    : 'The rules found nothing to change. A model rewrite would go further.');
}

async function runModel(text) {
  const code = ui.accessCode.value.trim();
  const res = await fetch('/api/humanise/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(code ? { 'x-access-code': code } : {}) },
    body: JSON.stringify({
      text,
      strength: ui.strength.value,
      effort: ui.effort.value,
      rubricText: state.rubricText,
    }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) ui.accessCode.focus();
    throw new Error(data.error || 'The model rewrite could not start.');
  }
  try {
    if (code) sessionStorage.setItem('humaniser.accessCode', code);
  } catch { /* storage may be unavailable */ }

  state.changes = [];
  ui.output.textContent = '';
  ui.output.classList.add('streaming');
  setStatus('Reading…');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rewritten = '';
  let failure = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let event;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }

      if (event.type === 'thinking') {
        setStatus('Working out the rhythm…');
      } else if (event.type === 'delta') {
        rewritten += event.text;
        ui.output.textContent = rewritten;
        ui.outCount.textContent = `${wordCount(rewritten).toLocaleString()} words`;
      } else if (event.type === 'done') {
        // The server's final text includes the offline clean-up pass.
        if (typeof event.text === 'string' && event.text.trim()) rewritten = event.text;
        showOutput(rewritten.trim());
        state.rubricChecks = event.rubricChecks || [];
        renderDashboard(event.report, state.baseline);
        const bits = [`${event.usage.output.toLocaleString()} tokens out`];
        if (event.usage.cacheRead) bits.push(`${event.usage.cacheRead.toLocaleString()} cached`);
        if (event.fallbackUsed) bits.push('served by a fallback model');
        const fixes = (event.polishChanges || []).length;
        if (fixes) bits.push(`${fixes} more fix${fixes === 1 ? '' : 'es'} by the offline rules`);
        if (event.truncated) bits.push('output hit the token ceiling, so it may be cut short');
        setStatus(`Done with ${event.model}. ${bits.join(' · ')}.`);
      } else if (event.type === 'error') {
        failure = event.message;
      }
    }
  }

  ui.output.classList.remove('streaming');
  if (failure) throw new Error(failure);
  if (!rewritten.trim()) throw new Error('The model returned nothing.');
}

async function run() {
  const text = ui.input.value;
  if (!text.trim()) { setStatus('Paste some text first.', true); return; }

  setBusy(true, 'Working…');
  try {
    // Score the original first, so the dashboard can show the change.
    if (!state.baseline || state.baseline.counts.characters !== text.length) {
      state.baseline = await getReport(text);
    }
    if (!offline && ui.mode.value === 'model') {
      await runModel(text);
    } else {
      await runLocal(text);
    }
  } catch (error) {
    ui.output.classList.remove('streaming');
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

// ---------- wiring ----------

ui.input.addEventListener('input', () => {
  ui.inCount.textContent = `${wordCount(ui.input.value).toLocaleString()} words`;
  state.baseline = null;
});

ui.mode.addEventListener('change', () => {
  const usingModel = ui.mode.value === 'model';
  ui.effortField.hidden = !usingModel;
  ui.codeField.hidden = !usingModel || !(state.status && state.status.model.accessCodeRequired);
  if (usingModel && state.status && !state.status.model.keyInEnv) {
    setStatus('No API key in the environment. Add GEMINI_API_KEY to .env and restart, or stay on the offline engine.', true);
  } else {
    setStatus('');
  }
});

ui.run.addEventListener('click', run);
ui.analyse.addEventListener('click', runAnalyseOnly);

ui.sample.addEventListener('click', () => {
  ui.input.value = SAMPLE;
  ui.input.dispatchEvent(new Event('input'));
});

ui.clear.addEventListener('click', () => {
  ui.input.value = '';
  ui.input.dispatchEvent(new Event('input'));
  showOutput('');
  ui.output.innerHTML = '<p class="placeholder">The rewrite lands here.</p>';
  ui.dashboard.hidden = true;
  setStatus('');
});

ui.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.outputText);
    setStatus('Copied.');
  } catch {
    setStatus('The browser blocked the clipboard. Select the text and copy it.', true);
  }
});

ui.use.addEventListener('click', () => {
  ui.input.value = state.outputText;
  ui.input.dispatchEvent(new Event('input'));
  setStatus('Moved the rewrite across. Run it again to go further.');
});

ui.toggleTable.addEventListener('click', () => {
  const showing = !ui.rhythmTable.hidden;
  ui.rhythmTable.hidden = showing;
  ui.rhythmChart.hidden = !showing;
  ui.toggleTable.textContent = showing ? 'Show table' : 'Show chart';
  ui.toggleTable.setAttribute('aria-expanded', String(!showing));
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      const on = other === tab;
      other.classList.toggle('active', on);
      other.setAttribute('aria-selected', String(on));
    }
    ui.issues.hidden = tab.dataset.tab !== 'issues';
    ui.changes.hidden = tab.dataset.tab !== 'changes';
  });
}

// Command-Return is the Mac habit; Control-Return for anyone on a PC keyboard.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    if (!state.busy) run();
  }
});

function setGuideStatus(message, kind = '') {
  ui.guideStatus.textContent = message || '';
  ui.guideStatus.className = `guide-status ${kind}`;
}

async function loadGuide(source) {
  setGuideStatus('Reading…');
  try {
    const { rubric, text } = await readGuide(source);
    if (!rubric) throw new Error('Nothing readable in that guide.');
    state.rubric = rubric;
    state.rubricText = text;
    state.baseline = null;               // constraints change the score
    if (source.file) ui.guideText.value = text;
    renderGuideSummary();
    setGuideStatus('Guide applied. Run it again to see the difference.', 'ok');
    if (state.current) renderDashboard(state.current, null);
  } catch (error) {
    setGuideStatus(error.message, 'error');
  }
}

ui.guideToggle.addEventListener('click', () => {
  const open = ui.guideBody.hidden;
  ui.guideBody.hidden = !open;
  ui.guideToggle.setAttribute('aria-expanded', String(open));
  ui.guideToggle.textContent = open ? 'Hide' : 'Add a guide';
});

ui.guidePick.addEventListener('click', () => ui.guideFile.click());
ui.guideFile.addEventListener('change', () => {
  const file = ui.guideFile.files && ui.guideFile.files[0];
  if (file) loadGuide({ file });
});

ui.guideRead.addEventListener('click', () => loadGuide({ text: ui.guideText.value }));

ui.guideClear.addEventListener('click', () => {
  state.rubric = null;
  state.rubricText = '';
  state.rubricChecks = [];
  state.baseline = null;
  ui.guideText.value = '';
  ui.guideFile.value = '';
  ui.rubricCard.hidden = true;
  renderGuideSummary();
  setGuideStatus('Guide removed. Back to the house style.');
  if (state.current) renderDashboard(state.current, null);
});

for (const event of ['dragenter', 'dragover']) {
  ui.dropzone.addEventListener(event, (e) => {
    e.preventDefault();
    ui.dropzone.classList.add('over');
  });
}
for (const event of ['dragleave', 'drop']) {
  ui.dropzone.addEventListener(event, () => ui.dropzone.classList.remove('over'));
}
ui.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadGuide({ file });
});

// Dropping anywhere on the panel works too, which is what people try first.
ui.guide.addEventListener('dragover', (e) => e.preventDefault());
ui.guide.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  if (ui.guideBody.hidden) ui.guideToggle.click();
  loadGuide({ file });
});

// ---------- one page, two tools ----------
// Research is the front door; the rewriter lives at #rewrite. The two halves
// talk through DOM events rather than importing each other, which is what
// lets the single-file build scope each script separately.

function currentView() {
  return location.hash === '#rewrite' ? 'rewriter' : 'research';
}

function showView() {
  const view = currentView();
  document.getElementById('view-research').hidden = view !== 'research';
  document.getElementById('view-rewriter').hidden = view !== 'rewriter';
  document.querySelectorAll('.navlink[data-view]').forEach((link) => {
    const on = link.dataset.view === view;
    link.classList.toggle('current', on);
    if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  document.title = view === 'rewriter' ? 'Humaniser' : 'Humaniser Research';
}
window.addEventListener('hashchange', showView);
showView();

/** The sentence around the cursor, or whatever is selected. */
function sentenceAtCursor() {
  const { value, selectionStart: a, selectionEnd: b } = ui.input;
  if (b > a) return value.slice(a, b).trim();
  const before = value.slice(0, a);
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! '), before.lastIndexOf('\n'));
  const rest = value.slice(a).search(/[.?!](\s|$)|\n/);
  return value.slice(start < 0 ? 0 : start + 1, rest < 0 ? value.length : a + rest + 1).trim();
}

document.getElementById('find-sources').addEventListener('click', () => {
  const text = sentenceAtCursor();
  if (!text) {
    setStatus('Put your cursor in a sentence, or select one, and it will find papers that support it.');
    return;
  }
  location.hash = '#research';
  document.dispatchEvent(new CustomEvent('humaniser:find', { detail: { text } }));
});

// Research hands over findings to be written up. Academic text needs the
// academic rules, so an empty marking guide is filled with them.
document.addEventListener('humaniser:rewrite', (event) => {
  const { text = '', academic = false, citationStyle = '' } = event.detail || {};
  ui.input.value = text;
  ui.input.dispatchEvent(new Event('input'));
  location.hash = '#rewrite';
  if (academic && !state.rubricText) {
    ui.guideText.value = [
      'Formal academic register.',
      'Avoid contractions.',
      'Write in the third person.',
      citationStyle ? `Citations follow ${citationStyle}.` : '',
    ].filter(Boolean).join('\n');
    if (ui.guideBody.hidden) ui.guideToggle.click();
    loadGuide({ text: ui.guideText.value });
  }
  setStatus('Loaded from Research. Citations are kept as they are.');
  window.scrollTo({ top: 0 });
});

loadStatus();
