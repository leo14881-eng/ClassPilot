// Decides how prominent a recognised question should be. Pure logic, tested in tests/priority.test.ts.
//
// The AI also returns a target, but the rules here are deterministic and run first:
//   - the user's name or alias anywhere in the sentence  -> 'you'
//   - conversation mode: every question                  -> 'you'
//   - a question right after the user spoke              -> 'you'
//   - a short question addressed with "you/your"         -> 'you'
//   - "anyone / everyone / who can / raise your hand"    -> 'all'
// Otherwise the AI's own judgement is used, falling back to 'all'.

export type Priority = 'you' | 'all';
export type Mode = 'class' | 'chat';

export interface PriorityInput {
  text: string;
  isQuestion: boolean;
  aiTarget?: 'you' | 'all' | 'other' | null;
  names: string[];
  mode: Mode;
  /** Milliseconds since the user's own last line, or null if unknown. */
  msSinceSelf: number | null;
}

const GROUP_RE = /\b(anyone|anybody|everyone|everybody|all of you|who can|who knows|raise your hand|any volunteers?)\b/i;

export function mentionsName(text: string, names: string[]): boolean {
  return names
    .map((n) => n.trim())
    .filter((n) => n.length >= 2)
    .some((n) => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(text));
}

export function questionPriority(input: PriorityInput): Priority | null {
  if (!input.isQuestion) return null;
  const { text } = input;
  if (mentionsName(text, input.names)) return 'you';
  if (input.mode === 'chat') return 'you';
  if (GROUP_RE.test(text)) return 'all';
  if (input.msSinceSelf !== null && input.msSinceSelf < 12_000) return 'you';
  const words = text.trim().split(/\s+/).length;
  if (words <= 9 && /\b(you|your)\b/i.test(text)) return 'you';
  if (input.aiTarget === 'you') return 'you';
  return 'all';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
