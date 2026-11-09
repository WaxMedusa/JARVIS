import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** URL-safe, collision-resistant id such as `mem_k3j9x2m1q8z4`. */
export function newId(prefix: string, length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Standards-compliant UUID (used for OAuth state and request ids). */
export function uuid(): string {
  return randomUUID();
}

/** Stable, short non-cryptographic hash for dedupe / loop detection. */
export function shortHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
