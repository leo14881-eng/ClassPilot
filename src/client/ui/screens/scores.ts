// Scores: every scored scenario practice and Sunday test, newest first.

import { TALK_SCENARIOS } from '../../../shared/prompts';
import type { Score } from '../../../shared/types';
import { api } from '../../api';
import { h, replace } from '../../dom';
import { bottomNav } from '../nav';

export function scoresScreen(): HTMLElement {
  const body = h('div', { class: 'col', style: 'gap:12px' }, h('div', { class: 'muted small' }, '加载中…'));
  void api
    .scores()
    .then((list) => {
      if (!list.length) {
        replace(body, h('div', { class: 'card muted' }, '还没有成绩。在"每日计划"里做一次场景训练（10 轮对话）就会有第一个分数。'));
        return;
      }
      const tests = list.filter((s) => s.kind === 'test');
      const avg = (xs: Score[]) => (xs.length ? Math.round(xs.reduce((a, s) => a + s.total, 0) / xs.length) : null);
      const passed = new Set(list.filter((s) => s.pass).map((s) => s.scenarioId)).size;
      replace(
        body,
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'stats' }, stat(String(list.length), '次打分'), stat(String(avg(list.slice(0, 5)) ?? '—'), '最近 5 次平均'), stat(`${passed}/${TALK_SCENARIOS.length}`, '场景通过')),
          tests.length ? h('div', { class: 'small muted' }, `口语小测 ${tests.length} 次，平均 ${avg(tests)} 分`) : null,
        ),
        ...list.map(scoreCard),
      );
    })
    .catch((e: Error) => replace(body, h('div', { class: 'err' }, e.message)));
  return h('div', { class: 'withnav' }, h('div', { class: 'page' }, h('h2', null, '成绩'), body), bottomNav('scores'));
}

export function scoreCard(s: Score): HTMLElement {
  const title = TALK_SCENARIOS.find((x) => x.id === s.scenarioId)?.titleZh ?? '自由聊天';
  const d = new Date(s.createdAt);
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'between' },
      h('div', { class: 'col', style: 'gap:2px' }, h('b', null, `${s.kind === 'test' ? '口语小测' : '场景训练'} · ${title}`), h('span', { class: 'small muted' }, `${d.getMonth() + 1}月${d.getDate()}日 · 说了 ${s.learnerTurns} 句`)),
      h('div', { class: 'col', style: 'align-items:flex-end;gap:2px' }, h('span', { class: 'en', style: 'font-size:26px;font-weight:700;font-variant-numeric:tabular-nums' }, String(s.total)), h('span', { class: `badge ${s.pass ? 'ok' : 'err'}` }, s.pass ? '通过' : '未通过')),
    ),
    h('div', { class: 'stats small' }, mini('理解', s.understanding), mini('语法', s.grammar), mini('词汇', s.vocabulary), mini('流利', s.fluency)),
    s.commentZh ? h('div', { style: 'line-height:1.6' }, s.commentZh) : null,
    s.strengthsZh.length ? h('div', { class: 'small' }, h('span', { style: 'color:var(--accent)' }, '做得好：'), s.strengthsZh.join('；')) : null,
    s.improveZh.length ? h('div', { class: 'col', style: 'gap:4px' }, h('span', { class: 'small', style: 'color:var(--you)' }, '下次练：'), ...s.improveZh.map((x) => h('div', { class: 'small' }, `· ${x}`))) : null,
  );
}

function stat(value: string, label: string): HTMLElement {
  return h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 'en', style: 'font-size:20px;font-weight:700;font-variant-numeric:tabular-nums' }, value), h('span', { class: 'small muted' }, label));
}

function mini(label: string, v: number): HTMLElement {
  return h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 'muted' }, label), h('span', { class: 'en', style: 'font-weight:700' }, String(v)));
}
