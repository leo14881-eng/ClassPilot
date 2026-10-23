// Microphone capture for server-side transcription (the phone's own recognizer mishears accents and skips speech).
//
// - One shared microphone for the whole app (acquireMic/releaseMic): iOS shows its "microphone enabled" banner
//   every time capture starts, so the stream stays open while any screen uses it and for a while after.
// - Audio is tapped as raw PCM (16 kHz mono) and cut into WAV files in the browser: no recorder restarts,
//   so nothing is lost between sentences, and cuts can be placed in the quietest moment.

const RATE = 16_000;
const FRAME_MS = 1000 / (RATE / 1024); // ~64 ms analysis frames at 16 kHz

export function voiceSupported(): boolean {
  return !!navigator.mediaDevices?.getUserMedia && !!(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);
}

let ctx: AudioContext | null = null;

/** Create/resume the audio context; call from a tap so iOS allows it. */
export function unlockAudio(): void {
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return;
  ctx ??= new C();
  // iOS puts the context in "interrupted" when another sound, Siri, a call or a notification takes the audio session.
  if (ctx.state !== 'running') void ctx.resume().catch(() => {});
}

// ---------- audio health (iOS can silently stop delivering microphone audio) ----------

let lastFrameAt = 0;
let lastLevel = 0;

/** Is microphone audio actually arriving? `msSinceAudio` is time since the last audio block was processed. */
export function audioHealth(): { state: string; msSinceAudio: number; level: number } {
  return { state: ctx?.state ?? 'none', msSinceAudio: lastFrameAt ? Date.now() - lastFrameAt : Infinity, level: lastLevel };
}

/**
 * Get the audio engine running again after an iOS interruption: resume it, and if that does not work, replace it
 * with a new one (allowed while the microphone is in use). Returns true when it is running. Callers must then
 * re-create their audio taps (they belong to the old engine).
 */
export async function repairAudio(): Promise<boolean> {
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return false;
  if (ctx && ctx.state !== 'running') {
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 700))]);
  }
  if (!ctx || ctx.state !== 'running') {
    try {
      void ctx?.close().catch(() => {});
    } catch {
      /* already closed */
    }
    const rate = mic?.getAudioTracks()[0]?.getSettings?.().sampleRate;
    try {
      ctx = rate ? new C({ sampleRate: rate }) : new C();
    } catch {
      ctx = new C();
    }
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 700))]);
  }
  return ctx.state === 'running';
}

// A tap is the one moment iOS always allows audio to start: use any tap to un-stick an interrupted engine.
if (typeof document !== 'undefined') {
  for (const ev of ['pointerdown', 'touchend']) {
    document.addEventListener(ev, () => ctx && ctx.state !== 'running' && void ctx.resume().catch(() => {}), { capture: true, passive: true });
  }
}

/**
 * iOS: an AudioContext created before the microphone opened can run at a different rate than the microphone,
 * which garbles the captured audio. Recreate it at the microphone's rate (allowed while capture is active).
 */
function matchContextToMic(s: MediaStream): void {
  const rate = s.getAudioTracks()[0]?.getSettings?.().sampleRate;
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C || !rate || (ctx && ctx.sampleRate === rate)) return;
  try {
    void ctx?.close();
    ctx = new C({ sampleRate: rate });
    void ctx.resume();
  } catch {
    ctx ??= new C();
  }
}

/** Short description of the audio setup, sent with each clip to diagnose recognition problems. */
export function audioInfo(): string {
  const t = mic?.getAudioTracks()[0];
  const st = t?.getSettings?.() ?? {};
  return `ctx=${ctx?.sampleRate ?? 0}/${ctx?.state ?? 'none'} mic=${st.sampleRate ?? '?'} ch=${st.channelCount ?? '?'} ec=${st.echoCancellation ?? '?'} ns=${st.noiseSuppression ?? '?'} ${/iPhone|iPad/.test(navigator.userAgent) ? 'iOS' : ''}`.trim();
}

// ---------- one shared microphone ----------

let mic: MediaStream | null = null;
let micOpening: Promise<MediaStream> | null = null;
let users = 0;
let idleTimer: number | undefined;
const IDLE_CLOSE_MS = 3 * 60_000;

