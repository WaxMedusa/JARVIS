# JARVIS

A personal AI chief-of-staff that remembers you, acts on your systems, and runs
on your own machine. **Not a website** — it is a TypeScript backend, a terminal
assistant, a daemon with an HTTP/SSE API, scheduler and Telegram bridge, and a
self-contained macOS app that runs the whole assistant on your Mac.

JARVIS is deliberately single-user and local-first. Its memory lives in SQLite,
its credentials are encrypted on disk, and every state-changing action passes
through a policy engine and an append-only audit log.

```
  you ──► CLI / HTTP / Telegram ──► Agent ──► LLM (any provider)
                                      │
                                      ├──► long-term memory + profile + RAG
                                      ├──► tools (files, shell, web, tasks, …)
                                      ├──► integrations (Google, Notion, GitHub, …)
                                      └──► policy ──► approval ──► audit
```

## What it can do

- **Remember everything worth remembering.** Raw memories, temporally
  versioned profile facts, conversation summaries, and a searchable document
  index. Recall blends full-text search, optional embeddings, a configurable
  recency half-life, access-frequency feedback, importance, pinning and
  diversity-aware ordering.
- **Capture the day, not just the conversation.** First-class notes with FTS5
  search, tags, pinning, archiving, clipboard capture, voice dictation and
  audio-to-note transcription. Notes can be edited in the companion or CLI and
  are available to the agent as tools.
- **Act, not just chat.** 53 tools for notes, memory, tasks/reminders, files,
  shell, web search/fetch, weather, knowledge search, Google Calendar/Gmail/Tasks,
  Notion, GitHub, Linear, Home Assistant, email, RSS, Supabase sync and
  sub-agent research.
- **Be proactive.** Morning and evening briefings, due reminders, custom cron
  jobs, appointment checks, memory consolidation and maintenance.
- **Stay under your control.** Strict/balanced/autonomous approval modes, a
  path jail, a shell allowlist, SSRF protection, encrypted secrets, and a
  SHA-256 hash-chained audit log.
- **Work offline.** A deterministic mock provider powers `npm run smoke`,
  tests and development with no API key.
- **Be always there.** The macOS app is a full desktop workspace with a
  menu-bar icon and `⌘⇧J`: streaming chat, an embedded browser JARVIS can read,
  notes and voice notes, a Google/iCloud/Outlook calendar, read-only Canvas
  courses and assignments, tool activity, approvals and clipboard capture.
- **Reach you where you are.** Interactive CLI, one-shot `ask`, HTTP/SSE API,
  Telegram long-polling, the macOS companion, and speech-to-text/text-to-speech.

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite`; Node 24/26 recommended)
- npm 10+
- Optional: Docker, `ffmpeg`/`arecord` for the CLI voice recorder, a working microphone, and an audio-capable OpenAI-compatible endpoint for transcription

No native SQLite build, Python or pnpm is required.

## Quick start

```bash
git clone https://github.com/WaxMedusa/JARVIS.git
cd JARVIS
npm install

cp .env.example .env
# Edit .env: set one model provider, e.g.
#   OPENAI_API_KEY=sk-...
#   JARVIS_MODEL=gpt-4.1

