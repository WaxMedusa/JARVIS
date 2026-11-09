import crypto from 'node:crypto';
import {Hono} from 'hono';
import {serve, type ServerType} from '@hono/node-server';
import type {App} from '../core/app.js';
import {JarvisError, errorMessage} from '../core/errors.js';
import {getLogger} from '../core/logger.js';
import {ApprovalBroker} from './approvals.js';

const startedAt = Date.now();

export interface HttpServer {
  server: ServerType;
  broker: ApprovalBroker;
  close(): Promise<void>;
}

export function createHttpApp(app: App): {hono: Hono; broker: ApprovalBroker} {
  const hono = new Hono();
  const broker = new ApprovalBroker();

  hono.get('/health', (c) =>
    c.json({
      ok: true,
      name: app.config.assistant.name,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      model: app.config.llm.model,
    }),
  );

  hono.use('/v1/*', async (c, next) => {
    const token = app.config.server.apiToken;
    const host = app.config.server.host;
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
    if (!token && loopback) return next();
    if (!token) {
      return c.json({error: 'Server refuses to expose /v1 without JARVIS_API_TOKEN'}, 500);
    }
    const header = c.req.header('authorization') ?? '';
    const provided = header.replace(/^Bearer\s+/i, '').trim();
    if (!safeEqual(provided, token)) {
      return c.json({error: 'unauthorized'}, 401);
    }
    await next();
  });

  hono.use('/v1/*', async (c, next) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > app.config.server.maxBodyBytes) return c.json({error: 'request body too large'}, 413);
    const start = Date.now();
    await next();
    getLogger().debug('http request', {method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start});
  });

  hono.get('/v1/status', (c) =>
    c.json({
      name: app.config.assistant.name,
      version: '1.0.0',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      model: app.config.llm.model,
      provider: app.config.llm.provider,
      embeddings: app.embedder?.available ? app.embedder.model : null,
      timezone: app.config.assistant.timezone,
      counts: {
        memories: app.memory.count(),
        profileFacts: app.memory.getProfile({limit: 1000}).length,
        conversations: app.conversations.list(500).length,
        openTasks: app.tasks.list({status: 'open', limit: 500}).length,
        auditEntries: app.audit.count(),
        documents: app.documents.stats(),
      },
      tools: app.registry.count(),
      integrations: app.integrations.status(),
      approvals: broker.list(),
    }),
  );

  hono.post('/v1/chat', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {message?: unknown; conversationId?: unknown; channel?: unknown};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return c.json({error: 'message is required'}, 400);
    if (message.length > 32_000) return c.json({error: 'message too long'}, 413);
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
    const channel = typeof body.channel === 'string' ? body.channel : 'api';
    const controller = new AbortController();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: async (ctrl) => {
        let closed = false;
        const send = (event: string, data: unknown): void => {
          if (closed) return;
          ctrl.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        send('open', {ok: true});
        try {
          for await (const event of app.agent.run({
            message,
            conversationId,
            channel,
            signal: controller.signal,
            requestApproval: async (request) => {
              const {id, promise} = broker.createWithId(request, 120_000);
              send('approval_required', {id, ...request});
              return promise;
            },
          })) {
            switch (event.type) {
              case 'start':
                send('start', {conversationId: event.conversationId, channel: event.channel});
                break;
              case 'text':
                send('text', {text: event.text});
                break;
              case 'reasoning':
                send('reasoning', {text: event.text});
                break;
              case 'tool_start':
                send('tool_start', {name: event.name, args: event.args, risk: event.risk});
                break;
              case 'tool_end':
                send('tool_end', {name: event.name, ok: event.ok, summary: event.summary, durationMs: event.durationMs, content: event.content.slice(0, 4000)});
                break;
              case 'usage':
                send('usage', event.usage);
                break;
              case 'done':
                send('done', {
                  conversationId: event.conversationId,
                  text: event.text,
                  usage: event.usage,
                  steps: event.steps,
                  toolCalls: event.toolCalls,
                });
                break;
              case 'error':
                send('error', {message: event.message, code: event.code});
                break;
            }
          }
        } catch (error) {
          send('error', {message: errorMessage(error)});
        } finally {
          closed = true;
          ctrl.close();
        }
      },
      cancel() {
        controller.abort();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });

  hono.get('/v1/approvals', (c) => c.json({pending: broker.list()}));
  hono.post('/v1/approvals/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {approved?: unknown};
    const approved = body.approved === true;
    const resolved = broker.resolve(c.req.param('id'), approved);
    return resolved ? c.json({ok: true, approved}) : c.json({error: 'approval not found or expired'}, 404);
  });

  hono.get('/v1/conversations', (c) => c.json({conversations: app.conversations.list(Number(c.req.query('limit') ?? 25))}));
  hono.get('/v1/conversations/:id/messages', (c) => {
    const conversation = app.conversations.get(c.req.param('id'));
    if (!conversation) return c.json({error: 'conversation not found'}, 404);
    return c.json({conversation, messages: app.conversations.messages(conversation.id, {limit: Number(c.req.query('limit') ?? 200)})});
  });

  hono.get('/v1/memory', async (c) => {
    const query = c.req.query('query');
    const limit = Number(c.req.query('limit') ?? 20);
    if (query) {
      const hits = await app.memory.search(query, {limit});
      return c.json({memories: hits.map((hit) => ({...hit.memory, embedding: undefined, score: hit.score, via: hit.via}))});
    }
    return c.json({memories: app.memory.list({limit}).map((memory) => ({...memory, embedding: undefined}))});
  });
  hono.post('/v1/memory', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.content !== 'string' || !body.content.trim()) return c.json({error: 'content is required'}, 400);
    const memory = await app.memory.remember({
      content: body.content,
      kind: typeof body.kind === 'string' ? body.kind : 'note',
      importance: typeof body.importance === 'number' ? body.importance : 0.5,
      pinned: body.pinned === true,
      source: 'api',
    });
    return c.json({memory: {...memory, embedding: undefined}}, 201);
  });
  hono.delete('/v1/memory/:id', (c) => {
    const deleted = app.memory.delete(c.req.param('id'));
    return deleted ? c.json({ok: true}) : c.json({error: 'memory not found'}, 404);
  });

  hono.get('/v1/profile', (c) => c.json({facts: app.memory.getProfile({limit: 500}).map((fact) => ({...fact, embedding: undefined}))}));
  hono.post('/v1/profile', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.key !== 'string' || typeof body.value !== 'string') return c.json({error: 'key and value are required'}, 400);
    const result = await app.memory.setFact({
      key: body.key,
      value: body.value,
      category: typeof body.category === 'string' ? body.category : 'general',
      confidence: typeof body.confidence === 'number' ? body.confidence : 0.9,
      source: 'api',
    });
    return c.json({fact: {...result.fact, embedding: undefined}, superseded: result.superseded ? result.superseded.id : null}, 201);
  });

  hono.get('/v1/tasks', (c) => c.json({tasks: app.tasks.list({status: c.req.query('status') ?? 'open', limit: Number(c.req.query('limit') ?? 50)})}));
  hono.post('/v1/tasks', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.title !== 'string' || !body.title.trim()) return c.json({error: 'title is required'}, 400);
    try {
      const task = app.tasks.create({
        title: body.title,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
        dueAt: typeof body.due_at === 'string' ? body.due_at : null,
        recurrence: typeof body.recurrence === 'string' ? body.recurrence : null,
        priority: typeof body.priority === 'number' ? body.priority : undefined,
        source: 'api',
      });
      return c.json({task}, 201);
    } catch (error) {
      return c.json({error: errorMessage(error)}, 400);
    }
  });
  hono.post('/v1/tasks/:id/complete', (c) => {
    const task = app.tasks.complete(c.req.param('id'));
    return task ? c.json({task}) : c.json({error: 'task not found'}, 404);
  });
  hono.delete('/v1/tasks/:id', (c) => (app.tasks.delete(c.req.param('id')) ? c.json({ok: true}) : c.json({error: 'task not found'}, 404)));

  hono.get('/v1/integrations', (c) => c.json({integrations: app.integrations.status(), mcp: app.mcp.list()}));
  hono.get('/v1/tools', (c) => c.json({tools: app.registry.list().map(({definition, source, jsonSchema}) => ({name: definition.name, description: definition.description, risk: definition.risk, category: definition.category, source, parameters: jsonSchema}))}));
  hono.get('/v1/audit', (c) => c.json({entries: app.audit.tail(Number(c.req.query('limit') ?? 50))}));

  hono.post('/v1/index', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {path?: unknown};
    if (typeof body.path !== 'string') return c.json({error: 'path is required'}, 400);
    const stats = await app.documents.indexPath(body.path);
    return c.json({stats});
  });

  hono.post('/v1/sync', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {direction?: unknown};
    const supabase = app.integrations.services.supabase;
    if (!supabase) return c.json({error: 'Supabase is not configured'}, 400);
    const result = body.direction === 'pull' ? await supabase.pull() : await supabase.push();
    return c.json({result});
  });

  hono.notFound((c) => c.json({error: 'not found'}, 404));
  hono.onError((error, c) => {
    getLogger().error('http error', {path: c.req.path, error: errorMessage(error)});
    if (error instanceof JarvisError) return c.json({error: error.message, code: error.code}, error.status as never);
    return c.json({error: 'internal error'}, 500);
  });

  return {hono, broker};
}

export function startHttpServer(app: App): HttpServer {
  const {hono, broker} = createHttpApp(app);
  const host = app.config.server.host;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && !app.config.server.apiToken) {
    throw new JarvisError('CONFIG', 'Refusing to bind a non-loopback host without JARVIS_API_TOKEN. Set a token or bind 127.0.0.1.');
  }
  const server = serve({fetch: hono.fetch, hostname: host, port: app.config.server.port}, (info) => {
    app.logger.info('HTTP API listening', {url: `http://${host}:${info.port}`, auth: app.config.server.apiToken ? 'bearer' : 'loopback-only'});
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    app.logger.error('HTTP server error', {code: error.code, error: error.message});
  });
  return {
    server,
    broker,
    close: () =>
      new Promise<void>((resolve) => {
        broker.cancelAll();
        server.close(() => resolve());
      }),
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
