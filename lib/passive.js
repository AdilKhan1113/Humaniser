// Passive detection, shared by the rewriter and the report.
//
// The test is deliberately conservative. A be-verb followed by an -ed word is
// not proof of anything ("she was tired" is an adjective, not a passive), so
// known predicate adjectives are excluded outright and the verb table decides
// whether a flip is safe.

import { isKnownParticiple, activeForm } from './verbs.js';
import { isCommonWord } from './common-words.js';

const BE = String.raw`(?:is|are|was|were|has been|have been|had been|will be|can be|must be|being)`;

// Words that look like participles but behave as adjectives after "be".
const ADJECTIVAL = new Set([
  'tired', 'interested', 'excited', 'pleased', 'surprised', 'worried',
  'scared', 'confused', 'bored', 'satisfied', 'disappointed', 'concerned',
  'involved', 'prepared', 'determined', 'supposed', 'located',
  'based', 'related', 'aged', 'wooden', 'golden', 'sudden', 'often',
  'engaged', 'married', 'retired', 'qualified', 'experienced', 'dedicated',
  'devoted', 'convinced', 'frightened', 'embarrassed', 'exhausted',
  'crowded', 'closed', 'open', 'limited', 'detailed', 'advanced',
  'complicated', 'unexpected', 'mixed', 'armed', 'gifted', 'talented',
]);

// An optional adverb or negation may sit between the be-verb and the participle
// ("was quickly read", "is not approved"), so the pattern allows one filler word.
const PASSIVE_RE = new RegExp(
  String.raw`\b(${BE})\s+(?:(?:not|never|already|only|\w+ly)\s+)?(\w+)\b` +
    // The agent also stops at a bracket, so "by sleep (Smith, 2020)" leaves the
  // citation where it was instead of splicing it into the subject.
  String.raw`(\s+by\s+([^,.;:!?()[\]]+?)(?=[,.;:!?]|\s*[([]|\s+(?:and|but|so|which|that|when|because|while)\b|$))?`,
  'gi',
);

// Where an agent phrase stops. Anything from here on is a modifier that belongs
// at the end of the active sentence, not in its subject.
const AGENT_BOUNDARY = new Set([
  'last', 'next', 'this', 'yesterday', 'today', 'tomorrow', 'in', 'on', 'at',
  'for', 'during', 'after', 'before', 'from', 'over', 'under', 'within',
  'since', 'while', 'when', 'because', 'through', 'throughout', 'until',
  'per', 'via', 'about', 'against', 'toward', 'towards', 'every',
  'prior', 'due', 'ahead', 'thanks', 'along', 'across', 'behind', 'below',
  'regarding', 'concerning', 'including', 'excluding', 'following',
  'considering', 'despite', 'without', 'among', 'between', 'unlike',
  'versus', 'vs', 'alongside', 'amid', 'beyond', 'besides', 'plus',
]);

/**
 * Splits "Sarah last night" into the agent ("Sarah") and the trailing modifier
 * ("last night"), capping the agent at four words.
 */
function parseAgent(raw) {
  const tokens = raw.trim().split(/\s+/);
  const agent = [];
  let i = 0;
  for (; i < tokens.length && agent.length < 4; i += 1) {
    if (agent.length > 0 && AGENT_BOUNDARY.has(tokens[i].toLowerCase())) break;
    agent.push(tokens[i]);
  }
  // A noun phrase cannot end on a preposition or an article. Anything dangling
  // at the end belongs to the modifier, not the subject, which is what keeps
  // "by the committee prior to the meeting" from yielding "The committee prior to".
  while (agent.length > 1 && DANGLING_TAIL.has(agent[agent.length - 1].toLowerCase())) {
    i -= 1;
    agent.pop();
  }
  return { agent: agent.join(' '), trailing: tokens.slice(i).join(' ') };
}

const DANGLING_TAIL = new Set([
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'and', 'or',
  'the', 'a', 'an', 'as', 'than', 'that', 'which', 'into', 'onto', 'up',
  // Copulas and infinitive markers: "by our team to be highly effective"
  // must yield the agent "our team", not "our team to be".
  'be', 'been', 'being', 'is', 'are', 'was', 'were', 'not', 'very', 'highly',
  'regarding', 'concerning', 'including', 'following', 'about', 'over',
]);

// Words ending in -s that are singular anyway, so they do not trip the plural check.
const SINGULAR_S = new Set([
  'news', 'business', 'process', 'analysis', 'series', 'physics', 'politics',
  'economics', 'mathematics', 'statistics', 'ethics', 'class', 'glass', 'boss',
  'address', 'press', 'access', 'success', 'progress', 'congress', 'campus',
  'bus', 'gas', 'focus', 'status', 'basis', 'crisis', 'thesis',
]);

