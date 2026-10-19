// Live class screen: captions + translation, highlighted questions with answers to read aloud,
// tap a word, hold to ask in Chinese, type to ask, switch class/conversation mode, pause and end.

import { formatDuration, tokenize } from '../../../shared/text';
import type { Line } from '../../../shared/types';
import { api } from '../../api';
import { LiveClass } from '../../live';
import { speechSupported } from '../../recognizer';
import { askBar, isWordLookup } from '../askbar';
import { h, icon, replace, toast } from '../../dom';
import { answerBlock, openAsk, openWord } from '../sheets';
import { go } from '../router';

const VISIBLE = 80;

export function liveScreen(id: string): { el: HTMLElement; dispose: () => void } {
  const stream = h('div', { class: 'stream', 'aria-live': 'polite' });
  const timer = h('span', { class: 'en muted small', style: 'font-variant-numeric:tabular-nums' }, '00:00');
  const dot = h('span', { class: 'dot' });
  const stateLabel = h('span', { style: 'font-weight:500' }, '准备中');
  const pauseBtn = h('button', { class: 'btn icon', 'aria-label': '暂停' }, icon('pause'));
  const endBtn = h('button', { class: 'btn', style: 'height:44px;padding:0 12px' }, '下课');
  const note = h('div', { class: 'small muted', style: 'padding:0 16px' });

  let live: LiveClass | null = null;
  let follow = true;
  stream.addEventListener('scroll', () => {
    follow = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
  });

  const render = () => {
    if (!live) return;
    stateLabel.textContent = live.paused ? '已暂停' : '听课中';
    dot.className = live.paused ? 'dot off' : 'dot';
    replace(pauseBtn, icon(live.paused ? 'play' : 'pause'));
    pauseBtn.setAttribute('aria-label', live.paused ? '继续' : '暂停');
    note.textContent = [live.recordingNote, live.error].filter(Boolean).join(' · ');
    note.className = live.error ? 'err' : 'small muted';
    note.style.padding = '0 16px';
    const lines = live.lines.slice(-VISIBLE);
    const lastQuestion = [...lines].reverse().find((l) => l.kind === 'question');
    replace(
      stream,
      live.lines.length > VISIBLE ? h('div', { class: 'small muted' }, `更早的 ${live.lines.length - VISIBLE} 句可在课后复习里查看`) : null,
      ...lines.map((l) => lineView(l, l === lastQuestion, id)),
      live.interim ? h('div', { class: 'interim' }, live.interim) : null,
      !live.lines.length && !live.interim ? h('div', { class: 'muted' }, '正在听…老师说话后，这里会出现英文和中文') : null,
    );
    if (follow) stream.scrollTop = stream.scrollHeight;
  };

  const tick = window.setInterval(() => live && (timer.textContent = formatDuration(live.elapsed())), 1000);

  pauseBtn.addEventListener('click', () => (live?.paused ? live.resume() : live?.pause()));
  endBtn.addEventListener('click', async () => {
    if (!live) return;
    endBtn.disabled = true;
    replace(endBtn, '上传中…');
    try {
      const s = await live.end();
      toast(s.deepReview ? '已下课，正在整理复习内容' : '已下课');
      go(`review/${s.id}`);
    } catch (e) {
      endBtn.disabled = false;
      replace(endBtn, '下课');
      toast(e instanceof Error ? e.message : String(e));
    }
  });

  const modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': '模式', style: 'padding:2px' });
  const paintMode = () => {
    if (!live) return;
    const cur = live.session.mode;
    const pick = (m: 'class' | 'chat') => async () => {
      if (!live || live.session.mode === m) return;
      live.session.mode = m;
      paintMode();
      try {
        await api.setMode(id, m);
        toast(m === 'chat' ? '已切换到对话：每个问题都当作在问你' : '已切换到上课：讲课只翻译，提问才给答案');
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    };
    replace(
      modeSeg,
      h('button', { 'aria-pressed': String(cur === 'class'), style: 'height:36px;padding:0 12px', onClick: pick('class') }, '上课'),
      h('button', { 'aria-pressed': String(cur === 'chat'), style: 'height:36px;padding:0 12px', onClick: pick('chat') }, '对话'),
    );
  };

  const bar = askBar({
    placeholder: '查单词或提问，中英文都行',
    onAsk: (q) => (isWordLookup(q) ? openWord(q, live?.lines.at(-1)?.en ?? '', id) : openAsk(q, id)),
    onHoldStart: () => live?.hold(),
    onHoldEnd: () => live?.release(),
  });

  const el = h(
    'div',
    { class: 'live' },
    h(
      'div',
      { class: 'livetop' },
      h('div', { class: 'row', style: 'gap:8px' }, dot, stateLabel, timer),
      h('div', { class: 'row', style: 'gap:8px' }, modeSeg, pauseBtn, endBtn),
      h('div', { class: 'row', style: 'gap:8px;width:100%' },
        h('button', { class: 'btn', style: 'flex:1;height:38px', onClick: () => go('ask') }, '查词 · 提问'),
        h('button', { class: 'btn', style: 'flex:1;height:38px', onClick: () => go('talk') }, '英语对话练习'),
      ),
    ),
    note,
    stream,
    bar,
  );

  let unsub = () => {};
  (async () => {
    if (!speechSupported()) {
      note.textContent = '这个浏览器不支持语音识别，请用 iPhone 的 Safari 打开';
      note.className = 'err';
    }
    try {
      const [{ session, lines }, settings] = await Promise.all([api.session(id), api.settings()]);
      if (session.status !== 'live') return go(`review/${id}`);
      live = new LiveClass(session, settings.recordAudio);
      unsub = live.subscribe(render);
      paintMode();
      await live.start(lines);
      render();
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : String(e);
      note.className = 'err';
    }
  })();

  return {
    el,
    dispose: () => {
      window.clearInterval(tick);
      unsub();
      // Leaving the screen without ending keeps the class "live"; listening stops.
      live?.pause();
    },
  };
}

function lineView(l: Line, isLatestQuestion: boolean, sessionId: string): HTMLElement {
  const words = tokenize(l.en).map((tk) => (tk.word ? h('span', { class: 'w', onClick: () => openWord(tk.text, l.en, sessionId) }, tk.text) : tk.text));
  if (l.kind === 'question' && l.priority) {
    const you = l.priority === 'you';
    const cls = l.priority;
    const label = you ? '在问你' : l.priority === 'all' ? '问大家' : '问同学';
    return h(
      'div',
      { class: `col ${cls === 'other' ? 'other' : ''}`, style: 'gap:8px' },
      h(
        'div',
        { class: `q ${cls}` },
        h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: `badge ${cls === 'other' ? 'grey' : cls}` }, label)),
        h('div', { class: 'qt' }, words),
        l.questionZh ? h('div', { class: 'qz' }, l.questionZh) : l.zh ? h('div', { class: 'qz' }, l.zh) : null,
      ),
      ...(isLatestQuestion || you ? (l.answers ?? []).map((a, i) => answerBlock(a, you && i === 0)) : []),
    );
  }
  return h(
    'div',
    { class: `utt ${l.kind === 'self' ? 'self' : ''}` },
    h('div', { class: 't' }, words),
    l.kind === 'pending' ? h('div', { class: 'z' }, '翻译中…') : l.zh ? h('div', { class: 'z' }, l.zh) : null,
  );
}
