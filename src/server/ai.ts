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
  async transcribe(audio: Buffer, mime: string): Promise<string> {
    const format = formatOf(mime);
    return this.withProviders(async (p) => {
      if (p === 'openrouter') {
        const body: Record<string, unknown> = {
          model: this.cfg.models.sttOpenrouter,
          input_audio: { data: audio.toString('base64'), format },
          language: 'en',
        };
        if (this.cfg.sttProviderOptions) body.provider = { options: this.cfg.sttProviderOptions };
        const res = await this.fetchImpl(`${ENDPOINT.openrouter}/audio/transcriptions`, {
          method: 'POST',
          headers: this.headers(p),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw await this.readError(p, res);
        return String(((await res.json()) as { text?: string }).text ?? '');
      }
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `chunk.${format === 'mp4' ? 'm4a' : format}`);
      form.append('model', this.cfg.models.sttOpenai);
      form.append('language', 'en');
      const res = await this.fetchImpl(`${ENDPOINT.openai}/audio/transcriptions`, {
        method: 'POST',
        headers: this.headers(p, false),
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw await this.readError(p, res);
      return String(((await res.json()) as { text?: string }).text ?? '');
    });
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

export function formatOf(mime: string): string {
  if (/mp4|m4a|aac/.test(mime)) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'mp4';
}

export function extOf(mime: string): string {
  const f = formatOf(mime);
  return f === 'mp4' ? 'm4a' : f;
}
