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
  if (ctx.state === 'suspended') void ctx.resume();
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

/** Tracks the background level and decides whether a frame is speech. */
class Vad {
  private floor = 0.004;
  loud(level: number): boolean {
    const threshold = Math.max(0.01, this.floor * 2.5);
    const loud = level > threshold;
    if (!loud) this.floor = this.floor * 0.97 + level * 0.03;
    else this.floor = Math.min(this.floor * 1.002, 0.05);
    return loud;
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
    const pauseMs = this.o.pauseMs ?? 700;
    const softMax = this.o.softMaxMs ?? 4500;
    const hardMax = this.o.hardMaxMs ?? 7000;
    const vad = new Vad();
    let frames: Float32Array[] = [];
    let level: number[] = [];
    let voiced: boolean[] = [];
    let sinceLoud = 0;
    let speaking = false;
    let segStart = Date.now();
    const speechMs = () => voiced.filter(Boolean).length * FRAME_MS;
    const take = (n: number) => {
      const out = frames.slice(0, n);
      const outVoiced = voiced.slice(0, n).filter(Boolean).length * FRAME_MS;
      frames = frames.slice(n);
      level = level.slice(n);
      voiced = voiced.slice(n);
      const started = segStart;
      segStart = Date.now() - frames.length * FRAME_MS;
      if (outVoiced >= 190) this.o.onSegment(toWav(out), started);
    };
    this.flush = () => take(frames.length);
    this.tap = new PcmTap(this.stream, (f) => {
      const l = rms(f);
      const loud = vad.loud(l);
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
        // Fast non-stop speech: cut at the quietest frame of the last ~1.5 s (2.5 s once past the hard limit).
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
