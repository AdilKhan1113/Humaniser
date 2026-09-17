import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRubric, checkAgainstRubric } from '../lib/rubric.js';
import { documentXmlToText } from '../lib/docx.js';
import { humanise } from '../lib/rules.js';
import { analyze } from '../lib/analyze.js';

const GUIDE = `PSYC3001 Assignment 2 — Marking Guide
Word limit: 1500 words (±10%)
Referencing: APA 7th edition. At least 6 peer-reviewed sources.
Style: Formal academic register throughout. Avoid contractions. Write in the third person.
Continuous prose — avoid bullet points.

Criteria:
- Applies Bronfenbrenner's ecological systems theory to the case (10 marks)
- Identifies microsystem and mesosystem influences accurately (10 marks)
- Evaluates the reciprocity of the relationships described (10 marks)`;

test('reads a word limit in each of the usual phrasings', () => {
  assert.deepEqual(parseRubric('Word limit: 1500 words').wordLimit, { target: 1500 });
  assert.deepEqual(parseRubric('Write 2000-2500 words').wordLimit, { min: 2000, max: 2500 });
  assert.deepEqual(parseRubric('No more than 800 words').wordLimit, { max: 800 });
  assert.deepEqual(parseRubric('At least 1,200 words').wordLimit, { min: 1200 });
  assert.deepEqual(
    parseRubric('1500 words (±10%)').wordLimit,
    { target: 1500, min: 1350, max: 1650, tolerance: 10 },
  );
  assert.equal(parseRubric('Submit by Friday.').wordLimit, null);
});

test('reads the style constraints and what they switch off', () => {
  const rubric = parseRubric(GUIDE);
  assert.equal(rubric.constraints.noContractions, true);
  assert.equal(rubric.constraints.noFirstPerson, true);
  assert.equal(rubric.constraints.noBulletPoints, true);
  assert.equal(rubric.constraints.formalRegister, true);
  // A formal register implies the two it does not spell out.
  assert.equal(rubric.constraints.noSecondPerson, true);
  assert.ok(rubric.appliedConstraints.every((c) => c.evidence));
});

test('reads referencing, sources and criteria', () => {
  const rubric = parseRubric(GUIDE);
  assert.equal(rubric.citationStyle, 'APA');
  assert.equal(rubric.minSources, 6);
  assert.equal(rubric.criteria.length, 3);
  assert.match(rubric.criteria[0], /^Applies Bronfenbrenner/);
});

test('picks out subject concepts, not marking verbs', () => {
  const terms = parseRubric(GUIDE).keyTerms;
  for (const wanted of ['bronfenbrenner', 'microsystem', 'mesosystem', 'reciprocity']) {
    assert.ok(terms.includes(wanted), `expected ${wanted} in ${terms.join(', ')}`);
  }
  for (const unwanted of ['applies', 'identifies', 'evaluates', 'marks', 'criteria', 'avoid']) {
    assert.equal(terms.includes(unwanted), false, `${unwanted} should not count as a concept`);
  }
});

test('an empty guide parses to nothing rather than throwing', () => {
  assert.equal(parseRubric(''), null);
  assert.equal(parseRubric('   '), null);
});

