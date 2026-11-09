import {z} from 'zod';
import type {LLMProvider} from '../llm/types.js';
import {extractJson} from '../core/json.js';

const FactSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.string().min(1).max(600),
  category: z
    .enum(['identity', 'location', 'work', 'health', 'relationships', 'preferences', 'goals', 'projects', 'finance', 'general'])
    .default('general'),
  confidence: z.number().min(0).max(1).default(0.8),
  sensitivity: z.enum(['public', 'private', 'secret']).default('private'),
});

const MemorySchema = z.object({
  content: z.string().min(3).max(2000),
  kind: z.enum(['note', 'fact', 'event', 'preference', 'insight', 'person', 'project']).default('note'),
  importance: z.number().min(0).max(1).default(0.5),
  sensitivity: z.enum(['public', 'private', 'secret']).default('private'),
});

const EntitySchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['person', 'org', 'place', 'project', 'tool', 'other']).default('person'),
  aliases: z.array(z.string()).default([]),
});

const RelationSchema = z.object({
  from: z.string().min(1),
  predicate: z.string().min(1).max(80),
  to: z.string().min(1).max(200),
});

const TaskSchema = z.object({
  title: z.string().min(1).max(300),
  due_at: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
});

export const ExtractionSchema = z.object({
  memories: z.array(MemorySchema).default([]),
  facts: z.array(FactSchema).default([]),
  entities: z.array(EntitySchema).default([]),
  relations: z.array(RelationSchema).default([]),
  tasks: z.array(TaskSchema).default([]),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export const EXTRACTION_INSTRUCTIONS = `You extract long-term memory from a conversation between a user and their personal assistant.

Return ONLY a JSON object with these keys:
{
  "memories": [{"content": "...", "kind": "note|fact|event|preference|insight|person|project", "importance": 0.0-1.0, "sensitivity": "public|private|secret"}],
  "facts": [{"key": "snake_case_slot", "value": "...", "category": "identity|location|work|health|relationships|preferences|goals|projects|finance|general", "confidence": 0.0-1.0, "sensitivity": "public|private|secret"}],
  "entities": [{"name": "...", "type": "person|org|place|project|tool|other", "aliases": []}],
  "relations": [{"from": "...", "predicate": "works_on|knows|lives_in|owns|uses", "to": "..."}],
  "tasks": [{"title": "...", "due_at": "ISO-8601 or null", "recurrence": "daily|weekdays|weekly|monthly|every:2:weeks|null"}]
}

Rules:
- Only include durable information worth remembering weeks later. Skip small talk, temporary states and anything the assistant said about itself.
- Facts are stable attributes about the USER (name, home city, job, relationships, preferences, goals, constraints, routines). Use stable snake_case keys such as home_city, job_title, dietary_preference, wake_time.
- Never store credentials, tokens, passwords, card numbers or government IDs. Mark genuinely sensitive personal details as "secret".
- A fact may be updated: extract the new value even if it contradicts something the user said earlier.
- Tasks are explicit commitments or reminders the user agreed to, not vague ideas.
- Be conservative: empty arrays are a valid answer. Never invent details.
- Respond with JSON only, no prose and no markdown fences.`;

export async function extractMemories(
  llm: LLMProvider,
  transcript: string,
  signal?: AbortSignal,
): Promise<Extraction | null> {
  const result = await llm.complete({
    messages: [
      {role: 'system', content: EXTRACTION_INSTRUCTIONS},
      {role: 'user', content: `Conversation transcript:\n\n${transcript.slice(0, 24_000)}`},
    ],
    tools: [],
    temperature: 0.1,
    maxOutputTokens: 1600,
    jsonMode: true,
    abortSignal: signal,
  });
  const parsed = extractJson(result.text);
  if (!parsed) return null;
  const validated = ExtractionSchema.safeParse(parsed);
  if (!validated.success) return null;
  return validated.data;
}

export const SUMMARY_INSTRUCTIONS = `Summarize this conversation segment for the assistant's future context.
Keep: decisions, commitments, open questions, user preferences, important facts, emotional tone, and anything unresolved.
Drop: small talk, repeated information, and tool mechanics.
Write compact prose or bullets under 220 words. Do not address the user. Do not invent anything.`;
