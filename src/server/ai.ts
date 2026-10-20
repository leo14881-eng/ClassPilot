// Every AI call goes through here, on the server, so API keys never reach the browser.
// OpenRouter is tried first; when its balance is used up it is marked exhausted (stored in kv)
// and calls move to the OpenAI key.

import { ApiError, isOutOfCredits, providerOrder, type ProviderName } from '../shared/fallback';
import type { ProviderStatus } from '../shared/settings';
import { parseJsonLoose } from '../shared/text';
import type { ServerConfig } from './config';
import type { Store } from './db';

/** live = in-class, must be fast; smart = ask / word / conversation, quality first; deep = post-class review. */
export type Purpose = 'live' | 'smart' | 'deep';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const ENDPOINT: Record<ProviderName, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
};

const EXHAUSTED_KEY = 'openrouterExhausted';

export class Ai {
  constructor(
    private cfg: ServerConfig,
    private store: Store,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private key(p: ProviderName): string {
    return p === 'openrouter' ? this.cfg.openrouterKey : this.cfg.openaiKey;
  }

  get exhausted(): boolean {
    return this.store.kvGet<boolean>(EXHAUSTED_KEY) === true;
  }

  /** Clear the exhausted flag (e.g. after topping up OpenRouter). */
  resetExhausted(): void {
    this.store.kvSet(EXHAUSTED_KEY, false);
  }

  headers(p: ProviderName, json = true): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.key(p)}` };
    if (json) h['Content-Type'] = 'application/json';
    if (p === 'openrouter') h['X-Title'] = 'ClassPilot';
    return h;
  }

  async readError(p: ProviderName, res: Response): Promise<ApiError> {
    let msg = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      msg = body?.error?.message || JSON.stringify(body).slice(0, 300);
    } catch {
      /* not JSON */
    }
    // Providers sometimes quote (part of) the key back ("Incorrect API key provided: sk-proj…"): never pass that on.
    msg = msg.replace(/sk-[A-Za-z0-9_*\-]{6,}/g, 'sk-…').replace(/Incorrect API key provided[^.]*\./i, `${p === 'openai' ? 'OpenAI' : 'OpenRouter'} 的 API Key 无效，请在服务器配置里换一个有效的 Key。`);
    return new ApiError(p, res.status, msg);
  }

  async withProviders<T>(call: (p: ProviderName) => Promise<T>): Promise<T> {
    const order = providerOrder({ openrouter: this.cfg.openrouterKey, openai: this.cfg.openaiKey }, this.exhausted);
    if (order.length === 0) throw new Error('服务器还没有配置 API Key');
    let last: unknown;
    for (const p of order) {
      try {
        return await call(p);
      } catch (err) {
        last = err;
        if (isOutOfCredits(err)) {
          this.store.kvSet(EXHAUSTED_KEY, true);
          console.warn('[ai] OpenRouter balance used up, switching to OpenAI');
          continue;
        }
        throw err;
      }
    }
    throw last;
  }

  private model(p: ProviderName, purpose: Purpose): string {
    const m = this.cfg.models;
    if (purpose === 'live') return p === 'openrouter' ? m.liveOpenrouter : m.liveOpenai;
    if (purpose === 'smart') return p === 'openrouter' ? m.smartOpenrouter : m.smartOpenai;
    return p === 'openrouter' ? m.deepOpenrouter : m.deepOpenai;
  }

  async chat(messages: ChatMessage[], opts: { purpose: Purpose; json?: boolean; temperature?: number }): Promise<string> {
    return this.withProviders(async (p) => {
      const body: Record<string, unknown> = { model: this.model(p, opts.purpose), messages, temperature: opts.temperature ?? 0.3 };
      if (opts.json) body.response_format = { type: 'json_object' };
      const res = await this.fetchImpl(`${ENDPOINT[p]}/chat/completions`, {
        method: 'POST',
        headers: this.headers(p),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.purpose === 'live' ? 30_000 : opts.purpose === 'smart' ? 60_000 : 180_000),
      });
      if (!res.ok) throw await this.readError(p, res);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('AI 没有返回内容');
      return text;
    });
  }

  async chatJson<T>(messages: ChatMessage[], opts: { purpose: Purpose }): Promise<T> {
    return parseJsonLoose<T>(await this.chat(messages, { ...opts, json: true }));
  }

  /** Transcribe one recorded chunk (a few minutes of audio). */
  /**
   * Speech to text. Models were chosen by measuring 120 recordings of adult Mandarin speakers reading English
   * (speechocean762) and 30 Mandarin clips (AISHELL-1):
   *   English  → ElevenLabs Scribe v2 (7–10% word errors, no garbage output; gpt-4o-transcribe produced
   *              Chinese/garbled text on ~8% of accented clips), second opinion / fallback Whisper large-v3 turbo.
   *   Chinese  → gpt-4o-transcribe (4.6% character errors).
   * `use`: 'en' (default), 'en2' (the second-opinion model), 'zh', 'record' (3-minute class recordings).
   * `model`: diagnostics only, "or:<openrouter slug>" or "oa:<openai model>".
   */
  async transcribe(input: Buffer, mime: string, opts: { use?: 'en' | 'en2' | 'zh' | 'record'; model?: string } = {}): Promise<string> {
    const use = opts.use ?? 'en';
    // The phone uploads compact μ-law WAV (saves mobile data); providers get standard 16-bit PCM.
    const audio = mime.includes('wav') ? expandMulawWav(input) : input;
    const language = use === 'zh' ? 'zh' : 'en';
    const m = this.cfg.models;
    const once = async (p: ProviderName, model: string): Promise<string> => {
      if (p === 'openrouter') {
        const body: Record<string, unknown> = { model, input_audio: { data: audio.toString('base64'), format: openrouterFormat(mime) }, language, temperature: 0 };
        if (this.cfg.sttProviderOptions && use === 'record') body.provider = { options: this.cfg.sttProviderOptions };
        const res = await this.fetchImpl(`${ENDPOINT.openrouter}/audio/transcriptions`, {
          method: 'POST',
          headers: this.headers(p),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(use === 'record' ? 120_000 : 12_000),
        });
        if (!res.ok) throw await this.readError(p, res);
        return String(((await res.json()) as { text?: string }).text ?? '');
      }
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `audio.${extOf(mime)}`);
      form.append('model', model);
      form.append('language', language);
      const res = await this.fetchImpl(`${ENDPOINT.openai}/audio/transcriptions`, {
        method: 'POST',
        headers: this.headers(p, false),
        body: form,
        signal: AbortSignal.timeout(use === 'record' ? 120_000 : 12_000),
      });
      if (!res.ok) throw await this.readError(p, res);
      return String(((await res.json()) as { text?: string }).text ?? '');
    };
    if (opts.model) {
      const name = opts.model.slice(3);
      return cleanTranscript(await once(opts.model.startsWith('oa:') ? 'openai' : 'openrouter', name));
    }
    const primary = { en: [m.sttEnOpenrouter, m.sttEnOpenai], en2: [m.sttEn2Openrouter, m.sttEnOpenai], zh: [m.sttZhOpenrouter, m.sttZhOpenai], record: [m.sttOpenrouter, m.sttOpenai] }[use];
    const backup = [m.sttEn2Openrouter, m.sttEnOpenai];
    const run = (pair: string[]) => this.withProviders((p) => once(p, p === 'openrouter' ? pair[0] : pair[1]));
    try {
      return cleanTranscript(await run(primary));
    } catch (e) {
      if (primary[0] === backup[0]) throw e;
      console.warn('[ai] transcription failed, trying the backup model:', e instanceof Error ? e.message : e);
      return cleanTranscript(await run(backup));
    }
  }

  async status(): Promise<ProviderStatus> {
    const order = providerOrder({ openrouter: this.cfg.openrouterKey, openai: this.cfg.openaiKey }, this.exhausted);
    return {
      openrouterConfigured: !!this.cfg.openrouterKey,
      openaiConfigured: !!this.cfg.openaiKey,
      openrouterExhausted: this.exhausted,
      openrouterRemaining: await this.openrouterRemaining(),
      active: order[0] ?? 'none',
    };
  }

  private async openrouterRemaining(): Promise<number | null> {
    if (!this.cfg.openrouterKey) return null;
    try {
      const res = await this.fetchImpl(`${ENDPOINT.openrouter}/credits`, { headers: this.headers('openrouter'), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const d = ((await res.json()) as { data?: { total_credits?: number; total_usage?: number } }).data;
      if (typeof d?.total_credits === 'number' && typeof d?.total_usage === 'number') return Math.round((d.total_credits - d.total_usage) * 100) / 100;
      return null;
    } catch {
      return null;
    }
  }
}

/** 8-bit μ-law WAV → 16-bit PCM WAV (same rate). Anything else is returned unchanged. */
export function expandMulawWav(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
  // Find the fmt and data chunks.
  let off = 12;
  let fmt = -1;
  let data = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = off + 8;
    if (id === 'data') {
      data = off + 8;
      dataLen = Math.min(len, buf.length - data);
      break;
    }
    off += 8 + len + (len % 2);
  }
  if (fmt < 0 || data < 0 || buf.readUInt16LE(fmt) !== 7 || buf.readUInt16LE(fmt + 14) !== 8) return buf;
  const channels = buf.readUInt16LE(fmt + 2);
  const rate = buf.readUInt32LE(fmt + 4);
  const out = Buffer.alloc(44 + dataLen * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataLen * 2, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataLen * 2, 40);
  for (let i = 0; i < dataLen; i++) out.writeInt16LE(MULAW[buf[data + i]], 44 + i * 2);
  return out;
}

const MULAW = Array.from({ length: 256 }, (_, i) => {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const man = u & 0x0f;
  const mag = (((man << 3) + 0x84) << exp) - 0x84;
  return sign ? -mag : mag;
});

/** Remove sound-event tags ("[outro jingle]", "(laughs)") and stray whitespace. */
export function cleanTranscript(t: string): string {
  return t
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .replace(/\((?:[a-z ]{0,30})\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** OpenRouter accepts wav, mp3, flac, m4a, ogg, webm, aac (not "mp4"): iPhone's audio/mp4 is sent as m4a. */
export function openrouterFormat(mime: string): string {
  const f = formatOf(mime);
  return f === 'mp4' ? 'm4a' : f;
}

export function formatOf(mime: string): string {
  if (/mp4|m4a|aac/.test(mime)) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('flac')) return 'flac';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  return 'mp4';
}

export function extOf(mime: string): string {
  const f = formatOf(mime);
  return f === 'mp4' ? 'm4a' : f;
}
