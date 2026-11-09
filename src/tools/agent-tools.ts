import {z} from 'zod';
import {defineTool} from './types.js';

export const agentTools = [
  defineTool({
    name: 'delegate_research',
    description:
      'Delegate a focused research task to a read-only sub-agent with web and file access. Use for deep lookups, comparisons or reading several sources; returns a compact report with sources.',
    risk: 'external',
    category: 'agent',
    timeoutMs: 300_000,
    schema: z.object({
      task: z.string().min(5).max(2000).describe('What to investigate and what the report should answer'),
      context: z.string().max(4000).optional().describe('Relevant context the sub-agent needs'),
    }),
    async handler(args, ctx) {
      if (!ctx.delegate) return {content: 'Research delegation is unavailable in this context.', isError: true};
      const report = await ctx.delegate({task: args.task, context: args.context});
      return {content: report || 'The research sub-agent returned no findings.', summary: 'research complete'};
    },
  }),
];
