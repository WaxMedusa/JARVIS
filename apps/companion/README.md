# JARVIS for macOS

JARVIS is now one desktop app. The core, memory, tools, browser, Canvas client
and calendar engine ship inside `JARVIS.app`; there is no separate daemon and no
terminal step. Download the DMG, drag JARVIS into Applications, open it, choose a
model, and paste your own API key.

<p align="center"><strong>One app · your model · your Mac</strong></p>

## First launch

1. Open **JARVIS** from Applications.
2. Pick a provider: OpenAI, Anthropic, OpenRouter, Google Gemini, a local Ollama,
   or any OpenAI-compatible endpoint.
3. Paste the API key. JARVIS tests the model, starts its private core, and keeps
   the key in the macOS Keychain.
4. Ask for a briefing, open the browser, or connect your calendar and Canvas.

No configuration file, shell command, Node install or separate daemon is needed.
The core starts automatically with the app and restarts if it stops. All data,
memory and credentials stay on this Mac under
`~/Library/Application Support/JARVIS/jarvis`.

## What is inside

- **A real chat workspace** — streaming replies, Markdown, code blocks with copy,
  tool activity, conversation history and approval cards, sized like a desktop
  assistant rather than a menu-bar popover.
- **A browser JARVIS can see** — a Chromium tab inside the app with its own
  private session. JARVIS reads the page you are on when you send a message, so
  “summarise this” and “what should I do here?” work on real pages. Page content
  is treated as untrusted context, never as instructions.
- **Memory and notes** — persistent memory, searchable notes, pinning, archiving,
  clipboard capture, and voice memos that are transcribed and structured.
- **Agenda** — Google Calendar, iCloud, Outlook or any private iCal feed. Add
  the secret address in Agenda → Connected calendars; no developer OAuth app is
  required. Google OAuth remains supported for creating events.
- **Canvas LMS** — paste your school URL and a personal Canvas API token. See
  active courses, upcoming assignments, points, submission state and your Canvas
  to-do list. Read-only: JARVIS cannot submit work or change your account.
- **Voice** — dictate a message or record a voice note. The core stores audio and
  transcription locally, using your OpenAI-compatible audio endpoint.
- **A menu-bar home** — closing the window keeps JARVIS running. Summon it with
  `⌘⇧J`, the tray icon, or the Dock.

## Models

| Provider | Notes |
| --- | --- |
| OpenAI | GPT-5.x, GPT-4.1, o-series. |
| Anthropic | Claude Sonnet, Opus, Haiku. |
| OpenRouter | One key for many models; uses the OpenAI-compatible API. |
| Google Gemini | Gemini 2.5 Pro/Flash through Google's OpenAI-compatible endpoint. |
| Ollama | Local models; no key. Start Ollama before choosing a local model. |
| Custom | Any OpenAI-compatible base URL and key. |

Change the model any time from the model chip in the sidebar or Settings →
Change model. A new model is tested before the core restarts with it.

## Security model

- The renderer is sandboxed with `contextIsolation: true`, `nodeIntegration:
  false`, and a narrow IPC bridge. It never sees the model key or daemon token.
- Keys are encrypted with Electron `safeStorage` (macOS Keychain). They are
  passed to the child core through its environment, never written into config.
- The core binds to a random loopback port with a fresh per-run bearer token.
- The embedded browser has a separate persistent session, denies camera, mic,
  geolocation and notification permissions, and blocks non-http(s) navigation.
  Only the active page's visible text can be shared, and only when you send it.
- Page text is wrapped in an explicit untrusted-context block. The daemon still
  enforces its own approval, path, shell and network policy.
- CSP disables remote scripts and renderer network access. External links open in
  your default browser.
- Canvas is read-only. Google OAuth remains optional; private iCal feeds are the
  recommended no-terminal path.

## Build from source

Requires macOS, Node 24 and npm.

```bash
# repository root
npm ci
npm run build

cd apps/companion
npm ci
npm run assets
npm run prepare:backend   # bundles the core into extraResources/backend/index.cjs
npm run dist:mac          # x64 + arm64 DMG/ZIP in release/
```

`npm run prepare:backend` uses esbuild to bundle the TypeScript core into one
CommonJS file. Electron's bundled Node (24) runs it with
`ELECTRON_RUN_AS_NODE=1`; `node:sqlite` is built in, so there is no native
rebuild. The staged core is excluded from git and included through
electron-builder `extraResources`.

For local UI work without Electron:

```bash
python3 -m http.server 4400 --bind 0.0.0.0 --directory src/renderer
# open http://localhost:4400
```

The preview bridge simulates chat, notes, agenda, Canvas, onboarding and the
browser. In the packaged app the real `preload.js` bridge replaces it.

## Releases

`.github/workflows/release-macos.yml` runs on macOS 26 Intel and Apple silicon.
It installs and builds the core, runs both test suites, bundles the core, builds
the app, then verifies:

- `JARVIS.app`, `app.asar`, the embedded `backend/index.cjs` and Info.plist;
- that the core starts and answers `/health` with no terminal;
- the DMG (`hdiutil verify`) and ZIP (`unzip -tq`).

With all five Apple secrets configured, it signs, notarizes, staples and
publishes a stable `companion-v<version>` release. Without them it still builds
and verifies everything, then publishes an unsigned preview
`companion-v<version>-unsigned`. macOS may block unsigned builds; right-click →
Open, or:

```bash
xattr -dr com.apple.quarantine /Applications/JARVIS.app
```

Only do that for source you trust.

### Signed release secrets

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64 of the **Developer ID Application** `.p12` |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |

## Known limitations

- Signed/notarized releases require a paid Apple Developer account and the five
  secrets above. Otherwise the downloadable build is explicitly unsigned.
- A local Ollama model needs Ollama running on the same Mac; JARVIS does not
  bundle model weights.
- Google Calendar creation still requires Google OAuth. Reading Apple/Google/
  Outlook calendars through private iCal feeds works without it.
- Canvas tokens are read-only in JARVIS by design; assignment submission is not
  implemented.
- The app targets macOS 11+, Intel and Apple silicon. Windows/Linux are not
  packaged.

## Layout

```
src/main/main.js             window, tray, hotkey, IPC, embedded browser
src/main/backend.js          managed core process, ports and health
src/main/models.js           provider validation and live model test
src/main/settings.js         encrypted settings schema and validation
src/main/jarvis-client.js    HTTP/SSE client for the core
src/main/preload.js          context-isolated bridge
src/renderer/index.html      desktop shell
src/renderer/app.js          chat, notes, agenda and voice
src/renderer/workspace.js    onboarding, sidebar, Canvas, feeds, browser
src/renderer/markdown.js     safe Markdown renderer
src/renderer/styles-v3.css   desktop layout
scripts/prepare-backend.mjs  bundles the core into extraResources
test/                        node:test coverage
```
