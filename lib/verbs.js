// Turning "the book was read by me" into "I read the book" needs the verb's
// other forms, and English will not hand them over by rule alone. So: an
// explicit table for irregulars, a narrow conjugator for the regulars that
// behave, and a lookup that returns nothing when it is unsure. A miss becomes a
// suggestion in the report rather than a bad rewrite.

// participle -> [past, third-person present, base]
const IRREGULAR = {
  written: ['wrote', 'writes', 'write'],
  taken: ['took', 'takes', 'take'],
  given: ['gave', 'gives', 'give'],
  seen: ['saw', 'sees', 'see'],
  done: ['did', 'does', 'do'],
  eaten: ['ate', 'eats', 'eat'],
  known: ['knew', 'knows', 'know'],
  chosen: ['chose', 'chooses', 'choose'],
  driven: ['drove', 'drives', 'drive'],
  spoken: ['spoke', 'speaks', 'speak'],
  broken: ['broke', 'breaks', 'break'],
  stolen: ['stole', 'steals', 'steal'],
  forgotten: ['forgot', 'forgets', 'forget'],
  hidden: ['hid', 'hides', 'hide'],
  shown: ['showed', 'shows', 'show'],
  grown: ['grew', 'grows', 'grow'],
  thrown: ['threw', 'throws', 'throw'],
  worn: ['wore', 'wears', 'wear'],
  torn: ['tore', 'tears', 'tear'],
  drawn: ['drew', 'draws', 'draw'],
  flown: ['flew', 'flies', 'fly'],
  begun: ['began', 'begins', 'begin'],
  drunk: ['drank', 'drinks', 'drink'],
  sung: ['sang', 'sings', 'sing'],
  rung: ['rang', 'rings', 'ring'],
  swum: ['swam', 'swims', 'swim'],
  run: ['ran', 'runs', 'run'],
  come: ['came', 'comes', 'come'],
  become: ['became', 'becomes', 'become'],
  held: ['held', 'holds', 'hold'],
  sent: ['sent', 'sends', 'send'],
  built: ['built', 'builds', 'build'],
  made: ['made', 'makes', 'make'],
  found: ['found', 'finds', 'find'],
  led: ['led', 'leads', 'lead'],
  kept: ['kept', 'keeps', 'keep'],
  left: ['left', 'leaves', 'leave'],
  meant: ['meant', 'means', 'mean'],
  met: ['met', 'meets', 'meet'],
  paid: ['paid', 'pays', 'pay'],
  read: ['read', 'reads', 'read'],
  said: ['said', 'says', 'say'],
  sold: ['sold', 'sells', 'sell'],
  told: ['told', 'tells', 'tell'],
  taught: ['taught', 'teaches', 'teach'],
  thought: ['thought', 'thinks', 'think'],
  understood: ['understood', 'understands', 'understand'],
  won: ['won', 'wins', 'win'],
  brought: ['brought', 'brings', 'bring'],
  bought: ['bought', 'buys', 'buy'],
  caught: ['caught', 'catches', 'catch'],
  fought: ['fought', 'fights', 'fight'],
  felt: ['felt', 'feels', 'feel'],
  heard: ['heard', 'hears', 'hear'],
  lost: ['lost', 'loses', 'lose'],
  put: ['put', 'puts', 'put'],
  set: ['set', 'sets', 'set'],
  cut: ['cut', 'cuts', 'cut'],
  hit: ['hit', 'hits', 'hit'],
  let: ['let', 'lets', 'let'],
  shut: ['shut', 'shuts', 'shut'],
  spent: ['spent', 'spends', 'spend'],
  stood: ['stood', 'stands', 'stand'],
  struck: ['struck', 'strikes', 'strike'],
  swept: ['swept', 'sweeps', 'sweep'],
  sent_: ['sent', 'sends', 'send'],
  dealt: ['dealt', 'deals', 'deal'],
  slept: ['slept', 'sleeps', 'sleep'],
  sought: ['sought', 'seeks', 'seek'],
  chosen_: ['chose', 'chooses', 'choose'],
};

