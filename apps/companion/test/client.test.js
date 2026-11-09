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
