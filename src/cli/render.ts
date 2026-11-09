import type {Interface as ReadlineInterface} from 'node:readline/promises';
import pc from 'picocolors';
import type {AgentEvent} from '../agent/agent.js';
import type {ApprovalRequest} from '../tools/types.js';
import type {App} from '../core/app.js';
import {describeModel} from '../core/app.js';
import {formatInTz} from '../core/time.js';

export interface RendererOptions {
  showReasoning?: boolean;
  showUsage?: boolean;
}

export interface Renderer {
  handle(event: AgentEvent): void;
  finish(): void;
}

export function createRenderer(options: RendererOptions = {}): Renderer {
  let atLineStart = true;
  let sawText = false;

  const write = (text: string): void => {
    if (!text) return;
    process.stdout.write(text);
    atLineStart = text.endsWith('\n');
    sawText = true;
  };
  const ensureNewline = (): void => {
    if (!atLineStart) {
      process.stdout.write('\n');
      atLineStart = true;
    }
  };

  return {
    handle(event) {
      switch (event.type) {
        case 'text':
          write(event.text);
          break;
        case 'reasoning':
          if (options.showReasoning) {
            ensureNewline();
            process.stderr.write(pc.dim(event.text));
          }
          break;
        case 'tool_start': {
          ensureNewline();
          const detail = compactArgs(event.args);
          process.stderr.write(pc.dim(`  · ${event.name}${detail ? ` ${detail}` : ''}\n`));
          break;
        }
        case 'tool_end': {
          ensureNewline();
          const mark = event.ok ? pc.green('✓') : pc.red('✗');
          const summary = event.summary ? ` ${event.summary}` : '';
          process.stderr.write(pc.dim(`  ${mark} ${event.name}${summary} ${pc.dim(`(${event.durationMs}ms)`)}\n`));
          break;
        }
        case 'usage':
          if (options.showUsage) {
            ensureNewline();
            process.stderr.write(
              pc.dim(`  tokens ↑${event.usage.inputTokens} ↓${event.usage.outputTokens}\n`),
            );
          }
          break;
        case 'error':
          ensureNewline();
          process.stderr.write(`${pc.red('error:')} ${event.message}\n`);
          break;
        case 'done':
          ensureNewline();
          break;
        case 'start':
          break;
      }
    },
    finish() {
      if (sawText) ensureNewline();
    },
  };
}

export async function askApproval(rl: ReadlineInterface, request: ApprovalRequest): Promise<boolean> {
  process.stdout.write(
    [
      '',
      `${pc.yellow('Approval required')} · ${pc.bold(request.tool)} ${pc.dim(`(${request.risk})`)}`,
      `  ${request.summary}`,
      pc.dim(`  ${request.reason}`),
      pc.dim(`  args: ${JSON.stringify(request.args).slice(0, 600)}`),
    ].join('\n') + '\n',
  );
  const answer = await rl.question(`  ${pc.bold('Allow?')} [y/N] `).catch(() => '');
  return /^y(es)?$/i.test(answer.trim());
}

export function printBanner(app: App): void {
  const config = app.config;
  const configured = app.integrations.status().filter((entry) => entry.configured).length;
  process.stdout.write(
    [
      '',
      `${pc.bold(pc.cyan(config.assistant.name))} ${pc.dim('v1.0 · personal assistant')}`,
      pc.dim(`${describeModel(app)} · ${config.assistant.timezone} · ${app.registry.count()} tools · ${configured} integrations`),
      pc.dim(`${app.memory.count()} memories · ${app.memory.getProfile({limit: 1000}).length} profile facts · ${app.tasks.list({limit: 500}).length} open tasks`),
      pc.dim('Type /help for commands, Ctrl+C to interrupt.'),
      '',
    ].join('\n') + '\n',
  );
}

