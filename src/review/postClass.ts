// After class: transcribe the recorded chunks, turn the class into review material,
// add review items to the shared queue, then apply the audio retention setting.
// Safe to re-run: chunks already transcribed are skipped.

import { chatJson } from '../ai/client';
import { transcribe } from '../ai/transcribe';
import { newItem } from '../classroom/ask';
import { reviewSystem, reviewUser } from '../prompts';
import { db } from '../storage/db';
import { currentSettings } from '../storage/settings';
import type { ClassSession, ReviewItem, SessionReview } from '../types';
import { normalizeWord } from '../util/text';

type Generated = Omit<SessionReview, 'sessionId' | 'createdAt' | 'transcript'>;

const running = new Set<string>();

export async function processClass(sessionId: string, onProgress: (note: string) => void = () => {}): Promise<void> {
  if (running.has(sessionId)) return;
  running.add(sessionId);
  const session = await db.getSession(sessionId);
  if (!session) return;
  const setStatus = async (status: ClassSession['status'], note?: string) => {
    session.status = status;
    session.statusNote = note;
    await db.putSession(session);
    if (note) onProgress(note);
  };
  try {
    const chunks = await db.audioFor(sessionId);
    let transcriptParts: string[] = [];
    if (chunks.length) {
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (c.transcript === undefined) {
          await setStatus('processing', `转写录音 ${i + 1}/${chunks.length}`);
          c.transcript = await transcribe(c.blob, c.mime);
          await db.putAudio(c);
        }
        transcriptParts.push(c.transcript);
      }
    }
    const lines = await db.linesFor(sessionId);
    if (!transcriptParts.join('').trim()) transcriptParts = lines.map((l) => l.en);
    const selfLines = lines.filter((l) => l.kind === 'self').map((l) => l.en);
    const transcript = transcriptParts.join('\n');
    if (!transcript.trim()) {
      await setStatus('done', '这节课没有可整理的内容');
      return;
    }

    await setStatus('processing', '整理复习内容');
    const s = currentSettings();
    const g = await chatJson<Partial<Generated>>(
      [
        { role: 'system', content: reviewSystem(s) },
        { role: 'user', content: reviewUser(transcript, selfLines, session.topic, session.school) },
      ],
      { purpose: 'deep' },
    );
    const review: SessionReview = {
      sessionId,
      createdAt: Date.now(),
      summaryZh: g.summaryZh ?? '',
      points: g.points ?? [],
      vocab: g.vocab ?? [],
      questions: g.questions ?? [],
      myCorrections: g.myCorrections ?? [],
      dialogues: g.dialogues ?? [],
      transcript: transcriptParts.flatMap((p) => p.split(/(?<=[.?!])\s+/)).filter(Boolean).map((en) => ({ speaker: '', en })),
    };
    await db.putReview(review);
    await db.putItems(await itemsFrom(review, session));
    await applyRetention(sessionId);
    await setStatus('done', undefined);
    onProgress('整理完成');
  } catch (e) {
    await setStatus('failed', e instanceof Error ? e.message : String(e));
  } finally {
    running.delete(sessionId);
  }
}

/** Turn a class review into practice items, skipping words already in the queue. */
async function itemsFrom(r: SessionReview, session: ClassSession): Promise<ReviewItem[]> {
  const existing = new Set((await db.allItems()).map((i) => `${i.type}|${normalizeWord(i.en)}`));
  const out: ReviewItem[] = [];
  const add = (it: ReviewItem) => {
    const k = `${it.type}|${normalizeWord(it.en)}`;
    if (existing.has(k)) return;
    existing.add(k);
    out.push(it);
  };
  r.vocab.forEach((v) => add(newItem('word', v.en, v.zh, session, v.ipa, v.example)));
  r.points.forEach((p) => p.examples.slice(0, 1).forEach((ex) => add(newItem('pattern', ex, p.detailZh, session, undefined, p.title))));
  r.questions.forEach((q) => {
    const a = q.answers[0];
    if (a) add(newItem('question', a.en, `${q.zh}（用英文回答）`, session, undefined, q.en));
  });
  r.myCorrections.forEach((c) => add(newItem('correction', c.better, `改正：${c.said}`, session, undefined, c.whyZh)));
  return out;
}

/** Delete this class's full recording when retention is 0 days. */
async function applyRetention(sessionId: string): Promise<void> {
  if (currentSettings().keepAudioDays > 0) return;
  const chunks = await db.audioFor(sessionId);
  await db.deleteAudio(chunks.map((c) => c.id));
}

/** On app start: delete recordings older than the retention window. */
export async function cleanupOldAudio(): Promise<void> {
  const days = currentSettings().keepAudioDays;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const old = (await db.allAudioMeta()).filter((a) => a.startedAt < cutoff);
  if (old.length) await db.deleteAudio(old.map((a) => a.id));
}
