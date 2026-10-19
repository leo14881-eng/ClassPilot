// Small wrappers over device features: keep the screen on, read text aloud.

// Keeping the screen on during class/conversation (iOS turns it off after 30 s otherwise, which also stops the microphone):
// 1. the Screen Wake Lock API, re-requested on every tap because iOS releases it easily and may need a user gesture;
// 2. a tiny silent looping video as a fallback (the classic NoSleep trick), which iOS treats as "media playing".

type Sentinel = { release(): Promise<void>; addEventListener?(t: 'release', f: () => void): void };
let lock: Sentinel | null = null;
let wanted = false;
let video: HTMLVideoElement | null = null;

const KEEP_AWAKE_MP4 = 'data:video/mp4;base64,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';

async function acquire(): Promise<void> {
  const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<Sentinel> } }).wakeLock;
  if (wl && !lock) {
    try {
      const l = await wl.request('screen');
      lock = l;
      l.addEventListener?.('release', () => lock === l && (lock = null));
    } catch {
      lock = null;
    }
  }
  if (!video) {
    video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.loop = true;
    video.src = KEEP_AWAKE_MP4;
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;bottom:0;left:0';
    document.body.appendChild(video);
  }
  if (video.paused) void video.play().catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') void acquire();
});
// Any tap re-arms it (a user gesture is the most reliable moment on iOS).
for (const ev of ['pointerdown', 'touchend', 'click']) {
  document.addEventListener(ev, () => wanted && (!lock || video?.paused) && void acquire(), { capture: true, passive: true });
}

export async function keepScreenOn(on: boolean): Promise<void> {
  wanted = on;
  if (on) await acquire();
  else {
    const l = lock;
    lock = null;
    await l?.release().catch(() => {});
    video?.pause();
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
