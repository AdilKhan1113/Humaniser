// A rough top-of-the-frequency-list vocabulary. Two jobs:
//   1. the rare-word share in the report (a stand-in for word surprise), and
//   2. deciding whether a capitalised word is a plain noun or somebody's name,
//      which matters when a passive subject slides into object position.
export const COMMON_WORDS = new Set(`
the be to of and a in that have i it for not on with he as you do at this but his by from they
we say her she or an will my one all would there their what so up out if about who get which go me
when make can like time no just him know take people into year your good some could them see other
than then now look only come its over think also back after use two how our work first well way even
new want because any these give day most us man thing woman life child world school state family
student group country problem hand part place case week company system program question work
government number night point home water room mother area money story fact month lot right study
book eye job word business issue side kind head house service friend father power hour game line end
member law car city community name president team minute idea kid body information back parent face
others level office door health person art war history party result change morning reason research
girl guy moment air teacher force education foot boy age policy process music market sense nation
plan college interest death experience effect use class control care field development role effort
rate heart drug show leader light voice wife police mind price report decision son view relationship
town road arm difference value building action model season society tax director position player
record paper space ground form event official matter center couple site project activity star table
need court produce eat american teach oil half situation easy cost industry figure street image
itself phone either data cover quite picture clear practice piece land recent describe product doctor
wall patient worker news test movie certain north love personal open support technology behind
national thousand sell top current stage park sound research trouble energy example rule mistake
mistakes decision decisions result results change changes file files code issue issues question
questions feedback document documents email emails meeting meetings task tasks report reports goal
goals target targets budget page pages window windows cake dinner lunch letter letters message
messages note notes list lists policy policies rules step steps price prices order orders invoice
invoices ticket tickets account accounts payment payments contract contracts draft drafts version
versions update updates feature features bug bugs release releases proposal proposals plan plans
process processes review reviews approval approvals design designs article articles post posts essay
essays story stories chapter chapters photo photos video videos song songs painting paintings
building buildings bridge bridges machine machines device devices tool tools engine engines
`
  .split(/\s+/)
  .filter(Boolean));

/**
 * True when a word is ordinary English rather than a likely proper noun.
 * Plurals are checked against their singular so "mistakes" resolves through
 * "mistake".
 */
export function isCommonWord(word) {
  const w = word.toLowerCase().replace(/[^a-z'-]/g, '');
  if (!w) return false;
  if (COMMON_WORDS.has(w)) return true;
  if (w.endsWith('s') && COMMON_WORDS.has(w.slice(0, -1))) return true;
  if (w.endsWith('es') && COMMON_WORDS.has(w.slice(0, -2))) return true;
  return false;
}
