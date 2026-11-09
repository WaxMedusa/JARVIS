import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import {z} from 'zod';
import {JarvisError} from './core/errors.js';

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

export const RiskSchema = z.enum(['read', 'internal', 'write', 'execute', 'external', 'irreversible']);
export type RiskLevel = z.infer<typeof RiskSchema>;

const McpServerSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  risk: RiskSchema.default('external'),
});

const ProactiveJobSchema = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  channel: z.string().default('console'),
  enabled: z.boolean().default(true),
});

const IntegrationSchema = z.object({
  google: z.object({
    clientId: z.string().default(''),
    clientSecret: z.string().default(''),
    redirectPort: z.number().int().min(1024).max(65535).default(53682),
    calendarId: z.string().default('primary'),
    scopes: z
      .array(z.string())
      .default([
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/drive.readonly',
      ]),
  }),
  notion: z.object({
    token: z.string().default(''),
    version: z.string().default('2022-06-28'),
  }),
  github: z.object({
    token: z.string().default(''),
    defaultRepo: z.string().default(''),
    apiBase: z.string().default('https://api.github.com'),
  }),
  homeAssistant: z.object({
    baseUrl: z.string().default(''),
    token: z.string().default(''),
  }),
  linear: z.object({
    token: z.string().default(''),
  }),
  supabase: z.object({
    url: z.string().default(''),
    key: z.string().default(''),
    tablePrefix: z.string().default('jarvis_'),
    autoSync: z.boolean().default(false),
  }),
  telegram: z.object({
    botToken: z.string().default(''),
    allowedChatIds: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
  }),
  email: z.object({
    imapHost: z.string().default(''),
    imapPort: z.number().int().default(993),
    imapUser: z.string().default(''),
    imapPassword: z.string().default(''),
    smtpHost: z.string().default(''),
    smtpPort: z.number().int().default(465),
    smtpUser: z.string().default(''),
    smtpPassword: z.string().default(''),
    from: z.string().default(''),
    secure: z.boolean().default(true),
  }),
  obsidian: z.object({
    vaultPath: z.string().default(''),
    dailyNoteFolder: z.string().default('Daily'),
  }),
  rss: z.object({
    feeds: z.array(z.string()).default([]),
  }),
  mcp: z.object({
    servers: z.array(McpServerSchema).default([]),
    connectTimeoutMs: z.number().int().min(1000).max(120000).default(20000),
  }),
  web: z.object({
    tavilyApiKey: z.string().default(''),
    braveApiKey: z.string().default(''),
    searxngUrl: z.string().default(''),
    userAgent: z.string().default('JARVIS/1.0 (+personal assistant)'),
  }),
});

