import crypto from 'node:crypto';
import {fetchCapped} from '../core/http.js';
import {JarvisError} from '../core/errors.js';
import {stripHtml} from '../core/http.js';
import type {SecretStore} from '../security/secrets.js';
import type {CalendarEvent, GoogleService} from './types.js';

const TOKEN_KEY = 'google.tokens';

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
}

interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  calendarId: string;
  redirectPort: number;
  secrets: SecretStore;
}

export class GoogleClient implements GoogleService {
  private readonly options: GoogleOptions;
  private pendingStates = new Map<string, number>();

  constructor(options: GoogleOptions) {
    this.options = options;
  }

  static create(options: GoogleOptions): GoogleClient | null {
    return options.clientId && options.clientSecret ? new GoogleClient(options) : null;
  }

  isAuthorized(): boolean {
    const tokens = this.tokens();
    return Boolean(tokens?.refresh_token || (tokens?.access_token && tokens.expires_at > Date.now()));
  }

  authUrl(state = crypto.randomBytes(16).toString('hex')): {url: string; state: string} {
    this.pendingStates.set(state, Date.now() + 10 * 60_000);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.options.scopes.join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    return {url: url.toString(), state};
  }

  consumeState(state: string): boolean {
    const expiry = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    return Boolean(expiry && expiry > Date.now());
  }

  async exchangeCode(code: string): Promise<void> {
    const payload = await this.tokenRequest({
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri(),
    });
    this.saveTokens(payload);
  }

  async status(): Promise<{authorized: boolean; email?: string}> {
    if (!this.isAuthorized()) return {authorized: false};
    try {
      const response = await this.api<{email?: string}>('https://www.googleapis.com/oauth2/v3/userinfo');
      if (response.email) this.options.secrets.set('google.email', response.email);
      return {authorized: true, email: response.email ?? this.options.secrets.get('google.email')};
    } catch {
      return {authorized: true, email: this.options.secrets.get('google.email')};
    }
  }

  async listEvents(args: {timeMin: string; timeMax: string; maxResults?: number; calendarId?: string}): Promise<CalendarEvent[]> {
    const calendarId = encodeURIComponent(args.calendarId ?? this.options.calendarId);
    const params = new URLSearchParams({
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(args.maxResults ?? 25, 2500)),
    });
    const payload = await this.api<{
      items?: Array<{
        id: string;
        summary?: string;
        description?: string;
        location?: string;
        htmlLink?: string;
        start?: {dateTime?: string; date?: string};
        end?: {dateTime?: string; date?: string};
        attendees?: Array<{email?: string; displayName?: string}>;
      }>;
    }>(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`);
    return (payload.items ?? []).map((item) => ({
      id: item.id,
      summary: item.summary ?? '(untitled)',
      start: item.start?.dateTime ?? item.start?.date ?? '',
      end: item.end?.dateTime ?? item.end?.date ?? '',
      location: item.location,
      description: item.description,
      htmlLink: item.htmlLink,
      attendees: (item.attendees ?? []).map((attendee) => attendee.displayName ?? attendee.email ?? '').filter(Boolean),
    }));
  }

  async createEvent(args: {
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    calendarId?: string;
  }): Promise<CalendarEvent> {
    const calendarId = encodeURIComponent(args.calendarId ?? this.options.calendarId);
    const payload = await this.api<{
      id: string;
      summary?: string;
      htmlLink?: string;
      start?: {dateTime?: string};
      end?: {dateTime?: string};
    }>(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
      method: 'POST',
      body: JSON.stringify({
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: {dateTime: args.start},
        end: {dateTime: args.end},
        attendees: args.attendees?.map((email) => ({email})),
      }),
    });
    return {
      id: payload.id,
      summary: payload.summary ?? args.summary,
      start: payload.start?.dateTime ?? args.start,
      end: payload.end?.dateTime ?? args.end,
      htmlLink: payload.htmlLink,
    };
  }

  async freeBusy(args: {timeMin: string; timeMax: string}): Promise<Array<{start: string; end: string}>> {
    const payload = await this.api<{
      calendars?: Record<string, {busy?: Array<{start: string; end: string}>}>;
    }>('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      body: JSON.stringify({timeMin: args.timeMin, timeMax: args.timeMax, items: [{id: this.options.calendarId}]}),
    });
    const calendar = payload.calendars?.[this.options.calendarId];
    return calendar?.busy ?? [];
  }

  async gmailSearch(args: {query: string; maxResults?: number}): Promise<
    Array<{id: string; threadId: string; from?: string; subject?: string; date?: string; snippet?: string; unread?: boolean}>
  > {
    const params = new URLSearchParams({q: args.query, maxResults: String(Math.min(args.maxResults ?? 8, 50))});
    const list = await this.api<{messages?: Array<{id: string; threadId: string; labelIds?: string[]}>}>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    );
    const messages = list.messages ?? [];
    const detailed = await Promise.all(
      messages.map(async (message) => {
        try {
          const full = await this.api<{id: string; threadId: string; snippet?: string; payload?: {headers?: Array<{name: string; value: string}>}}>(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          );
          const headers = headerMap(full.payload?.headers);
          return {
            id: message.id,
            threadId: message.threadId,
            from: headers.from,
            subject: headers.subject,
            date: headers.date,
            snippet: full.snippet,
            unread: (message.labelIds ?? []).includes('UNREAD'),
          };
        } catch {
          return {id: message.id, threadId: message.threadId};
        }
      }),
    );
    return detailed;
  }

  async gmailGet(id: string): Promise<{id: string; threadId: string; from?: string; to?: string; subject?: string; date?: string; body: string; labels?: string[]}> {
    const message = await this.api<{
      id: string;
      threadId: string;
      labelIds?: string[];
      payload?: {headers?: Array<{name: string; value: string}>; body?: {data?: string}; parts?: unknown[]; mimeType?: string};
    }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
    const headers = headerMap(message.payload?.headers);
    return {
      id: message.id,
      threadId: message.threadId,
      from: headers.from,
      to: headers.to,
      subject: headers.subject,
      date: headers.date,
      body: extractGmailBody(message.payload),
      labels: message.labelIds,
    };
  }

  async gmailSend(args: {to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[]}): Promise<{id: string}> {
    const raw = buildMime(args);
    const payload = await this.api<{id: string}>('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({raw: toBase64Url(raw)}),
    });
    return {id: payload.id};
  }

  async gmailDraft(args: {to: string[]; subject: string; body: string; cc?: string[]}): Promise<{id: string}> {
    const raw = buildMime(args);
    const payload = await this.api<{id: string}>('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      body: JSON.stringify({message: {raw: toBase64Url(raw)}}),
    });
    return {id: payload.id};
  }

  async tasksList(): Promise<Array<{id: string; title: string; due?: string; notes?: string; status: string}>> {
    const payload = await this.api<{items?: Array<{id: string; title?: string; due?: string; notes?: string; status?: string}>}>(
      'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?showCompleted=false&maxResults=50',
    );
    return (payload.items ?? []).map((item) => ({
      id: item.id,
      title: item.title ?? '(untitled)',
      due: item.due,
      notes: item.notes,
      status: item.status ?? 'needsAction',
    }));
  }

  async tasksCreate(args: {title: string; due?: string; notes?: string}): Promise<{id: string}> {
    const due = args.due ? normalizeGoogleDue(args.due) : undefined;
    const payload = await this.api<{id: string}>('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
      method: 'POST',
      body: JSON.stringify({title: args.title, notes: args.notes, ...(due ? {due} : {})}),
    });
    return {id: payload.id};
  }

  /* ------------------------------- internals ------------------------------ */

  private redirectUri(): string {
    return `http://127.0.0.1:${this.options.redirectPort}`;
  }

