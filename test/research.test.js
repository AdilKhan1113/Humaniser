import test from 'node:test';
import assert from 'node:assert/strict';

import { toQuery, detectMode, contentTerms } from '../lib/keywords.js';
import { splitSentences } from '../lib/sentences.js';
import { overlap, longestSharedRun } from '../lib/overlap.js';
import { paraphraseOffline, parseModelVariants, buildParaphraseMessage } from '../lib/paraphrase.js';
import { inText, reference, referenceList, arrange, bibtex, ris, initials } from '../lib/cite.js';
import {
  rebuildAbstract, normaliseOpenAlex, normaliseCrossref, splitName, buildFilter, bareDoi,
  searchWorks, getWork, connectedWorks, setFetch,
} from '../lib/scholar.js';
import {
  extractStudy, keyFinding, parseSynthesis, buildSynthesisMessage, studiesCsv, strongestFinding,
} from '../lib/insights.js';
import { WORKS } from './fixtures/openalex.js';

// ---------------------------------------------------------------- query

test('a question becomes its content words', () => {
  const q = toQuery('What is the effect of sleep deprivation on working memory in adolescents?');
  assert.equal(q.mode, 'question');
  assert.deepEqual(q.terms, ['sleep', 'deprivation', 'working', 'memory', 'adolescents']);
});

test('keywords pass through untouched', () => {
  const q = toQuery('microplastics freshwater');
  assert.equal(q.mode, 'keywords');
  assert.equal(q.search, 'microplastics freshwater');
});

test('a sentence keeps quoted phrases whole and drops citations', () => {
  const q = toQuery('Regular exercise reduces "depressive symptoms" in older adults (Smith, 2020).');
  assert.equal(q.mode, 'sentence');
  assert.match(q.search, /^"depressive symptoms" /);
  assert.ok(!q.terms.includes('Smith'));
  assert.ok(q.terms.includes('reduces') || q.terms.includes('exercise'));
});

test('mode detection and acronyms', () => {
  assert.equal(detectMode('Does caffeine help?'), 'question');
  assert.equal(detectMode('CRISPR'), 'keywords');
  assert.deepEqual(contentTerms('the role of AI in EU law'), ['AI', 'EU', 'law']);
});

// ---------------------------------------------------------------- sentences

test('sentences split on real endings only', () => {
  const parts = splitSentences('Accuracy fell (d = 0.62). Smith et al. 2019 disagreed, e.g. Fig. 2. The U.S. sample was small. 42 took part.');
  assert.deepEqual(parts, [
    'Accuracy fell (d = 0.62).',
    'Smith et al. 2019 disagreed, e.g. Fig. 2.',
    'The U.S. sample was small.',
    '42 took part.',
  ]);
});

test('no text is ever lost in splitting', () => {
  const text = 'Values were 1.5 and 2.25 respectively. Then p < .05 held. Done';
  assert.equal(splitSentences(text).join(' '), text);
});

// ---------------------------------------------------------------- overlap

test('a copied sentence is too close, a rewrite is not', () => {
  const src = 'Sleep restriction significantly reduced accuracy on the working memory task.';
  assert.equal(overlap(src, src).verdict, 'too-close');
  const fresh = overlap(src, 'Accuracy dropped markedly once participants had less sleep, according to the working-memory results.');
  assert.equal(fresh.verdict, 'fresh');
});

test('shared glue does not count as copying', () => {
  assert.equal(longestSharedRun('results of the trial', 'effects of the drug').length, 0);
  assert.equal(longestSharedRun('reduced working memory accuracy', 'lower working memory accuracy').text, 'working memory accuracy');
});

// ---------------------------------------------------------------- paraphrase

test('offline paraphrase changes structure and attribution', () => {
  const { variants } = paraphraseOffline('We found that sleep restriction significantly reduced accuracy compared to controls.');
  assert.ok(variants.length >= 2);
  const best = variants[0];
  assert.doesNotMatch(best.text, /\bwe\b/i, 'first person must become the authors');
  assert.match(best.text, /the authors/i);
  assert.ok(best.overlap.score < 100);
  for (const v of variants) assert.ok(v.overlap && typeof v.overlap.score === 'number');
});