const ALWAYS_PLURAL = new Set([
  'they', 'we', 'people', 'police', 'children', 'men', 'women', 'staff',
  'both', 'many', 'few', 'others', 'you',
]);

/**
 * Plurality of an agent phrase, judged from its head word ("thousands of
 * people" is plural because of "people", not "thousands").
 */
export function isPluralAgent(agent) {
  if (!agent) return false;
  const tokens = agent.trim().split(/\s+/);
  const head = tokens[tokens.length - 1].toLowerCase().replace(/[^a-z']/g, '');
  if (ALWAYS_PLURAL.has(head)) return true;
  if (SINGULAR_S.has(head)) return false;
  if (head.endsWith("'s")) return false; // possessive, not plural
  return head.endsWith('s');
}

/**
 * Finds passive constructions in a chunk of text.
 * @returns {Array<{index:number, length:number, match:string, beForm:string,
 *   participle:string, agent:string|null, rewrite:string|null}>}
 */
export function findPassives(text) {
  const hits = [];
  PASSIVE_RE.lastIndex = 0;
  let m;
  while ((m = PASSIVE_RE.exec(text)) !== null) {
    const [match, beForm, participle, , rawAgent] = m;
    const lower = participle.toLowerCase();
    if (ADJECTIVAL.has(lower)) continue;
    // "is used by" is passive; "is used to" is the adjective sense.
    if (lower === 'used' && /^\s+to\s/.test(text.slice(m.index + match.length))) continue;
    // Either the verb table knows it, or it at least has participle shape.
    if (!isKnownParticiple(lower) && !/(?:ed|en)$/.test(lower)) continue;

    const parsed = rawAgent ? parseAgent(rawAgent) : null;
    hits.push({
      index: m.index,
      length: match.length,
      match,
      beForm: beForm.toLowerCase(),
      participle,
      agent: parsed ? parsed.agent : null,
      trailing: parsed ? parsed.trailing : '',
      rewrite: parsed ? activeForm(lower, beForm.toLowerCase(), isPluralAgent(parsed.agent)) : null,
    });
  }
  return hits;
}

/**
 * Rewrites "X was read by me" as "I read X" when every piece is known. Takes a
 * single clause, not a multi-clause sentence: the caller splits first.
 * Returns null when anything is uncertain, which keeps a shaky guess out of the
 * output and leaves it as a suggestion instead.
 */
export function flipPassiveClause(clause, { capitalise = true } = {}) {
  const passives = findPassives(clause);
  if (passives.length !== 1) return null;

  const hit = passives[0];
  if (!hit.agent || !hit.rewrite) return null;

  const subject = clause.slice(0, hit.index).trim();
  const tail = clause.slice(hit.index + hit.length).trim();
  if (!subject || /[,;:]$/.test(subject)) return null;
  // A subject longer than a short phrase usually means the sentence has more
  // structure than this simple flip can respect.
  if (subject.split(/\s+/).length > 7) return null;

  const agent = normaliseAgent(hit.agent);
  const object = lowerFirstIfCommon(subject);
  const rebuilt = [agent, hit.rewrite, object, hit.trailing, tail]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ');
  return capitalise ? rebuilt.charAt(0).toUpperCase() + rebuilt.slice(1) : rebuilt;
}

// "by me" -> "I", "by him" -> "he", and so on: the agent becomes the subject, so
// object pronouns have to change case.
const PRONOUN_SUBJECTS = new Map(Object.entries({
  me: 'I', him: 'he', her: 'she', us: 'we', them: 'they', it: 'it', you: 'you',
  myself: 'I', themselves: 'they',
}));

function normaliseAgent(agent) {
  const key = agent.trim().toLowerCase();
  if (PRONOUN_SUBJECTS.has(key)) return PRONOUN_SUBJECTS.get(key);
  // Case is left alone here. Whether this word starts a sentence is the
  // caller's business, and forcing a capital produced "and The board approved".
  return agent.trim();
}

// The old subject moves into object position, so a capital that only existed
// because the word started the sentence has to go. A name keeps its capital, and
// the frequency list is what tells the two apart: "Mistakes" resolves to a
// common noun, "Sarah" does not.
function lowerFirstIfCommon(subject) {
  const first = subject.split(/\s+/)[0];
  if (first === 'I') return subject;
  if (!/^[A-Z]/.test(first)) return subject;
  if (!isCommonWord(first)) return subject; // treat as a proper noun
  return subject.charAt(0).toLowerCase() + subject.slice(1);
}
