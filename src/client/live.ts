// Controller for one live class in the browser: one microphone stream is cut into sentences at pauses
// (SegmentListener), each sentence is transcribed on the server (accurate, nothing skipped) and then analysed
// (translation / question detection / answers). The same stream is recorded in 3-minute chunks for after class.
// The 3-minute recording is kept on the phone (localaudio.ts), not uploaded during class, to save mobile data;
// if the phone cannot store it, it is uploaded as before (failed uploads are retried at the end).

import { uid } from '../shared/text';
import type { ClassSession, Line } from '../shared/types';
import { api, ApiFail } from './api';
import { keepScreenOn } from './device';
import { acquireMic, audioHealth, releaseMic, restartMic, SegmentListener, unlockAudio } from './voice';
import { saveChunk } from './localaudio';
import { ChunkRecorder, recordingSupported } from './recorder';

/**
 * The class in progress stays alive while the learner moves around the app (ask a word, practise, check the
 * plan): leaving the class screen must not stop listening or recording. Only 下课 / pause stop it.
 */
let active: LiveClass | null = null;
const activeListeners = new Set<() => void>();
export function activeClass(): LiveClass | null {
  return active && !active.isEnded ? active : null;
}
export function setActiveClass(c: LiveClass | null): void {
  active = c;
  activeListeners.forEach((f) => f());
}

export class LiveClass {
  lines: Line[] = [];
  interim = '';
  /** 0..1 microphone level for the meter; -1 = no audio is arriving. */
  level = 0;
  /** Called every second with the level (cheap meter update, no full redraw). */
  onLevel: ((level: number) => void) | null = null;
  private watchdog: number | undefined;
  private repairing = false;
  private failedRepairs = 0;
  private audioError = '';
  paused = false;
  /** iOS would not let the microphone restart by itself: one tap anywhere restarts it. */
  needTap = false;
  error = '';
  recordingNote = '';
  private mic: MediaStream | null = null;
  private listener: SegmentListener | null = null;
  private sttQueue: (() => Promise<void>)[] = [];
  private sttRunning = 0;
  private sttPending: Promise<void>[] = [];
  /** Bytes sent for live captions in this visit (shown so mobile data use is visible). */
  bytesUp = 0;
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
    this.listenPage(true);
    this.startListening();
    this.startWatchdog();
    if (this.record && recordingSupported()) {
      // Chunk number = seconds since the class started, so re-entering a class never overwrites earlier audio.
      this.recorder = new ChunkRecorder((blob, _index, startedAt) => {
        const index = Math.max(0, Math.floor((startedAt - this.session.startedAt) / 1000));
        saveChunk(this.session.id, index, startedAt, blob).catch(() => this.upload(index, startedAt, blob));
      });
      try {
        await this.recorder.start(this.mic ?? undefined);
        this.recordingNote = '录音存在手机上';
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
    this.bytesUp += blob.size;
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
  private onHide = () => {
    this.hiddenAt ||= Date.now();
  };
  private onVisibility = () => {
    if (document.hidden) {
      this.hiddenAt ||= Date.now();
      return;
    }
    if (!this.hiddenAt || this.paused || this.ended) return;
    const away = Date.now() - this.hiddenAt;
    this.hiddenAt = 0;
    void this.recover(away);
  };
  /** Any tap: if listening is stuck, restart it right now (a tap is when iOS always allows audio to start). */
  private onTap = () => {
    if (this.paused || this.ended || document.hidden) return;
    const h = audioHealth();
    if (!this.needTap && !this.unhealthy(h)) return;
    unlockAudio();
    void this.restart().then((ok) => {
      if (ok) this.clearTap();
    });
  };

  private listenPage(on: boolean): void {
    const f = on ? 'addEventListener' : 'removeEventListener';
    document[f]('visibilitychange', this.onVisibility);
    window[f]('pageshow', this.onVisibility);
    window[f]('focus', this.onVisibility);
    window[f]('pagehide', this.onHide);
    for (const ev of ['pointerdown', 'touchend']) document[f](ev, this.onTap, { capture: true });
  }

  /**
   * Back from the lock screen or another app: iOS froze this page and muted or stopped the microphone while it
   * was hidden. Open a fresh microphone and audio engine at once (not waiting for the watchdog), mark the gap in
   * the captions, and if iOS still refuses, ask for one tap.
   */
  private async recover(awayMs: number): Promise<void> {
    if (awayMs > 3000) {
      const away = awayMs < 60_000 ? `${Math.round(awayMs / 1000)} 秒` : `${Math.round(awayMs / 60_000)} 分钟`;
      this.lines.push({ id: uid('l'), sessionId: this.session.id, t: this.elapsed(), en: '', zh: `（你离开了约 ${away}，这段时间没有听到。用「语音备忘录」录了的话，下课后在这节课里导入录音就能补上）`, kind: 'lecture', priority: null });
      this.changed();
    }
    if (awayMs <= 3000) {
      // A blink (notification pulled down, Control Centre): restart only if listening really stopped.
      await new Promise((r) => setTimeout(r, 700));
      if (!this.unhealthy(audioHealth())) return;
    }
    let ok = await this.restart();
    if (!ok && !this.paused && !this.ended) {
      await new Promise((r) => setTimeout(r, 800));
      ok = await this.restart();
    }
    if (ok) this.clearTap();
    else this.askTap();
  }

  private restarting: Promise<boolean> | null = null;
  /** Fresh microphone + audio engine + listener; true once audio with real sound is arriving again. */
  private restart(): Promise<boolean> {
    this.restarting ??= (async () => {
      this.repairing = true;
      try {
        this.stopListening();
        this.mic = await restartMic();
        this.watchMic();
        this.recorder?.switchStream(this.mic);
        if (this.paused || this.ended) return false;
        this.startListening();
        void keepScreenOn(true);
        return await this.waitHealthy(2500);
      } catch {
        return false;
      } finally {
        this.repairing = false;
        this.restarting = null;
      }
    })();
    return this.restarting;
  }

  private async waitHealthy(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      if (!this.unhealthy(audioHealth())) return true;
    }
    return !this.unhealthy(audioHealth());
  }

  /** Surely not hearing: engine not running, no audio blocks, or the microphone track is muted / ended. */
  private unhealthy(h: ReturnType<typeof audioHealth>): boolean {
    return h.state !== 'running' || h.msSinceAudio >= 3000 || h.muted;
  }

  /**
   * Probably not hearing: audio blocks arrive but are exact zeros (iOS sometimes keeps a "live" microphone that
   * delivers only silence after coming back). A real microphone is never exactly silent, but to be safe this only
   * triggers a quiet restart now and then, never a request to tap.
   */
  private silentZeros(h: ReturnType<typeof audioHealth>): boolean {
    return h.msSinceSound >= 6000;
  }
  private lastZeroRestart = 0;

  private askTap(): void {
    this.needTap = true;
    this.audioError = '点一下屏幕任意位置，马上继续听课';
    this.error = this.audioError;
    this.changed();
  }

  private clearTap(): void {
    const was = this.needTap || !!this.audioError;
    this.needTap = false;
    if (this.audioError && this.error === this.audioError) this.error = '';
    this.audioError = '';
    this.failedRepairs = 0;
    if (was) this.changed();
  }

  /** The class microphone, shared with the hold-to-ask button. */
  get micStream(): MediaStream | null {
    return this.mic;
  }

  /**
   * Every second: is microphone audio really arriving? iOS can interrupt the audio engine (another sound, Siri,
   * a notification, a call) and then nothing is heard while everything looks fine — that lost whole classes.
   * Repair automatically; if that fails, tell the learner to tap the screen (a tap always lets audio restart).
   */
  private startWatchdog(): void {
    window.clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => void this.checkAudio(), 1000);
  }