test('paraphrase keeps numbers and statistics', () => {
  const { variants } = paraphraseOffline('We found that accuracy fell (d = 0.62, p < .01) in 84 students.');
  for (const v of variants) {
    assert.match(v.text, /d = 0\.62/);
    assert.match(v.text, /p < \.01/);
    assert.match(v.text, /84/);
  }
});

test('paraphrase never produces "is rose"', () => {
  const { variants } = paraphraseOffline('Hippocampal replay is increased during slow-wave sleep.');
  for (const v of variants) assert.doesNotMatch(v.text, /\bis (rose|fell|showed)\b/);
});

test('model replies split into three scored variants', () => {
  const reply = 'First version of the idea here.\n\nSecond version of the idea here.\n\n3. Third version of the idea here.';
  const out = parseModelVariants('Original idea sentence here.', reply);
  assert.equal(out.length, 3);
  assert.equal(out[2].text, 'Third version of the idea here.');
  assert.ok(out[0].overlap);
  assert.match(buildParaphraseMessage({ text: 'x y z', discipline: 'ecology' }), /ecology[\s\S]*<passage>/);
});

// ---------------------------------------------------------------- citations

const okafor = normaliseOpenAlex(WORKS[0]);
const natarajan = normaliseOpenAlex(WORKS[1]);
const vdb = normaliseOpenAlex(WORKS[2]);

test('APA reference and in-text', () => {
  assert.equal(
    reference(natarajan, 'apa').text,
    'Natarajan, P., & Whitfield, J. O. (2021). Chronic short sleep and executive function across adolescence: a longitudinal cohort study. Developmental Psychology, 57(2), 301–315. https://doi.org/10.1037/dev0000987',
  );
  assert.match(reference(natarajan, 'apa').html, /<i>Developmental Psychology<\/i>, <i>57<\/i>\(2\)/);
  assert.equal(inText(okafor, 'apa'), '(Okafor et al., 2019)');
  assert.equal(inText(natarajan, 'apa', { page: '12-14' }), '(Natarajan & Whitfield, 2021, pp. 12–14)');
  assert.equal(inText(natarajan, 'apa', { narrative: true }), 'Natarajan & Whitfield (2021)');
  assert.equal(inText([vdb, okafor], 'apa'), '(Okafor et al., 2019; van den Berg, 2020)');
});

test('MLA, Chicago, Harvard', () => {
  assert.equal(inText(okafor, 'mla', { page: '114' }), '(Okafor et al. 114)');
  assert.match(reference(natarajan, 'mla').text, /^Natarajan, Priya, and James O\. Whitfield\. “Chronic/);
  assert.equal(inText(okafor, 'chicago', { page: '114' }), '(Okafor, de la Cruz, and Lin 2019, 114)');
  assert.equal(inText(okafor, 'harvard'), '(Okafor, de la Cruz and Lin, 2019)');
  assert.match(reference(natarajan, 'harvard').text, /^Natarajan, P\. and Whitfield, J\.O\. \(2021\) ‘Chronic/);
});

test('numeric styles number by the list order', () => {
  const lib = [okafor, natarajan, vdb];
  assert.equal(inText(natarajan, 'ieee', { library: lib }), '[2]');
  assert.equal(inText([okafor, natarajan, vdb], 'ieee', { library: lib }), '[1]–[3]');
  assert.equal(inText(vdb, 'ieee', { library: lib, page: '4' }), '[3, p. 4]');
  assert.equal(inText([okafor, vdb], 'vancouver', { library: lib }), '(1,3)');
  assert.match(referenceList(lib, 'ieee')[0].text, /^\[1\] H\. R\. Okafor, T\. de la Cruz, and M\. Lin, “Sleep/);
  assert.match(referenceList(lib, 'vancouver')[2].text, /^3\. van den Berg L\. Slow-wave/);
});

