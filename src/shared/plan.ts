// The learning plan to 2027-01-31 (agreed with the learner): 15 weeks in three 5-week phases,
// 10 new words a day (life/travel/hospital 7 + work 3), one scenario a day, a speaking test every Sunday.
// Pure date logic, tested in tests/plan.test.ts.

import { TALK_SCENARIOS, type TalkScenario } from './prompts';

export const PLAN_START = '2026-10-19';
export const PLAN_END = '2027-01-31';
export const WORD_TARGET = 1000;
export const WORDS_PER_DAY = 10;
/** A scored scenario or test counts as passed at this score (0-100). */
export const PASS_SCORE = 70;

export interface Phase {
  n: 1 | 2 | 3;
  titleZh: string;
  start: string;
  end: string;
  /** What the 7 daily life words lean towards in this phase. */
  wordFocus: string;
}

export const PHASES: Phase[] = [
  { n: 1, titleZh: '日常生存', start: '2026-10-19', end: '2026-11-22', wordFocus: 'everyday survival: food and drink, shopping, money, directions, transport, time, weather, home, basic feelings; plus a few emergency health words' },
  { n: 2, titleZh: '旅游 + 沟通', start: '2026-11-23', end: '2026-12-27', wordFocus: 'travel (airport, hotel, tickets, sightseeing) and communication (hobbies, past experiences, opinions, inviting, asking for help)' },
  { n: 3, titleZh: '医院 + 综合', start: '2026-12-28', end: '2027-01-31', wordFocus: 'hospital and health (symptoms, body parts, appointments, medicine, allergies) plus phone calls and longer conversations' },
];

const DAY = 86_400_000;

function utc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function phaseOf(date: string): Phase {
  return PHASES.find((p) => date <= p.end) ?? PHASES[PHASES.length - 1];
}

/** Whole days from `date` to the end of the plan (0 on the last day, negative after). */
export function daysLeft(date: string): number {
  return Math.round((utc(PLAN_END) - utc(date)) / DAY);
}

/** Day number in the plan, 1 on the start date. */
export function dayNumber(date: string): number {
  return Math.round((utc(date) - utc(PLAN_START)) / DAY) + 1;
}

/** Sunday = weekly speaking test day. */
export function isTestDay(date: string): boolean {
  return new Date(utc(date)).getUTCDay() === 0;
}

/** Monday (YYYY-MM-DD) of the week that contains `date`. */
export function weekStart(date: string): string {
  const d = new Date(utc(date));
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(utc(date) - dow * DAY).toISOString().slice(0, 10);
}

/**
 * Today's scenario: the first scenario of the current phase not yet passed (earlier phases' unpassed ones first),
 * otherwise rotate through the phase by day number.
 */
export function scenarioForDay(date: string, passed: Set<string>): TalkScenario {
  const phase = phaseOf(date).n;
  const open = TALK_SCENARIOS.filter((s) => s.phase <= phase && !passed.has(s.id));
  if (open.length) return open[0];
  const inPhase = TALK_SCENARIOS.filter((s) => s.phase === phase);
  return inPhase[(dayNumber(date) - 1 + inPhase.length * 10) % inPhase.length];
}

/** Scenario for this week's Sunday test: one from the current phase, varying by week. */
export function testScenario(date: string): TalkScenario {
  const phase = phaseOf(date).n;
  const pool = TALK_SCENARIOS.filter((s) => s.phase <= phase);
  const week = Math.floor((dayNumber(date) - 1) / 7);
  return pool[(week * 3 + pool.length * 10) % pool.length];
}

/** Rough level label from mastered words and passed scenarios (for motivation, not a formal CEFR test). */
export function levelEstimate(masteredWords: number, scenariosPassed: number, recentTestAvg: number | null): { label: string; noteZh: string } {
  const score = masteredWords / WORD_TARGET * 50 + scenariosPassed / TALK_SCENARIOS.length * 30 + (recentTestAvg ?? 0) / 100 * 20;
  if (score >= 80) return { label: '接近 B1', noteZh: '日常、旅游、看病的基本对话都能应付' };
  if (score >= 55) return { label: 'A2', noteZh: '大部分日常场景能说清楚，继续练长对话' };
  if (score >= 25) return { label: 'A1 → A2', noteZh: '常用场景开始能开口，继续积累单词和场景' };
  return { label: 'A1', noteZh: '起步阶段：每天 10 个词 + 1 个场景，重点是敢开口' };
}
