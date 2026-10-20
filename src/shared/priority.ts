// Decides how prominent a recognised question should be. Pure logic, tested in tests/priority.test.ts.
//
// The AI also returns a target, but the rules here are deterministic and run first:
//   - the user's name or alias anywhere in the sentence  -> 'you'
//   - conversation mode: every question                  -> 'you'
//   - a question right after the user spoke              -> 'you'
//   - a short question addressed with "you/your"         -> 'you'  (unless it opens by naming someone else —
//     "Mike, …", "Professor, …" — or the AI heard it asked to another person: then 'other')
//   - "anyone / everyone / who can / raise your hand"    -> 'all'
// Otherwise the AI's own judgement is used, falling back to 'all'.

export type Priority = 'you' | 'all' | 'other';
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
  const other = addressesSomeoneElse(text, input.names);
  if (other) return 'other';
  const words = text.trim().split(/\s+/).length;
  if (words <= 9 && /\b(you|your)\b/i.test(text) && input.aiTarget !== 'other') return 'you';
  if (input.aiTarget === 'you') return 'you';
  return input.aiTarget === 'other' ? 'other' : 'all';
}

const NOT_A_NAME = new Set(
  'okay ok yeah yes no uh um oh so well now and but right alright all hi hey sorry please good great nice thanks thank wait look listen next first then also hmm ah er like actually anyway'.split(' '),
);

/** "Mike, is this …", "Professor, did you …": the question opens by calling another person. */
export function addressesSomeoneElse(text: string, names: string[]): boolean {
  const m = text.match(/^\s*(?:(?:okay|ok|yeah|so|uh|um|oh|and|now|well)[,.]?\s+)*([a-z]+)\s*,/i);
  if (!m) return false;
  const word = m[1].toLowerCase();
  if (NOT_A_NAME.has(word)) return false;
  if (names.some((n) => n.trim().toLowerCase() === word)) return false;
  const titles = ['professor', 'teacher', 'sir', 'madam', 'miss', 'mister', 'mr', 'mrs', 'ms'];
  return titles.includes(word) || /^[A-Z]/.test(m[1]);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
