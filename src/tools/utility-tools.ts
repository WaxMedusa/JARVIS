import os from 'node:os';
import {z} from 'zod';
import {formatIsoLocal, formatInTz, humanizeRelative, nowIso, parseDate, zonedParts} from '../core/time.js';
import {defineTool} from './types.js';

export const utilityTools = [
  defineTool({
    name: 'current_time',
    description: 'Get the current date and time in the user\'s timezone or a specified one. Use this before computing relative dates when precision matters.',
    risk: 'read',
    category: 'utility',
    schema: z.object({
      timezone: z.string().optional().describe('IANA timezone, defaults to the user\'s configured timezone'),
    }),
    handler(args, ctx) {
      const tz = args.timezone || ctx.config.assistant.timezone;
      const now = new Date();
      try {
        const parts = zonedParts(now, tz);
        return {
          content: JSON.stringify(
            {
              iso: now.toISOString(),
              local: formatIsoLocal(now, tz),
              formatted: formatInTz(now, tz, {dateStyle: 'full', timeStyle: 'long'}),
              timezone: tz,
              weekday: parts.weekday,
              unix: Math.floor(now.getTime() / 1000),
            },
            null,
            2,
          ),
          summary: tz,
        };
      } catch {
        return {content: `Unknown timezone: ${tz}`, isError: true};
      }
    },
  }),

  defineTool({
    name: 'date_math',
    description: 'Add or subtract time from a date. Useful for converting "next Tuesday" or "in three hours" into a precise timestamp before creating a reminder or event.',
    risk: 'read',
    category: 'utility',
    schema: z.object({
      base: z.string().optional().describe('ISO timestamp; defaults to now'),
      add_days: z.number().default(0),
      add_hours: z.number().default(0),
      add_minutes: z.number().default(0),
    }),
    handler(args, ctx) {
      const base = args.base ? parseDate(args.base) : new Date();
      if (!base) return {content: `Could not parse base date: ${args.base}`, isError: true};
      const result = new Date(
        base.getTime() + args.add_days * 86_400_000 + args.add_hours * 3_600_000 + args.add_minutes * 60_000,
      );
      return {
        content: JSON.stringify(
          {
            iso: result.toISOString(),
            local: formatIsoLocal(result, ctx.config.assistant.timezone),
            humanized: humanizeRelative(result),
            date: formatInTz(result, ctx.config.assistant.timezone, {dateStyle: 'full', timeStyle: 'short'}),
          },
          null,
          2,
        ),
        summary: 'date computed',
      };
    },
  }),

  defineTool({
    name: 'system_status',
    description: 'Report JARVIS health: model, memory counts, tasks, documents, integrations and host resources. Use when the user asks how you or the system are doing.',
    risk: 'read',
    category: 'system',
    schema: z.object({}),
    async handler(_args, ctx) {
      const counts = {
        memories: ctx.memory.count(),
        profileFacts: ctx.memory.getProfile({limit: 1000}).length,
        conversations: ctx.conversations.list(200).length,
        openTasks: ctx.tasks.list({limit: 500}).length,
        auditEntries: ctx.audit.count(),
        documents: ctx.documents.stats(),
      };
      const integrations = ctx.integrations
        .status()
        .map((entry) => `${entry.name}: ${entry.configured ? 'ready' : 'not configured'}${entry.configured && entry.detail ? ` (${entry.detail})` : ''}`);
      const memory = process.memoryUsage();
      const content = [
        `JARVIS status — ${formatInTz(new Date(), ctx.config.assistant.timezone, {dateStyle: 'medium', timeStyle: 'medium'})}`,
        `Model: ${ctx.llm.main.model} (${ctx.config.llm.provider})`,
        `Embeddings: ${ctx.embedder?.available ? `${ctx.embedder.model} (${ctx.embedder.dimensions}d)` : 'disabled — keyword recall only'}`,
        `Memory: ${counts.memories} memories, ${counts.profileFacts} profile facts, ${counts.conversations} conversations`,
        `Tasks: ${counts.openTasks} open; Documents: ${counts.documents.documents} files / ${counts.documents.chunks} chunks`,
        `Audit: ${counts.auditEntries} entries`,
        `Host: ${os.hostname()} · ${os.platform()} ${os.release()} · uptime ${humanizeRelative(new Date(Date.now() - os.uptime() * 1000)) ? `up ${humanizeDurationFromSeconds(os.uptime())}` : 'unknown'}`,
        `RSS: ${(memory.rss / 1024 / 1024).toFixed(0)} MB · load ${os.loadavg()[0]?.toFixed(2)}`,
        `Integrations: ${integrations.join('; ')}`,
      ].join('\n');
      return {content, summary: 'system status'};
    },
  }),

  defineTool({
    name: 'send_notification',
    description: 'Send a short notification to the user (console, configured webhook or Telegram). Use only when the user asked to be notified or a scheduled task needs to report.',
    risk: 'internal',
    category: 'system',
    schema: z.object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(2000),
      channel: z.string().optional().describe('console | telegram | webhook; defaults to configured channels'),
    }),
    async handler(args, ctx) {
      await ctx.notifier.send({title: args.title, body: args.body, channel: args.channel});
      return {content: `Notification sent${args.channel ? ` via ${args.channel}` : ''}.`, summary: 'notification sent'};
    },
  }),
];

function humanizeDurationFromSeconds(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export const utilityToolTimestamp = nowIso;
