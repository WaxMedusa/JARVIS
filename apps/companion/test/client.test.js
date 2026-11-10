'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {JarvisClient} = require('../src/main/jarvis-client');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port}));
  });
}

test('streams SSE chat events with the API token', async () => {
  let seenAuth = '';
  const {server, port} = await listen((req, res) => {
    seenAuth = req.headers.authorization || '';
    if (req.url === '/v1/chat') {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write('event: start\ndata: {"conversationId":"conv_1"}\n\n');
      res.write('event: text\ndata: {"text":"Hel"}\n\n');
      setTimeout(() => {
        res.write('event: text\ndata: {"text":"lo"}\n\n');
        res.write('event: done\ndata: {"conversationId":"conv_1","steps":1}\n\n');
        res.end();
      }, 10);
      return;
    }
    res.writeHead(404).end();
  });

  try {
    const client = new JarvisClient({baseUrl: `http://127.0.0.1:${port}`, token: 'secret'});
    const events = [];
    await client.chat({message: 'hi', onEvent: (event) => events.push(event)});
    assert.equal(seenAuth, 'Bearer secret');
    assert.deepEqual(events.map((event) => event.type), ['start', 'text', 'text', 'done']);
    assert.equal(events[1].text + events[2].text, 'Hello');
  } finally {
    server.close();
  }
});

test('sends memory writes and surfaces daemon errors', async () => {
  const {server, port} = await listen((req, res) => {
    if (req.url === '/v1/memory' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.writeHead(201, {'content-type': 'application/json'});
        res.end(JSON.stringify({memory: {id: 'mem_1', content: parsed.content}}));
      });
      return;
    }
    res.writeHead(500, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: 'core exploded'}));
  });

  try {
    const client = new JarvisClient({baseUrl: `http://127.0.0.1:${port}`});
    const memory = await client.remember('a durable fact');
    assert.equal(memory.id, 'mem_1');
    await assert.rejects(() => client.status(), /core exploded/);
  } finally {
    server.close();
  }
});

test('carries notes, calendar events and audio uploads', async () => {
  const seen = [];
  const {server, port} = await listen((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({url: req.url, method: req.method, contentType: req.headers['content-type'] || '', body});
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/v1/notes?')) {
        res.end(JSON.stringify({notes: [{id: 'note_1', title: 'Cabin'}], stats: {active: 1, archived: 0, withAudio: 0}}));
      } else if (req.url === '/v1/notes' && req.method === 'POST') {
        res.end(JSON.stringify({note: {id: 'note_2', title: 'New note'}}));
      } else if (req.url === '/v1/calendar?days=7') {
        res.end(JSON.stringify({available: true, authorized: true, events: [{id: 'evt_1'}]}));
      } else if (req.url === '/v1/calendar/events') {
        res.end(JSON.stringify({event: {id: 'evt_2', summary: 'Review'}}));
      } else if (req.url === '/v1/notes/audio') {
        res.end(JSON.stringify({note: {id: 'note_3', title: 'Voice memo'}, transcript: 'hello'}));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({error: 'not found'}));
      }
    });
  });

  try {
    const client = new JarvisClient({baseUrl: `http://127.0.0.1:${port}`});
    const list = await client.notes({query: 'cabin'});
    assert.equal(list.notes[0].id, 'note_1');
    const note = await client.createNote({title: 'New note', content: 'body', tags: ['work']});
    assert.equal(note.id, 'note_2');
    const calendar = await client.calendar(7);
    assert.equal(calendar.events[0].id, 'evt_1');
    const event = await client.createCalendarEvent({summary: 'Review', start: '2026-11-10T10:00:00Z', end: '2026-11-10T11:00:00Z'});
    assert.equal(event.id, 'evt_2');
    const audio = await client.createAudioNote({data: Buffer.from('audio-bytes'), mime: 'audio/webm', filename: 'memo.webm', durationSeconds: 4});
    assert.equal(audio.transcript, 'hello');

    const audioRequest = seen.find((entry) => entry.url === '/v1/notes/audio');
    assert.match(audioRequest.contentType, /multipart\/form-data/);
    assert.match(audioRequest.body, /name="file"/);
    assert.match(audioRequest.body, /name="duration_seconds"/);
    assert.match(seen.find((entry) => entry.url.startsWith('/v1/notes?')).url, /query=cabin/);
  } finally {
    server.close();
  }
});

test('aborts a streaming turn through the provided signal', async () => {
  const {server, port} = await listen((_req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('event: start\ndata: {}\n\n');
  });
  try {
    const client = new JarvisClient({baseUrl: `http://127.0.0.1:${port}`});
    const controller = new AbortController();
    const promise = client.chat({message: 'hi', signal: controller.signal, onEvent: () => controller.abort()});
    await assert.rejects(promise);
  } finally {
    server.close();
  }
});
