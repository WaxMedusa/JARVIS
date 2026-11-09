import type {JarvisConfig} from '../config.js';
import {llmApiKey, llmBaseUrl} from '../config.js';
import {JarvisError} from '../core/errors.js';
import {getLogger} from '../core/logger.js';
import {AnthropicProvider} from './anthropic.js';
import {Embedder} from './embeddings.js';
import {MockProvider, type MockTurn} from './mock.js';
import {OpenAICompatProvider} from './openai.js';
import type {LLMProvider} from './types.js';

export interface LLMSet {
  main: LLMProvider;
  small: LLMProvider;
  embedder: Embedder | null;
}

export interface CreateLLMOptions {
  env?: NodeJS.ProcessEnv;
  /** Scripted turns only used by the mock provider. */
  mockTurns?: MockTurn[];
}

export function createLLM(config: JarvisConfig, options: CreateLLMOptions = {}): LLMSet {
  const env = options.env ?? process.env;
  const provider = config.llm.provider;

  if (provider === 'mock') {
    const scripted = options.mockTurns ?? parseMockScript(env.JARVIS_MOCK_SCRIPT);
    return {main: new MockProvider(scripted, config.llm.model || 'mock-1'), small: new MockProvider(scripted, 'mock-small'), embedder: null};
  }

  const apiKey = llmApiKey(config, env);
  const baseUrl = llmBaseUrl(config, env);
  const common = {
    model: config.llm.model,
    contextWindow: config.llm.contextWindow,
    temperature: config.llm.temperature,
    maxOutputTokens: config.llm.maxOutputTokens,
    retries: config.llm.retries,
    requestTimeoutMs: config.llm.requestTimeoutMs,
  };

  let main: LLMProvider;
  if (provider === 'anthropic') {
    main = new AnthropicProvider({apiKey, baseUrl, ...common});
  } else {
    main = new OpenAICompatProvider({
      apiKey,
      baseUrl,
      ...common,
      reasoningEffort: config.llm.reasoningEffort || undefined,
      providerLabel: provider,
    });
  }

  const small =
    config.llm.smallModel && config.llm.smallModel !== config.llm.model
      ? provider === 'anthropic'
        ? new AnthropicProvider({apiKey, baseUrl, ...common, model: config.llm.smallModel})
        : new OpenAICompatProvider({apiKey, baseUrl, ...common, model: config.llm.smallModel, providerLabel: provider})
      : main;

  let embedder: Embedder | null = null;
  if (config.llm.embeddings) {
    if (provider === 'anthropic') {
      const openaiKey = env.OPENAI_API_KEY?.trim();
      if (openaiKey) {
        embedder = new Embedder({
          apiKey: openaiKey,
          baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
          model: config.llm.embeddingModel,
          dimensions: config.llm.embeddingDimensions,
        });
      } else {
        getLogger().info('Anthropic provider selected without OPENAI_API_KEY: semantic recall disabled, keyword recall active');
      }
    } else if (apiKey) {
      embedder = new Embedder({
        apiKey,
        baseUrl,
        model: config.llm.embeddingModel,
        dimensions: config.llm.embeddingDimensions,
      });
    }
  }

  getLogger().info('LLM configured', {provider, model: config.llm.model, embeddings: Boolean(embedder?.available)});
  return {main, small, embedder};
}

export function assertLLMUsable(set: LLMSet): void {
  if (!set.main) throw new JarvisError('CONFIG', 'No LLM provider configured');
}

function parseMockScript(raw: string | undefined): MockTurn[] {
  if (!raw?.trim()) {
    return [
      {
        toolCalls: [
          {
            id: 'call_mock_1',
            name: 'remember',
            arguments: JSON.stringify({content: 'Demo memory created by the offline mock provider.', importance: 0.4}),
          },
        ],
      },
      {text: 'Understood. I have stored that in memory and all systems are operational.'},
    ];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as MockTurn[];
  } catch {
    // fall through
  }
  return [{text: raw}];
}