  private async checkAudio(): Promise<void> {
    if (this.paused || this.ended || !this.listener || this.repairing || document.hidden) return;
    const h = audioHealth();
    const healthy = !this.unhealthy(h);
    const zeros = healthy && this.silentZeros(h);
    const level = healthy && !zeros ? Math.min(1, h.level * 12) : -1;
    const flipped = (level < 0) !== (this.level < 0);
    this.level = level;
    this.onLevel?.(level);
    if (flipped) this.changed();
    if (healthy) {
      this.clearTap();
      if (zeros && Date.now() - this.lastZeroRestart > 120_000) {
        this.lastZeroRestart = Date.now();
        await this.restart();
      }
      return;
    }
    if (this.needTap) return; // waiting for the tap; restarting again without one would fail the same way
    const ok = await this.restart();
    if (ok) {
      this.clearTap();
      return;
    }
    this.failedRepairs++;
    if (this.failedRepairs >= 1) this.askTap();
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
    // The app itself is talking (reading an answer aloud, conversation practice): not class speech.
    if (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking) return;
    this.bytesUp += blob.size;
    const line: Line = { id: uid('l'), sessionId: this.session.id, t: Math.max(0, startedAt - this.session.startedAt - this.pausedMs), en: '', kind: 'pending', priority: null };
    this.lines.push(line);
    this.changed();
    let done: () => void = () => {};
    this.sttPending.push(new Promise<void>((r) => (done = r)));
    this.sttQueue.push(async () => {
      try {
        const text = (await api.stt(blob, 'en', { live: true })).text.trim();
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
    window.clearInterval(this.watchdog);
    this.listenPage(false);
    this.pause();
    if (this.mic) {
      this.mic = null;
      releaseMic();
    }
  }

  private ended = false;
  get isEnded(): boolean {
    return this.ended;
  }

  async end(): Promise<ClassSession> {
    this.ended = true;
    window.clearInterval(this.watchdog);
    this.listenPage(false);
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
