// Shared data model. Everything is stored locally in IndexedDB (see storage/db.ts).

export type School = 'ILA' | 'WSE';
export type Mode = 'class' | 'chat';

export interface ClassSession {
  id: string;
  school: School;
  topic: string;
  mode: Mode;
  startedAt: number;
  endedAt?: number;
  status: 'live' | 'processing' | 'done' | 'failed';
  /** Human-readable progress or error for post-class processing. */
  statusNote?: string;
  /** Set when moved to the bin; restorable for 30 days. */
  deletedAt?: number;
  /** Last time a line or audio chunk arrived (ms). Used to tell a class in progress from one left open. */
  lastActivityAt?: number;
  /** Whether post-class transcription + review generation should run for this class. */
  deepReview: boolean;
}

export interface Answer {
  en: string;
  zh: string;
}

export interface Line {
  id: string;
  sessionId: string;
  /** Milliseconds since the class started. */
  t: number;
  en: string;
  zh?: string;
  /** 'self' = judged to be the user speaking. */
  kind: 'lecture' | 'question' | 'self' | 'pending';
  /** Mode at the time this line was heard (the user can switch between class and conversation mid-class). */
  mode?: Mode;
  /** you = asked to the learner; all = to the group; other = to another classmate (answers still shown, greyed). */
  priority: 'you' | 'all' | 'other' | null;
  questionZh?: string;
  answers?: Answer[];
}

export interface WordInfo {
  word: string;
  ipa: string;
  pos: string;
  zh: string;
  explain: string;
  example: Answer;
  inContext: string;
}

export type ItemType = 'word' | 'phrase' | 'pattern' | 'question' | 'correction' | 'dialogue';

export interface ReviewItem {
  id: string;
  type: ItemType;
  /** The English the user must be able to produce. */
  en: string;
  /** The Chinese prompt shown when practising. */
  zh: string;
  ipa?: string;
  note?: string;
  source: { sessionId?: string; school?: School; date: string; origin: 'class' | 'lookup' | 'ask' | 'import' };
  correctStreak: number;
  lapses: number;
  due: number;
  mastered: boolean;
  createdAt: number;
}

export interface SessionReview {
  sessionId: string;
  createdAt: number;
  summaryZh: string;
  points: { title: string; detailZh: string; examples: string[] }[];
  vocab: { en: string; ipa: string; zh: string; example: string }[];
  questions: { asker: 'teacher' | 'classmate'; en: string; zh: string; answers: Answer[] }[];
  myCorrections: { said: string; better: string; whyZh: string }[];
  dialogues: { titleZh: string; turns: { speaker: string; en: string; zh: string }[] }[];
  transcript: { speaker: string; en: string }[];
}

export interface AudioChunk {
  id: string;
  sessionId: string;
  index: number;
  startedAt: number;
  mime: string;
  blob: Blob;
  transcript?: string;
}
