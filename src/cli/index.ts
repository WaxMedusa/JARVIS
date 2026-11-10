#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import {createInterface} from 'node:readline/promises';
import {Command} from 'commander';
import pc from 'picocolors';
import type {JarvisConfig} from '../config.js';
import {loadConfig, publicConfig} from '../config.js';
import {createApp, describeModel} from '../core/app.js';
import {JarvisDB} from '../db/database.js';
import {errorMessage} from '../core/errors.js';
import {formatInTz} from '../core/time.js';
import {IntegrationsHub} from '../integrations/index.js';
import {GoogleClient} from '../integrations/google.js';
import {AuditLog} from '../security/audit.js';
import {Policy} from '../security/policy.js';
import {SecretStore} from '../security/secrets.js';
import {runDaemon} from '../server/daemon.js';
import {registerStorageCommands} from './commands.js';
import {
  askApproval,
  createRenderer,
  printBanner,
  printHelp,
  printIntegrations,
  printProfile,
  printStatus,
  printTasks,
  printToolList,
} from './render.js';
import {createAppOptions, isAutoApprove, loadCliConfig, openStorage, type CliGlobalOptions} from './storage.js';

const program = new Command();
program
  .name('jarvis')
  .description('JARVIS — a personal AI assistant with long-term memory, tools and integrations')
  .version('2.0.0')
  .option('--home <path>', 'data directory (default: ~/.jarvis)')
  .option('--config <path>', 'path to jarvis.config.json')
  .option('--no-mcp', 'do not connect configured MCP servers')
  .option('--verbose', 'enable debug logging')
  .option('--yes', 'auto-approve reversible actions (irreversible actions still require confirmation)');

const globals = (): CliGlobalOptions => program.opts<CliGlobalOptions>();

function readOptions(raw: unknown): Record<string, any> {
  if (raw && typeof (raw as Command).opts === 'function') return (raw as Command).opts();
  return (raw as Record<string, any>) ?? {};
}

/* -------------------------------------------------------------------------- */
/* chat                                                                       */
/* -------------------------------------------------------------------------- */