npm run dev -- init      # creates ~/.jarvis, the database and a starter config
npm run dev -- chat      # start talking
```

One-shot usage:

```bash
npm run dev -- ask "What do I have tomorrow?"
npm run dev -- status
```

Install it as a command:

```bash
npm run build
npm link          # or: npm install -g .
jarvis init
jarvis chat
```

### Try it without any API key

```bash
npm run smoke
```

This runs the real agent loop, tool registry, SQLite memory and audit chain
against a scripted mock model. It should print `SMOKE TEST PASSED`.

You can also chat offline:

```bash
JARVIS_LLM_PROVIDER=mock npm run dev -- chat
```

## The macOS app

JARVIS for macOS is self-contained: the core, memory, tools, browser, Canvas and
calendar engine all ship inside the app. Download the latest DMG from
[Releases](https://github.com/WaxMedusa/JARVIS/releases) — look for
`JARVIS-*.dmg` — drag JARVIS to Applications, open it, and choose a model. No
terminal, Node install or separate `jarvis serve` is required.

Inside: streaming chat with Markdown and approvals, notes and voice notes, an
embedded browser JARVIS can read, Google Calendar/iCloud/Outlook private iCal
feeds, and read-only Canvas courses and assignments. The model key is kept in
the macOS Keychain; the private core starts on a random loopback port with a
fresh per-run token. The renderer never sees either credential.

Release 3.0.1 ships Intel and Apple silicon DMGs/ZIPs. With the five Apple
secrets configured the workflow signs with a Developer ID Application
certificate and notarizes the build; otherwise it publishes a clearly labelled
unsigned preview prerelease so the app stays installable. To build locally:

```bash
npm ci && npm run build
cd apps/companion
npm ci && npm run assets && npm run dist:mac
```

See [apps/companion/README.md](apps/companion/README.md) for first-run setup,
the security model, development preview, and signed-release setup.

## Choosing a model

JARVIS is provider-agnostic. Every OpenAI-compatible endpoint works through
`LLM_BASE_URL`, so there is no vendor lock-in.

| Provider | Configuration |
| --- | --- |
| OpenAI | `JARVIS_LLM_PROVIDER=openai`, `OPENAI_API_KEY=...`, `JARVIS_MODEL=gpt-4.1` |
| Anthropic | `JARVIS_LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...` (native API, prompt caching) |
| Ollama | `JARVIS_LLM_PROVIDER=ollama`, `JARVIS_MODEL=llama3.1` (local, no key) |
| Z.ai / OpenRouter / vLLM / LM Studio / any compatible API | `JARVIS_LLM_PROVIDER=custom`, `LLM_BASE_URL=...`, `LLM_API_KEY=...` or `OPENAI_API_KEY=...` |
| Mock | `JARVIS_LLM_PROVIDER=mock` (offline tests/demo) |

Example for Z.ai's OpenAI-compatible endpoint:

```dotenv
JARVIS_LLM_PROVIDER=custom
LLM_BASE_URL=https://api.z.ai/api/paas/v4
LLM_API_KEY=your-key
JARVIS_MODEL=glm-4.6
```

Semantic recall uses an OpenAI-compatible `/embeddings` endpoint. With an
Anthropic-only setup, either set `OPENAI_API_KEY` for embeddings or set
`JARVIS_EMBEDDINGS=false` to use keyword recall. Everything degrades gracefully:
without embeddings, full-text and recency search still work.

### Configuration precedence

`.env` seeds the defaults; a JSON config file then overrides any keys it
contains; programmatic overrides win last. Config is read from
`~/.jarvis/config.json`, a project `jarvis.config.json`, or `--config <path>`.
`jarvis init` writes a starter file to `~/.jarvis/config.json`, so **edit that
file (or delete a key) if you want the matching `.env` value to take effect**.
Use `jarvis config:show` to inspect the effective, secret-redacted config.

A fully commented example lives in
[`jarvis.config.example.json`](jarvis.config.example.json).

## Memory model

| Layer | Purpose |
| --- | --- |
| Memory | Self-contained notes, facts, events, preferences, insights, people and projects. Deduplicated by content hash, with importance, sensitivity, pinning and optional TTL. |
| Profile facts | Stable attributes keyed by slots such as `home_city` or `job_title`. Changing a value archives the old row instead of destroying history. |
| Conversations | Full transcripts, FTS5 search, and rolling summaries for long threads. |
| Documents | Files and Obsidian vaults chunked, embedded and indexed for RAG. |
| Entities/relations | Schema support for a personal graph; exposed through memory search rather than a separate UI. |
| Notes | Durable user-authored notes with FTS5 search, tags, pin/archive, clipboard capture and one local audio attachment. |
| Tasks | One-off reminders and recurring tasks with a small, explicit recurrence grammar. |

Recall combines SQLite FTS5 (BM25), optional vector cosine similarity, recency,
importance and pinning. Recency decays with a configurable half-life
(`memory.recencyHalfLifeDays`, default 90), memories that are repeatedly useful
receive an access-frequency boost, and a diversity pass (`memory.diversity`,
default 0.35) prevents one topic from crowding the whole context. The context
builder injects a bounded, relevant slice — never the whole database — into
each turn. Background consolidation extracts profile facts and summarizes old
conversations.

Useful commands:

```bash
jarvis memory add "I prefer window seats" --importance 0.7
jarvis memory search "seat preference"
jarvis memory list
jarvis memory pin <id>
jarvis memory forget <id>

jarvis profile set home_city Berlin --category location
jarvis profile list
jarvis profile history home_city