const ConfigSchema = z.object({
  assistant: z.object({
    name: z.string().default('JARVIS'),
    userName: z.string().default('sir'),
    persona: z
      .string()
      .default(
        'You are JARVIS, a brilliant, discreet personal chief-of-staff. You are calm, precise, lightly witty, and unfailingly competent. You anticipate needs instead of waiting to be told. You never pad answers with filler.',
      ),
    timezone: z.string().default(''),
    locale: z.string().default('en-US'),
    language: z.string().default('English'),
    addressUserAs: z.string().default('sir'),
    verbosity: z.enum(['terse', 'concise', 'normal', 'detailed']).default('concise'),
  }),
  llm: z.object({
    provider: z.enum(['openai', 'anthropic', 'ollama', 'mock', 'custom']).default('openai'),
    model: z.string().default(''),
    smallModel: z.string().default(''),
    embeddingModel: z.string().default('text-embedding-3-small'),
    baseUrl: z.string().default(''),
    apiKeyEnv: z.string().default(''),
    temperature: z.number().min(0).max(2).default(0.4),
    maxOutputTokens: z.number().int().min(256).max(32768).default(4096),
    contextWindow: z.number().int().min(4096).default(128000),
    maxSteps: z.number().int().min(1).max(40).default(12),
    maxParallelTools: z.number().int().min(1).max(8).default(3),
    requestTimeoutMs: z.number().int().min(5000).max(600000).default(120000),
    retries: z.number().int().min(0).max(6).default(2),
    embeddings: z.boolean().default(true),
    embeddingDimensions: z.number().int().min(64).max(8192).default(1536),
    reasoningEffort: z.enum(['', 'low', 'medium', 'high']).default(''),
  }),
  memory: z.object({
    recallLimit: z.number().int().min(1).max(50).default(10),
    maxRecallChars: z.number().int().min(500).max(40000).default(6000),
    recencyHalfLifeDays: z.number().int().min(1).max(3650).default(90),
    diversity: z.number().min(0).max(1).default(0.35),
    extractFacts: z.boolean().default(true),
    consolidateEveryTurns: z.number().int().min(1).max(100).default(6),
    importanceFloor: z.number().min(0).max(1).default(0.15),
    retentionDays: z.number().int().min(0).default(0),
    maxMemories: z.number().int().min(100).default(50000),
    documentChunkChars: z.number().int().min(200).max(8000).default(1200),
    documentChunkOverlap: z.number().int().min(0).max(2000).default(200),
    autoIndexVault: z.boolean().default(true),
  }),
  security: z.object({
    approvalMode: z.enum(['strict', 'balanced', 'autonomous']).default('balanced'),
    allowIrreversible: z.boolean().default(false),
    allowedPaths: z.array(z.string()).default([]),
    shellAllowlist: z.array(z.string()).default([]),
    allowPrivateNetwork: z.boolean().default(false),
    denyPathPatterns: z.array(z.string()).default([]),
    maxToolOutputChars: z.number().int().min(1000).max(200000).default(14000),
    toolDeny: z.array(z.string()).default([]),
    toolAllow: z.array(z.string()).default([]),
    alwaysApprove: z.array(z.string()).default([]),
    redactLogs: z.boolean().default(true),
    audit: z.boolean().default(true),
  }),
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(8765),
    apiToken: z.string().default(''),
    publicHealth: z.boolean().default(true),
    maxBodyBytes: z.number().int().min(1024).default(2 * 1024 * 1024),
  }),
  proactive: z.object({
    enabled: z.boolean().default(true),
    channels: z.array(z.string()).default(['console']),
    morningBrief: z.string().default('07:30'),
    eveningReview: z.string().default('21:30'),
    weeklyReviewCron: z.string().default('0 18 * * 0'),
    quietHours: z.object({
      start: z.string().default('22:30'),
      end: z.string().default('07:00'),
    }),
    webhookUrl: z.string().default(''),
    jobs: z.array(ProactiveJobSchema).default([]),
    appointmentWindowDays: z.number().int().min(1).max(30).default(2),
  }),
  voice: z.object({
    enabled: z.boolean().default(false),
    sttModel: z.string().default('whisper-1'),
    ttsModel: z.string().default('tts-1'),
    ttsVoice: z.string().default('onyx'),
    recordSeconds: z.number().int().min(1).max(120).default(8),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    file: z.boolean().default(true),
  }),
  integrations: IntegrationSchema,
});

export type JarvisConfigData = z.infer<typeof ConfigSchema>;

export interface JarvisPaths {
  home: string;
  configFile: string;
  db: string;
  secrets: string;
  masterKey: string;
  logsDir: string;
  logFile: string;
  pidFile: string;
  tmpDir: string;
}

