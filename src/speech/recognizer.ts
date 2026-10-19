// Continuous speech recognition on top of the browser's Web Speech API (Safari: webkitSpeechRecognition).
// Safari stops recognition every so often; we restart it automatically while running.
// iOS also sometimes never marks a result final, so an utterance that stops changing for
// SILENCE_MS is emitted as final anyway.

interface SRAlternative { transcript: string }
interface SRResult { isFinal: boolean; 0: SRAlternative; length: number }
interface SRResultList { length: number; [i: number]: SRResult }
interface SREvent { resultIndex: number; results: SRResultList }
interface SR {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

type SRCtor = new () => SR;

function ctor(): SRCtor | null {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return ctor() !== null;
}

const SILENCE_MS = 1400;

export interface RecognizerEvents {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
}

export class Recognizer {
  private sr: SR | null = null;
  private running = false;
  private interim = '';
  private silenceTimer: number | undefined;
  private restartTimer: number | undefined;

  constructor(
    private lang: string,
    private events: RecognizerEvents,
    private continuous = true,
  ) {}

  start(): void {
    const C = ctor();
    if (!C) {
      this.events.onError?.('这个浏览器不支持语音识别，请用 iPhone 的 Safari 打开');
      return;
    }
    this.running = true;
    this.spawn(C);
  }

  /** Stop listening; any pending interim text is emitted as final. */
  stop(): void {
    this.running = false;
    window.clearTimeout(this.restartTimer);
    this.flush();
    try {
      this.sr?.stop();
    } catch {
      /* already stopped */
    }
    this.sr = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private spawn(C: SRCtor): void {
    const sr = new C();
    sr.lang = this.lang;
    sr.continuous = this.continuous;
    sr.interimResults = true;
    sr.onresult = (e) => this.handle(e);
    sr.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.running = false;
        this.events.onError?.('没有麦克风或语音识别权限：请在 iPhone 设置 > Safari > 麦克风 中允许，并打开 Siri 与听写');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.events.onError?.(`语音识别出错：${e.error}`);
      }
    };
    sr.onend = () => {
      this.flush();
      if (this.running && this.continuous) {
        this.restartTimer = window.setTimeout(() => this.running && this.spawn(C), 150);
      }
    };
    this.sr = sr;
    try {
      sr.start();
    } catch {
      /* start() throws if called twice; onend will retry */
    }
  }

  private handle(e: SREvent): void {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0].transcript;
      if (r.isFinal) {
        this.emit(text);
      } else {
        interim += text;
      }
    }
    this.interim = interim.trim();
    this.events.onInterim?.(this.interim);
    window.clearTimeout(this.silenceTimer);
    if (this.interim) {
      this.silenceTimer = window.setTimeout(() => {
        // Utterance stopped changing: treat as final and restart to clear Safari's buffer.
        this.flush();
        try {
          this.sr?.abort();
        } catch {
          /* ignore */
        }
      }, SILENCE_MS);
    }
  }

  private flush(): void {
    window.clearTimeout(this.silenceTimer);
    if (this.interim) {
      const t = this.interim;
      this.interim = '';
      this.events.onInterim?.('');
      this.emit(t);
    }
  }

  private emit(text: string): void {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) this.events.onFinal(t);
  }
}
