import {execFile} from 'node:child_process';
import fs from 'node:fs';
import type {JarvisConfig} from '../config.js';
import {getLogger, type Logger} from '../core/logger.js';
import {fetchCapped} from '../core/http.js';
import type {Notifier} from '../tools/types.js';

export interface Notification {
  title: string;
  body: string;
  channel?: string;
  meta?: Record<string, unknown>;
}

/** Delivers proactive messages to every configured channel, best-effort. */
export class NotificationHub implements Notifier {
  private readonly config: JarvisConfig;
  private readonly logger: Logger = getLogger().child('notify');

  constructor(config: JarvisConfig) {
    this.config = config;
  }

  async send(notification: Notification): Promise<void> {
    const channels = notification.channel ? [notification.channel] : this.config.proactive.channels;
    const results = await Promise.allSettled(channels.map((channel) => this.dispatch(channel, notification)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') this.logger.warn('notification channel failed', {channel: channels[index], error: String(result.reason)});
    });
  }

  private async dispatch(channel: string, notification: Notification): Promise<void> {
    switch (channel) {
      case 'console':
        process.stdout.write(`\n[${notification.title}] ${notification.body}\n`);
        return;
      case 'webhook':
        await this.webhook(notification);
        return;
      case 'telegram':
        await this.telegram(notification);
        return;
      case 'desktop':
        await this.desktop(notification);
        return;
      case 'none':
        return;
      default:
        this.logger.warn('unknown notification channel', {channel});
    }
  }

  private async webhook(notification: Notification): Promise<void> {
    const url = this.config.proactive.webhookUrl;
    if (!url) throw new Error('No proactive.webhookUrl configured');
    await fetchCapped(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({title: notification.title, body: notification.body, meta: notification.meta, ts: new Date().toISOString()}),
      timeoutMs: 15_000,
      service: 'webhook',
    });
  }

  private async telegram(notification: Notification): Promise<void> {
    const token = this.config.integrations.telegram.botToken;
    const chats = this.config.integrations.telegram.allowedChatIds;
    if (!token || !chats.length) throw new Error('Telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS)');
    for (const chatId of chats) {
      await fetchCapped(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({chat_id: chatId, text: `${notification.title}\n\n${notification.body}`.slice(0, 4000)}),
        timeoutMs: 15_000,
        service: 'Telegram',
      });
    }
  }

  private async desktop(notification: Notification): Promise<void> {
    const title = notification.title.replace(/\n/g, ' ');
    const body = notification.body.replace(/\n/g, ' ');
    if (process.platform === 'darwin') {
      await run('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
      return;
    }
    if (process.platform === 'linux' && commandExists('notify-send')) {
      await run('notify-send', [title, body]);
      return;
    }
    throw new Error('Desktop notifications are not available on this platform');
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {timeout: 10_000}, (error) => (error ? reject(error) : resolve()));
  });
}

let notifySendAvailable: boolean | null = null;
function commandExists(command: string): boolean {
  if (command !== 'notify-send') return false;
  if (notifySendAvailable !== null) return notifySendAvailable;
  notifySendAvailable = ['/usr/bin/notify-send', '/usr/local/bin/notify-send'].some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  return notifySendAvailable;
}
