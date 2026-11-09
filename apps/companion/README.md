# JARVIS Companion

An always-there macOS companion for JARVIS. It lives in the menu bar and as a
frameless, translucent panel in the corner of your screen — summoned with
`⌘⇧J`, a tray click, or the menu bar.

It is a thin, secure client for the JARVIS daemon: memory, conversations, tools,
approvals and streaming all come from the local backend. The renderer never
holds an API token and never talks to the network directly.

## What it does

- **Always available** — menu-bar app with a floating panel, `always-on-top`,
  all-spaces visibility, draggable/resizable layout, and remembered position.
- **Streaming conversations** — token-by-token replies, live tool activity,
  stop/reconnect, and conversation history from the daemon.
- **Approval cards** — when a tool needs consent, the action appears in the
  panel with Approve/Deny; the backend policy still enforces the final decision.
- **Quick capture** — save the current clipboard to long-term memory from the
  tray or the header, with a native notification.
- **Memory-aware status** — model, online state, memory count, tool count.
- **No browser chrome** — borderless glass panel, custom typography and arc
  reactor motion; dock icon hidden (`LSUIElement`).
- **Encrypted credentials** — remote daemon API tokens use Electron
  `safeStorage` (macOS Keychain-backed) and never enter the renderer.

## Requirements

- macOS 11 or newer (Apple silicon or Intel)
- Node.js 22+ for local development
- A running JARVIS daemon:
  ```bash
  jarvis serve
  ```
  By default it listens on `http://127.0.0.1:8765`. If you bind it to a
  non-loopback address, set `JARVIS_API_TOKEN` and paste that token into the
  companion settings.

## Run it

Download the latest `JARVIS-Companion-2.0.0-*.dmg` from the repository's
Releases page, open it, and drag JARVIS to Applications.

The build is **unsigned and not notarized** (there is no Apple Developer signing
certificate in CI). On first launch, macOS Gatekeeper may block it:

- Right-click the app → **Open** → **Open**, or
- `xattr -dr com.apple.quarantine /Applications/JARVIS.app`

This is a normal limitation of an unsigned open-source build, not a sign that
the app is damaged. Build it yourself if you prefer.

## Local development

```bash
cd apps/companion
npm install
npm run assets
npm start          # launches the real Electron panel
```

The panel talks to the daemon in the main process. Use `npm run dev` to open
DevTools.

### Design preview without Electron

The renderer ships with a mock bridge so the complete UI can be opened in a
normal browser:

```bash
python3 -m http.server 4400 --bind 0.0.0.0 --directory src/renderer
# open http://localhost:4400
```

The badge in the corner confirms preview mode. Typing “brief me”, “what do you
know about me”, “remember…”, or anything containing “email” exercises the
streaming, tool, history and approval states.

## Build a DMG

```bash
npm install
npm run assets
npm run dist:mac
```

Artifacts land in `release/`: separate `x64` and `arm64` DMGs and ZIPs. The
build is unsigned; macOS will warn on first open.

The GitHub workflow `.github/workflows/release-macos.yml` does this on a macOS
runner and publishes a release when `apps/companion/**` lands on `main` (or when
run manually). It uses the version in `package.json` as the tag
`companion-v<version>`.

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer.
- Only a narrow IPC bridge is exposed: settings, status, chat, approvals,
  history, clipboard capture, hide/quit.
- All daemon requests happen in the main process; the API token is encrypted at
  rest with `safeStorage` and is never returned to the renderer.
- CSP disables remote scripts, remote connections, objects and form actions.
- Navigation and `window.open` are denied; only explicit HTTPS links open in the
  default browser.
- Clipboard capture is user-triggered and truncated to 8,000 characters before
  it is sent to the daemon.
- The companion never bypasses JARVIS policy. Every tool still goes through the
  backend's approval, path, shell and network controls.

## Known limitations

- Unsigned/notarized builds require a paid Apple Developer account; the release
  workflow is ready for signing secrets when you have them.
- Uses the daemon's HTTP API; it cannot start `jarvis serve` for you.
- No microphone capture yet. Voice remains available through the CLI/daemon.
- The global shortcut depends on macOS accepting the Electron accelerator.
  Settings reports when a shortcut is rejected.
- A second instance focuses the existing panel rather than opening another.

## Layout

```
src/main/main.js            panel, tray, hotkey, IPC, lifecycle
src/main/jarvis-client.js   HTTP/SSE daemon client
src/main/sse.js             dependency-free SSE parser
src/main/settings.js        validation + defaults
src/main/preload.js         context-isolated bridge
src/renderer/               HTML, CSS, renderer state machine, preview mock
scripts/generate-assets.mjs icon + template tray icons
test/                       node:test coverage for SSE, client, settings
```
