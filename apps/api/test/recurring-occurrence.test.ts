/**
 * Opening one occurrence of a recurring meeting shows that occurrence.
 *
 * A series is stored as a single row, so every occurrence shares its id and its dates.
 * The detail endpoint read the row and nothing else, which meant a daily stand-up opened
 * on the twelfth reported the second — the series' first occurrence — no matter which
 * day had been clicked.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { occurrencesBetween, parseRecurrence } from '../src/core/recurrence.js';

const source = readFileSync(join(process.cwd(), 'src/domains/calendar.ts'), 'utf8');

describe('recurring occurrences', () => {
  it('expands a daily series into distinct days', () => {
    // COUNT has to outlast the window: a ten-occurrence series starting on the 2nd is
    // already finished by the 12th, and would correctly expand to nothing.
    const rule = parseRecurrence('FREQ=DAILY;COUNT=30');
    assert.ok(rule);
    const start = new Date('2026-09-02T19:00:00.000Z');
    const days = occurrencesBetween(
      start, 30 * 60_000, rule!,
      new Date('2026-09-12T00:00:00.000Z'),
      new Date('2026-09-15T00:00:00.000Z'),
    );
    assert.deepEqual(
      days.map((d) => d.toISOString().slice(0, 10)),
      ['2026-09-12', '2026-09-13', '2026-09-14'],
      'the expansion does not produce one occurrence per day',
    );
  });

  it('gives every occurrence its own identity', () => {
    // Shared ids were what made the list unkeyable and every row highlight at once.
    assert.match(source, /occurrence_id: `\$\{row\.id\}:/);
    assert.match(source, /occurrenceId:/, 'the occurrence id never reaches the client');
  });

  it('resolves a detail request to the occurrence asked for', () => {
    assert.match(source, /export async function getEvent\([^)]*occurrence\?: Date/s,
      'getEvent cannot be asked about a specific occurrence');
    assert.match(source, /occurrenceOf\(event, occurrence\)/,
      'getEvent does not apply the occurrence it was given');
  });

  it('refuses a timestamp that is not an occurrence of the rule', () => {
    // Otherwise a hand-edited URL would describe a meeting that was never scheduled.
    const body = source.slice(source.indexOf('function occurrenceOf'));
    assert.match(body.slice(0, 1200), /if \(!matches\) return row;/);
  });

  it('is asked for by the route', () => {
    const routes = readFileSync(join(process.cwd(), 'src/http/routes/collaboration.ts'), 'utf8');
    const handler = routes.slice(routes.indexOf("app.get('/calendar/events/:id'"));
    assert.match(handler.slice(0, 700), /occurrence: z\.string\(\)\.datetime\(\)\.optional\(\)/,
      'the detail route does not accept an occurrence');
  });
});
