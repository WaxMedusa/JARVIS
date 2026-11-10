'use strict';

const {spawn} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const START_TIMEOUT_MS = 45_000;
const HEALTH_INTERVAL_MS = 400;

/** Pick a free loopback port for the private core process. */
function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a local port.'))));
    });
  });
}

/** The bundled daemon entry: extraResources in production, repo dist in development. */
function resolveBackendEntry({isPackaged, resourcesPath, appRoot}) {
  if (isPackaged) return path.join(resourcesPath, 'backend', 'index.cjs');
  return path.join(appRoot, 'dist', 'cli', 'index.js');
}

/** Environment for the private JARVIS core. Never persisted to disk. */
function buildBackendEnv({settings, apiKey, canvasToken, home, port, token, baseEnv = process.env}) {
  const requested = String(settings.provider || 'openai');
  const provider = ['openai', 'anthropic', 'ollama', 'mock'].includes(requested) ? requested : 'custom';
  const providerBase =
    requested === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : requested === 'google'
        ? 'https://generativelanguage.googleapis.com/v1beta/openai'
        : '';
  const env = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    JARVIS_DESKTOP: '1',
    JARVIS_HOME: home,
    JARVIS_SERVER_HOST: '127.0.0.1',
    JARVIS_SERVER_PORT: String(port),
    JARVIS_API_TOKEN: token,
    JARVIS_LLM_PROVIDER: provider,
    JARVIS_MODEL: String(settings.model || '').trim(),
    JARVIS_SMALL_MODEL: String(settings.model || '').trim(),
    JARVIS_EMBEDDINGS: provider === 'openai' ? 'true' : 'false',
    JARVIS_PROACTIVE: 'false',
    JARVIS_LOG_LEVEL: 'info',
    CANVAS_BASE_URL: String(settings.canvasBaseUrl || '').trim(),
    CANVAS_API_TOKEN: String(canvasToken || '').trim(),
  };
  const baseUrl = String(settings.apiBaseUrl || providerBase || '').trim();
  if (baseUrl) {
    env.LLM_BASE_URL = baseUrl;
    if (provider === 'openai') env.OPENAI_BASE_URL = baseUrl;
  }
  const key = String(apiKey || '').trim();
  if (key) {
    if (provider === 'anthropic') env.ANTHROPIC_API_KEY = key;
    else if (provider === 'openai') env.OPENAI_API_KEY = key;
    else if (provider === 'ollama') env.OLLAMA_API_KEY = key;
    else env.LLM_API_KEY = key;
    if (requested === 'openrouter' || requested === 'google') env.LLM_API_KEY = key;
  }
  if (provider === 'ollama' && !env.LLM_BASE_URL) env.LLM_BASE_URL = 'http://127.0.0.1:11434/v1';
  return env;
}

function redact(line) {
  return String(line)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-…')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer …')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1…');
}

class BackendManager {
  constructor(options) {
    this.appRoot = options.appRoot;
    this.resourcesPath = options.resourcesPath;
    this.isPackaged = Boolean(options.isPackaged);
    this.userData = options.userData;
    this.getSettings = options.getSettings;
    this.getApiKey = options.getApiKey;
    this.getCanvasToken = options.getCanvasToken;
    this.getExternalToken = options.getExternalToken;
    this.onState = options.onState || (() => {});
    this.child = null;
    this.port = 0;
    this.url = '';
    this.token = '';
    this.state = 'stopped';
    this.message = 'JARVIS core is stopped.';
    this.restarts = 0;
    this.restartTimer = null;
    this.intentionalStop = false;
    this.logLines = [];
    this.startedAt = null;
  }

  snapshot() {
    return {
      state: this.state,
      message: this.message,
      url: this.url ? 'local' : '',
      managed: !this.getSettings().useExternalDaemon,
      startedAt: this.startedAt,
    };
  }

  setState(state, message) {
    this.state = state;
    this.message = message;
    if (state === 'online') this.startedAt = new Date().toISOString();
    this.onState(this.snapshot());
  }

  clientOptions() {
    if (this.getSettings().useExternalDaemon) {
      return {baseUrl: this.getSettings().baseUrl || 'http://127.0.0.1:8765', token: this.getExternalToken()};
    }
    return {baseUrl: this.url || 'http://127.0.0.1:8765', token: this.token};
  }

