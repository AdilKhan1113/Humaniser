#!/usr/bin/env node
// A small local web server. No framework, so `npm install` only ever has to
// fetch the Anthropic SDK and PDF.js, and the offline half of the app works
// even if that fails: both are loaded on first use.

// First, so that anything reading process.env at import time sees the .env file.
import './lib/env.js';

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from './lib/analyze.js';
import { humanise, PROFILES } from './lib/rules.js';
import { parseRubric, checkAgainstRubric } from './lib/rubric.js';
import { extractDocxText } from './lib/docx.js';
import { rewrite, hasKey, providerStatus, listModels } from './lib/provider.js';
import {
  searchWorks, getWork, connectedWorks, similarWorks, identifyPaper, findDoi,
} from './lib/scholar.js';
import { topicTerms } from './lib/keywords.js';
import {
  SYNTHESIS_SYSTEM, MAX_SYNTHESIS_PAPERS, buildSynthesisMessage, parseSynthesis, digest, plainText,
  SCAN_SYSTEM, buildScanMessage, parseScan, ASK_SYSTEM, buildAskMessage,
} from './lib/insights.js';
import { readPdf, fetchFullText } from './lib/fulltext.js';
import {
  paraphraseOffline, PARAPHRASE_SYSTEM, buildParaphraseMessage, parseModelVariants,
} from './lib/paraphrase.js';
import {
  ACCESS_CODE, clientKey, takeToken, sweepBuckets, accessCodeAccepted, limitsForStatus,
} from './lib/guard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = 1_000_000; // 1 MB of prose is roughly 160,000 words
const MAX_TEXT = 200_000;

// Pure modules the browser imports as-is, so the reference list and the
// overlap check run the same code on both sides. An allowlist, not a directory.
const SHARED = {
  '/shared/cite.js': path.join(here, 'lib', 'cite.js'),
  '/shared/overlap.js': path.join(here, 'lib', 'overlap.js'),
  '/shared/sentences.js': path.join(here, 'lib', 'sentences.js'),
  '/shared/insights.js': path.join(here, 'lib', 'insights.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        // Reject first so the route can answer with a 413, then stop reading.
        // Destroying the socket immediately gave the client a connection reset
        // instead of a reason.
        reject(Object.assign(new Error('That text is too long for one request.'), { status: 413 }));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The raw bytes of a request, for uploads. Its own cap, far above the JSON one. */
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > max) {
        aborted = true;
        reject(Object.assign(new Error(`That file is over ${Math.round(max / 1048576)} MB.`), { status: 413 }));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MAX_UPLOAD = 30 * 1024 * 1024;

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('The request body was not valid JSON.'), { status: 400 });
  }
}

function requireText(payload) {
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text.trim()) {
    throw Object.assign(new Error('Send some text to work on.'), { status: 400 });
  }
  if (text.length > MAX_TEXT) {
    throw Object.assign(
      new Error(`That is ${text.length.toLocaleString()} characters. The limit is ${MAX_TEXT.toLocaleString()}; try a section at a time.`),
      { status: 413 },
    );
  }
  return text;
}

