// End-to-end test of the server with a fake AI provider: login, start a class, analyse lines,
// upload audio, end class, post-class review, review items, OpenRouter -> OpenAI fallback.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Ai } from '../src/server/ai';
import { DEFAULT_CONFIG, type ServerConfig } from '../src/server/config';
import { Store } from '../src/server/db';
import { checkToken, createApp, makeToken } from '../src/server/http';
import { Service } from '../src/server/service';

const calls: { url: string; auth: string }[] = [];
let openrouterBroke = false;

function reply(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
}

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
  calls.push({ url, auth });
  if (url.includes('openrouter') && openrouterBroke) return new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 });
  if (url.endsWith('/credits')) return new Response(JSON.stringify({ data: { total_credits: 45, total_usage: 2.68 } }), { status: 200 });
  if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'Kevin, what do you do on the weekend? I play football.' }), { status: 200 });
  const body = JSON.parse(String(init?.body ?? '{}'));
  const system: string = body.messages?.[0]?.content ?? '';
  const user: string = body.messages?.[1]?.content ?? '';
  if (system.includes('live English class') || system.includes('small-group')) {
    const isQ = user.includes('?');
    return reply({ zh: '翻译', isQuestion: isQ, target: isQ ? 'you' : null, isSelf: user.includes('I play'), questionZh: '老师在问：你周末做什么？', answers: [{ en: 'I usually stay home.', zh: '我一般在家。' }, { en: 'I go to a cafe.', zh: '我去咖啡店。' }] });
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
  service = new Service(store, ai, dir);
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
  assert.equal(detail.lines.length, 3);
  assert.ok(detail.review.transcript.length >= 2);

  const items = (await api('GET', 'items')).data as { type: string; en: string; id: string }[];
  assert.ok(items.some((i) => i.type === 'word' && i.en === 'weekend'));
  assert.ok(items.some((i) => i.type === 'correction' && i.en === 'I play football on the weekend.'));

  const graded = (await api('POST', `items/${items[0].id}/grade`, { correct: true })).data;
  assert.equal(graded.correctStreak, 1);
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

test('settings round-trip never exposes keys', async () => {
  const s = (await api('PUT', 'settings', { level: 'intermediate', profile: { other: 'likes coffee' } })).data;
  assert.equal(s.level, 'intermediate');
  assert.equal(s.profile.name, 'Kevin');
  assert.equal(s.profile.other, 'likes coffee');
  const status = JSON.stringify((await api('GET', 'status')).data);
  assert.ok(!status.includes('or-key') && !status.includes('oa-key'));
});
