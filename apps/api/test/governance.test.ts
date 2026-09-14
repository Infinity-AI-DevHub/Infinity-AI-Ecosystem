/**
 * Quiz marking, certification expiry, temporary access end dates and who reviews a grant.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { certificationExpiry, markQuiz } from '../src/domains/academy.js';
import { grantExpiry, reviewerFor } from '../src/domains/access.js';

describe('academy rules', () => {
  it('marks a quiz by position and rounds the score', () => {
    assert.deepEqual(markQuiz([0, 2, 1], [0, 2, 1], 80), { score: 100, passed: true });
    assert.deepEqual(markQuiz([0, 2, 1], [0, 1, 1], 80), { score: 67, passed: false });
    assert.deepEqual(markQuiz([0, 2, 1], [0, null, 1], 60), { score: 67, passed: true });
    assert.deepEqual(markQuiz([3], [3], 100), { score: 100, passed: true });
  });

  it('counts validity in calendar months and clamps to the end of short months', () => {
    assert.equal(certificationExpiry(new Date('2026-01-31T10:00:00Z'), 1)!.toISOString(), '2026-02-28T10:00:00.000Z');
    assert.equal(certificationExpiry(new Date('2028-01-31T10:00:00Z'), 1)!.toISOString(), '2028-02-29T10:00:00.000Z', 'leap year');
    assert.equal(certificationExpiry(new Date('2026-03-15T00:00:00Z'), 12)!.toISOString(), '2027-03-15T00:00:00.000Z');
    assert.equal(certificationExpiry(new Date('2026-08-31T00:00:00Z'), 6)!.toISOString(), '2027-02-28T00:00:00.000Z', 'across a year');
    assert.equal(certificationExpiry(new Date(), null), null);
  });
});

describe('access rules', () => {
  it('starts a temporary grant\'s clock when it is set up, not when it is approved', () => {
    const setUp = new Date('2026-09-14T09:00:00Z');
    assert.equal(grantExpiry(setUp, 7)!.toISOString(), '2026-09-21T09:00:00.000Z');
    assert.equal(grantExpiry(setUp, null), null);
  });

  it('never asks someone to review their own access', () => {
    assert.equal(reviewerFor({ userId: 'ana', ownerId: 'olu', userManagerId: 'mia' }, 'admin'), 'olu');
    assert.equal(reviewerFor({ userId: 'olu', ownerId: 'olu', userManagerId: 'mia' }, 'admin'), 'mia', 'the owner holds it');
    assert.equal(reviewerFor({ userId: 'olu', ownerId: 'olu', userManagerId: null }, 'admin'), 'admin');
    assert.equal(reviewerFor({ userId: 'ana', ownerId: null, userManagerId: 'ana' }, 'admin'), 'admin');
  });
});
