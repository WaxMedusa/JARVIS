import crypto from 'node:crypto';
import {Hono, type Context} from 'hono';
import {isSupportedAudioMime, normalizeAudioMime} from '../memory/notes.js';
import {serve, type ServerType} from '@hono/node-server';
import type {App} from '../core/app.js';
import {JarvisError, errorMessage} from '../core/errors.js';
import {getLogger} from '../core/logger.js';
import {ApprovalBroker} from './approvals.js';
import type {CalendarEvent} from '../integrations/types.js';

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
    const audioUpload = c.req.path === '/v1/audio/transcribe' || c.req.path === '/v1/notes/audio';
    const limit = audioUpload ? app.config.voice.maxAudioBytes + 1024 * 1024 : app.config.server.maxBodyBytes;
    if (length > limit) return c.json({error: audioUpload ? 'audio upload is too large' : 'request body too large'}, 413);
    const start = Date.now();
    await next();
    getLogger().debug('http request', {method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start});
  });

  hono.get('/v1/status', (c) =>
    c.json({
      name: app.config.assistant.name,
      version: '3.0.0',
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
        notes: app.notes.count(),
        archivedNotes: app.notes.count({archived: true}),
        audioNotes: app.notes.stats().withAudio,
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

  /* ------------------------------- Notes -------------------------------- */

  hono.get('/v1/notes', (c) => {
    const archived = c.req.query('archived') === 'true' || c.req.query('archived') === '1';
    const notes = app.notes.list({
      query: c.req.query('query') || undefined,
      tag: c.req.query('tag') || undefined,
      archived,
      limit: Number(c.req.query('limit') ?? 100),
      offset: Number(c.req.query('offset') ?? 0),
    });
    return c.json({notes, tags: app.notes.tags(), stats: app.notes.stats(), archived});
  });

  hono.get('/v1/notes/tags', (c) => c.json({tags: app.notes.tags()}));

  hono.post('/v1/notes', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const content = typeof body.content === 'string' ? body.content : '';
    const title = typeof body.title === 'string' ? body.title : undefined;
    if (!content.trim() && !title?.trim()) return c.json({error: 'title or content is required'}, 400);
    try {
      const note = app.notes.create({
        title,
        content,
        tags: body.tags as string[] | string | undefined,
        pinned: body.pinned === true,
        source: typeof body.source === 'string' ? body.source : 'api',
      });
      return c.json({note}, 201);
    } catch (error) {
      return c.json({error: errorMessage(error)}, 400);
    }
  });

  hono.post('/v1/notes/audio', async (c) => {
    const upload = await readAudioUpload(c, app.config.voice.maxAudioBytes);
    if ('error' in upload) return c.json({error: upload.error}, upload.status);
    try {
      const result = await app.audioNotes.createFromAudio({
        buffer: upload.buffer,
        mime: upload.mime,
        filename: upload.filename,
        title: upload.fields.title,
        tags: upload.fields.tags,
        durationSeconds: upload.fields.duration_seconds ? Number(upload.fields.duration_seconds) : null,
        summarize: upload.fields.summarize !== 'false',
      });
      return c.json(result, 201);
    } catch (error) {
      throw error;
    }
  });

  hono.post('/v1/audio/transcribe', async (c) => {
    const upload = await readAudioUpload(c, app.config.voice.maxAudioBytes);
    if ('error' in upload) return c.json({error: upload.error}, upload.status);
    const transcript = await app.voice.transcribeBuffer(upload.buffer, {mime: upload.mime, filename: upload.filename});
    return c.json({transcript, text: transcript, chars: transcript.length});
  });

  hono.get('/v1/notes/:id/audio', async (c) => {
    const note = app.notes.get(c.req.param('id'));
    if (!note) return c.json({error: 'note not found'}, 404);
    if (!note.audio_path) return c.json({error: 'this note has no audio attachment'}, 404);
    try {
      const audio = await app.notes.readAudio(note);
      c.header('content-type', audio.mime);
      c.header('content-length', String(audio.data.length));
      c.header('cache-control', 'private, no-store');
      return c.body(new Uint8Array(audio.data));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return c.json({error: 'audio attachment is missing'}, 404);
      throw error;
    }
  });

  hono.get('/v1/notes/:id', (c) => {
    const note = app.notes.get(c.req.param('id'));
    return note ? c.json({note}) : c.json({error: 'note not found'}, 404);
  });

  hono.patch('/v1/notes/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const note = app.notes.update(c.req.param('id'), {
        title: typeof body.title === 'string' ? body.title : undefined,
        content: typeof body.content === 'string' ? body.content : undefined,
        summary: body.summary === null ? null : typeof body.summary === 'string' ? body.summary : undefined,
        tags: body.tags as string[] | string | undefined,
        pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
        archived: typeof body.archived === 'boolean' ? body.archived : undefined,
      });
      return note ? c.json({note}) : c.json({error: 'note not found'}, 404);
    } catch (error) {
      return c.json({error: errorMessage(error)}, 400);
    }
  });

  hono.delete('/v1/notes/:id', async (c) => {
    const deleted = await app.notes.delete(c.req.param('id'));
    return deleted ? c.json({ok: true}) : c.json({error: 'note not found'}, 404);
  });

  /* ------------------------------ Calendar ------------------------------ */

  hono.get('/v1/calendar', async (c) => {
    const google = app.integrations.services.google;
    const feedService = app.integrations.services.calendarFeeds;
    const feeds = feedService.list();
    const googleAuthorized = Boolean(google?.isAuthorized());
    if (!googleAuthorized && !feeds.length) {
      return c.json({
        available: false,
        configured: Boolean(google),
        authorized: false,
        google: {configured: Boolean(google), authorized: false},
        feeds: [],
        events: [],
        timezone: app.config.assistant.timezone,
        message: 'Connect your calendar: add the private iCal address from Google Calendar in JARVIS → Agenda.',
      });
    }
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 7) || 7, 1), 60);
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + days);
    const events: CalendarEvent[] = [];
    const warnings: string[] = [];
    if (googleAuthorized && google) {
      try {
        for (const event of await google.listEvents({timeMin: from.toISOString(), timeMax: to.toISOString(), maxResults: 250})) {
          events.push({...event, all_day: /^\d{4}-\d{2}-\d{2}$/.test(event.start), source: 'Google Calendar'});
        }
      } catch (error) {
        warnings.push(`Google Calendar: ${errorMessage(error)}`);
      }
    }
    if (feeds.length) {
      try {
        const result = await feedService.events({timeMin: from.toISOString(), timeMax: to.toISOString()});
        events.push(...result.events);
        warnings.push(...result.warnings);
      } catch (error) {
        warnings.push(`Calendar feeds: ${errorMessage(error)}`);
      }
    }
    const unique = new Map<string, CalendarEvent>();
    for (const event of events) unique.set(`${String(event.summary)}|${String(event.start)}`, event);
    const merged = [...unique.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return c.json({
      available: true,
      configured: true,
      authorized: googleAuthorized || feeds.length > 0,
      google: {configured: Boolean(google), authorized: googleAuthorized},
      feeds,
      days,
      timezone: app.config.assistant.timezone,
      calendarId: app.config.integrations.google.calendarId,
      from: from.toISOString(),
      to: to.toISOString(),
      events: merged,
      warnings,
    });
  });

  hono.get('/v1/calendar/feeds', (c) => c.json({feeds: app.integrations.services.calendarFeeds.list()}));
  hono.post('/v1/calendar/feeds', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {url?: unknown; label?: unknown};
    if (typeof body.url !== 'string' || !body.url.trim()) return c.json({error: 'A calendar URL is required.'}, 400);
    try {
      const feed = await app.integrations.services.calendarFeeds.add({
        url: body.url,
        label: typeof body.label === 'string' ? body.label.slice(0, 80) : undefined,
      });
      return c.json({feed}, 201);
    } catch (error) {
      return c.json({error: errorMessage(error)}, error instanceof JarvisError ? 400 : 502);
    }
  });
  hono.delete('/v1/calendar/feeds/:id', (c) =>
    app.integrations.services.calendarFeeds.remove(c.req.param('id'))
      ? c.json({ok: true})
      : c.json({error: 'calendar feed not found'}, 404),
  );

  /* -------------------------------- Canvas ------------------------------- */

  hono.get('/v1/canvas', async (c) => {
    const canvas = app.integrations.services.canvas;
    if (!canvas) {
      return c.json({
        available: false,
        configured: false,
        courses: [],
        upcoming: [],
        todo: [],
        message: 'Connect Canvas in JARVIS → School with your school URL and an API token.',
      });
    }
    try {
      const [profile, courses, upcoming, todo] = await Promise.all([
        canvas.status().catch(() => ({connected: false})),
        canvas.courses(),
        canvas.upcoming(25).catch(() => []),
        canvas.todo(25).catch(() => []),
      ]);
      return c.json({available: true, configured: true, profile, courses, upcoming, todo});
    } catch (error) {
      return c.json({available: true, configured: true, courses: [], upcoming: [], todo: [], error: errorMessage(error)}, 502);
    }
  });
  hono.get('/v1/canvas/courses', async (c) => {
    const canvas = app.integrations.services.canvas;
    if (!canvas) return c.json({error: 'Canvas is not connected.'}, 400);
    try {
      return c.json({courses: await canvas.courses()});
    } catch (error) {
      return c.json({error: errorMessage(error)}, 502);
    }
  });
  hono.get('/v1/canvas/assignments', async (c) => {
    const canvas = app.integrations.services.canvas;
    if (!canvas) return c.json({error: 'Canvas is not connected.'}, 400);
    const courseId = c.req.query('course_id') || c.req.query('courseId') || '';
    if (!courseId) return c.json({error: 'course_id is required.'}, 400);
    try {
      return c.json({assignments: await canvas.assignments(courseId, c.req.query('bucket') || 'upcoming')});
    } catch (error) {
      return c.json({error: errorMessage(error)}, error instanceof JarvisError && error.code === 'VALIDATION' ? 400 : 502);
    }
  });
  hono.get('/v1/canvas/todo', async (c) => {
    const canvas = app.integrations.services.canvas;
    if (!canvas) return c.json({error: 'Canvas is not connected.'}, 400);
    try {
      return c.json({todo: await canvas.todo(Number(c.req.query('limit') ?? 25))});
    } catch (error) {
      return c.json({error: errorMessage(error)}, 502);
    }
  });

  hono.post('/v1/calendar/events', async (c) => {
    const google = app.integrations.services.google;
    if (!google) return c.json({error: 'Google Calendar is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'}, 400);
    if (!google.isAuthorized()) return c.json({error: 'Google Calendar is not connected. Run `jarvis auth google`.'}, 400);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    const start = typeof body.start === 'string' ? new Date(body.start) : null;
    const end = typeof body.end === 'string' ? new Date(body.end) : null;
    if (!summary) return c.json({error: 'Event title is required.'}, 400);
    if (summary.length > 300) return c.json({error: 'Event title is too long.'}, 400);
    if (!start || Number.isNaN(start.getTime()) || !end || Number.isNaN(end.getTime())) return c.json({error: 'Valid start and end times are required.'}, 400);
    if (end <= start) return c.json({error: 'End time must be after the start time.'}, 400);
    const attendees = Array.isArray(body.attendees)
      ? body.attendees.filter((item): item is string => typeof item === 'string' && item.includes('@')).slice(0, 50)
      : [];
    try {
      const event = await google.createEvent({
        summary,
        start: start.toISOString(),
        end: end.toISOString(),
        description: typeof body.description === 'string' ? body.description.slice(0, 8000) : undefined,
        location: typeof body.location === 'string' ? body.location.slice(0, 500) : undefined,
        attendees,
      });
      return c.json({event}, 201);
    } catch (error) {
      return c.json({error: errorMessage(error)}, 502);
    }
  });

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

