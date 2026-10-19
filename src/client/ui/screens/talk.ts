// English conversation practice with the AI: pick free chat or one of the 28 scenarios,
// tap "对话模式" and just talk (hands-free), or type; the AI answers in simple English (read aloud) and corrects mistakes.

import { TALK_SCENARIOS } from '../../../shared/prompts';
import type { Score } from '../../../shared/types';
import { api, type TalkResult } from '../../api';
import { scoreCard } from './scores';
import { speak } from '../../device';
import { h, icon, replace, toast } from '../../dom';
import { HandsFree, handsFreeButton } from '../../handsfree';
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
    h('div', { class: 'small muted' }, '点“对话模式”后直接说英文，说完停 3 秒左右自动发送；AI 读完回复会接着听你说。说错时马上告诉你更好的说法，错句自动加入复习。'),
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

const TURNS = 10;

/** `test` = Sunday speaking test: no suggested answers, scored at the end. Scenario practice is also scored after 10 turns. */
export function talkScreen(scenarioId: string, test = false): { el: HTMLElement; dispose: () => void } {
  const scenario = TALK_SCENARIOS.find((s) => s.id === scenarioId);
  let scored: Score | null = null;
  let scoring = false;
  const counter = h('span', { class: 'small muted', style: 'font-variant-numeric:tabular-nums' });
  const finishBtn = h('button', { class: 'btn', style: 'height:38px' }, '结束并打分');
  const myTurns = () => turns.filter((t) => t.who === 'me').length;
  const finish = async () => {
    if (scoring || scored) return;
    if (myTurns() < 3) return toast('至少说 3 句才能打分');
    scoring = true;
    render();
    try {
      scored = await api.scoreTalk({ scenarioId: scenario?.id, kind: test ? 'test' : 'scenario', history: turns.map((t) => ({ who: t.who, en: t.en })) });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      scoring = false;
      render();
    }
  };
  finishBtn.addEventListener('click', () => void finish());
  const turns: Turn[] = [];
  let suggestions: TalkResult['suggestions'] = [];
  let busy = false;
  let interim = '';

  const stream = h('div', { class: 'stream' });
  const status = h('div', { class: 'small muted', style: 'padding:0 16px' });
  const input = h('input', { id: 'talk-input', placeholder: '也可以打字（英文）', enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'off' });

  const render = () => {
    counter.textContent = scenario ? `第 ${Math.min(myTurns() + (scored ? 0 : 1), TURNS)}/${TURNS} 轮` : `已说 ${myTurns()} 句`;
    finishBtn.hidden = !!scored || myTurns() < 3;
    mic.el.disabled = !!scored || scoring;
    input.disabled = !!scored || scoring;
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
      scoring ? h('div', { class: 'card muted' }, '正在打分…') : null,
      scored
        ? h(
            'div',
            { class: 'col', style: 'gap:10px' },
            scoreCard(scored),
            h('div', { class: 'grid2' }, h('button', { class: 'btn', onClick: () => go(`talk/${scenarioId}${test ? '/test' : ''}?again=${Date.now()}`) }, '再练一次'), h('button', { class: 'btn primary', onClick: () => go('plan') }, '回到计划')),
          )
        : null,
      busy ? h('div', { class: 'muted small' }, 'AI 正在回答…') : null,
      !busy && !scored && !test && suggestions.length
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

  /** Send one learner turn (empty = let the AI open). Returns the AI reply, or null on error. */
  const send = async (said: string): Promise<string | null> => {
    if (busy) return null;
    busy = true;
    if (said) turns.push({ who: 'me', en: said });
    suggestions = [];
    render();
    let reply: string | null = null;
    try {
      const history = turns.slice(0, said ? -1 : undefined).map((t) => ({ who: t.who, en: t.en }));
      const r = await api.talk({ scenarioId: scenario?.id, history, said });
      if (said && r.correction) turns[turns.length - 1].correction = r.correction;
      turns.push({ who: 'ai', en: r.reply.en, zh: r.reply.zh });
      suggestions = r.suggestions;
      reply = r.reply.en;
      status.textContent = '';
      status.className = 'small muted';
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
      status.className = 'err';
    } finally {
      busy = false;
      render();
    }
    if (scenario && myTurns() >= TURNS) {
      hf.stop();
      void finish();
    }
    return reply;
  };

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    input.blur();
    void send(t).then((reply) => reply && (hf.on ? hf.say(reply) : speak(reply)));
  });

  // Conversation mode: tap once, then just talk. Pausing ~3 s sends the sentence; the reply is read aloud, then it listens again.
  const hf: HandsFree = new HandsFree({
    lang: 'en-US',
    pauseMs: 2800,
    onInterim: (t) => {
      interim = t;
      render();
    },
    onState: (st) => {
      mic.update(st);
      input.disabled = st !== 'off' || !!scored || scoring;
    },
    onTurn: async (text) => {
      const reply = await send(text);
      if (reply && !scored && !scoring) await hf.say(reply);
    },
    onError: (m) => toast(m),
  });
  const mic = handsFreeButton(hf, '对话模式');

  void send('').then((reply) => reply && speak(reply));

  const el = h(
    'div',
    { class: 'live' },
    h(
      'div',
      { class: 'livetop' },
      h('div', { class: 'row' }, h('button', { class: 'btn icon', 'aria-label': '返回', onClick: () => (history.length > 1 ? history.back() : go('talk')) }, icon('back')), h('h2', null, `${test ? '口语小测：' : ''}${scenario ? scenario.titleZh : '自由聊天'}`)),
      h('div', { class: 'row', style: 'gap:10px' }, counter, finishBtn),
    ),
    test ? h('div', { class: 'small muted', style: 'padding:0 16px' }, '小测不给参考回答。说 10 句后自动打分，70 分通过。') : null,
    status,
    stream,
    h('div', { class: 'livebar' }, input, mic.el),
  );
  return { el, dispose: () => hf.stop() };
}
