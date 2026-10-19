// English conversation practice with the AI: pick free chat or one of the 28 scenarios,
// hold to speak English, the AI answers in simple English (read aloud) and corrects mistakes.

import { TALK_SCENARIOS } from '../../../shared/prompts';
import { api, type TalkResult } from '../../api';
import { speak } from '../../device';
import { h, icon, replace, toast } from '../../dom';
import { Recognizer } from '../../recognizer';
import { go } from '../router';
import { speakBtn } from '../sheets';

const PHASES: Record<number, string> = { 1: '第 1 阶段 · 日常生存', 2: '第 2 阶段 · 旅游 + 沟通', 3: '第 3 阶段 · 医院' };

export function talkPickScreen(): HTMLElement {
  const groups = [1, 2, 3].map((p) =>
    h(
      'div',
      { class: 'col' },
      h('h3', null, PHASES[p]),
      h(
        'div',
        { class: 'grid2' },
        ...TALK_SCENARIOS.filter((s) => s.phase === p).map((s) => h('button', { class: 'choice', onClick: () => go(`talk/${s.id}`) }, h('b', null, s.titleZh))),
      ),
    ),
  );
  return h(
    'div',
    { class: 'page' },
    h('div', { class: 'row' }, h('button', { class: 'btn icon', 'aria-label': '返回', onClick: () => (history.length > 1 ? history.back() : go('')) }, icon('back')), h('h2', null, '英语对话练习')),
    h('div', { class: 'small muted' }, '按住说英文，AI 用简单英文回你并读出来；说错时马上告诉你更好的说法，错句自动加入复习。'),
    h('button', { class: 'btn primary big', onClick: () => go('talk/free') }, '自由聊天'),
    ...groups,
  );
}

interface Turn {
  who: 'ai' | 'me';
  en: string;
  zh?: string;
  correction?: TalkResult['correction'];
}

export function talkScreen(scenarioId: string): { el: HTMLElement; dispose: () => void } {
  const scenario = TALK_SCENARIOS.find((s) => s.id === scenarioId);
  const turns: Turn[] = [];
  let suggestions: TalkResult['suggestions'] = [];
  let busy = false;
  let interim = '';

  const stream = h('div', { class: 'stream' });
  const status = h('div', { class: 'small muted', style: 'padding:0 16px' });
  const input = h('input', { id: 'talk-input', placeholder: '也可以打字（英文）', enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'off' });
  const hold = h('button', { class: 'hold', 'aria-label': '按住说英文' }, icon('mic', 18), '按住说英文');

  const render = () => {
    replace(
      stream,
      ...turns.map((t) =>
        t.who === 'ai'
          ? h(
              'div',
              { class: 'card', style: 'max-width:88%' },
              h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { class: 'en', style: 'flex:1;font-size:18px;line-height:1.35' }, t.en), speakBtn(t.en)),
              t.zh ? h('div', { class: 'small muted' }, t.zh) : null,
            )
          : h(
              'div',
              { class: 'col', style: 'align-self:flex-end;max-width:88%;gap:6px' },
              h('div', { class: 'card', style: 'background:var(--surface-2)' }, h('div', { class: 'en', style: 'font-size:17px' }, t.en)),
              t.correction
                ? h(
                    'div',
                    { class: 'card', style: 'border:1px solid var(--you)' },
                    h('div', { class: 'small', style: 'color:var(--you)' }, '更好的说法'),
                    h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { class: 'en', style: 'flex:1;color:var(--answer);font-weight:700;font-size:17px' }, t.correction.better), speakBtn(t.correction.better)),
                    h('div', { class: 'small muted' }, t.correction.whyZh),
                  )
                : null,
            ),
      ),
      interim ? h('div', { class: 'interim', style: 'align-self:flex-end' }, interim) : null,
      busy ? h('div', { class: 'muted small' }, 'AI 正在回答…') : null,
      !busy && suggestions.length
        ? h(
            'div',
            { class: 'col' },
            h('div', { class: 'small', style: 'color:var(--accent)' }, '不知道怎么说？可以这样回答（点一下听发音，然后自己说一遍）'),
            ...suggestions.map((s) => h('button', { class: 'ans', style: 'text-align:left;width:100%', onClick: () => speak(s.en) }, h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'ae', style: 'font-size:17px' }, s.en), h('div', { class: 'az' }, s.zh)))),
          )
        : null,
    );
    stream.scrollTop = stream.scrollHeight;
  };

  const send = async (said: string) => {
    if (busy) return;
    busy = true;
    if (said) turns.push({ who: 'me', en: said });
    suggestions = [];
    render();
    try {
      const history = turns.slice(0, said ? -1 : undefined).map((t) => ({ who: t.who, en: t.en }));
      const r = await api.talk({ scenarioId: scenario?.id, history, said });
      if (said && r.correction) turns[turns.length - 1].correction = r.correction;
      turns.push({ who: 'ai', en: r.reply.en, zh: r.reply.zh });
      suggestions = r.suggestions;
      speak(r.reply.en);
      status.textContent = '';
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
      status.className = 'err';
    } finally {
      busy = false;
      render();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    input.blur();
    void send(t);
  });

  let rec: Recognizer | null = null;
  let heard = '';
  const start = (e: Event) => {
    e.preventDefault();
    if (rec || busy) return;
    speechSynthesis?.cancel();
    heard = '';
    hold.classList.add('on');
    replace(hold, icon('mic', 18), '松开发送');
    rec = new Recognizer('en-US', {
      onInterim: (t) => ((interim = t), render()),
      onFinal: (t) => (heard += (heard ? ' ' : '') + t),
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
    replace(hold, icon('mic', 18), '按住说英文');
    window.setTimeout(() => {
      interim = '';
      const said = heard.trim();
      if (said) void send(said);
      else {
        render();
        toast('没听清，再按住说一次');
      }
    }, 300);
  };
  hold.addEventListener('pointerdown', start);
  hold.addEventListener('pointerup', end);
  hold.addEventListener('pointercancel', end);
  hold.addEventListener('contextmenu', (e) => e.preventDefault());

  void send('');

  const el = h(
    'div',
    { class: 'live' },
    h('div', { class: 'livetop' }, h('div', { class: 'row' }, h('button', { class: 'btn icon', 'aria-label': '返回', onClick: () => go('talk') }, icon('back')), h('h2', null, scenario ? scenario.titleZh : '自由聊天'))),
    status,
    stream,
    h('div', { class: 'livebar' }, input, hold),
  );
  return { el, dispose: () => (rec?.stop(), speechSynthesis?.cancel()) };
}
