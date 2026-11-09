import {ImapFlow} from 'imapflow';
import nodemailer from 'nodemailer';
import {simpleParser} from 'mailparser';
import {JarvisError} from '../core/errors.js';
import {stripHtml} from '../core/http.js';
import type {EmailService} from './types.js';

export interface EmailConfig {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  from: string;
  secure: boolean;
}

export class EmailClient implements EmailService {
  private readonly config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  static create(config: EmailConfig): EmailClient | null {
    return config.imapHost && config.imapUser && config.imapPassword ? new EmailClient(config) : null;
  }

  private async withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: true,
      auth: {user: this.config.imapUser, pass: this.config.imapPassword},
      logger: false,
      socketTimeout: 30_000,
    } as never);
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      return await fn(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async search(query: string, limit = 10): Promise<Array<{uid: number; from?: string; subject?: string; date?: string; seen?: boolean}>> {
    return this.withImap(async (client) => {
      const uids = (await client.search({or: [{subject: query}, {from: query}, {body: query}]} as never)) || [];
      const selected = uids.slice(-Math.min(limit, 30));
      return this.fetchSummaries(client, selected);
    });
  }

  async recent(limit = 10): Promise<Array<{uid: number; from?: string; subject?: string; date?: string; seen?: boolean}>> {
    return this.withImap(async (client) => {
      const uids = (await client.search({all: true} as never)) || [];
      return this.fetchSummaries(client, uids.slice(-Math.min(limit, 30)));
    });
  }

  private async fetchSummaries(client: ImapFlow, uids: number[]): Promise<Array<{uid: number; from?: string; subject?: string; date?: string; seen?: boolean}>> {
    const output: Array<{uid: number; from?: string; subject?: string; date?: string; seen?: boolean}> = [];
    for await (const message of client.fetch(uids, {envelope: true, flags: true}, {uid: true})) {
      output.push({
        uid: Number(message.uid),
        from: message.envelope?.from?.[0]?.address ?? undefined,
        subject: message.envelope?.subject ?? '(no subject)',
        date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : undefined,
        seen: message.flags?.has('\\Seen') ?? false,
      });
    }
    return output.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')).reverse();
  }

  async read(uid: number): Promise<{uid: number; from?: string; to?: string; subject?: string; date?: string; text: string}> {
    return this.withImap(async (client) => {
      const message = await client.fetchOne(String(uid), {source: true}, {uid: true});
      if (!message || !message.source) throw new JarvisError('NOT_FOUND', `Email ${uid} not found`);
      const parsed = await simpleParser(message.source);
      const text = parsed.text ?? (parsed.html ? stripHtml(String(parsed.html)) : '');
      return {
        uid,
        from: parsed.from?.text ?? undefined,
        to: Array.isArray(parsed.to) ? parsed.to.map((address) => address.text).join(', ') : parsed.to?.text ?? undefined,
        subject: parsed.subject ?? '(no subject)',
        date: parsed.date?.toISOString(),
        text: text.slice(0, 60_000),
      };
    });
  }

  async send(args: {to: string[]; subject: string; body: string; cc?: string[]}): Promise<void> {
    if (!this.config.smtpHost) throw new JarvisError('CONFIG', 'SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD).');
    const transport = nodemailer.createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.secure,
      auth: this.config.smtpUser ? {user: this.config.smtpUser, pass: this.config.smtpPassword} : undefined,
    });
    await transport.sendMail({
      from: this.config.from || this.config.smtpUser,
      to: args.to.join(', '),
      cc: args.cc?.join(', '),
      subject: args.subject,
      text: args.body,
    });
  }
}