  private tokens(): GoogleTokens | null {
    const raw = this.options.secrets.get(TOKEN_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GoogleTokens;
    } catch {
      return null;
    }
  }

  private saveTokens(payload: {access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string}): void {
    const existing = this.tokens();
    const tokens: GoogleTokens = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? existing?.refresh_token,
      expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000 - 60_000,
      scope: payload.scope ?? existing?.scope,
      token_type: payload.token_type ?? existing?.token_type,
    };
    this.options.secrets.set(TOKEN_KEY, JSON.stringify(tokens));
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    const tokens = this.tokens();
    if (!tokens) throw new JarvisError('AUTH', 'Google account is not connected. Run `jarvis auth google`.');
    if (!forceRefresh && tokens.access_token && tokens.expires_at > Date.now()) return tokens.access_token;
    if (!tokens.refresh_token) throw new JarvisError('AUTH', 'Google access token expired and no refresh token is stored. Run `jarvis auth google`.');
    const refreshed = await this.tokenRequest({grant_type: 'refresh_token', refresh_token: tokens.refresh_token});
    this.saveTokens({...refreshed, refresh_token: refreshed.refresh_token ?? tokens.refresh_token});
    return refreshed.access_token;
  }

  private async tokenRequest(params: Record<string, string>): Promise<{access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string}> {
    const body = new URLSearchParams({client_id: this.options.clientId, client_secret: this.options.clientSecret, ...params});
    const response = await fetchCapped('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: body.toString(),
      service: 'Google OAuth',
      timeoutMs: 30_000,
    });
    try {
      return JSON.parse(response.text) as {access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string};
    } catch (error) {
      throw new JarvisError('AUTH', 'Google token exchange returned invalid JSON', {cause: error});
    }
  }

  private async api<T>(url: string, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await this.accessToken();
    try {
      const response = await fetchCapped(url, {
        ...init,
        timeoutMs: 30_000,
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {})},
        service: 'Google',
      });
      return (response.text.trim() ? JSON.parse(response.text) : {}) as T;
    } catch (error) {
      const status = error instanceof JarvisError ? Number((error.details as {upstreamStatus?: number})?.upstreamStatus ?? 0) : 0;
      if (status === 401 && !retried) {
        await this.accessToken(true);
        return this.api<T>(url, init, true);
      }
      throw error;
    }
  }
}

function headerMap(headers: Array<{name: string; value: string}> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const header of headers ?? []) output[header.name.toLowerCase()] = header.value;
  return output;
}

function extractGmailBody(payload: {body?: {data?: string}; parts?: unknown[]; mimeType?: string} | undefined): string {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  const parts = (payload.parts ?? []) as Array<{mimeType?: string; body?: {data?: string}; parts?: unknown[]}>;
  const plain = parts.find((part) => part.mimeType === 'text/plain');
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  const html = parts.find((part) => part.mimeType === 'text/html');
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));
  for (const part of parts) {
    const nested = extractGmailBody(part as {body?: {data?: string}; parts?: unknown[]; mimeType?: string});
    if (nested) return nested;
  }
  return '';
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildMime(args: {to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[]}): string {
  const encodeHeader = (value: string): string =>
    /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
  const headers = [
    `To: ${args.to.join(', ')}`,
    ...(args.cc?.length ? [`Cc: ${args.cc.join(', ')}`] : []),
    ...(args.bcc?.length ? [`Bcc: ${args.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeader(args.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const encodedBody = Buffer.from(args.body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${encodedBody}`;
}

function normalizeGoogleDue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}
