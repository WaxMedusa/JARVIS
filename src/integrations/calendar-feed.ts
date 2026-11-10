import crypto from 'node:crypto';
import {JarvisError} from '../core/errors.js';
import type {SecretStore} from '../security/secrets.js';
import type {CalendarEvent, CalendarFeedService, CalendarFeedSummary} from './types.js';

const SECRET_KEY = 'calendar.feeds';
const MAX_FEEDS = 10;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const CACHE_MS = 2 * 60_000;
const MAX_OCCURRENCES = 200;

interface FeedRecord {
  id: string;
  url: string;
  label: string;
  addedAt: string;
}

interface FeedCache {
  at: number;
  events: CalendarEvent[];
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface IcsWhen {
  date: Date;
  allDay: boolean;
}

interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  start: IcsWhen;
  end?: IcsWhen;
  rrule?: string;
  exdates: string[];
  recurrenceId?: string;
}

export interface CalendarFeedOptions {
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
}

export function normalizeFeedUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) throw new JarvisError('VALIDATION', 'A calendar feed URL is required.');
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new JarvisError('VALIDATION', 'Enter a valid iCal URL.');
  }
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new JarvisError('VALIDATION', 'Calendar feeds must use https.');
  }
  if (url.username || url.password) throw new JarvisError('VALIDATION', 'Do not put credentials in the calendar URL.');
  return url.toString();
}

/** Reads private iCal feeds (Google Calendar → Settings → Secret address in iCal format). */
export class IcsCalendarFeedService implements CalendarFeedService {
  private readonly secrets: SecretStore;
  private readonly fetchImpl: typeof fetch;
  private cache = new Map<string, FeedCache>();

  constructor(options: CalendarFeedOptions) {
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  list(): CalendarFeedSummary[] {
    return this.readFeeds().map((feed) => ({
      id: feed.id,
      label: feed.label,
      host: safeHost(feed.url),
      addedAt: feed.addedAt,
    }));
  }

  async add(args: {url: string; label?: string}): Promise<CalendarFeedSummary> {
    const url = normalizeFeedUrl(args.url);
    const feeds = this.readFeeds();
    if (feeds.length >= MAX_FEEDS) {
      throw new JarvisError('VALIDATION', `JARVIS can watch up to ${MAX_FEEDS} calendar feeds. Remove one first.`);
    }
    if (feeds.some((feed) => feed.url === url)) {
      throw new JarvisError('VALIDATION', 'That calendar is already connected.');
    }
    const text = await this.download(url);
    const parsed = parseIcs(text);
    if (!parsed.length) throw new JarvisError('VALIDATION', 'That URL did not contain any calendar events.');
    const host = safeHost(url);
    const feed: FeedRecord = {
      id: `feed_${crypto.randomBytes(5).toString('hex')}`,
      url,
      label: String(args.label || '').trim().slice(0, 80) || host,
      addedAt: new Date().toISOString(),
    };
    this.writeFeeds([...feeds, feed]);
    this.cache.set(feed.id, {
      at: Date.now(),
      events: expandEvents(parsed, feed, new Date(Date.now() - 86_400_000), new Date(Date.now() + 90 * 86_400_000)),
    });
    return {id: feed.id, label: feed.label, host, addedAt: feed.addedAt};
  }

  remove(id: string): boolean {
    const feeds = this.readFeeds();
    const next = feeds.filter((feed) => feed.id !== id);
    if (next.length === feeds.length) return false;
    this.writeFeeds(next);
    this.cache.delete(id);
    return true;
  }

  async events(args: {timeMin: string; timeMax: string}): Promise<{events: CalendarEvent[]; warnings: string[]}> {
    const from = new Date(args.timeMin);
    const to = new Date(args.timeMax);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      throw new JarvisError('VALIDATION', 'Invalid calendar window.');
    }
    const events: CalendarEvent[] = [];
    const warnings: string[] = [];
    for (const feed of this.readFeeds()) {
      const cached = this.cache.get(feed.id);
      if (cached && Date.now() - cached.at < CACHE_MS) {
        events.push(...cached.events.filter((event) => overlaps(event, from, to)));
        continue;
      }
      try {
        const parsed = parseIcs(await this.download(feed.url));
        const expanded = expandEvents(parsed, feed, new Date(from.getTime() - 7 * 86_400_000), new Date(to.getTime() + 7 * 86_400_000));
        this.cache.set(feed.id, {at: Date.now(), events: expanded});
        events.push(...expanded.filter((event) => overlaps(event, from, to)));
      } catch (error) {
        warnings.push(`${feed.label}: ${(error as Error).message}`);
      }
    }
    events.sort((a, b) => a.start.localeCompare(b.start));
    return {events: events.slice(0, 500), warnings};
  }

