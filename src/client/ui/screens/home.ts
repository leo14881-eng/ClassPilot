// Start screen: school, topic, mode, start class; recent classes.

import type { ClassSession, Mode, School } from '../../../shared/types';
import { formatDuration } from '../../../shared/text';
import { api } from '../../api';
import { h, icon, replace } from '../../dom';
import { go } from '../router';

export function homeScreen(): HTMLElement {
  let school: School = 'ILA';
  let mode: Mode = 'class';
  let deep = true;
  const topic = h('input', { id: 'topic', class: 'en', placeholder: '例如 Weekend activities（可不填）', autocomplete: 'off' });
  const recent = h('div', { class: 'col' }, h('div', { class: 'muted small' }, '加载中…'));
  const schoolSeg = h('div', { class: 'seg', role: 'group', 'aria-label': '学校' });
  const modeRow = h('div', { class: 'grid2' });
  const deepBtn = h('button', { class: 'choice', 'aria-pressed': 'true' });
  const startBtn = h('button', { class: 'btn primary big' }, icon('mic', 22), '开始上课');

  const paint = () => {
    replace(
      schoolSeg,
      ...(['ILA', 'WSE'] as School[]).map((s) =>
        h('button', { class: 'en', 'aria-pressed': String(school === s), onClick: () => ((school = s), paint()) }, s === 'ILA' ? 'ILA' : 'Wall Street English'),
      ),
    );
    replace(
      modeRow,
      h('button', { class: 'choice', 'aria-pressed': String(mode === 'class'), onClick: () => ((mode = 'class'), paint()) }, h('b', null, '上课'), h('span', { class: 'small muted' }, '老师讲课只翻译，提问才给答案')),
      h('button', { class: 'choice', 'aria-pressed': String(mode === 'chat'), onClick: () => ((mode = 'chat'), paint()) }, h('b', null, '对话'), h('span', { class: 'small muted' }, '小组讨论，每个问题都当作问你')),
    );
    deepBtn.setAttribute('aria-pressed', String(deep));
    replace(deepBtn, h('b', null, deep ? '课后整理：开' : '课后整理：关'), h('span', { class: 'small muted' }, deep ? '下课后转写录音、整理问题、生词和纠错' : '只保存实时字幕，不花转写费用'));
  };
  deepBtn.addEventListener('click', () => ((deep = !deep), paint()));

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
      const s = await api.createSession({ school, topic: topic.value.trim(), mode, deepReview: deep });
      go(`live/${s.id}`);
    } catch (e) {
      startBtn.disabled = false;
      alertInline(e);
    }
  });

  const errBox = h('div', { class: 'err' });
  const alertInline = (e: unknown) => (errBox.textContent = e instanceof Error ? e.message : String(e));

  void api.settings().then((s) => {
    school = s.lastSchool;
    paint();
  });
  void api.sessions().then((list) => replace(recent, ...(list.length ? list.slice(0, 8).map(sessionRow) : [h('div', { class: 'muted small' }, '还没有上过课')])));

  paint();
  return h(
    'div',
    { class: 'page' },
    h('div', { class: 'between' }, h('div', { class: 'brand' }, 'Class', h('span', null, 'Pilot')), h('div', { class: 'row' }, h('button', { class: 'btn icon', 'aria-label': '复习', onClick: () => go('review') }, icon('book')), h('button', { class: 'btn icon', 'aria-label': '设置', onClick: () => go('settings') }, icon('gear')))),
    h('div', { class: 'col' }, h('h3', null, '哪个学校'), schoolSeg),
    h('div', { class: 'col' }, h('label', { for: 'topic' }, '本节课主题（可选）'), topic),
    h('div', { class: 'col' }, h('h3', null, '模式'), modeRow),
    deepBtn,
    startBtn,
    h('div', { class: 'muted small', style: 'text-align:center;margin-top:-8px' }, '开始后自动听、自动翻译，屏幕保持常亮'),
    errBox,
    h('div', { class: 'col' }, h('h3', null, '最近的课'), recent),
  );
}

export function statusBadge(s: ClassSession): HTMLElement {
  if (s.status === 'live') return h('span', { class: 'badge you' }, '上课中');
  if (s.status === 'processing') return h('span', { class: 'badge all' }, s.statusNote ?? '整理中');
  if (s.status === 'failed') return h('span', { class: 'badge err' }, '整理失败');
  return h('span', { class: 'badge ok' }, '已整理');
}

function sessionRow(s: ClassSession): HTMLElement {
  const d = new Date(s.startedAt);
  const dur = s.endedAt ? formatDuration(s.endedAt - s.startedAt) : '';
  return h(
    'button',
    { class: 'listbtn', onClick: () => go(s.status === 'live' ? `live/${s.id}` : `review/${s.id}`) },
    h(
      'span',
      { class: 'col', style: 'gap:3px;min-width:0' },
      h('span', { class: 'en', style: 'font-weight:700' }, s.topic || '（未填主题）'),
      h('span', { class: 'small muted' }, `${s.school === 'WSE' ? 'WSE' : 'ILA'} · ${d.getMonth() + 1}月${d.getDate()}日 ${dur}`),
    ),
    statusBadge(s),
  );
}