async function serveStatic(req, res, pathname) {
  if (SHARED[pathname]) {
    const data = await fs.readFile(SHARED[pathname]);
    res.writeHead(200, { 'content-type': MIME['.js'], 'content-length': data.length, 'cache-control': 'no-cache' });
    res.end(data);
    return;
  }
  // Both tools are one page now; the old address still lands on Research.
  if (pathname === '/research' || pathname === '/research.html') {
    res.writeHead(302, { location: '/#research', 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const wanted = pathname === '/' ? '/index.html' : pathname;
  // Resolve, then confirm the result is still inside public/, which is what
  // stops "/../../etc/passwd" from ever being read.
  const target = path.join(PUBLIC_DIR, path.normalize(wanted));
  if (!target.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Nope.' });
    return;
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: `Not found: ${wanted}` });
  }
}

/** Streams the model's rewrite to the browser as server-sent events. */
async function streamRewrite(req, res, payload) {
  const text = requireText(payload);
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let rewritten = '';
  try {
    const rubricText = typeof payload.rubricText === 'string' ? payload.rubricText : '';
    const rubric = rubricText.trim() ? parseRubric(rubricText) : null;
    const constraints = (rubric && rubric.constraints) || {};
    const options = {
      text,
      strength: payload.strength,
      effort: payload.effort,
      audience: typeof payload.audience === 'string' ? payload.audience : '',
      notes: typeof payload.notes === 'string' ? payload.notes : '',
      rubric,
      rubricText,
      model: typeof payload.model === 'string' ? payload.model : undefined,
    };
    for await (const event of rewrite(options, controller.signal)) {
      if (event.type === 'delta') rewritten += event.text;
      if (event.type === 'done') {
        const finished = rewritten.trim();
        send({
          ...event,
          report: analyze(finished, { constraints }),
          rubricChecks: rubric ? checkAgainstRubric(finished, rubric) : null,
        });
      } else {
        send(event);
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      res.end();
      return;
    }
    send({ type: 'error', code: error.code || 'UNKNOWN', message: error.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/** The access code and hourly allowance every model call has to clear. Throws when it does not. */
function admitModelCall(req, res, payload) {
  const who = clientKey(req);
  // The code is checked before anything reaches the API, so a wrong one costs
  // nothing, and it is counted against its own allowance so that guessing
  // cannot exhaust the owner's model budget.
  if (!accessCodeAccepted(req.headers['x-access-code'] || payload.accessCode)) {
    const attempts = takeToken(who, 'auth');
    if (!attempts.ok) res.setHeader('retry-after', String(attempts.retryAfter));
    throw Object.assign(
      new Error('That access code is not right. Model rewrites are limited to whoever runs this server.'),
      { status: attempts.ok ? 401 : 429 },
    );
  }
  const allowance = takeToken(who, 'claude');
  if (!allowance.ok) {
    res.setHeader('retry-after', String(allowance.retryAfter));
    throw Object.assign(
      new Error('Hourly limit reached for model rewrites. The offline engine has no limit worth hitting.'),
      { status: 429 },
    );
  }
}

/** Streams model paraphrases, then sends them split and scored for overlap. */
async function streamParaphrase(req, res, payload, text) {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  let reply = '';
  try {
    const options = {
      text,
      effort: 'low',
      system: PARAPHRASE_SYSTEM,
      userMessage: buildParaphraseMessage({
        text,
        context: typeof payload.context === 'string' ? payload.context : '',
        discipline: typeof payload.discipline === 'string' ? payload.discipline : '',
      }),
    };
    for await (const event of rewrite(options, controller.signal)) {
      if (event.type === 'delta') { reply += event.text; send(event); }
      if (event.type === 'done') send({ ...event, variants: parseModelVariants(text, reply) });
    }
  } catch (error) {
    if (controller.signal.aborted) { res.end(); return; }
    send({ type: 'error', code: error.code || 'UNKNOWN', message: error.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/** Runs one model call to completion and returns its text. Provider errors become HTTP ones. */
async function modelText(options, signal) {
  let reply = '';
  try {
    for await (const event of rewrite(options, signal)) {
      if (event.type === 'delta') reply += event.text;
    }
  } catch (error) {
    throw Object.assign(new Error(error.message), { status: error.status || (error.code === 'NO_CREDENTIALS' ? 503 : 502) });
  }
  return reply;
}

/** Opens a server-sent event stream and returns a sender for it. */
function openStream(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  return (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
}

const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

const bool = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : !/^(0|false|no|off)$/i.test(String(v)));

/** A light copy of a work: what the model reads, and nothing the browser could inflate. */
function paperForModel(w) {
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const urls = (v) => (Array.isArray(v) ? v.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 4).map((u) => u.slice(0, 1000)) : []);
  return {
    id: text(w?.id, 80),
    doi: text(w?.doi, 200),
    oaUrl: urls([w?.oaUrl])[0] || null,
    pdfUrls: urls(w?.pdfUrls),
    landingUrls: urls(w?.landingUrls),
    fulltext: text(w?.fulltext, 9000) || null,
    title: text(w?.title, 400),
    year: Number.isInteger(w?.year) ? w.year : null,
    venue: text(w?.venue, 200),
    abstract: text(w?.abstract, 1800),
    authors: Array.isArray(w?.authors) ? w.authors.slice(0, 3).map((a) => ({ family: text(a?.family || a?.name, 80) })) : [],
  };
}

const researchRoutes = {
  // A cited answer across the top papers, with each paper's stance and study
  // details. One model call, answered as JSON.
  'POST /api/research/synthesize': async (req, res) => {
    const payload = await readJson(req);
    const question = typeof payload.question === 'string' ? payload.question.trim() : '';
    if (!question) throw Object.assign(new Error('Ask a question to answer.'), { status: 400 });
    if (question.length > 1000) throw Object.assign(new Error('Keep the question to a sentence or two.'), { status: 413 });
    const works = (Array.isArray(payload.works) ? payload.works : []).slice(0, MAX_SYNTHESIS_PAPERS).map(paperForModel)
      .filter((w) => w.id && w.title);
    if (!works.length) throw Object.assign(new Error('Search first: the answer is built from the papers found.'), { status: 400 });
    admitModelCall(req, res, payload);

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    // Read the free full texts the browser does not already have. Four at a
    // time, and whatever is not in within 45 seconds stays on its abstract.
    if (payload.readFullText) {
      const todo = works.filter((w) => !w.fulltext && (w.pdfUrls.length || w.oaUrl || w.landingUrls.length));
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
      let next = 0;
      const worker = async () => {
        while (next < todo.length && !deadline.aborted) {
          const w = todo[next++];
          try { w.fulltext = digest(await fetchFullText(w, deadline)); } catch { /* abstract it is */ }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    }
    let reply = '';
    try {
      for await (const event of rewrite({
        text: question,
        effort: 'low',
        system: SYNTHESIS_SYSTEM,
        userMessage: buildSynthesisMessage(question, works),
      }, controller.signal)) {
        if (event.type === 'delta') reply += event.text;
      }
    } catch (error) {
      // Provider errors carry a code, not an HTTP status. A missing key is the
      // server's configuration; anything else is the upstream API.
      throw Object.assign(new Error(error.message), { status: error.status || (error.code === 'NO_CREDENTIALS' ? 503 : 502) });
    }
    sendJson(res, 200, parseSynthesis(reply, works));
  },


  // A word, a question, a sentence from a draft, or a DOI.
  'GET /api/research/search': async (req, res, url) => {
    const p = url.searchParams;
    sendJson(res, 200, await searchWorks({
      q: p.get('q') || '',
      mode: p.get('mode') || 'auto',
      sort: p.get('sort') || 'relevance',
      peerReviewed: bool(p.get('peerReviewed'), true),
      openAccess: bool(p.get('openAccess'), false),
      fromYear: p.get('fromYear'),
      toYear: p.get('toYear'),
      minCitations: p.get('minCitations'),
      page: p.get('page'),
      perPage: p.get('perPage'),
    }));
  },

  // The free full text of one paper, found through the index and read here.
  'GET /api/research/fulltext': async (req, res, url) => {
    const work = await getWork(url.searchParams.get('id') || '');
    const ft = await fetchFullText(work);
    sendJson(res, 200, { id: work.id, ...ft });
  },

  // A PDF the researcher has access to. Read and returned, never kept.
  // With ?identify=1 it also finds the paper's record in the index, by the
  // DOI printed in it or by its title, and the phrases it is about.
  'POST /api/research/fulltext/upload': async (req, res, url) => {
    const bytes = await readRaw(req, MAX_UPLOAD);
    if (!bytes.length) throw Object.assign(new Error('Send the PDF as the request body.'), { status: 400 });
    const ft = await readPdf(bytes);
    if (url.searchParams.get('identify') !== '1') {
      sendJson(res, 200, { ...ft, via: 'upload' });
      return;
    }
    const text = plainText(ft);
    const front = ft.sections.find((x) => x.kind === 'front')?.paragraphs.map((p) => p.text) || [];
    const work = await identifyPaper({ doi: findDoi(text), titles: [ft.title, front[0]] }).catch(() => null);
    sendJson(res, 200, { ...ft, via: 'upload', work, terms: topicTerms(text, 6) });
  },

  // Papers on the same topic as one paper, indexed or uploaded.
  'POST /api/research/similar': async (req, res) => {
    const payload = await readJson(req);
    let work = null;
    if (typeof payload.id === 'string' && /^W\d+$/i.test(payload.id)) work = await getWork(payload.id);
    else if (payload.work && typeof payload.work === 'object') {
      work = {
        id: clip(payload.work.id, 80), doi: clip(payload.work.doi, 200), title: clip(payload.work.title, 400),
        abstract: clip(payload.work.abstract, 4000),
        keywords: Array.isArray(payload.work.keywords) ? payload.work.keywords.slice(0, 8).map((k) => clip(k, 80)) : [],
      };
    }
    sendJson(res, 200, await similarWorks({
      work,
      text: clip(payload.text, 60000),
      terms: Array.isArray(payload.terms) ? payload.terms.slice(0, 6).map((t) => clip(t, 80)).filter(Boolean) : null,
      peerReviewed: bool(payload.peerReviewed, true),
    }));
  },

  // The model reads one whole paper: summary, findings, limitations, topics, next searches.
  'POST /api/research/scan': async (req, res) => {
    const payload = await readJson(req);
    const text = clip(payload.text, 150000);
    if (text.trim().length < 200) throw Object.assign(new Error('Not enough of the paper to scan.'), { status: 400 });
    admitModelCall(req, res, payload);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const reply = await modelText({
      text: 'scan', effort: 'low', system: SCAN_SYSTEM, userMessage: buildScanMessage({ title: clip(payload.title, 400), text }),
    }, controller.signal);
    sendJson(res, 200, parseScan(reply));
  },

  // A question about one paper, answered from its text and streamed.
  'POST /api/research/ask': async (req, res) => {
    const payload = await readJson(req);
    const question = clip(payload.question, 1000).trim();
    const text = clip(payload.text, 150000);
    if (!question) throw Object.assign(new Error('Ask a question about the paper.'), { status: 400 });
    if (text.trim().length < 100) throw Object.assign(new Error('There is no text of this paper to answer from.'), { status: 400 });
    admitModelCall(req, res, payload);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const paper = payload.paper && typeof payload.paper === 'object' ? {
      title: clip(payload.paper.title, 400),
      year: Number.isInteger(payload.paper.year) ? payload.paper.year : null,
      authors: Array.isArray(payload.paper.authors) ? payload.paper.authors.slice(0, 4).map((a) => ({ family: clip(a?.family || a?.name, 80) })) : [],
    } : {};
    const send = openStream(res);
    try {
      for await (const event of rewrite({
        text: question, effort: 'low', system: ASK_SYSTEM,
        userMessage: buildAskMessage({ paper, text, history: payload.history, question }),
      }, controller.signal)) {
        if (event.type === 'delta') send({ type: 'delta', text: event.text });
        if (event.type === 'done') send({ type: 'done' });
      }
    } catch (error) {
      if (!controller.signal.aborted) send({ type: 'error', message: error.message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  },

  'GET /api/research/work': async (req, res, url) => {
    sendJson(res, 200, { work: await getWork(url.searchParams.get('id') || '') });
  },

  // related | citing | references
  'GET /api/research/connected': async (req, res, url) => {
    const p = url.searchParams;
    sendJson(res, 200, await connectedWorks(p.get('id') || '', p.get('kind') || 'related', {
      peerReviewed: bool(p.get('peerReviewed'), false),
      perPage: p.get('perPage'),
      sort: p.get('sort'),
    }));
  },

  'POST /api/research/paraphrase': async (req, res) => {
    const payload = await readJson(req);
    const text = requireText(payload);
    if (text.length > 4000) {
      throw Object.assign(new Error('Paraphrase a sentence or a short passage at a time, not a whole section.'), { status: 413 });
    }
    if (payload.engine === 'model') {
      admitModelCall(req, res, payload);
      await streamParaphrase(req, res, payload, text);
      return;
    }
    sendJson(res, 200, paraphraseOffline(text));
  },
};

const routes = {
  ...researchRoutes,

  'GET /api/status': async (req, res) => {
    sendJson(res, 200, {
      offline: true,
      // Named `model` rather than `claude`: which provider is in play depends
      // on which key is set.
      model: {
        ...providerStatus(),
        // Whether a code is needed, never the code itself.
        accessCodeRequired: Boolean(ACCESS_CODE),
      },
      limits: limitsForStatus(),
      profiles: Object.entries(PROFILES).map(([id, p]) => ({
        id,
        label: p.label,
        description: p.description,
      })),
    });
  },

  'POST /api/analyze': async (req, res) => {
    const payload = await readJson(req);
    const text = requireText(payload);
    const constraints = payload.constraints || {};
    sendJson(res, 200, { report: analyze(text, { constraints }) });
  },

  // Reads a marking guide. Takes plain text, or a base64 .docx the browser
  // could not open itself.
  'POST /api/rubric': async (req, res) => {
    const payload = await readJson(req);
    let text = typeof payload.text === 'string' ? payload.text : '';

    if (!text && typeof payload.docxBase64 === 'string') {
      const bytes = Buffer.from(payload.docxBase64, 'base64');
      if (bytes.length > 12_000_000) {
        throw Object.assign(new Error('That file is too large.'), { status: 413 });
      }
      try {
        text = await extractDocxText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      } catch (error) {
        throw Object.assign(new Error(error.message), { status: 400 });
      }
    }
    if (!text.trim()) {
      throw Object.assign(new Error('Send the guide as text, or as a .docx.'), { status: 400 });
    }
    if (text.length > MAX_TEXT) {
      throw Object.assign(new Error('That guide is too long to read.'), { status: 413 });
    }
    sendJson(res, 200, { rubric: parseRubric(text), text });
  },

  'POST /api/humanise': async (req, res) => {
    const payload = await readJson(req);
    const text = requireText(payload);
    const constraints = payload.constraints || {};
    const result = humanise(text, { strength: payload.strength, constraints });
    sendJson(res, 200, {
      text: result.text,
      changes: result.changes,
      byRule: result.byRule,
      profile: result.profile,
      before: analyze(text, { constraints }),
      after: analyze(result.text, { constraints }),
    });
  },

  // Which models the configured key can actually reach. Gemini's version
  // numbers move, so this beats trusting a hardcoded list.
  'GET /api/models': async (req, res) => {
    if (!hasKey()) {
      sendJson(res, 200, { models: [], reason: 'no API key is set' });
      return;
    }
    try {
      sendJson(res, 200, { models: await listModels() });
    } catch (error) {
      sendJson(res, 200, { models: [], reason: error.message });
    }
  },

  'POST /api/humanise/model': async (req, res) => {
    const payload = await readJson(req);
    admitModelCall(req, res, payload);
    await streamRewrite(req, res, payload);
  },
};

// The route was /api/humanise/claude before there was more than one provider.
routes['POST /api/humanise/claude'] = routes['POST /api/humanise/model'];

const server = http.createServer(async (req, res) => {
  try {
    // Parsed inside the try. A request for "//" or a junk Host header makes
    // new URL throw, and out here that became an unhandled rejection, which
    // ends the process — one malformed request would take the whole site down.
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || HOST}`);
    } catch {
      sendJson(res, 400, { error: 'That request line is not a valid URL.' });
      return;
    }
    const key = `${req.method} ${url.pathname}`;

    // Hosts poll this to decide whether the instance is alive.
    if (key === 'GET /healthz') {
      sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
      return;
    }

    // Every API route is flood-limited. Model rewrites then count separately,
    // inside its own handler and only once the access code has passed.
    if (url.pathname.startsWith('/api/')) {
      const allowance = takeToken(clientKey(req), 'offline');
      if (!allowance.ok) {
        res.setHeader('retry-after', String(allowance.retryAfter));
        throw Object.assign(
          new Error('Too many requests. Wait a minute and try again.'),
          { status: 429 },
        );
      }
    }

    if (routes[key]) {
      await routes[key](req, res, url);
      return;
    }
    if (req.method === 'GET') {
      await serveStatic(req, res, url.pathname);
      return;
    }
    sendJson(res, 404, { error: `No route for ${key}` });
  } catch (error) {
    if (res.writableEnded) return;
    const status = error.status || 500;
    if (status >= 500) console.error('[humaniser]', error);
    sendJson(res, status, { error: error.message || 'Something broke.' });
  }
});

/** Ports get taken. Walk forward a few rather than dying on startup. */
function listen(port, attemptsLeft = 10) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} is busy, trying ${port + 1}…`);
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error('Could not start the server:', error.message);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    const limits = limitsForStatus();
    console.log('');
    console.log('  Humaniser is running');
    console.log(`  http://${shown}:${port}`);
    console.log(`  Research opens first. The rewriter is at http://${shown}:${port}/#rewrite`);
    console.log('');
    const provider = providerStatus();
    console.log('  Offline rules engine: ready');
    console.log(`  Model mode:           ${provider.keyInEnv
      ? `ready — ${provider.label} (${provider.model})`
      : 'no API key found, offline mode still works'}`);

    if (HOST === '0.0.0.0') {
      console.log('');
      console.log('  Reachable from the network.');
      if (provider.keyInEnv && !ACCESS_CODE) {
        console.log('  WARNING: an API key is set but HUMANISER_ACCESS_CODE is not.');
        console.log('           Anyone who reaches this URL can spend your API credit.');
        console.log('           Set HUMANISER_ACCESS_CODE to a shared secret and restart.');
      } else if (ACCESS_CODE) {
        console.log(`  ${provider.label || 'Model'} mode is behind an access code.`);
      }
      console.log(`  Hourly limits per client: ${limits.claude} model, ${limits.offline} offline.`);
    }
    console.log('');
    console.log('  Press Control-C to stop.');
    console.log('');
  });
}

const sweeper = setInterval(() => sweepBuckets(), 10 * 60 * 1000);
sweeper.unref();

// A safety net, not an excuse. Every handler catches its own errors; this keeps
// a missed one from ending a running deployment.
process.on('unhandledRejection', (reason) => {
  console.error('[humaniser] unhandled rejection:', reason);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

listen(BASE_PORT);
