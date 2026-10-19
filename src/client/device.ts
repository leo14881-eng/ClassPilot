// Small wrappers over device features: keep the screen on, read text aloud.

let lock: { release(): Promise<void> } | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
  if (!wl) return;
  try {
    lock = await wl.request('screen');
  } catch {
    lock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') void acquire();
});

export async function keepScreenOn(on: boolean): Promise<void> {
  wanted = on;
  if (on) await acquire();
  else {
    await lock?.release().catch(() => {});
    lock = null;
  }
}

export function speak(text: string, rate = 0.8): void {
  void speakAsync(text, { rate });
}

/** Read text aloud; resolves when finished, cancelled, or after a safety timeout (iOS sometimes never fires onend). */
export function speakAsync(text: string, opts: { rate?: number; lang?: 'en-US' | 'zh-CN' } = {}): Promise<void> {
  if (!('speechSynthesis' in window) || !text.trim()) return Promise.resolve();
  const lang = opts.lang ?? 'en-US';
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = opts.rate ?? (lang === 'en-US' ? 0.8 : 0.95);
  const voices = speechSynthesis.getVoices();
  const voice =
    lang === 'en-US'
      ? voices.find((v) => v.lang === 'en-US' && /Samantha|Alex|Ava|Allison/i.test(v.name))
      : voices.find((v) => /^zh[-_]CN/i.test(v.lang));
  if (voice) u.voice = voice;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve();
    };
    const perChar = lang === 'en-US' ? 95 : 300;
    const timer = window.setTimeout(finish, 2500 + text.length * perChar);
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);
  });
}
