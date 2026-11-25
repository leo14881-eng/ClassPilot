// Is a transcribed line English? The speech model sometimes guesses another language for accented speech,
// classmates speaking Vietnamese or plain noise, and then writes Japanese, Thai, Arabic, German, Indonesian…
// ("ジャケット", "Ich hab keine Zeit.", "Ini kaya aku di mana."). Such lines are re-heard as English or dropped.
// No dictionary download: the most common English words make up most of any English sentence, so a sentence
// where few of its words are common English words is not English.

const COMMON = new Set(
  `a about above across after again against ago all almost alone along already also always am among an and another any anyone anything are
  area around as ask asked at away back bad be because become bed been before begin behind being believe below best better between big bit
  black blue body book both bottom box boy break bring brother brown but buy by call called came can can't car card care carry case cat
  change check child children city class clean close clothes cold color colour come comes coming cook cool correct could count country course
  cup cut dad day days dear did didn't different do does doesn't dog doing don't done door down drink drive during each ear early easy eat
  eight eleven else end english enough even evening ever every everyone everything example excuse eye eyes face family far fast father favorite
  feel few fifteen fifty find fine finish first five floor food foot for four free friday friend friends from front full fun game gave get
  gets getting girl give go goes going gone good got great green group grow had hair half hand happy hard has have haven't having he head
  hear heard hello help her here hi high him his hold home hope hot hour house how hundred hungry i i'm i've idea if in into is isn't it
  it's its job just keep kind know last late later learn least leave left leg less let let's letter life like likes listen little live long
  look looking lot love lunch made make man many may maybe me mean meet men might mind minute minutes miss mom monday money more morning most
  mother mouth move much mum music must my name near need never new next nice night nine no not nothing now number of off often oh ok okay
  old on once one only open or orange other our out over own page paper part people person phone pick picture place play please point pretty
  put question quick quiet rain read ready really red remember right room run said same saturday say says school second see seven she shoe
  shoes shop short should show sister sit six sleep slow small so some someone something sometimes song soon sorry sound speak start stay
  still stop story student students study sunday sure table take talk teacher tell ten than thank thanks that that's the their them then
  there there's these they thing things think third thirty this those three through thursday time to today together told tomorrow too took
  top toward try tuesday turn twelve twenty two under understand until up us use used usually very wait walk want wanted was wasn't watch water
  way we we're wear wednesday week weekend well went were what what's when where which white who whose why will window with without woman
  women word words work world would write wrong yeah year years yellow yes yesterday yet you you're your yours
  arm back bag birthday bread brush buy cake chair cheap chicken coffee dance dinner doctor dress egg eggs expensive fish fruit hat hobby
  hobbies hospital hotel jacket kitchen lamp market meat milk nose pain park pen pencil percent price rice sale shirt shopping size skirt
  sofa sport sports store sugar sweater tea teeth tooth trousers weather yourself myself hmm mm uh um`.split(/\s+/),
);

const LETTERS = /\p{L}/u;
const ASCII_WORD = /^[a-z][a-z']*$/;

/** True when the text is written in English (or is too short to tell and uses only plain English letters). */
export function looksEnglish(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Any letter outside basic Latin (Japanese, Thai, Arabic, Vietnamese tones, German ß…) is not an English caption,
  // except for a rare accented loanword (café) inside an otherwise English sentence.
  const letters = [...t].filter((c) => LETTERS.test(c));
  if (!letters.length) return /\d/.test(t); // "26." is fine
  const foreign = letters.filter((c) => c > 'ɏ' || /[^\x00-\x7f]/.test(c)).length;
  if (foreign / letters.length > 0.05) return false;
  const words = t
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[^a-z'À-ɏ]+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
  if (words.length <= 1) return words.every((w) => ASCII_WORD.test(w));
  const known = words.filter((w) => COMMON.has(w) || COMMON.has(w.replace(/(s|es|ed|ing|'s)$/, ''))).length;
  return known / words.length >= 0.5;
}

/** Keep only the English sentences of a longer transcript (a whole-class recording). */
export function englishSentences(text: string): string {
  return text
    .split(/(?<=[.?!。？！])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s && looksEnglish(s))
    .join(' ');
}