// Regular bases whose -s and -ed forms follow the plain rules, so no consonant
// doubling and no surprises.
const REGULAR_BASES = [
  'use', 'ask', 'add', 'help', 'move', 'close', 'open', 'start', 'finish',
  'create', 'design', 'review', 'approve', 'reject', 'accept', 'deliver',
  'report', 'publish', 'launch', 'cancel', 'change', 'check', 'collect',
  'compare', 'complete', 'confirm', 'consider', 'cover', 'decide', 'define',
  'describe', 'develop', 'discover', 'discuss', 'explain', 'explore', 'follow',
  'handle', 'ignore', 'improve', 'include', 'increase', 'reduce', 'introduce',
  'invite', 'join', 'kill', 'learn', 'like', 'limit', 'load', 'lock', 'manage',
  'mark', 'mention', 'need', 'notice', 'offer', 'order', 'own', 'paint', 'pass',
  'perform', 'pick', 'place', 'plan', 'play', 'point', 'practice', 'prefer',
  'prepare', 'present', 'prevent', 'produce', 'promise', 'protect', 'prove',
  'provide', 'pull', 'push', 'raise', 'reach', 'receive', 'recommend', 'record',
  'release', 'remember', 'remove', 'repair', 'repeat', 'replace', 'request',
  'require', 'rescue', 'reserve', 'resolve', 'return', 'reveal', 'save',
  'search', 'select', 'sell', 'serve', 'share', 'shape', 'show', 'sign',
  'solve', 'sort', 'spell', 'start', 'store', 'suggest', 'support', 'suppose',
  'surprise', 'talk', 'teach', 'test', 'thank', 'touch', 'train', 'treat',
  'trust', 'turn', 'update', 'upload', 'value', 'view', 'visit', 'vote',
  'wait', 'walk', 'want', 'warn', 'wash', 'watch', 'welcome', 'work', 'yield',
  'apply', 'imply', 'classify', 'notify', 'modify', 'multiply', 'satisfy',
  'qualify', 'justify', 'certify', 'deploy', 'employ', 'enjoy', 'reply',
  'try', 'stay', 'marry', 'hurry', 'assign', 'dismiss', 'express',
  'approach', 'match', 'stop', 'drop', 'plan', 'skip', 'grab', 'clip',
  'refer', 'submit', 'commit', 'admit', 'omit', 'permit', 'occur',
  'demonstrate', 'analyze', 'analyse', 'evaluate', 'investigate', 'indicate',
  'implement', 'determine', 'ensure', 'achieve', 'assess', 'assume',
  'involve', 'calculate', 'communicate', 'coordinate', 'allocate',
  'illustrate', 'integrate', 'interpret', 'construct', 'conclude',
  'distribute', 'contribute', 'convert', 'emphasize', 'optimize',
  'minimize', 'maximize', 'authorize', 'prioritize', 'customize',
  'highlight', 'influence', 'enhance', 'enforce', 'engage', 'exclude',
  'execute', 'exercise', 'expand', 'expose', 'extract', 'forecast',
  'govern', 'grant', 'guarantee', 'inspire', 'instruct', 'interview',
  'manipulate', 'measure', 'mediate', 'moderate', 'navigate', 'observe',
  'overturn', 'oversee', 'populate', 'predict', 'prescribe', 'preserve',
  'prohibit', 'pursue', 'reconcile', 'refine', 'reinforce', 'reject',
  'relocate', 'replicate', 'reproduce', 'resolve', 'restrict', 'retrieve',
  'simulate', 'specify', 'sponsor', 'stimulate', 'structure', 'subsidize',
  'substitute', 'summarize', 'supervise', 'terminate', 'tolerate',
  'transcribe', 'utilize', 'validate', 'verify', 'visualize', 'withdraw',
  'answer', 'appoint', 'arrange', 'attach', 'award', 'balance', 'block',
  'borrow', 'build_', 'burn', 'call', 'capture', 'carry', 'cause', 'celebrate',
  'clean', 'clear', 'climb', 'combine', 'command', 'comment', 'commission',
  'connect', 'contact', 'contain', 'continue', 'control', 'copy', 'correct',
  'count', 'cross', 'damage', 'decorate', 'delay', 'delete', 'demand', 'deny',
  'destroy', 'detect', 'direct', 'disable', 'display', 'divide', 'double',
  'download', 'draft', 'earn', 'edit', 'elect', 'email', 'enable', 'encourage',
  'enter', 'establish', 'estimate', 'examine', 'exchange', 'expect', 'extend',
  'file', 'fill', 'film', 'filter', 'fix', 'form', 'found_', 'fund', 'gather',
  'generate', 'grade', 'greet', 'guard', 'guide', 'hire', 'host', 'identify',
  'imagine', 'import', 'inform', 'insert', 'inspect', 'install', 'insure',
  'invent', 'invest', 'issue', 'judge', 'label', 'lend', 'license', 'lift',
  'list', 'locate', 'maintain', 'market', 'measure', 'merge', 'migrate',
  'monitor', 'name', 'negotiate', 'note', 'number', 'observe', 'obtain',
  'operate', 'organize', 'outline', 'paint_', 'park', 'permit_', 'phone',
  'photograph', 'plant', 'please', 'post', 'pour', 'praise', 'predict',
  'print', 'process', 'promote', 'pronounce', 'propose', 'publish_', 'punish',
  'purchase', 'question', 'quote', 'race', 'rate', 'realize', 'rebuild_',
  'recall', 'recognize', 'reconsider', 'recover', 'recruit', 'refuse',
  'register', 'regulate', 'reinstall', 'relate', 'rely', 'rename', 'rent',
  'reorder', 'repay_', 'rephrase', 'report_', 'reprint', 'rescan', 'reset_',
  'resize', 'restart', 'restore', 'restrict', 'resume', 'retain', 'retry',
  'reuse', 'revert', 'revise', 'reward', 'rewrite_', 'rinse', 'rob', 'roll',
  'rule', 'sample', 'scan', 'schedule', 'score', 'scratch', 'seal', 'season',
  'secure', 'separate', 'settle', 'sew', 'shake_', 'shave', 'shield', 'shift',
  'ship', 'shock', 'shorten', 'shout', 'signal', 'simplify', 'sketch', 'slice',
  'smooth', 'snap', 'soak', 'soften', 'spare', 'spark', 'specify', 'sponsor',
  'spot', 'spray', 'squeeze', 'stack', 'stain', 'stamp', 'staple', 'state',
  'station', 'steer', 'stir', 'stitch', 'stock', 'straighten', 'strain',
  'strengthen', 'stress', 'stretch', 'study', 'style', 'submit_', 'subtract',
  'summarize', 'supervise', 'supply', 'surround', 'survey', 'suspend',
  'sustain', 'swap', 'switch', 'tackle', 'tag', 'tailor', 'tape', 'target',
  'taste', 'tax', 'tell_', 'tempt', 'tender', 'thread', 'tidy', 'tighten',
  'tilt', 'time', 'tip', 'title', 'toast', 'total', 'trace', 'track', 'trade',
  'transfer_', 'transform', 'translate', 'transport', 'trim', 'triple',
  'trigger', 'tune', 'twist', 'uncover', 'underline', 'undo_', 'unify',
  'unlock', 'unpack', 'unplug', 'unwrap', 'validate', 'vary', 'verify',
  'video', 'void', 'wrap', 'weigh', 'widen', 'wipe', 'wire', 'witness',
  'wonder', 'worry', 'wound', 'zip',
];

