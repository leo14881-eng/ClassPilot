// Application logic on the server: live analysis, ask, word lookup, review items, post-class processing.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { questionPriority } from '../shared/priority';
import { askSystem, askUser, type AskTurn, checkSystem, checkUser, liveSystem, liveUser, planWordsSystem, planWordsUser, reviewSystem, reviewUser, scoreSystem, scoreUser, TALK_SCENARIOS, talkSystem, talkUser, wordSystem, wordUser } from '../shared/prompts';
import { dayNumber, daysLeft, isTestDay, levelEstimate, PASS_SCORE, phaseOf, scenarioForDay, testScenario, weekStart, WORD_TARGET, WORDS_PER_DAY } from '../shared/plan';
import { grade } from '../shared/schedule';
import { mergeUserSettings, nameList, type UserSettings } from '../shared/settings';
import { localDate, looksLikeQuestion, normalizeWord, uid } from '../shared/text';
import type { Answer, ClassSession, Line, PlanDay, PlanWord, ReviewItem, Score, SessionReview, WordInfo } from '../shared/types';
import { extOf, type Ai } from './ai';
import type { Store } from './db';

export interface TalkResult {
  reply: Answer;
  correction: { said: string; better: string; whyZh: string } | null;
  suggestions: Answer[];
}

export interface PlanStatus {
  date: string;
  dayNumber: number;
  daysLeft: number;
  phase: { n: number; titleZh: string; start: string; end: string };
  words: (PlanWord & { itemId?: string; correctStreak: number; mastered: boolean })[];
  dueCount: number;
  scenario: { id: string; titleZh: string; best: number | null; practicedToday: boolean };
  test: { today: boolean; scenarioId: string; titleZh: string; doneThisWeek: Score | null };
  progress: { masteredWords: number; wordTarget: number; scenariosPassed: number; scenarioTotal: number; level: { label: string; noteZh: string } };
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

