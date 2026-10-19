// Records the class in independent chunks of CHUNK_MS each, so every chunk is a playable file
// small enough for one transcription request (upload limit 25 MB, ~60 s processing).
// Chunks are handed to `onChunk` (saved to IndexedDB by the caller).

const CHUNK_MS = 3 * 60 * 1000;

function pickMime(): string {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export class ChunkRecorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private timer: number | undefined;
  private index = 0;
  private active = false;
  private chunkStart = 0;
  readonly mime = pickMime();

  constructor(private onChunk: (blob: Blob, index: number, startedAt: number, mime: string) => void) {}

  private ownStream = false;

  /** Pass the class's microphone stream to share it (one microphone for listening and recording). */
  async start(shared?: MediaStream): Promise<void> {
    this.ownStream = !shared;
    this.stream =
      shared ??
      (await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      }));
    this.active = true;
    this.next();
  }

  /** Pause between chunks (class break); resume starts a fresh chunk. */
  pause(): void {
    this.active = false;
    window.clearTimeout(this.timer);
    if (this.rec?.state === 'recording') this.rec.stop();
  }

  resume(): void {
    if (!this.stream || this.active) return;
    this.active = true;
    this.next();
  }

  async stop(): Promise<void> {
    this.pause();
    // Give the last chunk's dataavailable event a moment to fire.
    await new Promise((r) => setTimeout(r, 300));
    if (this.ownStream) this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private next(): void {
    if (!this.stream || !this.active) return;
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 32000 } : undefined);
    const parts: Blob[] = [];
    const index = this.index++;
    this.chunkStart = Date.now();
    const startedAt = this.chunkStart;
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = () => {
      if (parts.length) {
        const mime = rec.mimeType || this.mime || 'audio/mp4';
        this.onChunk(new Blob(parts, { type: mime }), index, startedAt, mime);
      }
      if (this.active) this.next();
    };
    rec.start();
    this.rec = rec;
    this.timer = window.setTimeout(() => rec.state === 'recording' && rec.stop(), CHUNK_MS);
  }
}
