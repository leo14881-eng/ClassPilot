// App entry: checks login, then routes between screens.

import './ui/styles.css';
import { api, setUnauthorizedHandler } from './api';
import { h, replace } from './dom';
import { homeScreen } from './ui/screens/home';
import { liveScreen } from './ui/screens/live';
import { reviewDetailScreen, reviewListScreen } from './ui/screens/review';
import { settingsScreen } from './ui/screens/settings';
import { go, parse } from './ui/router';

const app = document.getElementById('app')!;
let dispose: () => void = () => {};
let authed = false;

function loginScreen(): HTMLElement {
  const input = h('input', { id: 'pass', type: 'password', autocomplete: 'current-password', placeholder: '输入口令' });
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary big' }, '进入');
  const submit = async () => {
    btn.disabled = true;
    err.textContent = '';
    try {
      await api.login(input.value);
      authed = true;
      go('');
      route();
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  return h(
    'div',
    { class: 'page', style: 'justify-content:center' },
    h('div', { class: 'brand', style: 'font-size:32px' }, 'Class', h('span', null, 'Pilot')),
    h('div', { class: 'muted' }, '英语课堂助手'),
    h('div', { class: 'col' }, h('label', { for: 'pass' }, '口令'), input),
    btn,
    err,
    h('div', { class: 'small muted' }, '输入一次后这台手机会记住。'),
  );
}

function route(): void {
  dispose();
  dispose = () => {};
  if (!authed) {
    replace(app, loginScreen());
    return;
  }
  const r = parse(location.hash);
  switch (r.name) {
    case 'live': {
      const s = liveScreen(r.id!);
      dispose = s.dispose;
      replace(app, s.el);
      break;
    }
    case 'review':
      replace(app, reviewListScreen());
      break;
    case 'reviewDetail': {
      const s = reviewDetailScreen(r.id!);
      dispose = s.dispose;
      replace(app, s.el);
      break;
    }
    case 'settings':
      replace(app, settingsScreen());
      break;
    default:
      replace(app, homeScreen());
  }
  window.scrollTo(0, 0);
}

setUnauthorizedHandler(() => {
  if (!authed) return;
  authed = false;
  route();
});

window.addEventListener('hashchange', route);

(async () => {
  try {
    await api.me();
    authed = true;
  } catch {
    authed = false;
  }
  route();
})();
