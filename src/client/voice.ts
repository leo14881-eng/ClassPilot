// Record one spoken answer and detect when the learner has finished (a pause), for server-side transcription.
// The phone's built-in recognizer often mishears a Chinese accent, so practice answers and conversation turns
// are recorded and transcribed on the server instead (gpt-4o-transcribe / Whisper).

function pickMime(): string {
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

export function voiceSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export interface UtteranceOptions {
  /** Silence after speech that ends the answer. */
  silenceMs: number;
  /** Hard stop. */
  maxMs: number;
  /** Give up if nothing is said for this long (returns null). */
  noSpeechMs?: number;
  /** 0..1 microphone level, for a small meter. */
  onLevel?: (level: number) => void;
  /** Called once when speech starts. */
  onSpeech?: () => void;
  /** Hold-to-talk: keep the recording even if the level meter never saw speech. */
  keepQuiet?: boolean;
}

let ctx: AudioContext | null = null;

/** Create/resume the audio context; call from a tap so iOS allows it. */
export function unlockAudio(): void {
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return;
  ctx ??= new C();
  if (ctx.state === 'suspended') void ctx.resume();
}

export class VoiceCapture {
  private stream: MediaStream | null = null;
  private stopNow: (() => void) | null = null;

  /** `shared`: use a microphone stream that is already open (the class), instead of opening another. */
  constructor(private shared?: () => MediaStream | null) {}

  /** Finish the current utterance now (the tap-to-stop button). */
  finish(): void {
    this.stopNow?.();
  }

  /** Release the microphone (e.g. while the app is talking, so iOS plays at full volume). */
  release(): void {
    this.stopNow?.();
    if (this.stream && this.stream !== this.shared?.()) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /** Record until the learner pauses. Resolves with the audio, or null if nothing was said. */
  async record(o: UtteranceOptions): Promise<Blob | null> {
    unlockAudio();
    const shared = this.shared?.();
    if (shared?.active) this.stream = shared;
    if (!this.stream || !this.stream.active) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      } catch {
        throw new Error('没有麦克风权限：请在 iPhone 设置 > Safari > 麦克风 中允许这个网站');
      }
    }
    const stream = this.stream;
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);

    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    if (ctx) {
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
    }
    const buf = new Uint8Array(analyser?.fftSize ?? 0);
    const level = () => {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      return Math.sqrt(sum / buf.length);
    };

    return new Promise<Blob | null>((resolve) => {
      const t0 = performance.now();
      let floor = 0.01;
      let speechMs = 0;
      let spoke = false;
      let lastLoud = 0;
      let done = false;
      const end = (keep: boolean) => {
        if (done) return;
        done = true;
        window.clearInterval(tick);
        this.stopNow = null;
        source?.disconnect();
        rec.onstop = () => {
          const blob = new Blob(parts, { type: (rec.mimeType || mime || 'audio/mp4').split(';')[0] });
          resolve(keep && (spoke || !analyser || o.keepQuiet) && blob.size > 1500 ? blob : null);
        };
        if (rec.state !== 'inactive') rec.stop();
        else resolve(null);
      };
      this.stopNow = () => end(true);
      const tick = window.setInterval(() => {
        const now = performance.now();
        const l = level();
        o.onLevel?.(Math.min(1, l * 8));
        // Learn the room's noise level in the first moments, then speech = clearly above it.
        if (now - t0 < 400) floor = Math.max(floor, l);
        const loud = l > Math.max(0.025, floor * 2.5);
        if (loud) {
          speechMs += 50;
          lastLoud = now;
          if (!spoke && speechMs >= 200) {
            spoke = true;
            o.onSpeech?.();
          }
        }
        if (spoke && now - lastLoud > o.silenceMs) end(true);
        else if (!spoke && o.noSpeechMs && now - t0 > o.noSpeechMs) end(false);
        else if (now - t0 > o.maxMs) end(true);
      }, 50);
      rec.start(); // one blob on stop: a single complete file (iOS fragments are not reliable to join)
    });
  }
}

