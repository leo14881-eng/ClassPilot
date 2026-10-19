// Hands-free conversation mode (like a voice chat): tap once, then just talk.
// Record → when the learner pauses → transcribe on the server → send the turn → read the reply aloud → listen again.
// The microphone stays open for the whole conversation (reopening it makes iOS show a banner every turn),
// but nothing is recorded while the reply is read, so the app never hears itself. The screen is kept on.

import { api } from './api';
import { keepScreenOn, speakAsync } from './device';
import { h, icon, replace } from './dom';
import { VoiceCapture } from './voice';

export type HandsFreeState = 'off' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking';

export interface HandsFreeOptions {
  lang: 'en-US' | 'zh-CN';
  /** Silence after speech that ends a turn. Beginners pause while thinking, so keep it generous. */
  pauseMs?: number;
  /** Words that help the transcriber (e.g. the AI's last line). */
  hint?: () => string;
  /** Shows what is happening in the chat: '' clears it. */
  onInterim: (text: string) => void;
  onState?: (s: HandsFreeState) => void;
  /** Handle one finished turn (send it, show the reply, read it with `say`). Listening resumes when it resolves. */
  onTurn: (text: string) => Promise<void>;
  onError: (message: string) => void;
}

export class HandsFree {
  state: HandsFreeState = 'off';
  private voice = new VoiceCapture();
  private loop = 0;

  constructor(private o: HandsFreeOptions) {}

  get on(): boolean {
    return this.state !== 'off';
  }

  start(): void {
    if (this.on) return;
    speechSynthesis?.cancel();
    void keepScreenOn(true); // don't let the phone lock mid-conversation
    void this.run(++this.loop);
  }

  stop(): void {
    this.loop++;
    this.voice.release();
    void keepScreenOn(false);
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

  private async run(id: number): Promise<void> {
    const live = () => this.loop === id;
    while (live()) {
      this.set('listening');
      this.o.onInterim('（在听，说完停一下就会发送）');
      let blob: Blob | null;
      try {
        blob = await this.voice.record({
          silenceMs: this.o.pauseMs ?? 2500,
          maxMs: 45_000,
          noSpeechMs: 60_000,
          onSpeech: () => live() && (this.set('hearing'), this.o.onInterim('（在听你说…）')),
        });
      } catch (e) {
        this.o.onError(e instanceof Error ? e.message : String(e));
        if (live()) this.stop();
        return;
      }
      if (!live()) return;
      if (!blob) {
        // A minute of silence: stop instead of listening forever.
        this.o.onError('一分钟没听到声音，对话模式先停了');
        this.stop();
        return;
      }
      // Keep the microphone open for the whole conversation: reopening it makes iOS show its permission banner every turn.
      this.set('transcribing');
      this.o.onInterim('（识别中…）');
      let text = '';
      try {
        text = (await api.stt(blob, this.o.lang === 'zh-CN' ? 'zh' : 'en', this.o.hint?.() ?? '')).text.trim();
      } catch (e) {
        this.o.onError(e instanceof Error ? e.message : String(e));
      }
      if (!live()) return;
      this.o.onInterim('');
      if (!text) {
        this.o.onError('没听清，请再说一遍');
        continue;
      }
      this.set('thinking');
      try {
        await this.o.onTurn(text);
      } catch (e) {
        this.o.onError(e instanceof Error ? e.message : String(e));
      }
      // Short breath after the reply before listening again, so the pace stays relaxed.
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

const LABEL: Record<HandsFreeState, string> = { off: '对话模式', listening: '在听…点我停', hearing: '在听…点我停', transcribing: '识别中…', thinking: '在想…', speaking: '在说…' };

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
