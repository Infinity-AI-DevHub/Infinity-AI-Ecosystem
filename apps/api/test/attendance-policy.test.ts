/**
 * The weekday policy.
 *
 * Saturday and Sunday are not working days, so the six-hour minimum is not owed on one.
 * Clocking in on a weekend still records the time — it simply is not measured against a
 * minimum, and a short weekend is not a shortfall.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isWorkingDay, MINIMUM_MINUTES_PER_DAY } from '../src/domains/attendance.js';

test('the working week', async (t) => {
  await t.test('Monday to Friday are working days', () => {
    // 2026-09-07 is a Monday.
    for (const day of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) {
      assert.equal(isWorkingDay(day), true, day);
    }
  });

  await t.test('Saturday and Sunday are not', () => {
    assert.equal(isWorkingDay('2026-09-05'), false);
    assert.equal(isWorkingDay('2026-09-06'), false);
  });

  await t.test('the minimum is six hours', () => {
    assert.equal(MINIMUM_MINUTES_PER_DAY, 360);
  });
});
