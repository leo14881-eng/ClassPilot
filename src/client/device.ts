// Small wrappers over device features: keep the screen on, read text aloud.

// Keeping the screen on during class/conversation (iOS turns it off after 30 s otherwise, which also stops the microphone):
// 1. the Screen Wake Lock API, re-requested on every tap because iOS releases it easily and may need a user gesture;
// 2. a tiny silent looping video as a fallback (the classic NoSleep trick), which iOS treats as "media playing".

type Sentinel = { release(): Promise<void>; addEventListener?(t: 'release', f: () => void): void };
let lock: Sentinel | null = null;
let wanted = false;
let video: HTMLVideoElement | null = null;

const KEEP_AWAKE_MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMvbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAC7gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAll0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAC7gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAu4AAAAAAABAAAAAAHRbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAwABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABfG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAATxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMACDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAbwAAAG8AAAABhzdHRzAAAAAAAAAAEAAAADAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAADAAAAAQAAACBzdHN6AAAAAAAAAAAAAAADAAAChgAAAAoAAAAKAAAAFHN0Y28AAAAAAAAAAQAAA18AAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAACom1kYXQAAAJwBgX//2zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAADmWIhAX///8PRQABV5+AAAAABkGaOAt6gAAAAAZBmlQCvqA='; // video only: no audio track, so it never competes for the audio session

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
