# Architecture

JARVIS is a single-process, single-user TypeScript application with several
front ends and one agent core. This document describes how a request flows,
how state is stored, and where to extend it.

## Process graph

```
 CLI (chat/ask) ─┐
 HTTP + SSE ─────┼──► Agent ──► ContextBuilder ──► LLM provider
 Telegram ───────┘      │
 Scheduler ─────────────┤
                        ├──► ToolRegistry ──► Policy ──► approval ──► tools
                        │                         │
                        │                         └──► AuditLog (hash chain)
                        ├──► MemoryService / ConversationStore / TaskService
                        ├──► DocumentIndex (FTS + optional vectors)
                        └──► IntegrationsHub (Google, Notion, GitHub, …)
```

The composition root is [`src/core/app.ts`](../src/core/app.ts). `createApp()`
loads and validates config, opens SQLite, builds the encrypted secret store,
policy engine, audit log, memory services, integrations, tool registry, context
builder, agent and optional MCP connections. The CLI, daemon and tests all use
the same graph; `scripts/smoke.ts` injects a mock LLM set.

## Startup sequence

1. `loadConfig` reads `.env` from the working directory and JARVIS home, applies
   defaults seeded by the environment, merges the JSON config file and any
   programmatic overrides, validates with Zod, resolves paths/timezone and
   creates the data, log and temp directories.
2. `JarvisDB` opens SQLite with WAL, foreign keys, a busy timeout and applies
   ordered migrations.
3. The logger is configured (pretty on a TTY, JSON lines to a file otherwise).
4. Services are constructed; the registry registers built-in tools; MCP
   servers are connected if configured.
5. An `app.start` audit entry records provider, model, tool count, approval mode
   and configured integrations.
6. The chosen front end starts. `shutdown()` closes MCP transports, writes an
   `app.stop` entry and closes the database.

## Agent loop

[`src/agent/agent.ts`](../src/agent/agent.ts) implements a bounded tool loop:

1. Resolve or create the conversation, persist the user message and redact
   secrets from what is stored.
2. Build context: system prompt/persona, current time and user profile, recalled
   memories, relevant document chunks, open tasks, rolling conversation summary
   and recent messages. Everything is bounded by character budgets and the
   provider's context window.
3. Stream the model response. Text and reasoning are forwarded as events; tool
   calls are accumulated.
4. For each tool call: validate arguments with Zod, run the policy check,
   request approval if required, execute with a timeout and abort signal,
   truncate oversized output, audit the result and append a `tool` message.
5. Repeat until the model stops calling tools, the step limit is reached, or an
   error occurs. Repeated identical calls are detected and answered with a
   "do not repeat" tool result instead of looping forever.
6. Persist the assistant message, update the conversation title/turn count and
   trigger asynchronous fact extraction/summarization according to policy.

Events are a small discriminated union (`start`, `text`, `reasoning`,
`tool_start`, `tool_end`, `usage`, `done`, `error`). The CLI renderer, HTTP SSE
writer and tests consume the same stream; no front end reaches into the loop.

A separate research runner (`runResearch`) can be delegated to as a sub-agent
with its own smaller step budget and tool set. `delegate_research` exposes it to
the main model.

## Memory and retrieval

SQLite is the source of truth. The data model is intentionally boring:

| Table | Role |
| --- | --- |
| `memories` | Raw durable statements with kind, source, importance, sensitivity, pin, TTL, hash and optional embedding |
| `memories_fts` | FTS5 index, kept in sync by insert/delete/update triggers |
| `profile_facts` | Keyed stable attributes; a partial unique index allows one active value per key; `superseded_by` preserves history |
| `conversations`, `messages`, `messages_fts` | Transcripts and full-text history search |
| `documents`, `chunks`, `chunks_fts` | Indexed files, overlapping chunks and their search index |
| `entities`, `relations` | Personal graph primitives |
| `tasks` | Reminders/recurrence with due and notification state |
| `audit_log` | Append-only hash chain |
| `jobs` | Scheduler jobs |
| `approvals` | Pending/decided approval records for the HTTP broker |
| `sync_state`, `kv`, `meta` | Sync cursors, small state and schema bookkeeping |

### Recall

`MemoryService.search` first builds a safe FTS5 query from the user's terms,
fetches keyword candidates with BM25, and (when an embedder is available)
computes cosine similarity against stored vectors. Candidates are combined with
recency, importance, pinned status and access frequency, then re-ranked with a
diversity-aware MMR-style pass so a single topic cannot crowd out the context.
Recency uses an exponential decay with a configurable half-life
(`memory.recencyHalfLifeDays`); repeated recall of a memory raises its access
signal, providing lightweight reinforcement. Results carry the contributing
signals (`keyword`, `vector`, `recency`, `importance`, `pinned`, `access`) for
debugging and UI display.

