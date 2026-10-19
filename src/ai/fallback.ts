// Decides when the OpenRouter balance is exhausted so calls move to the OpenAI key.
// Pure logic, tested in tests/fallback.test.ts.

export type ProviderName = 'openrouter' | 'openai';

export class ApiError extends Error {
  constructor(
    public provider: ProviderName,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** OpenRouter answers 402 when credits run out; some proxies use 403/429 with a credits message. */
export function isOutOfCredits(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.provider !== 'openrouter') return false;
  if (err.status === 402) return true;
  return /insufficient|credit|balance|quota/i.test(err.message) && [400, 403, 429].includes(err.status);
}

/** Order of providers to try, given which keys exist and whether OpenRouter is marked exhausted. */
export function providerOrder(keys: { openrouter: string; openai: string }, openrouterExhausted: boolean): ProviderName[] {
  const order: ProviderName[] = [];
  if (keys.openrouter && !openrouterExhausted) order.push('openrouter');
  if (keys.openai) order.push('openai');
  if (keys.openrouter && openrouterExhausted && !keys.openai) order.push('openrouter');
  return order;
}