function thirdPerson(base) {
  if (/(?:s|x|z|ch|sh|o)$/.test(base)) return `${base}es`;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  return `${base}s`;
}

// Verbs of more than one syllable that double the final consonant. Single
// syllable consonant-vowel-consonant words are caught by rule below.
const DOUBLE_FINAL = new Set([
  'submit', 'permit', 'control', 'refer', 'prefer', 'occur', 'regret',
  'admit', 'commit', 'omit', 'transmit', 'patrol', 'propel', 'compel',
  'expel', 'rebel', 'forbid', 'begin', 'prefer', 'infer', 'deter',
]);

function pastTense(base) {
  if (base.endsWith('e')) return `${base}d`;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ied`;
  // stop -> stopped, ship -> shipped, but not fix, snow or play
  const singleSyllableCVC = /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(base);
  if (singleSyllableCVC || DOUBLE_FINAL.has(base)) {
    return `${base}${base.slice(-1)}ed`;
  }
  return `${base}ed`;
}

// participle -> { past, present3, base }
export const PARTICIPLES = new Map();

for (const [participle, [past, present3, base]] of Object.entries(IRREGULAR)) {
  // Trailing underscores only exist to keep duplicate keys apart in the source.
  PARTICIPLES.set(participle.replace(/_$/, ''), { past, present3, base });
}

for (const raw of REGULAR_BASES) {
  const base = raw.replace(/_$/, '');
  const participle = pastTense(base);
  if (PARTICIPLES.has(participle)) continue; // an irregular already claimed it
  PARTICIPLES.set(participle, { past: participle, present3: thirdPerson(base), base });
}

export const BE_FORMS = new Map(Object.entries({
  is: 'present',
  are: 'present-plural',
  'was': 'past',
  'were': 'past',
  'has been': 'past',
  'have been': 'past',
  'had been': 'past',
  'will be': 'future',
  'can be': 'modal-can',
  'must be': 'modal-must',
  'being': 'progressive',
  'be': 'bare',
}));

/**
 * Picks the active form of the verb for a given "be" form. Returns null when the
 * pairing is not safe to rewrite.
 *
 * In the present tense the verb has to agree with the *new* subject, which is
 * the old agent, so plurality is passed in rather than read off the be-verb:
 * "is used by thousands of people" becomes "thousands of people use", not "uses".
 */
export function activeForm(participle, beForm, pluralSubject = false) {
  const lower = participle.toLowerCase();
  const tense = BE_FORMS.get(beForm.toLowerCase());
  const forms = PARTICIPLES.get(lower);

  if (!forms) {
    // Every regular verb spells its past tense and its past participle the same
    // way, so "was <anything>ed by X" flips safely even for a verb this table
    // has never seen. The present tense needs the base form, which cannot be
    // recovered from "-ed" without guessing, so that case stays unhandled.
    if (tense === 'past' && lower.length > 4 && lower.endsWith('ed')) return lower;
    return null;
  }

  switch (tense) {
    case 'past':
      return forms.past;
    case 'present':
    case 'present-plural':
      return pluralSubject ? forms.base : forms.present3;
    case 'future':
      return `will ${forms.base}`;
    case 'modal-can':
      return `can ${forms.base}`;
    case 'modal-must':
      return `must ${forms.base}`;
    default:
      return null;
  }
}

export function isKnownParticiple(word) {
  return PARTICIPLES.has(word.toLowerCase());
}

// Every form the table knows about, in one set. The comma rule uses it to tell
// a second independent clause ("and the board approved it") from a list tail
// ("and the oranges").
export const VERB_FORMS = new Set();
for (const [participle, forms] of PARTICIPLES) {
  VERB_FORMS.add(participle);
  VERB_FORMS.add(forms.past);
  VERB_FORMS.add(forms.present3);
  VERB_FORMS.add(forms.base);
}
