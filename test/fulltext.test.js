import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readPdf, headingKind, assertPublicUrl, pdfCandidates, fetchFullText, setNetwork } from '../lib/fulltext.js';
import { digest, plainText } from '../lib/insights.js';

const PDF = fs.readFileSync(new URL('./fixtures/paper.pdf', import.meta.url));
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('a PDF becomes sections with page numbers, references dropped', async () => {
  const ft = await readPdf(PDF);
  assert.equal(ft.pages, 3);
  const kinds = ft.sections.map((s) => s.kind);
  assert.deepEqual(kinds, ['front', 'abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion']);
  const methods = ft.sections.find((s) => s.kind === 'methods');
  assert.equal(methods.paragraphs[0].page, 1);
  assert.equal(methods.paragraphs[1].page, 2, 'a paragraph on the next page knows it');
  assert.match(ft.sections.find((s) => s.kind === 'results').paragraphs[0].text, /d = 0\.62, p < \.001/);
  assert.doesNotMatch(plainText(ft), /Why we sleep/, 'the reference list is gone');
});

test('what the model reads from a full text stays within budget', async () => {
  const ft = await readPdf(PDF);
  const d = digest(ft, 1200);
  assert.ok(d.length <= 1400);
  assert.match(d, /^ABSTRACT: /);
  assert.match(d, /RESULTS: Restricted sleep reduced 2-back accuracy/);
});

test('non-PDFs are refused politely', async () => {
  await assert.rejects(readPdf(Buffer.from('<html>not a pdf</html>')), (e) => e.status === 422 && /not a PDF/.test(e.message));
});

test('headings are recognised with or without numbering', () => {
  assert.equal(headingKind('2.1. Materials and Methods'), 'methods');
  assert.equal(headingKind('RESULTS'), 'results');
  assert.equal(headingKind('IV. Discussion'), 'discussion');
  assert.equal(headingKind('Conclusions:'), 'conclusion');
  assert.equal(headingKind('Declaration of competing interest'), 'back');
  assert.equal(headingKind('The results of the first experiment were clear'), null);
});

test('the fetcher refuses private and odd addresses', async () => {
  const lookups = {
    'intranet.local': [{ address: '10.0.0.5' }],
    'metadata.cloud': [{ address: '169.254.169.254' }],
    'v6.local': [{ address: '::1' }],
    'good.org': [{ address: '93.184.216.34' }],
  };
  const lookup = async (host) => lookups[host] || [];
  for (const url of ['http://intranet.local/x.pdf', 'http://metadata.cloud/', 'http://v6.local/', 'http://127.0.0.1/', 'http://[::ffff:192.168.1.1]/']) {
    await assert.rejects(assertPublicUrl(url, lookup), /private network/, url);
  }
  await assert.rejects(assertPublicUrl('file:///etc/passwd', lookup), /Only web addresses/);
  assert.equal((await assertPublicUrl('https://good.org/a.pdf', lookup)).hostname, 'good.org');
});

test('a redirect into a private network is not followed', async (t) => {
  const seen = [];
  setNetwork({
    lookup: async (host) => (host === 'evil.example' ? [{ address: '192.168.0.1' }] : publicDns()),
    fetch: async (url) => {
      seen.push(url);
      return new Response('', { status: 302, headers: { location: 'http://evil.example/admin' } });
    },
  });
  t.after(() => setNetwork());
  await assert.rejects(fetchFullText({ id: 'W7', pdfUrls: ['https://repo.example/p.pdf'] }), /private network/);
  assert.deepEqual(seen, ['https://repo.example/p.pdf'], 'the private hop was never requested');
});

test('a landing page is followed to its citation_pdf_url', async (t) => {
  setNetwork({
    lookup: publicDns,
    fetch: async (url) => {
      if (url === 'https://repo.example/record/1') {
        return new Response('<html><head><meta name="citation_pdf_url" content="/files/1.pdf"></head></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url === 'https://repo.example/files/1.pdf') return new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
      return new Response('', { status: 404 });
    },
  });
  t.after(() => setNetwork());
  const ft = await fetchFullText({ id: 'W8', landingUrls: ['https://repo.example/record/1'] });
  assert.equal(ft.source, 'https://repo.example/files/1.pdf');
  assert.equal(ft.via, 'open access');
});

test('no free copy says to upload', async () => {
  await assert.rejects(fetchFullText({ id: 'W9' }), (e) => e.status === 404 && /upload the PDF/.test(e.message));
});

test('candidates put PDFs first and add arXiv', () => {
  const c = pdfCandidates({ doi: '10.48550/arxiv.2101.00001', pdfUrls: ['https://a.org/x.pdf'], oaUrl: 'https://a.org/x.pdf', landingUrls: ['https://a.org/rec'] });
  assert.deepEqual(c, ['https://a.org/x.pdf', 'https://arxiv.org/pdf/2101.00001', 'https://a.org/rec']);
});
