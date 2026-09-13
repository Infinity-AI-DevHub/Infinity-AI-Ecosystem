/**
 * SLA business-hours arithmetic. These are the cases that go wrong in practice: a target
 * that runs over a weekend, a holiday, a desk in a non-UTC timezone, and a daylight-saving
 * change in the middle of a window.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addBusinessMinutes, businessMinutesBetween, zonedToInstant, type Schedule } from '../src/core/business-hours.js';

const weekdays = (timezone: string, holidays: string[] = []): Schedule => ({
  timezone,
  days: { 1: [540, 1020], 2: [540, 1020], 3: [540, 1020], 4: [540, 1020], 5: [540, 1020] },
  holidays,
});

describe('business hours', () => {
  it('carries a target from Friday evening into Monday', () => {
    // Friday 2026-09-18 16:00 UTC, 4 business hours: 1h Friday, 3h Monday -> Monday 12:00.
    const due = addBusinessMinutes(new Date('2026-09-18T16:00:00Z'), 240, weekdays('UTC'));
    assert.equal(due.toISOString(), '2026-09-21T12:00:00.000Z');
  });

  it('starts counting at opening time when raised overnight', () => {
    const due = addBusinessMinutes(new Date('2026-09-15T02:00:00Z'), 30, weekdays('UTC'));
    assert.equal(due.toISOString(), '2026-09-15T09:30:00.000Z');
  });

  it('skips holidays', () => {
    const due = addBusinessMinutes(new Date('2026-09-18T16:00:00Z'), 240, weekdays('UTC', ['2026-09-21']));
    assert.equal(due.toISOString(), '2026-09-22T12:00:00.000Z');
  });

  it('uses the calendar timezone, not the server clock', () => {
    // Colombo is UTC+05:30. 09:00 local on Monday 2026-09-14 is 03:30 UTC.
    const due = addBusinessMinutes(new Date('2026-09-14T00:00:00Z'), 60, weekdays('Asia/Colombo'));
    assert.equal(due.toISOString(), '2026-09-14T04:30:00.000Z');
  });

  it('follows the wall clock across a daylight-saving change', () => {
    // London moves from BST (UTC+1) to GMT on Sunday 2026-10-25. Opening is 09:00 local
    // either side: 08:00 UTC on the Friday, 09:00 UTC on the Monday.
    const london = weekdays('Europe/London');
    assert.equal(new Date(zonedToInstant(2026, 10, 23, 540, 'Europe/London')).toISOString(), '2026-10-23T08:00:00.000Z');
    assert.equal(new Date(zonedToInstant(2026, 10, 26, 540, 'Europe/London')).toISOString(), '2026-10-26T09:00:00.000Z');
    const due = addBusinessMinutes(new Date('2026-10-23T15:00:00Z'), 120, london); // Fri 16:00 BST, 1h left
    assert.equal(due.toISOString(), '2026-10-26T10:00:00.000Z'); // Mon 10:00 GMT
  });

  it('measures open minutes between two instants for pauses', () => {
    const s = weekdays('UTC');
    assert.equal(businessMinutesBetween(new Date('2026-09-18T16:00:00Z'), new Date('2026-09-21T10:00:00Z'), s), 120);
    assert.equal(businessMinutesBetween(new Date('2026-09-19T10:00:00Z'), new Date('2026-09-20T10:00:00Z'), s), 0);
    assert.equal(businessMinutesBetween(new Date('2026-09-21T10:00:00Z'), new Date('2026-09-21T09:00:00Z'), s), 0);
  });

  it('falls back to wall-clock time for a calendar that is never open', () => {
    const closed: Schedule = { timezone: 'UTC', days: {}, holidays: [] };
    assert.equal(addBusinessMinutes(new Date('2026-09-18T16:00:00Z'), 60, closed).toISOString(), '2026-09-18T17:00:00.000Z');
  });
});
