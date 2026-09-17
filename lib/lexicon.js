// Shared word lists. Both the rewriter (rules.js) and the reporter (analyze.js)
// read from here, so a term only ever needs fixing in one place.

// Corporate padding, not vivid vocabulary. The distinction matters: "obsidian"
// or "cantankerous" are uncommon and welcome, "utilize" is just "use" wearing a
// suit. Only bureaucratic inflation belongs in this map.
export const INFLATED = new Map(Object.entries({
  // multi-word first; the matcher runs longest-first anyway
  'due to the fact that': 'because',
  'of the fact that': 'that',
  'in spite of the fact that': 'although',
  'despite the fact that': 'although',
  'in the event that': 'if',
  'for the purpose of': 'to',
  'with regard to': 'about',
  'with reference to': 'about',
  'in relation to': 'about',
  'pertaining to': 'about',
  'in conjunction with': 'with',
  'in the near future': 'soon',
  'at this point in time': 'now',
  'at the present time': 'now',
  'in order to': 'to',
  'a large number of': 'many',
  'a great deal of': 'much',
  'the majority of': 'most',
  'a sufficient number of': 'enough',
  'in close proximity to': 'near',
  'on a daily basis': 'daily',
  'on a regular basis': 'regularly',
  'in the absence of': 'without',
  'subsequent to': 'after',
  'prior to': 'before',
  'in excess of': 'more than',
  'is capable of': 'can',
  'has the ability to': 'can',
  'has the capacity to': 'can',
  'is able to': 'can',
  'are able to': 'can',
  'it is possible that': 'maybe',
  'the reason why is because': 'because',
  'each and every': 'every',
  'first and foremost': 'first',
  'end result': 'result',
  'final outcome': 'outcome',
  'past history': 'history',
  'advance planning': 'planning',
  'added bonus': 'bonus',
  'unexpected surprise': 'surprise',
  'completely eliminate': 'eliminate',
  'absolutely essential': 'essential',
  'close proximity': 'nearness',
  // single words
  utilize: 'use',
  utilise: 'use',
  utilizing: 'using',
  utilising: 'using',
  utilization: 'use',
  utilisation: 'use',
  leverage: 'use',
  leveraging: 'using',
  facilitate: 'help',
  facilitates: 'helps',
  facilitated: 'helped',
  endeavour: 'try',
  endeavor: 'try',
  ascertain: 'find',
  commence: 'start',
  commences: 'starts',
  commenced: 'started',
  terminate: 'end',
  terminates: 'ends',
  terminated: 'ended',
  demonstrate: 'show',
  demonstrates: 'shows',
  demonstrated: 'showed',
  sufficient: 'enough',
  additional: 'more',
  obtain: 'get',
  obtains: 'gets',
  obtained: 'got',
  purchase: 'buy',
  purchased: 'bought',
  assist: 'help',
  assists: 'helps',
  assisted: 'helped',
  attempt: 'try',
  attempts: 'tries',
  attempted: 'tried',
  numerous: 'many',
  optimal: 'best',
  remainder: 'rest',
  subsequently: 'later',
  approximately: 'about',
  predominantly: 'mostly',
  consequently: 'so',
  currently: 'now',
  finalize: 'finish',
  finalise: 'finish',
  henceforth: 'from now on',
  notwithstanding: 'despite',
  elucidate: 'explain',
  exacerbate: 'worsen',
  exacerbates: 'worsens',
  ameliorate: 'improve',
  cognizant: 'aware',
  requisite: 'needed',
  plethora: 'plenty',
  utilizations: 'uses',
  endeavours: 'efforts',
  endeavors: 'efforts',
  myriad: 'many',
  paradigm: 'model',
  paradigms: 'models',
  methodology: 'method',
  methodologies: 'methods',
  initiate: 'start',
  initiates: 'starts',
  initiated: 'started',
  participate: 'take part',
  indicative: 'a sign',
  inquire: 'ask',
  inquired: 'asked',
  reside: 'live',
  resides: 'lives',
  transmit: 'send',
  transmitted: 'sent',
  anticipate: 'expect',
  anticipates: 'expects',
  regarding: 'about',
  whilst: 'while',
  amongst: 'among',
  thusly: 'so',
  heretofore: 'until now',
}));