jarvis task add "Renew passport" --due 2026-11-10T09:00:00+01:00 --priority 1
jarvis task list
jarvis task done <id>

jarvis note add "Maya is waiting on the cabin dates" --title "Cabin" --tags personal,travel
jarvis note list
jarvis note search cabin
jarvis note show <id>
jarvis note pin <id>
jarvis note record --seconds 30

jarvis index ~/Notes
jarvis index ~/JarvisVault --remove-missing
```

Inside `jarvis chat`, slash commands include `/help`, `/remember <text>`,
`/memories [query]`, `/notes [query]`, `/note <text>`, `/profile`, `/tasks`,
`/conversations`, `/resume <id>`, `/new`, `/auto on|off`, `/status`, `/tools`,
`/integrations` and `/model`.

## Notes, dictation and voice notes

Notes live in SQLite, not in a model context window. Every note has a title,
free-form content, normalized tags, pin/archive state, a source and an optional
local audio recording. Notes are indexed with FTS5 and exposed to the agent as
`notes_create`, `notes_search`, `notes_get`, `notes_update`, `notes_append` and
`notes_delete`.

The macOS companion has a Notes tab with search, tag chips, pinned notes and an
archive filter. The microphone button in the composer dictates into the current
message; the Notes tab records a memo, uploads it to the local daemon, preserves
the original audio and creates a transcript note. When a real small model is
available, the daemon adds a title, summary, action items and tags; otherwise it
still stores the full transcript. Recording audio never leaves your daemon
except for the configured transcription endpoint.

```bash
jarvis note add "A thought worth keeping" --tags ideas
jarvis note search "thought"
jarvis note record --title "Morning memo" --seconds 30
jarvis note archive <id>
```

Voice settings:

```dotenv
STT_MODEL=whisper-1
STT_LANGUAGE=            # optional language hint; auto-detect when empty
JARVIS_MAX_AUDIO_MB=25
JARVIS_AUDIO_NOTE_SUMMARY=true
```

## Integrations

Every integration is optional and is skipped cleanly when unconfigured.

| Integration | Capabilities | Setup |
| --- | --- | --- |
| Google | Calendar list/create/free-busy, Gmail search/read/send/draft, Google Tasks, Drive read scope | Create a Desktop OAuth client, add `http://127.0.0.1:53682` as a redirect URI, enable Calendar/Gmail/Tasks APIs, set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, then `jarvis auth google` |
| Notion | Search, read pages, append blocks, create pages | `NOTION_API_KEY` (share the pages with the integration) |
| GitHub | Activity and issue search/read | `GITHUB_TOKEN`, optional `GITHUB_DEFAULT_REPO=owner/repo` |
| Linear | Issue listing and search | `LINEAR_API_KEY` |
| Home Assistant | Entity states and service calls | `HOME_ASSISTANT_URL` + `HOME_ASSISTANT_TOKEN` |
| Email | Recent mail via IMAP, send via SMTP | `IMAP_*`, `SMTP_*`, `EMAIL_FROM` |
| RSS | Headlines and a news digest | `RSS_FEEDS` (comma-separated) |
| Supabase | Cloud mirror of memories, profile and tasks | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, run [`docs/supabase.sql`](docs/supabase.sql), then `jarvis sync push`/`pull` |
| MCP | Any Model Context Protocol server (stdio or streamable HTTP) | `integrations.mcp.servers` in the config file |
| Web search | Tavily, Brave or SearXNG; best-effort keyless fallback | `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY` or `SEARXNG_URL` |
| Weather | Current conditions and forecasts (no key) | — |
| Telegram | Chat with JARVIS from your phone | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_IDS` |
| Voice | Dictation, audio-to-note transcription and spoken replies | An OpenAI-compatible audio endpoint (`OPENAI_API_KEY` or `LLM_API_KEY`); `ffmpeg`/`arecord` is only needed for CLI recording and playback |

MCP example:

```json
{
  "integrations": {
    "mcp": {
      "servers": [
        {
          "name": "filesystem",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/Notes"],
          "risk": "read"
        }
      ]
    }
  }
}
```

MCP tool output is treated as untrusted data. Server commands execute with your
OS permissions; only add servers you trust.

Check what is connected:

```bash
jarvis integrations
jarvis doctor          # add --live to make a tiny real model request
```

## Running the daemon

```bash
jarvis serve
# HTTP API on http://127.0.0.1:8765 by default
```

The daemon runs the HTTP API, scheduler, reminders, Telegram bridge and
periodic memory maintenance.

```bash
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/v1/status

