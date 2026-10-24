import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOutOfCredits, providerOrder, ApiError } from '../src/shared/fallback';
import { questionPriority, mentionsName } from '../src/shared/priority';
import { dueQueue, grade, MASTERY_STREAK } from '../src/shared/schedule';
import { formatDuration, looksLikeQuestion, parseJsonLoose, tokenize, collapseLoops } from '../src/shared/text';

test('tokenize keeps words tappable and punctuation as text', () => {
  const t = tokenize("Kevin, what's your plan?");
  assert.deepEqual(
    t.filter((x) => x.word).map((x) => x.text),
    ['Kevin', "what's", 'your', 'plan'],
  );
  assert.equal(t.map((x) => x.text).join(''), "Kevin, what's your plan?");
});

test('looksLikeQuestion', () => {
  assert.ok(looksLikeQuestion('Where are you from'));
  assert.ok(looksLikeQuestion('You like it here?'));
  assert.ok(!looksLikeQuestion('Today we talk about weekends.'));
});

test('parseJsonLoose handles fences and extra prose', () => {
  assert.deepEqual(parseJsonLoose<{ a: number }>('Sure:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJsonLoose('no json here'));
});

test('formatDuration', () => {
  assert.equal(formatDuration(65_000), '01:05');
  assert.equal(formatDuration(3_725_000), '01:02:05');
});

const base = { isQuestion: true, names: ['Kevin', 'Xu'], mode: 'class' as const, msSinceSelf: null };

test('priority: name or alias means the question is for you', () => {
  assert.equal(questionPriority({ ...base, text: 'Mr. Xu, what do you think about it?' }), 'you');
  assert.equal(questionPriority({ ...base, text: 'kevin what did you do yesterday' }), 'you');
  assert.ok(!mentionsName('Xuan is here', ['Xu']));
});

test('priority: a question that opens by calling someone else is for them', () => {
  assert.equal(questionPriority({ ...base, text: 'Mike, is this yours?' }), 'other');
  assert.equal(questionPriority({ ...base, text: 'Professor, did you learn English for reading?' }), 'other');
  assert.equal(questionPriority({ ...base, text: 'Jay, you vote?' }), 'other');
  assert.equal(questionPriority({ ...base, text: 'Okay, Anna, do you like it?' }), 'other');
  assert.equal(questionPriority({ ...base, text: 'Okay, do you want to try?' }), 'you', 'a filler word is not a name');
  assert.equal(questionPriority({ ...base, text: 'Kevin, do you want to try?' }), 'you');
  assert.equal(questionPriority({ ...base, text: 'Do you want to come with us?', aiTarget: 'other' }), 'other');
});

test('priority: group questions and conversation mode', () => {
  assert.equal(questionPriority({ ...base, text: 'Does anyone know the answer to number three?' }), 'all');
  assert.equal(questionPriority({ ...base, mode: 'chat', text: 'Does anyone like coffee?' }), 'you');
});

test('priority: question right after the learner spoke, short you-questions', () => {
  assert.equal(questionPriority({ ...base, text: 'Oh, what kind of projects do they build there exactly?', msSinceSelf: 5000 }), 'you');
  assert.equal(questionPriority({ ...base, text: 'Where are you from?' }), 'you');
  assert.equal(questionPriority({ ...base, text: 'What is the difference between these two words in this sentence?' }), 'all');
  assert.equal(questionPriority({ ...base, isQuestion: false, text: 'Kevin' }), null);
});

test('schedule: three correct in a row masters, wrong resets and is due now', () => {
  let item = { correctStreak: 0, due: 0, mastered: false, lapses: 0 };
  const now = 1_000_000;
  for (let i = 0; i < MASTERY_STREAK; i++) item = grade(item, true, now);
  assert.equal(item.mastered, true);
  item = grade(item, false, now);
  assert.equal(item.mastered, false);
  assert.equal(item.correctStreak, 0);
  assert.equal(item.due, now);
  assert.equal(item.lapses, 1);
});

test('schedule: due queue orders by due time, then more lapses first', () => {
  const items = [
    { id: 'a', correctStreak: 0, due: 5, mastered: false, lapses: 0 },
    { id: 'b', correctStreak: 0, due: 5, mastered: false, lapses: 2 },
    { id: 'c', correctStreak: 0, due: 1, mastered: false, lapses: 0 },
    { id: 'd', correctStreak: 3, due: 1, mastered: true, lapses: 0 },
    { id: 'e', correctStreak: 0, due: 99, mastered: false, lapses: 0 },
  ];
  assert.deepEqual(dueQueue(items, 10).map((i) => i.id), ['c', 'b', 'a']);
});

test('fallback: OpenRouter first, OpenAI after credits run out', () => {
  assert.deepEqual(providerOrder({ openrouter: 'k', openai: 'k' }, false), ['openrouter', 'openai']);
  assert.deepEqual(providerOrder({ openrouter: 'k', openai: 'k' }, true), ['openai']);
  assert.deepEqual(providerOrder({ openrouter: 'k', openai: '' }, true), ['openrouter']);
  assert.deepEqual(providerOrder({ openrouter: '', openai: '' }, false), []);
  assert.ok(isOutOfCredits(new ApiError('openrouter', 402, 'Payment required')));
  assert.ok(isOutOfCredits(new ApiError('openrouter', 403, 'Insufficient credits')));
  assert.ok(!isOutOfCredits(new ApiError('openai', 402, 'x')));
  assert.ok(!isOutOfCredits(new ApiError('openrouter', 500, 'credits')));
});

test('englishOnly drops English lines with Chinese mixed in', async () => {
  const { englishOnly } = await import('../src/server/service');
  const out = englishOnly([
    { en: 'China is the English name for 中国.', zh: 'x' },
    { en: "I'm from China.", zh: '我来自中国。' },
    { en: '', zh: 'empty' },
  ]);
  assert.deepEqual(out.map((a) => a.en), ["I'm from China."]);
});

test('speech-to-text loops are removed, real repetition in drills is kept', () => {
  const loop = Array(20).fill("I'm not sure if it's correct or not, but I think it's correct.").join(' ');
  assert.equal(collapseLoops(`What is your job? I'm a developer. ${loop} Next one.`), `What is your job? I'm a developer. ${Array(3).fill("I'm not sure if it's correct or not, but I think it's correct.").join(' ')} Next one.`);
  // A two-sentence cycle.
  assert.equal(collapseLoops('Okay. So, talk. Okay. So, talk. Okay. So, talk. Okay. So, talk. Okay. So, talk. Good.'), 'Okay. So, talk. Okay. So, talk. Okay. So, talk. Good.');
  // One word as a whole sentence, 177 times.
  assert.equal(collapseLoops(Array(177).fill('Pharmacy.').join(' ')), 'Pharmacy. Pharmacy. Pharmacy.');
  // Inside one sentence.
  assert.equal(collapseLoops('It is bended bended bended bended bended bended here.'), 'It is bended bended bended here.');
  // Normal speech and a teacher repeating twice are untouched.
  const normal = 'Between. Between. The school is between the library and the park. Barely. Barely. Barely.';
  assert.equal(collapseLoops(normal), normal);
});
