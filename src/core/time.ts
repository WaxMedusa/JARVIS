/** Timezone-aware time utilities built on Intl (no external date library). */

export const nowIso = (): string => new Date().toISOString();

export function toIso(value: Date | number | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
  }
  partsFormatters.set(timeZone, formatter);
  return formatter;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '0' : map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAYS[map.weekday ?? 'Sun'] ?? 0,
  };
}

/** Offset in milliseconds such that `zonedWallClock - offset = UTC wall clock`. */
export function timezoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight of the day containing `date`, in the given timezone. */
export function startOfDay(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  const offset = timezoneOffsetMs(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - offset);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function formatInTz(
  value: Date | string | number,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const date = parseDate(value);
  if (!date) return 'unknown time';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(date);
  }
}

export function formatIsoLocal(value: Date | string | number, timeZone: string): string {
  const date = parseDate(value);
  if (!date) return '';
  const p = zonedParts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = Math.round(timezoneOffsetMs(date, timeZone) / 60000);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function humanizeDuration(ms: number): string {
  const abs = Math.abs(ms);
  const units: Array<[number, string]> = [
    [86_400_000 * 365, 'year'],
    [86_400_000 * 30, 'month'],
    [86_400_000 * 7, 'week'],
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1000, 'second'],
  ];
  for (const [size, label] of units) {
    if (abs >= size) {
      const value = Math.round(abs / size);
      return `${value} ${label}${value === 1 ? '' : 's'}`;
    }
  }
  return 'moments';
}

export function humanizeRelative(value: Date | string | number | null | undefined, now = Date.now()): string {
  const date = parseDate(value ?? null);
  if (!date) return 'unknown';
  const delta = date.getTime() - now;
  if (Math.abs(delta) < 45_000) return 'just now';
  return delta > 0 ? `in ${humanizeDuration(delta)}` : `${humanizeDuration(delta)} ago`;
}

/** Minutes since local midnight. */
export function minutesOfDay(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** True when `now` falls inside a possibly overnight quiet window (e.g. 22:30-07:00). */
export function isQuietHours(now: Date, timeZone: string, start: string, end: string): boolean {
  const startMin = parseClock(start);
  const endMin = parseClock(end);
  if (startMin === null || endMin === null || startMin === endMin) return false;
  const current = minutesOfDay(now, timeZone);
  if (startMin < endMin) return current >= startMin && current < endMin;
  return current >= startMin || current < endMin;
}

export function dayKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