curl -N http://127.0.0.1:8765/v1/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Brief me on today"}'
```

`/v1/chat` returns Server-Sent Events: `open`, `start`, `text`, `reasoning`,
`tool_start`, `tool_end`, `usage`, `done`, or `error`. When an action needs
approval, an `approval_required` event carries an id; approve it with
`POST /v1/approvals/:id` and `{"approved":true}`.

Main routes: `/health`, `/v1/status`, `/v1/chat`, `/v1/approvals`,
`/v1/conversations`, `/v1/memory`, `/v1/profile`, `/v1/tasks`, `/v1/notes`,
`/v1/notes/audio`, `/v1/audio/transcribe`, `/v1/calendar`,
`/v1/calendar/events`, `/v1/integrations`, `/v1/tools`, `/v1/audit`,
`/v1/index`, `/v1/sync`.

Notes are available over JSON (`GET/POST/PATCH/DELETE /v1/notes`), audio
attachments can be streamed from `GET /v1/notes/:id/audio`, and voice notes use
a multipart upload with a `file` field plus optional `title`, `tags`,
`duration_seconds` and `summarize`. `/v1/calendar` returns a setup state instead
of failing when Google is not connected.

Security rules for the API:

- It binds to loopback by default.
- A non-loopback bind is refused unless `JARVIS_API_TOKEN` is set.
- When a token is set, every `/v1/*` request needs `Authorization: Bearer <token>`.
- `/health` is public; keep the port on a trusted network or behind a reverse
  proxy with TLS.

### Proactive jobs

Morning briefings (`07:30`), evening reviews (`21:30`), a weekly review,
appointment checks, due reminders and custom cron jobs run while the daemon is
up. Configure channels (`console`, `telegram`, webhook) and quiet hours in the
config. Custom jobs use five-field cron syntax:

```json
{
  "proactive": {
    "jobs": [
      {
        "name": "monday_planning",
        "cron": "0 9 * * 1",
        "prompt": "Plan my week from calendar, tasks and open loops.",
        "channel": "telegram"
      }
    ]
  }
}
```

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Set `TELEGRAM_BOT_TOKEN`.
3. Put your numeric chat id(s) in `TELEGRAM_ALLOWED_CHAT_IDS` (comma-separated).
4. Run `jarvis serve` and message the bot. Unlisted chats are ignored.

## Docker

```bash
docker build -t jarvis .

# Daemon (non-loopback bind requires an API token)
docker run --rm -it \
  --env-file .env \
  -e JARVIS_API_TOKEN=choose-a-long-random-token \
  -p 8765:8765 \
  -v jarvis-data:/data \
  jarvis

# Interactive CLI in the same volume
docker run --rm -it --env-file .env -v jarvis-data:/data jarvis chat
```

The image runs as the unprivileged `node` user with `JARVIS_HOME=/data`.
Everything persistent (database, master key, encrypted secrets, logs) lives in
that volume. Back it up as a unit.

## CLI reference

| Command | Purpose |
| --- | --- |
| `jarvis init` | Create the data directory, database and starter config |
| `jarvis chat` | Interactive conversation with streaming, tools and approvals |
| `jarvis ask <question>` | One-shot question and answer |
| `jarvis serve` | HTTP API + scheduler + Telegram daemon |
| `jarvis status` | One-screen status and integration overview |
| `jarvis doctor [--live]` | Diagnose config, DB, audit chain, credentials and integrations |
| `jarvis tools` | List the tool catalog |
| `jarvis memory ...` | list / search / add / forget / pin |
| `jarvis profile ...` | list / set / history / delete |
| `jarvis task ...` | add / list / done / cancel / delete |
| `jarvis note ...` | list / search / add / show / record / pin / archive / delete |
| `jarvis index <path>` | Index files or folders for RAG |
| `jarvis integrations` | Show integration status and setup hints |
| `jarvis audit [--verify]` | Inspect or verify the audit chain |
| `jarvis sync [push\|pull]` | Mirror memory/profile/tasks with Supabase |
| `jarvis voice [--say\|--listen\|--chat]` | Speak or listen |
| `jarvis config:show` | Print effective config with secrets redacted |
| `jarvis logs` | Tail the JSON log |
| `jarvis backup` | Copy the SQLite database to a timestamped backup |
| `jarvis version` | Versions and runtime details |

Global flags: `--home <path>`, `--config <path>`, `--no-mcp`, `--verbose`,
`--yes` (auto-approve reversible actions; irreversible actions still ask).

## Security

Read [docs/SECURITY.md](docs/SECURITY.md) before exposing the daemon or
connecting sensitive accounts. The short version:

- **Approval modes:** `strict` asks for writes and execution, `balanced`
  (default) asks only for state-changing tool calls, `autonomous` allows them.
  Irreversible actions always require explicit consent unless
  `JARVIS_ALLOW_IRREVERSIBLE=true`.
- **Path jail:** file tools are confined to `security.allowedPaths`; symlinks
  are resolved before the check; `.ssh`, `.gnupg`, `.aws`, `.kube`, keys and the
  JARVIS database itself are denied by default.
- **Shell:** only allowlisted command prefixes run without approval, and shell
  chaining/redirection always asks. Destructive patterns are denied.
- **Network:** only HTTP(S); embedded credentials, loopback/private/link-local
  addresses and cloud metadata endpoints are blocked unless
  `allowPrivateNetwork` is enabled. DNS is resolved before the request.
- **Secrets:** OAuth tokens and keys are stored in an AES-256-GCM encrypted
  file; the master key is a separate `0600` file. Losing it makes the vault
  unrecoverable.
- **Audit:** every tool decision and execution is appended to a SHA-256
  hash chain. `jarvis audit --verify` detects edits or deletions.
- **Untrusted content:** web pages, emails, documents and MCP results are
  treated as data. The policy engine, not the model, enforces permissions.

## Testing and development

```bash
npm run typecheck
npm test
npm run smoke
npm run build
```

Tests cover memory/profile versioning, hybrid recall, recency/access/diversity
ranking, notes/FTS/tags/archive, audio-to-note persistence, the HTTP API, the
path jail and symlink escapes, shell and SSRF policy, cron/recurrence, document
chunking, the tool registry's validation/approval flow, and the agent loop
including loop detection. The companion has its own `node:test` suite for SSE
framing, the daemon client (including notes, calendar and multipart audio) and
settings validation.
No network or API keys are needed:

```bash
npm test                        # backend (Vitest)
cd apps/companion && npm test   # companion (node:test)
```

Project layout:

```
src/
  cli/          commander commands, storage shortcuts, terminal rendering
  agent/        system prompt, context builder, multi-step loop, sub-agent
  memory/       memories, notes, profile, conversations, tasks, documents, consolidation
  notes/        audio-to-note orchestration and structured transcript capture
  tools/        registry + 53 tools
  integrations/ Google, Notion, GitHub, Linear, HA, email, RSS, Supabase, MCP
  security/     policy, encrypted secrets, audit chain
  llm/          OpenAI-compatible, Anthropic, embeddings, mock
  server/       Hono HTTP/SSE API, approvals, Telegram, daemon
  scheduler/    cron, briefings, reminders, maintenance
  db/           schema migrations + typed SQLite wrapper
  notify/       console, webhook, Telegram, desktop notifications
docs/           architecture, security, Supabase schema
tests/          Vitest suite
apps/companion/ self-contained macOS app (Electron + bundled core, own tests/workflow)
scripts/smoke.ts offline end-to-end check
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for request flow, memory
scoring, persistence and extension points.

## Known limitations

- Single-user by design. There is no account system or multi-tenant isolation.
- The shell tool is policy-gated, not OS-sandboxed. It runs with your user
  privileges; use a dedicated OS account or container for hard isolation.
- The audit chain is tamper-evident, not externally notarized. An attacker who
  can rewrite the whole database can rebuild the chain.
- Live provider, OAuth, Telegram and Supabase paths need real credentials;
  they are not exercised by the offline test suite.
- Voice needs a microphone and an audio-capable OpenAI-compatible model
  endpoint. The companion records through Electron's microphone permission;
  the CLI recorder additionally needs `ffmpeg`/`arecord` and a player.
- Live Google Calendar, transcription and signed builds need real credentials;
  they are not exercised by the offline suite. The companion preview uses a
  simulated bridge.
- MCP servers are arbitrary programs and inherit your permissions.
- Signed and notarized macOS releases need an Apple Developer account and five
  repository secrets. The release workflow publishes a labelled unsigned
  preview prerelease when they are absent, and never presents it as signed.

## License

Private personal project. Add a license before distributing.
