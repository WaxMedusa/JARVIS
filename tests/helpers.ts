import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {loadConfig, type JarvisConfig} from '../src/config.js';
import {JarvisDB} from '../src/db/database.js';
import {MemoryService} from '../src/memory/memory.js';
import {ConversationStore} from '../src/memory/conversations.js';
import {TaskService} from '../src/memory/tasks.js';
import {DocumentIndex} from '../src/memory/documents.js';
import {Consolidator} from '../src/memory/consolidation.js';
import {Policy} from '../src/security/policy.js';
import {AuditLog} from '../src/security/audit.js';
import {SecretStore} from '../src/security/secrets.js';
import {MockProvider, type MockTurn} from '../src/llm/mock.js';
import type {LLMSet} from '../src/llm/index.js';
import {ContextBuilder} from '../src/agent/context.js';
import {Agent} from '../src/agent/agent.js';
import {ToolRegistry} from '../src/tools/registry.js';
import type {IntegrationHub, IntegrationServices} from '../src/integrations/types.js';
import type {Notifier, ToolContext} from '../src/tools/types.js';
import {getLogger} from '../src/core/logger.js';

export interface Harness {
  home: string;
  config: JarvisConfig;
  db: JarvisDB;
  policy: Policy;
  audit: AuditLog;
  secrets: SecretStore;
  memory: MemoryService;
  conversations: ConversationStore;
  tasks: TaskService;
  documents: DocumentIndex;
  llm: LLMSet;
  registry: ToolRegistry;
  agent: Agent;
  conversationId: string;
  context(overrides?: Partial<ToolContext>): ToolContext;
  shutdown(): void;
}

export function createHarness(options: {script?: MockTurn[]; overrides?: Record<string, unknown>} = {}): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
  const config = loadConfig({
    home,
    skipFile: true,
    env: {...process.env, JARVIS_LLM_PROVIDER: 'mock', JARVIS_EMBEDDINGS: 'false'},
    overrides: {
      security: {approvalMode: 'autonomous', allowedPaths: [home]},
      memory: {extractFacts: false, autoIndexVault: false},
      llm: {embeddings: false},
      proactive: {enabled: false, morningBrief: '', eveningReview: ''},
      ...(options.overrides ?? {}),
    },
  });

  const db = new JarvisDB(config.paths.db);
  const policy = new Policy(config);
  const audit = new AuditLog(db, true);
  const secrets = new SecretStore(config.paths.secrets, {keyPath: config.paths.masterKey});
  const memory = new MemoryService({db, config, embedder: null});
  const conversations = new ConversationStore(db);
  const tasks = new TaskService({db, config});
  const documents = new DocumentIndex({db, config, policy, embedder: null});
  const mock = new MockProvider(
    options.script ?? [
      {toolCalls: [{id: 'call_1', name: 'remember', arguments: JSON.stringify({content: 'The user loves espresso', importance: 0.8})}]},
      {text: 'Noted — you love espresso.'},
    ],
  );
  const llm: LLMSet = {main: mock, small: mock, embedder: null};
  const consolidator = new Consolidator({config, db, memory, conversations, tasks, llm});
  const integrations: IntegrationHub = {
    services: {google: null, notion: null, github: null, homeAssistant: null, linear: null, email: null, supabase: null, rss: null} as unknown as IntegrationServices,
    status: () => [],
    has: () => false,
  };
  const notifier: Notifier = {send: async () => undefined};
  const registry = new ToolRegistry();
  const context = new ContextBuilder({config, memory, conversations, tasks, documents});
  const agent = new Agent({
    config,
    db,
    logger: getLogger(),
    memory,
    conversations,
    tasks,
    documents,
    policy,
    audit,
    secrets,
    llm,
    embedder: null,
    integrations,
    notifier,
    registry,
    consolidator,
    context,
  });

  const conversation = conversations.create('test');
  const toolContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    config,
    db,
    logger: getLogger(),
    memory,
    conversations,
    tasks,
    documents,
    policy,
    audit,
    secrets,
    llm,
    embedder: null,
    integrations,
    notifier,
    channel: 'test',
    conversationId: conversation.id,
    ...overrides,
  });

  return {
    home,
    config,
    db,
    policy,
    audit,
    secrets,
    memory,
    conversations,
    tasks,
    documents,
    llm,
    registry,
    agent,
    conversationId: conversation.id,
    context: toolContext,
    shutdown() {
      db.close();
      fs.rmSync(home, {recursive: true, force: true});
    },
  };
}

export const testEchoTool = {
  name: 'echo',
  description: 'Echo text',
  schema: z.object({text: z.string()}),
  risk: 'read' as const,
  category: 'test',
  handler: (args: {text: string}) => ({content: args.text}),
};
