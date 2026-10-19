// Review: list of classes, one class's review material, and a simple practice queue
// (Chinese prompt -> type or say the English -> checked automatically -> answer shown; wrong = retest; 3 right in a row = mastered).

import type { ClassSession, ReviewItem, SessionReview } from '../../../shared/types';
import { api } from '../../api';
import { speak } from '../../device';
import { copyText, h, icon, replace, toast } from '../../dom';
import { VoiceCapture } from '../../voice';
import { go } from '../router';
import { bottomNav } from '../nav';
import { answerBlock, speakBtn } from '../sheets';
import { statusBadge } from './home';

function header(title: string, back: string): HTMLElement {
  return h('div', { class: 'row' }, h('button', { class: 'btn icon', 'aria-label': '返回', onClick: () => go(back) }, icon('back')), h('h2', { class: 'en' }, title));
}

export function reviewListScreen(): HTMLElement {
  const list = h('div', { class: 'col' }, h('div', { class: 'muted small' }, '加载中…'));
  const due = h('div', { class: 'card' }, h('div', { class: 'muted small' }, '加载中…'));
  void api.dueItems().then((items) => {
    replace(
      due,
      h('div', { class: 'between' }, h('b', null, '到期复习'), h('span', { class: 'en', style: 'font-variant-numeric:tabular-nums' }, `${items.length}`)),
      h('div', { class: 'small muted' }, '看中文，打字或说出英文，自动判对错；错了等一下再考，同一个连对 3 次算掌握'),
      h('button', { class: 'btn primary', disabled: items.length === 0, onClick: () => practice(items, '复习', () => go('review')) }, items.length ? '开始复习' : '今天没有到期的内容'),
    );
  });
  const load = () =>
    api.sessions().then((sessions) =>
      replace(list, ...(sessions.length ? sessions.map((s) => classRow(s, load)) : [h('div', { class: 'muted small' }, '还没有课程记录')])),
    );
  void load();
  return h(
    'div',
    { class: 'withnav' },
    h(
      'div',
      { class: 'page' },
      h('h2', null, '复习'),
      due,
      h('div', { class: 'between' }, h('h3', null, '课程记录'), h('button', { class: 'btn', style: 'height:36px', onClick: () => go('bin') }, '回收站')),
      list,
    ),
    bottomNav('review'),
  );
}

