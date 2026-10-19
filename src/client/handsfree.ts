// Hands-free conversation mode (like a voice chat): tap once, then just talk.
// Listen → when the learner pauses → send the turn → the app reads the reply aloud → listen again.
// The microphone is off while the reply is read, so the app never hears itself.

import { speakAsync } from './device';
import { h, icon, replace } from './dom';
import { Recognizer } from './recognizer';

export type HandsFreeState = 'off' | 'listening' | 'thinking' | 'speaking';

export interface HandsFreeOptions {
  lang: 'en-US' | 'zh-CN';
  /** Silence after the last heard word that ends a turn. Beginners pause while thinking, so keep it generous. */
  pauseMs?: number;
  onInterim: (text: string) => void;
  onState?: (s: HandsFreeState) => void;
  /** Handle one finished turn (send it, show the reply, read it with `say`). Listening resumes when it resolves. */
  onTurn: (text: string) => Promise<void>;
  onError: (message: string) => void;
}

export class HandsFree {
  state: HandsFreeState = 'off';
  private rec: Recognizer | null = null;
  private heard = '';
  private timer: number | undefined;

  constructor(private o: HandsFreeOptions) {}

  get on(): boolean {
    return this.state !== 'off';
  }

  start(): void {
    if (this.on) return;
    speechSynthesis?.cancel();
    this.listen();
  }

  stop(): void {
    window.clearTimeout(this.timer);
    const r = this.rec;
    this.rec = null;
    this.heard = '';
    r?.stop();
    speechSynthesis?.cancel();
    this.o.onInterim('');
    this.set('off');
  }

  /** Read a reply aloud with the microphone off. */
  async say(text: string, lang: 'en-US' | 'zh-CN' = 'en-US'): Promise<void> {
    if (!this.on) return;
    this.set('speaking');
    await speakAsync(text, { lang });
  }

  private set(s: HandsFreeState): void {
    this.state = s;
    this.o.onState?.(s);
  }

  private listen(): void {
    this.heard = '';
    this.set('listening');
    const rec = new Recognizer(this.o.lang, {
      onInterim: (t) => {
        if (this.rec !== rec) return;
        this.o.onInterim(join(this.heard, t));
        if (t) this.arm();
      },
      onFinal: (t) => {
        if (this.rec !== rec) return;
        this.heard = join(this.heard, t);
        this.o.onInterim(this.heard);
        this.arm();
      },
      onError: (m) => {
        this.o.onError(m);
        if (/权限|不支持/.test(m)) this.stop();
      },
    });
    this.rec = rec;
    rec.start();
  }

  private arm(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.commit(), this.o.pauseMs ?? 2500);
  }

  private async commit(): Promise<void> {
    const r = this.rec;
    if (!r) return;
    r.stop(); // flushes pending interim text into `heard` via onFinal
    this.rec = null;
    window.clearTimeout(this.timer);
    const text = this.heard.trim();
    this.heard = '';
    this.o.onInterim('');
    if (!this.on) return;
    if (!text) return this.listen();
    this.set('thinking');
    try {
      await this.o.onTurn(text);
    } catch (e) {
      this.o.onError(e instanceof Error ? e.message : String(e));
    }
    // Short breath after the reply before listening again, so the pace stays relaxed.
    if (this.on) window.setTimeout(() => this.on && this.state !== 'listening' && this.listen(), 700);
  }
}

function join(a: string, b: string): string {
  return [a, b].filter(Boolean).join(' ').trim();
}

const LABEL: Record<HandsFreeState, string> = { off: '对话模式', listening: '在听…点我停', thinking: '在想…', speaking: '在说…' };

/** The big mic button: tap to start the voice conversation, tap again to stop. */
export function handsFreeButton(hf: HandsFree, offLabel = LABEL.off): { el: HTMLButtonElement; update: (s: HandsFreeState) => void } {
  const el = h('button', { class: 'hold', 'aria-label': offLabel }) as HTMLButtonElement;
  const update = (s: HandsFreeState) => {
    el.classList.toggle('on', s !== 'off');
    el.setAttribute('aria-pressed', String(s !== 'off'));
    replace(el, icon(s === 'off' ? 'mic' : 'stop', 18), s === 'off' ? offLabel : LABEL[s]);
  };
  el.addEventListener('click', () => (hf.on ? hf.stop() : hf.start()));
  update('off');
  return { el, update };
}
