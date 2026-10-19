// "Ask anytime" and tap-a-word lookups. Every looked-up word becomes a review item.

import { chatJson } from '../ai/client';
import { askSystem, askUser, wordSystem, wordUser } from '../prompts';
import { db } from '../storage/db';
import { currentSettings } from '../storage/settings';
import type { Answer, ClassSession, ReviewItem, WordInfo } from '../types';
import { localDate, normalizeWord, uid } from '../util/text';

export interface AskResult {
  answerZh: string;
  say: Answer[];
  words: Answer[];
}

export async function ask(question: string, recent: string[], session?: ClassSession): Promise<AskResult> {
  const r = await chatJson<Partial<AskResult>>(
    [
      { role: 'system', content: askSystem(currentSettings()) },
      { role: 'user', content: askUser(recent, question) },
    ],
    { purpose: 'live' },
  );
  const result: AskResult = { answerZh: r.answerZh ?? '', say: r.say ?? [], words: r.words ?? [] };
  const items: ReviewItem[] = [
    ...result.say.map((a) => newItem('pattern', a.en, a.zh, session)),
    ...result.words.map((a) => newItem('word', a.en, a.zh, session)),
  ];
  for (const it of items) it.source.origin = 'ask';
  await db.putItems(items);
  return result;
}

const wordCache = new Map<string, WordInfo>();

export async function lookupWord(word: string, sentence: string, session?: ClassSession): Promise<WordInfo> {
  const key = `${normalizeWord(word)}|${sentence}`;
  const cached = wordCache.get(key);
  if (cached) return cached;
  const info = await chatJson<WordInfo>(
    [
      { role: 'system', content: wordSystem() },
      { role: 'user', content: wordUser(word, sentence) },
    ],
    { purpose: 'live' },
  );
  wordCache.set(key, info);
  const item = newItem('word', normalizeWord(info.word || word), info.zh, session, info.ipa, info.example?.en);
  item.source.origin = 'lookup';
  await db.putItems([item]);
  return info;
}

export function newItem(
  type: ReviewItem['type'],
  en: string,
  zh: string,
  session?: ClassSession,
  ipa?: string,
  note?: string,
): ReviewItem {
  const now = Date.now();
  return {
    id: uid('i'),
    type,
    en,
    zh,
    ipa,
    note,
    source: { sessionId: session?.id, school: session?.school, date: localDate(session?.startedAt ?? now), origin: 'class' },
    correctStreak: 0,
    lapses: 0,
    due: now,
    mastered: false,
    createdAt: now,
  };
}
