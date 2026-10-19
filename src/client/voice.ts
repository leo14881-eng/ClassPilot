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

  /** Finish the current utterance now (the tap-to-stop button). */
  finish(): void {
    this.stopNow?.();
  }

  /** Release the microphone (e.g. while the app is talking, so iOS plays at full volume). */
  release(): void {
    this.stopNow?.();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /** Record until the learner pauses. Resolves with the audio, or null if nothing was said. */
  async record(o: UtteranceOptions): Promise<Blob | null> {
    unlockAudio();
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
          resolve(keep && (spoke || !analyser) && blob.size > 1500 ? blob : null);
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
      rec.start(250);
    });
  }
}