  private readFeeds(): FeedRecord[] {
    const raw = this.secrets.get(SECRET_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is FeedRecord =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as FeedRecord).id === 'string' &&
          typeof (item as FeedRecord).url === 'string' &&
          typeof (item as FeedRecord).label === 'string',
      );
    } catch {
      return [];
    }
  }

  private writeFeeds(feeds: FeedRecord[]): void {
    this.secrets.set(SECRET_KEY, JSON.stringify(feeds));
  }

  private async download(url: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'JARVIS/1.0 (+personal assistant)'},
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new JarvisError('UNAVAILABLE', `Could not download the calendar feed: ${(error as Error).message}`, {cause: error});
    }
    if (!response.ok) throw new JarvisError('UNAVAILABLE', `The calendar feed returned HTTP ${response.status}.`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) throw new JarvisError('VALIDATION', 'That calendar feed is too large.');
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw new JarvisError('VALIDATION', 'That calendar feed is too large.');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new JarvisError('VALIDATION', 'That URL is not an iCal (.ics) calendar.');
    return text;
  }
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return 'calendar';
  }
}

function overlaps(event: CalendarEvent, from: Date, to: Date): boolean {
  const start = new Date(event.start).getTime();
  const end = new Date(event.end || event.start).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && start < to.getTime() && end > from.getTime();
}

/* -------------------------------------------------------------------------- */
/* iCal parsing                                                               */
/* -------------------------------------------------------------------------- */

export function parseIcs(text: string): IcsEvent[] {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  let current: {props: IcsProperty[]} | null = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line.trim())) {
      current = {props: []};
      continue;
    }
    if (/^END:VEVENT$/i.test(line.trim())) {
      if (current) {
        const parsed = eventFromProperties(current.props);
        if (parsed) events.push(parsed);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const property = parseProperty(line);
    if (property) current.props.push(property);
  }
  return events;
}

function unfold(text: string): string[] {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const output: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && output.length) {
      output[output.length - 1] += line.slice(1);
    } else {
      output.push(line);
    }
  }
  return output;
}

function parseProperty(line: string): IcsProperty | null {
  const colon = indexOfUnquoted(line, ':');
  if (colon <= 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = splitUnquoted(left, ';');
  const name = (segments.shift() || '').trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    params[segment.slice(0, eq).trim().toUpperCase()] = segment.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return {name, params, value};
}

function eventFromProperties(props: IcsProperty[]): IcsEvent | null {
  const get = (name: string): IcsProperty | undefined => props.find((property) => property.name === name);
  const startProperty = get('DTSTART');
  if (!startProperty) return null;
  const start = parseIcsDate(startProperty);
  if (!start) return null;
  const endProperty = get('DTEND');
  const end = endProperty ? parseIcsDate(endProperty) ?? undefined : undefined;
  const uid = (get('UID')?.value || '').trim() || `event_${crypto.createHash('sha1').update(`${start.date.toISOString()}${get('SUMMARY')?.value || ''}`).digest('hex').slice(0, 12)}`;
  const exdates = props
    .filter((property) => property.name === 'EXDATE')
    .flatMap((property) => property.value.split(','))
    .map((value) => parseIcsDate({name: 'EXDATE', params: startProperty.params, value}))
    .filter((value): value is IcsWhen => Boolean(value))
    .map((value) => value.date.toISOString());
  const recurrenceProperty = get('RECURRENCE-ID');
  const recurrenceId = recurrenceProperty ? parseIcsDate(recurrenceProperty)?.date.toISOString() : undefined;
  return {
    uid,
    summary: unescapeText(get('SUMMARY')?.value || '') || '(untitled event)',
    description: truncate(unescapeText(get('DESCRIPTION')?.value || ''), 2000) || undefined,
    location: truncate(unescapeText(get('LOCATION')?.value || ''), 300) || undefined,
    url: truncate((get('URL')?.value || '').trim(), 500) || undefined,
    start,
    end,
    rrule: get('RRULE')?.value,
    exdates,
    recurrenceId,
  };
}

function parseIcsDate(property: IcsProperty): IcsWhen | null {
  const value = property.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return {date: new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0), allDay: true};
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zulu] = match;
  const parts = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)] as const;
  if (zulu) {
    return {date: new Date(Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5])), allDay: false};
  }
  const tzid = property.params.TZID;
  if (tzid) {
    try {
      return {date: zonedTimeToUtc(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], tzid), allDay: false};
    } catch {
      return {date: new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]), allDay: false};
    }
  }
  return {date: new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]), allDay: false};
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): Date {
  const utcGuess = Date.UTC(year, month, day, hour, minute, second);
  let stamp = utcGuess;
  for (let i = 0; i < 2; i += 1) {
    const offset = zoneOffsetMs(stamp, timeZone);
    stamp = utcGuess - offset;
  }
  return new Date(stamp);
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(lookup.year, (lookup.month || 1) - 1, lookup.day || 1, lookup.hour || 0, lookup.minute || 0, lookup.second || 0);
  return asUtc - utcMs;
}

interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number;
  until?: Date;
  byday: number[];
}

