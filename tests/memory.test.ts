import {afterEach, describe, expect, it} from 'vitest';
import {createHarness, type Harness} from './helpers.js';
import {diversifyHits} from '../src/memory/memory.js';
import type {MemoryHit, MemoryRecord} from '../src/memory/types.js';

let harness: Harness | undefined;

afterEach(() => {
  harness?.shutdown();
  harness = undefined;
});

describe('MemoryService', () => {
  it('stores, deduplicates and finds memories by keyword', async () => {
    harness = createHarness();
    const first = await harness.memory.remember({content: 'The user prefers oat milk in coffee', importance: 0.7, source: 'test'});
    const duplicate = await harness.memory.remember({content: '  the user prefers OAT milk in coffee ', importance: 0.9});
    expect(duplicate.id).toBe(first.id);
    expect(harness.memory.count()).toBe(1);

    const hits = await harness.memory.search('oat milk');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.memory.content).toContain('oat milk');
    expect(hits[0]!.via).toContain('keyword');
  });

  it('versions profile facts and preserves history', async () => {
    harness = createHarness();
    const berlin = await harness.memory.setFact({key: 'home_city', value: 'Berlin', category: 'location'});
    const paris = await harness.memory.setFact({key: 'home_city', value: 'Paris', category: 'location'});
    expect(paris.superseded?.id).toBe(berlin.fact.id);
    expect(paris.fact.value).toBe('Paris');

    const active = harness.memory.getProfile();
    expect(active.filter((fact) => fact.key === 'home_city')).toHaveLength(1);
    expect(active[0]!.value).toBe('Paris');

    const history = harness.memory.historyFor('home_city');
    expect(history).toHaveLength(2);
    expect(history.some((fact) => fact.superseded_by === paris.fact.id)).toBe(true);
  });

  it('confirms an unchanged fact without creating history', async () => {
    harness = createHarness();
    const first = await harness.memory.setFact({key: 'job_title', value: 'Engineer', confidence: 0.6});
    const again = await harness.memory.setFact({key: 'job_title', value: 'engineer', confidence: 0.9});
    expect(again.fact.id).toBe(first.fact.id);
    expect(again.fact.confidence).toBeGreaterThanOrEqual(0.9);
    expect(harness.memory.historyFor('job_title')).toHaveLength(1);
  });

  it('deletes memories and respects pinned ordering', async () => {
    harness = createHarness();
    const pinned = await harness.memory.remember({content: 'Passport number is in the safe', pinned: true});
    const normal = await harness.memory.remember({content: 'Milk in the fridge'});
    const recent = harness.memory.recent(10);
    expect(recent[0]!.memory.id).toBe(pinned.id);
    expect(harness.memory.delete(normal.id)).toBe(true);
    expect(harness.memory.getMemory(normal.id)).toBeUndefined();
    expect(harness.memory.delete('mem_missing')).toBe(false);
  });

  it('tracks recall access as a soft relevance signal', async () => {
    harness = createHarness();
    const memory = await harness.memory.remember({content: 'The user keeps a spare key with Mara', importance: 0.6});
    expect(memory.access_count).toBe(0);
    const hits = await harness.memory.search('spare key Mara');
    expect(hits[0]!.memory.id).toBe(memory.id);
    const after = harness.memory.getMemory(memory.id)!;
    expect(after.access_count).toBeGreaterThanOrEqual(1);
    expect(after.last_accessed_at).toBeTruthy();
  });

  it('prefers fresher memories when relevance is otherwise equal', async () => {
    harness = createHarness();
    const older = await harness.memory.remember({content: 'Quarterly review notes for project atlas', importance: 0.5});
    const newer = await harness.memory.remember({content: 'Quarterly review notes for project atlas updated', importance: 0.5});
    harness.db.run('UPDATE memories SET updated_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', older.id);
    const hits = await harness.memory.search('quarterly review project atlas', {limit: 5});
    const olderIndex = hits.findIndex((hit) => hit.memory.id === older.id);
    const newerIndex = hits.findIndex((hit) => hit.memory.id === newer.id);
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex === -1 || newerIndex < olderIndex).toBe(true);
  });

  it('diversifies near-duplicate recall results', () => {
    const make = (id: string, content: string): MemoryRecord => ({
      id,
      content,
      kind: 'note',
      source: 'test',
      source_ref: null,
      importance: 0.5,
      sensitivity: 'private',
      pinned: 0,
      embedding: null,
      embedding_model: null,
      hash: null,
      access_count: 0,
      last_accessed_at: null,
      expires_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const hits: MemoryHit[] = [
      {memory: make('a', 'Project atlas roadmap review with Mara'), score: 1, via: ['keyword']},
      {memory: make('b', 'Project atlas roadmap review with Mara today'), score: 0.99, via: ['keyword']},
      {memory: make('c', 'Passport renewal appointment is in Paris'), score: 0.9, via: ['keyword']},
    ];
    const selected = diversifyHits(hits, 2, 0.5);
    expect(selected[0]!.memory.id).toBe('a');
    expect(selected[1]!.memory.id).toBe('c');
  });

  it('builds a bounded context block', async () => {
    harness = createHarness();
    for (let i = 0; i < 12; i += 1) {
      await harness.memory.remember({content: `Note ${i} about project atlas and the roadmap`, importance: 0.5});
    }
    const block = await harness.memory.contextBlock('project atlas roadmap', 500);
    expect(block.text.length).toBeLessThanOrEqual(600);
    expect(block.hits.length).toBeGreaterThan(0);
  });
});
