import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayNumber, daysLeft, isTestDay, levelEstimate, phaseOf, scenarioForDay, testScenario, weekStart } from '../src/shared/plan';

test('phases and countdown follow the agreed dates', () => {
  assert.equal(phaseOf('2026-10-19').n, 1);
  assert.equal(phaseOf('2026-11-22').n, 1);
  assert.equal(phaseOf('2026-11-23').n, 2);
  assert.equal(phaseOf('2026-12-28').n, 3);
  assert.equal(phaseOf('2027-03-01').n, 3);
  assert.equal(daysLeft('2026-10-19'), 104);
  assert.equal(daysLeft('2027-01-31'), 0);
  assert.equal(dayNumber('2026-10-19'), 1);
  assert.equal(dayNumber('2026-10-25'), 7);
});

test('Sunday is test day; weeks start on Monday', () => {
  assert.ok(isTestDay('2026-10-25'));
  assert.ok(!isTestDay('2026-10-19'));
  assert.equal(weekStart('2026-10-25'), '2026-10-19');
  assert.equal(weekStart('2026-10-26'), '2026-10-26');
});

test('daily scenario: first unpassed of the phase, hospital only in phase 3', () => {
  assert.equal(scenarioForDay('2026-10-19', new Set()).id, 'intro');
  assert.equal(scenarioForDay('2026-10-20', new Set(['intro'])).id, 'restaurant');
  assert.equal(scenarioForDay('2026-10-20', new Set()).phase, 1);
  assert.notEqual(testScenario('2026-10-25').phase, 3);
  assert.equal(scenarioForDay('2026-12-29', new Set()).id, 'intro'); // unpassed earlier scenarios come first
});

test('level estimate grows with progress', () => {
  assert.equal(levelEstimate(0, 0, null).label, 'A1');
  assert.equal(levelEstimate(1000, 28, 90).label, '接近 B1');
});

test('"today" follows Ho Chi Minh City time, not the server clock', async () => {
  const { localDate } = await import('../src/shared/text');
  // 18:30 UTC on Oct 19 is already 01:30 on Oct 20 in Vietnam.
  assert.equal(localDate(Date.UTC(2026, 9, 19, 18, 30)), '2026-10-20');
  assert.equal(localDate(Date.UTC(2026, 9, 19, 16, 59)), '2026-10-19');
});
