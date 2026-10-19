// Application logic on the server: live analysis, ask, word lookup, review items, post-class processing.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { questionPriority } from '../shared/priority';
import { askSystem, askUser, liveSystem, liveUser, reviewSystem, reviewUser, TALK_SCENARIOS, talkSystem, talkUser, wordSystem, wordUser } from '../shared/prompts';
import { grade } from '../shared/schedule';
import { mergeUserSettings, nameList, type UserSettings } from '../shared/settings';
import { localDate, looksLikeQuestion, normalizeWord, uid } from '../shared/text';
import type { Answer, ClassSession, Line, ReviewItem, SessionReview, WordInfo } from '../shared/types';
import { extOf, type Ai } from './ai';
import type { Store } from './db';

export interface TalkResult {
  reply: Answer;
  correction: { said: string; better: string; whyZh: string } | null;
  suggestions: Answer[];
}

export interface AskResult {
  answerZh: string;
  say: Answer[];
  words: Answer[];
}

interface LiveResult {
  zh?: string;
  isQuestion?: boolean;
  target?: 'you' | 'all' | 'other' | null;
  isSelf?: boolean;
  questionZh?: string;
  answers?: Answer[];
}

type Generated = Omit<SessionReview, 'sessionId' | 'createdAt' | 'transcript'>;

export class Service {
  private processing = new Set<string>();
  /** Time of the learner's last own line per session, for question priority. */
  private lastSelf = new Map<string, number>();

  constructor(
    private store: Store,
    private ai: Ai,
    private dataDir: string,
    private uploadGraceMs = 45_000,
  ) {
    mkdirSync(join(dataDir, 'audio'), { recursive: true });
  }

  // ---------- settings ----------
  settings(): UserSettings {
    return mergeUserSettings(this.store.kvGet<Partial<UserSettings>>('userSettings'));
  }
  saveSettings(patch: Partial<UserSettings>): UserSettings {
    const next = mergeUserSettings({ ...this.settings(), ...patch, profile: { ...this.settings().profile, ...(patch.profile ?? {}) } });
    this.store.kvSet('userSettings', next);
    return next;
  }

  // ---------- sessions ----------
  createSession(input: Pick<ClassSession, 'school' | 'topic' | 'mode' | 'deepReview'>): ClassSession {
    // A class left open (the user never pressed 下课) is ended when the next one starts.
    for (const old of this.store.sessionsWithStatus('live')) this.endSession(old.id);
    const now = Date.now();
    const s: ClassSession = { id: uid('c'), startedAt: now, lastActivityAt: now, status: 'live', ...input };
    this.store.putSession(s);
    this.saveSettings({ lastSchool: input.school });
    return s;
  }

  endSession(id: string): ClassSession {
    const s = this.mustSession(id);
    if (s.status !== 'live') return s;
    s.endedAt = Date.now();
    s.status = s.deepReview ? 'processing' : 'done';
    s.statusNote = s.deepReview ? '等待整理' : undefined;
    this.store.putSession(s);
    // Give the last audio chunks (still uploading from the phone) a moment to arrive before transcribing.
    if (s.deepReview) setTimeout(() => void this.processClass(id), this.uploadGraceMs).unref?.();
    return s;
  }

  /** Switch between class mode and conversation mode in the middle of a class. */
  setMode(id: string, mode: ClassSession['mode']): ClassSession {
    const s = this.mustSession(id);
    s.mode = mode;
    this.store.putSession(s);
    return s;
  }

  /** Move a class to the bin. Its review items leave the practice queue too (kept aside so a restore brings them back). */
  deleteSession(id: string): ClassSession {
    const s = this.mustSession(id);
    if (s.status === 'live') this.endSession(id);
    const cur = this.mustSession(id);
    cur.deletedAt = Date.now();
    this.store.putSession(cur);
    const taken = this.store.takeItemsForSession(id);
    const kept = this.store.kvGet<ReviewItem[]>(`bin-items:${id}`) ?? [];
    this.store.kvSet(`bin-items:${id}`, [...kept, ...taken]);
    return cur;
  }

  restoreSession(id: string): ClassSession {
    const s = this.mustSession(id);
    delete s.deletedAt;
    this.store.putSession(s);
    this.store.addItems(this.store.kvGet<ReviewItem[]>(`bin-items:${id}`) ?? []);
    this.store.kvSet(`bin-items:${id}`, []);
    return s;
  }

  /** Permanently remove classes that have been in the bin for more than 30 days. */
  purgeDeleted(now = Date.now()): number {
    const old = this.store.deletedSessions().filter((s) => (s.deletedAt ?? now) < now - 30 * 86_400_000);
    for (const s of old) {
      rmSync(join(this.dataDir, 'audio', s.id), { recursive: true, force: true });
      this.store.purgeSession(s.id);
    }
    return old.length;
  }

  mustSession(id: string): ClassSession {
    const s = this.store.getSession(id);
    if (!s) throw new HttpError(404, '找不到这节课');
    return s;
  }

