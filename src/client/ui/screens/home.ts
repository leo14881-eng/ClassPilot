// Start screen: school, topic, mode, start class; recent classes.

import { keepScreenOn } from '../../device';
import { acquireMic, releaseMic } from '../../voice';
import type { ClassSession, School } from '../../../shared/types';
import { formatDuration } from '../../../shared/text';
import { api } from '../../api';
import { h, icon, replace } from '../../dom';
import { go } from '../router';
import { bottomNav } from '../nav';

export function homeScreen(): HTMLElement {
  let school: School = 'ILA';
  let deep = true;
  const topic = h('input', { id: 'topic', class: 'en', placeholder: '例如 Weekend activities（可不填）', autocomplete: 'off' });
  const recent = h('div', { class: 'col' }, h('div', { class: 'muted small' }, '加载中…'));
  const schoolSeg = h('div', { class: 'seg', role: 'group', 'aria-label': '学校' });
  const deepBtn = h('button', { class: 'choice', 'aria-pressed': 'true' });
  const startBtn = h('button', { class: 'btn primary big' }, icon('mic', 22), '开始上课');

  const paint = () => {
    replace(
      schoolSeg,
      ...(['ILA', 'WSE'] as School[]).map((s) =>
        h('button', { class: 'en', 'aria-pressed': String(school === s), onClick: () => ((school = s), paint()) }, s === 'ILA' ? 'ILA' : 'Wall Street English'),
      ),
    );
    deepBtn.setAttribute('aria-pressed', String(deep));
    replace(deepBtn, h('b', null, deep ? '课后整理：开' : '课后整理：关'), h('span', { class: 'small muted' }, deep ? '下课后转写录音、整理问题、生词和纠错' : '只保存实时字幕，不花转写费用'));
  };
  deepBtn.addEventListener('click', () => ((deep = !deep), paint()));

  // A class already in progress: continue it (one class must not be split into several when the page is reopened).
  const liveSlot = h('div');
  let liveNow: ClassSession | null = null;
  let confirmNew = false;
  let confirmTimer: number | undefined;
  startBtn.addEventListener('click', async () => {
    if (liveNow && !confirmNew) {
      confirmNew = true;
      replace(startBtn, icon('mic', 22), '再点一次：结束正在上的课，开始新的一节');
      confirmTimer = window.setTimeout(() => ((confirmNew = false), replace(startBtn, icon('mic', 22), '开始新的一节课')), 4000);
      return;
    }
    window.clearTimeout(confirmTimer);
    startBtn.disabled = true;
    // Inside the tap: iOS only allows these from a user gesture.
    void keepScreenOn(true);
    void acquireMic()
      .then(() => releaseMic())
      .catch(() => {});
    try {
      const s = await api.createSession({ school, topic: topic.value.trim(), mode: 'class', deepReview: deep });
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
  void api.sessions().then((list) => {
    replace(recent, ...(list.length ? list.slice(0, 8).map(sessionRow) : [h('div', { class: 'muted small' }, '还没有上过课')]));
    liveNow = list.find((x) => x.status === 'live') ?? null;
    if (!liveNow) return;
    const live = liveNow;
    const mins = Math.max(1, Math.round((Date.now() - live.startedAt) / 60000));
    replace(
      liveSlot,
      h(
        'button',
        { class: 'btn primary big', style: 'width:100%', onClick: () => go(`live/${live.id}`) },
        icon('play', 22),
        `继续上课（已上 ${mins} 分钟）`,
      ),
      h('div', { class: 'muted small', style: 'text-align:center;margin-top:6px' }, '刚才那节课还没下课，点这里接着听，字幕接在后面'),
    );
    startBtn.className = 'btn big';
    replace(startBtn, icon('mic', 22), '开始新的一节课');
  });

  paint();
  return h(
    'div',
    { class: 'withnav' },
    h(
    'div',
    { class: 'page' },
    h('div', { class: 'between' }, h('div', { class: 'brand' }, 'Class', h('span', null, 'Pilot')), h('button', { class: 'btn icon', 'aria-label': '设置', onClick: () => go('settings') }, icon('gear'))),
    liveSlot,
    h('div', { class: 'col' }, h('h3', null, '哪个学校'), schoolSeg),
    h('div', { class: 'col' }, h('label', { for: 'topic' }, '本节课主题（可选）'), topic),
    deepBtn,
    startBtn,
    h('div', { class: 'muted small', style: 'text-align:center;margin-top:-8px' }, '开始后自动听、自动翻译。上课中可以随时切换"上课 / 对话"'),
    h(
      'button',
      { class: 'listbtn', onClick: () => go('ask') },
      h('span', { class: 'col', style: 'gap:3px' }, h('b', null, '查词提问'), h('span', { class: 'small muted' }, '不用上课也能用：查单词、问"英语怎么说"、按住说中文')),
      icon('chevron', 18),
    ),
    h(
      'button',
      { class: 'listbtn', onClick: () => go('talk') },
      h('span', { class: 'col', style: 'gap:3px' }, h('b', null, '英语对话练习'), h('span', { class: 'small muted' }, '跟 AI 用英语聊天：自由聊或 28 个场景，说错马上纠正')),
      icon('chevron', 18),
    ),
    errBox,
    h('div', { class: 'col' }, h('h3', null, '最近的课'), recent),
    ),
    bottomNav('home'),
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
