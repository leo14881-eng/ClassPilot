// Daily plan: countdown to 2027-01-31, phase progress, today's 10 words, due reviews,
// today's scenario (scored) and the Sunday speaking test.

import { PHASES, PLAN_END, PLAN_START } from '../../../shared/plan';
import { api, type PlanStatus } from '../../api';
import { speak } from '../../device';
import { h, icon, replace } from '../../dom';
import { bottomNav } from '../nav';
import { go } from '../router';
import { practice } from './review';

/** Quiz today's plan words right away (Chinese prompt → type or say the English), whether or not they are due. */
async function quizToday(p: PlanStatus): Promise<void> {
  const ids = new Set(p.words.map((w) => w.itemId).filter(Boolean));
  const all = await api.items();
  const items = all.filter((i) => ids.has(i.id));
  if (!items.length) return;
  practice(items, '今天的新词', () => go('plan'));
}

const CAT: Record<string, string> = { life: '生活', travel: '旅游', hospital: '医院', work: '工作' };

export function planScreen(): HTMLElement {
  const body = h('div', { class: 'col', style: 'gap:14px' }, h('div', { class: 'card muted' }, '正在准备今天的计划（第一次打开每天要几秒钟生成新词）…'));
  const load = () =>
    api
      .plan()
      .then((p) => replace(body, ...render(p)))
      .catch((e: Error) => replace(body, h('div', { class: 'card' }, h('div', { class: 'err' }, e.message), h('button', { class: 'btn', onClick: load }, '重试'))));
  void load();
  return h(
    'div',
    { class: 'withnav' },
    h('div', { class: 'page' }, h('div', { class: 'between' }, h('h2', null, '今天的计划'), h('span', { class: 'small muted', id: 'plan-date' }, '')), body),
    bottomNav('plan'),
  );
}

function render(p: PlanStatus): HTMLElement[] {
  const d = new Date(`${p.date}T00:00:00`);
  const dateEl = document.getElementById('plan-date');
  if (dateEl) dateEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日 · 第 ${p.dayNumber} 天`;
  const span = Date.parse(PLAN_END) - Date.parse(PLAN_START);
  const pct = Math.min(100, Math.max(0, Math.round(((Date.parse(p.date) - Date.parse(PLAN_START)) / span) * 100)));
  const wordsLearned = p.words.filter((w) => w.correctStreak > 0 || w.mastered).length;

  const progress = h(
    'div',
    { class: 'card' },
    h('div', { class: 'between' }, h('b', null, `离 1 月 31 日目标还有 ${Math.max(0, p.daysLeft)} 天`), h('span', { class: 'small muted' }, `第 ${p.phase.n} 阶段 · ${p.phase.titleZh}`)),
    h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${pct}%` })),
    h('div', { class: 'phases' }, ...PHASES.map((ph) => h('span', { class: ph.n === p.phase.n ? 'on' : '' }, `${ph.titleZh} ${Number(ph.start.slice(5, 7))}/${Number(ph.start.slice(8))}`))),
    h(
      'div',
      { class: 'stats' },
      stat(`${p.progress.masteredWords}`, `已掌握 / ${p.progress.wordTarget} 词`),
      stat(`${p.progress.scenariosPassed}/${p.progress.scenarioTotal}`, '场景通过'),
      stat(p.progress.level.label, '当前水平'),
    ),
    h('div', { class: 'small muted' }, p.progress.level.noteZh),
  );

  const quiz = h(
    'button',
    { class: 'btn primary', style: 'width:100%', onClick: () => void quizToday(p) },
    icon('check', 18),
    '考一考今天的 10 个词',
  );

  const words = h(
    'div',
    { class: 'card' },
    h('div', { class: 'between' }, h('b', null, '今天的 10 个新词'), h('span', { class: 'small muted' }, `已练 ${wordsLearned}/${p.words.length}`)),
    h('div', { class: 'small muted' }, '先听、跟读，再用每个词自己说一句话。学完点最下面的按钮考一考：看中文，打字或说英文，自动判对错。'),
    ...p.words.map((w) =>
      h(
        'div',
        { class: 'wordrow' },
        h(
          'div',
          { style: 'flex:1;min-width:0' },
          h('div', null, h('span', { class: 'en', style: 'font-weight:700;font-size:17px' }, w.en), ' ', h('span', { class: 'en muted small' }, w.ipa), ' ', h('span', { class: 'chip' }, CAT[w.category] ?? w.category)),
          h('div', null, w.zh),
          h('div', { class: 'en small muted' }, w.example),
          h('div', { class: 'small muted' }, w.exampleZh),
        ),
        h('button', { class: 'btn icon', 'aria-label': `朗读 ${w.en}`, onClick: () => speak(`${w.en}. ${w.example}`) }, icon('speaker')),
      ),
    ),
    quiz,
  );

  const due = h(
    'button',
    { class: 'listbtn', onClick: () => go('review') },
    h('span', { class: 'col', style: 'gap:3px' }, h('b', null, '复习到期的内容'), h('span', { class: 'small muted' }, '中文出题，你说英文；连对 3 次算掌握')),
    h('span', { class: 'en', style: 'font-size:20px;font-weight:700' }, String(p.dueCount)),
  );

  const scen = h(
    'button',
    { class: 'listbtn', style: 'border:1.5px solid var(--accent)', onClick: () => go(`talk/${p.scenario.id}`) },
    h(
      'span',
      { class: 'col', style: 'gap:3px' },
      h('b', null, `场景训练：${p.scenario.titleZh}`),
      h('span', { class: 'small muted' }, `跟 AI 对话 10 轮，从易到难，结束后打分。${p.scenario.best !== null ? `最好成绩 ${p.scenario.best} 分` : '还没练过'}${p.scenario.practicedToday ? ' · 今天已练' : ''}`),
    ),
    icon('chevron', 18),
  );

  // The speaking test can be taken any day; Sunday is the reminder day.
  const t = p.test;
  const done = t.doneThisWeek;
  const test = h(
    'button',
    { class: 'listbtn', style: `border:1.5px solid ${t.today && !done ? 'var(--you)' : 'var(--line, #2a3a34)'}`, onClick: () => go(`talk/${t.scenarioId}/test`) },
    h(
      'span',
      { class: 'col', style: 'gap:3px' },
      h('b', null, `口语小测：${t.titleZh}${t.today && !done ? '（今天周日，该测了）' : ''}`),
      h(
        'span',
        { class: 'small muted' },
        done ? `本周已测：${done.total} 分 · ${done.pass ? '通过' : '没通过'}。可以再测一次` : '10 轮对话，没有参考回答，结束后打分，70 分通过。每周日提醒一次，平时也能随时测',
      ),
    ),
    icon('chevron', 18),
  );

  return [progress, words, due, scen, test];
}

function stat(value: string, label: string): HTMLElement {
  return h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 'en', style: 'font-size:20px;font-weight:700;font-variant-numeric:tabular-nums' }, value), h('span', { class: 'small muted' }, label));
}
