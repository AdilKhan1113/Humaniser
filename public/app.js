// Front end. No framework and no build step: the browser loads this file as-is.

const el = (id) => document.getElementById(id);

const ui = {
  mode: el('mode'),
  strength: el('strength'),
  effort: el('effort'),
  effortField: el('effort-field'),
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
};

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

async function loadStatus() {
  try {
    const status = await fetch('/api/status').then((r) => r.json());
    state.status = status;

    if (status.claude.keyInEnv) {
      ui.engineNote.textContent = `Claude mode ready with ${status.claude.model}. `
        + 'Offline rules need no key and never leave this machine.';
    } else {
      // Nothing to gain from letting someone pick an engine that cannot run.
      const claudeOption = ui.mode.querySelector('option[value="claude"]');
      claudeOption.disabled = true;
      claudeOption.textContent = 'Claude (needs an API key)';
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

    const row = document.createElement('div');
    row.className = 'sub';
    row.innerHTML = `
      <span class="sub-name">${label}</span>
      <span class="sub-track"><span class="sub-bar" style="width:${value}%"></span></span>
      <span class="sub-value">${value}</span>`;

    const tip = was == null
      ? `${label}: ${value} of 100. ${SUBSCORE_HELP[key]}`
      : `${label}: ${was} → ${value}. ${SUBSCORE_HELP[key]}`;
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
    ui.changes.innerHTML = '<p class="placeholder">Claude rewrites whole sentences, so there is no line-by-line list. Switch to the offline engine to see every edit.</p>';
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
    const { report } = await postJson('/api/analyze', { text });
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
  const result = await postJson('/api/humanise', { text, strength: ui.strength.value });
  state.baseline = result.before;
  state.changes = result.changes;
  showOutput(result.text);
  renderDashboard(result.after, result.before);
  setStatus(result.changes.length
    ? `${result.changes.length} edit${result.changes.length === 1 ? '' : 's'} applied by the offline engine.`
    : 'The rules found nothing to change. Try the Claude engine for a real rewrite.');
}

async function runClaude(text) {
  const res = await fetch('/api/humanise/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      strength: ui.strength.value,
      effort: ui.effort.value,
    }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Claude mode could not start.');
  }

  state.changes = [];
  ui.output.textContent = '';
  ui.output.classList.add('streaming');
  setStatus('Claude is reading…');

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
        setStatus('Claude is working out the rhythm…');
      } else if (event.type === 'delta') {
        rewritten += event.text;
        ui.output.textContent = rewritten;
        ui.outCount.textContent = `${wordCount(rewritten).toLocaleString()} words`;
      } else if (event.type === 'done') {
        showOutput(rewritten.trim());
        renderDashboard(event.report, state.baseline);
        const bits = [`${event.usage.output.toLocaleString()} tokens out`];
        if (event.usage.cacheRead) bits.push(`${event.usage.cacheRead.toLocaleString()} cached`);
        if (event.fallbackUsed) bits.push('served by a fallback model');
        if (event.truncated) bits.push('output hit the token ceiling, so it may be cut short');
        setStatus(`Done with ${event.model}. ${bits.join(' · ')}.`);
      } else if (event.type === 'error') {
        failure = event.message;
      }
    }
  }

  ui.output.classList.remove('streaming');
  if (failure) throw new Error(failure);
  if (!rewritten.trim()) throw new Error('Claude returned nothing.');
}

async function run() {
  const text = ui.input.value;
  if (!text.trim()) { setStatus('Paste some text first.', true); return; }

  setBusy(true, 'Working…');
  try {
    // Score the original first, so the dashboard can show the change.
    if (!state.baseline || state.baseline.counts.characters !== text.length) {
      const { report } = await postJson('/api/analyze', { text });
      state.baseline = report;
    }
    if (ui.mode.value === 'claude') {
      await runClaude(text);
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
  const claude = ui.mode.value === 'claude';
  ui.effortField.hidden = !claude;
  if (claude && state.status && !state.status.claude.keyInEnv) {
    setStatus('No API key in the environment. Add one to .env and restart, or stay on the offline engine.', true);
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

loadStatus();
