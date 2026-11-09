import type {JarvisConfig} from '../config.js';
import type {ConversationStore} from '../memory/conversations.js';
import type {DocumentIndex} from '../memory/documents.js';
import type {MemoryService} from '../memory/memory.js';
import type {TaskService} from '../memory/tasks.js';
import type {MemoryHit} from '../memory/types.js';
import type {LLMMessage} from '../llm/types.js';
import {buildSystemPrompt} from './prompts.js';
import {getLogger} from '../core/logger.js';

export interface ContextInput {
  conversationId: string;
  channel: string;
  userMessage: string;
  toolNames: string[];
  integrationSummary: string;
  extraInstructions?: string;
}

export interface BuiltContext {
  system: string;
  messages: LLMMessage[];
  memoryHits: MemoryHit[];
  estimatedTokens: number;
}

/**
 * Assembles everything the model needs each step: persona, profile, relevant
 * memories, tasks, integration status, summary and recent transcript.
 */
export class ContextBuilder {
  private readonly config: JarvisConfig;
  private readonly memory: MemoryService;
  private readonly conversations: ConversationStore;
  private readonly tasks: TaskService;
  private readonly documents: DocumentIndex;

  constructor(options: {config: JarvisConfig; memory: MemoryService; conversations: ConversationStore; tasks: TaskService; documents: DocumentIndex}) {
    this.config = options.config;
    this.memory = options.memory;
    this.conversations = options.conversations;
    this.tasks = options.tasks;
    this.documents = options.documents;
  }

  async build(input: ContextInput): Promise<BuiltContext> {
    const conversation = this.conversations.get(input.conversationId);
    const [profileBlock, recall, taskBlock] = await Promise.all([
      this.memory.profileBlock(4000).catch(() => ''),
      this.memory.contextBlock(input.userMessage).catch(() => ({text: '', hits: [] as MemoryHit[]})),
      Promise.resolve(this.tasks.taskBlock(12)),
    ]);

    const system = buildSystemPrompt({
      config: this.config,
      now: new Date(),
      profileBlock,
      memoryBlock: recall.text,
      taskBlock,
      integrationSummary: input.integrationSummary,
      channel: input.channel,
      documentStats: this.safeDocumentStats(),
      toolNames: input.toolNames,
      extraInstructions: input.extraInstructions,
    });

    const sinceRow = conversation?.summary_upto_message_row ?? 0;
    const rows = conversation ? this.conversations.recent(input.conversationId, 60, sinceRow) : [];
    let history = this.conversations.toLLMMessages(rows);
    history = trimToUserBoundary(history);

    const messages: LLMMessage[] = [];
    if (conversation?.summary) {
      messages.push({role: 'system', content: `Summary of the conversation before this point:\n${conversation.summary}`});
    }
    messages.push(...history);
    if (!messages.some((message) => message.role === 'user' || message.role === 'tool')) {
      messages.push({role: 'user', content: input.userMessage});
    }

    const estimatedTokens = estimateTokens(system) + messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    return {system, messages, memoryHits: recall.hits, estimatedTokens};
  }

  /** Full message list for a provider request. */
  static withSystem(system: string, messages: LLMMessage[]): LLMMessage[] {
    return [{role: 'system', content: system}, ...messages];
  }

  private safeDocumentStats(): {documents: number; chunks: number} | undefined {
    try {
      const stats = this.documents.stats();
      return {documents: stats.documents, chunks: stats.chunks};
    } catch (error) {
      getLogger().debug('document stats unavailable', {error: (error as Error).message});
      return undefined;
    }
  }
}

/** Drop leading partial turns so history always begins at a user message. */
export function trimToUserBoundary(messages: LLMMessage[]): LLMMessage[] {
  const index = messages.findIndex((message) => message.role === 'user');
  if (index <= 0) return messages;
  return messages.slice(index);
}

export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}