Embeddings are optional. Without an embedding endpoint, recall is keyword +
recency + importance + diversity and all features still work. Embeddings are
stored as little-endian float32 blobs; changing the embedding model requires
reindexing.

### Consolidation

After enough turns (configurable), the consolidator asks the small model to
extract durable facts, update profile slots and summarize old messages. It uses
the same versioning rules as manual profile edits, so automated extraction cannot
silently destroy history. Maintenance prunes low-value, expired or excess
memories according to retention settings.

## Tools and permissions

Every tool is a `ToolDefinition` with a Zod schema, risk level, category,
timeout and handler. `ToolRegistry` converts the schema to JSON Schema for the
model, validates inputs, applies the policy, handles approval and timeout,
truncates output, and records audit entries.

Risk tiers:

| Risk | Meaning | Typical examples |
| --- | --- | --- |
| `read` | No local state change | `recall`, `read_file`, `web_search` |
| `internal` | Reversible state inside JARVIS | `remember`, `create_task`, `update_profile` |
| `write` | Changes files or external local state | `write_file`, `index_documents` |
| `execute` | Runs a process | `run_shell` |
| `external` | Reads from a third party | Gmail read, GitHub, weather |
| `irreversible` | Sends, deletes, spends | `gmail_send`, `email_send`, `forget_memory` (write + explicit user intent) |

The policy engine also inspects arguments: paths go through the jail, URLs
through the SSRF check, shell commands through the allowlist/danger patterns.
Approval is requested only when the resulting decision is `ask`.

## Persistence and migrations

[`src/db/migrations.ts`](../src/db/migrations.ts) is append-only. Each migration
has a version and a SQL script; it is applied inside a transaction and recorded
in `_migrations`. Migrations use `IF NOT EXISTS`, FTS5 virtual tables and
triggers. `JarvisDB` exposes only prepared-statement helpers (`get`, `all`,
`run`), transactions with savepoint nesting, integrity checks and KV helpers.
Never interpolate user data into SQL; all queries are parameterized.

## LLM abstraction

`src/llm` defines a streaming provider interface and two implementations:

- **OpenAI-compatible** (`openai` package) for OpenAI, Z.ai, OpenRouter, vLLM,
  LM Studio, Ollama and compatible gateways.
- **Anthropic** native Messages API with SSE and prompt caching.
- **Mock** for deterministic tests and offline development.
- **Embeddings** wrapper for OpenAI-compatible `/embeddings` endpoints.

Provider selection, base URL and API key resolution live in
`src/config.ts`/`src/llm/index.ts`. Retries with exponential backoff, request
timeouts, usage accounting and error normalization are shared in
`src/llm/retry.ts`. A provider failure surfaces as an `error` event; the daemon
keeps running.

## Integrations

`IntegrationsHub` constructs every configured client once and exposes a status
list. Clients return `null` when unconfigured so tools can report a helpful
setup message rather than throwing. OAuth refresh tokens are kept in the
encrypted `SecretStore`, never in the config file.

- **Google**: OAuth loopback flow, Calendar, Gmail, Tasks, Drive read scope.
- **Notion / GitHub / Linear / Home Assistant / email / RSS**: token or
  host/credential based REST/IMAP/SMTP clients.
- **Supabase**: REST upsert/pull of memories, profile facts and tasks, with
  per-row timestamp comparison and a sync cursor.
- **MCP**: stdio and streamable HTTP clients from the official SDK. Their tools
  are registered dynamically with the configured risk level and their output is
  wrapped as untrusted data.

## Scheduler and delivery

[`src/scheduler/scheduler.ts`](../src/scheduler/scheduler.ts) runs in the
daemon. It matches five-field cron expressions, checks clock-based briefings,
sends due reminders, advances recurring tasks, runs appointment checks, applies
quiet hours, and performs periodic memory maintenance. Notifications go through
`NotificationHub` (console, webhook, Telegram, desktop). Jobs and their last
status are persisted; a failed job is logged and retried on its next schedule.

The Telegram bridge uses long polling, enforces the chat-id allowlist, and runs
the same agent loop as the CLI. The HTTP API exposes chat over SSE and an
approval broker for remote approval flows.

## Extension points

**Add a tool**

1. Define it with `defineTool({name, description, schema, risk, category,
   handler})` in `src/tools/`.
2. Add it to the relevant exported array.
3. Register that array in `src/core/app.ts`.
4. Add a policy test if it touches paths, URLs or shell commands.

**Add a provider**

Implement the streaming provider interface in `src/llm/`, add the provider to
the config enum/factory, and keep the `LLMStreamEvent` contract unchanged.

**Add an integration**

Add a config section, a client with a `create()` that returns `null` when
unconfigured, status wiring in `IntegrationsHub`, tool wrappers, and setup
documentation. Never put long-lived credentials in config JSON.

**Add a scheduled job**

Prefer a config-driven `proactive.jobs` entry. Use code only for jobs that need
internal services; keep prompts bounded and idempotent.