/** Get the shared microphone (opened once; reopened only if iOS ended it). Pair with releaseMic(). */
export async function acquireMic(): Promise<MediaStream> {
  unlockAudio();
  users++;
  window.clearTimeout(idleTimer);
  if (mic && mic.active && mic.getAudioTracks().some((t) => t.readyState === 'live')) return mic;
  micOpening ??= navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
    .then((s) => {
      mic = s;
      matchContextToMic(s);
      return s;
    })
    .catch(() => {
      throw new Error('没有麦克风权限：请在 iPhone 设置 > Safari > 麦克风 中选“允许”');
    })
    .finally(() => (micOpening = null));
  try {
    return await micOpening;
  } catch (e) {
    users = Math.max(0, users - 1);
    throw e;
  }
}

/** Done with the microphone; it closes after a few idle minutes (reopening shows the iOS banner again). */
export function releaseMic(): void {
  users = Math.max(0, users - 1);
  if (users > 0) return;
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (users > 0) return;
    mic?.getTracks().forEach((t) => t.stop());
    mic = null;
  }, IDLE_CLOSE_MS);
}

// ---------- raw PCM tap ----------

/** Streams 16 kHz mono frames (Float32Array of 1024 samples) from the microphone until stopped. */
class PcmTap {
  private source: MediaStreamAudioSourceNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private carry = new Float32Array(0);

  constructor(
    stream: MediaStream,
    private onFrame: (frame: Float32Array) => void,
  ) {
    // Tests feed frames directly (no audio hardware).
    const hook = (globalThis as unknown as { __captureTap?: (cb: (f: Float32Array) => void) => void }).__captureTap;
    if (hook) {
      hook(onFrame);
      return;
    }
    unlockAudio();
    if (!ctx) return;
    const c = ctx;
    this.source = c.createMediaStreamSource(stream);
    this.proc = c.createScriptProcessor(4096, 1, 1);
    this.sink = c.createGain();
    this.sink.gain.value = 0; // the processor only runs when connected to the output; keep it silent
    const ratio = c.sampleRate / RATE;
    this.proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      lastFrameAt = Date.now();
      let sq = 0;
      for (let i = 0; i < input.length; i += 16) sq += input[i] * input[i];
      lastLevel = Math.sqrt(sq / (input.length / 16));
      const out = new Float32Array(Math.floor(input.length / ratio));
      for (let i = 0; i < out.length; i++) {
        const x = i * ratio;
        const i0 = Math.floor(x);
        const i1 = Math.min(i0 + 1, input.length - 1);
        out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0);
      }
      const all = new Float32Array(this.carry.length + out.length);
      all.set(this.carry);
      all.set(out, this.carry.length);
      let off = 0;
      for (; off + 1024 <= all.length; off += 1024) this.onFrame(all.slice(off, off + 1024));
      this.carry = all.slice(off);
    };
    this.source.connect(this.proc);
    this.proc.connect(this.sink);
    this.sink.connect(c.destination);
  }

  stop(): void {
    if (this.proc) this.proc.onaudioprocess = null;
    this.source?.disconnect();
    this.proc?.disconnect();
    this.sink?.disconnect();
    this.source = this.proc = this.sink = null;
  }
}

function rms(f: Float32Array): number {
  let s = 0;
  for (const v of f) s += v * v;
  return Math.sqrt(s / f.length);
}

/**
 * Class captions: 12 kHz 8-bit μ-law WAV, about 37% of 16 kHz PCM. Measured on 60 hard learner clips:
 * same word error rate as full quality (4.5%), while 8 kHz lost accuracy. The server expands it to PCM.
 */
export function toCompactWav(frames: Float32Array[]): Blob {
  const n16 = frames.reduce((a, f) => a + f.length, 0);
  const src = new Float32Array(n16);
  let p = 0;
  for (const f of frames) {
    src.set(f, p);
    p += f.length;
  }
  const RATE_OUT = 12_000;
  const n = Math.floor((n16 * RATE_OUT) / RATE);
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o: number, x: string) => [...x].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 7, true); // μ-law
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE_OUT, true);
  v.setUint32(28, RATE_OUT, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, n, true);
  const ratio = RATE / RATE_OUT;
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, n16 - 1);
    v.setUint8(44 + i, mulaw(src[i0] + (src[i1] - src[i0]) * (x - i0)));
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** G.711 μ-law encode of one sample in [-1, 1]. */
export function mulaw(x: number): number {
  let s = Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  s = Math.min(32635, s) + 132;
  let e = 7;
  for (let m = 0x4000; (s & m) === 0 && e > 0; m >>= 1) e--;
  const man = (s >> (e + 3)) & 0x0f;
  return ~(sign | (e << 4) | man) & 0xff;
}