test('same author, same year gets 2019a and 2019b', () => {
  const second = { ...okafor, id: 'W9', title: 'A follow-up study' };
  const lib = [okafor, second];
  const labels = arrange(lib, 'apa').map((e) => e.suffix);
  assert.deepEqual(labels, ['a', 'b']);
  assert.equal(inText(okafor, 'apa', { library: lib }), '(Okafor et al., 2019b)');
});

test('author-date lists sort alphabetically with particles', () => {
  const list = referenceList([vdb, okafor, natarajan], 'apa').map((r) => r.text.slice(0, 8));
  assert.deepEqual(list, ['Natarajan'.slice(0, 8), 'Okafor, '.slice(0, 8), 'van den '.slice(0, 8)]);
});

test('missing data degrades gracefully', () => {
  const bare = { id: 'x', title: 'An anonymous report', authors: [], year: null };
  assert.equal(inText(bare, 'apa'), '(“An anonymous report”, n.d.)');
  assert.match(reference(bare, 'apa').text, /^An anonymous report\. \(n\.d\.\)\./);
  assert.equal(initials('Jean-Paul'), 'J.-P.');
});

test('BibTeX and RIS', () => {
  const bib = bibtex([okafor, natarajan]);
  assert.match(bib, /@article\{okafor2019sleep,/);
  assert.match(bib, /pages = \{112--120\}/);
  assert.match(bib, /author = \{Okafor, Hannah R\. and de la Cruz, Tomás and Lin, Mei\}/);
  const r = ris([okafor]);
  assert.match(r, /^TY {2}- JOUR/);
  assert.match(r, /SP {2}- 112\nEP {2}- 120/);
  assert.match(r, /ER {2}-$/);
});

// ---------------------------------------------------------------- scholar

test('OpenAlex abstracts are rebuilt in order', () => {
  assert.equal(rebuildAbstract({ world: [1], Hello: [0], again: [3], ',': [2] }), 'Hello world, again');
});

test('OpenAlex records normalise', () => {
  assert.equal(okafor.id, 'W1001');
  assert.equal(okafor.doi, '10.1016/j.sleep.2019.04.012');
  assert.equal(okafor.pages, '112–120');
  assert.equal(okafor.peerReviewed, true);
  assert.equal(okafor.authors[1].family, 'de la Cruz');
  assert.match(okafor.abstract, /^We examined whether/);
  assert.deepEqual(okafor.related, ['W1002', 'W1003']);
});

test('Crossref records normalise', () => {
  const w = normaliseCrossref({
    DOI: '10.5555/ABC', title: ['A <i>new</i> thing'], type: 'journal-article',
    author: [{ given: 'Ada', family: 'Lovelace' }], issued: { 'date-parts': [[2024, 3]] },
    'container-title': ['Journal of Things'], volume: '4', page: '10-19', 'is-referenced-by-count': 3,
  });
  assert.equal(w.doi, '10.5555/abc');
  assert.equal(w.title, 'A new thing');
  assert.equal(w.year, 2024);
  assert.equal(w.pages, '10–19');
  assert.equal(w.peerReviewed, true);
});

test('names split with particles', () => {
  assert.deepEqual(splitName('Ludwig van Beethoven'), { family: 'van Beethoven', given: 'Ludwig' });
  assert.deepEqual(splitName('Curie, Marie'), { family: 'Curie', given: 'Marie' });
  assert.equal(bareDoi('https://doi.org/10.1000/XYZ'), '10.1000/xyz');
});

test('filters encode the controls', () => {
  const f = buildFilter({ peerReviewed: true, openAccess: true, fromYear: '2015', minCitations: '10' });
  assert.match(f, /type:article\|review/);
  assert.match(f, /primary_location\.source\.type:journal/);
  assert.match(f, /is_oa:true/);
  assert.match(f, /from_publication_date:2015-01-01/);
  assert.match(f, /cited_by_count:>9/);
  assert.doesNotMatch(buildFilter({ peerReviewed: false }), /type:/);
});

test('search, lookup and connections go to the right OpenAlex URLs', async (t) => {
  const seen = [];
  setFetch(async (url) => {
    seen.push(url);
    const u = new URL(url);
    const body = u.pathname.startsWith('/works/') ? WORKS[0] : { meta: { count: 3, page: 1 }, results: WORKS };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  t.after(() => setFetch(null));

  const res = await searchWorks({ q: 'Does sleep loss hurt working memory?', sort: 'cited' });
  assert.equal(res.interpreted.mode, 'question');
  assert.equal(res.results.length, 3);
  assert.ok(res.results[0].evidence.length, 'question searches say where the abstract matches');
  const u = new URL(seen[0]);
  assert.equal(u.searchParams.get('sort'), 'cited_by_count:desc');
  assert.match(u.searchParams.get('filter'), /has_doi:true/);

  const byDoi = await searchWorks({ q: 'https://doi.org/10.1016/j.sleep.2019.04.012' });
  assert.equal(byDoi.interpreted.mode, 'doi');
  assert.match(seen[1], /\/works\/doi:10\.1016\/j\.sleep\.2019\.04\.012/);

  await connectedWorks('W1001', 'citing');
  assert.match(new URL(seen[2]).searchParams.get('filter'), /^cites:W1001/);
  await assert.rejects(connectedWorks('nope', 'related'), /OpenAlex id/);
  await assert.rejects(getWork('not-an-id'), /not an OpenAlex id/);
  await assert.rejects(searchWorks({ q: '  ' }), /Type a word/);
});

test('an index outage becomes a readable error', async (t) => {
  setFetch(async () => new Response('{}', { status: 503 }));
  t.after(() => setFetch(null));
  await assert.rejects(searchWorks({ q: 'anything' }), (e) => e.status === 502 && /answered 503/.test(e.message));
  setFetch(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(searchWorks({ q: 'anything' }), /Could not reach/);
});

// ---------------------------------------------------------------- insights

test('the study table reads design, sample and finding from abstracts', () => {
  const [a, b, c] = WORKS.map(normaliseOpenAlex).map(extractStudy);
  assert.equal(a.design, 'Randomised controlled trial');
  assert.equal(a.sample, '84 students');
  assert.equal(a.population, 'students aged 14 to 17');
  assert.match(a.finding, /^These results suggest/);
  assert.equal(b.design, 'Cohort study');
  assert.equal(b.sample, '2,310 participants');
  assert.equal(c.design, 'Meta-analysis');
  assert.equal(c.sample, '61 studies');
  assert.ok(c.designRank < a.designRank && a.designRank < b.designRank, 'evidence ranks in the usual order');
});

test('nothing is guessed when the abstract is silent', () => {
  const x = extractStudy({ title: 'Thoughts on a topic', abstract: 'We discuss the topic in 2019 terms.' });
  assert.equal(x.design, null);
  assert.equal(x.sample, null);
  assert.equal(keyFinding(''), null);
});

test('model answers are parsed, and invented citations are dropped', () => {
  const works = WORKS.map(normaliseOpenAlex);
  const reply = 'Here you go:\n```json\n' + JSON.stringify({
    answer: 'Short sleep impairs working memory [1, 2], and one paper says so [7].',
    consensus: 'mostly-yes',
    papers: [
      { n: 1, stance: 'yes', finding: 'One short night cut accuracy.', design: 'RCT', population: 'null', sample: '84' },
      { n: 2, stance: 'possibly', finding: 'Small effects over time.' },
      { n: 9, stance: 'no' },
      { n: 1, stance: 'no' },
    ],
  }) + '\n```';
  const out = parseSynthesis(reply, works);
  assert.equal(out.answer, 'Short sleep impairs working memory [1, 2], and one paper says so.');
  assert.equal(out.papers.length, 2);
  assert.equal(out.papers[0].id, 'W1001');
  assert.equal(out.papers[0].population, null);
  assert.deepEqual(out.meter, { yes: 1, possibly: 1, no: 0, unclear: 0 });
  assert.throws(() => parseSynthesis('I cannot help with that.', works), /expected form/);
});

test('the synthesis prompt numbers the papers it gives', () => {
  const msg = buildSynthesisMessage('Does it work?', WORKS.map(normaliseOpenAlex));
  assert.match(msg, /^Question: Does it work\?/);
  assert.match(msg, /\[1\] Okafor, de la Cruz, Lin \(2019\)/);
  assert.match(msg, /\[3\] van den Berg \(2020\)/);
});

test('the study table exports as CSV', () => {
  const work = normaliseOpenAlex(WORKS[0]);
  const csv = studiesCsv([{ work, ...extractStudy(work), stance: 'yes' }]);
  const [head, row] = csv.split('\n');
  assert.match(head, /^Title,Authors,Year/);
  assert.match(row, /^Sleep deprivation and working memory in adolescents: a randomized crossover trial,Hannah R\. Okafor; /);
  assert.match(row, /,"These results suggest that even a single short night impairs working memory in this age group, e\.g\. during examination periods\.",yes$/);
  const evil = studiesCsv([{ work: { ...work, title: '=HYPERLINK("x")' } }]).split('\n')[1];
  assert.match(evil, /^"'=HYPERLINK\(""x""\)",/);
});

test('the takeaway and the focus come back checked', () => {
  const works = WORKS.map(normaliseOpenAlex);
  works[0].fulltext = 'RESULTS: accuracy fell';
  const out = parseSynthesis(JSON.stringify({
    takeaway: 'Short sleep impairs working memory [1] and [8].',
    focus: {
      question: 'Does short sleep impair working memory in adolescents?',
      population: 'Adolescents', exposure: 'Sleep restriction', comparison: 'null', outcome: 'Working memory',
      evidenceNeeded: 'Randomised trials.',
      nextSearches: ['a', 'b', 'c', 'd', 42],
    },
    answer: 'Yes [1].',
    consensus: 'yes',
    papers: [{ n: 1, stance: 'yes', limitation: 'One city only' }],
  }), works);
  assert.equal(out.takeaway, 'Short sleep impairs working memory [1] and.');
  assert.equal(out.focus.population, 'Adolescents');
  assert.equal(out.focus.comparison, null);
  assert.deepEqual(out.focus.nextSearches, ['a', 'b', 'c']);
  assert.equal(out.papers[0].limitation, 'One city only');
  assert.equal(out.papers[0].fullText, true);
  assert.deepEqual(out.fullTextIds, ['W1001']);
});

test('a reply without takeaway or focus still parses', () => {
  const out = parseSynthesis('{"answer":"Unclear.","consensus":"insufficient","papers":[]}', WORKS.map(normaliseOpenAlex));
  assert.equal(out.takeaway, null);
  assert.deepEqual(out.focus.nextSearches, []);
});

test('the model is told which papers are full text', () => {
  const works = WORKS.map(normaliseOpenAlex);
  works[1].fulltext = 'METHODS: four waves';
  const msg = buildSynthesisMessage('Q?', works);
  assert.match(msg, /\[1\][^\n]*\n\(ABSTRACT ONLY\)/);
  assert.match(msg, /\[2\][^\n]*\n\(FULL TEXT, condensed\)\nMETHODS: four waves/);
});

test('without a model, the takeaway is the strongest study\'s finding', () => {
  const best = strongestFinding(WORKS.map(normaliseOpenAlex));
  assert.equal(best.work.id, 'W1003', 'the meta-analysis outranks the trial and the cohort');
  assert.match(best.study.finding, /^Across 61 studies/);
  assert.equal(strongestFinding([]), null);
});

// ---------------------------------------------------------------- one paper in, more like it out

test('a paper\'s topics come from the phrases it repeats', async () => {
  const { topicTerms } = await import('../lib/keywords.js');
  const text = 'Working memory declined after sleep restriction. Working memory was tested with an n-back task. '
    + 'Sleep restriction lowered n-back accuracy. Adolescents with sleep restriction showed poorer working memory.';
  const terms = topicTerms(text, 4);
  assert.equal(terms[0], 'working memory');
  assert.ok(terms.includes('sleep restriction'));
  assert.ok(!terms.includes('memory'), 'a word already inside a chosen phrase is not repeated');
  assert.deepEqual(topicTerms(''), []);
});

test('the DOI printed in a paper is found, and titles are compared fairly', async () => {
  const { findDoi, titleSimilarity } = await import('../lib/scholar.js');
  assert.equal(findDoi('Sleep Med. 2019. https://doi.org/10.1016/J.SLEEP.2019.04.012.'), '10.1016/j.sleep.2019.04.012');
  assert.equal(findDoi('no identifier here'), null);
  assert.equal(titleSimilarity('Sleep and memory in teens', 'Sleep and memory in teens'), 1);
  assert.ok(titleSimilarity('Sleep and memory in teens', 'Microplastics in rivers') < 0.2);
});

test('an upload is matched by title only when the match is close', async (t) => {
  const { identifyPaper } = await import('../lib/scholar.js');
  setFetch(async () => new Response(JSON.stringify({ meta: { count: 3 }, results: WORKS }), { status: 200 }));
  t.after(() => setFetch(null));
  const hit = await identifyPaper({ titles: ['Sleep deprivation and working memory in adolescents: a randomized crossover trial'] });
  assert.equal(hit.id, 'W1001');
  const miss = await identifyPaper({ titles: ['Groundwater nitrate and agricultural runoff in the Po valley'] });
  assert.equal(miss, null);
});

test('similar papers merge the graph with a topic search, without the paper itself', async (t) => {
  const { similarWorks } = await import('../lib/scholar.js');
  const seen = [];
  setFetch(async (url) => {
    seen.push(new URL(url));
    return new Response(JSON.stringify({ meta: { count: 3 }, results: WORKS }), { status: 200 });
  });
  t.after(() => setFetch(null));
  const paper = normaliseOpenAlex(WORKS[0]);
  const out = await similarWorks({ work: paper });
  assert.equal(out.interpreted.mode, 'similar');
  assert.ok(!out.results.some((w) => w.id === 'W1001'), 'the paper is not similar to itself');
  assert.deepEqual(out.results.map((w) => w.id), ['W1002', 'W1003'], 'no duplicates across the two sources');
  assert.ok(seen.some((u) => /related_to:W1001/.test(u.searchParams.get('filter') || '')));
  assert.ok(seen.some((u) => u.searchParams.get('search')));
  await assert.rejects(similarWorks({ work: { id: 'upload-1', title: '' } }), /Not enough text/);
});

test('the scan is parsed and capped', async () => {
  const { parseScan } = await import('../lib/insights.js');
  const scan = parseScan('```json\n' + JSON.stringify({
    summary: 'It tested sleep.', design: 'null', keyFindings: ['a (p. 2)', 'b', 'c', 'd', 'e'],
    topics: ['sleep', 7, 'memory'], searches: ['x'],
  }) + '\n```');
  assert.equal(scan.summary, 'It tested sleep.');
  assert.equal(scan.design, null);
  assert.equal(scan.keyFindings.length, 4);
  assert.deepEqual(scan.topics, ['sleep', 'memory']);
  assert.throws(() => parseScan('no json'), /expected form/);
});

test('a question carries the paper with page markers and the conversation so far', async () => {
  const { paperText, buildAskMessage } = await import('../lib/insights.js');
  const ft = { sections: [{ title: 'Results', paragraphs: [{ text: 'Accuracy fell.', page: 2 }] }] };
  const text = paperText(ft, (p) => 110 + p);
  assert.match(text, /## Results\n\[p\. 112\] Accuracy fell\./);
  const msg = buildAskMessage({
    paper: { title: 'T', year: 2019, authors: [{ family: 'Okafor' }] },
    text,
    history: [{ q: 'Who?', a: 'Students.' }],
    question: 'How many?',
  });
  assert.match(msg, /^Paper: T by Okafor \(2019\)\./);
  assert.match(msg, /<paper>[\s\S]*\[p\. 112\][\s\S]*<\/paper>/);
  assert.match(msg, /Q: Who\?\nA: Students\./);
  assert.match(msg, /Question: How many\?$/);
  assert.match(paperText(ft, (p) => p, 20), /cut to fit/);
});