function parseRule(raw: string | undefined): RecurrenceRule | null {
  if (!raw) return null;
  const fields = new Map<string, string>();
  for (const part of raw.split(';')) {
    const [key, value] = part.split('=');
    if (key && value) fields.set(key.trim().toUpperCase(), value.trim());
  }
  const freq = (fields.get('FREQ') || '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const interval = Math.max(1, Math.min(Number(fields.get('INTERVAL') || 1) || 1, 52));
  const count = Math.max(0, Math.min(Number(fields.get('COUNT') || 0) || 0, 1000));
  const untilRaw = fields.get('UNTIL');
  let until: Date | undefined;
  if (untilRaw) {
    const parsed = parseIcsDate({name: 'UNTIL', params: {}, value: untilRaw});
    until = parsed?.date;
  }
  const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const byday = (fields.get('BYDAY') || '')
    .split(',')
    .map((token) => dayNames.indexOf(token.replace(/^[+-]?\d+/, '').trim().toUpperCase()))
    .filter((index) => index >= 0);
  return {freq: freq as RecurrenceRule['freq'], interval, count, until, byday};
}

export function expandEvents(events: IcsEvent[], feed: {id: string; label: string}, from: Date, to: Date): CalendarEvent[] {
  const overrides = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.recurrenceId) continue;
    if (!overrides.has(event.uid)) overrides.set(event.uid, new Set());
    overrides.get(event.uid)?.add(new Date(event.recurrenceId).toISOString());
  }
  const output: CalendarEvent[] = [];
  for (const event of events) {
    if (event.recurrenceId) {
      pushIfVisible(output, event, event.start.date, event.end?.date, feed, from, to);
      continue;
    }
    const rule = parseRule(event.rrule);
    if (!rule) {
      pushIfVisible(output, event, event.start.date, event.end?.date, feed, from, to);
      continue;
    }
    const duration = event.end ? event.end.date.getTime() - event.start.date.getTime() : event.start.allDay ? 86_400_000 : 3_600_000;
    const excluded = new Set([...event.exdates, ...(overrides.get(event.uid) || new Set<string>())]);
    let emitted = 0;
    for (const occurrence of occurrenceDates(event.start.date, rule)) {
      if (occurrence > to) break;
      if (emitted >= MAX_OCCURRENCES) break;
      const key = occurrence.toISOString();
      if (excluded.has(key)) continue;
      emitted += 1;
      const end = new Date(occurrence.getTime() + duration);
      if (end < from) continue;
      output.push({
        id: `${feed.id}:${event.uid}:${key}`,
        summary: event.summary,
        start: key,
        end: end.toISOString(),
        all_day: event.start.allDay,
        location: event.location,
        description: event.description,
        htmlLink: event.url,
        source: feed.label,
      });
    }
  }
  return output.sort((a, b) => a.start.localeCompare(b.start));
}

function* occurrenceDates(start: Date, rule: RecurrenceRule): Generator<Date> {
  const base = new Date(start.getTime());
  const anchorWeekday = base.getDay();
  const emit = function* (): Generator<Date> {
    let index = 0;
    while (true) {
      let next: Date | null = null;
      if (rule.freq === 'DAILY') {
        next = addDays(base, index * rule.interval);
      } else if (rule.freq === 'WEEKLY') {
        if (rule.byday.length) {
          const weekStart = addDays(base, -((anchorWeekday + 7) % 7));
          const week = Math.floor(index / rule.byday.length);
          const day = rule.byday[index % rule.byday.length] ?? 0;
          next = addDays(weekStart, week * 7 * rule.interval + day);
          const time = new Date(next);
          time.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds());
          next = time;
        } else {
          next = addDays(base, index * 7 * rule.interval);
        }
      } else if (rule.freq === 'MONTHLY') {
        next = addMonths(base, index * rule.interval);
      } else {
        next = addMonths(base, index * 12 * rule.interval);
      }
      if (!next) return;
      if (next < base) {
        index += 1;
        if (index > 5000) return;
        continue;
      }
      if (rule.until && next > rule.until) return;
      if (rule.count && index >= rule.count) return;
      index += 1;
      if (index > 5000) return;
      yield next;
    }
  };
  yield* emit();
}

function pushIfVisible(output: CalendarEvent[], event: IcsEvent, start: Date, end: Date | undefined, feed: {id: string; label: string}, from: Date, to: Date): void {
  const actualEnd = end ?? new Date(start.getTime() + (event.start.allDay ? 86_400_000 : 3_600_000));
  if (!(start < to) || !(actualEnd > from)) return;
  output.push({
    id: `${feed.id}:${event.uid}:${start.toISOString()}`,
    summary: event.summary,
    start: start.toISOString(),
    end: actualEnd.toISOString(),
    all_day: event.start.allDay,
    location: event.location,
    description: event.description,
    htmlLink: event.url,
    source: feed.label,
  });
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const daysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, daysInMonth));
  return next;
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function indexOfUnquoted(value: string, needle: string): number {
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '"') quoted = !quoted;
    if (!quoted && value[i] === needle) return i;
  }
  return -1;
}

function splitUnquoted(value: string, separator: string): string[] {
  const output: string[] = [];
  let quoted = false;
  let current = '';
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (character === separator && !quoted) {
      output.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  output.push(current);
  return output;
}
