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
- **Notes** — a searchable second brain with tags, pinning, archiving and a
  full note editor. Capture the clipboard to notes from the tray too.
- **Agenda** — a seven-day Google Calendar view with all-day/timed events and a
  native event creator; when Google is not connected the panel explains how.
- **Voice capture** — dictate into the composer or record a memo that becomes a
  transcribed, optionally AI-structured note. Audio is stored by the daemon.
- **Memory-aware status** — model, online state, memory count, note count, tool count.
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

Download the latest `JARVIS-Companion-*.dmg` from the repository's Releases
page, open it, and drag JARVIS to Applications.

Release 2.1.0 is built by the workflow on GitHub macOS runners. When all five
credentials below are configured, it signs with a Developer ID Application
certificate, notarizes with Apple and publishes a stable release. When they are
missing, it still builds and verifies the DMG, but publishes it as an explicitly
labelled unsigned preview prerelease (`companion-v2.1.0-unsigned`) instead of
presenting it as a signed release. The 2.0.0 artifacts predate signing and
remain unsigned. Local builds are unsigned unless you configure the same
credentials.

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
streaming, tool, history and approval states. The Notes tab, note editor,
Agenda, event creator and simulated voice-note flow run entirely against the
preview bridge. The browser may deny microphone access for the real recorder;
that is expected outside the packaged Electron app.

## Build a DMG

```bash
npm install
npm run assets
npm run dist:mac
```

Artifacts land in `release/`: separate `x64` and `arm64` DMGs and ZIPs. Local
builds are unsigned by default; configure the credentials below to sign and
notarize them.

The GitHub workflow `.github/workflows/release-macos.yml` does this on a macOS
runner and publishes a release when `apps/companion/**` lands on `main` (or when
run manually). It uses the version in `package.json` as the tag
`companion-v<version>`, appending `-unsigned` when signing secrets are absent.
With credentials, notarization is mandatory and the workflow verifies the
signed app with `codesign`, `xcrun stapler` and `spctl` before publishing a
stable release.

### Signed release setup

Add these as **repository secrets** under Settings → Secrets and variables →
Actions. All five are required; the build stops with an annotation naming any
that are missing.

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64 of the **Developer ID Application** certificate and private key, exported as `.p12` |
| `CSC_KEY_PASSWORD` | Password used when exporting that `.p12` |
| `APPLE_ID` | Apple ID email for the developer team |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from [appleid.apple.com](https://appleid.apple.com) |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |

Create a **Developer ID Application** certificate in the Apple Developer
portal, install it in Keychain Access, then export the certificate and its
private key as a `.p12`. Base64-encode it without line breaks:

```bash
base64 -i DeveloperID.p12 | tr -d '\n' | pbcopy
```

Paste the result into `CSC_LINK`. Never commit the certificate, its password, or
the app-specific password. The workflow passes them to electron-builder only
for the build step; it uses the Apple notary service and does not upload the
credentials as artifacts. When the five secrets are present, CI also enables
`forceCodeSigning` and mandatory notarization, so a missing or invalid
certificate stops the build instead of producing a broken signed release.

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer.
- Only a narrow IPC bridge is exposed: settings, status, chat, approvals,
  history, notes, calendar, audio uploads/transcription, clipboard capture and
  hide/quit.
- Electron's permission handler allows `media` only for audio requested by the
  companion window; camera and screen capture stay denied. The packaged app
  declares `NSMicrophoneUsageDescription`. Recording stops when the user stops
  it or after five minutes.
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

- Signed/notarized releases require a paid Apple Developer account and the five
  repository secrets above. Without them the workflow publishes an unsigned
  preview prerelease (`companion-v<version>-unsigned`) instead.
- Uses the daemon's HTTP API; it cannot start `jarvis serve` for you.
- Voice transcription needs an audio-capable OpenAI-compatible endpoint
  configured on the daemon. The companion records audio, but the daemon owns
  transcription and note storage.
- Google Agenda needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `jarvis auth google` on the daemon.
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
