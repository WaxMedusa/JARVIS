import {z} from 'zod';
import {defineTool, type ToolContext} from './types.js';

function feeds(ctx: ToolContext) {
  return ctx.integrations.services.calendarFeeds;
}

export const calendarFeedTools = [
  defineTool({
    name: 'calendar_feed_list',
    description: 'List the private iCal calendar feeds connected to JARVIS (Google Calendar secret addresses or other .ics URLs).',
    risk: 'read',
    category: 'calendar',
    schema: z.object({}),
    async handler(_args, ctx) {
      const items = feeds(ctx).list();
      if (!items.length) {
        return {
          content: 'No calendar feeds are connected. The user can add one in JARVIS → Agenda → Connect calendar.',
          summary: 'no feeds',
        };
      }
      return {content: items.map((feed) => `- ${feed.label} (${feed.host})`).join('\n'), summary: `${items.length} feeds`};
    },
  }),

  defineTool({
    name: 'calendar_feed_add',
    description:
      'Connect a read-only iCal calendar feed. Use the private .ics address from Google Calendar (Settings → Secret address in iCal format). The URL is a credential and is stored encrypted.',
    risk: 'write',
    category: 'calendar',
    timeoutMs: 30_000,
    schema: z.object({
      url: z.string().min(10).max(2000),
      label: z.string().max(80).optional(),
    }),
    async handler(args, ctx) {
      const feed = await feeds(ctx).add({url: args.url, label: args.label});
      return {content: `Calendar connected: ${feed.label} (${feed.host}).`, summary: 'calendar connected'};
    },
  }),

  defineTool({
    name: 'calendar_feed_remove',
    description: 'Disconnect a private iCal calendar feed by its id.',
    risk: 'write',
    category: 'calendar',
    schema: z.object({id: z.string().min(3)}),
    async handler(args, ctx) {
      const removed = feeds(ctx).remove(args.id);
      return removed
        ? {content: 'Calendar feed disconnected.', summary: 'feed removed'}
        : {content: 'No feed with that id.', isError: true};
    },
  }),
];
