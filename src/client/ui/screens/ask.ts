// Ask anytime, like a chat: look up a word or ask "how do I say …", then keep asking follow-ups
// ("那过去式呢", "再简单一点"). Type, or tap 对话模式 and just talk in Chinese; answers are read aloud.
// Every word and sentence in the answers goes into review.

import { api, type AskResult } from '../../api';
import type { WordInfo } from '../../../shared/types';
import { speak } from '../../device';
import { h, icon, toast } from '../../dom';
import { HandsFree, handsFreeButton } from '../../handsfree';
import { isWordLookup } from '../askbar';
import { go } from '../router';
import { answerBlock, speakBtn } from '../sheets';

type Reply = { kind: 'word'; q: string; w: WordInfo } | { kind: 'ask'; q: string; r: AskResult };

export function askScreen(): { el: HTMLElement; dispose: () => void } {
  const chat: { q: string; a: string }[] = [];
  const stream = h(
    'div',
    { class: 'stream' },
    h(
      'div',
      { class: 'card' },
      h('b', null, '随时查、随时问，可以接着追问'),
      h(
        'div',
        { class: 'small muted', style: 'line-height:1.6' },
        '输入一个英文单词：查意思、音标和发音',
        h('br'),
        '用中文问：比如"我想说我周末喜欢喝咖啡，英语怎么说"，然后可以接着问"再简单一点""过去式怎么说"',
        h('br'),
        '点"对话模式"直接说中文，说完停一下就自动发送，回答会读出来，然后接着听你说',
      ),
    ),
  );
  const interimEl = h('div', { class: 'interim', style: 'align-self:flex-end;font-family:var(--f-zh)' });
  const scrollDown = () => (stream.scrollTop = stream.scrollHeight);

  const wordView = (q: string, w: WordInfo) =>
    h(
      'div',
      { class: 'col', style: 'gap:6px' },
      h('div', { class: 'between' }, h('div', null, h('span', { class: 'bigword', style: 'font-size:26px' }, w.word || q), ' ', h('span', { class: 'en muted' }, w.ipa)), speakBtn(w.word || q)),
      h('div', null, h('span', { class: 'small muted' }, `${w.pos} `), h('b', null, w.zh)),
      h('div', { class: 'muted small' }, w.explain),
      w.example?.en ? h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { style: 'flex:1' }, h('div', { class: 'en' }, w.example.en), h('div', { class: 'small muted' }, w.example.zh)), speakBtn(w.example.en)) : null,
      h('div', { class: 'small', style: 'color:var(--accent)' }, '已加入复习'),
    );

  const askView = (r: AskResult) =>
    h(
      'div',
      { class: 'col', style: 'gap:10px' },
      r.answerZh ? h('div', { style: 'line-height:1.6' }, r.answerZh) : null,
      ...r.say.map((a) => answerBlock(a)),
      r.words.length
        ? h('div', { class: 'row', style: 'flex-wrap:wrap' }, ...r.words.map((w) => h('button', { class: 'btn', onClick: () => speak(w.en) }, h('span', { class: 'en' }, w.en), h('span', { class: 'muted' }, w.zh))))
        : null,
    );

  /** Ask one question; shows it in the chat and returns the reply (null on error). */
  const ask = async (q: string): Promise<Reply | null> => {
    const answer = h('div', { class: 'card', style: 'max-width:94%' }, h('div', { class: 'muted small' }, '思考中…'));
    stream.insertBefore(h('div', { class: 'card', style: 'align-self:flex-end;max-width:86%;background:var(--surface-2)' }, q), interimEl);
    stream.insertBefore(answer, interimEl);
    scrollDown();
    try {
      if (isWordLookup(q)) {
        const w = await api.word(q, '');
        answer.replaceChildren(wordView(q, w));
        chat.push({ q, a: `${w.word || q} ${w.ipa}: ${w.zh}. ${w.example?.en ?? ''}` });
        scrollDown();
        return { kind: 'word', q, w };
      }
      const r = await api.ask(q, undefined, chat.slice(-6));
      answer.replaceChildren(askView(r));
      chat.push({ q, a: [r.answerZh, ...r.say.map((s) => s.en)].filter(Boolean).join(' ') });
      scrollDown();
      return { kind: 'ask', q, r };
    } catch (e) {
      answer.replaceChildren(h('div', { class: 'err' }, e instanceof Error ? e.message : String(e)));
      return null;
    }
  };

  const input = h('input', { id: 'ask', placeholder: '查单词或提问，中英文都行', enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'off' }) as HTMLInputElement;
  const sendBtn = h('button', { class: 'btn icon', 'aria-label': '发送', style: 'height:48px' }, icon('send'));
  const submit = () => {
    const q = input.value.trim();
    if (!q) return input.focus();
    input.value = '';
    input.blur();
    void ask(q);
  };
  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());

  const hf: HandsFree = new HandsFree({
    lang: 'zh-CN',
    pauseMs: 2200,
    onInterim: (t) => {
      interimEl.textContent = t;
      if (t) scrollDown();
    },
    onState: (s) => {
      mic.update(s);
      input.disabled = s !== 'off';
      sendBtn.toggleAttribute('disabled', s !== 'off');
    },
    onTurn: async (text) => {
      const reply = await ask(text);
      if (!reply) return;
      if (reply.kind === 'word') {
        await hf.say(reply.w.word || reply.q);
        await hf.say(reply.w.zh, 'zh-CN');
        if (reply.w.example?.en) await hf.say(reply.w.example.en);
        return;
      }
      if (reply.r.answerZh) await hf.say(reply.r.answerZh, 'zh-CN');
      for (const s of reply.r.say.slice(0, 2)) await hf.say(s.en);
    },
    onError: (m) => toast(m),
  });
  const mic = handsFreeButton(hf, '对话模式');
  stream.append(interimEl);

  const el = h(
    'div',
    { class: 'live' },
    h('div', { class: 'livetop' }, h('div', { class: 'row' }, h('button', { class: 'btn icon', 'aria-label': '返回', onClick: () => (window.history.length > 1 ? window.history.back() : go('')) }, icon('back')), h('h2', null, '查词提问'))),
    stream,
    h('div', { class: 'livebar' }, input, sendBtn, mic.el),
  );
  return { el, dispose: () => hf.stop() };
}