// Words worth a note but not a mechanical swap: any substitution would need to
// agree in number or pick a referent, and guessing wrong is worse than leaving
// the word alone. The report raises these; the rewriter never touches them.
export const FLAG_ONLY = new Map(Object.entries({
  aforementioned: 'Name the thing you mean instead.',
  thereof: 'Say what it belongs to.',
  therein: 'Say where.',
  herein: 'Say where.',
  hereby: 'Legal boilerplate. Cut it.',
  whereby: 'Try "where" or "in which".',
  'in terms of': 'Usually deletable, or becomes "for".',
  'vis-à-vis': 'Try "about" or "compared with".',
  'per se': 'Rarely earns its keep.',
  'inter alia': 'Try "among other things".',
  notwithstanding: 'Try "despite" or "still".',
  ergo: 'Try "so".',
}));

// Phrases that read as machine-generated. Replacement of '' means "delete it and
// let the sentence start at the real point".
export const AI_TELLS = [
  { find: /\bit(?:'s| is) important to (?:note|remember|understand|realize|realise) that\s+/gi, use: '', label: 'filler opener' },
  { find: /\bit(?:'s| is) worth (?:noting|mentioning) that\s+/gi, use: '', label: 'filler opener' },
  { find: /\bit should be noted that\s+/gi, use: '', label: 'filler opener' },
  { find: /\bneedless to say,?\s*/gi, use: '', label: 'filler opener' },
  { find: /\bin today's (?:fast[- ]paced|ever[- ]changing|modern|digital) world,?\s*/gi, use: '', label: 'stock opener' },
  { find: /\bin the (?:ever[- ]evolving|ever[- ]changing) (?:world|landscape|realm) of\s+/gi, use: 'in ', label: 'stock opener' },
  { find: /\bin conclusion,?\s*/gi, use: '', label: 'essay scaffolding' },
  { find: /\bin summary,?\s*/gi, use: '', label: 'essay scaffolding' },
  { find: /\bto sum up,?\s*/gi, use: '', label: 'essay scaffolding' },
  { find: /\bembark on a journey\b/gi, use: 'start', label: 'stock metaphor' },
  { find: /\bnavigat(e|ing) the (?:complexities|intricacies|nuances) of\b/gi, use: (m, g1) => (g1 === 'e' ? 'work through' : 'working through'), label: 'stock metaphor' },
  { find: /\bunlock the (?:power|potential|secrets) of\b/gi, use: 'get more from', label: 'stock metaphor' },
  { find: /\bshed light on\b/gi, use: 'clarify', label: 'stock metaphor' },
  { find: /\ba testament to\b/gi, use: 'proof of', label: 'stock metaphor' },
  { find: /\ba (?:rich |vibrant )?tapestry of\b/gi, use: 'a mix of', label: 'stock metaphor' },
  { find: /\bthe (?:landscape|realm|world) of\b/gi, use: '', label: 'padding' },
  { find: /\bdelve into\b/gi, use: 'dig into', label: 'overused verb' },
  { find: /\bdelving into\b/gi, use: 'digging into', label: 'overused verb' },
  { find: /\bwhen it comes to\b/gi, use: 'with', label: 'padding' },
  { find: /\bplays? a (?:crucial|vital|key|pivotal|significant) role in\b/gi, use: 'is key to', label: 'padding' },
  { find: /\bserves? as a\b/gi, use: 'is a', label: 'padding' },
  { find: /\bat the end of the day,?\s*/gi, use: '', label: 'padding' },
  { find: /\bmoreover,?\s*/gi, use: "What's more, ", label: 'stiff connective' },
  { find: /\bfurthermore,?\s*/gi, use: 'Also, ', label: 'stiff connective' },
  { find: /\badditionally,?\s*/gi, use: 'Also, ', label: 'stiff connective' },
  { find: /\bnevertheless,?\s*/gi, use: 'Still, ', label: 'stiff connective' },
  { find: /\bhence,?\s*/gi, use: 'So, ', label: 'stiff connective' },
  { find: /\bthereby\b/gi, use: 'so', label: 'stiff connective' },
  { find: /\bin the realm of\b/gi, use: 'in', label: 'padding' },
];

// Phrases that talk about the writing instead of saying the thing.
export const SELF_REFERENCE = [
  /\bin this (?:article|post|essay|piece|guide|blog|section|chapter)\b/gi,
  /\bthis (?:article|post|essay|piece|guide|blog) (?:will|aims to|seeks to|explores|discusses|covers)\b/gi,
  /\bas (?:mentioned|stated|discussed|noted) (?:above|earlier|previously|below)\b/gi,
  /\bwe will (?:explore|discuss|examine|look at|cover)\b/gi,
  /\blet(?:'s| us) (?:explore|dive|delve)\b/gi,
  /\bthe following (?:section|paragraph|list)\b/gi,
  /\bas an ai\b/gi,
  /\bi (?:cannot|can't|am unable to) (?:provide|assist)\b/gi,
];

// Light verb + noun where a single verb does the job. Forms are index-aligned:
// [base, third-person, past, gerund].
const LIGHT_VERB_PHRASES = [
  { light: ['make', 'makes', 'made', 'making'], object: 'a decision', verb: ['decide', 'decides', 'decided', 'deciding'] },
  { light: ['make', 'makes', 'made', 'making'], object: 'an announcement', verb: ['announce', 'announces', 'announced', 'announcing'] },
  { light: ['make', 'makes', 'made', 'making'], object: 'a contribution', verb: ['contribute', 'contributes', 'contributed', 'contributing'] },
  { light: ['make', 'makes', 'made', 'making'], object: 'a comparison', verb: ['compare', 'compares', 'compared', 'comparing'] },
  { light: ['make', 'makes', 'made', 'making'], object: 'reference', verb: ['refer', 'refers', 'referred', 'referring'] },
  { light: ['take', 'takes', 'took', 'taking'], object: 'into consideration', verb: ['consider', 'considers', 'considered', 'considering'] },
  { light: ['take', 'takes', 'took', 'taking'], object: 'into account', verb: ['consider', 'considers', 'considered', 'considering'] },
  { light: ['take', 'takes', 'took', 'taking'], object: 'action', verb: ['act', 'acts', 'acted', 'acting'] },
  { light: ['give', 'gives', 'gave', 'giving'], object: 'consideration to', verb: ['consider', 'considers', 'considered', 'considering'] },
  { light: ['give', 'gives', 'gave', 'giving'], object: 'an explanation of', verb: ['explain', 'explains', 'explained', 'explaining'] },
  { light: ['conduct', 'conducts', 'conducted', 'conducting'], object: 'an investigation', verb: ['investigate', 'investigates', 'investigated', 'investigating'] },
  { light: ['conduct', 'conducts', 'conducted', 'conducting'], object: 'an analysis of', verb: ['analyze', 'analyzes', 'analyzed', 'analyzing'] },
  { light: ['conduct', 'conducts', 'conducted', 'conducting'], object: 'a review of', verb: ['review', 'reviews', 'reviewed', 'reviewing'] },
  { light: ['perform', 'performs', 'performed', 'performing'], object: 'an analysis of', verb: ['analyze', 'analyzes', 'analyzed', 'analyzing'] },
  { light: ['provide', 'provides', 'provided', 'providing'], object: 'assistance to', verb: ['help', 'helps', 'helped', 'helping'] },
  { light: ['provide', 'provides', 'provided', 'providing'], object: 'an explanation of', verb: ['explain', 'explains', 'explained', 'explaining'] },
  { light: ['offer', 'offers', 'offered', 'offering'], object: 'an explanation of', verb: ['explain', 'explains', 'explained', 'explaining'] },
  { light: ['carry out', 'carries out', 'carried out', 'carrying out'], object: 'an assessment of', verb: ['assess', 'assesses', 'assessed', 'assessing'] },
  { light: ['reach', 'reaches', 'reached', 'reaching'], object: 'a conclusion', verb: ['conclude', 'concludes', 'concluded', 'concluding'] },
  { light: ['come', 'comes', 'came', 'coming'], object: 'to the realization that', verb: ['realize', 'realizes', 'realized', 'realizing'] },
  { light: ['have', 'has', 'had', 'having'], object: 'an impact on', verb: ['affect', 'affects', 'affected', 'affecting'] },
  { light: ['have', 'has', 'had', 'having'], object: 'a preference for', verb: ['prefer', 'prefers', 'preferred', 'preferring'] },
  { light: ['put', 'puts', 'put', 'putting'], object: 'an emphasis on', verb: ['emphasize', 'emphasizes', 'emphasized', 'emphasizing'] },
  { light: ['place', 'places', 'placed', 'placing'], object: 'an order for', verb: ['order', 'orders', 'ordered', 'ordering'] },
  { light: ['is', 'is', 'was', 'being'], object: 'in agreement with', verb: ['agrees with', 'agrees with', 'agreed with', 'agreeing with'] },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Expand each light-verb entry into four concrete find/replace rules.
export const NOMINALIZATIONS = LIGHT_VERB_PHRASES.flatMap((entry) =>
  entry.light.map((form, i) => ({
    // A trailing "of" belongs to the noun being replaced, so it is swallowed
    // with it: "conducted an investigation of the leak" -> "investigated the
    // leak", not "investigated of the leak".
    find: new RegExp(
      `\\b${escapeRegex(form)}\\s+${escapeRegex(entry.object)}${entry.object.endsWith('of') ? '' : '(?:\\s+of)?'}\\b`,
      'gi',
    ),
    use: entry.verb[i],
  })),
);

// Intensifiers that dilute rather than add. "really" and "pretty" survive the
// cut on purpose: they carry a speaking voice.
export const HEDGES = [
  'very', 'quite', 'rather', 'somewhat', 'fairly', 'relatively', 'basically',
  'essentially', 'actually', 'literally', 'virtually', 'arguably', 'certainly',
  'undoubtedly', 'definitely', 'truly', 'indeed', 'simply', 'clearly',
];

export const EXPANSIONS = [
  // Negations read naturally contracted almost everywhere, so these are not rationed.
  { find: /\bdo not\b/g, use: "don't", always: true },
  { find: /\bdoes not\b/g, use: "doesn't", always: true },
  { find: /\bdid not\b/g, use: "didn't", always: true },
  { find: /\bis not\b/g, use: "isn't", always: true },
  { find: /\bare not\b/g, use: "aren't", always: true },
  { find: /\bwas not\b/g, use: "wasn't", always: true },
  { find: /\bwere not\b/g, use: "weren't", always: true },
  { find: /\bhave not\b/g, use: "haven't", always: true },
  { find: /\bhas not\b/g, use: "hasn't", always: true },
  { find: /\bhad not\b/g, use: "hadn't", always: true },
  { find: /\bwill not\b/g, use: "won't", always: true },
  { find: /\bwould not\b/g, use: "wouldn't", always: true },
  { find: /\bcould not\b/g, use: "couldn't", always: true },
  { find: /\bshould not\b/g, use: "shouldn't", always: true },
  { find: /\bcannot\b/g, use: "can't", always: true },
  { find: /\bcan not\b/g, use: "can't", always: true },
  { find: /\bmust not\b/g, use: "mustn't", always: true },
  // Pronoun contractions are rationed, so the result sounds relaxed, not sloppy.
  { find: /\bI am\b/g, use: "I'm" },
  { find: /\bI will\b/g, use: "I'll" },
  { find: /\bI have\b/g, use: "I've" },
  { find: /\bI would\b/g, use: "I'd" },
  { find: /\byou are\b/gi, use: "you're" },
  { find: /\byou will\b/gi, use: "you'll" },
  { find: /\byou have\b/gi, use: "you've" },
  { find: /\byou would\b/gi, use: "you'd" },
  { find: /\bwe are\b/gi, use: "we're" },
  { find: /\bwe will\b/gi, use: "we'll" },
  { find: /\bwe have\b/gi, use: "we've" },
  { find: /\bwe would\b/gi, use: "we'd" },
  { find: /\bthey are\b/gi, use: "they're" },
  { find: /\bthey will\b/gi, use: "they'll" },
  { find: /\bthey have\b/gi, use: "they've" },
  { find: /\bthey would\b/gi, use: "they'd" },
  { find: /\bit is\b/gi, use: "it's" },
  { find: /\bit will\b/gi, use: "it'll" },
  { find: /\bhe is\b/gi, use: "he's" },
  { find: /\bshe is\b/gi, use: "she's" },
  { find: /\bthat is\b/gi, use: "that's" },
  { find: /\bthere is\b/gi, use: "there's" },
  { find: /\bhere is\b/gi, use: "here's" },
  { find: /\bwhat is\b/gi, use: "what's" },
  { find: /\bwho is\b/gi, use: "who's" },
  { find: /\blet us\b/gi, use: "let's" },
  { find: /\bwould have\b/gi, use: "would've" },
  { find: /\bshould have\b/gi, use: "should've" },
  { find: /\bcould have\b/gi, use: "could've" },
  // "has/have" only contracts safely in front of a participle, so the pattern
  // demands "been" rather than trusting a bare auxiliary.
  { find: /\b(it|he|she|that|there) has been\b/gi, use: (m, g1) => `${g1}'s been`, always: true },
  { find: /\b(I|you|we|they) have been\b/g, use: (m, g1) => `${g1}'ve been`, always: true },
];

export const COORDINATING_CONJUNCTIONS = ['and', 'but', 'for', 'or', 'nor', 'so', 'yet'];

// A clause that opens with one of these is almost certainly independent, which
// is what the comma rule hinges on.
export const SUBJECT_STARTERS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'there', 'here', 'this', 'that',
  'these', 'those', 'who', 'what', 'nobody', 'everyone', 'someone', 'anyone',
  'nothing', 'everything', 'something',
]);

export const FINITE_VERBS = new Set([
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'has', 'have', 'had',
  'do', 'does', 'did', 'will', 'would', 'can', 'could', 'shall', 'should',
  'may', 'might', 'must', 'needs', 'need', 'gets', 'get', 'got', 'goes', 'go',
  'went', 'makes', 'make', 'made', 'takes', 'take', 'took', 'comes', 'come',
  'came', 'seems', 'seem', 'looks', 'look', 'feels', 'feel', 'means', 'mean',
  'stays', 'stay', 'keeps', 'keep', 'works', 'work', 'helps', 'help',
]);

export const DETERMINERS = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'their', 'its', 'his', 'her', 'every',
  'each', 'most', 'some', 'many', 'few', 'both', 'all', 'no', 'one', 'two',
]);

export const NATURAL_TRANSITIONS = [
  'however', 'for example', 'still', 'also', 'then', 'so', 'but', 'and yet',
  'of course', 'that said', 'in other words', 'for instance', 'meanwhile',
  'after all', 'even so', 'better yet', 'on top of that', "what's more",
  'to be fair', 'either way', 'granted', 'instead', 'because of that',
];
