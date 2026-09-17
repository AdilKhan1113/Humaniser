import test from 'node:test';
import assert from 'node:assert/strict';

import { humanise, PROFILES } from '../lib/rules.js';
import { flipPassiveClause, findPassives, isPluralAgent } from '../lib/passive.js';
import { activeForm, PARTICIPLES } from '../lib/verbs.js';

const run = (text, strength = 'balanced') => humanise(text, { strength }).text;

test('flips a passive with a named actor', () => {
  assert.equal(flipPassiveClause('The book was read by me.'), 'I read the book.');
  assert.equal(flipPassiveClause('The cake was eaten by the dog.'), 'The dog ate the cake.');
  assert.equal(flipPassiveClause('Mistakes were made by the team.'), 'The team made mistakes.');
});

test('keeps a name capitalised and lowercases a common noun', () => {
  assert.equal(flipPassiveClause('Sarah was praised by the board.'), 'The board praised Sarah.');
  assert.match(flipPassiveClause('Mistakes were made by the team.'), /made mistakes/);
});

test('agrees with the new subject', () => {
  assert.equal(
    flipPassiveClause('The system is used by thousands of people.'),
    'Thousands of people use the system.',
  );
  assert.equal(
    flipPassiveClause('The proposal is reviewed by the committee.'),
    'The committee reviews the proposal.',
  );
  assert.ok(isPluralAgent('thousands of people'));
  assert.equal(isPluralAgent('the committee'), false);
  assert.equal(isPluralAgent('the business'), false);
});

test('an adverbial after the agent moves to the end, not into the subject', () => {
  assert.equal(
    flipPassiveClause('The report was written by Sarah last night.'),
    'Sarah wrote the report last night.',
  );
  assert.equal(
    flipPassiveClause('Decisions were made by the committee regarding the proposals.'),
    'The committee made decisions regarding the proposals.',
  );
});

test('refuses to flip when the actor is missing', () => {
  assert.equal(flipPassiveClause('The window was broken.'), null);
  assert.equal(findPassives('The window was broken.').length, 1);
});

test('does not mistake a predicate adjective for a passive', () => {
  assert.equal(findPassives('She was tired.').length, 0);
  assert.equal(findPassives('He is used to the noise.').length, 0);
  assert.equal(findPassives('The rule is based on evidence.').length, 0);
});

test('flips an unknown regular verb in the past tense', () => {
  assert.equal(PARTICIPLES.has('slashed'), false);
  assert.equal(activeForm('slashed', 'was'), 'slashed');
  assert.equal(activeForm('slashed', 'is'), null); // present needs the base form
  assert.equal(
    flipPassiveClause('The budget was slashed by management.'),
    'Management slashed the budget.',
  );
});

test('flips each clause of a two-clause sentence on its own', () => {
  const out = run('The memo was approved by the board, and the note was signed by Ana.');
  assert.match(out, /The board approved the memo/);
  assert.match(out, /Ana signed the note/);
});

test('strips stock phrasing and repairs the capital', () => {
  assert.equal(run('It is important to note that sales fell.'), 'Sales fell.');
  assert.equal(run('In conclusion, the plan works.'), 'The plan works.');
});

test('swaps inflated words for plain ones', () => {
  assert.match(run('We utilize numerous methodologies.'), /use many methods/);
  assert.match(run('Prior to the meeting we will commence.'), /Before the meeting/);
});

test('leaves a participle behind a be-verb alone rather than writing "was showed"', () => {
  const out = run('The finding was demonstrated.');
  assert.doesNotMatch(out, /was showed/);
});

test('unburies a verb from a light-verb phrase', () => {
  assert.match(run('We need to make a decision today.'), /to decide today/);
  assert.match(run('They conducted an investigation of the leak.'), /investigated the leak/);
});

test('drops the comma before a conjunction joining two clauses', () => {
  assert.equal(run('I read the book, but I disliked it.'), 'I read the book but I disliked it.');
});

test('keeps the commas in a list', () => {
  assert.match(run('I bought apples, oranges, and pears.'), /apples, oranges, and pears/);
});

