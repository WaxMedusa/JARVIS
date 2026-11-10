# Security model

JARVIS is a personal agent with access to your files, accounts and machine. It
is built on the assumption that **the model can be wrong or manipulated**, so
permissions are enforced in code, not in the prompt.

## Threat model

Relevant adversaries and failure modes:

- A malicious web page, email, document, RSS item or MCP result that tries to
  instruct the model to exfiltrate data or run commands (prompt injection).
- A model mistake: wrong path, destructive shell command, overly broad query.
- A leaked OAuth token, API key or Telegram bot token.
- A local attacker or accidental exposure of the HTTP daemon.
- Silent tampering with the action history.

Out of scope: a compromised OS account, a malicious kernel/driver, a malicious
npm dependency at install time, and protection against an attacker who can
rewrite all files and the audit chain together. There is no multi-user
authorization model.

## Enforcement layers

### 1. Approval modes and risk tiers

Every tool call has a risk: `read`, `internal`, `write`, `execute`, `external`
or `irreversible`.

| Mode | `read` / `internal` / `external` | `write` / `execute` | `irreversible` |
| --- | --- | --- | --- |
| `strict` | allow | ask | ask |
| `balanced` (default) | allow | ask | ask |
| `autonomous` | allow | allow | ask |

`JARVIS_ALLOW_IRREVERSIBLE=true` removes the final gate — use it only with
close supervision. `security.alwaysApprove` and `security.toolAllow/Deny` can
narrow or widen the policy for specific tools. Approval requests show the tool,
risk, a human-readable summary and the arguments.

The CLI prompts on a TTY. The HTTP API emits `approval_required` over SSE and
waits for `POST /v1/approvals/:id` (120-second timeout). Without an approval
callback, an `ask` decision is denied.

### 2. Path jail

File tools resolve every path (including `~`) and check it against
`security.allowedPaths` using a normalized, separator-aware prefix test. For
existing paths, `realpath` resolves symlinks before the check; for new files,
the nearest existing parent is resolved. This prevents `../` traversal and
symlink escapes. Denied patterns include `.ssh`, `.gnupg`, `.aws`, `.kube`,
`*.pem`, `master.key`, `secrets.enc` and the database/WAL files. Deny patterns
win over the allowlist.

Writes default to requiring approval in balanced mode. Sensitive paths cannot
be approved into existence by the model; the policy denies them outright.

### 3. Shell guard

`run_shell` accepts only commands or command prefixes on
`security.shellAllowlist` (for example `ls`, `grep`, `git status`). Anything
else requires approval. The following always require approval:

- shell chaining, pipes, redirection, command substitution or backgrounding;
- a command not on the allowlist.

The following are denied regardless of mode: `rm -rf /`, `mkfs`, writes to raw
devices, shutdown/reboot, fork bombs, `curl|sh`/`wget|sh`, recursive `chmod 777
/`, `history -c`, and `passwd`. This is a guardrail, not an OS sandbox: an
approved command runs with your full user privileges.

### 4. Network / SSRF guard

Only `http:` and `https:` are allowed. URLs containing embedded credentials are
rejected. Hostnames are lowercased, DNS-resolved and checked against loopback,
private, link-local, multicast and cloud-metadata ranges. Redirect targets are
checked as well. `security.allowPrivateNetwork=true` is required for Home
Assistant or local model endpoints; enable it deliberately.

Web fetches have size and timeout caps. Tool output is truncated before it is
returned to the model and stored in the transcript.

### 5. Secrets at rest

`SecretStore` encrypts a JSON key/value vault with AES-256-GCM, a random 12-byte
IV, an auth tag and the AAD `jarvis-secrets-v1`. The 32-byte master key comes
from `JARVIS_MASTER_KEY` or a local `master.key` file created with mode `0600`;
the vault is written atomically with mode `0600`. Plaintext secrets are never
written to the config file or logs. Rotating/deleting the master key makes the
vault unrecoverable; back them up together.

Environment variables (`.env`) are read into the process; they are not encrypted
by JARVIS. Keep `.env` at mode `0600` and out of version control.

### 6. Prompt-injection containment

System instructions tell the model that tool output, web pages, emails and
documents are untrusted data. MCP results are wrapped in
`<untrusted_mcp_result>` delimiters. More importantly, the model cannot bypass
the policy engine: every tool still passes through risk checks, path/URL/shell
validation and approvals. Tool descriptions from MCP servers are untrusted too;
only connect servers you trust, and prefer the lowest useful `risk` setting.

### 7. Audit chain

