/**
 * On-call rotation arithmetic: whose shift it is, across weeks, handoff times, overrides
 * and a daylight-saving change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { onCallAt, rotationShiftAt, upcomingShifts, type RotationSchedule } from '../src/core/oncall.js';

const weekly: RotationSchedule = { timezone: 'UTC', rotation: 'weekly', handoffMinute: 540, rotationStart: '2026-09-07', members: ['ana', 'ben', 'cy'] };

describe('on-call rotation', () => {
  it('walks the member list one week at a time from the start date and handoff time', () => {
    assert.equal(rotationShiftAt(weekly, new Date('2026-09-07T08:59:00Z')), null, 'nobody before the rotation starts');
    assert.equal(rotationShiftAt(weekly, new Date('2026-09-07T09:00:00Z'))!.userId, 'ana');
    assert.equal(rotationShiftAt(weekly, new Date('2026-09-14T08:59:00Z'))!.userId, 'ana');
    assert.equal(rotationShiftAt(weekly, new Date('2026-09-14T09:00:00Z'))!.userId, 'ben');
    assert.equal(rotationShiftAt(weekly, new Date('2026-09-28T12:00:00Z'))!.userId, 'ana', 'wraps around');
  });

  it('keeps the handoff at local time across a daylight-saving change', () => {
    const london: RotationSchedule = { timezone: 'Europe/London', rotation: 'daily', handoffMinute: 540, rotationStart: '2026-10-24', members: ['ana', 'ben'] };
    // 09:00 BST on Saturday is 08:00Z; after the change on Sunday, 09:00 GMT is 09:00Z.
    assert.equal(rotationShiftAt(london, new Date('2026-10-24T08:00:00Z'))!.userId, 'ana');
    const monday = rotationShiftAt(london, new Date('2026-10-26T08:30:00Z'))!;
    assert.equal(monday.userId, 'ben', 'still Sunday\'s shift until 09:00 GMT');
    assert.equal(monday.endsAt.toISOString(), '2026-10-26T09:00:00.000Z');
  });

  it('lets an override win, the most recent one first', () => {
    const at = new Date('2026-09-15T12:00:00Z');
    const overrides = [
      { userId: 'dee', startsAt: new Date('2026-09-15T00:00:00Z'), endsAt: new Date('2026-09-16T00:00:00Z'), createdAt: new Date('2026-09-01') },
      { userId: 'eve', startsAt: new Date('2026-09-15T10:00:00Z'), endsAt: new Date('2026-09-15T14:00:00Z'), createdAt: new Date('2026-09-02') },
    ];
    assert.equal(onCallAt(weekly, overrides, at)!.userId, 'eve');
    assert.equal(onCallAt(weekly, overrides, new Date('2026-09-15T15:00:00Z'))!.userId, 'dee');
    assert.equal(onCallAt(weekly, overrides, new Date('2026-09-16T01:00:00Z'))!.userId, 'ben');
  });

  it('lists upcoming shifts in order', () => {
    const shifts = upcomingShifts(weekly, [], new Date('2026-09-10T00:00:00Z'), 3);
    assert.deepEqual(shifts.map((s) => s.userId), ['ana', 'ben', 'cy']);
    assert.equal(shifts[1]!.startsAt.toISOString(), '2026-09-14T09:00:00.000Z');
  });
});