program
  .command('chat')
  .description('Start an interactive conversation with JARVIS')
  .option('--show-reasoning', 'print model reasoning when the provider exposes it')
  .option('--show-usage', 'print token usage after each turn')
  .action(async (rawOptions?: unknown) => {
    const options = readOptions(rawOptions);
    const app = await createApp(createAppOptions(globals()));
    printBanner(app);
    const rl = createInterface({input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY)});
    const state: {conversationId?: string; autoApprove: boolean} = {
      conversationId: undefined,
      autoApprove: isAutoApprove(globals()),
    };
    let active: AbortController | null = null;
    let closing = false;

    rl.on('SIGINT', () => {
      if (active) {
        active.abort();
        process.stdout.write(`\n${pc.dim('cancelling…')}\n`);
      } else {
        closing = true;
        rl.close();
      }
    });

    const handleSlash = async (input: string): Promise<boolean> => {
      const [command, ...rest] = input.slice(1).split(/\s+/);
      const argument = rest.join(' ').trim();
      switch (command?.toLowerCase()) {
        case 'help':
          printHelp();
          break;
        case 'tools':
          printToolList(app);
          break;
        case 'status':
          printStatus(app);
          break;
        case 'memories': {
          if (argument) {
            const hits = await app.memory.search(argument, {limit: 12});
            if (!hits.length) console.log(pc.dim('No matches.'));
            for (const hit of hits) console.log(`${pc.cyan(hit.memory.id)} ${pc.dim(`(${(hit.score * 100).toFixed(0)}%)`)} ${hit.memory.content.replace(/\s+/g, ' ').slice(0, 300)}`);
          } else {
            const rows = app.memory.list({limit: 20});
            if (!rows.length) console.log(pc.dim('No memories stored yet.'));
            for (const memory of rows) console.log(`${pc.cyan(memory.id)} ${pc.dim(memory.created_at.slice(0, 10))} ${memory.content.replace(/\s+/g, ' ').slice(0, 300)}`);
          }
          break;
        }
        case 'remember': {
          if (!argument) {
            console.log(pc.dim('Usage: /remember <something worth keeping>'));
            break;
          }
          const memory = await app.memory.remember({content: argument, importance: 0.7, source: 'cli'});
          console.log(`${pc.green('stored')} ${pc.cyan(memory.id)}`);
          break;
        }
        case 'notes': {
          const rows = argument
            ? app.notes.list({query: argument, limit: 20})
            : app.notes.list({limit: 20});
          if (!rows.length) console.log(pc.dim('No notes found.'));
          for (const note of rows) {
            const tags = note.tags.length ? ` ${pc.dim(note.tags.map((tag) => `#${tag}`).join(' '))}` : '';
            console.log(`${pc.cyan(note.id)} ${pc.bold(note.title)}${tags} ${pc.dim(note.updated_at.slice(0, 10))}`);
            console.log(pc.dim(note.content.replace(/\s+/g, ' ').slice(0, 240)));
          }
          break;
        }
        case 'note': {
          if (!argument) {
            console.log(pc.dim('Usage: /note <something worth keeping>'));
            break;
          }
          const note = app.notes.create({content: argument, source: 'cli'});
          console.log(`${pc.green('note created')} ${pc.cyan(note.id)} ${note.title}`);
          break;
        }
        case 'profile':
          printProfile(app);
          break;
        case 'tasks':
          printTasks(app);
          break;
        case 'new':
          state.conversationId = undefined;
          console.log(pc.dim('Started a new conversation.'));
          break;
        case 'conversations': {
          const conversations = app.conversations.list(15);
          if (!conversations.length) console.log(pc.dim('No conversations yet.'));
          for (const conversation of conversations) {
            console.log(`${pc.cyan(conversation.id)} ${pc.dim(conversation.updated_at.slice(0, 16).replace('T', ' '))} ${conversation.title ?? '(untitled)'} ${pc.dim(`[${conversation.channel}]`)}`);
          }
          break;
        }
        case 'resume': {
          if (!argument) {
            console.log(pc.dim('Usage: /resume <conversation-id>'));
            break;
          }
          const conversation = app.conversations.get(argument);
          if (!conversation) {
            console.log(pc.red('Conversation not found.'));
            break;
          }
          state.conversationId = conversation.id;
          console.log(`${pc.green('resumed')} ${conversation.id} ${pc.dim(conversation.title ?? '')}`);
          break;
        }
        case 'integrations':
          printIntegrations(app);
          break;
        case 'auto': {
          if (argument === 'on') state.autoApprove = true;
          else if (argument === 'off') state.autoApprove = false;
          else state.autoApprove = !state.autoApprove;
          console.log(`Auto-approve reversible actions: ${state.autoApprove ? pc.green('on') : pc.dim('off')}`);
          break;
        }
        case 'model':
          console.log(describeModel(app));
          break;
        case 'quit':
        case 'exit':
        case 'q':
          return true;
        default:
          console.log(pc.dim(`Unknown command /${command ?? ''}. Type /help.`));
      }
      return false;
    };

    while (!closing) {
      let input: string;
      try {
        input = await rl.question(pc.bold(pc.green('you › ')));
      } catch {
        break;
      }
      const message = input.trim();
      if (!message) continue;
      if (message.startsWith('/')) {
        if (await handleSlash(message)) break;
        continue;
      }

      active = new AbortController();
      const signal = active.signal;
      const renderer = createRenderer({
        showReasoning: Boolean(options.showReasoning),
        showUsage: Boolean(options.showUsage),
      });
      try {
        for await (const event of app.agent.run({
          message,
          conversationId: state.conversationId,
          channel: 'cli',
          signal,
          requestApproval: async (request) => {
            if (state.autoApprove && request.risk !== 'irreversible') {
              process.stderr.write(pc.dim(`  auto-approved ${request.tool}\n`));
              return true;
            }
            if (!process.stdin.isTTY) return false;
            return askApproval(rl, request);
          },
        })) {
          if (event.type === 'start' || event.type === 'done') state.conversationId = event.conversationId;
          renderer.handle(event);
        }
      } catch (error) {
        console.error(pc.red(errorMessage(error)));
      } finally {
        renderer.finish();
        active = null;
      }
    }

    rl.close();
    await app.shutdown();
  });

/* -------------------------------------------------------------------------- */
/* ask                                                                        */
/* -------------------------------------------------------------------------- */

program
  .command('ask <message...>')
  .description('Ask a single question and print the answer')
  .option('--show-reasoning', 'print model reasoning')
  .action(async (message: string[], rawOptions?: unknown) => {
    const options = readOptions(rawOptions);
    const text = message.join(' ').trim();
    if (!text) throw new Error('Ask needs a question');
    const app = await createApp(createAppOptions(globals()));
    const auto = isAutoApprove(globals());
    const rl = process.stdin.isTTY ? createInterface({input: process.stdin, output: process.stdout}) : null;
    const renderer = createRenderer({showReasoning: Boolean(options.showReasoning)});
    try {
      for await (const event of app.agent.run({
        message: text,
        channel: 'cli',
        requestApproval: async (request) => {
          if (auto && request.risk !== 'irreversible') return true;
          if (!rl) return false;
          return askApproval(rl, request);
        },
      })) {
        renderer.handle(event);
      }
    } finally {
      renderer.finish();
      rl?.close();
      await app.shutdown();
    }
  });

