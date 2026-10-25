// The AI writes the review as JSON and sometimes leaves fields out (e.g. a question with no "answers").
// Every review is passed through this before it is saved, sent or shown, so no screen or export can crash on it.

import type { Answer, SessionReview } from './types';

const str = (x: unknown): string => (typeof x === 'string' ? x : x == null ? '' : String(x));
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
const answers = (x: unknown): Answer[] => arr<unknown>(x).map(obj).map((a) => ({ en: str(a.en), zh: str(a.zh) })).filter((a) => a.en);

export function normalizeReview(raw: unknown, sessionId = ''): SessionReview {
  const r = obj(raw);
  return {
    sessionId: str(r.sessionId) || sessionId,
    createdAt: Number(r.createdAt) || Date.now(),
    summaryZh: str(r.summaryZh),
    points: arr<unknown>(r.points).map(obj).map((p) => ({ title: str(p.title), detailZh: str(p.detailZh), examples: arr<unknown>(p.examples).map(str).filter(Boolean) })),
    vocab: arr<unknown>(r.vocab).map(obj).map((v) => ({ en: str(v.en), ipa: str(v.ipa), zh: str(v.zh), example: str(v.example) })).filter((v) => v.en),
    questions: arr<unknown>(r.questions)
      .map(obj)
      .map((q) => ({ asker: q.asker === 'classmate' ? ('classmate' as const) : ('teacher' as const), en: str(q.en), zh: str(q.zh), answers: answers(q.answers) }))
      .filter((q) => q.en),
    myCorrections: arr<unknown>(r.myCorrections).map(obj).map((c) => ({ said: str(c.said), better: str(c.better), whyZh: str(c.whyZh) })).filter((c) => c.said || c.better),
    dialogues: arr<unknown>(r.dialogues)
      .map(obj)
      .map((d) => ({ titleZh: str(d.titleZh), turns: arr<unknown>(d.turns).map(obj).map((t) => ({ speaker: str(t.speaker), en: str(t.en), zh: str(t.zh) })).filter((t) => t.en) })),
    transcript: arr<unknown>(r.transcript).map(obj).map((t) => ({ speaker: str(t.speaker), en: str(t.en) })).filter((t) => t.en),
  };
}
