// Bottom bar used in class and on the standalone ask screen:
// type a question (or one English word), or hold the button and speak Chinese.

import { Recognizer } from '../recognizer';
import { h, icon, replace, toast } from '../dom';

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

  let rec: Recognizer | null = null;
  let heard = '';
  const start = (e: Event) => {
    e.preventDefault();
    if (rec) return;
    opts.onHoldStart?.();
    heard = '';
    hold.classList.add('on');
    replace(hold, icon('mic', 18), '松开发送');
    rec = new Recognizer('zh-CN', {
      onInterim: (t) => (input.placeholder = t || '正在听你说…'),
      onFinal: (t) => (heard += t),
      onError: (m) => toast(m),
    });
    rec.start();
  };
  const end = () => {
    if (!rec) return;
    const r = rec;
    rec = null;
    r.stop();
    hold.classList.remove('on');
    replace(hold, icon('mic', 18), '按住说');
    input.placeholder = placeholder;
    opts.onHoldEnd?.();
    window.setTimeout(() => {
      const q = heard.trim();
      if (q) opts.onAsk(q);
      else toast('没听清，再按住说一次');
    }, 250);
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
