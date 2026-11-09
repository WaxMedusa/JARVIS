import type {Command} from 'commander';
import pc from 'picocolors';
import {publicConfig} from '../config.js';
import {errorMessage} from '../core/errors.js';
import {formatInTz} from '../core/time.js';
import {IntegrationsHub} from '../integrations/index.js';
import {SupabaseClient} from '../integrations/supabase.js';
import {VoiceService} from '../voice/index.js';
import {createAppOptions, openStorage, type CliGlobalOptions} from './storage.js';
import {createApp} from '../core/app.js';

function options(raw: unknown): Record<string, any> {
  if (raw && typeof (raw as Command).opts === 'function') return (raw as Command).opts();
  return (raw as Record<string, any>) ?? {};
}

export function registerStorageCommands(program: Command, globals: () => CliGlobalOptions): void {
  program
    .command('memory <action> [values...]')
    .description('Long-term memory: list | search <query> | add <text> | forget <id> | pin <id>')
    .option('--limit <n>', 'result limit', '20')
    .option('--kind <kind>', 'memory kind')
    .option('--importance <n>', 'importance 0-1', '0.6')
    .option('--off', 'unpin instead of pin')
    .action(async (action: string, values: string[] = [], rawOptions?: unknown) => {
      const opts = options(rawOptions);
      const store = openStorage(globals());
      try {
        switch (action) {
          case 'list': {
            const rows = store.memory.list({limit: Number(opts.limit), kind: opts.kind});
            if (!rows.length) return console.log(pc.dim('No memories stored.'));
            for (const memory of rows) {
              console.log(`${pc.cyan(memory.id)} ${pc.dim(memory.created_at.slice(0, 10))} ${pc.dim(`[${memory.kind}]`)} ${memory.content.replace(/\s+/g, ' ').slice(0, 300)}`);
            }
            break;
          }
          case 'search': {
            const query = values.join(' ').trim();
            if (!query) throw new Error('Usage: jarvis memory search <query>');
            const hits = await store.memory.search(query, {limit: Number(opts.limit)});
            if (!hits.length) return console.log(pc.dim('No matches.'));
            for (const hit of hits) {
              console.log(`${pc.cyan(hit.memory.id)} ${pc.dim(`(${(hit.score * 100).toFixed(0)}%, ${hit.via.join('+')})`)} ${hit.memory.content.replace(/\s+/g, ' ').slice(0, 300)}`);
            }
            break;
          }
          case 'add':
          case 'remember': {
            const content = values.join(' ').trim();
            if (!content) throw new Error('Usage: jarvis memory add <text>');
            const memory = await store.memory.remember({content, kind: opts.kind ?? 'note', importance: Number(opts.importance), source: 'cli'});
            console.log(`Stored ${pc.cyan(memory.id)}.`);
            break;
          }
          case 'forget': {
            const id = values[0];
            if (!id) throw new Error('Usage: jarvis memory forget <id>');
            console.log(store.memory.delete(id) ? 'Deleted.' : 'Memory not found.');
            break;
          }
          case 'pin': {
            const id = values[0];
            if (!id) throw new Error('Usage: jarvis memory pin <id> [--off]');
            console.log(store.memory.setPinned(id, !opts.off) ? 'Updated.' : 'Memory not found.');
            break;
          }
          default:
            console.log(pc.dim('Actions: list, search, add, forget, pin'));
        }
      } finally {
        store.shutdown();
      }
    });

  program
    .command('profile <action> [values...]')
    .description('User profile: list | set <key> <value> | history <key> | delete <id>')
    .option('--category <category>', 'fact category', 'general')
    .option('--confidence <n>', 'confidence 0-1', '0.9')
    .action(async (action: string, values: string[] = [], rawOptions?: unknown) => {
      const opts = options(rawOptions);
      const store = openStorage(globals());
      try {
        if (action === 'list') {
          const facts = store.memory.getProfile({limit: 500});
          if (!facts.length) return console.log(pc.dim('No profile facts yet.'));
          for (const fact of facts) console.log(`${pc.cyan(fact.category)}/${fact.key}: ${fact.value} ${pc.dim(`(${fact.confidence.toFixed(2)}, ${fact.source ?? 'unknown'})`)}`);
          return;
        }
        if (action === 'set') {
          const [key, ...rest] = values;
          const value = rest.join(' ').trim();
          if (!key || !value) throw new Error('Usage: jarvis profile set <key> <value>');
          const result = await store.memory.setFact({key, value, category: opts.category, confidence: Number(opts.confidence), source: 'cli'});
          console.log(`Profile updated: ${result.fact.key} = ${result.fact.value}${result.superseded ? pc.dim(` (previous: ${result.superseded.value})`) : ''}`);
          return;
        }
        if (action === 'history') {
          const key = values[0];
          if (!key) throw new Error('Usage: jarvis profile history <key>');
          const history = store.memory.historyFor(key);
          if (!history.length) return console.log(pc.dim('No history for that key.'));
          for (const fact of history) console.log(`${fact.created_at.slice(0, 10)} ${fact.value}${fact.superseded_by ? pc.dim(' (superseded)') : pc.green(' (active)')}`);
          return;
        }
        if (action === 'delete') {
          const id = values[0];
          if (!id) throw new Error('Usage: jarvis profile delete <id>');
          console.log(store.memory.deleteFact(id) ? 'Deleted.' : 'Fact not found.');
          return;
        }
        console.log(pc.dim('Actions: list, set, history, delete'));
      } finally {
        store.shutdown();
      }
    });

  program
    .command('task <action> [values...]')
    .description('Tasks: add <title> | list | done <id> | cancel <id> | delete <id>')
    .option('--due <iso>', 'due timestamp, ISO-8601')
    .option('--repeat <spec>', 'daily | weekdays | weekly | monthly | every:2:weeks')
    .option('--priority <n>', '1 high, 2 normal, 3 low', '2')
    .option('--notes <text>', 'notes')
    .option('--all', 'include completed')
    .option('--limit <n>', 'limit', '40')
    .action(async (action: string, values: string[] = [], rawOptions?: unknown) => {
      const opts = options(rawOptions);
      const store = openStorage(globals());
      try {
        if (action === 'add' || action === 'create') {
          const title = values.join(' ').trim();
          if (!title) throw new Error('Usage: jarvis task add <title> [--due ISO]');
          const task = store.tasks.create({
            title,
            dueAt: opts.due,
            recurrence: opts.repeat,
            priority: Number(opts.priority),
            notes: opts.notes,
            source: 'cli',
          });
          console.log(store.tasks.format(task));
          return;
        }
        if (action === 'list') {
          const tasks = store.tasks.list({status: opts.all ? 'all' : 'open', includeCompleted: Boolean(opts.all), limit: Number(opts.limit)});
          if (!tasks.length) return console.log(pc.dim('No tasks.'));
          for (const task of tasks) console.log(store.tasks.format(task));
          return;
        }
        if (action === 'done') {
          const id = values[0];
          if (!id) throw new Error('Usage: jarvis task done <id>');
          const task = store.tasks.complete(id);
          console.log(task ? store.tasks.format(task) : 'Task not found.');
          return;
        }
        if (action === 'cancel') {
          const id = values[0];
          if (!id) throw new Error('Usage: jarvis task cancel <id>');
          console.log(store.tasks.cancel(id) ? 'Cancelled.' : 'Task not found.');
          return;
        }
        if (action === 'delete') {
          const id = values[0];
          if (!id) throw new Error('Usage: jarvis task delete <id>');
          console.log(store.tasks.delete(id) ? 'Deleted.' : 'Task not found.');
          return;
        }
        console.log(pc.dim('Actions: add, list, done, cancel, delete'));
      } finally {
        store.shutdown();
      }
    });

  program
    .command('index <path>')
    .description('Index a folder or file into the searchable knowledge base')
    .option('--no-recursive', 'do not descend into subfolders')
    .option('--remove-missing', 'drop documents whose files disappeared')
    .action(async (target: string, rawOptions?: unknown) => {
      const opts = options(rawOptions);
      const store = openStorage(globals());
      try {
        console.log(pc.dim(`Indexing ${target}...`));
        const stats = await store.documents.indexPath(target, {recursive: opts.recursive !== false});
        console.log(`Scanned ${stats.scanned}, indexed ${stats.indexed}, skipped ${stats.skipped}, chunks ${stats.chunks}.`);
        if (stats.errors.length) console.log(pc.yellow(`Issues: ${stats.errors.slice(0, 8).join('; ')}`));
        if (opts.removeMissing) await store.documents.removeMissing(target);
      } finally {
        store.shutdown();
      }
    });

  program
    .command('integrations')
    .description('Show integration status and setup hints')
    .action(async () => {
      const store = openStorage(globals());
      try {
        const hub = new IntegrationsHub({config: store.config, secrets: store.secrets, db: store.db, policy: store.policy});
        for (const row of hub.status()) {
          console.log(`${row.configured ? pc.green('ready') : pc.dim('off  ')} ${pc.bold(row.label.padEnd(32))} ${pc.dim(row.detail)}`);
        }
        console.log('');
      } finally {
        store.shutdown();
      }
    });

  program
    .command('audit')
    .description('Inspect the tamper-evident audit log')
    .option('--limit <n>', 'entries to show', '30')
    .option('--verify', 'verify the hash chain')
    .action(async (rawOptions?: unknown) => {
      const opts = options(rawOptions);
      const store = openStorage(globals());
      try {
        if (opts.verify) {
          const result = store.audit.verify(100_000);
          console.log(result.ok ? pc.green(`Audit chain intact (${result.checked} entries).`) : pc.red(`Audit chain broken at entry ${result.brokenAt}: ${result.reason}`));
        }
        for (const entry of store.audit.tail(Number(opts.limit))) {
          console.log(`${pc.dim(entry.ts)} ${pc.cyan(entry.action)} ${pc.dim(entry.actor)} ${(entry.detail ?? '').slice(0, 300)}`);
        }
      } finally {
        store.shutdown();
      }
    });

  program
    .command('config')
    .description('Print the effective configuration with secrets redacted')
    .action(async () => {
      const store = openStorage(globals());
      try {
        console.log(JSON.stringify(publicConfig(store.config), null, 2));
      } finally {
        store.shutdown();
      }
    });

  program
    .command('sync [direction]')
    .description('Sync memory/profile/tasks with Supabase: push (default) or pull')
    .action(async (direction = 'push') => {
      const store = openStorage(globals());
      try {
        const supabase = SupabaseClient.create({
          url: store.config.integrations.supabase.url,
          key: store.config.integrations.supabase.key,
          tablePrefix: store.config.integrations.supabase.tablePrefix,
          db: store.db,
        });
        if (!supabase) throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and create the tables in docs/supabase.sql.');
        const result = direction === 'pull' ? await supabase.pull() : await supabase.push();
        console.log(JSON.stringify(result, null, 2));
      } finally {
        store.shutdown();
      }
    });

  program
    .command('voice [text...]')
    .description('Voice: say text aloud, or listen and optionally chat')
    .option('--say <text>', 'synthesize and play text')
    .option('--listen', 'record and transcribe')
    .option('--chat', 'with --listen, send the transcript to JARVIS and speak the reply')
    .option('--seconds <n>', 'recording length', '8')
    .action(async (text: string[] = [], rawOptions?: unknown) => {
      const opts = options(rawOptions);
      const store = openStorage(globals());
      const voice = new VoiceService(store.config);
      let app: Awaited<ReturnType<typeof createApp>> | undefined;
      try {
        const spoken = opts.say ?? text.join(' ').trim();
        if (spoken) {
          const file = await voice.speak(spoken);
          console.log(pc.dim(`Played ${file ?? 'audio'}.`));
          return;
        }
        if (!opts.listen) {
          console.log(pc.dim('Usage: jarvis voice "text to say" | jarvis voice --listen [--chat]'));
          return;
        }
        const file = await voice.record(Number(opts.seconds));
        const transcript = await voice.transcribe(file);
        console.log(`${pc.bold('You (voice):')} ${transcript}`);
        if (!opts.chat || !transcript) return;
        app = await createApp(createAppOptions(globals()));
        const result = await app.agent.runToCompletion({message: transcript, channel: 'voice'});
        console.log(`${pc.bold('JARVIS:')} ${result.text}`);
        await voice.speak(result.text);
      } finally {
        await app?.shutdown();
        store.shutdown();
      }
    });
}

export function printMemoryLine(createdAt: string, kind: string, content: string, timezone: string): string {
  return `${pc.dim(formatInTz(createdAt, timezone, {dateStyle: 'short'}))} ${pc.dim(`[${kind}]`)} ${content.replace(/\s+/g, ' ').slice(0, 280)}`;
}

export {errorMessage};
