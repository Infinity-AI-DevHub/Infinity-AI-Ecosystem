/**
 * The dates a reminder turns on, and where it goes next.
 *
 * All the ways a reminder can be wrong are date arithmetic: a subscription that drifts a
 * few days every month, a renewal that lands on the 3rd of March because February is
 * short, a lead-in that starts the nagging on the wrong day. Each is quiet — the
 * reminder still arrives, just not when it should — so each is asserted directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { catchUp, nextDue, remindFrom } from '../src/domains/reminders.js';

describe('reminder dates', () => {
  it('starts reminding the right number of days early', () => {
    // "I'll do that work on Friday and want prodding from Tuesday."
    assert.equal(remindFrom('2026-09-18', 3), '2026-09-15');
    assert.equal(remindFrom('2026-09-18', 0), '2026-09-18');
  });

  it('steps a lead-in back across a month boundary', () => {
    assert.equal(remindFrom('2026-03-02', 5), '2026-02-25');
  });

  it('repeats monthly on the same day', () => {
    // The Claude subscription on the 4th.
    assert.equal(nextDue('2026-09-04', 'monthly'), '2026-10-04');
    assert.equal(nextDue('2026-12-04', 'monthly'), '2027-01-04');
  });

  it('clamps a month-end subscription instead of letting it drift', () => {
    // Billed on the 31st: February has no 31st, and rolling over to 3 March would move
    // the reminder permanently — every later month would be wrong too.
    assert.equal(nextDue('2026-01-31', 'monthly'), '2026-02-28');
    assert.equal(nextDue('2026-03-31', 'monthly'), '2026-04-30');
    // A leap year still gets its 29th.
    assert.equal(nextDue('2028-01-31', 'monthly'), '2028-02-29');
  });

  it('repeats yearly for a domain or server renewal', () => {
    assert.equal(nextDue('2026-03-14', 'yearly'), '2027-03-14');
    // 29 February renews on the 28th, not the 1st of March.
    assert.equal(nextDue('2028-02-29', 'yearly'), '2029-02-28');
  });

  it('honours an interval', () => {
    assert.equal(nextDue('2026-09-04', 'monthly', 3), '2026-12-04');
    assert.equal(nextDue('2026-09-04', 'weekly', 2), '2026-09-18');
    assert.equal(nextDue('2026-09-04', 'yearly', 2), '2028-09-04');
  });

  it('has no next date for a one-off', () => {
    assert.equal(nextDue('2026-09-04', 'none'), null);
  });

  it('catches a neglected repeat up to the future in one step', () => {
    // Three months unticked: the next date should be the next one due, not tomorrow's
    // notification walking forward a month a day until it catches up.
    const next = catchUp('2026-06-04', 'monthly', 1, '2026-09-12');
    assert.equal(next, '2026-10-04');
  });

  it('leaves a one-off alone when catching up', () => {
    assert.equal(catchUp('2026-01-01', 'none', 1, '2026-09-12'), '2026-01-01');
  });

  it('cannot spin on a repeat that does not advance', () => {
    // A guard, not a scenario: a corrupt row must not hang the scheduler.
    const started = Date.now();
    catchUp('2020-01-01', 'daily', 1, '2026-09-12');
    assert.ok(Date.now() - started < 1000);
  });
});
