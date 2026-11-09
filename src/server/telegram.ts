import type {JarvisConfig} from '../config.js';
import type {JarvisDB} from '../db/database.js';
import type {Agent} from '../agent/agent.js';
import {errorMessage} from '../core/errors.js';
import {getLogger, type Logger} from '../core/logger.js';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: {id: number; type: string};
    from?: {id: number; first_name?: string; username?: string};
    text?: string;
    date: number;
  };
}

/** Phone access: allowlisted Telegram chats map to per-chat conversations. */
export class TelegramBot {
  private readonly config: JarvisConfig;
  private readonly db: JarvisDB;
  private readonly agent: Agent;
  private readonly logger: Logger = getLogger().child('telegram');
  private stopped = true;
  private offset = 0;
  private backoff = 0;

  constructor(options: {config: JarvisConfig; db: JarvisDB; agent: Agent}) {
    this.config = options.config;
    this.db = options.db;
    this.agent = options.agent;
    this.offset = Number(this.db.kvGet('telegram:offset') ?? 0);
  }

  start(): void {
    if (!this.config.integrations.telegram.botToken || !this.config.integrations.telegram.enabled) return;
    if (this.stopped === false) return;
    this.stopped = false;
    this.logger.info('Telegram bot started', {allowedChats: this.config.integrations.telegram.allowedChatIds.length});
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.poll();
        this.backoff = 0;
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          this.db.kvSet('telegram:offset', String(this.offset));
          await this.handleUpdate(update);
        }
      } catch (error) {
        this.backoff = Math.min(this.backoff + 1, 6);
        this.logger.warn('Telegram poll failed', {error: errorMessage(error), retryIn: this.backoff});
        await new Promise((resolve) => setTimeout(resolve, this.backoff * 2000));
      }
    }
  }

  private async poll(): Promise<TelegramUpdate[]> {
    const token = this.config.integrations.telegram.botToken;
    const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${this.offset}&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`;
    const response = await fetch(url, {signal: AbortSignal.timeout(40_000)});
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
    const payload = (await response.json()) as {ok: boolean; result?: TelegramUpdate[]; description?: string};
    if (!payload.ok) throw new Error(payload.description ?? 'Telegram API error');
    return payload.result ?? [];
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text) return;
    const chatId = String(message.chat.id);
    const allowed = this.config.integrations.telegram.allowedChatIds;
    if (!allowed.includes(chatId)) {
      if (message.text.trim() === '/start') {
        await this.send(chatId, `This assistant is private. Your chat id is ${chatId}. Add it to TELEGRAM_ALLOWED_CHAT_IDS to authorize this chat.`);
        this.logger.warn('unauthorized telegram chat', {chatId, username: message.from?.username});
      }
      return;
    }

    const text = message.text.trim();
    if (text === '/start' || text === '/help') {
      await this.send(chatId, `JARVIS online.\n\nSend any message to talk. Commands:\n/tasks — open tasks\n/new — start a new conversation\n/status — system status\n/help — this message`);
      return;
    }
    if (text === '/new') {
      this.db.kvDelete(`telegram:conv:${chatId}`);
      await this.send(chatId, 'New conversation started.');
      return;
    }
    if (text === '/tasks') {
      const tasks = this.db.all<{title: string; due_at: string | null}>(
        "SELECT title, due_at FROM tasks WHERE status = 'open' ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC LIMIT 12",
      );
      await this.send(
        chatId,
        tasks.length ? tasks.map((task) => `- ${task.title}${task.due_at ? ` (due ${task.due_at.slice(0, 16).replace('T', ' ')})` : ''}`).join('\n') : 'No open tasks.',
      );
      return;
    }

    const conversationId = this.db.kvGet(`telegram:conv:${chatId}`) ?? undefined;
    await this.sendTyping(chatId);
    try {
      const result = await this.agent.runToCompletion({
        message: text,
        conversationId,
        channel: `telegram:${chatId}`,
        consolidate: true,
      });
      if (result.conversationId) this.db.kvSet(`telegram:conv:${chatId}`, result.conversationId);
      for (const chunk of chunkText(result.text || '(no response)', 3800)) {
        await this.send(chatId, chunk);
      }
    } catch (error) {
      await this.send(chatId, `Sorry — that failed: ${errorMessage(error)}`);
    }
  }

  private async send(chatId: string, text: string): Promise<void> {
    const token = this.config.integrations.telegram.botToken;
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({chat_id: chatId, text, disable_web_page_preview: true}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) this.logger.warn('telegram send failed', {status: response.status});
  }

  private async sendTyping(chatId: string): Promise<void> {
    const token = this.config.integrations.telegram.botToken;
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({chat_id: chatId, action: 'typing'}),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = remaining.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
