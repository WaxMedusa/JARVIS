import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {createHarness, type Harness} from './helpers.js';
import {memoryTools} from '../src/tools/memory-tools.js';

let harness: Harness | undefined;

afterEach(() => {
  harness?.shutdown();
  harness = undefined;
});

describe('ToolRegistry', () => {
  it('validates arguments and reports unknown tools', async () => {
    harness = createHarness();
    harness.registry.register({
      name: 'echo',
      description: 'Echo',
      schema: z.object({text: z.string()}),
      risk: 'read',
      category: 'test',
      handler: (args) => ({content: args.text}),
    });
    const ok = await harness.registry.execute('echo', {text: 'hello'}, harness.context());
    expect(ok.ok).toBe(true);
    expect(ok.content).toBe('hello');

    const invalid = await harness.registry.execute('echo', {text: 5}, harness.context());
    expect(invalid.ok).toBe(false);
    expect(invalid.content).toContain('validation failed');

    const missing = await harness.registry.execute('nope', {}, harness.context());
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain('Unknown tool');
  });

  it('denies tools outside the path jail', async () => {
    harness = createHarness();
    harness.registry.register({
      name: 'read_path',
      description: 'read',
      schema: z.object({path: z.string()}),
      risk: 'read',
      category: 'test',
      handler: (args) => ({content: args.path}),
    });
    const result = await harness.registry.execute('read_path', {path: '/etc/passwd'}, harness.context());
    expect(result.ok).toBe(false);
    expect(result.denied).toBe(true);
  });

  it('asks for approval when the policy requires it', async () => {
    harness = createHarness({overrides: {security: {approvalMode: 'strict', allowedPaths: []}}});
    const requested = vi.fn(async () => true);
    harness.registry.register({
      name: 'write_thing',
      description: 'write',
      schema: z.object({value: z.string()}),
      risk: 'write',
      category: 'test',
      handler: (args) => ({content: `wrote ${args.value}`}),
    });
    const result = await harness.registry.execute('write_thing', {value: 'x'}, harness.context({requestApproval: requested}));
    expect(requested).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);

    const denied = await harness.registry.execute('write_thing', {value: 'y'}, harness.context({requestApproval: async () => false}));
    expect(denied.ok).toBe(false);
    expect(denied.denied).toBe(true);
  });
});

describe('Agent loop', () => {
  it('executes a tool, stores the transcript and answers', async () => {
    harness = createHarness({
      overrides: {security: {approvalMode: 'autonomous', allowedPaths: []}},
      script: [
        {
          toolCalls: [
            {
              id: 'call_1',
              name: 'remember',
              arguments: JSON.stringify({content: 'The user loves espresso', importance: 0.8}),
            },
          ],
        },
        {text: 'Noted — you love espresso.'},
      ],
    });
    harness.registry.registerMany(memoryTools);

    const events = [];
    for await (const event of harness.agent.run({message: 'Remember that I love espresso', channel: 'test'})) {
      events.push(event);
    }
    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    expect(done && 'text' in done ? done.text : '').toContain('espresso');
    expect(harness.memory.count()).toBe(1);

    const conversations = harness.conversations.list(5);
    const transcript = harness.conversations.messages(conversations[0]!.id);
    expect(transcript.some((message) => message.role === 'user')).toBe(true);
    expect(transcript.some((message) => message.role === 'tool')).toBe(true);
    expect(transcript.some((message) => message.role === 'assistant' && message.content?.includes('espresso'))).toBe(true);
  });

  it('stops repeated identical tool calls', async () => {
    const repeated = {
      toolCalls: [{id: 'call_x', name: 'recall', arguments: JSON.stringify({query: 'anything'})}],
    };
    harness = createHarness({
      script: [repeated, repeated, repeated, repeated, {text: 'Stopped.'}],
      overrides: {security: {approvalMode: 'autonomous', allowedPaths: []}, llm: {maxSteps: 6}},
    });
    harness.registry.registerMany(memoryTools);
    const result = await harness.agent.runToCompletion({message: 'Loop please', channel: 'test'});
    expect(result.steps).toBeLessThanOrEqual(6);
    const conversation = harness.conversations.list(1)[0]!;
    const toolMessages = harness.conversations.messages(conversation.id).filter((message) => message.role === 'tool');
    expect(toolMessages.some((message) => message.content?.includes('Do not repeat'))).toBe(true);
  });

  it('returns a clean error when the model fails', async () => {
    harness = createHarness({script: [{error: 'provider exploded'}]});
    const events = [];
    for await (const event of harness.agent.run({message: 'hello', channel: 'test'})) events.push(event);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });
});
