// End-to-end test of the server with a fake AI provider: login, start a class, analyse lines,
// upload audio, end class, post-class review, review items, OpenRouter -> OpenAI fallback.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Ai } from '../src/server/ai';
import { DEFAULT_CONFIG, type ServerConfig } from '../src/server/config';
import { Store } from '../src/server/db';
import { checkToken, createApp, makeToken } from '../src/server/http';
import { accentAlike, sameAnswer, sentenceAlike, Service, soundKey, soundsAlike } from '../src/server/service';

const calls: { url: string; auth: string }[] = [];
let openrouterBroke = false;

function reply(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
}

const sttCalls: { model?: string; language?: string; input_audio?: { format?: string } }[] = [];

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
  calls.push({ url, auth });
  if (url.includes('openrouter') && openrouterBroke) return new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 });
  if (url.endsWith('/credits')) return new Response(JSON.stringify({ data: { total_credits: 45, total_usage: 2.68 } }), { status: 200 });
  if (url.endsWith('/audio/transcriptions') && url.includes('openrouter')) sttCalls.push(JSON.parse(String(init?.body ?? '{}')));
  if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'Kevin, what do you do on the weekend? I play football.' }), { status: 200 });
  const body = JSON.parse(String(init?.body ?? '{}'));
  const system: string = body.messages?.[0]?.content ?? '';
  const user: string = body.messages?.[1]?.content ?? '';
  if (system.includes('live English class') || system.includes('small-group')) {
    const utt = user.split('New utterance:')[1] ?? user;
    const isQ = utt.includes('?');
    const toOther = utt.includes('Anna');
    return reply({ zh: '翻译', isQuestion: isQ, target: toOther ? 'other' : isQ ? 'you' : null, isSelf: utt.includes('I play'), questionZh: '老师在问：你周末做什么？', answers: [{ en: 'I usually stay home.', zh: '我一般在家。' }, { en: 'I go to a cafe.', zh: '我去咖啡店。' }] });
  }
  if (system.includes('turning a recorded class')) {
    return reply({
      summaryZh: '周末活动',
      points: [{ title: 'I usually + verb', detailZh: '表示习惯', examples: ['I usually stay home.'] }],
      vocab: [{ en: 'weekend', ipa: '/ˌwiːkˈend/', zh: '周末', example: 'See you at the weekend.' }],
      questions: [{ asker: 'teacher', en: 'What do you do on the weekend?', zh: '你周末做什么？', answers: [{ en: 'I play football.', zh: '我踢足球。' }] }],
      myCorrections: [{ said: 'I play football in weekend.', better: 'I play football on the weekend.', whyZh: '用 on the weekend' }],
      dialogues: [],
    });
  }
  if (system.includes("today's 10 new English words")) {
    const words = ['order', 'receipt', 'change', 'menu', 'bill', 'spicy', 'takeaway', 'meeting', 'deadline', 'deploy', 'weekend'].map((en, i) => ({
      en, ipa: '/x/', zh: '词', category: i >= 7 ? 'work' : 'life', example: `I need the ${en}.`, exampleZh: '例句',
    }));
    return reply({ words });
  }
  if (system.includes('speaking examiner')) {
    return reply({ grammar: 60, vocabulary: 70, fluency: 65, understanding: 90, total: 74, commentZh: '能听懂，回答清楚。', strengthsZh: ['回答切题'], improveZh: ['注意过去式：I went'] });
  }
  if (system.includes('conversation partner')) {
    const said = user.split("Learner's latest sentence:")[1] ?? '';
    return reply({
      reply: { en: 'Nice! What do you usually drink?', zh: '不错！你一般喝什么？' },
      correction: said.includes('I go to coffee yesterday') ? { said: 'I go to coffee yesterday.', better: 'I went to a coffee shop yesterday.', whyZh: '昨天用过去式 went' } : null,
      suggestions: [{ en: 'I usually drink iced coffee.', zh: '我一般喝冰咖啡。' }, { en: 'I like milk tea.', zh: '我喜欢奶茶。' }],
    });
  }
  if (system.includes('review drill')) {
    const ok = /Learner's answer[^:]*: I'd like breakfast/.test(user);
    return reply({ correct: ok, feedbackZh: ok ? '对了' : '时态不对', better: ok ? '' : 'I had breakfast.' });
  }
  if (system.includes('explain one English word')) return reply({ word: 'routine', ipa: '/ruːˈtiːn/', pos: '名词', zh: '日常惯例', explain: '每天固定做的事', example: { en: 'I have a morning routine.', zh: '我早上有固定习惯。' }, inContext: '固定安排' });
  return reply({ answerZh: '意思是周末', say: [{ en: 'On weekends, I code.', zh: '周末我写代码。' }], words: [{ en: 'weekend', zh: '周末' }] });
}) as typeof fetch;

