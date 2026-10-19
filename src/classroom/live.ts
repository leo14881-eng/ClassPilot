// Controller for one live class: listens, records, analyses each utterance, stores everything.
// The Live screen subscribes to changes and re-renders.

import { chatJson } from '../ai/client';
import { liveSystem, liveUser } from '../prompts';
import { ChunkRecorder, recordingSupported } from '../recording/recorder';
import { Recognizer } from '../speech/recognizer';
import { db } from '../storage/db';
import { currentSettings, nameList } from '../storage/settings';
import { keepScreenOn } from '../platform/device';
import type { Answer, ClassSession, Line } from '../types';
import { looksLikeQuestion, uid } from '../util/text';
import { questionPriority } from './priority';

interface LiveResult {
  zh?: string;
  isQuestion?: boolean;
  target?: 'you' | 'all' | 'other' | null;
  isSelf?: boolean;
  questionZh?: string;
  answers?: Answer[];
}

const MAX_PARALLEL = 3;

export class LiveClass {
  lines: Line[] = [];
  interim = '';
  paused = false;
  error = '';
  recordingNote = '';
  private recognizer: Recognizer | null = null;
  private recorder: ChunkRecorder | null = null;
  private listeners = new Set<() => void>();
  private inFlight = 0;
  private waiting: Line[] = [];
  private lastSelfT: number | null = null;
  private pausedMs = 0;
  private pausedAt = 0;

  constructor(public session: ClassSession) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.listeners.forEach((fn) => fn());
  }

  /** Milliseconds of class time, excluding breaks. */
  elapsed(now = Date.now()): number {
    const pausedNow = this.paused ? now - this.pausedAt : 0;
    return now - this.session.startedAt - this.pausedMs - pausedNow;
  }

  async start(): Promise<void> {
    this.lines = await db.linesFor(this.session.id);
    this.startRecognizer();
    void keepScreenOn(true);
    if (currentSettings().recordAudio && recordingSupported()) {
      this.recorder = new ChunkRecorder((blob, index, startedAt, mime) => {
        void db.putAudio({ id: `${this.session.id}-${index}`, sessionId: this.session.id, index, startedAt, mime, blob });
      });
      try {
        await this.recorder.start();
        this.recordingNote = '录音中';
      } catch {
        this.recorder = null;
        this.recordingNote = '录音没有启动，课后整理会改用实时字幕';
      }
    } else {
      this.recordingNote = '未开启录音';
    }
    this.changed();
  }

  private startRecognizer(): void {
    this.recognizer = new Recognizer('en-US', {
      onInterim: (t) => {
        this.interim = t;
        this.changed();
      },
      onFinal: (t) => this.addUtterance(t),
      onError: (m) => {
        this.error = m;
        this.changed();
      },
    });
    this.recognizer.start();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pausedAt = Date.now();
    this.recognizer?.stop();
    this.recorder?.pause();
    this.changed();
  }

  resume(): void {
    if (!this.paused) return;
    this.pausedMs += Date.now() - this.pausedAt;
    this.paused = false;
    this.error = '';
    this.startRecognizer();
    this.recorder?.resume();
    this.changed();
  }

  /** Temporarily stop English listening (e.g. while the user asks a question in Chinese). */
  hold(): void {
    this.recognizer?.stop();
  }

  release(): void {
    if (!this.paused) this.startRecognizer();
  }

  async end(): Promise<ClassSession> {
    this.recognizer?.stop();
    await this.recorder?.stop();
    void keepScreenOn(false);
    this.session = {
      ...this.session,
      endedAt: Date.now(),
      status: this.session.deepReview ? 'processing' : 'done',
      statusNote: this.session.deepReview ? '等待整理' : undefined,
    };
    await db.putSession(this.session);
    this.changed();
    return this.session;
  }

  recentText(n = 8): string[] {
    return this.lines
      .filter((l) => l.kind !== 'pending' || l.en)
      .slice(-n)
      .map((l) => (l.kind === 'self' ? `[learner] ${l.en}` : l.en));
  }

  private addUtterance(text: string): void {
    const line: Line = {
      id: uid('l'),
      sessionId: this.session.id,
      t: this.elapsed(),
      en: text,
      kind: 'pending',
      priority: null,
    };
    this.lines.push(line);
    void db.putLine(line);
    this.changed();
    this.waiting.push(line);
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < MAX_PARALLEL && this.waiting.length) {
      const line = this.waiting.shift()!;
      this.inFlight++;
      void this.analyze(line).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
  }

  private async analyze(line: Line): Promise<void> {
    const s = currentSettings();
    const recent = this.lines.filter((l) => l.t < line.t).slice(-6).map((l) => (l.kind === 'self' ? `[learner] ${l.en}` : l.en));
    let r: LiveResult = {};
    try {
      r = await chatJson<LiveResult>(
        [
          { role: 'system', content: liveSystem(s, this.session.mode, this.session.topic) },
          { role: 'user', content: liveUser(recent, line.en) },
        ],
        { purpose: 'live' },
      );
      this.error = '';
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    const isSelf = !!r.isSelf;
    const isQuestion = !isSelf && (r.isQuestion ?? looksLikeQuestion(line.en));
    const priority = questionPriority({
      text: line.en,
      isQuestion,
      aiTarget: r.target ?? null,
      names: nameList(s),
      mode: this.session.mode,
      msSinceSelf: this.lastSelfT === null ? null : line.t - this.lastSelfT,
    });
    if (isSelf) this.lastSelfT = line.t;
    const updated: Line = {
      ...line,
      zh: r.zh,
      kind: isSelf ? 'self' : isQuestion ? 'question' : 'lecture',
      priority: r.target === 'other' && priority === 'all' ? null : priority,
      questionZh: isQuestion ? r.questionZh : undefined,
      answers: isQuestion ? (r.answers ?? []).slice(0, 2) : undefined,
    };
    const i = this.lines.findIndex((l) => l.id === line.id);
    if (i >= 0) this.lines[i] = updated;
    await db.putLine(updated);
    this.changed();
  }
}
