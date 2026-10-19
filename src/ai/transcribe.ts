// Post-class transcription of recorded audio chunks (each a few minutes long, under upload limits).
// OpenRouter: POST /audio/transcriptions with base64 JSON. OpenAI: multipart upload.

import { currentSettings } from '../storage/settings';
import { ENDPOINT, headers, readError, withProviders } from './client';

function formatOf(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'mp4';
}

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < buf.length; i += step) bin += String.fromCharCode(...buf.subarray(i, i + step));
  return btoa(bin);
}

export async function transcribe(blob: Blob, mime: string): Promise<string> {
  const s = currentSettings();
  return withProviders(async (p, key) => {
    const format = formatOf(mime);
    if (p === 'openrouter') {
      const body: Record<string, unknown> = {
        model: s.models.sttOpenrouter,
        input_audio: { data: await toBase64(blob), format },
        language: 'en',
      };
      if (s.sttProviderOptions.trim()) {
        try {
          body.provider = { options: JSON.parse(s.sttProviderOptions) };
        } catch {
          /* invalid JSON in settings is ignored */
        }
      }
      const res = await fetch(`${ENDPOINT.openrouter}/audio/transcriptions`, {
        method: 'POST',
        headers: headers(p, key),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await readError(p, res);
      const d = await res.json();
      return String(d?.text ?? '');
    }
    const form = new FormData();
    form.append('file', blob, `chunk.${format === 'mp4' ? 'm4a' : format}`);
    form.append('model', s.models.sttOpenai);
    form.append('language', 'en');
    const res = await fetch(`${ENDPOINT.openai}/audio/transcriptions`, {
      method: 'POST',
      headers: headers(p, key, false),
      body: form,
    });
    if (!res.ok) throw await readError(p, res);
    const d = await res.json();
    return String(d?.text ?? '');
  });
}