function when(s: ClassSession): string {
  const d = new Date(s.startedAt);
  return `${s.school} · ${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A class row with a delete button that asks for a second tap (the page cannot show system dialogs). */
function classRow(s: ClassSession, reload: () => void): HTMLElement {
  const del = h('button', { class: 'btn icon', 'aria-label': '删除这节课', style: 'flex:none;width:auto;padding:0 12px;height:40px' }, '删除');
  let armed = false;
  let timer: number | undefined;
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      del.textContent = '确认删除';
      del.classList.add('warn');
      timer = window.setTimeout(() => {
        armed = false;
        del.textContent = '删除';
        del.classList.remove('warn');
      }, 3000);
      return;
    }
    window.clearTimeout(timer);
    try {
      await api.deleteSession(s.id);
      toast('已移到回收站，这节课的复习内容也一起移走；30 天内可以恢复');
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });
  return h(
    'div',
    { class: 'row' },
    h(
      'button',
      { class: 'listbtn', style: 'flex:1;min-width:0', onClick: () => go(`review/${s.id}`) },
      h('span', { class: 'col', style: 'gap:3px;min-width:0' }, h('span', { class: 'en', style: 'font-weight:700' }, s.topic || '（未填主题）'), h('span', { class: 'small muted' }, when(s))),
      statusBadge(s),
    ),
    del,
  );
}

export function binScreen(): HTMLElement {
  const list = h('div', { class: 'col' }, h('div', { class: 'muted small' }, '加载中…'));
  const load = () =>
    api.bin().then((items) =>
      replace(
        list,
        ...(items.length
          ? items.map((s) => {
              const left = Math.max(0, 30 - Math.floor((Date.now() - (s.deletedAt ?? Date.now())) / 86_400_000));
              return h(
                'div',
                { class: 'card', style: 'flex-direction:row;align-items:center;justify-content:space-between' },
                h('span', { class: 'col', style: 'gap:3px;min-width:0' }, h('span', { class: 'en', style: 'font-weight:700' }, s.topic || '（未填主题）'), h('span', { class: 'small muted' }, `${when(s)} · 还剩 ${left} 天`)),
                h(
                  'button',
                  {
                    class: 'btn primary',
                    style: 'flex:none',
                    onClick: () =>
                      api
                        .restoreSession(s.id)
                        .then(() => (toast('已恢复'), load()))
                        .catch((e: Error) => toast(e.message)),
                  },
                  '恢复',
                ),
              );
            })
          : [h('div', { class: 'muted small' }, '回收站是空的')]),
      ),
    );
  void load();
  return h('div', { class: 'page' }, header('回收站', 'review'), h('div', { class: 'small muted' }, '删除的课程保留 30 天，之后自动清除。删除时这节课的生词、问题和纠错也会从复习里移走，恢复时一起回来。'), list);
}

export function reviewDetailScreen(id: string): { el: HTMLElement; dispose: () => void } {
  const body = h('div', { class: 'col', style: 'gap:14px' }, h('div', { class: 'muted' }, '加载中…'));
  const title = h('h2', { class: 'en' }, '');
  let tab = 'questions';
  let poll: number | undefined;

  const load = async () => {
    const { session, lines, review } = await api.session(id);
    title.textContent = session.topic || '（未填主题）';
    const d = new Date(session.startedAt);
    const meta = h('div', { class: 'small muted' }, `${session.school} · ${d.getMonth() + 1}月${d.getDate()}日`);
    if (session.status === 'processing') {
      replace(body, meta, h('div', { class: 'card' }, h('b', null, '正在整理'), h('div', { class: 'muted' }, session.statusNote ?? ''), h('div', { class: 'small muted' }, '可以先离开，整理完再回来看')));
      poll = window.setTimeout(load, 5000);
      return;
    }
    const tabs = h('div', { class: 'tabs' });
    const content = h('div', { class: 'col', style: 'gap:10px' });
    const paintTab = () => {
      const defs: [string, string][] = [
        ['questions', `问题 ${review?.questions.length ?? 0}`],
        ['vocab', `生词 ${review?.vocab.length ?? 0}`],
        ['fix', `纠错 ${review?.myCorrections.length ?? 0}`],
        ['points', '要点'],
        ['dialogues', '对话'],
        ['transcript', '完整记录'],
      ];
      replace(tabs, ...defs.map(([k, label]) => h('button', { 'aria-pressed': String(tab === k), onClick: () => ((tab = k), paintTab()) }, label)));
      replace(content, ...tabContent(tab, review, lines.map((l) => l.en)));
    };
    paintTab();
    const failed = session.status === 'failed';
    replace(
      body,
      meta,
      failed ? h('div', { class: 'card' }, h('div', { class: 'err' }, `整理失败：${session.statusNote ?? ''}`), h('button', { class: 'btn', onClick: () => api.reprocess(id).then(load) }, '重新整理')) : null,
      review?.summaryZh ? h('div', { class: 'card' }, review.summaryZh) : null,
      !review && !failed ? h('div', { class: 'card muted' }, '这节课没有做课后整理，下面是实时字幕记录。') : null,
      tabs,
      content,
      review ? h('button', { class: 'btn', onClick: () => copyReview(session, review) }, icon('copy', 18), '复制给 Claude') : null,
    );
  };
  void load().catch((e: Error) => replace(body, h('div', { class: 'err' }, e.message)));

  return { el: h('div', { class: 'page' }, h('div', { class: 'row' }, h('button', { class: 'btn icon', 'aria-label': '返回', onClick: () => go('review') }, icon('back')), title), body), dispose: () => window.clearTimeout(poll) };
}

function tabContent(tab: string, r: SessionReview | null, liveLines: string[]): (Node | null)[] {
  if (!r) return liveLines.map((l) => h('div', { class: 'en' }, l));
  switch (tab) {
    case 'questions':
      return r.questions.map((q) =>
        h(
          'div',
          { class: 'card' },
          h('span', { class: `badge ${q.asker === 'teacher' ? 'you' : 'grey'}` }, q.asker === 'teacher' ? '老师' : '同学'),
          h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { class: 'en', style: 'flex:1;font-weight:700;font-size:16px' }, q.en), speakBtn(q.en)),
          h('div', { class: 'small muted' }, q.zh),
          ...q.answers.map((a) => answerBlock(a, false)),
        ),
      );
    case 'vocab':
      return r.vocab.map((v) =>
        h('div', { class: 'card' }, h('div', { class: 'between' }, h('div', null, h('span', { class: 'en', style: 'font-size:18px;font-weight:700' }, v.en), ' ', h('span', { class: 'en muted small' }, v.ipa)), speakBtn(v.en)), h('div', null, v.zh), h('div', { class: 'en small muted' }, v.example)),
      );
    case 'fix':
      return r.myCorrections.length
        ? r.myCorrections.map((c) =>
            h('div', { class: 'card' }, h('div', { class: 'en', style: 'color:var(--bad);text-decoration:line-through' }, c.said), h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { class: 'en', style: 'flex:1;color:var(--answer);font-weight:700;font-size:17px' }, c.better), speakBtn(c.better)), h('div', { class: 'small muted' }, c.whyZh)),
          )
        : [h('div', { class: 'muted' }, '这节课没有找到需要纠正的句子')];
    case 'points':
      return r.points.map((p) => h('div', { class: 'card' }, h('b', { class: 'en' }, p.title), h('div', null, p.detailZh), ...p.examples.map((e) => h('div', { class: 'row' }, h('div', { class: 'en muted', style: 'flex:1' }, e), speakBtn(e)))));
    case 'dialogues':
      return r.dialogues.map((d) =>
        h('div', { class: 'card' }, h('b', null, d.titleZh), ...d.turns.map((t) => h('div', { class: 'col', style: 'gap:2px' }, h('div', { class: 'row', style: 'align-items:flex-start' }, h('span', { class: 'small muted', style: 'width:64px;flex:none' }, t.speaker), h('span', { class: 'en', style: 'flex:1' }, t.en), speakBtn(t.en)), h('div', { class: 'small muted', style: 'padding-left:72px' }, t.zh)))),
      );
    default:
      return r.transcript.map((t) => h('div', { class: 'en', style: 'line-height:1.5' }, t.en));
  }
}

async function copyReview(s: ClassSession, r: SessionReview): Promise<void> {
  const text = [
    `# ${s.school} ${new Date(s.startedAt).toLocaleDateString('zh-CN')} ${s.topic}`,
    r.summaryZh,
    '## 生词',
    ...r.vocab.map((v) => `- ${v.en} ${v.ipa} ${v.zh}`),
    '## 老师的问题',
    ...r.questions.map((q) => `- ${q.en}（${q.zh}）→ ${q.answers[0]?.en ?? ''}`),
    '## 我说错的',
    ...r.myCorrections.map((c) => `- ${c.said} → ${c.better}（${c.whyZh}）`),
  ].join('\n');
  toast((await copyText(text)) ? '已复制，粘贴给 Claude 即可' : '复制失败，请长按选择文字复制');
}

