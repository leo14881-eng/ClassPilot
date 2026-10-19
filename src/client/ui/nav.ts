// Bottom tab bar on the main screens: 上课 · 计划 · 复习 · 成绩.

import { h, icon } from '../dom';
import { go } from './router';

type Tab = 'home' | 'plan' | 'review' | 'scores';

const TABS: { id: Tab; label: string; path: string; icon: string }[] = [
  { id: 'home', label: '上课', path: '', icon: 'mic' },
  { id: 'plan', label: '每日计划', path: 'plan', icon: 'calendar' },
  { id: 'review', label: '复习', path: 'review', icon: 'book' },
  { id: 'scores', label: '成绩', path: 'scores', icon: 'chart' },
];

export function bottomNav(active: Tab): HTMLElement {
  return h(
    'nav',
    { class: 'tabbar', 'aria-label': '主菜单' },
    ...TABS.map((t) =>
      h(
        'button',
        { class: t.id === active ? 'on' : '', 'aria-current': t.id === active ? 'page' : null, onClick: () => go(t.path) },
        icon(t.icon, 22),
        h('span', null, t.label),
      ),
    ),
  );
}
