// Controller for one live class in the browser: one microphone stream is cut into sentences at pauses
// (SegmentListener), each sentence is transcribed on the server (accurate, nothing skipped) and then analysed
// (translation / question detection / answers). The same stream is recorded in 3-minute chunks for after class.
// Audio chunks that fail to upload are kept in memory and retried.

import { uid } from '../shared/text';
import type { ClassSession, Line } from '../shared/types';
import { api, ApiFail } from './api';
import { keepScreenOn } from './device';
import { acquireMic, releaseMic, SegmentListener, unlockAudio } from './voice';
import { ChunkRecorder, recordingSupported } from './recorder';

export class LiveClass {
  lines: Line[] = [];
  interim = '';
  paused = false;
  error = '';
  recordingNote = '';
  private mic: MediaStream | null = null;
  private listener: SegmentListener | null = null;
  private sttQueue: (() => Promise<void>)[] = [];
  private sttRunning = 0;
  private sttPending: Promise<void>[] = [];
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
    void keepScreenOn(true);
    try {
      this.mic = await acquireMic();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.changed();
      return;
    }
    this.watchMic();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.startListening();
    if (this.record && recordingSupported()) {
      // Chunk number = seconds since the class started, so re-entering a class never overwrites earlier audio.
      this.recorder = new ChunkRecorder((blob, _index, startedAt) => this.upload(Math.max(0, Math.floor((startedAt - this.session.startedAt) / 1000)), startedAt, blob));
      try {
        await this.recorder.start(this.mic ?? undefined);
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

  /** If iOS cuts the microphone (phone call, lock screen), pause and say so instead of silently hearing nothing. */
  private watchMic(): void {
    this.mic?.getAudioTracks().forEach((t) =>
      t.addEventListener('ended', () => {
        if (this.paused || document.hidden) return; // in the background: recovered when the page comes back
        this.pause();
        this.error = '麦克风被系统中断了，点 ▶ 继续';
        this.changed();
      }),
    );
  }

  private hiddenAt = 0;
  private onVisibility = () => {
    if (document.hidden) {
      this.hiddenAt = Date.now();
      return;
    }
    if (!this.hiddenAt || this.paused || this.ended) return;
    const away = Date.now() - this.hiddenAt;
    this.hiddenAt = 0;
    void this.recover(away);
  };

  /**
   * Back from another app: iOS froze this page and stopped the microphone while it was hidden,
   * so reconnect and mark the gap in the captions.
   */
  private async recover(awayMs: number): Promise<void> {
    unlockAudio();
    try {
      if (!this.mic || !this.mic.active || !this.mic.getAudioTracks().some((t) => t.readyState === 'live')) {
        if (this.mic) releaseMic();
        this.mic = null;
        this.mic = await acquireMic();
        this.watchMic();
        this.recorder?.switchStream(this.mic);
      }
      this.stopListening();
      this.startListening();
      if (awayMs > 3000) {
        const mins = Math.max(1, Math.round(awayMs / 60000));
        this.lines.push({ id: uid('l'), sessionId: this.session.id, t: this.elapsed(), en: '', zh: `（你离开了约 ${mins} 分钟，这段时间没有听课）`, kind: 'lecture', priority: null });
      }
      this.error = '';
    } catch {
      this.pause();
      this.error = '回来后麦克风没有自动恢复，点 ▶ 继续';
    }
    this.changed();
  }

  /** The class microphone, shared with the hold-to-ask button. */
  get micStream(): MediaStream | null {
    return this.mic;
  }

  private startListening(): void {
    if (!this.mic) return;
    this.listener = new SegmentListener(this.mic, {
      onSegment: (wav, startedAt) => this.addSegment(wav, startedAt),
      onSpeaking: (on) => {
        const next = on ? '（有人在说话…）' : '';
        if (next !== this.interim) {
          this.interim = next;
          this.changed();
        }
      },
    });
    this.listener.start();
  }

  private stopListening(): void {
    this.listener?.stop();
    this.listener = null;
    this.interim = '';
  }

  /** One spoken sentence: reserve its place in the captions now, transcribe (at most 3 at a time), then analyse. */
  private addSegment(blob: Blob, startedAt: number): void {
    const line: Line = { id: uid('l'), sessionId: this.session.id, t: Math.max(0, startedAt - this.session.startedAt - this.pausedMs), en: '', kind: 'pending', priority: null };
    this.lines.push(line);
    this.changed();
    const hint = this.lines.filter((l) => l.en).slice(-2).map((l) => l.en).join(' ');
    let done: () => void = () => {};
    this.sttPending.push(new Promise<void>((r) => (done = r)));
    this.sttQueue.push(async () => {
      try {
        const text = (await api.stt(blob, 'en', hint, true)).text.trim();
        if (!text) {
          this.lines = this.lines.filter((l) => l !== line);
          this.changed();
          return;
        }
        line.en = text;
        this.changed();
        this.analyze(line);
      } catch (e) {
        this.lines = this.lines.filter((l) => l !== line);
        this.error = e instanceof Error ? e.message : String(e);
        this.changed();
      } finally {
        done();
      }
    });
    this.pump();
  }

  private pump(): void {
    while (this.sttRunning < 4 && this.sttQueue.length) {
      const job = this.sttQueue.shift()!;
      this.sttRunning++;
      void job().finally(() => {
        this.sttRunning--;
        this.pump();
      });
    }
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pausedAt = Date.now();
    this.stopListening();
    this.recorder?.pause();
    this.changed();
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    // iOS may have ended the microphone (lock screen, phone call): open it again.
    if (!this.mic || !this.mic.active) {
      try {
        if (this.mic) releaseMic();
        this.mic = await acquireMic();
        this.watchMic();
        this.recorder?.switchStream(this.mic);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        this.changed();
        return;
      }
    }
    this.pausedMs += Date.now() - this.pausedAt;
    this.paused = false;
    this.error = '';
    this.startListening();
    this.recorder?.resume();
    this.changed();
  }

  /** Stop English listening while the user asks a question in Chinese. */
  hold(): void {
    this.stopListening();
    this.changed();
  }

  release(): void {
    if (!this.paused && !this.listener) this.startListening();
  }

  /** Leaving the class screen: stop listening and give the microphone back. */
  leave(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.pause();
    if (this.mic) {
      this.mic = null;
      releaseMic();
    }
  }

  private ended = false;

  async end(): Promise<ClassSession> {
    this.ended = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopListening();
    // Let the last sentences finish transcribing (at most 10 s).
    await Promise.race([Promise.allSettled(this.sttPending), new Promise((r) => setTimeout(r, 10_000))]);
    await this.recorder?.stop();
    if (this.mic) {
      this.mic = null;
      releaseMic();
    }
    void keepScreenOn(false);
    // Wait at most 20 s for audio uploads; whatever is still going keeps uploading in the background.
    const retries = this.pendingAudio.splice(0).map((a) => api.uploadAudio(this.session.id, a.index, a.startedAt, a.blob).then(() => undefined, () => undefined));
    await Promise.race([Promise.allSettled([...this.uploads, ...retries]), new Promise((r) => setTimeout(r, 20_000))]);
    this.session = await api.endSession(this.session.id);
    this.changed();
    return this.session;
  }

  private analyze(line: Line): void {
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
