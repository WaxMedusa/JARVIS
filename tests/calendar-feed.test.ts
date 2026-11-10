import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {IcsCalendarFeedService, expandEvents, normalizeFeedUrl, parseIcs} from '../src/integrations/calendar-feed.js';
import {SecretStore} from '../src/security/secrets.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, {recursive: true, force: true});
});

function ics(lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//JARVIS test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
}

function tempSecrets(): SecretStore {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-feed-'));
  homes.push(home);
  return new SecretStore(path.join(home, 'secrets.enc'), {keyPath: path.join(home, 'master.key')});
}

describe('iCal calendar feeds', () => {
  it('expands a weekly recurrence in its timezone and honors EXDATE', () => {
    const text = ics([
      'BEGIN:VEVENT',
      'UID:standup-1',
      'SUMMARY:Morning standup',
      'LOCATION:Studio',
      'DTSTART;TZID=Europe/Berlin:20261102T093000',
      'DTEND;TZID=Europe/Berlin:20261102T094500',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      'EXDATE;TZID=Europe/Berlin:20261109T093000',
      'END:VEVENT',
    ]);
    const parsed = parseIcs(text);
    const events = expandEvents(parsed, {id: 'feed_test', label: 'Work'}, new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    expect(events).toHaveLength(3);
    expect(events[0]?.start).toBe('2026-11-02T08:30:00.000Z');
    expect(events[1]?.start).toBe('2026-11-16T08:30:00.000Z');
    expect(events[0]).toMatchObject({summary: 'Morning standup', location: 'Studio', source: 'Work'});
    expect(events[0]?.end).toBe('2026-11-02T08:45:00.000Z');
  });

  it('handles all-day events and escaped text', () => {
    const text = ics([
      'BEGIN:VEVENT',
      'UID:holiday-1',
      'SUMMARY:Reading day\\, no classes',
      'DTSTART;VALUE=DATE:20261110',
      'DTEND;VALUE=DATE:20261111',
      'END:VEVENT',
    ]);
    const events = expandEvents(parseIcs(text), {id: 'feed_all', label: 'School'}, new Date('2026-11-09T00:00:00Z'), new Date('2026-11-12T00:00:00Z'));
    expect(events).toHaveLength(1);
    expect(events[0]?.all_day).toBe(true);
    expect(events[0]?.summary).toBe('Reading day, no classes');
    expect(new Date(events[0]!.start).getDate()).toBe(10);
  });

  it('keeps a single occurrence of an overridden recurring event', () => {
    const text = ics([
      'BEGIN:VEVENT',
      'UID:lecture-1',
      'SUMMARY:Lecture',
      'DTSTART;TZID=Europe/Berlin:20261103T100000',
      'DTEND;TZID=Europe/Berlin:20261103T110000',
      'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:lecture-1',
      'RECURRENCE-ID;TZID=Europe/Berlin:20261110T100000',
      'SUMMARY:Lecture (moved)',
      'DTSTART;TZID=Europe/Berlin:20261110T140000',
      'DTEND;TZID=Europe/Berlin:20261110T150000',
      'END:VEVENT',
    ]);
    const events = expandEvents(parseIcs(text), {id: 'feed_override', label: 'Uni'}, new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    expect(events).toHaveLength(3);
    expect(events.filter((event) => event.summary === 'Lecture (moved)')).toHaveLength(1);
    expect(events.filter((event) => event.summary === 'Lecture')).toHaveLength(2);
  });

  it('validates feed URLs', () => {
    expect(normalizeFeedUrl('calendar.google.com/calendar/ical/x/basic.ics')).toBe(
      'https://calendar.google.com/calendar/ical/x/basic.ics',
    );
    expect(() => normalizeFeedUrl('http://calendar.google.com/x.ics')).toThrow(/https/);
    expect(() => normalizeFeedUrl('')).toThrow(/required/);
  });

  it('adds, lists, expands and removes a feed through encrypted storage', async () => {
    const text = ics([
      'BEGIN:VEVENT',
      'UID:lab-1',
      'SUMMARY:Physics lab',
      'DTSTART:20261112T140000Z',
      'DTEND:20261112T160000Z',
      'END:VEVENT',
    ]);
    const fetchImpl = (async () => new Response(text, {status: 200})) as typeof fetch;
    const service = new IcsCalendarFeedService({secrets: tempSecrets(), fetchImpl});
    const feed = await service.add({url: 'https://calendar.google.com/calendar/ical/secret/basic.ics', label: 'University'});
    expect(feed.host).toBe('calendar.google.com');
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]).toMatchObject({label: 'University', host: 'calendar.google.com'});

    const result = await service.events({timeMin: '2026-11-01T00:00:00Z', timeMax: '2026-12-01T00:00:00Z'});
    expect(result.warnings).toEqual([]);
    expect(result.events[0]).toMatchObject({summary: 'Physics lab', start: '2026-11-12T14:00:00.000Z', source: 'University'});

    expect(service.remove(feed.id)).toBe(true);
    expect(service.remove(feed.id)).toBe(false);
    expect(service.list()).toEqual([]);
  });

  it('rejects a URL that is not a calendar', async () => {
    const fetchImpl = (async () => new Response('<html>login</html>', {status: 200})) as typeof fetch;
    const service = new IcsCalendarFeedService({secrets: tempSecrets(), fetchImpl});
    await expect(service.add({url: 'https://example.com/feed.ics'})).rejects.toThrow(/not an iCal/);
  });
});