Every approval, denial, execution and failure appends a row containing
`sha256(prev_hash | timestamp | actor | action | serialized_detail)`. Detail is
redacted and truncated before hashing. `jarvis audit --verify` recomputes the
chain and reports the first broken id. This detects edits and deletions unless
the entire history was rebuilt consistently. It is not an external timestamp or
notarization.

### 8. HTTP API

- Binds `127.0.0.1` by default.
- Refuses a non-loopback bind without `JARVIS_API_TOKEN`.
- When a token is configured, all `/v1/*` routes require
  `Authorization: Bearer <token>` using a timing-safe comparison.
- `/health` is public and intentionally minimal.
- Request bodies are capped (`server.maxBodyBytes`, default 2 MiB); the two
  audio upload routes get an explicit `voice.maxAudioBytes` cap (default 25 MiB)
  plus a small multipart allowance, and chat input is capped at 32,000
  characters. Audio MIME types are validated before transcription.
- Note audio is stored under `<JARVIS_HOME>/notes-audio` with mode `0600`, is
  never returned by the notes list, and is streamed only through the
  authenticated `/v1/notes/:id/audio` route.
- No CORS wildcard is enabled. If you put it behind a reverse proxy, terminate
  TLS there and keep the upstream on a private network.

### 9. Telegram

Only chat ids in `TELEGRAM_ALLOWED_CHAT_IDS` are served. The bot token is read
from the environment or the encrypted store, not the config file. Revoke it via
BotFather if leaked.

### 10. Redaction and logging

Logs are structured JSON and pass through redaction for common secret keys and
token-shaped values before writing. The transcript records redacted content for
stored messages. Redaction is best-effort; treat logs as sensitive and protect
the data directory.

### 11. macOS companion

The companion is a renderer, not a second policy engine. It can only ask the
daemon to do something; every request still passes through the daemon's
approval, path, shell and network controls.

- The BrowserWindow uses `sandbox: true`, `contextIsolation: true` and
  `nodeIntegration: false`. The preload exposes a fixed IPC allowlist, not
  `ipcRenderer` itself.
- All HTTP and SSE traffic happens in the Electron main process. An API token is
  stored with `safeStorage` (macOS Keychain-backed) and is never returned to the
  renderer or embedded in the page.
- Every IPC handler validates that the sender is the companion window.
- The renderer has a restrictive CSP (`connect-src 'none'`, no remote scripts).
  Its permission handler allows only `media` audio for this one window; camera
  and screen capture remain denied. Navigation is blocked; only explicit
  HTTP(S) links are handed to the default browser.
- Clipboard capture is user-triggered and truncated to 8,000 characters.
- Voice audio goes from the renderer to the main process over IPC and then to
  the local daemon. The renderer never receives the daemon API token, and audio
  is sent only to the configured transcription endpoint.
- Release artifacts built by the workflow are produced on GitHub macOS runners.
  With the five Apple secrets configured, the build is signed with a Developer
  ID Application certificate, hardened at runtime and notarized; the workflow
  verifies the signature, stapled ticket and Gatekeeper assessment before
  publishing a stable release. Without them it publishes the verified DMG/ZIP
  as a prerelease tagged `-unsigned` with installation warnings, so unsigned
  output is never presented as a signed release. The published 2.0.0 artifacts
  predate this gate and should be replaced by a signed rerun.

## Operational checklist

- [ ] Run as a dedicated non-admin OS user; do not run the daemon as root.
- [ ] Back up `jarvis.db`, `master.key` and `secrets.enc` together, encrypted.
- [ ] Keep `.env` and `~/.jarvis` at mode `0700`/`0600`.
- [ ] Use `strict` or `balanced` mode for the first week; review `jarvis audit`.
- [ ] Grant OAuth scopes you actually use (Gmail modify is powerful).
- [ ] Use a dedicated Supabase project and keep the service-role key server-side.
- [ ] Do not expose port 8765 directly to the internet; use a VPN/TLS proxy.
- [ ] Pin/audit MCP servers before adding them; they are arbitrary code.
- [ ] Rotate provider, Google, GitHub, Telegram and Supabase credentials if a
      device is lost.
- [ ] Verify the audit chain after upgrades: `jarvis audit --verify`.
- [ ] Verify the companion download with
      `spctl --assess --type execute -vv /Applications/JARVIS.app`; it should
      report `Notarized Developer ID`.

## Known gaps

- No OS sandbox/container isolation for shell commands; approvals are the gate.
- The audit hash chain is not anchored externally.
- No OS keychain integration yet; the master key is a protected file or env var.
- Single-user only: anyone who can read the data directory can read the
  assistant's memory (unless the volume is encrypted at rest).
- Live integrations and OAuth flows are not covered by the offline tests.

If you find a security issue in this project, report it privately to the
repository owner rather than opening a public issue with exploit details.
