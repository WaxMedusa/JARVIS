import {z} from 'zod';
import {defineTool, type ToolContext} from './types.js';

const recipients = z.union([z.string(), z.array(z.string())]).describe('One or more email addresses');

function toList(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : value.split(',')).map((item) => item.trim()).filter(Boolean);
}

function service<T>(ctx: ToolContext, name: keyof ToolContext['integrations']['services'], hint: string): T {
  const found = ctx.integrations.services[name] as unknown as T | null;
  if (!found) throw new Error(`${name} is not configured. ${hint}`);
  return found;
}

export const workspaceTools = [
  /* ------------------------------- Notion -------------------------------- */
  defineTool({
    name: 'notion_search',
    description: 'Search the user\'s Notion workspace for pages and databases.',
    risk: 'read',
    category: 'notion',
    timeoutMs: 30_000,
    schema: z.object({query: z.string().min(1).max(300), limit: z.number().int().min(1).max(20).default(8)}),
    async handler(args, ctx) {
      const results = await service<import('../integrations/types.js').NotionService>(ctx, 'notion', 'Set NOTION_API_KEY and share the target pages with the integration.').search(args.query, args.limit);
      if (!results.length) return {content: 'No Notion results.', summary: 'no results'};
      return {content: results.map((item) => `- ${item.title} [${item.type}] ${item.url ?? item.id}`).join('\n'), summary: `${results.length} pages`};
    },
  }),

  defineTool({
    name: 'notion_read_page',
    description: 'Read the text content of a Notion page by id.',
    risk: 'read',
    category: 'notion',
    schema: z.object({id: z.string().min(3)}),
    async handler(args, ctx) {
      const page = await service<import('../integrations/types.js').NotionService>(ctx, 'notion', 'Set NOTION_API_KEY.').getPage(args.id);
      return {content: `<untrusted_notion_page title="${page.title}">\n${page.text.slice(0, 12_000)}\n</untrusted_notion_page>`, summary: 'page read'};
    },
  }),

  defineTool({
    name: 'notion_append',
    description: 'Append a paragraph of text to an existing Notion page.',
    risk: 'write',
    category: 'notion',
    schema: z.object({page_id: z.string().min(3), text: z.string().min(1).max(20_000)}),
    async handler(args, ctx) {
      await service<import('../integrations/types.js').NotionService>(ctx, 'notion', 'Set NOTION_API_KEY.').appendText(args.page_id, args.text);
      return {content: 'Notion page updated.', summary: 'page appended'};
    },
  }),

  defineTool({
    name: 'notion_create_page',
    description: 'Create a new Notion page under a parent page or database id.',
    risk: 'write',
    category: 'notion',
    schema: z.object({
      parent_id: z.string().min(3),
      title: z.string().min(1).max(300),
      content: z.string().max(50_000).default(''),
    }),
    async handler(args, ctx) {
      const page = await service<import('../integrations/types.js').NotionService>(ctx, 'notion', 'Set NOTION_API_KEY.').createPage({
        parentId: args.parent_id,
        title: args.title,
        content: args.content,
      });
      return {content: `Notion page created: ${page.url ?? page.id}`, summary: 'page created'};
    },
  }),

  /* ------------------------------- GitHub -------------------------------- */
  defineTool({
    name: 'github_activity',
    description: 'Show the user\'s GitHub notifications and optionally their identity. Good for "what needs my attention on GitHub".',
    risk: 'read',
    category: 'github',
    timeoutMs: 30_000,
    schema: z.object({include_viewer: z.boolean().default(true), limit: z.number().int().min(1).max(30).default(10)}),
    async handler(args, ctx) {
      const github = service<import('../integrations/types.js').GitHubService>(ctx, 'github', 'Set GITHUB_TOKEN.');
      const [viewer, notifications] = await Promise.all([
        args.include_viewer ? github.viewer().catch(() => null) : Promise.resolve(null),
        github.notifications(args.limit),
      ]);
      const lines: string[] = [];
      if (viewer) lines.push(`Signed in as ${viewer.login}${viewer.name ? ` (${viewer.name})` : ''}.`);
      if (!notifications.length) lines.push('No unread GitHub notifications.');
      for (const item of notifications) {
        lines.push(`- ${item.repo}: ${item.title} (${item.reason})${item.url ? ` ${item.url}` : ''}`);
      }
      return {content: lines.join('\n'), summary: `${notifications.length} notifications`};
    },
  }),

  defineTool({
    name: 'github_issues',
    description: 'List issues or pull requests in a GitHub repository, or create/comment on an issue.',
    risk: 'read',
    category: 'github',
    timeoutMs: 30_000,
    schema: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('list_issues'),
        repo: z.string().describe('owner/name'),
        state: z.enum(['open', 'closed', 'all']).default('open'),
        limit: z.number().int().min(1).max(50).default(15),
      }),
      z.object({
        action: z.literal('list_prs'),
        repo: z.string(),
        state: z.enum(['open', 'closed', 'all']).default('open'),
        limit: z.number().int().min(1).max(50).default(15),
      }),
      z.object({
        action: z.literal('search'),
        query: z.string().min(2),
        limit: z.number().int().min(1).max(30).default(10),
      }),
      z.object({
        action: z.literal('create_issue'),
        repo: z.string(),
        title: z.string().min(1).max(300),
        body: z.string().max(20_000).default(''),
        labels: z.array(z.string()).default([]),
      }),
      z.object({
        action: z.literal('comment'),
        repo: z.string(),
        number: z.number().int().min(1),
        body: z.string().min(1).max(20_000),
      }),
    ]),
    async handler(args, ctx) {
      const github = service<import('../integrations/types.js').GitHubService>(ctx, 'github', 'Set GITHUB_TOKEN.');
      if (args.action === 'list_issues') {
        const issues = await github.listIssues({repo: args.repo, state: args.state, limit: args.limit});
        return {content: issues.map((issue) => `#${issue.number} [${issue.state}] ${issue.title} ${issue.url}`).join('\n') || 'No issues.', summary: `${issues.length} issues`};
      }
      if (args.action === 'list_prs') {
        const prs = await github.listPullRequests({repo: args.repo, state: args.state, limit: args.limit});
        return {content: prs.map((pr) => `#${pr.number} [${pr.state}${pr.draft ? ', draft' : ''}] ${pr.title} ${pr.url}`).join('\n') || 'No pull requests.', summary: `${prs.length} PRs`};
      }
      if (args.action === 'search') {
        const results = await github.search({query: args.query, limit: args.limit});
        return {content: results.map((item) => `- [${item.type}] ${item.title} ${item.url}`).join('\n') || 'No results.', summary: `${results.length} results`};
      }
      if (args.action === 'create_issue') {
        const issue = await github.createIssue({repo: args.repo, title: args.title, body: args.body, labels: args.labels});
        return {content: `Issue #${issue.number} created: ${issue.url}`, summary: 'issue created'};
      }
      const comment = await github.comment({repo: args.repo, number: args.number, body: args.body});
      return {content: `Comment added: ${comment.url}`, summary: 'comment added'};
    },
  }),

  /* ------------------------------- Linear -------------------------------- */
  defineTool({
    name: 'linear_issues',
    description: 'Read or manage Linear issues: list assigned work, search, or create an issue.',
    risk: 'read',
    category: 'linear',
    timeoutMs: 30_000,
    schema: z.discriminatedUnion('action', [
      z.object({action: z.literal('mine'), limit: z.number().int().min(1).max(50).default(15)}),
      z.object({action: z.literal('search'), query: z.string().min(2), limit: z.number().int().min(1).max(30).default(10)}),
      z.object({
        action: z.literal('create'),
        title: z.string().min(1).max(300),
        description: z.string().max(20_000).default(''),
        team_id: z.string().optional(),
        priority: z.number().int().min(0).max(4).optional(),
      }),
    ]),
    async handler(args, ctx) {
      const linear = service<import('../integrations/types.js').LinearService>(ctx, 'linear', 'Set LINEAR_API_KEY.');
      if (args.action === 'mine') {
        const issues = await linear.myIssues(args.limit);
        return {content: issues.map((issue) => `- ${issue.identifier} [${issue.state}] ${issue.title}${issue.url ? ` ${issue.url}` : ''}`).join('\n') || 'No assigned issues.', summary: `${issues.length} issues`};
      }
      if (args.action === 'search') {
        const issues = await linear.searchIssues(args.query, args.limit);
        return {content: issues.map((issue) => `- ${issue.identifier} [${issue.state}] ${issue.title}`).join('\n') || 'No matches.', summary: `${issues.length} issues`};
      }
      const created = await linear.createIssue({title: args.title, description: args.description, teamId: args.team_id, priority: args.priority});
      return {content: `Linear issue created: ${created.identifier} ${created.url ?? ''}`, summary: 'issue created'};
    },
  }),

  /* --------------------------- Home Assistant ---------------------------- */
  defineTool({
    name: 'home_states',
    description: 'Read Home Assistant entity states (lights, climate, sensors, locks). Optionally filter by substring.',
    risk: 'read',
    category: 'home',
    timeoutMs: 20_000,
    schema: z.object({filter: z.string().optional(), limit: z.number().int().min(1).max(100).default(30)}),
    async handler(args, ctx) {
      const home = service<import('../integrations/types.js').HomeAssistantService>(ctx, 'homeAssistant', 'Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN.');
      const states = await home.states(args.filter);
      return {
        content: states.slice(0, args.limit).map((state) => `- ${state.entity_id}: ${state.state}${state.unit ? ` ${state.unit}` : ''}${state.name ? ` (${state.name})` : ''}`).join('\n') || 'No entities matched.',
        summary: `${Math.min(states.length, args.limit)} entities`,
      };
    },
  }),

  defineTool({
    name: 'home_control',
    description: 'Call a Home Assistant service to control a device (e.g. light.turn_on, climate.set_temperature). Requires approval.',
    risk: 'write',
    category: 'home',
    timeoutMs: 20_000,
    schema: z.object({
      domain: z.string().min(1).max(60),
      service_name: z.string().min(1).max(60),
      entity_id: z.string().optional(),
      data: z.record(z.string(), z.unknown()).default({}),
    }),
    async handler(args, ctx) {
      const home = service<import('../integrations/types.js').HomeAssistantService>(ctx, 'homeAssistant', 'Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN.');
      const result = await home.callService({
        domain: args.domain,
        service: args.service_name,
        entityId: args.entity_id,
        data: args.data,
      });
      return {content: `Home Assistant ${args.domain}.${args.service_name} executed.`, summary: 'device controlled', data: result};
    },
  }),

  /* ------------------------------ Generic email -------------------------- */
  defineTool({
    name: 'email_recent',
    description: 'List recent email from the configured IMAP account.',
    risk: 'read',
    category: 'email',
    timeoutMs: 40_000,
    schema: z.object({limit: z.number().int().min(1).max(30).default(10)}),
    async handler(args, ctx) {
      const email = service<import('../integrations/types.js').EmailService>(ctx, 'email', 'Set IMAP_HOST, IMAP_USER and IMAP_PASSWORD.');
      const messages = await email.recent(args.limit);
      return {content: messages.map((message) => `- [${message.uid}] ${message.date ?? ''} · ${message.from ?? ''} · ${message.subject ?? ''}`).join('\n') || 'Inbox is empty.', summary: `${messages.length} emails`};
    },
  }),

  defineTool({
    name: 'email_send',
    description: 'Send an email via the configured SMTP account. Irreversible: requires explicit user intent.',
    risk: 'irreversible',
    category: 'email',
    timeoutMs: 40_000,
    schema: z.object({
      to: recipients,
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(100_000),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    async handler(args, ctx) {
      const email = service<import('../integrations/types.js').EmailService>(ctx, 'email', 'Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD.');
      const to = toList(args.to);
      await email.send({to, subject: args.subject, body: args.body, cc: args.cc ? toList(args.cc) : undefined});
      return {content: `Email sent to ${to.join(', ')}.`, summary: 'email sent'};
    },
  }),

  /* --------------------------------- RSS --------------------------------- */
  defineTool({
    name: 'news_digest',
    description: 'Read the latest headlines from the configured RSS feeds. Use for briefings and "what\'s new" questions.',
    risk: 'external',
    category: 'news',
    timeoutMs: 45_000,
    schema: z.object({
      limit: z.number().int().min(1).max(40).default(12),
      urls: z.array(z.string()).default([]).describe('Optional feed URLs; defaults to configured feeds'),
    }),
    async handler(args, ctx) {
      const rss = service<import('../integrations/types.js').RssService>(ctx, 'rss', 'Configure integrations.rss.feeds in jarvis.config.json.');
      const items = await rss.digest({limit: args.limit, urls: args.urls.length ? args.urls : undefined});
      if (!items.length) return {content: 'No feed items available.', summary: 'no news'};
      return {
        content: items.map((item) => `- ${item.title} (${item.source}${item.published ? `, ${item.published.slice(0, 10)}` : ''})\n  ${item.link}`).join('\n'),
        summary: `${items.length} headlines`,
      };
    },
  }),

  /* ------------------------------- Supabase ------------------------------ */
  defineTool({
    name: 'supabase_sync',
    description: 'Push local memories/tasks to Supabase or pull them back. Use for keeping the assistant\'s memory durable across machines.',
    risk: 'write',
    category: 'sync',
    timeoutMs: 120_000,
    schema: z.object({direction: z.enum(['push', 'pull']).default('push')}),
    async handler(args, ctx) {
      const supabase = service<import('../integrations/types.js').SupabaseService>(ctx, 'supabase', 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then run the schema in docs/supabase.sql.');
      if (args.direction === 'push') {
        const result = await supabase.push();
        return {content: `Pushed ${result.pushed} rows to Supabase (${result.tables.join(', ')}).`, summary: 'cloud sync complete'};
      }
      const result = await supabase.pull();
      return {content: `Pulled ${result.pulled} rows from Supabase.`, summary: 'cloud sync complete'};
    },
  }),
];