  async start() {
    if (this.state === 'starting' || this.state === 'online') return this.snapshot();
    clearTimeout(this.restartTimer);
    this.restartTimer = null;

    if (this.getSettings().useExternalDaemon) {
      const settings = this.getSettings();
      this.url = settings.baseUrl;
      this.token = this.getExternalToken();
      this.setState('starting', 'Connecting to your JARVIS daemon…');
      const ok = await this.ping();
      this.setState(ok ? 'online' : 'offline', ok ? 'Connected to your JARVIS daemon.' : `No JARVIS daemon answered at ${settings.baseUrl}.`);
      return this.snapshot();
    }

    const entry = resolveBackendEntry(this);
    if (!fs.existsSync(entry)) {
      this.setState('offline', 'The JARVIS core is missing from this build. Reinstall JARVIS.');
      return this.snapshot();
    }

    try {
      this.port = await findFreePort();
    } catch (error) {
      this.setState('offline', `Could not allocate a local port: ${error.message}`);
      return this.snapshot();
    }
    const settings = this.getSettings();
    const token = crypto.randomBytes(24).toString('hex');
    const home = path.join(this.userData, 'jarvis');
    const env = buildBackendEnv({
      settings,
      apiKey: this.getApiKey(),
      canvasToken: this.getCanvasToken(),
      home,
      port: this.port,
      token,
    });
    this.url = `http://127.0.0.1:${this.port}`;
    this.token = token;
    this.intentionalStop = false;
    this.setState('starting', 'Starting JARVIS core…');
    this.logLines = [];

    let child;
    try {
      child = spawn(process.execPath, [entry, 'serve', '--host', '127.0.0.1', '--port', String(this.port)], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.setState('offline', `JARVIS core could not start: ${error.message}`);
      return this.snapshot();
    }
    this.child = child;

    const logFile = path.join(this.userData, 'logs', 'core.log');
    try {
      fs.mkdirSync(path.dirname(logFile), {recursive: true});
    } catch {
      // Logging is best-effort; the core still runs if the folder is unavailable.
    }
    const logStream = (() => {
      try {
        return fs.createWriteStream(logFile, {flags: 'a'});
      } catch {
        return null;
      }
    })();
    const record = (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        this.logLines.push(redact(line));
        if (this.logLines.length > 60) this.logLines.shift();
        try {
          logStream?.write(`${new Date().toISOString()} ${redact(line)}\n`);
        } catch {
          // ignore
        }
      }
    };
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);
    child.on('error', (error) => {
      this.child = null;
      this.setState('offline', `JARVIS core could not start: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      try {
        logStream?.end();
      } catch {
        // ignore
      }
      if (this.intentionalStop) return;
      const detail = this.logLines.slice(-4).join(' ').slice(0, 400);
      this.setState('offline', `JARVIS core stopped${code ? ` (code ${code})` : signal ? ` (${signal})` : ''}.${detail ? ` ${detail}` : ''}`);
      this.scheduleRestart();
    });

    const health = await this.waitForHealth(START_TIMEOUT_MS);
    if (!health.ok) {
      this.setState('offline', health.message);
      if (this.child) {
        this.intentionalStop = true;
        this.child.kill('SIGTERM');
      }
      return this.snapshot();
    }
    this.restarts = 0;
    this.setState('online', 'JARVIS core is online.');
    return this.snapshot();
  }

  async restart() {
    await this.stop();
    this.restarts = 0;
    return this.start();
  }

  async stop() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.intentionalStop = true;
    const child = this.child;
    this.child = null;
    this.url = '';
    this.token = '';
    if (!child) {
      this.setState('stopped', 'JARVIS core is stopped.');
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        finish();
      }, 3000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        finish();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
    this.setState('stopped', 'JARVIS core is stopped.');
  }

  async waitForHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.child) return {ok: false, message: 'JARVIS core exited before it became ready.'};
      if (await this.ping()) return {ok: true};
      await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
    }
    const detail = this.logLines.slice(-6).join(' ').slice(0, 500);
    return {
      ok: false,
      message: `JARVIS core did not become ready in time.${detail ? ` ${detail}` : ' Open Settings → Advanced to check the model configuration.'}`,
    };
  }

  async ping() {
    const base = this.getSettings().useExternalDaemon ? this.getSettings().baseUrl : this.url;
    if (!base) return false;
    try {
      const response = await fetch(`${base.replace(/\/+$/, '')}/health`, {signal: AbortSignal.timeout(1500)});
      return response.ok;
    } catch {
      return false;
    }
  }

  scheduleRestart() {
    if (this.restarts >= 3 || this.getSettings().useExternalDaemon) return;
    this.restarts += 1;
    this.setState('starting', `Restarting JARVIS core (${this.restarts}/3)…`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, 1200 * this.restarts);
    this.restartTimer.unref?.();
  }
}

module.exports = {
  BackendManager,
  buildBackendEnv,
  findFreePort,
  redact,
  resolveBackendEntry,
};
