import {execFile, execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {JarvisConfig} from '../config.js';
import {JarvisError, httpError} from '../core/errors.js';

/**
 * Voice is optional and degrades gracefully: recording needs arecord/sox/ffmpeg,
 * playback needs afplay/ffplay/mpv/aplay, and transcription/synthesis need an
 * OpenAI-compatible audio endpoint.
 */
export class VoiceService {
  private readonly config: JarvisConfig;

  constructor(config: JarvisConfig) {
    this.config = config;
  }

  get audioApi(): {baseUrl: string; apiKey: string} | null {
    const key = process.env.OPENAI_API_KEY?.trim() || process.env.LLM_API_KEY?.trim();
    if (!key) return null;
    const base = (process.env.OPENAI_BASE_URL?.trim() || this.config.llm.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    return {baseUrl: base, apiKey: key};
  }

  recordingCommand(): string[] | null {
    if (exists('arecord')) return ['arecord'];
    if (exists('sox')) return ['sox'];
    if (exists('ffmpeg')) return ['ffmpeg'];
    return null;
  }

  playbackCommand(): string[] | null {
    if (process.platform === 'darwin' && exists('afplay')) return ['afplay'];
    if (exists('ffplay')) return ['ffplay'];
    if (exists('mpv')) return ['mpv'];
    if (exists('aplay')) return ['aplay'];
    return null;
  }

  async record(seconds = this.config.voice.recordSeconds): Promise<string> {
    const target = path.join(this.config.paths.tmpDir, `voice-${Date.now()}.wav`);
    const tool = this.recordingCommand();
    if (!tool) {
      throw new JarvisError('UNAVAILABLE', 'No recorder found. Install alsa-utils (arecord), sox or ffmpeg to use voice input.');
    }
    const [command] = tool;
    let args: string[];
    if (command === 'arecord') args = ['-q', '-f', 'cd', '-t', 'wav', '-d', String(seconds), target];
    else if (command === 'sox') args = ['-d', '-q', target, 'trim', '0', String(seconds)];
    else
      args =
        process.platform === 'darwin'
          ? ['-y', '-f', 'avfoundation', '-i', ':0', '-t', String(seconds), target]
          : ['-y', '-f', 'pulse', '-i', 'default', '-t', String(seconds), target];
    process.stdout.write(`Recording for ${seconds}s...\n`);
    await run(command, args, seconds * 1000 + 10_000);
    return target;
  }

  async transcribe(file: string): Promise<string> {
    const buffer = await fs.readFile(file);
    return this.transcribeBuffer(buffer, {filename: path.basename(file), mime: mimeForFile(file)});
  }

  /** Transcribe audio that arrived from the companion, web UI or an API client. */
  async transcribeBuffer(buffer: Buffer, options: {mime?: string; filename?: string} = {}): Promise<string> {
    const api = this.audioApi;
    if (!api) throw new JarvisError('CONFIG', 'Voice transcription needs OPENAI_API_KEY (or an OpenAI-compatible LLM_API_KEY).');
    if (!buffer.length) throw new JarvisError('VALIDATION', 'The audio recording is empty.');
    if (buffer.length > this.config.voice.maxAudioBytes) {
      throw new JarvisError('VALIDATION', `The audio recording exceeds the ${Math.round(this.config.voice.maxAudioBytes / (1024 * 1024))} MB limit.`);
    }
    const mime = normalizeMime(options.mime);
    const filename = options.filename || `voice-${Date.now()}.${mime.includes('mp4') ? 'm4a' : 'webm'}`;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], {type: mime}), filename);
    form.append('model', this.config.voice.sttModel);
    form.append('response_format', 'json');
    if (this.config.voice.language.trim()) form.append('language', this.config.voice.language.trim());
    const response = await fetch(`${api.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {authorization: `Bearer ${api.apiKey}`},
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw httpError('Transcription', response.status, await response.text().catch(() => ''));
    const payload = (await response.json()) as {text?: string};
    return payload.text?.trim() ?? '';
  }

  async speak(text: string): Promise<string | null> {
    const api = this.audioApi;
    if (!api) throw new JarvisError('CONFIG', 'Voice output needs OPENAI_API_KEY (or an OpenAI-compatible LLM_API_KEY).');
    const response = await fetch(`${api.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {authorization: `Bearer ${api.apiKey}`, 'content-type': 'application/json'},
      body: JSON.stringify({model: this.config.voice.ttsModel, voice: this.config.voice.ttsVoice, input: text.slice(0, 4000), response_format: 'mp3'}),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw httpError('Speech synthesis', response.status, await response.text().catch(() => ''));
    const buffer = Buffer.from(await response.arrayBuffer());
    const file = path.join(this.config.paths.tmpDir, `speech-${Date.now()}.mp3`);
    await fs.writeFile(file, buffer);
    await this.play(file);
    return file;
  }

  async play(file: string): Promise<void> {
    const tool = this.playbackCommand();
    if (!tool) {
      process.stdout.write(`Audio saved to ${file} (no player found).\n`);
      return;
    }
    const [command] = tool;
    const args = command === 'ffplay' ? ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] : command === 'mpv' ? ['--no-video', '--really-quiet', file] : [file];
    await run(command, args, 300_000);
  }
}

function normalizeMime(raw: string | undefined): string {
  const value = String(raw || 'audio/webm').split(';')[0]!.trim().toLowerCase();
  return value.startsWith('audio/') || value === 'video/webm' ? value : 'audio/webm';
}

function mimeForFile(file: string): string {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.m4a' || extension === '.mp4') return 'audio/mp4';
  if (extension === '.ogg' || extension === '.opus') return 'audio/ogg';
  if (extension === '.flac') return 'audio/flac';
  return 'audio/webm';
}

function exists(command: string): boolean {
  try {
    execFileSync('which', [command], {stdio: 'ignore', timeout: 2000});
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {timeout, maxBuffer: 1024 * 1024}, (error) => {
      if (error) reject(new JarvisError('UNAVAILABLE', `${command} failed: ${error.message}`, {cause: error}));
      else resolve();
    });
  });
}
