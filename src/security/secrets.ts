import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {JarvisError} from '../core/errors.js';

const AAD = 'jarvis-secrets-v1';

interface SecretFile {
  version: 1;
  iv: string;
  tag: string;
  data: string;
  updated_at: string;
}

/**
 * AES-256-GCM encrypted key/value store for OAuth refresh tokens and API keys.
 * The master key comes from JARVIS_MASTER_KEY or a local 0600 key file.
 */
export class SecretStore {
  private readonly filePath: string;
  private readonly keyPath: string;
  private cache: Record<string, string> | null = null;

  constructor(filePath: string, options: {keyPath?: string} = {}) {
    this.filePath = filePath;
    this.keyPath = options.keyPath ?? path.join(path.dirname(filePath), 'master.key');
  }

  get(key: string): string | undefined {
    return this.load()[key];
  }

  require(key: string, hint = 'Run `jarvis auth` or set the matching environment variable.'): string {
    const value = this.get(key);
    if (!value) throw new JarvisError('AUTH', `Missing credential "${key}". ${hint}`);
    return value;
  }

  has(key: string): boolean {
    return Boolean(this.get(key));
  }

  names(): string[] {
    return Object.keys(this.load()).sort();
  }

  set(key: string, value: string): void {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(key)) throw new JarvisError('VALIDATION', `Invalid secret name: ${key}`);
    const store = {...this.load(), [key]: value};
    this.save(store);
  }

  setMany(values: Record<string, string>): void {
    this.save({...this.load(), ...values});
  }

  delete(key: string): void {
    const store = this.load();
    delete store[key];
    this.save(store);
  }

  reload(): void {
    this.cache = null;
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as SecretFile;
      if (parsed.version !== 1) throw new Error('unsupported secrets format');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey(), Buffer.from(parsed.iv, 'base64'));
      decipher.setAAD(Buffer.from(AAD));
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
      const values = JSON.parse(plaintext) as unknown;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('invalid secrets payload');
      this.cache = values as Record<string, string>;
      return this.cache;
    } catch (error) {
      throw new JarvisError(
        'AUTH',
        `Could not decrypt ${this.filePath}. The master key may have changed or the file is corrupted.`,
        {cause: error},
      );
    }
  }

  private save(values: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.filePath), {recursive: true});
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey(), iv);
    cipher.setAAD(Buffer.from(AAD));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    const payload: SecretFile = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: ciphertext.toString('base64'),
      updated_at: new Date().toISOString(),
    };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), {mode: 0o600});
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // best effort on exotic filesystems
    }
    this.cache = values;
  }

  private masterKey(): Buffer {
    const fromEnv = process.env.JARVIS_MASTER_KEY?.trim();
    if (fromEnv) return deriveKey(fromEnv);
    if (!fs.existsSync(this.keyPath)) {
      fs.mkdirSync(path.dirname(this.keyPath), {recursive: true});
      fs.writeFileSync(this.keyPath, crypto.randomBytes(32).toString('hex'), {mode: 0o600});
      try {
        fs.chmodSync(this.keyPath, 0o600);
      } catch {
        // best effort
      }
    }
    const material = fs.readFileSync(this.keyPath, 'utf8').trim();
    if (!material) throw new JarvisError('AUTH', `Master key file ${this.keyPath} is empty`);
    return deriveKey(material);
  }
}

function deriveKey(material: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(material)) return Buffer.from(material, 'hex');
  const base64 = Buffer.from(material, 'base64');
  if (base64.length === 32 && /^[A-Za-z0-9+/=]+$/.test(material)) return base64;
  return crypto.scryptSync(material, 'jarvis-secrets-v1', 32);
}

/** Integration token lookup: environment first, encrypted store second. */
export function resolveToken(store: SecretStore, secretName: string, envNames: string[]): string {
  for (const name of envNames) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return store.get(secretName) ?? '';
}
