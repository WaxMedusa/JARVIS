import fs from 'node:fs';
import path from 'node:path';
import {redact, redactDeep} from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {debug: 10, info: 20, warn: 30, error: 40, silent: 100};

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
  level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  file?: string;
  pretty?: boolean;
  maxFileBytes?: number;
}

export class StructuredLogger implements Logger {
  readonly level: LogLevel;
  private readonly scope: string;
  private readonly file?: string;
  private readonly pretty: boolean;
  private readonly maxFileBytes: number;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.scope = options.scope ?? 'jarvis';
    this.file = options.file;
    this.pretty = options.pretty ?? Boolean(process.stderr.isTTY);
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  }

  child(scope: string): Logger {
    return new StructuredLogger({
      level: this.level,
      scope: `${this.scope}:${scope}`,
      file: this.file,
      pretty: this.pretty,
      maxFileBytes: this.maxFileBytes,
    });
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const timestamp = new Date().toISOString();
    const safeMessage = redact(message);
    const safeMeta = meta ? redactDeep(meta) : undefined;

    let line: string;
    if (this.pretty) {
      const metaText = safeMeta && Object.keys(safeMeta).length ? ` ${safeJson(safeMeta)}` : '';
      line = `${timestamp} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${safeMessage}${metaText}`;
    } else {
      line = JSON.stringify({ts: timestamp, level, scope: this.scope, msg: safeMessage, ...(safeMeta ?? {})});
    }

    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // stderr can be closed in daemonized environments; never crash on logging.
    }

    if (this.file) this.appendToFile(line);
  }

  private appendToFile(line: string): void {
    try {
      fs.mkdirSync(path.dirname(this.file!), {recursive: true});
      try {
        const stat = fs.statSync(this.file!);
        if (stat.size > this.maxFileBytes) {
          fs.renameSync(this.file!, `${this.file}.1`);
        }
      } catch {
        // file does not exist yet
      }
      fs.appendFileSync(this.file!, `${line}\n`, {mode: 0o600});
    } catch {
      // Logging must never take the assistant down.
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

let globalLogger: Logger = new StructuredLogger({level: 'silent'});

export function setLogger(logger: Logger): void {
  globalLogger = logger;
}

export function getLogger(): Logger {
  return globalLogger;
}

/** Convenience for one-off logs before configuration is loaded. */
export const nullLogger: Logger = {
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