export function printHelp(): void {
  process.stdout.write(
    [
      '',
      pc.bold('Commands'),
      '  /help                 show this help',
      '  /tools                list available tools',
      '  /status               model, memory, tasks and integrations',
      '  /memories [query]     list or search long-term memory',
      '  /remember <text>      store something in long-term memory',
      '  /profile              show what JARVIS knows about you',
      '  /tasks                list open tasks and reminders',
      '  /new                  start a new conversation',
      '  /conversations        list recent conversations',
      '  /resume <id>          switch to an existing conversation',
      '  /integrations         integration status',
      '  /auto on|off          toggle auto-approval of reversible actions',
      '  /model                show the active model',
      '  /quit                 exit',
      '',
    ].join('\n') + '\n',
  );
}

export function printIntegrations(app: App): void {
  const rows = app.integrations.status();
  process.stdout.write(`\n${pc.bold('Integrations')}\n`);
  for (const row of rows) {
    const mark = row.configured ? pc.green('ready') : pc.dim('off');
    process.stdout.write(`  ${mark.padEnd(14)} ${pc.bold(row.label)} ${pc.dim(row.detail)}\n`);
  }
  const mcp = app.mcp.list();
  if (mcp.length) {
    process.stdout.write(`  ${pc.green('ready')}          ${pc.bold('MCP')} ${pc.dim(mcp.map((server) => `${server.name} (${server.tools} tools)`).join(', '))}\n`);
  }
  process.stdout.write('\n');
}

export function printStatus(app: App): void {
  const counts = {
    memories: app.memory.count(),
    facts: app.memory.getProfile({limit: 1000}).length,
    conversations: app.conversations.list(500).length,
    tasks: app.tasks.list({limit: 500}).length,
    documents: app.documents.stats(),
  };
  process.stdout.write(
    [
      '',
      `${pc.bold('Status')} ${pc.dim(formatInTz(new Date(), app.config.assistant.timezone, {dateStyle: 'medium', timeStyle: 'short'}))}`,
      `  model         ${describeModel(app)}`,
      `  provider      ${app.config.llm.provider} · approval ${app.config.security.approvalMode}`,
      `  memory        ${counts.memories} memories · ${counts.facts} profile facts`,
      `  conversations ${counts.conversations}`,
      `  tasks         ${counts.tasks} open`,
      `  documents     ${counts.documents.documents} files · ${counts.documents.chunks} chunks · ${counts.documents.embedded} embedded`,
      `  tools         ${app.registry.count()}`,
      `  audit         ${app.audit.count()} entries`,
      `  timezone      ${app.config.assistant.timezone}`,
      '',
    ].join('\n') + '\n',
  );
}

export function printToolList(app: App): void {
  process.stdout.write(`\n${pc.bold(`Tools (${app.registry.count()})`)}\n${app.registry.describeText()}\n\n`);
}

export function printProfile(app: App): void {
  const facts = app.memory.getProfile({limit: 300});
  if (!facts.length) {
    process.stdout.write(pc.dim('\nNo profile facts yet. Tell JARVIS about yourself or use /remember.\n\n'));
    return;
  }
  process.stdout.write(`\n${pc.bold(`Profile (${facts.length} facts)`)}\n`);
  for (const fact of facts) {
    process.stdout.write(`  ${pc.cyan(fact.category)}/${fact.key}: ${fact.value} ${pc.dim(`(${fact.confidence.toFixed(2)})`)}\n`);
  }
  process.stdout.write('\n');
}

export function printTasks(app: App): void {
  const tasks = app.tasks.list({limit: 40});
  if (!tasks.length) {
    process.stdout.write(pc.dim('\nNo open tasks.\n\n'));
    return;
  }
  process.stdout.write(`\n${pc.bold(`Open tasks (${tasks.length})`)}\n`);
  for (const task of tasks) process.stdout.write(`  ${app.tasks.format(task)}\n`);
  process.stdout.write('\n');
}

function compactArgs(args: Record<string, unknown>): string {
  const pieces: string[] = [];
  for (const key of ['query', 'path', 'command', 'url', 'title', 'to', 'summary', 'id']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) pieces.push(`${key}=${value.length > 60 ? `${value.slice(0, 57)}…` : value}`);
  }
  return pieces.length ? pc.dim(`(${pieces.join(', ')})`) : '';
}
