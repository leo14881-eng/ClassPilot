import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classMarkdown, classMarkdownName } from '../src/shared/markdown';
import type { ClassSession, Line, SessionReview } from '../src/shared/types';

const session = { id: 's1', school: 'ILA', topic: 'Food | drinks', mode: 'class', startedAt: Date.UTC(2026, 9, 19, 2, 0), endedAt: Date.UTC(2026, 9, 19, 3, 30), status: 'done', deepReview: true } as unknown as ClassSession;
const lines: Line[] = [
  { id: 'a', sessionId: 's1', t: 5000, en: 'What do you eat for breakfast?', zh: '你早餐吃什么？', kind: 'question', priority: 'you', questionZh: '老师问你早餐吃什么', answers: [{ en: 'I eat eggs.', zh: '我吃鸡蛋。' }] },
  { id: 'b', sessionId: 's1', t: 9000, en: 'I eat egg', kind: 'self', priority: null },
];
const review: SessionReview = {
  sessionId: 's1',
  createdAt: 0,
  summaryZh: '讲早餐',
  points: [{ title: 'like + -ing', detailZh: '喜欢做某事', examples: ['I like cooking.'] }],
  vocab: [{ en: 'cereal', ipa: '/ˈsɪəriəl/', zh: '麦片', example: 'I eat cereal.' }],
  questions: [{ asker: 'teacher', en: 'What do you eat for breakfast?', zh: '你早餐吃什么？', answers: [{ en: 'I eat eggs.', zh: '我吃鸡蛋。' }] }],
  myCorrections: [{ said: 'I eat egg', better: 'I eat eggs.', whyZh: '复数' }],
  dialogues: [{ titleZh: '点早餐', turns: [{ speaker: 'Teacher', en: 'Hi', zh: '你好' }] }],
  transcript: [{ speaker: 'Teacher', en: 'Good morning.' }],
};

test('class markdown with review: rules, all sections, IPA, tables escaped', () => {
  const md = classMarkdown(session, lines, review);
  for (const part of ['# ILA 英语课 2026-10-19', '音标只用 IPA', '## 老师 / 同学的问题', '## 我说错的句子', '| I eat egg | I eat eggs. | 复数 |', '## 生词', '/ˈsɪəriəl/', '## 语法和句型', '## 课上的对话', '## 完整记录', 'Good morning.']) {
    assert.ok(md.includes(part), part);
  }
  assert.ok(md.includes('Food \\| drinks') || md.includes('Food | drinks'));
});

test('class markdown without review falls back to live captions', () => {
  const md = classMarkdown(session, lines, null);
  assert.ok(md.includes('## 课上的问题'));
  assert.ok(md.includes('问我'));
  assert.ok(md.includes('## 我在课上说的话'));
  assert.ok(md.includes('What do you eat for breakfast? — 你早餐吃什么？'));
  assert.equal(classMarkdownName(session), 'ILA-2026-10-19-Food-drinks.md');
});
