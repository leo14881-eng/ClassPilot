// Browser-side API client. All data and AI calls go to the ClassPilot server (same origin);
// the login cookie is HttpOnly, so the page never sees a key or token.

import { audioInfo } from './voice';
import type { ProviderStatus, UserSettings } from '../shared/settings';
import type { ClassSession, Line, ReviewItem, SessionReview, WordInfo, Answer, PlanWord, Score } from '../shared/types';

export class ApiFail extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: unknown,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function call<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : undefined,
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new ApiFail(0, '网络连不上服务器，请检查网络');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== 'login') onUnauthorized();
    throw new ApiFail(res.status, (data as { error?: string }).error ?? `出错了（${res.status}）`, (data as { extra?: unknown }).extra);
  }
  return data as T;
}

export interface Status extends ProviderStatus {
  items: { total: number; mastered: number };
}

export interface TalkResult {
  reply: Answer;
  correction: { said: string; better: string; whyZh: string } | null;
  suggestions: Answer[];
}

export interface PlanStatus {
  date: string;
  dayNumber: number;
  daysLeft: number;
  phase: { n: number; titleZh: string; start: string; end: string };
  words: (PlanWord & { itemId?: string; correctStreak: number; mastered: boolean })[];
  dueCount: number;
  scenario: { id: string; titleZh: string; best: number | null; practicedToday: boolean };
  test: { today: boolean; scenarioId: string; titleZh: string; doneThisWeek: Score | null };
  progress: { masteredWords: number; wordTarget: number; scenariosPassed: number; scenarioTotal: number; level: { label: string; noteZh: string } };
}

export interface CheckResult {
  correct: boolean;
  feedbackZh: string;
  better: string;
}

export interface AskResult {
  answerZh: string;
  say: Answer[];
  words: Answer[];
}

export const api = {
  login: (passcode: string) => call<{ ok: boolean }>('POST', 'login', { passcode }),
  me: () => call<{ ok: boolean }>('GET', 'me'),
  settings: () => call<UserSettings>('GET', 'settings'),
  saveSettings: (patch: Partial<UserSettings>) => call<UserSettings>('PUT', 'settings', patch),
  status: () => call<Status>('GET', 'status'),
  resetOpenrouter: () => call<Status>('POST', 'status/reset-openrouter'),
  sessions: () => call<ClassSession[]>('GET', 'sessions'),
  createSession: (b: Pick<ClassSession, 'school' | 'topic' | 'mode' | 'deepReview'>) => call<ClassSession>('POST', 'sessions', b),
  session: (id: string) => call<{ session: ClassSession; lines: Line[]; review: SessionReview | null }>('GET', `sessions/${id}`),
  endSession: (id: string) => call<ClassSession>('POST', `sessions/${id}/end`),
  setMode: (id: string, mode: ClassSession['mode']) => call<ClassSession>('PATCH', `sessions/${id}`, { mode }),
  deleteSession: (id: string) => call<ClassSession>('DELETE', `sessions/${id}`),
  restoreSession: (id: string) => call<ClassSession>('POST', `sessions/${id}/restore`),
  bin: () => call<ClassSession[]>('GET', 'sessions/bin'),
  reprocess: (id: string) => call<ClassSession>('POST', `sessions/${id}/process`),
  analyze: (sessionId: string, line: { id: string; t: number; en: string }) => call<Line>('POST', `sessions/${sessionId}/lines`, line),
  uploadAudio: (sessionId: string, index: number, startedAt: number, blob: Blob) =>
    call<{ ok: boolean }>('PUT', `sessions/${sessionId}/audio/${index}`, blob, {
      headers: { 'Content-Type': blob.type || 'audio/mp4', 'X-Started-At': String(startedAt) },
    }),
  ask: (question: string, sessionId?: string, history?: { q: string; a: string }[]) => call<AskResult>('POST', 'ask', { question, sessionId, history }),
  plan: () => call<PlanStatus>('GET', 'plan'),
  scores: () => call<Score[]>('GET', 'scores'),
  scoreTalk: (b: { scenarioId?: string; kind: 'scenario' | 'test'; history: { who: 'ai' | 'me'; en: string }[] }) => call<Score>('POST', 'talk/score', b),
  talk: (b: { scenarioId?: string; history: { who: 'ai' | 'me'; en: string }[]; said: string }) => call<TalkResult>('POST', 'talk', b),
  word: (word: string, sentence: string, sessionId?: string) => call<WordInfo>('POST', 'word', { word, sentence, sessionId }),
  items: () => call<ReviewItem[]>('GET', 'items'),
  dueItems: () => call<ReviewItem[]>('GET', 'items/due'),
  check: (id: string, answer: string, spoken = false, alts: string[] = []) => call<CheckResult>('POST', `items/${id}/check`, { answer, spoken, alts }),
  /** Transcribe a few seconds of the learner's voice on the server (much better with an accent than the phone's recognizer). */
  /** `second`: also ask a second recognizer (practice answers); `live`: class captions (not stored for diagnosis). */
  stt: (blob: Blob, lang: 'en' | 'zh', opts: { live?: boolean; second?: boolean } = {}) =>
    call<{ text: string; alts: string[] }>('POST', `stt?lang=${lang}${opts.live ? '&live=1' : ''}${opts.second ? '&second=1' : ''}`, blob, {
      headers: { 'Content-Type': (blob.type || 'audio/mp4').split(';')[0], 'X-Audio-Info': audioInfo() },
    }),
  grade: (id: string, correct: boolean) => call<ReviewItem>('POST', `items/${id}/grade`, { correct }),
};