let base = '';
let cookie = '';
let close: () => void = () => {};
let store: Store;
let service: Service;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-'));
  const staticDir = join(dir, 'static');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>ClassPilot</title>');
  const cfg: ServerConfig = { ...DEFAULT_CONFIG, dataDir: dir, staticDir, passcode: 'secret-123', openrouterKey: 'or-key', openaiKey: 'oa-key' };
  store = new Store(':memory:');
  const ai = new Ai(cfg, store, fakeFetch);
  service = new Service(store, ai, dir, 0);
  process.env.CLASSPILOT_INSECURE_COOKIE = '1';
  const server = createApp({ cfg, store, ai, service });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/${path}`, {
    method,
    headers: { ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}

test('token signing', () => {
  const key = Buffer.from('k'.repeat(32));
  assert.ok(checkToken(key, makeToken(key)));
  assert.ok(!checkToken(key, makeToken(key, Date.now() - 400 * 86_400_000)));
  assert.ok(!checkToken(key, 'x.y'));
});

test('API requires the passcode', async () => {
  assert.equal((await api('GET', 'sessions')).status, 401);
  assert.equal((await api('POST', 'login', { passcode: 'wrong' })).status, 401);
  const ok = await api('POST', 'login', { passcode: 'secret-123' });
  assert.equal(ok.status, 200);
  cookie = (ok.res.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie.startsWith('cp_session='));
  assert.equal((await api('GET', 'me')).status, 200);
});

test('static app is served', async () => {
  const res = await fetch(`${base}/review/abc`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ClassPilot/);
});

test('full class flow: live lines, audio, post-class review, items', async () => {
  const s = (await api('POST', 'sessions', { school: 'WSE', topic: 'Weekends', mode: 'class', deepReview: true })).data;
  assert.equal(s.school, 'WSE');

  const lecture = (await api('POST', `sessions/${s.id}/lines`, { id: 'l1', t: 1000, en: 'Today we talk about weekends.' })).data;
  assert.equal(lecture.kind, 'lecture');
  assert.equal(lecture.zh, '翻译');

  const q = (await api('POST', `sessions/${s.id}/lines`, { id: 'l2', t: 2000, en: 'Kevin, what do you do on the weekend?' })).data;
  assert.equal(q.kind, 'question');
  assert.equal(q.priority, 'you');
  assert.equal(q.answers.length, 2);

  const self = (await api('POST', `sessions/${s.id}/lines`, { id: 'l3', t: 3000, en: 'I play football.' })).data;
  assert.equal(self.kind, 'self');

  // A question clearly asked to another classmate still gets answers, marked 'other' (shown greyed).
  const other = (await api('POST', `sessions/${s.id}/lines`, { id: 'l4', t: 60000, en: 'Anna, what is the meaning of this long sentence on the board?' })).data;
  assert.equal(other.kind, 'question');
  assert.equal(other.priority, 'other');
  assert.equal(other.answers.length, 2);

  const up = await api('PUT', `sessions/${s.id}/audio/0`, new Uint8Array([1, 2, 3, 4]), { 'Content-Type': 'audio/mp4', 'X-Started-At': String(Date.now()) });
  assert.equal(up.status, 200);

  const ended = (await api('POST', `sessions/${s.id}/end`)).data;
  assert.equal(ended.status, 'processing');
  for (let i = 0; i < 50; i++) {
    const cur = (await api('GET', `sessions/${s.id}`)).data;
    if (cur.session.status !== 'processing') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const detail = (await api('GET', `sessions/${s.id}`)).data;
  assert.equal(detail.session.status, 'done', detail.session.statusNote);
  assert.equal(detail.review.vocab[0].en, 'weekend');
  assert.equal(detail.lines.length, 4);
  assert.ok(detail.review.transcript.length >= 2);

  const items = (await api('GET', 'items')).data as { type: string; en: string; id: string }[];
  assert.ok(items.some((i) => i.type === 'word' && i.en === 'weekend'));
  assert.ok(items.some((i) => i.type === 'correction' && i.en === 'I play football on the weekend.'));

  const graded = (await api('POST', `items/${items[0].id}/grade`, { correct: true })).data;
  assert.equal(graded.correctStreak, 1);
});

test('starting a new class ends one that was left open', async () => {
  const a = (await api('POST', 'sessions', { school: 'ILA', topic: '', mode: 'class', deepReview: false })).data;
  await api('POST', `sessions/${a.id}/lines`, { id: 'a1', t: 1000, en: 'Hello everyone.' });
  const b = (await api('POST', 'sessions', { school: 'ILA', topic: '', mode: 'class', deepReview: false })).data;
  assert.equal((await api('GET', `sessions/${a.id}`)).data.session.status, 'done');
  assert.equal((await api('GET', `sessions/${b.id}`)).data.session.status, 'live');
  assert.ok(b.lastActivityAt > 0);
  await api('POST', `sessions/${b.id}/end`);
});

test('switching mode mid-class keeps one class; later lines use the new mode', async () => {
  const c = (await api('POST', 'sessions', { school: 'ILA', topic: 'Mix', mode: 'class', deepReview: false })).data;
  const l1 = (await api('POST', `sessions/${c.id}/lines`, { id: 'm1', t: 1000, en: 'What is a verb?' })).data;
  assert.equal(l1.mode, 'class');
  const switched = (await api('PATCH', `sessions/${c.id}`, { mode: 'chat' })).data;
  assert.equal(switched.mode, 'chat');
  assert.equal(switched.id, c.id);
  const l2 = (await api('POST', `sessions/${c.id}/lines`, { id: 'm2', t: 90000, en: 'Does anyone here like coffee?' })).data;
  assert.equal(l2.mode, 'chat');
  assert.equal(l2.priority, 'you');
  await api('POST', `sessions/${c.id}/end`);
});

test('delete moves a class to the bin, restore brings it back, purge after 30 days', async () => {
  const c = (await api('POST', 'sessions', { school: 'WSE', topic: 'Bin test', mode: 'class', deepReview: false })).data;
  await api('POST', `sessions/${c.id}/lines`, { id: 'b1', t: 1000, en: 'Open your books.' });
  await api('POST', `sessions/${c.id}/end`);
  // Give this class one review item, which must leave the queue on delete and come back on restore.
  store.addItems([{ id: 'bin-item', type: 'word', en: 'binword', zh: '测试', source: { sessionId: c.id, date: '2026-10-19', origin: 'class' }, correctStreak: 0, lapses: 0, due: 0, mastered: false, createdAt: 0 }]);
  const d = (await api('DELETE', `sessions/${c.id}`)).data;
  assert.ok(d.deletedAt > 0);
  assert.ok(!store.allItems().some((i) => i.en === 'binword'));
  assert.ok(!(await api('GET', 'sessions')).data.some((s: { id: string }) => s.id === c.id));
  assert.ok((await api('GET', 'sessions/bin')).data.some((s: { id: string }) => s.id === c.id));
  await api('POST', `sessions/${c.id}/restore`);
  assert.ok((await api('GET', 'sessions')).data.some((s: { id: string }) => s.id === c.id));
  assert.ok(store.allItems().some((i) => i.en === 'binword'));
  await api('DELETE', `sessions/${c.id}`);
  assert.equal(service.purgeDeleted(Date.now() + 31 * 86_400_000), 1);
  assert.equal((await api('GET', `sessions/${c.id}`)).status, 404);
  assert.ok(!store.allItems().some((i) => i.en === 'binword'));
  assert.equal(store.kvGet(`bin-items:${c.id}`), undefined);
});

test('ask and word lookup add review items without duplicates', async () => {
  const before = store.itemCounts().total;
  const a = (await api('POST', 'ask', { question: 'weekend 什么意思' })).data;
  assert.equal(a.say[0].en, 'On weekends, I code.');
  const w = (await api('POST', 'word', { word: 'routine', sentence: 'Most people have a routine.' })).data;
  assert.equal(w.ipa, '/ruːˈtiːn/');
  // 'weekend' word already existed from the class review, so it is not added twice.
  assert.equal(store.itemCounts().total, before + 2);
});

test('OpenRouter balance used up -> calls move to OpenAI', async () => {
  openrouterBroke = true;
  calls.length = 0;
  const a = await api('POST', 'ask', { question: 'hello?' });
  assert.equal(a.status, 200);
  assert.ok(calls.some((c) => c.url.includes('openrouter')));
  assert.ok(calls.some((c) => c.url.includes('api.openai.com') && c.auth === 'Bearer oa-key'));
  const status = (await api('GET', 'status')).data;
  assert.equal(status.active, 'openai');
  assert.equal(status.openrouterExhausted, true);
  openrouterBroke = false;
  const reset = (await api('POST', 'status/reset-openrouter')).data;
  assert.equal(reset.active, 'openrouter');
  assert.equal(reset.openrouterRemaining, 42.32);
});

test('conversation practice: starts the role-play, corrects mistakes into review', async () => {
  const first = (await api('POST', 'talk', { scenarioId: 'coffee', history: [], said: '' })).data;
  assert.equal(first.correction, null);
  assert.equal(first.suggestions.length, 2);
  const before = store.itemCounts().total;
  const r = (await api('POST', 'talk', { scenarioId: 'coffee', history: [{ who: 'ai', en: first.reply.en }], said: 'I go to coffee yesterday.' })).data;
  assert.equal(r.correction.better, 'I went to a coffee shop yesterday.');
  assert.equal(store.itemCounts().total, before + 1);
});

test('daily plan: 10 new words once a day, added to review, scenario and progress', async () => {
  const p1 = (await api('GET', 'plan')).data;
  // 'weekend' already exists from the class review, so it is skipped and 10 remain.
  assert.equal(p1.words.length, 10);
  assert.ok(!p1.words.some((w: { en: string }) => w.en === 'weekend'));
  assert.equal(p1.words.filter((w: { category: string }) => w.category === 'work').length, 3);
  assert.ok(store.allItems().some((i) => i.en === 'receipt' && i.source.origin === 'plan'));
  const receipt = store.allItems().find((i) => i.en === 'receipt')!;
  assert.ok(receipt.due > Date.now(), 'plan words are first tested tomorrow');
  const p2 = (await api('GET', 'plan')).data;
  assert.deepEqual(p2.words.map((w: { en: string }) => w.en), p1.words.map((w: { en: string }) => w.en));
  assert.ok(p1.scenario.id);
  assert.equal(p1.progress.scenarioTotal, 28);
});

test('checking a review answer: exact match locally, otherwise AI judges, nothing graded yet', async () => {
  const receipt = store.allItems().find((i) => i.en === 'receipt')!;
  const callsBefore = calls.length;
  const exact = (await api('POST', `items/${receipt.id}/check`, { answer: 'Receipt.' })).data;
  assert.equal(exact.correct, true);
  assert.equal(calls.length, callsBefore, 'exact answers need no AI call');
  const wrong = (await api('POST', `items/${receipt.id}/check`, { answer: 'I have breakfast' })).data;
  assert.equal(wrong.correct, false);
  assert.equal(wrong.better, 'I had breakfast.');
  const ok = (await api('POST', `items/${receipt.id}/check`, { answer: "I'd like breakfast" })).data;
  assert.equal(ok.correct, true);
  assert.equal(store.getItem(receipt.id)!.correctStreak, 0, 'check does not grade');
  assert.equal((await api('POST', 'items/nope/check', { answer: 'x' })).status, 404);
});

test('soundsAlike: accent-level differences on single words only, never a missing word', () => {
  assert.ok(soundsAlike('meetin', 'meeting'));
  assert.ok(soundsAlike('Rains.', 'rain'));
  assert.ok(soundsAlike('bus stops', 'bus stop'));
  assert.ok(!soundsAlike('lunch', 'breakfast'));
  assert.ok(!soundsAlike('stop', 'bus stop'));
  assert.ok(!soundsAlike('I am from China', 'I am from China.'.replace('am ', '')), 'sentences are left to the judge');
});

test('accentAlike: Chinese-accent sound mix-ups count, different words do not', () => {
  for (const heard of ['Lane.', 'Rhine', 'Ren', 'rains', 'lain']) assert.ok(accentAlike(heard, 'rain'), heard);
  for (const heard of ['Mitting', 'meat in', 'meetin']) assert.ok(accentAlike(heard, 'meeting'), heard);
  assert.ok(accentAlike('head egg', 'headache'));
  assert.ok(accentAlike('bass stop', 'bus stop'));
  for (const [heard, word] of [['snow', 'rain'], ['eating', 'meeting'], ['password', 'passport'], ['lunch', 'breakfast'], ['price', 'prize']]) {
    assert.ok(!accentAlike(heard, word) || soundKey(heard) === soundKey(word), `${heard}/${word}`);
  }
  assert.ok(!accentAlike('snow', 'rain'));
  assert.ok(!accentAlike('eating', 'meeting'));
  assert.ok(!accentAlike('password', 'passport'));
  assert.ok(!accentAlike('I am from China', 'I am from China'), 'sentences go to the judge');
});

test('sentenceAlike: word-for-word sound match, strict on grammar and missing words', () => {
  assert.ok(sentenceAlike("It's hard to be afforded for that", "It's hard to be faulted for that"));
  assert.ok(sentenceAlike('I lan home', 'I ran home'), 'r/l accent slip');
  assert.ok(!sentenceAlike('I run home yesterday', 'I ran home yesterday'), 'present instead of past is a real mistake');
  assert.ok(!sentenceAlike('He eat breakfast', 'He eats breakfast'), 'missing -s is a real mistake');
  assert.ok(!sentenceAlike('I go to school yesterday', 'I went to school yesterday'));
  assert.ok(!sentenceAlike('The researchers find that', 'The researchers found that'), 'tense change');
  assert.ok(!sentenceAlike('I want coffee', 'I want a coffee'), 'missing word');
  assert.ok(sentenceAlike('I lead a book', 'I read a book'));
  assert.ok(sentenceAlike("I'm from China", 'I am from China'));
});

test('sameAnswer ignores case, punctuation and contractions', () => {
  assert.ok(sameAnswer("I'm from China.", 'i am from china'));
  assert.ok(sameAnswer("I don't know", 'I do not know!'));
  assert.ok(!sameAnswer('I am from Japan', 'I am from China'));
  assert.ok(!sameAnswer('', ''));
});

test('speech to text: measured models, second opinion for practice answers, iPhone audio sent as m4a', async () => {
  const tiny = await api('POST', 'stt?lang=en', new Uint8Array(100), { 'Content-Type': 'audio/mp4' });
  assert.equal(tiny.data.text, '', 'a click or empty recording is ignored');
  let before = sttCalls.length;
  const r = await api('POST', 'stt?lang=en&second=1', new Uint8Array(5000), { 'Content-Type': 'audio/mp4' });
  assert.equal(r.status, 200);
  assert.ok(r.data.text.length > 0);
  const models = sttCalls.slice(before).map((c) => c.model).sort();
  assert.deepEqual(models, ['elevenlabs/scribe-v2', 'openai/whisper-large-v3-turbo']);
  assert.ok(sttCalls.slice(before).every((c) => c.input_audio?.format === 'm4a' && c.language === 'en'));
  assert.ok(Array.isArray(r.data.alts));
  before = sttCalls.length;
  await api('POST', 'stt?lang=zh', new Uint8Array(5000), { 'Content-Type': 'audio/mp4' });
  assert.deepEqual(sttCalls.slice(before).map((c) => [c.model, c.language]), [['openai/gpt-4o-transcribe', 'zh']]);
  before = sttCalls.length;
  await api('POST', 'stt?lang=en&live=1', new Uint8Array(5000), { 'Content-Type': 'audio/wav' });
  assert.deepEqual(sttCalls.slice(before).map((c) => [c.model, c.input_audio?.format]), [['elevenlabs/scribe-v2', 'wav']]);
  assert.equal((await api('POST', 'stt', new Uint8Array(5000), { 'Content-Type': 'text/plain' })).status, 400);
  const log = (await api('GET', 'voicelog')).data;
  assert.ok(log.stt.some((e: { clip?: string }) => e.clip), 'practice clips are kept for diagnosis');
  const clip = log.stt.find((e: { clip?: string }) => e.clip).clip;
  assert.equal((await api('GET', `voicelog/${clip}`)).status, 200);
});

test('spoken answer in one round trip: transcribe, judge, report what was heard', async () => {
  const item = store.allItems().find((i) => i.en === 'receipt')!;
  const r = (await api('POST', `items/${item.id}/check-audio`, new Uint8Array(5000), { 'Content-Type': 'audio/wav' })).data;
  assert.ok(r.heard.length > 0);
  assert.equal(typeof r.correct, 'boolean');
  assert.equal(store.getItem(item.id)!.correctStreak, item.correctStreak, 'checking does not grade');
  assert.equal((await api('POST', `items/${item.id}/check-audio`, new Uint8Array(5000), { 'Content-Type': 'text/plain' })).status, 400);
});

test('judging spoken answers: accent-level slips pass, real mistakes fail, second recognizer counts', async () => {
  const chk = async (en: string, answer: string, alts: string[] = []) => (await api('POST', 'check-text', { type: 'pattern', en, zh: '', answer, spoken: true, alts })).data;
  assert.equal((await chk('rain', 'Lane.')).correct, true);
  assert.equal((await chk('It was hard to be faulted for that', 'It was hard to be afforded for that')).correct, true);
  // the first recognizer misheard, the second got it
  assert.equal((await chk('I like coffee', 'I lie coffee', ['I like coffee.'])).correct, true);
});

test('ask keeps the chat context for follow-up questions', async () => {
  const before = calls.length;
  await api('POST', 'ask', { question: '那过去式呢', history: [{ q: '吃早餐英语怎么说', a: 'have breakfast' }] });
  assert.equal(calls.length, before + 1);
});

test('scoring a conversation: needs 3 turns, saved, scenario counts as passed', async () => {
  const short = await api('POST', 'talk/score', { scenarioId: 'intro', kind: 'scenario', history: [{ who: 'me', en: 'Hi' }] });
  assert.equal(short.status, 400);
  const history = [
    { who: 'ai', en: 'Hi! What is your name?' }, { who: 'me', en: 'My name is Kevin.' },
    { who: 'ai', en: 'Where are you from?' }, { who: 'me', en: 'I am from China.' },
    { who: 'ai', en: 'What do you do?' }, { who: 'me', en: 'I am a developer.' },
  ];
  const sc = (await api('POST', 'talk/score', { scenarioId: 'intro', kind: 'test', history })).data;
  assert.equal(sc.total, 74);
  assert.equal(sc.pass, true);
  assert.equal(sc.kind, 'test');
  assert.equal(sc.learnerTurns, 3);
  const list = (await api('GET', 'scores')).data;
  assert.equal(list[0].id, sc.id);
  const plan = (await api('GET', 'plan')).data;
  assert.equal(plan.progress.scenariosPassed, 1);
  assert.notEqual(plan.scenario.id, 'intro');
});

test('settings round-trip never exposes keys', async () => {
  const s = (await api('PUT', 'settings', { level: 'intermediate', profile: { other: 'likes coffee' } })).data;
  assert.equal(s.level, 'intermediate');
  assert.equal(s.profile.name, 'Kevin');
  assert.equal(s.profile.other, 'likes coffee');
  const status = JSON.stringify((await api('GET', 'status')).data);
  assert.ok(!status.includes('or-key') && !status.includes('oa-key'));
});

test('who is speaking: first-person lines are not the learner unless they answer him or mention his details', async () => {
  const { selfPlausible, slashIpa } = await import('../src/server/service');
  const s = service.settings();
  const q = { id: 'q', sessionId: 'x', t: 10_000, en: 'Kevin, where are you from?', kind: 'question' as const, priority: 'you' as const };
  assert.equal(selfPlausible('I was the only one who could do that', 60_000, [], s, 'class'), false);
  assert.equal(selfPlausible('I am from Wuhan', 60_000, [], s, 'class'), true);
  assert.equal(selfPlausible('I come from China', 20_000, [q], s, 'class'), true, 'answer right after a question to him');
  assert.equal(selfPlausible('I come from Japan', 90_000, [q], s, 'class'), false, 'too long after the question');
  assert.equal(slashIpa('əˈʃʊr'), '/əˈʃʊr/');
  assert.equal(slashIpa('/pruːv/'), '/pruːv/');
  assert.equal(slashIpa('[ɡeɪm]'), '/ɡeɪm/');
});

test('a class where nothing was heard is not kept; bin classes can be deleted for good', async () => {
  const empty = (await api('POST', 'sessions', { school: 'ILA', topic: 'oops', mode: 'class', deepReview: true })).data;
  const ended = (await api('POST', `sessions/${empty.id}/end`)).data;
  assert.equal(ended.statusNote, '没有听到内容，已自动删除');
  assert.equal(store.getSession(empty.id), undefined, 'gone, not even in the bin');
  const c = (await api('POST', 'sessions', { school: 'ILA', topic: 'purge me', mode: 'class', deepReview: false })).data;
  await api('POST', `sessions/${c.id}/lines`, { id: 'l-p1', t: 1000, en: 'Good morning everyone.' });
  await api('POST', `sessions/${c.id}/end`);
  assert.equal((await api('POST', `sessions/${c.id}/purge`)).status, 400, 'only from the bin');
  await api('DELETE', `sessions/${c.id}`);
  assert.equal((await api('POST', `sessions/${c.id}/purge`)).status, 200);
  assert.equal(store.getSession(c.id), undefined);
});

test('a plan day saved with fewer than 10 words is topped up once, then left alone', async () => {
  store.kvSet('plan:2026-12-01', { date: '2026-12-01', words: [{ en: 'ticket', ipa: '/ˈtɪkɪt/', zh: '票', category: 'travel', example: 'One ticket, please.', exampleZh: '一张票。' }], createdAt: 0 });
  const calls0 = calls.length;
  const d1 = await service.planDay('2026-12-01');
  assert.equal(d1.toppedUp, true);
  assert.ok(d1.words.length >= 1);
  const calls1 = calls.length;
  assert.ok(calls1 > calls0, 'asked the AI for the missing words');
  await service.planDay('2026-12-01');
  assert.equal(calls.length, calls1, 'not retried on every visit');
});

test('classes split by reopening the page can be merged back into one, captions in time order', async () => {
  const a = (await api('POST', 'sessions', { school: 'ILA', topic: '', mode: 'class', deepReview: false })).data;
  await api('POST', `sessions/${a.id}/lines`, { id: 'mg1', t: 5, en: 'Good evening, class.' });
  await new Promise((r) => setTimeout(r, 20));
  const b = (await api('POST', 'sessions', { school: 'ILA', topic: 'Food', mode: 'class', deepReview: false })).data; // ends a
  await api('POST', `sessions/${b.id}/lines`, { id: 'mg2', t: 500, en: 'Open your books.' });
  await api('POST', `sessions/${b.id}/end`);
  assert.equal((await api('POST', 'sessions/merge', { ids: [b.id] })).status, 400);
  const merged = (await api('POST', 'sessions/merge', { ids: [b.id, a.id] })).data;
  assert.equal(merged.id, a.id, 'kept the earliest class');
  assert.equal(merged.topic, 'Food');
  const lines = (await api('GET', `sessions/${a.id}`)).data.lines;
  assert.deepEqual(lines.map((l: { en: string }) => l.en), ['Good evening, class.', 'Open your books.']);
  assert.ok(lines[1].t >= 500 + 20 - 5, 'later class shifted after the first');
  assert.equal((await api('GET', `sessions/${b.id}`)).status, 404);
});

test('a recording left on the phone for a class that no longer exists can be recovered into a class', async () => {
  const id = 'cmrecovered01';
  const s = (await api('POST', 'sessions/recover', { id, startedAt: Date.now() - 3_600_000, endedAt: Date.now() - 600_000 })).data;
  assert.equal(s.id, id);
  assert.equal(s.status, 'done');
  assert.equal(s.deepReview, true);
  assert.equal((await api('POST', 'sessions/recover', { id, startedAt: 1, endedAt: 2 })).data.startedAt, s.startedAt, 'idempotent');
  assert.equal((await api('POST', 'sessions/recover', { id: '../x', startedAt: 1, endedAt: 2 })).status, 400);
  const up = await api('PUT', `sessions/${id}/audio/0`, new Uint8Array(5000), { 'Content-Type': 'audio/mp4', 'X-Started-At': String(s.startedAt) });
  assert.equal(up.status, 200);
});

async function waitDone(id: string): Promise<{ session: { status: string; statusNote?: string; importedAudio?: boolean; startedAt: number; endedAt?: number }; review: { transcript: unknown[] } | null }> {
  for (let i = 0; i < 100; i++) {
    const d = (await api('GET', `sessions/${id}`)).data;
    if (d.session.status !== 'processing') return d;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('still processing');
}

test('a Voice Memos recording imported after class becomes a class with a full review', async () => {
  const file = readFileSync(join(import.meta.dirname, 'fixtures', 'voice-20s.m4a'));
  const half = Math.ceil(file.length / 2);
  const upload = 'u-test-import-1';
  assert.equal((await api('PUT', `import/${upload}/0`, new Uint8Array(file.subarray(0, half)), { 'Content-Type': 'application/octet-stream' })).status, 200);
  assert.equal((await api('PUT', `import/${upload}/1`, new Uint8Array(file.subarray(half)), { 'Content-Type': 'application/octet-stream' })).status, 200);
  const before = sttCalls.length;
  const s = (await api('POST', `import/${upload}/finish`, { parts: 2, school: 'WSE', topic: 'Habits', mime: 'audio/x-m4a', fileTime: Date.now() })).data;
  assert.equal(s.school, 'WSE');
  assert.equal(s.importedAudio, true);
  assert.equal(s.startedAt, Date.parse('2026-10-24T07:00:00Z'), 'recording time from the file');
  assert.ok(Math.abs(s.endedAt - s.startedAt - 20_000) < 300);
  const d = await waitDone(s.id);
  assert.equal(d.session.status, 'done', d.session.statusNote ?? '');
  assert.ok(d.review && d.review.transcript.length > 0);
  assert.equal(sttCalls.length - before, 1);
  assert.equal(sttCalls[sttCalls.length - 1].input_audio?.format, 'm4a');
  // No other class was ended by the import.
  assert.ok((await api('GET', 'sessions')).data.some((x: { id: string }) => x.id === s.id));
});

test('importing into an existing class replaces its recording; not allowed while the class is live; missing pieces refused', async () => {
  const file = readFileSync(join(import.meta.dirname, 'fixtures', 'voice-20s.mp3'));
  const live = (await api('POST', 'sessions', { school: 'ILA', topic: 'x', mode: 'class', deepReview: true })).data;
  await api('POST', `sessions/${live.id}/lines`, { id: 'li1', t: 1000, en: 'Today we talk about habits.' });
  assert.equal((await api('PUT', `import/u-test-import-2/0`, new Uint8Array(file), { 'Content-Type': 'application/octet-stream' })).status, 200);
  const refused = await api('POST', `import/u-test-import-2/finish`, { parts: 1, sessionId: live.id });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /下课/);
  await api('POST', `sessions/${live.id}/end`);
  await waitDone(live.id);
  assert.equal((await api('PUT', `import/u-test-import-3/0`, new Uint8Array(file), { 'Content-Type': 'application/octet-stream' })).status, 200);
  const s = (await api('POST', `import/u-test-import-3/finish`, { parts: 1, sessionId: live.id, mime: 'audio/mpeg' })).data;
  assert.equal(s.id, live.id);
  const d = await waitDone(live.id);
  assert.equal(d.session.status, 'done', d.session.statusNote ?? '');
  assert.equal(d.session.importedAudio, true);
  assert.equal(store.audioFor(live.id).length, 1, 'only the imported recording');
  assert.equal((await api('GET', `sessions/${live.id}`)).data.lines.length, 1, 'live captions kept');
  assert.equal((await api('POST', `import/u-test-import-4/finish`, { parts: 2 })).status, 400);
  assert.equal((await api('PUT', `import/bad/0`, new Uint8Array(10))).status, 404);
});
