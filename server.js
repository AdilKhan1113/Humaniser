#!/usr/bin/env node
// A small local web server. No framework, so `npm install` only ever has to
// fetch the Anthropic SDK, and the offline half of the app works even if that
// fails.

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
import { rewriteWithClaude, hasApiKeyInEnv, MODEL, EFFORT_LEVELS } from './lib/claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = 1_000_000; // 1 MB of prose is roughly 160,000 words
const MAX_TEXT = 200_000;

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
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('That text is too long for one request.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

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

/** Streams the Claude rewrite to the browser as server-sent events. */
async function streamClaude(req, res, payload) {
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
    };
    for await (const event of rewriteWithClaude(options, controller.signal)) {
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

const routes = {
  'GET /api/status': async (req, res) => {
    sendJson(res, 200, {
      offline: true,
      claude: {
        model: MODEL,
        keyInEnv: hasApiKeyInEnv(),
        efforts: EFFORT_LEVELS,
      },
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

  'POST /api/humanise/claude': async (req, res) => {
    const payload = await readJson(req);
    await streamClaude(req, res, payload);
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    if (routes[key]) {
      await routes[key](req, res);
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
    const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`;
    console.log('');
    console.log('  Humaniser is running');
    console.log(`  ${url}`);
    console.log('');
    console.log(`  Offline rules engine: ready`);
    console.log(`  Claude mode:          ${hasApiKeyInEnv() ? `ready (${MODEL})` : 'no API key found, offline mode still works'}`);
    console.log('');
    console.log('  Press Control-C to stop.');
    console.log('');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

listen(BASE_PORT);
