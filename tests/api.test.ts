import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createApp, type App} from '../src/core/app.js';
import {createHttpApp} from '../src/server/http.js';
import {MockProvider} from '../src/llm/mock.js';

let app: App | undefined;
let home: string | undefined;

afterEach(async () => {
  await app?.shutdown();
  app = undefined;
  if (home) fs.rmSync(home, {recursive: true, force: true});
  home = undefined;
});

async function testServer(): Promise<{app: App; request: (path: string, init?: RequestInit) => Promise<Response>}> {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-api-'));
  const mock = new MockProvider([{text: 'ok'}]);
  app = await createApp({
    home,
    env: {...process.env, JARVIS_LLM_PROVIDER: 'mock', JARVIS_EMBEDDINGS: 'false'},
    llmSet: {main: mock, small: mock, embedder: null},
    registerTools: false,
    connectMcp: false,
  });
  const {hono} = createHttpApp(app);
  return {app, request: async (requestPath, init) => hono.request(requestPath, init)};
}

describe('notes API', () => {
  it('creates, searches, updates and deletes a note', async () => {
    const {request} = await testServer();
    const createdResponse = await request('/v1/notes', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({title: 'Cabin', content: 'Keep Friday afternoon free for the drive.', tags: ['Travel']}),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {note: {id: string; tags: string[]}};
    expect(created.note.tags).toEqual(['travel']);

    const searchResponse = await request('/v1/notes?query=Friday');
    expect(searchResponse.status).toBe(200);
    const search = (await searchResponse.json()) as {notes: Array<{id: string}>};
    expect(search.notes.map((note) => note.id)).toEqual([created.note.id]);

    const patchResponse = await request(`/v1/notes/${created.note.id}`, {
      method: 'PATCH',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pinned: true, content: 'Keep Friday and Monday free.'}),
    });
    expect(patchResponse.status).toBe(200);
    const patched = (await patchResponse.json()) as {note: {pinned: boolean; content: string}};
    expect(patched.note.pinned).toBe(true);
    expect(patched.note.content).toContain('Monday');

    const deleteResponse = await request(`/v1/notes/${created.note.id}`, {method: 'DELETE'});
    expect(deleteResponse.status).toBe(200);
    expect((await request('/v1/notes')).status).toBe(200);
  });

  it('turns a multipart voice upload into a searchable note', async () => {
    const {app: testApp, request} = await testServer();
    (testApp.voice as unknown as {transcribeBuffer: () => Promise<string>}).transcribeBuffer = async () =>
      'Send the board deck to Maya on Thursday morning.';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'audio/webm'}), 'memo.webm');
    form.append('title', 'Voice memo');
    form.append('tags', 'work');
    form.append('duration_seconds', '8');
    const response = await request('/v1/notes/audio', {method: 'POST', body: form});
    expect(response.status).toBe(201);
    const result = (await response.json()) as {note: {id: string; title: string; content: string; audio_path: string}; transcript: string};
    expect(result.transcript).toContain('Maya');
    expect(result.note.title).toBe('Voice memo');
    expect(result.note.content).toContain('Transcript:');
    expect(result.note.audio_path).toBeTruthy();

    const audio = await request(`/v1/notes/${result.note.id}/audio`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toContain('audio/webm');
    expect((await request('/v1/notes?query=Maya')).status).toBe(200);
  });

  it('reports calendar setup instead of pretending it is connected', async () => {
    const {request} = await testServer();
    const response = await request('/v1/calendar?days=7');
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {available: boolean; authorized: boolean; events: unknown[]};
    expect(payload.available).toBe(false);
    expect(payload.authorized).toBe(false);
    expect(payload.events).toEqual([]);
  });
});
