/** Memory and profile domain types shared by services, tools and prompts. */

export type MemoryKind = 'note' | 'fact' | 'event' | 'preference' | 'insight' | 'person' | 'project' | 'document' | 'task';

export type Sensitivity = 'public' | 'private' | 'secret';

export interface MemoryRecord {
  id: string;
  content: string;
  kind: string;
  source: string;
  source_ref: string | null;
  importance: number;
  sensitivity: string;
  pinned: number;
  embedding: Uint8Array | null;
  embedding_model: string | null;
  hash: string | null;
  access_count: number;
  last_accessed_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryHit {
  memory: MemoryRecord;
  score: number;
  via: string[];
}

export interface ProfileFact {
  id: string;
  key: string;
  value: string;
  category: string;
  confidence: number;
  source: string | null;
  sensitivity: string;
  embedding: Uint8Array | null;
  created_at: string;
  updated_at: string;
  last_confirmed_at: string | null;
  superseded_by: string | null;
}

export interface EntityRecord {
  id: string;
  name: string;
  type: string;
  aliases: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RelationRecord {
  id: string;
  from_id: string;
  predicate: string;
  to_id: string | null;
  to_value: string | null;
  confidence: number;
  source: string | null;
  created_at: string;
}

export interface RememberInput {
  content: string;
  kind?: string;
  source?: string;
  sourceRef?: string;
  importance?: number;
  sensitivity?: Sensitivity;
  pinned?: boolean;
  expiresAt?: string | null;
}

export interface SetFactInput {
  key: string;
  value: string;
  category?: string;
  confidence?: number;
  source?: string;
  sensitivity?: Sensitivity;
}

export interface SearchOptions {
  limit?: number;
  kinds?: string[];
  minScore?: number;
  includeExpired?: boolean;
}
