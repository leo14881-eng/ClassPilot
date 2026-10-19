// Ask anytime, without starting a class: look up a word or ask "how do I say …" by typing or holding to speak Chinese.
// Answers stack on this screen (newest on top); every word and sentence goes into review.

import { api } from '../../api';
import { speak } from '../../device';
import { h, icon } from '../../dom';
import { askBar, isWordLookup } from '../askbar';
import { go } from '../router';
import { answerBlock, speakBtn } from '../sheets';

export function askScreen(): HTMLElement {
  const list = h(
    'div',
    { class: 'col', style: 'gap:12px' },
    h(
      'div',
      { class: 'card' },
      h('b', null, '随时查、随时问'),
      h('div', { class: 'small muted', style: 'line-height:1.6' }, '输入一个英文单词：查意思、音标和发音', h('br'), '用中文问：比如"我想说我周末喜欢喝咖啡，英语怎么说"', h('br'), '也可以按住下面的按钮直接说中文'),
    ),
  );

  const add = (q: string) => {
    const box = h('div', { class: 'card' }, h('div', { class: 'small muted' }, '你问'), h('div', { style: 'font-weight:500' }, q), h('div', { class: 'muted small' }, '思考中…'));
    list.prepend(box);
    const loading = box.lastElementChild as HTMLElement;
    if (isWordLookup(q)) {
      api
        .word(q, '')
        .then((w) =>
          loading.replaceWith(
            h(
              'div',
              { class: 'col', style: 'gap:6px' },
              h('div', { class: 'between' }, h('div', null, h('span', { class: 'bigword', style: 'font-size:26px' }, w.word || q), ' ', h('span', { class: 'en muted' }, w.ipa)), speakBtn(w.word || q)),
              h('div', null, h('span', { class: 'small muted' }, `${w.pos} `), h('b', null, w.zh)),
              h('div', { class: 'muted small' }, w.explain),
              w.example?.en ? h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { style: 'flex:1' }, h('div', { class: 'en' }, w.example.en), h('div', { class: 'small muted' }, w.example.zh)), speakBtn(w.example.en)) : null,
              h('div', { class: 'small', style: 'color:var(--accent)' }, '已加入复习'),
            ),
          ),
        )
        .catch((e: Error) => loading.replaceWith(h('div', { class: 'err' }, e.message)));
      return;
    }
    api
      .ask(q)
      .then((r) =>
        loading.replaceWith(
          h(
            'div',
            { class: 'col', style: 'gap:10px' },
            r.answerZh ? h('div', { style: 'line-height:1.6' }, r.answerZh) : null,
            ...r.say.map((a) => answerBlock(a)),
            r.words.length
              ? h('div', { class: 'row', style: 'flex-wrap:wrap' }, ...r.words.map((w) => h('button', { class: 'btn', onClick: () => speak(w.en) }, h('span', { class: 'en' }, w.en), h('span', { class: 'muted' }, w.zh))))
              : null,
          ),
        ),
      )
      .catch((e: Error) => loading.replaceWith(h('div', { class: 'err' }, e.message)));
  };

  return h(
    'div',
    { class: 'live' },
    h('div', { class: 'livetop' }, h('div', { class: 'row' }, h('button', { class: 'btn icon', 'aria-label': '返回', onClick: () => (history.length > 1 ? history.back() : go('')) }, icon('back')), h('h2', null, '查词 · 提问'))),
    h('div', { class: 'stream' }, list),
    askBar({ onAsk: add }),
  );
}