  async ask(question: string, sessionId?: string, history: AskTurn[] = []): Promise<AskResult> {
    const session = sessionId ? this.store.getSession(sessionId) : undefined;
    const recent = sessionId ? this.store.linesFor(sessionId).slice(-10).map((l) => l.en) : [];
    const chat = history.slice(-6).map((t) => ({ q: String(t.q ?? '').slice(0, 500), a: String(t.a ?? '').slice(0, 800) }));
    const r = await this.ai.chatJson<Partial<AskResult>>(
      [
        { role: 'system', content: askSystem(this.settings()) },
        { role: 'user', content: askUser(recent, question, chat) },
      ],
      { purpose: 'smart' },
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
      { purpose: 'smart' },
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
      { purpose: 'smart' },
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

  // ---------- daily plan ----------
  private planInFlight = new Map<string, Promise<PlanDay>>();

  /** Today's plan day, generating the 10 new words once (and adding them to review). */
  async planDay(date = localDate()): Promise<PlanDay> {
    const saved = this.store.kvGet<PlanDay>(`plan:${date}`);
    if (saved) return saved;
    const running = this.planInFlight.get(date);
    if (running) return running;
    const p = this.generatePlanDay(date).finally(() => this.planInFlight.delete(date));
    this.planInFlight.set(date, p);
    return p;
  }

  private async generatePlanDay(date: string): Promise<PlanDay> {
    const knownSet = new Set(this.store.allItems().filter((i) => i.type === 'word').map((i) => normalizeWord(i.en)));
    const known = [...knownSet].slice(-600);
    const r = await this.ai.chatJson<{ words?: PlanWord[] }>(
      [
        { role: 'system', content: planWordsSystem() },
        { role: 'user', content: planWordsUser(phaseOf(date).wordFocus, known) },
      ],
      { purpose: 'smart' },
    );
    const seen = new Set<string>();
    const words = (r.words ?? [])
      .filter((w) => w && typeof w.en === 'string' && w.en.trim() && !CJK.test(w.en))
      .map((w) => ({ ...w, en: w.en.trim(), category: (['life', 'travel', 'hospital', 'work'] as const).includes(w.category) ? w.category : 'life' }))
      .filter((w) => {
        const k = normalizeWord(w.en);
        if (knownSet.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, WORDS_PER_DAY);
    if (words.length < 5) throw new HttpError(502, '今天的新词没有生成成功，请稍后再试');
    const day: PlanDay = { date, words, createdAt: Date.now() };
    this.store.kvSet(`plan:${date}`, day);
    // New words are studied today and first tested tomorrow (midnight in Ho Chi Minh City, UTC+7).
    const tomorrow = Date.parse(`${date}T00:00:00+07:00`) + 86_400_000;
    this.store.addItems(words.map((w) => ({ ...newItem('word', w.en, w.zh, 'plan', undefined, w.ipa, w.example), due: tomorrow })));
    return day;
  }

  scores(): Score[] {
    return (this.store.kvGet<Score[]>('scores') ?? []).sort((a, b) => b.createdAt - a.createdAt);
  }

  async planStatus(date = localDate()): Promise<PlanStatus> {
    const day = await this.planDay(date);
    const items = this.store.allItems();
    const byWord = new Map(items.filter((i) => i.type === 'word').map((i) => [normalizeWord(i.en), i]));
    const scores = this.scores();
    const passed = new Set(scores.filter((x) => x.pass).map((x) => x.scenarioId));
    const scen = scenarioForDay(date, passed);
    const best = scores.filter((x) => x.scenarioId === scen.id).reduce<number | null>((m, x) => (m === null || x.total > m ? x.total : m), null);
    const ts = testScenario(date);
    const week = weekStart(date);
    const doneThisWeek = scores.find((x) => x.kind === 'test' && weekStart(x.date) === week) ?? null;
    const masteredWords = items.filter((i) => i.type === 'word' && i.mastered).length;
    const recentTests = scores.filter((x) => x.kind === 'test').slice(0, 3);
    const testAvg = recentTests.length ? recentTests.reduce((a, x) => a + x.total, 0) / recentTests.length : null;
    const ph = phaseOf(date);
    return {
      date,
      dayNumber: dayNumber(date),
      daysLeft: daysLeft(date),
      phase: { n: ph.n, titleZh: ph.titleZh, start: ph.start, end: ph.end },
      words: day.words.map((w) => {
        const it = byWord.get(normalizeWord(w.en));
        return { ...w, itemId: it?.id, correctStreak: it?.correctStreak ?? 0, mastered: it?.mastered ?? false };
      }),
      dueCount: this.store.dueItems(Date.now(), 1000).length,
      scenario: { id: scen.id, titleZh: scen.titleZh, best, practicedToday: scores.some((x) => x.scenarioId === scen.id && x.date === date) },
      test: { today: isTestDay(date), scenarioId: ts.id, titleZh: ts.titleZh, doneThisWeek },
      progress: {
        masteredWords,
        wordTarget: WORD_TARGET,
        scenariosPassed: passed.size,
        scenarioTotal: TALK_SCENARIOS.length,
        level: levelEstimate(masteredWords, passed.size, testAvg),
      },
    };
  }

  /** Score a finished conversation (scenario practice or Sunday test) and keep the result. */
  async scoreTalk(input: { scenarioId?: string; kind: 'scenario' | 'test'; history: { who: 'ai' | 'me'; en: string }[] }): Promise<Score> {
    const learnerTurns = input.history.filter((t) => t.who === 'me').length;
    if (learnerTurns < 3) throw new HttpError(400, '至少说 3 句才能打分');
    const scenario = TALK_SCENARIOS.find((x) => x.id === input.scenarioId) ?? null;
    const r = await this.ai.chatJson<Partial<Score>>(
      [
        { role: 'system', content: scoreSystem(this.settings(), scenario, input.kind) },
        { role: 'user', content: scoreUser(input.history.slice(-40)) },
      ],
      { purpose: 'smart' },
    );
    const n = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const total = n(r.total ?? (n(r.understanding) * 0.3 + n(r.grammar) * 0.25 + n(r.vocabulary) * 0.2 + n(r.fluency) * 0.25));
    const score: Score = {
      id: uid('s'),
      kind: input.kind,
      scenarioId: scenario?.id ?? 'free',
      date: localDate(),
      createdAt: Date.now(),
      total,
      grammar: n(r.grammar),
      vocabulary: n(r.vocabulary),
      fluency: n(r.fluency),
      understanding: n(r.understanding),
      pass: total >= PASS_SCORE,
      learnerTurns,
      commentZh: String(r.commentZh ?? ''),
      strengthsZh: Array.isArray(r.strengthsZh) ? r.strengthsZh.map(String).slice(0, 3) : [],
      improveZh: Array.isArray(r.improveZh) ? r.improveZh.map(String).slice(0, 4) : [],
    };
    this.store.kvSet('scores', [score, ...(this.store.kvGet<Score[]>('scores') ?? [])].slice(0, 500));
    return score;
  }

  // ---------- review items ----------
  /** Judge a typed or spoken answer to a review item. Does not grade; the client grades after showing the result. */
  /** A few seconds of the learner speaking (practice answer, conversation turn, question). */
  /**
   * A few seconds of the learner speaking. Practice answers in English are transcribed by two models in parallel
   * (`alts` = the second model's text when different), so one recognizer's mistake does not fail a correct answer.
   */
  async speechToText(audio: Buffer, mime: string, language: 'en' | 'zh', opts: { live?: boolean; second?: boolean; info?: string; model?: string } = {}): Promise<{ text: string; alts: string[] }> {
    if (audio.length < 1000) return { text: '', alts: [] };
    const t0 = Date.now();
    const model = opts.model && /^(or|oa):[\w./-]{2,80}$/.test(opts.model) ? opts.model : undefined;
    const use = language === 'zh' ? 'zh' : 'en';
    // The second opinion never holds up the answer by more than 4 s.
    const secondP = opts.second && use === 'en' && !model ? this.ai.transcribe(audio, mime, { use: 'en2' }).catch(() => '') : Promise.resolve('');
    const first = await this.ai.transcribe(audio, mime, { use, model });
    const second = await Promise.race([secondP, new Promise<string>((r) => setTimeout(() => r(''), 4000))]);
    const text = dropHallucination(first);
    const alt = dropHallucination(second);
    const alts = alt && alt.toLowerCase() !== text.toLowerCase() ? [alt] : [];
    this.logVoice({ at: t0, ms: Date.now() - t0, language, live: !!opts.live, hint: alts.join(' | ').slice(0, 120), text, bytes: audio.length, mime, info: (opts.info ?? '').slice(0, 200) }, opts.live ? null : audio, mime);
    return { text: text || alt, alts: text ? alts : [] };
  }

  /** Recent speech-to-text results (diagnosis of "it heard me wrong"). Practice clips are kept for the last 40. */
  voiceLog(): VoiceLogEntry[] {
    return this.store.kvGet<VoiceLogEntry[]>('voicelog') ?? [];
  }

  voiceClip(name: string): { body: Buffer; mime: string } | null {
    if (!/^[\w-]+\.(wav|m4a|webm|ogg)$/.test(name)) return null;
    const path = join(this.dataDir, 'voicelog', name);
    try {
      return { body: readFileSync(path), mime: name.endsWith('.wav') ? 'audio/wav' : 'audio/mp4' };
    } catch {
      return null;
    }
  }

  private logVoice(e: VoiceLogEntry, audio: Buffer | null, mime: string): void {
    try {
      if (audio) {
        const dir = join(this.dataDir, 'voicelog');
        mkdirSync(dir, { recursive: true });
        e.clip = `${e.at}-${Math.random().toString(36).slice(2, 6)}.${extOf(mime)}`;
        writeFileSync(join(dir, e.clip), audio);
      }
      const log = [e, ...this.voiceLog()];
      const keep = log.slice(0, 200);
      // Only the newest 40 clips are kept on disk.
      log.filter((x) => x.clip).slice(40).forEach((x) => {
        rmSync(join(this.dataDir, 'voicelog', x.clip!), { force: true });
        delete x.clip;
      });
      this.store.kvSet('voicelog', keep);
    } catch (err) {
      console.warn('[voice] log failed', err);
    }
  }

  private logCheck(entry: Record<string, unknown>): void {
    const log = [entry, ...(this.store.kvGet<Record<string, unknown>[]>('checklog') ?? [])].slice(0, 200);
    this.store.kvSet('checklog', log);
  }

  checkLog(): Record<string, unknown>[] {
    return this.store.kvGet<Record<string, unknown>[]>('checklog') ?? [];
  }

  async checkAnswer(id: string, answer: string, spoken = false, alts: string[] = []): Promise<CheckResult> {
    const item = this.store.getItem(id);
    if (!item) throw new HttpError(404, '找不到这个复习项');
    return this.judge(item, answer, spoken, true, alts);
  }

  /** Same judging for any expected answer, without a review item (diagnostics and tests; nothing is saved). */
  async checkText(expected: { type: ReviewItem['type']; en: string; zh: string }, answer: string, spoken = false, alts: string[] = []): Promise<CheckResult> {
    return this.judge(expected, answer, spoken, false, alts);
  }

  private async judge(item: Pick<ReviewItem, 'type' | 'en' | 'zh'>, answer: string, spoken: boolean, log = true, alts: string[] = []): Promise<CheckResult> {
    const said = answer.trim();
    // Spoken answers may come with a second recognizer's version: correct if either is.
    const heard = [said, ...(spoken ? alts.map((a) => String(a).trim()).filter(Boolean).slice(0, 2) : [])].filter(Boolean);
    const done = (r: CheckResult) => {
      if (log) this.logCheck({ at: Date.now(), expected: item.en, type: item.type, answer: heard.join(' | '), spoken, ...r });
      return r;
    };
    if (!heard.length) return done({ correct: false, feedbackZh: '没有作答', better: item.en });
    if (heard.some((h) => sameAnswer(h, item.en))) return done({ correct: true, feedbackZh: '完全正确！', better: '' });
    // Spoken: the recognizer wrote words that sound the same with a Chinese accent (word count and tense must match).
    if (spoken && heard.some((h) => soundsAlike(h, item.en) || accentAlike(h, item.en) || sentenceAlike(h, item.en))) {
      return done({ correct: true, feedbackZh: '听懂了，说对了！发音再清楚一点会更好。', better: '' });
    }
    const r = await this.ai.chatJson<Partial<CheckResult>>(
      [
        { role: 'system', content: checkSystem() },
        { role: 'user', content: checkUser(item, heard.map((h) => h.slice(0, 300)), spoken) },
      ],
      { purpose: spoken ? 'smart' : 'live' },
    );
    const correct = r.correct === true;
    const better = typeof r.better === 'string' && !CJK.test(r.better) ? r.better.trim() : '';
    return done({ correct, feedbackZh: r.feedbackZh?.trim() || (correct ? '对了！' : '不太对'), better: correct ? '' : better || item.en });
  }

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
          c.transcript = await this.ai.transcribe(readFileSync(c.path), c.mime, { use: 'record' });
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

/** Whisper-style phantom text heard in silence or noise. */
function dropHallucination(text: string): string {
  const t = text.trim();
  return /^(thank you( (so much|very much))?( for watching)?|thanks for watching|you|bye|please subscribe.*|subtitles by.*|.*amara\.org.*)[.!]?$/i.test(t) ? '' : t;
}

export interface VoiceLogEntry {
  at: number;
  ms: number;
  language: string;
  live: boolean;
  hint: string;
  text: string;
  bytes: number;
  mime: string;
  info: string;
  clip?: string;
}

export interface CheckResult {
  correct: boolean;
  feedbackZh: string;
  better: string;
}

/**
 * Sound skeleton of a word for Chinese-accented speech: consonants only, with the pairs Chinese speakers
 * (and the recognizer hearing them) mix up merged: r/l, n/ng, b/p, g/k/c/ch, t/d/th, s/z/sh, v/w.
 * "rain", "lane", "Rhine", "Ren" → "Ln";  "meeting", "mitting", "meat in" → "mTN".
 */
export function soundKey(text: string, stripPlural = true): string {
  let x = text.toLowerCase().replace(/[^a-z]+/g, '');
  x = x
    .replace(/ph/g, 'f')
    .replace(/th/g, 'd')
    .replace(/sh|ti(?=on)/g, 's')
    .replace(/ch|ck|q/g, 'k')
    .replace(/ng/g, 'n')
    .replace(/gh/g, '')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/[aeiouyh]/g, '')
    .replace(/[rl]/g, 'L')
    .replace(/[bp]/g, 'P')
    .replace(/[gkcx]/g, 'K')
    .replace(/[td]/g, 'T')
    .replace(/[sz]/g, 'S')
    .replace(/[vw]/g, 'W')
    .replace(/(.)\1+/g, '$1');
  return stripPlural ? x.replace(/S$/, '') : x; // plural -s (single words only)
}

/** Base and past forms that differ only in a vowel: a recognizer slip there would hide a real tense mistake. */
const TENSE_PAIRS = new Set(
  'find found|run ran|sit sat|come came|begin began|drink drank|swim swam|get got|give gave|write wrote|ride rode|speak spoke|take took|eat ate|sing sang|ring rang|win won|meet met|read read|feel felt|keep kept|sleep slept|leave left|lose lost|fall fell|hold held|know knew|grow grew|throw threw|draw drew|wear wore|tear tore|bear bore|swear swore|steal stole|choose chose|freeze froze|wake woke|break broke|forget forgot|shine shone|stick stuck|dig dug|hang hung|bite bit|hide hid|slide slid'
    .split('|')
    .flatMap((p) => {
      const [a, b] = p.split(' ');
      return [`${a} ${b}`, `${b} ${a}`];
    }),
);

const CONTRACT: [RegExp, string][] = [
  [/\b(i)'m\b/g, '$1 am'],
  [/\b(\w+)'re\b/g, '$1 are'],
  [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(\w+)'d\b/g, '$1 would'],
  [/\bcan't\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\b(\w+)n't\b/g, '$1 not'],
];

function words(text: string): string[] {
  let x = text.toLowerCase().replace(/[’‘]/g, "'");
  for (const [re, to] of CONTRACT) x = x.replace(re, to);
  return x.replace(/[^a-z' ]+/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
}

/**
 * Spoken sentence that matches the expected one word for word, where each differing word only differs the way a
 * Chinese accent / the recognizer changes it (same sound skeleton). Strict: same number of words, no tense changes
 * (find/found), plural/3rd-person -s must be there.
 */
export function sentenceAlike(said: string, expected: string): boolean {
  const a = words(said);
  const b = words(expected);
  if (a.length < 2 || a.length !== b.length) return false;
  return b.every((w, i) => {
    const h = a[i];
    if (h === w) return true;
    if (TENSE_PAIRS.has(`${h} ${w}`)) return false;
    const kh = soundKey(h, false);
    const kw = soundKey(w, false);
    return kw.length > 0 && kh === kw;
  });
}

/** Spoken single word / two-word phrase whose sound skeleton matches the expected one. */
export function accentAlike(said: string, expected: string): boolean {
  if (expected.trim().split(/\s+/).length > 2) return false;
  const a = soundKey(said);
  const b = soundKey(expected);
  return a.length > 0 && a === b;
}

/** Spoken word that differs from the expected one only by recognizer-level noise (≤ ~20% of letters). */
export function soundsAlike(said: string, expected: string): boolean {
  // Only for single words / two-word phrases with the same number of words: a missing word is never "alike".
  const n = (x: string) => x.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const a = n(said);
  const b = n(expected);
  if (!a || !b || b.split(' ').length > 2 || a.split(' ').length !== b.split(' ').length) return false;
  const d = levenshtein(a, b);
  return d <= Math.max(1, Math.floor(b.length * 0.2));
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Same answer ignoring case, punctuation, extra spaces and common contractions. */
export function sameAnswer(a: string, b: string): boolean {
  const norm = (x: string) =>
    x
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/\b(i)'m\b/g, '$1 am')
      .replace(/\b(\w+)'re\b/g, '$1 are')
      .replace(/\b(\w+)'s\b/g, '$1 is')
      .replace(/\b(\w+)'ll\b/g, '$1 will')
      .replace(/\b(\w+)'ve\b/g, '$1 have')
      .replace(/\bcan't\b/g, 'cannot')
      .replace(/\b(\w+)n't\b/g, '$1 not')
      .replace(/[^a-z0-9' ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return norm(a) !== '' && norm(a) === norm(b);
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