/* -------------------------------------------------------------------------- */
/* serve                                                                      */
/* -------------------------------------------------------------------------- */

program
  .command('serve')
  .description('Run the daemon: HTTP API, scheduler, reminders and Telegram bridge')
  .option('--port <port>', 'override the HTTP port')
  .option('--host <host>', 'override the bind host')
  .action(async (rawOptions?: unknown) => {
    const options = readOptions(rawOptions);
    const base = createAppOptions(globals());
    const overrides: Record<string, unknown> = {...(base.configOverrides ?? {})};
    if (options.port) overrides.server = {...(overrides.server as object), port: Number(options.port)};
    if (options.host) overrides.server = {...(overrides.server as object), host: options.host};
    const app = await createApp({...base, configOverrides: overrides});
    await runDaemon(app);
  });

/* -------------------------------------------------------------------------- */
/* init                                                                       */
/* -------------------------------------------------------------------------- */

program
  .command('init')
  .description('Create the data directory, database and a starter config')
  .action(async () => {
    const config = loadConfig({home: globals().home, configFile: globals().config});
    const db = new JarvisDB(config.paths.db);
    db.close();
    if (!fs.existsSync(config.paths.configFile)) {
      const sample = {
        assistant: {
          name: 'JARVIS',
          userName: process.env.USER ?? '',
          timezone: config.assistant.timezone,
          addressUserAs: 'sir',
          verbosity: 'concise',
        },
        llm: {provider: config.llm.provider, model: config.llm.model, embeddings: true},
        security: {approvalMode: 'balanced', allowedPaths: config.security.allowedPaths},
        proactive: {enabled: true, channels: ['console'], morningBrief: '07:30', eveningReview: '21:30'},
        integrations: {obsidian: {vaultPath: ''}, rss: {feeds: []}, mcp: {servers: []}},
      };
      fs.writeFileSync(config.paths.configFile, `${JSON.stringify(sample, null, 2)}\n`, {mode: 0o600});
    }
    console.log(
      [
        `${pc.green('✓')} Home:    ${config.paths.home}`,
        `${pc.green('✓')} Database: ${config.paths.db}`,
        `${pc.green('✓')} Config:  ${config.paths.configFile}`,
        '',
        pc.bold('Next steps'),
        '  1. Put your model key in .env (see .env.example):',
        '       OPENAI_API_KEY=...            # or ANTHROPIC_API_KEY=...',
        '       JARVIS_MODEL=...              # optional model override',
        '  2. Optional: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, then `jarvis auth google`',
        '  3. Optional: NOTION_API_KEY, GITHUB_TOKEN, HOME_ASSISTANT_URL/TOKEN, TAVILY_API_KEY',
        '  4. Start chatting:  jarvis chat',
        '  5. Run the daemon:  jarvis serve',
        '',
        pc.dim('Secrets are never written to the config file.'),
      ].join('\n'),
    );
  });

/* -------------------------------------------------------------------------- */
/* doctor                                                                     */
/* -------------------------------------------------------------------------- */

