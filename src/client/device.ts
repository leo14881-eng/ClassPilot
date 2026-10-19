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

export function speak(text: string, rate = 0.9): void {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = rate;
  const voice = speechSynthesis.getVoices().find((v) => v.lang === 'en-US' && /Samantha|Alex|Ava|Allison/i.test(v.name));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