test('checks a draft against the guide', () => {
  const rubric = parseRubric(GUIDE);
  const draft = "We don't think the reciprocity is balanced, and you can see why (Baker et al., 2021).";
  const byLabel = Object.fromEntries(checkAgainstRubric(draft, rubric).map((c) => [c.label, c]));

  assert.equal(byLabel['Word count'].status, 'fail');
  assert.equal(byLabel['No contractions'].status, 'fail');
  assert.match(byLabel['No contractions'].detail, /don't/);
  assert.equal(byLabel['Third person only'].status, 'fail');
  assert.equal(byLabel['Does not address the reader'].status, 'fail');
  assert.equal(byLabel['Continuous prose'].status, 'pass');
  assert.equal(byLabel['APA referencing'].status, 'info');
});

test('a possessive is not a contraction', () => {
  const rubric = parseRubric('Avoid contractions.');
  const check = checkAgainstRubric("Milo's relationships and the students' views.", rubric)[0];
  assert.equal(check.status, 'pass', check.detail);
});

test('"US" in capitals is the country, not a pronoun', () => {
  const rubric = parseRubric('Write in the third person.');
  const check = checkAgainstRubric('The study examined US policy.', rubric)[0];
  assert.equal(check.status, 'pass', check.detail);
  const caught = checkAgainstRubric('We examined the policy.', rubric)[0];
  assert.equal(caught.status, 'fail');
});

test('checking against no guide returns nothing', () => {
  assert.deepEqual(checkAgainstRubric('Some text.', null), []);
});

test('a guide banning contractions reverses the rule instead of disabling it', () => {
  const constraints = { noContractions: true };
  const draft = "We don't have the data. It's late and the plan isn't ready.";
  const out = humanise(draft, { constraints }).text;
  assert.match(out, /do not have/);
  assert.match(out, /It is late/);
  assert.match(out, /is not ready/);
  assert.doesNotMatch(out, /n't/);
});

test('a third-person guide stops a passive becoming "we"', () => {
  const draft = 'The data was analysed by us.';
  assert.match(humanise(draft).text, /^We analysed the data/);
  assert.equal(humanise(draft, { constraints: { noFirstPerson: true } }).text, draft);
});

test('the report stops asking for what the guide forbids', () => {
  const formal = 'The committee reviewed the report. The findings were published. '
    + 'The analysis proceeded in three stages. The conclusion follows from the evidence presented here.';
  const plain = analyze(formal);
  const guided = analyze(formal, { constraints: { noContractions: true, noSecondPerson: true } });

  assert.ok(plain.issues.some((i) => i.type === 'no-contractions' || i.type === 'no-you')
    || plain.score <= guided.score);
  assert.equal(guided.issues.some((i) => i.type === 'no-contractions'), false);
  assert.equal(guided.issues.some((i) => i.type === 'no-you'), false);
  // Warmth measures what the guide bans, so it leaves the headline score.
  assert.equal(guided.scoredQualities.includes('warmth'), false);
  assert.equal(plain.scoredQualities.includes('warmth'), true);
  assert.ok(guided.score >= plain.score);
});

test('reads WordprocessingML down to plain text', () => {
  const xml = '<w:body><w:p><w:r><w:t>Word limit: 1500 words</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Avoid </w:t></w:r><w:r><w:t>contractions &amp; slang.</w:t></w:r></w:p>'
    + '<w:p><w:r><w:delText>deleted text</w:delText></w:r></w:p>'
    + '<w:p><w:r><w:t>Third’s person</w:t></w:r></w:p></w:body>';
  const text = documentXmlToText(xml);
  assert.match(text, /^Word limit: 1500 words$/m);
  assert.match(text, /^Avoid contractions & slang\.$/m);
  assert.doesNotMatch(text, /deleted text/);
  assert.match(text, /Third’s person/);
});

test('refuses a zip bomb instead of inflating it', async () => {
  // A small archive whose one entry expands past the ceiling. Reading it all in
  // before measuring is how a tiny upload takes a server down.
  const { extractDocxText } = await import('../lib/docx.js');
  const zlib = await import('node:zlib');

  const payload = Buffer.from('<w:document><w:body>' + 'A'.repeat(45 * 1024 * 1024) + '</w:body></w:document>');
  const deflated = zlib.deflateRawSync(payload, { level: 9 });
  const name = Buffer.from('word/document.xml');

  // Minimal zip: local header, data, central directory, end record.
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);                       // deflate
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);                    // local header offset

  const centralStart = local.length + name.length + deflated.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralStart, 16);

  const zip = Buffer.concat([local, name, deflated, central, name, end]);
  assert.ok(zip.length < 1_000_000, `the archive itself is small: ${zip.length} bytes`);

  await assert.rejects(
    () => extractDocxText(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)),
    /unpacks to far more/,
  );
});
