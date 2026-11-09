import {loadConfig, llmApiKey, llmBaseUrl, type JarvisConfig} from '../config.js';
import {JarvisDB} from '../db/database.js';
import {ConversationStore} from '../memory/conversations.js';
import {DocumentIndex} from '../memory/documents.js';
import {MemoryService} from '../memory/memory.js';
import {TaskService} from '../memory/tasks.js';
import {Policy} from '../security/policy.js';
import {AuditLog} from '../security/audit.js';
import {SecretStore} from '../security/secrets.js';
import {Embedder} from '../llm/embeddings.js';
import {StructuredLogger, setLogger} from '../core/logger.js';

export interface CliGlobalOptions {
  home?: string;
  config?: string;
  mcp?: boolean;
  verbose?: boolean;
  yes?: boolean;
}

export interface StorageBundle {
  config: JarvisConfig;
  db: JarvisDB;
  secrets: SecretStore;
  policy: Policy;
  audit: AuditLog;
  memory: MemoryService;
  conversations: ConversationStore;
  tasks: TaskService;
  documents: DocumentIndex;
  embedder: Embedder | null;
  shutdown(): void;
}

export function loadCliConfig(globals: CliGlobalOptions): JarvisConfig {
  return loadConfig({
    home: globals.home,
    configFile: globals.config,
    overrides: globals.verbose ? {logging: {level: 'debug'}} : undefined,
  });
}

/** Open the data layer without requiring an API key. */
export function openStorage(globals: CliGlobalOptions): StorageBundle {
  const config = loadCliConfig(globals);
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

  let embedder: Embedder | null = null;
  if (config.llm.embeddings) {
    let key = llmApiKey(config);
    let base = llmBaseUrl(config);
    if (config.llm.provider === 'anthropic') {
      key = process.env.OPENAI_API_KEY?.trim() || '';
      base = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
    }
    if (key && base && !base.startsWith('mock://')) {
      embedder = new Embedder({
        apiKey: key,
        baseUrl: base,
        model: config.llm.embeddingModel,
        dimensions: config.llm.embeddingDimensions,
      });
    }
  }

  const memory = new MemoryService({db, config, embedder});
  const conversations = new ConversationStore(db);
  const tasks = new TaskService({db, config});
  const documents = new DocumentIndex({db, config, policy, embedder});

  return {
    config,
    db,
    secrets,
    policy,
    audit,
    memory,
    conversations,
    tasks,
    documents,
    embedder,
    shutdown: () => db.close(),
  };
}

export function createAppOptions(globals: CliGlobalOptions): {
  home?: string;
  connectMcp?: boolean;
  configOverrides?: Record<string, unknown>;
} {
  return {
    home: globals.home,
    connectMcp: globals.mcp !== false,
    configOverrides: globals.verbose ? {logging: {level: 'debug'}} : undefined,
  };
}

export function isAutoApprove(globals: CliGlobalOptions): boolean {
  return globals.yes === true;
}