const TYPE_HINT: Record<string, string> = { word: '这个词英文怎么说？', pattern: '用英文说这句话', question: '用英文回答', correction: '用正确的英文说出来', sentence: '用英文说这句话' };

/**
 * Practice sheet: Chinese prompt → the learner types or says the English (no hints first) →
 * the server judges it → show the right answer → grade. Wrong answers come back at the end (retest).
 */
export function practice(items: ReviewItem[], title = '复习', onDone?: () => void): void {
  const queue = [...items];
  let i = 0;
  let right = 0;
  let wrong = 0;
  const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  const root = h('div', { class: 'sheet-bg' }, box);
  document.body.appendChild(root);
  const voice = new VoiceCapture();
  let recording = false;
  const stopMic = () => voice.finish();
  const close = () => {
    voice.release();
    root.remove();
    onDone?.();
  };
  const top = () =>
    h(
      'div',
      { class: 'between small muted' },
      h('span', null, `${title} · ${Math.min(i + 1, queue.length)} / ${queue.length}`),
      h('button', { class: 'btn icon', 'aria-label': '关闭', onClick: close }, icon('close')),
    );

  const ask = () => {
    const it = queue[i];
    if (!it) {
      replace(
        box,
        h('div', { class: 'grab' }),
        h('h2', null, `${title}完成了`),
        h('div', { class: 'muted' }, `答对 ${right} 次，答错 ${wrong} 次。答错的已经重考过；同一个连对 3 次算掌握。`),
        h('button', { class: 'btn primary', onClick: close }, '好的'),
      );
      return;
    }
    const input = h('input', { placeholder: '输入英文，或点麦克风说', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', style: 'flex:1;min-width:0;height:48px' }) as HTMLInputElement;
    const heard = h('div', { class: 'small muted' });
    const mic = h('button', { class: 'hold', 'aria-label': '说英文' }, icon('mic', 18), '说') as HTMLButtonElement;
    let spoken = false;
    const submit = () => {
      if (recording) return voice.finish();
      const a = input.value.trim();
      if (!a) return toast('先输入或说出你的答案');
      void check(it, a, spoken);
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    input.addEventListener('input', () => (spoken = false));
    const micIdle = () => {
      recording = false;
      mic.classList.remove('on');
      replace(mic, icon('mic', 18), '说');
    };
    mic.addEventListener('click', async () => {
      if (recording) return voice.finish();
      speechSynthesis?.cancel();
      recording = true;
      mic.classList.add('on');
      replace(mic, icon('stop', 18), '说完点我');
      heard.textContent = '在听…说完停一下会自动检查';
      let blob: Blob | null = null;
      try {
        blob = await voice.record({ silenceMs: 1800, maxMs: 15_000, noSpeechMs: 10_000, onSpeech: () => (heard.textContent = '在听你说…') });
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
      micIdle(); // the microphone stays open until the sheet closes, so iOS asks/banners only once
      if (!box.contains(input)) return;
      if (!blob) {
        heard.textContent = '没听到声音，再点一次“说”';
        return;
      }
      heard.textContent = '识别中…';
      try {
        const text = (await api.stt(blob, 'en', `English practice. The learner is trying to say: ${it.en}`)).text.trim();
        if (!box.contains(input)) return;
        if (!text) {
          heard.textContent = '没听清，请再说一遍';
          return;
        }
        input.value = text;
        spoken = true;
        heard.textContent = '';
        void check(it, text, true);
      } catch (e) {
        heard.textContent = e instanceof Error ? e.message : String(e);
      }
    });
    replace(
      box,
      h('div', { class: 'grab' }),
      top(),
      h('div', { class: 'small', style: 'color:var(--accent)' }, TYPE_HINT[it.type] ?? '用英文说出来'),
      h('div', { style: 'font-size:22px;font-weight:700;line-height:1.5' }, it.zh),
      h('div', { class: 'row' }, input, mic),
      heard,
      h('div', { class: 'grid2' }, h('button', { class: 'btn', onClick: () => (stopMic(), void reveal(it)) }, '不会，看答案'), h('button', { class: 'btn primary', onClick: submit }, '检查')),
    );
  };

  let spokenLast = false;
  const check = async (it: ReviewItem, answer: string, spoken = false) => {
    spokenLast = spoken;
    replace(box, h('div', { class: 'grab' }), top(), h('div', { style: 'font-size:20px;font-weight:700' }, it.zh), h('div', { class: 'muted' }, '正在检查…'));
    try {
      const r = await api.check(it.id, answer, spoken);
      result(it, answer, r.correct, r.feedbackZh, r.better);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      result(it, answer, null, '没能自动检查，请自己对照答案判断', '');
    }
  };

  const reveal = (it: ReviewItem) => ((spokenLast = false), result(it, '', false, '没关系，记住答案，等一下会再考你一次', ''));

  /** correct === null: the check failed, let the learner decide. */
  const result = (it: ReviewItem, answer: string, correct: boolean | null, feedbackZh: string, better: string) => {
    speak(it.en);
    const verdict =
      correct === null
        ? h('div', { class: 'muted' }, feedbackZh)
        : h(
            'div',
            { class: 'row', style: 'align-items:flex-start' },
            h('span', { class: `badge ${correct ? 'ok' : 'err'}`, style: 'font-size:14px;padding:4px 10px' }, correct ? '对了' : '不对'),
            h('div', { style: 'flex:1;line-height:1.5' }, feedbackZh),
          );
    const next = (ok: boolean) => void grade(it, ok);
    replace(
      box,
      h('div', { class: 'grab' }),
      top(),
      h('div', { style: 'font-size:20px;font-weight:700;line-height:1.5' }, it.zh),
      answer ? h('div', null, h('span', { class: 'small muted' }, spokenLast ? '听到你说：' : '你的回答：'), h('span', { class: 'en' }, answer)) : null,
      verdict,
      h(
        'div',
        { class: 'col', style: 'gap:4px' },
        h('div', { class: 'small muted' }, '答案'),
        h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { class: 'say', style: 'flex:1' }, it.en), speakBtn(it.en)),
        it.ipa ? h('div', { class: 'en muted' }, it.ipa) : null,
        it.note ? h('div', { class: 'small muted' }, it.note) : null,
      ),
      better && better.toLowerCase() !== it.en.toLowerCase()
        ? h('div', { class: 'col', style: 'gap:4px' }, h('div', { class: 'small muted' }, '照你的说法改一下'), h('div', { class: 'row' }, h('div', { class: 'en', style: 'flex:1;font-size:17px' }, better), speakBtn(better)))
        : null,
      correct === true
        ? h('button', { class: 'btn primary', onClick: () => next(true) }, '下一题')
        : correct === false
          ? h('div', { class: 'grid2' }, answer ? h('button', { class: 'btn', onClick: () => next(true) }, '其实我对了') : h('span'), h('button', { class: 'btn primary', onClick: () => next(false) }, '下一题'))
          : h('div', { class: 'grid2' }, h('button', { class: 'btn warn', onClick: () => next(false) }, '我错了'), h('button', { class: 'btn primary', onClick: () => next(true) }, '我对了')),
    );
  };

  const grade = async (it: ReviewItem, ok: boolean) => {
    try {
      await api.grade(it.id, ok);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
    if (ok) right++;
    else {
      wrong++;
      queue.push({ ...it }); // wrong answers come back at the end of this round (retest)
    }
    i++;
    ask();
  };

  ask();
}
