// Review: list of classes, one class's review material, and a simple practice queue
// (Chinese prompt -> say/think the English -> reveal -> mark right or wrong; 3 right in a row = mastered).

import type { ClassSession, ReviewItem, SessionReview } from '../../../shared/types';
import { api } from '../../api';
import { speak } from '../../device';
import { copyText, h, icon, replace, toast } from '../../dom';
import { go } from '../router';
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
      h('div', { class: 'small muted' }, '中文出题，你先用英文说出来，再看答案；同一个连对 3 次算掌握'),
      h('button', { class: 'btn primary', disabled: items.length === 0, onClick: () => practice(items) }, items.length ? '开始复习' : '今天没有到期的内容'),
    );
  });
  const load = () =>
    api.sessions().then((sessions) =>
      replace(list, ...(sessions.length ? sessions.map((s) => classRow(s, load)) : [h('div', { class: 'muted small' }, '还没有课程记录')])),
    );
  void load();
  return h(
    'div',
    { class: 'page' },
    header('复习', ''),
    due,
    h('div', { class: 'between' }, h('h3', null, '课程记录'), h('button', { class: 'btn', style: 'height:36px', onClick: () => go('bin') }, '回收站')),
    list,
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

function practice(items: ReviewItem[]): void {
  let i = 0;
  const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  const root = h('div', { class: 'sheet-bg' }, box);
  document.body.appendChild(root);
  const close = () => root.remove();
  const show = (revealed: boolean) => {
    const it = items[i];
    if (!it) {
      replace(box, h('div', { class: 'grab' }), h('h2', null, '今天的复习完成了'), h('button', { class: 'btn primary', onClick: () => (close(), go('review')) }, '好的'));
      return;
    }
    replace(
      box,
      h('div', { class: 'grab' }),
      h('div', { class: 'between small muted' }, h('span', null, `${i + 1} / ${items.length}`), h('button', { class: 'btn icon', 'aria-label': '关闭', onClick: close }, icon('close'))),
      h('div', { style: 'font-size:20px;font-weight:700;line-height:1.5' }, it.zh),
      revealed
        ? h('div', { class: 'col' }, h('div', { class: 'row', style: 'align-items:flex-start' }, h('div', { class: 'say', style: 'flex:1' }, it.en), speakBtn(it.en)), it.ipa ? h('div', { class: 'en muted' }, it.ipa) : null, it.note ? h('div', { class: 'small muted' }, it.note) : null)
        : h('div', { class: 'muted' }, '先用英文说出来，再看答案'),
      revealed
        ? h('div', { class: 'grid2' }, h('button', { class: 'btn warn', onClick: () => mark(false) }, '没说对'), h('button', { class: 'btn primary', onClick: () => mark(true) }, '说对了'))
        : h('button', { class: 'btn primary', onClick: () => (show(true), speak(it.en)) }, '看答案'),
    );
  };
  const mark = async (correct: boolean) => {
    const it = items[i];
    try {
      await api.grade(it.id, correct);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
    if (!correct) items.push({ ...it }); // wrong answers come back at the end of this round (retest)
    i++;
    show(false);
  };
  show(false);
}