program
  .command('doctor')
  .description('Diagnose configuration, database, credentials and integrations')
  .option('--live', 'make a tiny live LLM request to verify the provider')
  .action(async (rawOptions?: unknown) => {
    const options = readOptions(rawOptions);
    const problems: string[] = [];
    const ok = (label: string, detail = ''): void => console.log(`${pc.green('ok  ')} ${label.padEnd(22)} ${pc.dim(detail)}`);
    const warn = (label: string, detail = ''): void => console.log(`${pc.yellow('warn')} ${label.padEnd(22)} ${pc.dim(detail)}`);
    const fail = (label: string, detail = ''): void => {
      problems.push(label);
      console.log(`${pc.red('fail')} ${label.padEnd(22)} ${pc.dim(detail)}`);
    };

    let config: JarvisConfig;
    try {
      config = loadCliConfig(globals());
      ok('config', config.paths.configFile);
    } catch (error) {
      fail('config', errorMessage(error));
      process.exitCode = 1;
      return;
    }

    try {
      fs.accessSync(config.paths.home, fs.constants.W_OK);
      ok('data directory', config.paths.home);
    } catch (error) {
      fail('data directory', errorMessage(error));
    }
    try {
      const stat = fs.statfsSync(config.paths.home);
      ok('disk', `${((stat.bsize * stat.bavail) / 1e9).toFixed(1)} GB free`);
    } catch {
      warn('disk', 'unavailable');
    }

    let db: JarvisDB | undefined;
    try {
      db = new JarvisDB(config.paths.db);
      const integrity = db.integrityCheck();
      if (integrity.ok) ok('database', `${config.paths.db} (${db.tableCount('memories')} memories, ${db.tableCount('messages')} messages)`);
      else fail('database', integrity.issues.join('; '));
      const audit = new AuditLog(db, config.security.audit);
      const verification = audit.verify(100_000);
      if (verification.ok) ok('audit chain', `${verification.checked} entries`);
      else fail('audit chain', `broken at ${verification.brokenAt}: ${verification.reason}`);
    } catch (error) {
      fail('database', errorMessage(error));
    }

    const secrets = new SecretStore(config.paths.secrets, {keyPath: config.paths.masterKey});
    const policy = new Policy(config);
    if (db) {
      const hub = new IntegrationsHub({config, secrets, db, policy});
      for (const entry of hub.status()) {
        if (entry.configured) ok(`integration: ${entry.name}`, entry.detail);
        else warn(`integration: ${entry.name}`, entry.detail);
      }
    }

    const providerKey =
      config.llm.provider === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : config.llm.provider === 'ollama' || config.llm.provider === 'mock'
          ? 'local'
          : process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
    if (providerKey) ok('llm credentials', `${config.llm.provider}/${config.llm.model}`);
    else fail('llm credentials', `set ${config.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}`);

    if (config.llm.embeddings && !process.env.OPENAI_API_KEY && config.llm.provider === 'anthropic') {
      warn('embeddings', 'set OPENAI_API_KEY for semantic recall');
    }

    const vault = config.integrations.obsidian.vaultPath;
    if (vault) {
      if (fs.existsSync(vault)) ok('obsidian vault', vault);
      else warn('obsidian vault', 'path does not exist');
    }

    if (options.live && !problems.includes('llm credentials')) {
      try {
        const app = await createApp(createAppOptions(globals()));
        const result = await app.llm.small.complete({
          messages: [{role: 'user', content: 'Reply with exactly: OK'}],
          tools: [],
          temperature: 0,
          maxOutputTokens: 16,
        });
        ok('live llm', result.text.trim().slice(0, 60) || '(empty)');
        await app.shutdown();
      } catch (error) {
        fail('live llm', errorMessage(error));
      }
    }

    db?.close();
    console.log('');
    if (problems.length) {
      console.log(pc.red(`${problems.length} problem(s) found.`));
      process.exitCode = 1;
    } else {
      console.log(pc.green('No blocking problems found.'));
    }
  });

/* -------------------------------------------------------------------------- */
/* auth google                                                                */
/* -------------------------------------------------------------------------- */

