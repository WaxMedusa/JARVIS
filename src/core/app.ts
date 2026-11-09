import {loadConfig, type JarvisConfig} from '../config.js';
import {JarvisDB} from '../db/database.js';
import {createLLM, type LLMSet} from '../llm/index.js';
import {StructuredLogger, getLogger, setLogger, type Logger} from './logger.js';
import {errorMessage} from './errors.js';
import {MemoryService} from '../memory/memory.js';
import {ConversationStore} from '../memory/conversations.js';
import {TaskService} from '../memory/tasks.js';
import {DocumentIndex} from '../memory/documents.js';
import {Consolidator} from '../memory/consolidation.js';
import {Policy} from '../security/policy.js';
import {AuditLog} from '../security/audit.js';
import {SecretStore} from '../security/secrets.js';
import {IntegrationsHub} from '../integrations/index.js';
import {McpManager} from '../integrations/mcp.js';
import {NotificationHub} from '../notify/index.js';
import {ToolRegistry} from '../tools/registry.js';
import {memoryTools} from '../tools/memory-tools.js';
import {fileTools} from '../tools/files.js';
import {shellTools} from '../tools/shell.js';
import {webTools} from '../tools/web.js';
import {weatherTools} from '../tools/weather.js';
import {knowledgeTools} from '../tools/knowledge.js';
import {googleTools} from '../tools/google-tools.js';
import {workspaceTools} from '../tools/workspace-tools.js';
import {utilityTools} from '../tools/utility-tools.js';
import {agentTools} from '../tools/agent-tools.js';
import {ContextBuilder} from '../agent/context.js';
import {Agent} from '../agent/agent.js';

export interface App {
  config: JarvisConfig;
  logger: Logger;
  db: JarvisDB;
  secrets: SecretStore;
  policy: Policy;
  audit: AuditLog;
  llm: LLMSet;
  embedder: LLMSet['embedder'];
  memory: MemoryService;
  conversations: ConversationStore;
  tasks: TaskService;
  documents: DocumentIndex;
  integrations: IntegrationsHub;
  notifier: NotificationHub;
  registry: ToolRegistry;
  consolidator: Consolidator;
  context: ContextBuilder;
  agent: Agent;
  mcp: McpManager;
  shutdown(): Promise<void>;
}

export interface CreateAppOptions {
  home?: string;
  configFile?: string;
  configOverrides?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  llmSet?: LLMSet;
  connectMcp?: boolean;
  registerTools?: boolean;
}

/** Build the full assistant graph. One instance per process. */
export async function createApp(options: CreateAppOptions = {}): Promise<App> {
  const config = loadConfig({
    home: options.home,
    configFile: options.configFile,
    overrides: options.configOverrides,
    env: options.env ?? process.env,
  });
  const logger = new StructuredLogger({
    level: config.logging.level,
    scope: 'jarvis',
    file: config.logging.file ? config.paths.logFile : undefined,
    pretty: process.stderr.isTTY,
  });
  setLogger(logger);

  const db = new JarvisDB(config.paths.db);
  const secrets = new SecretStore(config.paths.secrets, {keyPath: config.paths.masterKey});
  const policy = new Policy(config);
  const audit = new AuditLog(db, config.security.audit);

  try {
    const llm = options.llmSet ?? createLLM(config, {env: options.env ?? process.env});
    const embedder = llm.embedder;
    const memory = new MemoryService({db, config, embedder});
    const conversations = new ConversationStore(db);
    const tasks = new TaskService({db, config});
    const documents = new DocumentIndex({db, config, policy, embedder});
    const integrations = new IntegrationsHub({config, secrets, db, policy});
    const notifier = new NotificationHub(config);
    const consolidator = new Consolidator({config, db, memory, conversations, tasks, llm});
    const registry = new ToolRegistry();

    if (options.registerTools !== false) {
      registry.registerMany(memoryTools);
      registry.registerMany(fileTools);
      registry.registerMany(shellTools);
      registry.registerMany(webTools);
      registry.registerMany(weatherTools);
      registry.registerMany(knowledgeTools);
      registry.registerMany(googleTools);
      registry.registerMany(workspaceTools);
      registry.registerMany(utilityTools);
      registry.registerMany(agentTools);
    }

    const mcp = new McpManager(config);
    if (options.connectMcp !== false && config.integrations.mcp.servers.length) {
      const result = await mcp.connect(registry);
      if (result.errors.length) logger.warn('some MCP servers failed', {errors: result.errors});
    }

    const context = new ContextBuilder({config, memory, conversations, tasks, documents});
    const agent = new Agent({
      config,
      db,
      logger,
      memory,
      conversations,
      tasks,
      documents,
      policy,
      audit,
      secrets,
      llm,
      embedder,
      integrations,
      notifier,
      registry,
      consolidator,
      context,
    });

    audit.record('system', 'app.start', {
      provider: config.llm.provider,
      model: config.llm.model,
      tools: registry.count(),
      approvalMode: config.security.approvalMode,
      integrations: integrations.status().filter((entry) => entry.configured).map((entry) => entry.name),
    });

    let closed = false;
    const shutdown = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await mcp.close();
      audit.record('system', 'app.stop', {});
      db.close();
    };

    return {
      config,
      logger,
      db,
      secrets,
      policy,
      audit,
      llm,
      embedder,
      memory,
      conversations,
      tasks,
      documents,
      integrations,
      notifier,
      registry,
      consolidator,
      context,
      agent,
      mcp,
      shutdown,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Tiny helper used by the CLI and server to describe the active model. */
export function describeModel(app: App): string {
  const embeddings = app.embedder?.available ? `embeddings ${app.embedder.model}` : 'keyword-only recall';
  return `${app.config.llm.provider}/${app.llm.main.model} · ${embeddings}`;
}

export function logStartupSummary(app: App): void {
  getLogger().info('JARVIS online', {
    model: describeModel(app),
    timezone: app.config.assistant.timezone,
    tools: app.registry.count(),
    approvalMode: app.config.security.approvalMode,
    integrations: app.integrations.status().filter((entry) => entry.configured).length,
  });
}

export function safeShutdownSync(app: App): void {
  try {
    app.db.close();
  } catch (error) {
    process.stderr.write(`shutdown warning: ${errorMessage(error)}\n`);
  }
}
