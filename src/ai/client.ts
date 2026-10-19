// One entry point for every AI call. Tries OpenRouter first; when its balance is used up
// (see fallback.ts) it marks it exhausted and moves to the OpenAI key, telling the UI once.

import { currentSettings, saveSettings, type Settings } from '../storage/settings';
import { parseJsonLoose } from '../util/text';
import { ApiError, isOutOfCredits, providerOrder, type ProviderName } from './fallback';

export type Purpose = 'live' | 'deep';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const ENDPOINT: Record<ProviderName, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
};

type Notice = (msg: string) => void;
let notice: Notice = () => {};
export function onAiNotice(fn: Notice): void {
  notice = fn;
}

function modelFor(s: Settings, p: ProviderName, purpose: Purpose): string {
  if (purpose === 'live') return p === 'openrouter' ? s.models.liveOpenrouter : s.models.liveOpenai;
  return p === 'openrouter' ? s.models.deepOpenrouter : s.models.deepOpenai;
}

export function headers(p: ProviderName, key: string, json = true): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (json) h['Content-Type'] = 'application/json';
  if (p === 'openrouter') {
    h['HTTP-Referer'] = location.origin;
    h['X-Title'] = 'ClassPilot';
  }
  return h;
}

export async function readError(p: ProviderName, res: Response): Promise<ApiError> {
  let msg = `${res.status}`;
  try {
    const body = await res.json();
    msg = body?.error?.message || JSON.stringify(body).slice(0, 300);
  } catch {
    /* body not JSON */
  }
  return new ApiError(p, res.status, msg);
}

/** Run `call` against providers in order, falling back from OpenRouter to OpenAI when credits run out. */
export async function withProviders<T>(call: (p: ProviderName, key: string) => Promise<T>): Promise<T> {
  const s = currentSettings();
  const order = providerOrder(s.keys, s.openrouterExhausted);
  if (order.length === 0) throw new Error('还没有填写 API Key，请到设置里填写');
  let lastErr: unknown;
  for (const p of order) {
    try {
      return await call(p, s.keys[p]);
    } catch (err) {
      lastErr = err;
      if (isOutOfCredits(err)) {
        await saveSettings({ openrouterExhausted: true });
        notice(s.keys.openai ? 'OpenRouter 余额已用完，已切换到 OpenAI' : 'OpenRouter 余额已用完，请充值或填写 OpenAI Key');
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function chat(messages: ChatMessage[], opts: { purpose: Purpose; json?: boolean; signal?: AbortSignal; temperature?: number }): Promise<string> {
  const s = currentSettings();
  return withProviders(async (p, key) => {
    const body: Record<string, unknown> = {
      model: modelFor(s, p, opts.purpose),
      messages,
      temperature: opts.temperature ?? 0.3,
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    const res = await fetch(`${ENDPOINT[p]}/chat/completions`, {
      method: 'POST',
      headers: headers(p, key),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw await readError(p, res);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('AI 没有返回内容');
    return text;
  });
}

export async function chatJson<T>(messages: ChatMessage[], opts: { purpose: Purpose; signal?: AbortSignal }): Promise<T> {
  const raw = await chat(messages, { ...opts, json: true });
  return parseJsonLoose<T>(raw);
}

export { ENDPOINT };

/** Remaining OpenRouter credit in USD, or null when unknown. */
export async function openrouterBalance(key: string): Promise<{ remaining: number | null; usage: number | null } | null> {
  if (!key) return null;
  try {
    const res = await fetch(`${ENDPOINT.openrouter}/key`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const d = (await res.json())?.data;
    const usage = typeof d?.usage === 'number' ? d.usage : null;
    let remaining: number | null = typeof d?.limit_remaining === 'number' ? d.limit_remaining : null;
    if (remaining === null) {
      const c = await fetch(`${ENDPOINT.openrouter}/credits`, { headers: { Authorization: `Bearer ${key}` } });
      if (c.ok) {
        const cd = (await c.json())?.data;
        if (typeof cd?.total_credits === 'number' && typeof cd?.total_usage === 'number') remaining = cd.total_credits - cd.total_usage;
      }
    }
    return { remaining, usage };
  } catch {
    return null;
  }
}
