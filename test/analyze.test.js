import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, splitSentences, findCommaSplices, looksIndependent, countSyllables } from '../lib/analyze.js';

test('splits sentences and records offsets', () => {
  const text = 'One two three. Four five six! Seven?';
  const sentences = splitSentences(text);
  assert.equal(sentences.length, 3);
  assert.equal(sentences[0].text, 'One two three.');
  assert.equal(text.slice(sentences[1].start, sentences[1].end), 'Four five six!');
  assert.equal(sentences[2].words.length, 1);
});

test('an abbreviation does not end a sentence', () => {
  const sentences = splitSentences('Dr. Smith arrived at 9 p.m. She was late.');
  assert.equal(sentences.length, 2);
  assert.match(sentences[0].text, /^Dr\. Smith/);
});

test('counts syllables well enough for a readability score', () => {
  assert.equal(countSyllables('cat'), 1);
  assert.equal(countSyllables('running'), 2);
  assert.equal(countSyllables('beautiful'), 3);
});

test('flags a comma before a conjunction joining two clauses', () => {
  const hits = findCommaSplices('I read the book, but I disliked it.');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].conjunction, 'but');
});

test('leaves the commas in a list alone', () => {
  assert.equal(findCommaSplices('I bought apples, oranges, and pears.').length, 0);
});

test('recognises an independent clause behind a determiner', () => {
  assert.ok(looksIndependent('the board approved it yesterday'));
  assert.ok(looksIndependent('it was late'));
  assert.equal(looksIndependent('oranges'), false);
});

test('scores machine-flavoured prose below human prose', () => {
  const stiff = 'It is important to note that the data was analyzed by the committee. '
    + 'Furthermore, the implementation of these paradigms was subsequently evaluated by the team. '
    + 'In conclusion, the results were published by the group.';
  const human = "You don't need a committee to read the numbers. I read them. They're ugly. "
    + 'But here is the thing: ugly numbers beat a pretty guess, and most teams would rather have the guess.';
  assert.ok(analyze(stiff).score < 45, `stiff scored ${analyze(stiff).score}`);
  assert.ok(analyze(human).score > 80, `human scored ${analyze(human).score}`);
});

test('reports the tallies the dashboard needs', () => {
  const report = analyze('It is important to note that the report was written by Sarah. We do not have the data.');
  assert.ok(report.tallies.aiTells >= 1);
  assert.ok(report.tallies.passive >= 1);
  assert.ok(report.tallies.contractionSlots >= 1);
  assert.equal(typeof report.rhythm.burstiness, 'number');
  assert.equal(Object.keys(report.subscores).length, 6);
});

test('burstiness rises when sentence lengths vary', () => {
  const flat = 'The cat sat down here. The dog ran away fast. The bird flew off now. The fish swam around too.';
  const varied = 'The cat sat. It waited for a long time, watching the door and the window and the stairs. Then nothing. Nothing at all happened for the rest of that long grey afternoon.';
  assert.ok(analyze(varied).rhythm.burstiness > analyze(flat).rhythm.burstiness);
});

test('flags a sentence longer than the target window', () => {
  const long = 'This particular sentence has been written deliberately so that it runs well past the target window of twenty words and therefore should be flagged by the report.';
  const issues = analyze(long).issues.filter((i) => i.type === 'long-sentence');
  assert.equal(issues.length, 1);
  assert.ok(issues[0].start === 0);
});

test('flags jargon it refuses to substitute', () => {
  const issues = analyze('The aforementioned proposals were rejected.').issues;
  assert.ok(issues.some((i) => i.type === 'jargon' && /aforementioned/i.test(i.title)));
});

test('an empty document does not throw', () => {
  const report = analyze('');
  assert.equal(report.counts.words, 0);
  assert.equal(report.issues.length, 0);
  assert.equal(typeof report.score, 'number');
});

test('a dot inside a URL or a decimal does not end a sentence', () => {
  assert.deepEqual(
    splitSentences('See https://example.com/a/b for details. Then stop.').map((s) => s.text),
    ['See https://example.com/a/b for details.', 'Then stop.'],
  );
  assert.equal(splitSentences('Costs rose 3.5% last year. Sales fell.').length, 2);
});

test('a heading or list item stands alone without a full stop', () => {
  assert.deepEqual(
    splitSentences('# Title\nSome prose follows.').map((s) => s.text),
    ['# Title', 'Some prose follows.'],
  );
  assert.deepEqual(
    splitSentences('- first item\n- second item').map((s) => s.text),
    ['- first item', '- second item'],
  );
});

test('a blank line ends a sentence that has no full stop', () => {
  assert.deepEqual(
    splitSentences('A line with no stop\n\nA new paragraph').map((s) => s.text),
    ['A line with no stop', 'A new paragraph'],
  );
});

test('a hard line wrap does not end a sentence', () => {
  // Text pasted from a PDF or a Word document arrives wrapped mid-sentence.
  // Treating each wrapped line as a sentence put a capital letter in the middle
  // of every one of them.
  const wrapped = 'Milo\'s relationships with students constitute a microsystem influence\n'
    + 'characterised by sustained emotional demand that runs one way, returning\n'
    + 'recognition rather than support.';
  const sentences = splitSentences(wrapped);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].words.length, 22);
});