function toWav(frames: Float32Array[]): Blob {
  const n = frames.reduce((a, f) => a + f.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (const f of frames) {
    for (const x of f) {
      const c = Math.max(-1, Math.min(1, x));
      v.setInt16(o, c < 0 ? c * 0x8000 : c * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Decides whether a frame is speech. The background level is the quiet end (15th percentile) of the last ~4 s,
 * so it is never pulled up by the speaker's own softer syllables (that bug cut sentences in the middle).
 * Hysteresis: speech starts above 3× background, and only counts as stopped below 1.8× background.
 */
export class Vad {
  private recent: number[] = [];
  private speaking = false;

  loud(level: number): boolean {
    this.recent.push(level);
    if (this.recent.length > 64) this.recent.shift();
    const sorted = [...this.recent].sort((x, y) => x - y);
    const floor = Math.min(0.03, sorted[Math.floor(sorted.length * 0.15)] ?? level);
    const on = Math.max(0.008, floor * 3);
    const off = Math.max(0.006, floor * 1.8);
    this.speaking = this.speaking ? level > off : level > on;
    return this.speaking;
  }
}

// ---------- one answer (practice, conversation turn, hold-to-ask) ----------

export interface UtteranceOptions {
  /** Silence after speech that ends the answer. */
  silenceMs: number;
  /** Hard stop. */
  maxMs: number;
  /** Give up if nothing is said for this long (returns null). */
  noSpeechMs?: number;
  /** Called once when speech starts. */
  onSpeech?: () => void;
  /** Hold-to-talk: keep the recording even if no speech was detected. */
  keepQuiet?: boolean;
}

export class VoiceCapture {
  private stopNow: (() => void) | null = null;
  private holding = false;

  /** Finish the current answer now (tap-to-stop / release the hold button). */
  finish(): void {
    this.stopNow?.();
  }

  /** Done with this screen: stop any recording and give the shared microphone back. */
  release(): void {
    this.stopNow?.();
    if (this.holding) {
      this.holding = false;
      releaseMic();
    }
  }

  /** Record until the speaker pauses. Resolves with a WAV, or null if nothing was said. */
  async record(o: UtteranceOptions): Promise<Blob | null> {
    if (!this.holding) {
      await acquireMic();
      this.holding = true;
    }
    const stream = mic!;
    return new Promise<Blob | null>((resolve) => {
      const frames: Float32Array[] = [];
      const vad = new Vad();
      let elapsed = 0;
      let speechMs = 0;
      let spoke = false;
      let sinceLoud = 0;
      let done = false;
      const end = (keep: boolean) => {
        if (done) return;
        done = true;
        tap.stop();
        this.stopNow = null;
        // Keep ~300 ms of lead-in, drop long leading silence.
        resolve(keep && (spoke || o.keepQuiet) && frames.length > 4 ? toWav(frames) : null);
      };
      const tap = new PcmTap(stream, (f) => {
        if (done) return;
        elapsed += FRAME_MS;
        const loud = vad.loud(rms(f));
        frames.push(f);
        if (!spoke && frames.length > 5) frames.shift(); // before speech: keep only a short lead-in
        if (loud) {
          speechMs += FRAME_MS;
          sinceLoud = 0;
          if (!spoke && speechMs >= 190) {
            spoke = true;
            o.onSpeech?.();
          }
        } else sinceLoud += FRAME_MS;
        if (spoke && sinceLoud >= o.silenceMs) end(true);
        else if (!spoke && o.noSpeechMs && elapsed > o.noSpeechMs) end(false);
        else if (elapsed > o.maxMs) end(true);
      });
      this.stopNow = () => end(true);
      if (!ctx) end(false);
    });
  }
}

// ---------- class: continuous listening, cut into sentences ----------

export interface SegmentOptions {
  /** A pause this long ends a sentence. */
  pauseMs?: number;
  /** Long speech is cut near this length, at the quietest moment… */
  softMaxMs?: number;
  /** …and always by this length. */
  hardMaxMs?: number;
  /** One spoken segment (WAV), in order. */
  onSegment: (wav: Blob, startedAt: number) => void;
  /** true while someone is talking. */
  onSpeaking?: (speaking: boolean) => void;
}

/**
 * Continuous listening for class / videos: every sample goes into exactly one segment (no gaps),
 * segments end at pauses or, in fast non-stop speech, at the quietest moment of the last second or two.
 */
export class SegmentListener {
  private tap: PcmTap | null = null;
  private flush: (() => void) | null = null;

  constructor(
    private stream: MediaStream,
    private o: SegmentOptions,
  ) {}

  start(): void {
    if (this.tap) return;
    const pauseMs = this.o.pauseMs ?? 800;
    const softMax = this.o.softMaxMs ?? 8000;
    const hardMax = this.o.hardMaxMs ?? 12000;
    const vad = new Vad();
    let frames: Float32Array[] = [];
    let level: number[] = [];
    let voiced: boolean[] = [];
    let sinceLoud = 0;
    let speaking = false;
    let segStart = Date.now();
    const speechMs = () => voiced.filter(Boolean).length * FRAME_MS;
    const take = (n: number) => {
      // Drop the silence after the last word (keep ~0.2 s) — it is pure upload cost.
      const outV = voiced.slice(0, n);
      const lastVoiced = outV.lastIndexOf(true);
      const out = frames.slice(0, Math.min(n, lastVoiced + 4));
      const outVoiced = outV.filter(Boolean).length * FRAME_MS;
      frames = frames.slice(n);
      level = level.slice(n);
      voiced = voiced.slice(n);
      const started = segStart;
      segStart = Date.now() - frames.length * FRAME_MS;
      if (outVoiced >= 190) this.o.onSegment(toCompactWav(out), started);
    };
    this.flush = () => take(frames.length);
    this.tap = new PcmTap(this.stream, (f) => {
      const l = rms(f);
      const loud = vad.loud(l);
      // First word of a new sentence: drop the silence before it (keep ~0.25 s lead-in), so the length limits
      // below measure speech, not the gap since the last sentence (that gap used to force a cut mid-sentence).
      if (loud && !voiced.some(Boolean) && frames.length > 4) {
        const drop = frames.length - 4;
        frames = frames.slice(drop);
        level = level.slice(drop);
        voiced = voiced.slice(drop);
        segStart = Date.now() - frames.length * FRAME_MS;
      }
      frames.push(f);
      level.push(l);
      voiced.push(loud);
      sinceLoud = loud ? 0 : sinceLoud + FRAME_MS;
      const sp = speechMs();
      const isSpeaking = sp > 0 && sinceLoud < pauseMs;
      if (isSpeaking !== speaking) {
        speaking = isSpeaking;
        this.o.onSpeaking?.(speaking);
      }
      const len = frames.length * FRAME_MS;
      const hadSpeech = sp >= 190;
      if (hadSpeech && sinceLoud >= (sp >= 1000 ? pauseMs : pauseMs * 2)) {
        // A pause ends the sentence (a short fragment waits a little longer, so a question is not split in two).
        take(frames.length);
      } else if (hadSpeech && len >= softMax) {
        // Long non-stop speech (8 s+): cut at the quietest frame of the last ~1.5 s (2.5 s once past 12 s).
        const win = Math.round((len >= hardMax ? 2500 : 1500) / FRAME_MS);
        const from = Math.max(1, frames.length - win);
        let best = from;
        for (let i = from; i < frames.length; i++) if (level[i] < level[best]) best = i;
        const peak = Math.max(...level.slice(from));
        if (level[best] < peak * 0.35 || len >= hardMax) take(best + 1);
      } else if (!hadSpeech && len > 3000) {
        // Background only: drop it, keep a short lead-in for the next word.
        const drop = frames.length - 4;
        frames = frames.slice(drop);
        level = level.slice(drop);
        voiced = voiced.slice(drop);
        segStart = Date.now() - frames.length * FRAME_MS;
      }
    });
  }

  /** Stop listening; a sentence in progress is still sent. */
  stop(): void {
    this.tap?.stop();
    this.tap = null;
    this.flush?.();
    this.flush = null;
  }
}