test('contracts negations and rations the rest', () => {
  assert.match(run('We do not have the data.'), /don't/);
  const many = run('You are late. You are early. You are here. You are gone. You are back. You are done.');
  const used = (many.match(/you're/gi) || []).length;
  assert.ok(used > 0 && used < 6, `contracted ${used} of 6, expected some but not all`);
});

test('bold contracts more than light', () => {
  const text = 'You are late and it is raining and we are tired and they are waiting.';
  const light = (humanise(text, { strength: 'light' }).text.match(/'/g) || []).length;
  const bold = (humanise(text, { strength: 'bold' }).text.match(/'/g) || []).length;
  assert.ok(bold > light, `light ${light}, bold ${bold}`);
});

test('breaks a long sentence at a conjunction', () => {
  const long = 'The team shipped the feature on Friday afternoon after a long review, but the tests were still failing on the main branch that evening.';
  const out = run(long, 'bold');
  assert.ok(out.split(/[.!?]/).filter((s) => s.trim()).length > 1, out);
  assert.match(out, /\. But /);
});

test('cuts empty intensifiers', () => {
  // "this is" has no contraction, so only the intensifier goes.
  assert.equal(run('This is a very good idea.'), 'This is a good idea.');
  assert.match(run('Clearly, the plan works.'), /^The plan works/);
});

test('never edits inside code, links or addresses', () => {
  const text = 'Run `utilize --now` first. See https://example.com/utilize/very for details. Mail do-not-reply@example.com.';
  const out = run(text);
  assert.match(out, /`utilize --now`/);
  assert.match(out, /https:\/\/example\.com\/utilize\/very/);
  assert.match(out, /do-not-reply@example\.com/);
});

test('leaves a fenced code block untouched', () => {
  const text = 'Here is the fix.\n\n```js\nconst veryOptimal = utilize(data);\n```\n\nIt is not complicated.';
  const out = run(text);
  assert.match(out, /const veryOptimal = utilize\(data\);/);
  assert.match(out, /isn't complicated/);
});

test('light touch leaves sentence structure alone', () => {
  const text = 'The report was written by Sarah. We do not have the data.';
  const out = humanise(text, { strength: 'light' }).text;
  assert.match(out, /The report was written by Sarah/);
  assert.match(out, /We do not have the data/);
});

test('logs every edit it makes', () => {
  const result = humanise('It is important to note that we utilize numerous tools.');
  assert.ok(result.changes.length >= 2);
  for (const change of result.changes) {
    assert.equal(typeof change.rule, 'string');
    assert.notEqual(change.from, change.to);
  }
  assert.ok(Object.keys(result.byRule).length >= 1);
});

test('handles empty and whitespace input', () => {
  assert.equal(humanise('').text, '');
  assert.equal(humanise('   \n  ').text, '');
});

test('every profile is declared with the fields the UI reads', () => {
  for (const [id, profile] of Object.entries(PROFILES)) {
    assert.equal(typeof profile.label, 'string', id);
    assert.equal(typeof profile.description, 'string', id);
    assert.equal(typeof profile.steps, 'object', id);
  }
});

test('running twice changes nothing more the second time', () => {
  const once = run('It is important to note that the data was analyzed by the committee, and we do not have it.');
  const twice = run(once);
  assert.equal(twice, once);
});

test('keeps markdown structure out of the rewritten sentence', () => {
  const out = run('- The build was broken by a bad merge.');
  assert.equal(out, '- A bad merge broke the build.');
  assert.match(run('> The memo was signed by Ana.'), /^> Ana signed the memo/);
  assert.match(run('1. The bug was found by QA.'), /^1\. QA found the bug/);
});

test('rewrites a markdown document without disturbing its shape', () => {
  const text = '## Heading\n\n- It is important to note that we utilize tools\n- The build was broken by a bad merge, and it is not fixed yet.';
  const out = run(text);
  assert.match(out, /^## Heading\n\n/);
  assert.match(out, /^- we use tools$/m);
  assert.match(out, /^- A bad merge broke the build and it isn't fixed yet\.$/m);
});

test('capitalises a quotation that starts mid-sentence', () => {
  assert.equal(
    run('She said, "It is important to note that we do not have the data."'),
    'She said, "We don\'t have the data."',
  );
});