interface AudioUpload {
  buffer: Buffer;
  mime: string;
  filename: string;
  fields: Record<string, string>;
}

async function readAudioUpload(c: Context, maxBytes: number): Promise<AudioUpload | {error: string; status: 400 | 413 | 415}> {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    return {error: 'expected a multipart/form-data upload', status: 400};
  }
  const candidate = body.file;
  if (!candidate || typeof candidate === 'string' || Array.isArray(candidate)) {
    return {error: 'file is required', status: 400};
  }
  const file = candidate as File;
  if (typeof file.arrayBuffer !== 'function') return {error: 'file is required', status: 400};
  if (file.size > maxBytes) {
    return {error: `Audio exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`, status: 413};
  }
  const mime = normalizeAudioMime(file.type || mimeForFilename(file.name));
  if (!isSupportedAudioMime(mime)) return {error: `Unsupported audio type: ${file.type || 'unknown'}`, status: 415};
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.length) return {error: 'the recording is empty', status: 400};
  if (buffer.length > maxBytes) {
    return {error: `Audio exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`, status: 413};
  }
  const stringField = (name: string): string => (typeof body[name] === 'string' ? (body[name] as string).slice(0, 120_000) : '');
  return {
    buffer,
    mime,
    filename: file.name || 'voice-note.webm',
    fields: {
      title: stringField('title'),
      tags: stringField('tags'),
      duration_seconds: stringField('duration_seconds'),
      summarize: stringField('summarize'),
    },
  };
}

function mimeForFilename(name: string): string {
  const extension = String(name || '').toLowerCase().split('.').pop() || '';
  if (extension === 'wav') return 'audio/wav';
  if (extension === 'mp3') return 'audio/mpeg';
  if (extension === 'm4a' || extension === 'mp4') return 'audio/mp4';
  if (extension === 'ogg' || extension === 'opus') return 'audio/ogg';
  if (extension === 'flac') return 'audio/flac';
  return 'audio/webm';
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
