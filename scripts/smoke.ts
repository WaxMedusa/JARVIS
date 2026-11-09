/**
 * Offline end-to-end smoke test. Runs the real agent loop, registry, SQLite
 * memory and audit chain against a scripted mock model — no network, no keys.
 *
 *   npm run smoke
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/core/app.js';
import {MockProvider} from '../src/llm/mock.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-smoke-'));
const mock = new MockProvider([
  {
    text: 'Let me store that.',
    toolCalls: [
      {
        id: 'call_smoke_1',
        name: 'remember',
        arguments: JSON.stringify({content: 'The user is testing JARVIS offline with a mock model.', importance: 0.4, kind: 'event'}),
      },
      {
        id: 'call_smoke_2',
        name: 'create_task',
        arguments: JSON.stringify({title: 'Review the JARVIS smoke test', due_at: null, priority: 3}),
      },
    ],
  },
  {
    text: 'All systems operational. I stored a memory and created a task. The audit chain and SQLite store are working.',
  },
]);

const app = await createApp({
  home,
  connectMcp: false,
  llmSet: {main: mock, small: mock, embedder: null},
  configOverrides: {
    llm: {provider: 'mock', model: 'mock-1', embeddings: false},
    memory: {extractFacts: false, autoIndexVault: false},
    security: {approvalMode: 'autonomous'},
    proactive: {enabled: false, morningBrief: '', eveningReview: ''},
    logging: {level: 'warn'},
  },
});

try {
  console.log(`home: ${home}`);
  console.log(`tools: ${app.registry.count()}`);
  console.log(`\n> user: Run the offline smoke test.`);

  for await (const event of app.agent.run({message: 'Run the offline smoke test and save a memory plus a task.', channel: 'smoke'})) {
    if (event.type === 'text') process.stdout.write(event.text);
    if (event.type === 'tool_start') process.stdout.write(`\n  → ${event.name} ${JSON.stringify(event.args).slice(0, 120)}\n`);
    if (event.type === 'tool_end') process.stdout.write(`  ${event.ok ? '✓' : '✗'} ${event.name} (${event.durationMs}ms)\n`);
    if (event.type === 'error') process.stdout.write(`\n  error: ${event.message}\n`);
  }

  const memories = app.memory.list({limit: 5});
  const tasks = app.tasks.list({limit: 5});
  const audit = app.audit.verify(1000);
  console.log('\n');
  console.log(`memories: ${memories.length}${memories[0] ? ` — ${memories[0].content}` : ''}`);
  console.log(`tasks:    ${tasks.length}${tasks[0] ? ` — ${tasks[0].title}` : ''}`);
  console.log(`audit:    ${audit.ok ? `intact (${audit.checked} entries)` : 'BROKEN'}`);
  console.log(`db:       ${app.config.paths.db}`);

  if (memories.length !== 1 || tasks.length !== 1 || !audit.ok) {
    console.error('\nSMOKE TEST FAILED');
    process.exitCode = 1;
  } else {
    console.log('\nSMOKE TEST PASSED');
  }
} finally {
  await app.shutdown();
  fs.rmSync(home, {recursive: true, force: true});
}