  // ---------- live ----------
  async analyzeUtterance(sessionId: string, input: { id: string; t: number; en: string }): Promise<Line> {
    const session = this.mustSession(sessionId);
    const s = this.settings();
    const pending: Line = { id: input.id, sessionId, t: input.t, en: input.en, kind: 'pending', priority: null, mode: session.mode };
    this.store.putLine(pending);
    this.touch(session);
    const recent = this.store
      .linesFor(sessionId)
      .filter((l) => l.t < input.t)
      .slice(-6)
      .map((l) => (l.kind === 'self' ? `[learner] ${l.en}` : l.en));
    let r: LiveResult = {};
    let error: string | undefined;
    try {
      r = await this.ai.chatJson<LiveResult>(
        [
          { role: 'system', content: liveSystem(s, session.mode, session.topic) },
          { role: 'user', content: liveUser(recent, input.en) },
        ],
        { purpose: 'live' },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const isSelf = !!r.isSelf;
    const isQuestion = !isSelf && (r.isQuestion ?? looksLikeQuestion(input.en));
    const last = this.lastSelf.get(sessionId);
    const priority = questionPriority({
      text: input.en,
      isQuestion,
      aiTarget: r.target ?? null,
      names: nameList(s),
      mode: session.mode,
      msSinceSelf: last === undefined ? null : input.t - last,
    });
    if (isSelf) this.lastSelf.set(sessionId, input.t);
    const line: Line = {
      ...pending,
      zh: r.zh,
      kind: isSelf ? 'self' : isQuestion ? 'question' : 'lecture',
      priority: r.target === 'other' && priority === 'all' ? 'other' : priority,
      questionZh: isQuestion ? r.questionZh : undefined,
      answers: isQuestion ? englishOnly(r.answers).slice(0, 2) : undefined,
    };
    this.store.putLine(line);
    if (error) throw new HttpError(502, error, line);
    return line;
  }

  async ask(question: string, sessionId?: string): Promise<AskResult> {
    const session = sessionId ? this.store.getSession(sessionId) : undefined;
    const recent = sessionId ? this.store.linesFor(sessionId).slice(-10).map((l) => l.en) : [];
    const r = await this.ai.chatJson<Partial<AskResult>>(
      [
        { role: 'system', content: askSystem(this.settings()) },
        { role: 'user', content: askUser(recent, question) },
      ],
      { purpose: 'live' },
    );
    const result: AskResult = { answerZh: r.answerZh ?? '', say: englishOnly(r.say), words: englishOnly(r.words) };
    this.store.addItems([
      ...result.say.map((a) => newItem('pattern', a.en, a.zh, 'ask', session)),
      ...result.words.map((a) => newItem('word', a.en, a.zh, 'ask', session)),
    ]);
    return result;
  }

  async lookupWord(word: string, sentence: string, sessionId?: string): Promise<WordInfo> {
    const session = sessionId ? this.store.getSession(sessionId) : undefined;
    const info = await this.ai.chatJson<WordInfo>(
      [
        { role: 'system', content: wordSystem() },
        { role: 'user', content: wordUser(word, sentence) },
      ],
      { purpose: 'live' },
    );
    this.store.addItems([newItem('word', normalizeWord(info.word || word), info.zh, 'lookup', session, info.ipa, info.example?.en)]);
    return info;
  }

  // ---------- English conversation practice ----------
  async talk(input: { scenarioId?: string; history: { who: 'ai' | 'me'; en: string }[]; said: string }): Promise<TalkResult> {
    const scenario = TALK_SCENARIOS.find((x) => x.id === input.scenarioId) ?? null;
    const r = await this.ai.chatJson<Partial<TalkResult>>(
      [
        { role: 'system', content: talkSystem(this.settings(), scenario) },
        { role: 'user', content: talkUser(input.history.slice(-16), input.said) },
      ],
      { purpose: 'live' },
    );
    const result: TalkResult = {
      reply: r.reply ?? { en: 'Sorry, can you say that again?', zh: '抱歉，能再说一遍吗？' },
      correction: r.correction && r.correction.better && r.correction.better !== r.correction.said ? r.correction : null,
      suggestions: englishOnly(r.suggestions).slice(0, 2),
    };
    if (result.correction) {
      const c = result.correction;
      const item = newItem('correction', c.better, `改正：${c.said}`, 'ask', undefined, undefined, c.whyZh);
      this.store.addItems([item]);
    }
    return result;
  }

  // ---------- review items ----------
  gradeItem(id: string, correct: boolean): ReviewItem {
    const item = this.store.getItem(id);
    if (!item) throw new HttpError(404, '找不到这个复习项');
    const next = grade(item, correct);
    this.store.updateItem(next);
    return next;
  }

  // ---------- audio ----------
  private touch(s: ClassSession): void {
    if (s.status !== 'live') return;
    s.lastActivityAt = Date.now();
    this.store.putSession(s);
  }

  saveAudio(sessionId: string, index: number, startedAt: number, mime: string, body: Buffer): void {
    this.touch(this.mustSession(sessionId));
    const dir = join(this.dataDir, 'audio', sessionId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${String(index).padStart(3, '0')}.${extOf(mime)}`);
    writeFileSync(path, body);
    this.store.putAudio({ id: `${sessionId}-${index}`, sessionId, index, startedAt, mime, path, transcript: null });
  }

  /** Delete recordings older than the retention window. Runs at start-up and every few hours. */
  cleanupAudio(now = Date.now()): number {
    const days = this.settings().keepAudioDays;
    const old = this.store.audioOlderThan(now - days * 86_400_000).filter((a) => this.store.getSession(a.sessionId)?.status !== 'processing');
    for (const a of old) {
      rmSync(a.path, { force: true });
      this.store.deleteAudioRow(a.id);
    }
    return old.length;
  }

  // ---------- post-class ----------
  /** Resume any class left mid-processing (e.g. after a restart). */
  resumeProcessing(): void {
    for (const s of this.store.sessionsWithStatus('processing')) void this.processClass(s.id);
  }

  async processClass(sessionId: string): Promise<void> {
    if (this.processing.has(sessionId)) return;
    this.processing.add(sessionId);
    const session = this.store.getSession(sessionId);
    if (!session) return;
    const set = (status: ClassSession['status'], note?: string) => {
      session.status = status;
      session.statusNote = note;
      this.store.putSession(session);
    };
    try {
      const chunks = this.store.audioFor(sessionId);
      let parts: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (c.transcript === null) {
          set('processing', `转写录音 ${i + 1}/${chunks.length}`);
          c.transcript = await this.ai.transcribe(readFileSync(c.path), c.mime);
          this.store.putAudio(c);
        }
        parts.push(c.transcript);
      }
      const lines = this.store.linesFor(sessionId);
      if (!parts.join('').trim()) parts = lines.map((l) => l.en);
      const transcript = parts.join('\n');
      if (!transcript.trim()) {
        set('done', '这节课没有可整理的内容');
        return;
      }
      set('processing', '整理复习内容');
      const s = this.settings();
      const g = await this.ai.chatJson<Partial<Generated>>(
        [
          { role: 'system', content: reviewSystem(s) },
          { role: 'user', content: reviewUser(transcript, lines.filter((l) => l.kind === 'self').map((l) => l.en), session.topic, session.school) },
        ],
        { purpose: 'deep' },
      );
      const review: SessionReview = {
        sessionId,
        createdAt: Date.now(),
        summaryZh: g.summaryZh ?? '',
        points: g.points ?? [],
        vocab: g.vocab ?? [],
        questions: g.questions ?? [],
        myCorrections: g.myCorrections ?? [],
        dialogues: g.dialogues ?? [],
        transcript: parts
          .flatMap((p) => p.split(/(?<=[.?!])\s+/))
          .filter((x) => x.trim())
          .map((en) => ({ speaker: '', en })),
      };
      this.store.putReview(review);
      // A class deleted while it was still being processed keeps its new items in the bin too.
      if (this.store.getSession(sessionId)?.deletedAt) {
        const kept = this.store.kvGet<ReviewItem[]>(`bin-items:${sessionId}`) ?? [];
        this.store.kvSet(`bin-items:${sessionId}`, [...kept, ...itemsFrom(review, session)]);
      } else {
        this.store.addItems(itemsFrom(review, session));
      }
      if (s.keepAudioDays === 0) {
        for (const c of chunks) {
          rmSync(c.path, { force: true });
          this.store.deleteAudioRow(c.id);
        }
      }
      set('done');
    } catch (e) {
      set('failed', e instanceof Error ? e.message : String(e));
    } finally {
      this.processing.delete(sessionId);
    }
  }
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** Drop English lines the model mixed Chinese into ("China is the English name for 中国."). */
export function englishOnly(list: Answer[] | undefined): Answer[] {
  return (list ?? []).filter((a) => a && typeof a.en === 'string' && a.en.trim() && !CJK.test(a.en));
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: unknown,
  ) {
    super(message);
  }
}

export function newItem(
  type: ReviewItem['type'],
  en: string,
  zh: string,
  origin: ReviewItem['source']['origin'],
  session?: ClassSession,
  ipa?: string,
  note?: string,
): ReviewItem {
  const now = Date.now();
  return {
    id: uid('i'),
    type,
    en: en.trim(),
    zh,
    ipa,
    note,
    source: { sessionId: session?.id, school: session?.school, date: localDate(session?.startedAt ?? now), origin },
    correctStreak: 0,
    lapses: 0,
    due: now,
    mastered: false,
    createdAt: now,
  };
}

export function itemsFrom(r: SessionReview, session: ClassSession): ReviewItem[] {
  const out: ReviewItem[] = [];
  r.vocab.forEach((v) => out.push(newItem('word', v.en, v.zh, 'class', session, v.ipa, v.example)));
  r.points.forEach((p) => p.examples.slice(0, 1).forEach((ex) => out.push(newItem('pattern', ex, p.detailZh, 'class', session, undefined, p.title))));
  r.questions.forEach((q) => {
    const a = q.answers?.[0];
    if (a) out.push(newItem('question', a.en, `${q.zh}（用英文回答）`, 'class', session, undefined, q.en));
  });
  r.myCorrections.forEach((c) => out.push(newItem('correction', c.better, `改正：${c.said}`, 'class', session, undefined, c.whyZh)));
  return out;
}
