// Pure text helpers. No DOM, no network — covered by tests/text.test.ts.

/** Split an English utterance into word and non-word tokens so each word can be tapped. */
export function tokenize(sentence: string): { text: string; word: boolean }[] {
  const out: { text: string; word: boolean }[] = [];
  const re = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
  let last = 0;
  for (const m of sentence.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: sentence.slice(last, i), word: false });
    out.push({ text: m[0], word: true });
    last = i + m[0].length;
  }
  if (last < sentence.length) out.push({ text: sentence.slice(last), word: false });
  return out;
}

/** Normalise a word for lookup and de-duplication ("Don’t" -> "don't"). */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/’/g, "'").trim();
}

/** True when the text reads like a question on its own (punctuation or a leading question word). */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.endsWith('?')) return true;
  return /^(what|why|how|where|when|who|which|whose|do|does|did|are|is|was|were|can|could|would|will|have|has|should|may)\b/.test(t);
}

/** Collapse whitespace and trim; returns '' for blank input. */
export function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** mm:ss or h:mm:ss for a duration in milliseconds. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** Local calendar date as YYYY-MM-DD. */
export function localDate(ts: number = Date.now()): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Short random id, good enough for local records. */
export function uid(prefix = ''): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Parse a JSON object out of a model reply that may wrap it in ```json fences or extra prose. */
export function parseJsonLoose<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 返回的内容不是 JSON');
  return JSON.parse(body.slice(start, end + 1)) as T;
}
