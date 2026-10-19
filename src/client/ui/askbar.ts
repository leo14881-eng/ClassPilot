// Bottom bar in class: type a question (or one English word), or hold the button and speak Chinese.
// The spoken question is recorded and transcribed on the server (accurate with mixed Chinese/English);
// it uses the same shared microphone as the class, so iOS does not show its banner again.

import { api } from '../api';
import { h, icon, replace, toast } from '../dom';
import { VoiceCapture } from '../voice';

export interface AskBarOptions {
  onAsk: (text: string) => void;
  /** Called when the user starts holding (e.g. pause English listening in class). */
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
  placeholder?: string;
}

export function askBar(opts: AskBarOptions): HTMLElement {
  const placeholder = opts.placeholder ?? '查单词或提问，中英文都行';
  const input = h('input', { id: 'ask', placeholder, enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'off' });
  const send = h('button', { class: 'btn icon', 'aria-label': '发送', style: 'height:48px' }, icon('send'));
  const hold = h('button', { class: 'hold', 'aria-label': '按住用中文说' }, icon('mic', 18), '按住说');

  const submit = () => {
    const q = input.value.trim();
    if (!q) return input.focus();
    input.value = '';
    input.blur();
    opts.onAsk(q);
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());

  const voice = new VoiceCapture();
  let holding = false;
  const start = (e: Event) => {
    e.preventDefault();
    if (holding) return;
    holding = true;
    opts.onHoldStart?.();
    hold.classList.add('on');
    replace(hold, icon('mic', 18), '松开发送');
    input.placeholder = '正在听你说…';
    void voice
      .record({ silenceMs: 600_000, maxMs: 60_000, keepQuiet: true })
      .then(async (blob) => {
        input.placeholder = '识别中…';
        if (!blob) return toast('没听清，再按住说一次');
        const q = (await api.stt(blob, 'zh')).text.trim();
        if (q) opts.onAsk(q);
        else toast('没听清，再按住说一次');
      })
      .catch((err: Error) => toast(err.message))
      .finally(() => {
        voice.release();
        input.placeholder = placeholder;
      });
  };
  const end = () => {
    if (!holding) return;
    holding = false;
    hold.classList.remove('on');
    replace(hold, icon('mic', 18), '按住说');
    opts.onHoldEnd?.();
    voice.finish();
  };
  hold.addEventListener('pointerdown', start);
  hold.addEventListener('pointerup', end);
  hold.addEventListener('pointercancel', end);
  hold.addEventListener('contextmenu', (e) => e.preventDefault());

  return h('div', { class: 'livebar' }, input, send, hold);
}

/** One English word (or a short phrase of up to 3 words) is looked up as a word; anything else is a question. */
export function isWordLookup(text: string): boolean {
  return /^[A-Za-z][A-Za-z'’-]*(\s+[A-Za-z][A-Za-z'’-]*){0,2}$/.test(text.trim());
}
