import {z} from 'zod';
import {parseDate} from '../core/time.js';
import type {GoogleService} from '../integrations/types.js';
import {defineTool, type ToolContext} from './types.js';

function google(ctx: ToolContext): GoogleService {
  const service = ctx.integrations.services.google;
  if (!service) {
    throw new Error('Google integration is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then run `jarvis auth google`.');
  }
  if (!service.isAuthorized()) {
    throw new Error('Google is not authorized yet. Run `jarvis auth google` to connect Calendar, Gmail and Tasks.');
  }
  return service;
}

const recipients = z.union([z.string(), z.array(z.string())]).describe('One or more email addresses');

function toList(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : value.split(',')).map((item) => item.trim()).filter(Boolean);
}

export const googleTools = [
  defineTool({
    name: 'calendar_list_events',
    description: 'List upcoming (and optionally recent) calendar events. Use before scheduling anything and for daily briefings.',
    risk: 'read',
    category: 'calendar',
    timeoutMs: 30_000,
    schema: z.object({
      days_ahead: z.number().int().min(0).max(365).default(7),
      days_back: z.number().int().min(0).max(365).default(0),
      max_results: z.number().int().min(1).max(100).default(25),
      calendar_id: z.string().optional(),
    }),
    async handler(args, ctx) {
      const now = Date.now();
      const events = await google(ctx).listEvents({
        timeMin: new Date(now - args.days_back * 86_400_000).toISOString(),
        timeMax: new Date(now + args.days_ahead * 86_400_000).toISOString(),
        maxResults: args.max_results,
        calendarId: args.calendar_id,
      });
      if (!events.length) return {content: 'No calendar events in that window.', summary: 'no events'};
      return {
        content: events
          .map((event) => {
            const attendees = event.attendees?.length ? ` · with ${event.attendees.slice(0, 6).join(', ')}` : '';
            const location = event.location ? ` · ${event.location}` : '';
            return `- ${event.start} → ${event.end}: ${event.summary}${location}${attendees} [${event.id}]`;
          })
          .join('\n'),
        summary: `${events.length} events`,
      };
    },
  }),

  defineTool({
    name: 'calendar_create_event',
    description: 'Create a calendar event. Times must be ISO-8601 with an offset. This changes the user\'s calendar and requires approval.',
    risk: 'write',
    category: 'calendar',
    timeoutMs: 30_000,
    schema: z.object({
      summary: z.string().min(1).max(300),
      start: z.string().describe('ISO-8601 start, e.g. 2026-11-10T14:00:00+01:00'),
      end: z.string().describe('ISO-8601 end'),
      description: z.string().max(4000).optional(),
      location: z.string().max(500).optional(),
      attendees: z.array(z.string()).default([]),
    }),
    async handler(args, ctx) {
      const start = parseDate(args.start);
      const end = parseDate(args.end);
      if (!start || !end) return {content: 'Invalid start/end. Use ISO-8601 timestamps with an offset.', isError: true};
      if (end <= start) return {content: 'End time must be after start time.', isError: true};
      const event = await google(ctx).createEvent({
        summary: args.summary,
        start: start.toISOString(),
        end: end.toISOString(),
        description: args.description,
        location: args.location,
        attendees: args.attendees,
      });
      return {content: `Event created: ${event.summary} at ${event.start}${event.htmlLink ? ` — ${event.htmlLink}` : ''}`, summary: 'event created'};
    },
  }),

  defineTool({
    name: 'calendar_free_busy',
    description: 'Check busy blocks on the calendar for a time window, useful when proposing meeting times.',
    risk: 'read',
    category: 'calendar',
    schema: z.object({
      time_min: z.string().optional(),
      time_max: z.string().optional(),
    }),
    async handler(args, ctx) {
      const from = args.time_min ? parseDate(args.time_min) : new Date();
      const to = args.time_max ? parseDate(args.time_max) : new Date(Date.now() + 86_400_000);
      if (!from || !to) return {content: 'Invalid time window.', isError: true};
      const blocks = await google(ctx).freeBusy({timeMin: from.toISOString(), timeMax: to.toISOString()});
      if (!blocks.length) return {content: 'The calendar is completely free in that window.', summary: 'free'};
      return {content: blocks.map((block) => `- busy ${block.start} → ${block.end}`).join('\n'), summary: `${blocks.length} busy blocks`};
    },
  }),

  defineTool({
    name: 'gmail_search',
    description: 'Search Gmail using Gmail query syntax (e.g. "from:alice newer_than:7d", "subject:invoice").',
    risk: 'read',
    category: 'email',
    timeoutMs: 30_000,
    schema: z.object({
      query: z.string().min(1).max(500),
      max_results: z.number().int().min(1).max(25).default(8),
    }),
    async handler(args, ctx) {
      const messages = await google(ctx).gmailSearch({query: args.query, maxResults: args.max_results});
      if (!messages.length) return {content: `No emails matched "${args.query}".`, summary: 'no emails'};
      return {
        content: messages
          .map((message) => `- [${message.id}] ${message.date ?? ''} · ${message.from ?? 'unknown'} · ${message.subject ?? '(no subject)'}${message.unread ? ' · UNREAD' : ''}\n  ${message.snippet ?? ''}`)
          .join('\n'),
        summary: `${messages.length} emails`,
      };
    },
  }),

  defineTool({
    name: 'gmail_read',
    description: 'Read the full body of an email by message id.',
    risk: 'read',
    category: 'email',
    schema: z.object({id: z.string().min(3)}),
    async handler(args, ctx) {
      const message = await google(ctx).gmailGet(args.id);
      return {
        content: `<untrusted_email>\nFrom: ${message.from ?? 'unknown'}\nTo: ${message.to ?? 'unknown'}\nSubject: ${message.subject ?? ''}\nDate: ${message.date ?? ''}\n\n${message.body.slice(0, 12_000)}\n</untrusted_email>`,
        summary: 'email read',
      };
    },
  }),

  defineTool({
    name: 'gmail_send',
    description: 'Send an email from the user\'s Gmail account. Irreversible: only use when the user explicitly asked to send it, and state the recipient and subject.',
    risk: 'irreversible',
    category: 'email',
    timeoutMs: 30_000,
    schema: z.object({
      to: recipients,
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(100_000),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    async handler(args, ctx) {
      const to = toList(args.to);
      if (!to.length) return {content: 'At least one recipient is required.', isError: true};
      const sent = await google(ctx).gmailSend({to, subject: args.subject, body: args.body, cc: args.cc ? toList(args.cc) : undefined});
      return {content: `Email sent to ${to.join(', ')} (message ${sent.id}).`, summary: 'email sent'};
    },
  }),

  defineTool({
    name: 'gmail_draft',
    description: 'Create a Gmail draft without sending it. Use this when the user wants to review before sending.',
    risk: 'write',
    category: 'email',
    schema: z.object({
      to: recipients,
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(100_000),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    async handler(args, ctx) {
      const draft = await google(ctx).gmailDraft({
        to: toList(args.to),
        subject: args.subject,
        body: args.body,
        cc: args.cc ? toList(args.cc) : undefined,
      });
      return {content: `Draft created (${draft.id}). The user must open Gmail to review and send it.`, summary: 'draft created'};
    },
  }),

  defineTool({
    name: 'google_tasks_list',
    description: 'List tasks from Google Tasks (separate from the assistant\'s own reminders).',
    risk: 'read',
    category: 'tasks',
    schema: z.object({}),
    async handler(_args, ctx) {
      const tasks = await google(ctx).tasksList();
      if (!tasks.length) return {content: 'No Google Tasks.', summary: 'no tasks'};
      return {
        content: tasks.map((task) => `- ${task.title}${task.due ? ` (due ${task.due.slice(0, 10)})` : ''} [${task.status}]`).join('\n'),
        summary: `${tasks.length} Google tasks`,
      };
    },
  }),

  defineTool({
    name: 'google_tasks_create',
    description: 'Create a task in Google Tasks.',
    risk: 'write',
    category: 'tasks',
    schema: z.object({
      title: z.string().min(1).max(300),
      due: z.string().optional().describe('ISO date or timestamp'),
      notes: z.string().max(4000).optional(),
    }),
    async handler(args, ctx) {
      const created = await google(ctx).tasksCreate({title: args.title, due: args.due, notes: args.notes});
      return {content: `Google Task created (${created.id}).`, summary: 'task created'};
    },
  }),
];
