// Controller for one live class in the browser: listens (Web Speech), records audio chunks,
// sends each utterance to the server for translation / question detection / answers.
// Audio chunks that fail to upload are kept in memory and retried.

import { uid } from '../shared/text';
import type { ClassSession, Line } from '../shared/types';
import { api, ApiFail } from './api';
import { keepScreenOn } from './device';
import { Recognizer } from './recognizer';
import { ChunkRecorder, recordingSupported } from './recorder';

export class LiveClass {
  lines: Line[] = [];
  interim = '';
  paused = false;
  error = '';
  recordingNote = '';
  private recognizer: Recognizer | null = null;
  private recorder: ChunkRecorder | null = null;
  private listeners = new Set<() => void>();
  private pausedMs = 0;
  private pausedAt = 0;
  private uploads: Promise<void>[] = [];
  private pendingAudio: { index: number; startedAt: number; blob: Blob }[] = [];

  constructor(
    public session: ClassSession,
    private record: boolean,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.listeners.forEach((fn) => fn());
  }

  elapsed(now = Date.now()): number {
    const pausedNow = this.paused ? now - this.pausedAt : 0;
    return now - this.session.startedAt - this.pausedMs - pausedNow;
  }

  async start(existing: Line[] = []): Promise<void> {
    this.lines = existing;
    this.startRecognizer();
    void keepScreenOn(true);
    if (this.record && recordingSupported()) {
      // Chunk number = seconds since the class started, so re-entering a class never overwrites earlier audio.
      this.recorder = new ChunkRecorder((blob, _index, startedAt) => this.upload(Math.max(0, Math.floor((startedAt - this.session.startedAt) / 1000)), startedAt, blob));
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

  private upload(index: number, startedAt: number, blob: Blob): void {
    const p: Promise<void> = api
      .uploadAudio(this.session.id, index, startedAt, blob)
      .then(() => undefined)
      .catch(() => {
        this.pendingAudio.push({ index, startedAt, blob });
        this.recordingNote = '有录音片段上传失败，下课时会重试';
        this.changed();
      });
    this.uploads.push(p);
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

  /** Stop English listening while the user asks a question in Chinese. */
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
    await Promise.allSettled(this.uploads);
    for (const a of this.pendingAudio.splice(0)) {
      await api.uploadAudio(this.session.id, a.index, a.startedAt, a.blob).catch(() => undefined);
    }
    this.session = await api.endSession(this.session.id);
    this.changed();
    return this.session;
  }

  private addUtterance(text: string): void {
    const line: Line = { id: uid('l'), sessionId: this.session.id, t: this.elapsed(), en: text, kind: 'pending', priority: null };
    this.lines.push(line);
    this.changed();
    api
      .analyze(this.session.id, { id: line.id, t: line.t, en: line.en })
      .then((updated) => {
        this.error = '';
        this.replace(updated);
      })
      .catch((e: unknown) => {
        this.error = e instanceof Error ? e.message : String(e);
        if (e instanceof ApiFail && e.extra && typeof e.extra === 'object') this.replace(e.extra as Line);
        this.changed();
      });
  }

  private replace(updated: Line): void {
    const i = this.lines.findIndex((l) => l.id === updated.id);
    if (i >= 0) this.lines[i] = updated;
    this.changed();
  }
}
