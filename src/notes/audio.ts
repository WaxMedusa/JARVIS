import type {JarvisConfig} from '../config.js';
import {JarvisError} from '../core/errors.js';
import {getLogger} from '../core/logger.js';
import type {LLMSet} from '../llm/index.js';
import {
  isSupportedAudioMime,
  normalizeAudioMime,
  normalizeTags,
  type NoteRecord,
  type NoteService,
} from '../memory/notes.js';

export interface AudioTranscriber {
  transcribeBuffer(buffer: Buffer, options?: {mime?: string; filename?: string}): Promise<string>;
}

export interface CreateAudioNoteInput {
  buffer: Buffer;
  mime?: string;
  filename?: string;
  title?: string;
  tags?: string[] | string;
  durationSeconds?: number | null;
  summarize?: boolean;
}

interface StructuredNote {
  title?: string;
  summary?: string;
  actions?: string[];
  tags?: string[];
}

/**
 * Turns a web/Electron recording into a durable note. The transcript is always
 * preserved; when a real model is available, a small model adds a title,
 * summary, action items and tags. Failure to summarize never loses the note.
 */
export class AudioNoteService {
  private readonly config: JarvisConfig;
  private readonly notes: NoteService;
  private readonly transcriber: AudioTranscriber;
  private readonly llm: LLMSet | null;
  private readonly logger = getLogger().child('audio-notes');

  constructor(options: {config: JarvisConfig; notes: NoteService; transcriber: AudioTranscriber; llm?: LLMSet | null}) {
    this.config = options.config;
    this.notes = options.notes;
    this.transcriber = options.transcriber;
    this.llm = options.llm ?? null;
  }

  async createFromAudio(input: CreateAudioNoteInput): Promise<{note: NoteRecord; transcript: string; structured: boolean}> {
    const buffer = input.buffer;
    if (!buffer.length) throw new JarvisError('VALIDATION', 'The recording is empty.');
    if (buffer.length > this.config.voice.maxAudioBytes) {
      throw new JarvisError('VALIDATION', `Recording exceeds the ${Math.round(this.config.voice.maxAudioBytes / (1024 * 1024))} MB limit.`);
    }
    const mime = normalizeAudioMime(input.mime);
    if (!isSupportedAudioMime(mime)) throw new JarvisError('VALIDATION', `Unsupported audio type: ${mime}`);

    const transcript = (await this.transcriber.transcribeBuffer(buffer, {
      mime,
      filename: input.filename || `voice-note.${mime.includes('mp4') ? 'm4a' : 'webm'}`,
    })).trim();
    if (!transcript) throw new JarvisError('UNAVAILABLE', 'The transcription was empty. Try recording again in a quieter place.');

    const shouldStructure = input.summarize !== false && this.config.voice.autoNoteSummary && this.llm && this.config.llm.provider !== 'mock';
    const structured = shouldStructure ? await this.structure(transcript) : null;
    const actions = (structured?.actions ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 12);
    const summary = structured?.summary?.trim() || null;
    const sections: string[] = [];
    if (summary) sections.push(summary);
    if (actions.length) sections.push(`Action items:\n${actions.map((item) => `- [ ] ${item}`).join('\n')}`);
    sections.push(`Transcript:\n${transcript}`);
    const content = sections.join('\n\n');
    const title = cleanTitle(input.title) || cleanTitle(structured?.title) || deriveTitle(transcript);
    const tags = normalizeTags([...normalizeTags(input.tags), ...normalizeTags(structured?.tags)]);

    let note = this.notes.create({
      title,
      content,
      summary,
      tags,
      source: 'audio',
    });
    note = await this.notes.saveAudio(note.id, buffer, mime);
    const duration = Number(input.durationSeconds);
    if (Number.isFinite(duration) && duration > 0) note = this.notes.setAudioDuration(note.id, duration) ?? note;
    this.logger.info('audio note created', {noteId: note.id, chars: transcript.length, structured: Boolean(structured), audioBytes: buffer.length});
    return {note, transcript, structured: Boolean(structured)};
  }

  private async structure(transcript: string): Promise<StructuredNote | null> {
    if (!this.llm) return null;
    try {
      const completion = await this.llm.small.complete({
        messages: [
          {
            role: 'system',
            content:
              'You organise voice memos into concise personal notes. Return one JSON object only, with keys title (string, max 80 chars), summary (string, 1-3 sentences), actions (array of short imperative strings, empty if none), and tags (array of 1-4 lowercase topical tags). Preserve names, dates, numbers and decisions exactly. Do not invent facts.',
          },
          {role: 'user', content: `Voice memo transcript:\n\n${transcript.slice(0, 24_000)}`},
        ],
        tools: [],
        temperature: 0.2,
        maxOutputTokens: 800,
        jsonMode: true,
      });
      return parseStructured(completion.text);
    } catch (error) {
      this.logger.warn('audio note structuring failed; preserving transcript', {error: (error as Error).message});
      return null;
    }
  }
}

function parseStructured(raw: string): StructuredNote | null {
  if (!raw.trim()) return null;
  let text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    return {
      title: typeof object.title === 'string' ? object.title : undefined,
      summary: typeof object.summary === 'string' ? object.summary : undefined,
      actions: Array.isArray(object.actions) ? object.actions.filter((item): item is string => typeof item === 'string') : undefined,
      tags: Array.isArray(object.tags) ? object.tags.filter((item): item is string => typeof item === 'string') : undefined,
    };
  } catch {
    return null;
  }
}

function cleanTitle(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function deriveTitle(transcript: string): string {
  const firstSentence = transcript.replace(/\s+/g, ' ').trim();
  if (!firstSentence) return 'Voice note';
  return firstSentence.length > 80 ? `${firstSentence.slice(0, 77).trimEnd()}…` : firstSentence;
}
