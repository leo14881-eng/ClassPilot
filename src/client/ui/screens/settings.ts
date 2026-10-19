// Settings: learner profile, answer level, audio retention, AI provider status (never the keys).

import type { UserSettings } from '../../../shared/settings';
import { api } from '../../api';
import { h, icon, replace, toast } from '../../dom';
import { go } from '../router';

export function settingsScreen(): HTMLElement {
  const form = h('div', { class: 'col', style: 'gap:14px' }, h('div', { class: 'muted' }, '加载中…'));
  const status = h('div', { class: 'card' }, h('div', { class: 'muted small' }, '查询中…'));

  const paintStatus = () =>
    api
      .status()
      .then((s) =>
        replace(
          status,
          h('b', null, 'AI 接口'),
          h('div', { class: 'between small' }, h('span', { class: 'muted' }, '正在使用'), h('span', { class: 'en' }, s.active === 'openrouter' ? 'OpenRouter' : s.active === 'openai' ? 'OpenAI' : '未配置')),
          h('div', { class: 'between small' }, h('span', { class: 'muted' }, 'OpenRouter 余额'), h('span', { class: 'en' }, s.openrouterRemaining === null ? '—' : `$${s.openrouterRemaining.toFixed(2)}`)),
          h('div', { class: 'between small' }, h('span', { class: 'muted' }, 'OpenRouter / OpenAI Key'), h('span', null, `${s.openrouterConfigured ? '已配置' : '未配置'} / ${s.openaiConfigured ? '已配置' : '未配置'}`)),
          h('div', { class: 'between small' }, h('span', { class: 'muted' }, '复习词库'), h('span', null, `${s.items.total} 条，已掌握 ${s.items.mastered}`)),
          s.openrouterExhausted
            ? h('button', { class: 'btn', onClick: () => api.resetOpenrouter().then(() => (toast('已切回 OpenRouter'), paintStatus())) }, 'OpenRouter 已充值，切回去用')
            : null,
          h('div', { class: 'small muted' }, 'Key 保存在服务器上，这里不显示'),
        ),
      )
      .catch((e: Error) => replace(status, h('div', { class: 'err' }, e.message)));

  void api.settings().then((s) => replace(form, ...fields(s)));
  void paintStatus();

  return h(
    'div',
    { class: 'page' },
    h('div', { class: 'row' }, h('button', { class: 'btn icon', 'aria-label': '返回', onClick: () => go('') }, icon('back')), h('h2', null, '设置')),
    form,
    status,
    h('a', { class: 'btn', href: 'api/export', download: 'classpilot-backup.json' }, '导出备份（JSON）'),
  );
}

function fields(s: UserSettings): HTMLElement[] {
  const input = (id: string, label: string, value: string, placeholder = '') =>
    h('div', { class: 'col', style: 'gap:4px' }, h('label', { for: id }, label), h('input', { id, value, placeholder, class: 'en' }));
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
  let level = s.level;
  let record = s.recordAudio;
  const levelSeg = h('div', { class: 'seg' });
  const paintLevel = () =>
    replace(
      levelSeg,
      h('button', { 'aria-pressed': String(level === 'beginner'), onClick: () => ((level = 'beginner'), paintLevel()) }, '初学者'),
      h('button', { 'aria-pressed': String(level === 'intermediate'), onClick: () => ((level = 'intermediate'), paintLevel()) }, '进阶'),
    );
  paintLevel();
  const recSeg = h('div', { class: 'seg' });
  const paintRec = () =>
    replace(
      recSeg,
      h('button', { 'aria-pressed': String(record), onClick: () => ((record = true), paintRec()) }, '上课录音'),
      h('button', { 'aria-pressed': String(!record), onClick: () => ((record = false), paintRec()) }, '不录音'),
    );
  paintRec();
  const keep = h(
    'select',
    { id: 'keep' },
    ...[0, 3, 7, 14].map((d) => h('option', { value: String(d), selected: s.keepAudioDays === d }, d === 0 ? '整理完就删除，只留文字' : `保留 ${d} 天`)),
  );
  const save = h('button', { class: 'btn primary' }, '保存');
  save.addEventListener('click', async () => {
    try {
      await api.saveSettings({
        profile: { name: val('p-name'), aliases: val('p-alias'), from: val('p-from'), livesIn: val('p-live'), job: val('p-job'), other: val('p-other') },
        level,
        recordAudio: record,
        keepAudioDays: Number((document.getElementById('keep') as HTMLSelectElement).value),
      });
      toast('已保存');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  });
  return [
    h(
      'div',
      { class: 'card' },
      h('b', null, '我的资料 ', h('span', { class: 'small muted' }, '用来生成你的答案')),
      h('div', { class: 'grid2' }, input('p-name', '名字', s.profile.name), input('p-alias', '别人怎么叫我', s.profile.aliases)),
      h('div', { class: 'grid2' }, input('p-from', '来自', s.profile.from), input('p-live', '住在', s.profile.livesIn)),
      input('p-job', '职业', s.profile.job),
      input('p-other', '爱好和其他（中英都行）', s.profile.other, '比如：喝咖啡、看电影'),
    ),
    h('div', { class: 'card' }, h('b', null, '答案难度'), levelSeg),
    h('div', { class: 'card' }, h('b', null, '录音'), recSeg, h('label', { for: 'keep' }, '完整录音保存多久'), keep),
    save,
  ];
}
