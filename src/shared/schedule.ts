// Review scheduling rules, migrated from the existing training system:
//   - a correct answer extends the interval; three correct in a row = mastered
//   - a wrong answer resets the streak and makes the item due again immediately (retest)
// Pure logic, tested in tests/schedule.test.ts.

export const MASTERY_STREAK = 3;
const DAY = 24 * 60 * 60 * 1000;
/** Days until the next review after the Nth consecutive correct answer. */
const INTERVALS_DAYS = [1, 3, 7];

export interface Schedulable {
  correctStreak: number;
  due: number;
  mastered: boolean;
  lapses: number;
}

export function grade<T extends Schedulable>(item: T, correct: boolean, now = Date.now()): T {
  if (!correct) {
    return { ...item, correctStreak: 0, mastered: false, due: now, lapses: item.lapses + 1 };
  }
  const streak = item.correctStreak + 1;
  const mastered = streak >= MASTERY_STREAK;
  const days = INTERVALS_DAYS[Math.min(streak - 1, INTERVALS_DAYS.length - 1)];
  return { ...item, correctStreak: streak, mastered, due: now + days * DAY };
}

export function isDue(item: Schedulable, now = Date.now()): boolean {
  return !item.mastered && item.due <= now;
}

/** Due items first by due time; items with more lapses (recurring mistakes) come earlier on ties. */
export function dueQueue<T extends Schedulable>(items: T[], now = Date.now()): T[] {
  return items.filter((i) => isDue(i, now)).sort((a, b) => a.due - b.due || b.lapses - a.lapses);
}
