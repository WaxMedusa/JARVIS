import type {z} from 'zod';
import type {JarvisConfig, RiskLevel} from '../config.js';
import type {Logger} from '../core/logger.js';
import type {JarvisDB} from '../db/database.js';
import type {IntegrationHub} from '../integrations/types.js';
import type {Embedder} from '../llm/embeddings.js';
import type {LLMSet} from '../llm/index.js';
import type {AuditLog} from '../security/audit.js';
import type {Policy} from '../security/policy.js';
import type {SecretStore} from '../security/secrets.js';
import type {ConversationStore} from '../memory/conversations.js';
import type {DocumentIndex} from '../memory/documents.js';
import type {MemoryService} from '../memory/memory.js';
import type {NoteService} from '../memory/notes.js';
import type {TaskService} from '../memory/tasks.js';

export interface ApprovalRequest {
  tool: string;
  risk: RiskLevel;
  summary: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Short human-facing label shown in the CLI while streaming. */
  summary?: string;
  data?: unknown;
}

export interface Notifier {
  send(notification: {title: string; body: string; channel?: string; meta?: Record<string, unknown>}): Promise<void>;
}

export interface DelegationRequest {
  task: string;
  context?: string;
  maxSteps?: number;
}

export interface ToolContext {
  config: JarvisConfig;
  db: JarvisDB;
  logger: Logger;
  memory: MemoryService;
  notes: NoteService;
  conversations: ConversationStore;
  tasks: TaskService;
  documents: DocumentIndex;
  policy: Policy;
  audit: AuditLog;
  secrets: SecretStore;
  llm: LLMSet;
  embedder: Embedder | null;
  integrations: IntegrationHub;
  notifier: Notifier;
  /** Optional research sub-agent supplied by the runtime. */
  delegate?: (request: DelegationRequest) => Promise<string>;
  channel: string;
  conversationId: string;
  signal?: AbortSignal;
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: TSchema;
  risk: RiskLevel;
  category: string;
  timeoutMs?: number;
  /** Extra guidance appended to the tool description for the model. */
  usage?: string;
  /** Pre-built JSON Schema (used by MCP tools whose schema is not zod). */
  jsonSchema?: Record<string, unknown>;
  handler: (args: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult | string> | ToolResult | string;
}

export function defineTool<TSchema extends z.ZodType>(definition: ToolDefinition<TSchema>): ToolDefinition<TSchema> {
  return definition;
}

export interface ToolExecution {
  tool: string;
  ok: boolean;
  content: string;
  summary?: string;
  durationMs: number;
  denied?: boolean;
  args: Record<string, unknown>;
}