export interface JarvisConfig extends JarvisConfigData {
  paths: JarvisPaths;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function expandHome(value: string, home = os.homedir()): string {
  if (!value) return value;
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(expandHome(env.JARVIS_HOME?.trim() || path.join(os.homedir(), '.jarvis')));
}

export function resolvePaths(home: string, configFile?: string): JarvisPaths {
  const logsDir = path.join(home, 'logs');
  return {
    home,
    configFile: configFile ?? path.join(home, 'config.json'),
    db: path.join(home, 'jarvis.db'),
    secrets: path.join(home, 'secrets.enc'),
    masterKey: path.join(home, 'master.key'),
    logsDir,
    logFile: path.join(logsDir, 'jarvis.log'),
    pidFile: path.join(home, 'jarvis.pid'),
    tmpDir: path.join(home, 'tmp'),
  };
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override === undefined ? base : override) as T;
  const output: Record<string, unknown> = {...base};
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = output[key];
    output[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return output as T;
}

/** Load `.env` from the project and JARVIS home without overriding real env vars. */
export function loadEnvFiles(home: string): void {
  for (const file of [path.join(process.cwd(), '.env'), path.join(home, '.env')]) {
    try {
      if (fs.existsSync(file)) dotenv.config({path: file, override: false, quiet: true});
    } catch {
      // A broken .env must not prevent the CLI from explaining the failure.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

function defaults(env: NodeJS.ProcessEnv, home: string): JarvisConfigData {
  const timezone = env.JARVIS_TIMEZONE?.trim() || '';
  return {
    assistant: {
      name: env.JARVIS_NAME?.trim() || 'JARVIS',
      userName: env.JARVIS_USER_NAME?.trim() || env.USER?.trim() || 'sir',
      persona:
        'You are JARVIS, a brilliant, discreet personal chief-of-staff. You are calm, precise, lightly witty, and unfailingly competent. You anticipate needs instead of waiting to be told. You never pad answers with filler.',
      timezone,
      locale: env.JARVIS_LOCALE?.trim() || 'en-US',
      language: env.JARVIS_LANGUAGE?.trim() || 'English',
      addressUserAs: env.JARVIS_ADDRESS_AS?.trim() || 'sir',
      verbosity: 'concise',
    },
    llm: {
      provider: (env.JARVIS_LLM_PROVIDER as JarvisConfigData['llm']['provider']) || 'openai',
      model: env.JARVIS_MODEL?.trim() || '',
      smallModel: env.JARVIS_SMALL_MODEL?.trim() || '',
      embeddingModel: env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
      baseUrl: env.LLM_BASE_URL?.trim() || '',
      apiKeyEnv: '',
      temperature: envInt(env.JARVIS_TEMPERATURE) ?? 0.4,
      maxOutputTokens: envInt(env.JARVIS_MAX_OUTPUT_TOKENS) ?? 4096,
      contextWindow: envInt(env.JARVIS_CONTEXT_WINDOW) ?? 128000,
      maxSteps: envInt(env.JARVIS_MAX_STEPS) ?? 12,
      maxParallelTools: 3,
      requestTimeoutMs: envInt(env.JARVIS_REQUEST_TIMEOUT_MS) ?? 120000,
      retries: 2,
      embeddings: envBool(env.JARVIS_EMBEDDINGS) ?? true,
      embeddingDimensions: envInt(env.EMBEDDING_DIMENSIONS) ?? 1536,
      reasoningEffort: '',
    },
    memory: {
      recallLimit: 10,
      maxRecallChars: 6000,
      recencyHalfLifeDays: 90,
      diversity: 0.35,
      extractFacts: envBool(env.JARVIS_EXTRACT_FACTS) ?? true,
      consolidateEveryTurns: 6,
      importanceFloor: 0.15,
      retentionDays: 0,
      maxMemories: 50000,
      documentChunkChars: 1200,
      documentChunkOverlap: 200,
      autoIndexVault: true,
    },
    security: {
      approvalMode: (env.JARVIS_APPROVAL_MODE as JarvisConfigData['security']['approvalMode']) || 'balanced',
      allowIrreversible: envBool(env.JARVIS_ALLOW_IRREVERSIBLE) ?? false,
      allowedPaths: envList(env.JARVIS_ALLOWED_PATHS) ?? [
        '~/Documents',
        '~/Desktop',
        '~/Downloads',
        '~/JarvisVault',
        process.cwd(),
      ],
      shellAllowlist: envList(env.JARVIS_SHELL_ALLOWLIST) ?? [
        'ls',
        'pwd',
        'cat',
        'head',
        'tail',
        'wc',
        'grep',
        'rg',
        'find',
        'df',
        'du',
        'uptime',
        'date',
        'whoami',
        'git status',
        'git log',
        'git diff',
        'node --version',
        'npm --version',
      ],
      allowPrivateNetwork: envBool(env.JARVIS_ALLOW_PRIVATE_NETWORK) ?? false,
      denyPathPatterns: [
        '**/.ssh/**',
        '**/.gnupg/**',
        '**/.aws/**',
        '**/.kube/**',
        '**/master.key',
        '**/secrets.enc',
        '**/*.pem',
        '**/jarvis.db*',
      ],
      maxToolOutputChars: 14000,
      toolDeny: [],
      toolAllow: [],
      alwaysApprove: [],
      redactLogs: true,
      audit: true,
    },
    server: {
      host: env.JARVIS_SERVER_HOST?.trim() || '127.0.0.1',
      port: envInt(env.JARVIS_SERVER_PORT) ?? 8765,
      apiToken: env.JARVIS_API_TOKEN?.trim() || '',
      publicHealth: true,
      maxBodyBytes: 2 * 1024 * 1024,
    },
    proactive: {
      enabled: envBool(env.JARVIS_PROACTIVE) ?? true,
      channels: envList(env.JARVIS_NOTIFY_CHANNELS) ?? ['console'],
      morningBrief: env.JARVIS_MORNING_BRIEF?.trim() ?? '07:30',
      eveningReview: env.JARVIS_EVENING_REVIEW?.trim() ?? '21:30',
      weeklyReviewCron: '0 18 * * 0',
      quietHours: {start: '22:30', end: '07:00'},
      webhookUrl: env.JARVIS_WEBHOOK_URL?.trim() || '',
      jobs: [],
      appointmentWindowDays: 2,
    },
    voice: {
      enabled: envBool(env.JARVIS_VOICE) ?? false,
      sttModel: env.STT_MODEL?.trim() || 'whisper-1',
      ttsModel: env.TTS_MODEL?.trim() || 'tts-1',
      ttsVoice: env.TTS_VOICE?.trim() || 'onyx',
      recordSeconds: 8,
    },
    logging: {
      level: (env.JARVIS_LOG_LEVEL as JarvisConfigData['logging']['level']) || 'info',
      file: true,
    },
    integrations: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID?.trim() || '',
        clientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || '',
        redirectPort: envInt(env.GOOGLE_REDIRECT_PORT) ?? 53682,
        calendarId: env.GOOGLE_CALENDAR_ID?.trim() || 'primary',
        scopes: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/tasks',
          'https://www.googleapis.com/auth/drive.readonly',
        ],
      },
      notion: {token: env.NOTION_API_KEY?.trim() || '', version: '2022-06-28'},
      github: {token: env.GITHUB_TOKEN?.trim() || '', defaultRepo: env.GITHUB_DEFAULT_REPO?.trim() || '', apiBase: 'https://api.github.com'},
      homeAssistant: {baseUrl: env.HOME_ASSISTANT_URL?.trim() || '', token: env.HOME_ASSISTANT_TOKEN?.trim() || ''},
      linear: {token: env.LINEAR_API_KEY?.trim() || ''},
      supabase: {
        url: env.SUPABASE_URL?.trim() || '',
        key: env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_KEY?.trim() || '',
        tablePrefix: 'jarvis_',
        autoSync: envBool(env.JARVIS_SUPABASE_AUTOSYNC) ?? false,
      },
      telegram: {
        botToken: env.TELEGRAM_BOT_TOKEN?.trim() || '',
        allowedChatIds: envList(env.TELEGRAM_ALLOWED_CHAT_IDS) ?? [],
        enabled: true,
      },
      email: {
        imapHost: env.IMAP_HOST?.trim() || '',
        imapPort: envInt(env.IMAP_PORT) ?? 993,
        imapUser: env.IMAP_USER?.trim() || '',
        imapPassword: env.IMAP_PASSWORD || '',
        smtpHost: env.SMTP_HOST?.trim() || '',
        smtpPort: envInt(env.SMTP_PORT) ?? 465,
        smtpUser: env.SMTP_USER?.trim() || '',
        smtpPassword: env.SMTP_PASSWORD || '',
        from: env.EMAIL_FROM?.trim() || env.SMTP_USER?.trim() || '',
        secure: envBool(env.SMTP_SECURE) ?? true,
      },
      obsidian: {
        vaultPath: env.OBSIDIAN_VAULT_PATH?.trim() || '',
        dailyNoteFolder: env.OBSIDIAN_DAILY_FOLDER?.trim() || 'Daily',
      },
      rss: {
        feeds:
          envList(env.RSS_FEEDS) ??
          ['https://news.ycombinator.com/rss', 'https://feeds.arstechnica.com/arstechnica/index'],
      },
      mcp: {servers: [], connectTimeoutMs: 20000},
      web: {
        tavilyApiKey: env.TAVILY_API_KEY?.trim() || '',
        braveApiKey: env.BRAVE_SEARCH_API_KEY?.trim() || '',
        searxngUrl: env.SEARXNG_URL?.trim() || '',
        userAgent: 'JARVIS/1.0 (+personal assistant)',
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

export interface LoadConfigOptions {
  home?: string;
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Record<string, unknown>;
  /** Skip reading jarvis.config.json (tests). */
  skipFile?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): JarvisConfig {
  const env = options.env ?? process.env;
  const home = path.resolve(expandHome(options.home ?? resolveHome(env)));
  loadEnvFiles(home);

  const paths = resolvePaths(home, options.configFile);
  fs.mkdirSync(home, {recursive: true});
  fs.mkdirSync(paths.logsDir, {recursive: true});
  fs.mkdirSync(paths.tmpDir, {recursive: true});

  let fileConfig: unknown = {};
  const candidate = options.configFile ?? paths.configFile;
  const projectConfig = path.join(process.cwd(), 'jarvis.config.json');
  const configFile = options.skipFile ? undefined : fs.existsSync(candidate) ? candidate : fs.existsSync(projectConfig) ? projectConfig : undefined;
  if (configFile) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      paths.configFile = configFile;
    } catch (error) {
      throw new JarvisError('CONFIG', `Could not parse config file ${configFile}: ${(error as Error).message}`, {cause: error});
    }
  }

  const merged = deepMerge(deepMerge(defaults(env, home), fileConfig), options.overrides ?? {});
  if (!merged.assistant.timezone) {
    merged.assistant.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new JarvisError('CONFIG', `Invalid configuration: ${issues}`, {details: parsed.error.issues});
  }

  const config = {...validateConfig(parsed.data)} as JarvisConfig;
  Object.defineProperty(config, 'paths', {value: paths, enumerable: true, writable: false});
  return config;
}

function validateConfig(data: JarvisConfigData): JarvisConfigData {
  const clone: JarvisConfigData = JSON.parse(JSON.stringify(data));
  clone.assistant.timezone = clone.assistant.timezone || 'UTC';
  clone.security.allowedPaths = [...new Set(clone.security.allowedPaths.map((p) => path.resolve(expandHome(p))))];
  clone.integrations.obsidian.vaultPath = clone.integrations.obsidian.vaultPath
    ? path.resolve(expandHome(clone.integrations.obsidian.vaultPath))
    : '';
  if (clone.llm.provider === 'ollama' && !clone.llm.baseUrl) clone.llm.baseUrl = 'http://127.0.0.1:11434/v1';
  if (clone.llm.provider === 'anthropic' && !clone.llm.model) clone.llm.model = 'claude-sonnet-4-5';
  if (clone.llm.provider === 'openai' && !clone.llm.model) clone.llm.model = 'gpt-4.1';
  if (clone.llm.provider === 'mock' && !clone.llm.model) clone.llm.model = 'mock-1';
  if (!clone.llm.smallModel) clone.llm.smallModel = clone.llm.model;
  return clone;
}

/** Config safe to print: secrets replaced. */
export function publicConfig(config: JarvisConfig): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(config)) as Record<string, any>;
  delete copy.paths;
  copy.server.apiToken = config.server.apiToken ? '[set]' : '';
  for (const key of ['clientSecret', 'token', 'botToken', 'key', 'imapPassword', 'smtpPassword', 'tavilyApiKey', 'braveApiKey'] as const) {
    if (copy.integrations?.google?.[key]) copy.integrations.google[key] = '[set]';
    if (copy.integrations?.notion?.[key]) copy.integrations.notion[key] = '[set]';
    if (copy.integrations?.github?.[key]) copy.integrations.github[key] = '[set]';
    if (copy.integrations?.homeAssistant?.[key]) copy.integrations.homeAssistant[key] = '[set]';
    if (copy.integrations?.linear?.[key]) copy.integrations.linear[key] = '[set]';
    if (copy.integrations?.supabase?.[key]) copy.integrations.supabase[key] = '[set]';
    if (copy.integrations?.telegram?.[key]) copy.integrations.telegram[key] = '[set]';
    if (copy.integrations?.web?.[key]) copy.integrations.web[key] = '[set]';
  }
  return copy;
}

/** Root used by the LLM API and embeddings (provider aware). */
export function llmBaseUrl(config: JarvisConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config.llm.baseUrl) return config.llm.baseUrl.replace(/\/+$/, '');
  if (config.llm.provider === 'anthropic') return 'https://api.anthropic.com';
  if (config.llm.provider === 'ollama') return 'http://127.0.0.1:11434/v1';
  if (config.llm.provider === 'mock') return 'mock://';
  return (env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

export function llmApiKey(config: JarvisConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config.llm.provider === 'anthropic') return env.ANTHROPIC_API_KEY?.trim() || '';
  if (config.llm.provider === 'ollama') return env.OLLAMA_API_KEY?.trim() || 'ollama';
  if (config.llm.provider === 'custom') {
    if (config.llm.apiKeyEnv) return env[config.llm.apiKeyEnv]?.trim() || '';
    return env.LLM_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || '';
  }
  return env.OPENAI_API_KEY?.trim() || '';
}
