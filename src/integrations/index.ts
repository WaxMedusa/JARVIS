import type {JarvisConfig} from '../config.js';
import type {JarvisDB} from '../db/database.js';
import type {Policy} from '../security/policy.js';
import type {SecretStore} from '../security/secrets.js';
import {EmailClient} from './email.js';
import {GitHubClient} from './github.js';
import {GoogleClient} from './google.js';
import {HomeAssistantClient} from './homeassistant.js';
import {LinearClient} from './linear.js';
import {NotionClient} from './notion.js';
import {RssClient} from './rss.js';
import {SupabaseClient} from './supabase.js';
import type {IntegrationHub, IntegrationName, IntegrationServices, IntegrationStatus} from './types.js';

export * from './types.js';

/** Builds every configured integration once and exposes their status. */
export class IntegrationsHub implements IntegrationHub {
  readonly services: IntegrationServices;
  private readonly mcpServers: number;

  constructor(options: {config: JarvisConfig; secrets: SecretStore; db: JarvisDB; policy: Policy}) {
    const {config, secrets, db, policy} = options;
    const google = GoogleClient.create({
      clientId: config.integrations.google.clientId,
      clientSecret: config.integrations.google.clientSecret,
      scopes: config.integrations.google.scopes,
      calendarId: config.integrations.google.calendarId,
      redirectPort: config.integrations.google.redirectPort,
      secrets,
    });
    this.services = {
      google,
      notion: NotionClient.create(config.integrations.notion),
      github: GitHubClient.create(config.integrations.github),
      homeAssistant: HomeAssistantClient.create(config.integrations.homeAssistant),
      linear: LinearClient.create(config.integrations.linear.token),
      email: EmailClient.create(config.integrations.email),
      supabase: SupabaseClient.create({
        url: config.integrations.supabase.url,
        key: config.integrations.supabase.key,
        tablePrefix: config.integrations.supabase.tablePrefix,
        db,
      }),
      rss: new RssClient(config.integrations.rss.feeds, policy),
    };
    this.mcpServers = config.integrations.mcp.servers.filter((server) => server.enabled).length;
  }

  has(name: IntegrationName): boolean {
    return Boolean(this.services[name]);
  }

  status(): IntegrationStatus[] {
    const s = this.services;
    return [
      {
        name: 'google',
        label: 'Google (Calendar, Gmail, Tasks)',
        configured: Boolean(s.google?.isAuthorized()),
        detail: s.google ? (s.google.isAuthorized() ? 'authorized' : 'run `jarvis auth google`') : 'set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
      },
      {name: 'notion', label: 'Notion', configured: Boolean(s.notion), detail: s.notion ? 'token set' : 'set NOTION_API_KEY'},
      {name: 'github', label: 'GitHub', configured: Boolean(s.github), detail: s.github ? 'token set' : 'set GITHUB_TOKEN'},
      {name: 'linear', label: 'Linear', configured: Boolean(s.linear), detail: s.linear ? 'token set' : 'set LINEAR_API_KEY'},
      {
        name: 'homeAssistant',
        label: 'Home Assistant',
        configured: Boolean(s.homeAssistant),
        detail: s.homeAssistant ? 'connected' : 'set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN',
      },
      {name: 'email', label: 'Email (IMAP/SMTP)', configured: Boolean(s.email), detail: s.email ? 'account configured' : 'set IMAP_HOST, IMAP_USER, IMAP_PASSWORD'},
      {
        name: 'supabase',
        label: 'Supabase sync',
        configured: Boolean(s.supabase),
        detail: s.supabase ? 'credentials set' : 'set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
      },
      {
        name: 'rss',
        label: 'RSS feeds',
        configured: Boolean(s.rss),
        detail: s.rss ? 'feeds configured' : 'no feeds',
      },
      {
        name: 'mcp',
        label: 'MCP servers',
        configured: this.mcpServers > 0,
        detail: this.mcpServers > 0 ? `${this.mcpServers} configured` : 'add integrations.mcp.servers in config',
      },
    ];
  }
}

export {GoogleClient, NotionClient, GitHubClient, HomeAssistantClient, LinearClient, EmailClient, SupabaseClient, RssClient};
