// Bottom sheets: tap-a-word, ask-anytime answer, fullscreen sentence.

import type { Answer } from '../../shared/types';
import { api, type AskResult } from '../api';
import { speak } from '../device';
import { h, icon } from '../dom';

function sheet(...children: (Node | null | false)[]): { root: HTMLElement; body: HTMLElement; close: () => void } {
  const body = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab' }), ...children);
  const root = h('div', { class: 'sheet-bg' }, body);
  const close = () => root.remove();
  root.addEventListener('click', (e) => e.target === root && close());
  document.body.appendChild(root);
  return { root, body, close };
}

export function showFull(text: string): void {
  const el = h('div', { class: 'full', onClick: () => el.remove() }, h('div', null, h('p', null, text), h('div', { class: 'muted small', style: 'margin-top:16px' }, '点任意处关闭')));
  document.body.appendChild(el);
}

export function speakBtn(text: string, label = '朗读'): HTMLButtonElement {
  return h('button', { class: 'btn icon', 'aria-label': label, onClick: (e: Event) => (e.stopPropagation(), speak(text)) }, icon('speaker'));
}

export function answerBlock(a: Answer, big = true): HTMLElement {
  return h(
    'div',
    { class: 'ans', onClick: () => showFull(a.en) },
    h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'ae', style: big ? '' : 'font-size:18px' }, a.en), h('div', { class: 'az' }, a.zh)),
    speakBtn(a.en),
  );
}

export function openWord(word: string, sentence: string, sessionId?: string): void {
  const loading = h('div', { class: 'muted' }, '查询中…');
  const { body } = sheet(
    h('div', { class: 'between' }, h('div', { class: 'bigword' }, word), speakBtn(word, `朗读 ${word}`)),
    loading,
  );
  api
    .word(word, sentence, sessionId)
    .then((w) => {
      loading.replaceWith(
        h(
          'div',
          { class: 'col', style: 'gap:14px' },
          h('div', { class: 'en muted' }, w.ipa),
          h('div', { class: 'col' }, h('div', { class: 'small muted' }, w.pos), h('div', { style: 'font-size:20px;font-weight:700' }, w.zh), h('div', { class: 'muted' }, w.explain)),
          h(
            'div',
            { class: 'card', style: 'background:var(--bg)' },
            h('div', { class: 'small', style: 'color:var(--accent)' }, '例句'),
            h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { class: 'en', style: 'flex:1;font-size:17px' }, w.example?.en ?? ''), speakBtn(w.example?.en ?? '')),
            h('div', { class: 'small muted' }, w.example?.zh ?? ''),
          ),
          w.inContext ? h('div', { class: 'col' }, h('div', { class: 'small muted' }, '在这句话里'), h('div', null, w.inContext)) : null,
          h('div', { class: 'small', style: 'color:var(--accent)' }, '已加入复习'),
        ),
      );
    })
    .catch((e: Error) => loading.replaceWith(h('div', { class: 'err' }, e.message)));
  void body;
}

export function openAsk(question: string, sessionId?: string): void {
  const loading = h('div', { class: 'muted' }, '思考中…');
  sheet(h('div', { class: 'card', style: 'background:var(--surface-2)' }, h('div', { class: 'small muted' }, '你问'), h('div', null, question)), loading);
  api
    .ask(question, sessionId)
    .then((r: AskResult) => {
      loading.replaceWith(
        h(
          'div',
          { class: 'col', style: 'gap:12px' },
          r.answerZh ? h('div', { style: 'line-height:1.6' }, r.answerZh) : null,
          r.say.length ? h('div', { class: 'small', style: 'color:var(--accent)' }, '这样说') : null,
          ...r.say.map((a) => answerBlock(a)),
          r.words.length
            ? h('div', { class: 'row', style: 'flex-wrap:wrap' }, ...r.words.map((w) => h('button', { class: 'btn', onClick: () => speak(w.en) }, h('span', { class: 'en' }, w.en), h('span', { class: 'muted' }, w.zh))))
            : null,
        ),
      );
    })
    .catch((e: Error) => loading.replaceWith(h('div', { class: 'err' }, e.message)));
}