program
  .command('auth <provider>')
  .description('Connect an account (currently: google)')
  .action(async (provider: string) => {
    if (provider !== 'google') {
      console.log(pc.dim('Supported providers: google'));
      return;
    }
    const config = loadCliConfig(globals());
    const secrets = new SecretStore(config.paths.secrets, {keyPath: config.paths.masterKey});
    const google = GoogleClient.create({
      clientId: config.integrations.google.clientId,
      clientSecret: config.integrations.google.clientSecret,
      scopes: config.integrations.google.scopes,
      calendarId: config.integrations.google.calendarId,
      redirectPort: config.integrations.google.redirectPort,
      secrets,
    });
    if (!google) {
      console.log(
        [
          pc.yellow('Google OAuth is not configured.'),
          '',
          '1. Open https://console.cloud.google.com/apis/credentials',
          '2. Create an OAuth client of type "Desktop app"',
          `3. Add ${pc.cyan(`http://127.0.0.1:${config.integrations.google.redirectPort}`)} as an authorized redirect URI`,
          '4. Enable the Calendar, Gmail and Tasks APIs',
          '5. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then rerun this command',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }

    const {url, state} = google.authUrl();
    const port = config.integrations.google.redirectPort;
    console.log(`\nOpen this URL in your browser to authorize Google:\n\n${pc.cyan(url)}\n`);
    console.log(pc.dim(`Waiting for the callback on http://127.0.0.1:${port} (5 minute timeout)...`));

    const server = http.createServer(async (req, res) => {
      const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (requestUrl.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const code = requestUrl.searchParams.get('code');
      const returnedState = requestUrl.searchParams.get('state') ?? '';
      if (!code) {
        res.writeHead(400, {'content-type': 'text/html'}).end('<h1>Missing authorization code</h1>');
        return;
      }
      if (!google.consumeState(returnedState)) {
        res.writeHead(400, {'content-type': 'text/html'}).end('<h1>Invalid or expired state</h1>');
        return;
      }
      try {
        await google.exchangeCode(code);
        const status = await google.status();
        res.writeHead(200, {'content-type': 'text/html'}).end(`<h1>JARVIS connected to Google${status.email ? ` as ${status.email}` : ''}</h1><p>You can close this tab.</p>`);
        console.log(pc.green(`\nGoogle connected${status.email ? ` as ${status.email}` : ''}.`));
        server.close();
      } catch (error) {
        res.writeHead(500, {'content-type': 'text/html'}).end('<h1>Authorization failed</h1>');
        console.error(pc.red(`\nGoogle authorization failed: ${errorMessage(error)}`));
        server.close();
      }
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      console.error(pc.red(`Could not listen on port ${port}: ${error.message}`));
      process.exitCode = 1;
    });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.error(pc.yellow('\nTimed out waiting for Google authorization.'));
        server.close();
        resolve();
      }, 5 * 60_000);
      server.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      server.listen(port, '127.0.0.1');
    });
  });

/* -------------------------------------------------------------------------- */
/* other commands                                                             */
/* -------------------------------------------------------------------------- */

registerStorageCommands(program, globals);

program
  .command('status')
  .description('Print a one-screen system status')
  .action(async () => {
    const app = await createApp(createAppOptions(globals()));
    try {
      printStatus(app);
      printIntegrations(app);
    } finally {
      await app.shutdown();
    }
  });

program
  .command('tools')
  .description('List available tools')
  .action(async () => {
    const app = await createApp(createAppOptions(globals()));
    try {
      printToolList(app);
    } finally {
      await app.shutdown();
    }
  });

program
  .command('config:show')
  .description('Print effective config (secrets redacted)')
  .action(async () => {
    const config = loadCliConfig(globals());
    console.log(JSON.stringify(publicConfig(config), null, 2));
  });

program
  .command('logs')
  .description('Show recent log lines')
  .option('--lines <n>', 'number of lines', '80')
  .action(async (rawOptions?: unknown) => {
    const options = readOptions(rawOptions);
    const config = loadCliConfig(globals());
    try {
      const lines = fs.readFileSync(config.paths.logFile, 'utf8').trim().split('\n');
      console.log(lines.slice(-Number(options.lines)).join('\n'));
    } catch {
      console.log(pc.dim('No log file yet.'));
    }
  });

program
  .command('memories')
  .description('Alias for `jarvis memory list`')
  .action(async () => {
    const store = openStorage(globals());
    try {
      const rows = store.memory.list({limit: 20});
      for (const memory of rows) console.log(`${memory.id} ${memory.created_at.slice(0, 10)} ${memory.content.replace(/\s+/g, ' ').slice(0, 240)}`);
      if (!rows.length) console.log(pc.dim('No memories stored yet.'));
    } finally {
      store.shutdown();
    }
  });

program
  .command('backup')
  .description('Copy the SQLite database to a timestamped backup file')
  .action(async () => {
    const config = loadCliConfig(globals());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${config.paths.db}.${stamp}.bak`;
    const db = new JarvisDB(config.paths.db);
    try {
      // A plain file copy can miss recently committed WAL pages. VACUUM INTO
      // produces a consistent, compacted snapshot even with a live daemon.
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    fs.chmodSync(target, 0o600);
    console.log(`${pc.green('✓')} Backup written to ${target}`);
  });

program
  .command('version')
  .description('Show versions and runtime details')
  .action(async () => {
    const config = loadCliConfig(globals());
    console.log(
      JSON.stringify({jarvis: '2.0.0', node: process.version, platform: process.platform, model: config.llm.model, provider: config.llm.provider, home: config.paths.home}, null, 2),
    );
  });

program.configureOutput({
  outputError: (text, write) => write(pc.red(text)),
});

program
  .parseAsync(process.argv)
  .catch((error) => {
    console.error(pc.red(errorMessage(error)));
    process.exitCode = 1;
  });

export {formatInTz};