/** Open the microphone once (echo cancellation and gain control on, good for a room). */
export async function openMic(): Promise<MediaStream> {
  unlockAudio();
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch {
    throw new Error('没有麦克风权限：请在 iPhone 设置 > Safari > 麦克风 中允许这个网站');
  }
}

export interface SegmentOptions {
  /** A pause this long ends a sentence. */
  pauseMs?: number;
  /** Cut long speech near this length at the next quieter moment… */
  softMaxMs?: number;
  /** …and always by this length. */
  hardMaxMs?: number;
  /** One spoken segment, in order. */
  onSegment: (blob: Blob, startedAt: number) => void;
  /** true while someone is talking. */
  onSpeaking?: (speaking: boolean) => void;
}

/**
 * Continuous listening for class: records the room and cuts it into sentences at pauses, so every sentence
 * can be transcribed on the server. Nothing is lost between segments (the next recorder starts at once),
 * and stretches with no speech are thrown away.
 */
export class SegmentListener {
  private tick: number | undefined;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private running = false;
  private readonly mime = pickMime();

  constructor(
    private stream: MediaStream,
    private o: SegmentOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    unlockAudio();
    if (ctx) {
      this.source = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.source.connect(this.analyser);
    }
    const buf = new Uint8Array(this.analyser?.fftSize ?? 0);
    const pauseMs = this.o.pauseMs ?? 800;
    const softMax = this.o.softMaxMs ?? 9000;
    const hardMax = this.o.hardMaxMs ?? 14000;
    let floor = 0.01;
    let segStart = 0;
    let speechMs = 0;
    let lastLoud = 0;
    let speaking = false;
    const begin = () => {
      segStart = performance.now();
      speechMs = 0;
      lastLoud = 0;
      this.newRecorder(Date.now());
    };
    begin();
    this.tick = window.setInterval(() => {
      if (!this.running) return;
      const now = performance.now();
      let l = 0.05;
      if (this.analyser) {
        this.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        l = Math.sqrt(sum / buf.length);
      }
      const threshold = Math.max(0.012, floor * 2.2);
      const loud = l > threshold;
      // Track the room's background level slowly, only from quiet moments.
      if (!loud) floor = floor * 0.98 + l * 0.02;
      if (loud) {
        speechMs += 50;
        lastLoud = now;
      }
      const isSpeaking = loud || (lastLoud > 0 && now - lastLoud < pauseMs);
      if (isSpeaking !== speaking) {
        speaking = isSpeaking;
        this.o.onSpeaking?.(speaking);
      }
      const len = now - segStart;
      const hadSpeech = speechMs >= 250;
      // A short fragment ("Ask not…") waits for a longer pause, so a question is not split in two.
      const silentFor = now - lastLoud;
      const paused = hadSpeech && (speechMs >= 1200 ? silentFor >= pauseMs : silentFor >= pauseMs * 2.2);
      const longQuietish = hadSpeech && len > softMax && l < threshold * 1.5;
      if (paused || longQuietish || len > hardMax) {
        this.cut(hadSpeech);
        begin();
      } else if (!hadSpeech && len > 15000) {
        // Only background noise for a while: drop it and start fresh.
        this.cut(false);
        begin();
      }
    }, 50);
  }

  stop(): void {
    this.running = false;
    window.clearInterval(this.tick);
    this.cut(true);
    this.source?.disconnect();
    this.source = null;
    this.analyser = null;
  }

  private current: { rec: MediaRecorder; keep: boolean; startedAt: number } | null = null;

  private newRecorder(startedAt: number): void {
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 32000 } : undefined);
    const parts: Blob[] = [];
    const entry = { rec, keep: false, startedAt };
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(parts, { type: (rec.mimeType || this.mime || 'audio/mp4').split(';')[0] });
      if (entry.keep && blob.size > 1500) this.o.onSegment(blob, entry.startedAt);
    };
    rec.start(); // one blob on stop: a single complete file (iOS fragments are not reliable to join)
    this.current = entry;
  }

  private cut(keep: boolean): void {
    const c = this.current;
    this.current = null;
    if (!c) return;
    c.keep = keep;
    if (c.rec.state !== 'inactive') c.rec.stop();
  }
}
