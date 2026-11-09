import fs from 'node:fs';
import type {App} from '../core/app.js';
import {errorMessage} from '../core/errors.js';
import {Scheduler} from '../scheduler/scheduler.js';
import {startHttpServer} from './http.js';
import {TelegramBot} from './telegram.js';

/** Runs every long-lived component and waits for a termination signal. */
export async function runDaemon(app: App): Promise<void> {
  const scheduler = new Scheduler({
    config: app.config,
    db: app.db,
    tasks: app.tasks,
    agent: app.agent,
    notifier: app.notifier,
    consolidator: app.consolidator,
    documents: app.documents,
  });
  const telegram = new TelegramBot({config: app.config, db: app.db, agent: app.agent});
  let http: ReturnType<typeof startHttpServer> | undefined;

  try {
    http = startHttpServer(app);
    scheduler.start();
    telegram.start();
    fs.mkdirSync(app.config.paths.home, {recursive: true});
    fs.writeFileSync(
      app.config.paths.pidFile,
      JSON.stringify({pid: process.pid, started_at: new Date().toISOString(), port: app.config.server.port, host: app.config.server.host}),
      {mode: 0o600},
    );

    const base = `http://${app.config.server.host === '0.0.0.0' ? '127.0.0.1' : app.config.server.host}:${app.config.server.port}`;
    process.stdout.write(
      [
        `${app.config.assistant.name} is online.`,
        `  API:        ${base}/v1/chat (SSE)`,
        `  Health:     ${base}/health`,
        `  Status:     ${base}/v1/status`,
        `  Model:      ${app.config.llm.provider}/${app.llm.main.model}`,
        `  Tools:      ${app.registry.count()}`,
        `  Scheduler:  ${app.config.proactive.enabled ? 'enabled' : 'disabled'}`,
        `  Telegram:   ${app.config.integrations.telegram.botToken ? `enabled (${app.config.integrations.telegram.allowedChatIds.length} allowed chats)` : 'not configured'}`,
        `  Data:       ${app.config.paths.db}`,
        '',
        'Press Ctrl+C to stop.',
      ].join('\n') + '\n',
    );

    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    app.logger.info('shutting down');
    scheduler.stop();
    telegram.stop();
    if (http) await http.close().catch((error) => app.logger.warn('http close failed', {error: errorMessage(error)}));
    try {
      fs.unlinkSync(app.config.paths.pidFile);
    } catch {
      // already gone
    }
    await app.shutdown();
  }
}

export function readPidFile(path: string): {pid: number; started_at: string; port: number} | null {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8')) as {pid: number; started_at: string; port: number};
  } catch {
    return null;
  }
}
