// Tiny DOM helper instead of a framework: h('div', { class: 'x', onClick }, ...children).

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        el.className = String(v);
      } else if (k === 'style') {
        el.setAttribute('style', String(v));
      } else if (k === 'value' && 'value' in el) {
        (el as HTMLInputElement).value = String(v);
      } else if (k === 'checked' && 'checked' in el) {
        (el as HTMLInputElement).checked = Boolean(v);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Inline stroke icons (no emoji). */
const PATHS: Record<string, string> = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/><path d="M8 7h6M8 11h6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  chart: '<path d="M4 19V5M10 19V9M16 19v-6M22 19H2"/>',
};

export function icon(name: keyof typeof PATHS | string, size = 20): SVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;
  return wrap.firstElementChild as SVGElement;
}

let toastTimer: number | undefined;
export function toast(msg: string, ms = 2600): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove('show'), ms);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older iOS: copy through a hidden text area.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
