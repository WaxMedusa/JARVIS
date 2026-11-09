import {JarvisError, httpError} from '../core/errors.js';
import {withRetry} from './retry.js';

export interface EmbedderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  batchSize?: number;
  retries?: number;
}

/**
 * Embeddings through any OpenAI-compatible /embeddings endpoint.
 * Vectors are normalized before storage so cosine similarity is a dot product.
 */
export class Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly retries: number;
  private warned = false;

  constructor(options: EmbedderOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.batchSize = options.batchSize ?? 32;
    this.retries = options.retries ?? 2;
  }

  get available(): boolean {
    return Boolean(this.apiKey && this.baseUrl && !this.baseUrl.startsWith('mock://'));
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Array<Float32Array | null>> {
    if (!texts.length) return [];
    if (!this.available) return texts.map(() => null);
    const output: Array<Float32Array | null> = [];
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      const batch = texts.slice(offset, offset + this.batchSize).map((text) => text.slice(0, 8000));
      try {
        const vectors = await this.requestBatch(batch, signal);
        for (const vector of vectors) output.push(vector);
      } catch (error) {
        if (!this.warned) {
          this.warned = true;
          process.stderr.write(`[jarvis] embeddings unavailable, falling back to keyword recall: ${(error as Error).message}\n`);
        }
        for (let i = 0; i < batch.length; i += 1) output.push(null);
      }
    }
    return output;
  }

  async embedOne(text: string, signal?: AbortSignal): Promise<Float32Array | null> {
    const [vector] = await this.embed([text], signal);
    return vector ?? null;
  }

  private async requestBatch(texts: string[], signal?: AbortSignal): Promise<Array<Float32Array | null>> {
    const response = await withRetry(
      () =>
        fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`},
          body: JSON.stringify({model: this.model, input: texts, encoding_format: 'float', ...(this.usesDimensions ? {dimensions: this.dimensions} : {})}),
          signal,
        }),
      {retries: this.retries, signal},
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw httpError('Embeddings', response.status, body);
    }
    const payload = (await response.json()) as {data?: Array<{embedding: number[]; index?: number}>};
    if (!Array.isArray(payload.data)) throw new JarvisError('LLM_ERROR', 'Embeddings response was malformed');
    const vectors: Array<Float32Array | null> = texts.map(() => null);
    payload.data.forEach((item, index) => {
      const position = item.index ?? index;
      if (!Array.isArray(item.embedding) || !item.embedding.length) return;
      vectors[position] = normalizeVector(Float32Array.from(item.embedding));
    });
    return vectors;
  }

  private get usesDimensions(): boolean {
    return !/^text-embedding-ada-002$/i.test(this.model);
  }
}

export function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) norm += vector[i]! * vector[i]!;
  norm = Math.sqrt(norm);
  if (!norm) return vector;
  const output = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) output[i] = vector[i]! / norm;
  return output;
}

export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function blobToVector(blob: Uint8Array | null | undefined): Float32Array | null {
  if (!blob || blob.byteLength < 4 || blob.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/** Cosine similarity for pre-normalized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}
