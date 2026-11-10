import fs from 'node:fs';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {AudioNoteService} from '../src/notes/audio.js';
import {createHarness, type Harness} from './helpers.js';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.shutdown();
});

describe('NoteService', () => {
  it('creates, searches and filters notes by tags', () => {
    const cabin = harness.notes.create({
      title: 'Cabin weekend',
      content: 'Maya is waiting on the cabin dates. Keep Friday afternoon free for the drive.',
      tags: ['Travel', 'Personal'],
      source: 'companion',
    });
    harness.notes.create({
      title: 'Board deck',
      content: 'The competitive landscape slide is still blank.',
      tags: ['work'],
      source: 'manual',
    });

    expect(harness.notes.count()).toBe(2);
    expect(harness.notes.list({query: 'cabin'}).map((note) => note.id)).toEqual([cabin.id]);
    expect(harness.notes.list({tag: 'travel'}).map((note) => note.id)).toEqual([cabin.id]);
    expect(harness.notes.list({query: 'competitive'})).toHaveLength(1);
    expect(harness.notes.list({query: 'nothing-matches-this'})).toHaveLength(0);
  });

  it('updates, pins, archives and resolves prefixes', () => {
    const note = harness.notes.create({title: 'A thought', content: 'First version', tags: ['ideas']});
    const updated = harness.notes.update(note.id, {
      title: 'A better thought',
      content: 'Second version with a sharper ending.',
      tags: ['ideas', 'writing'],
      pinned: true,
    });
    expect(updated?.title).toBe('A better thought');
    expect(updated?.pinned).toBe(true);
    expect(updated?.tags).toEqual(['ideas', 'writing']);
    expect(harness.notes.resolve(note.id.slice(0, 10))?.id).toBe(note.id);
    expect(harness.notes.list({query: 'sharper'})[0]?.id).toBe(note.id);

    harness.notes.update(note.id, {archived: true});
    expect(harness.notes.list()).toHaveLength(0);
    expect(harness.notes.list({archived: true})).toHaveLength(1);
    expect(harness.notes.count()).toBe(0);
    expect(harness.notes.count({archived: true})).toBe(1);
  });

  it('keeps a title-only note valid and derives a title from content', () => {
    const named = harness.notes.create({title: 'Only a title', content: ''});
    expect(named.title).toBe('Only a title');
    const derived = harness.notes.create({content: 'The first line becomes the title\n\nWith more detail below.'});
    expect(derived.title).toBe('The first line becomes the title');
  });
});

describe('AudioNoteService', () => {
  it('transcribes audio, stores it with the note and preserves the transcript', async () => {
    const audioNotes = new AudioNoteService({
      config: harness.config,
      notes: harness.notes,
      transcriber: {
        async transcribeBuffer() {
          return 'Book the train to Berlin on Friday. Ask Maya about the cabin.';
        },
      },
      llm: null,
    });

    const result = await audioNotes.createFromAudio({
      buffer: Buffer.from('not-a-real-webm-file'),
      mime: 'audio/webm',
      filename: 'memo.webm',
      durationSeconds: 12.5,
    });

    expect(result.transcript).toContain('Book the train');
    expect(result.structured).toBe(false);
    expect(result.note.content).toContain('Transcript:');
    expect(result.note.audio_mime).toBe('audio/webm');
    expect(result.note.audio_path).toMatch(/\.webm$/);
    expect(result.note.duration_seconds).toBe(12.5);
    expect(fs.existsSync(`${harness.home}/notes-audio/${result.note.audio_path}`)).toBe(true);

    const audio = await harness.notes.readAudio(result.note);
    expect(audio.data.toString()).toBe('not-a-real-webm-file');
    await harness.notes.delete(result.note.id);
    expect(fs.existsSync(`${harness.home}/notes-audio/${result.note.audio_path}`)).toBe(false);
  });

  it('rejects empty recordings without writing a note', async () => {
    const audioNotes = new AudioNoteService({
      config: harness.config,
      notes: harness.notes,
      transcriber: {async transcribeBuffer() { return 'unused'; }},
      llm: null,
    });
    await expect(audioNotes.createFromAudio({buffer: Buffer.alloc(0), mime: 'audio/webm'})).rejects.toThrow(/empty/i);
    expect(harness.notes.count()).toBe(0);
  });
});
