// Import a whole-class recording made with iPhone Voice Memos (语音备忘录).
// An iPhone web page stops hearing when the screen locks or another app is opened — iOS does not let web pages
// use the microphone in the background, and no code can change that. Voice Memos keeps recording, so for a
// complete record the class is recorded there and imported afterwards; it is turned into the same review and MD.

import type { ClassSession } from '../../shared/types';
import { api } from '../api';
import { h, toast } from '../dom';

export const VOICE_MEMO_STEPS = '在「语音备忘录」里点这条录音 → 右下角“…” → 共享 → 存储到“文件”，然后回来点导入，选这个文件。';

/** A button that picks an audio file, uploads it in pieces and returns the class it became. */
export function importRecordingButton(
  label: string,
  opts: () => { sessionId?: string; school?: string; topic?: string },
  onDone: (s: ClassSession) => void,
  cls = 'btn',
): HTMLElement {
  const input = h('input', { type: 'file', accept: 'audio/*,.m4a,.mp3,.wav,.aac', style: 'display:none' }) as HTMLInputElement;
  const btn = h('button', { class: cls }, label) as HTMLButtonElement;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const mb = file.size / 1048576;
    btn.disabled = true;
    try {
      const s = await api.importRecording(file, opts(), (done, total) => {
        btn.textContent = done < total ? `上传中 ${Math.round((done / total) * 100)}%（共 ${mb.toFixed(0)} MB，别锁屏）` : '上传完了，正在拆分录音…';
      });
      toast('录音已导入，正在整理，几分钟后就好');
      onDone(s);
    } catch (e) {
      btn.textContent = '导入失败，点我重试';
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      btn.disabled = false;
    }
  });
  return h('div', { class: 'col', style: 'gap:6px' }, btn, input);
}
