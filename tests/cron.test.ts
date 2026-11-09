import {describe, expect, it} from 'vitest';
import {clockMatches, matchesCron} from '../src/scheduler/scheduler.js';
import {nextOccurrence} from '../src/memory/tasks.js';
import {chunkText} from '../src/memory/documents.js';

describe('cron matching', () => {
  it('matches fixed times in UTC', () => {
    expect(matchesCron('30 7 * * *', new Date('2026-11-09T07:30:00Z'), 'UTC')).toBe(true);
    expect(matchesCron('30 7 * * *', new Date('2026-11-09T07:31:00Z'), 'UTC')).toBe(false);
  });

  it('supports steps, ranges and lists', () => {
    expect(matchesCron('*/15 * * * *', new Date('2026-11-09T07:45:00Z'), 'UTC')).toBe(true);
    expect(matchesCron('0 9 * * 1-5', new Date('2026-11-09T09:00:00Z'), 'UTC')).toBe(true); // Monday
    expect(matchesCron('0 9 * * 1-5', new Date('2026-11-08T09:00:00Z'), 'UTC')).toBe(false); // Sunday
    expect(matchesCron('0 8,20 * * *', new Date('2026-11-09T20:00:00Z'), 'UTC')).toBe(true);
  });

  it('matches day-of-week 0 and 7 as Sunday', () => {
    expect(matchesCron('0 18 * * 0', new Date('2026-11-08T18:00:00Z'), 'UTC')).toBe(true);
    expect(matchesCron('0 18 * * 7', new Date('2026-11-08T18:00:00Z'), 'UTC')).toBe(true);
  });

  it('understands clock strings', () => {
    expect(clockMatches('07:30', 450)).toBe(true);
    expect(clockMatches('07:30', 451)).toBe(false);
    expect(clockMatches('bad', 450)).toBe(false);
  });
});

describe('recurrence', () => {
  it('computes the next daily and weekday occurrence', () => {
    const base = new Date('2026-11-06T09:00:00Z'); // Friday
    expect(nextOccurrence('daily', base)?.toISOString()).toBe('2026-11-07T09:00:00.000Z');
    expect(nextOccurrence('weekdays', new Date('2026-11-06T09:00:00Z'))?.toISOString()).toBe('2026-11-09T09:00:00.000Z');
    expect(nextOccurrence('every:2:weeks', base)?.toISOString()).toBe('2026-11-20T09:00:00.000Z');
  });

  it('returns null for unknown recurrence', () => {
    expect(nextOccurrence('whenever', new Date())).toBeNull();
  });
});

describe('document chunking', () => {
  it('overlaps chunks and preserves content', () => {
    const text = 'A'.repeat(300) + '\n\n' + 'B'.repeat(300);
    const chunks = chunkText(text, 200, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true);
    expect(chunks.join('')).toContain('A');
    expect(chunks.join('')).toContain('B');
  });

  it('returns a single chunk for short text', () => {
    expect(chunkText('short note', 500, 50)).toEqual(['short note']);
  });
});
