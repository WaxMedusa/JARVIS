/** Tolerant JSON parsing for model output (fences, prose, trailing commas). */

export function extractJson(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
    const objectStart = candidate.indexOf('{');
    const objectEnd = candidate.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      const slice = candidate.slice(objectStart, objectEnd + 1);
      const fromObject = tryParse(slice);
      if (fromObject !== undefined) return fromObject;
    }
    const arrayStart = candidate.indexOf('[');
    const arrayEnd = candidate.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      const fromArray = tryParse(candidate.slice(arrayStart, arrayEnd + 1));
      if (fromArray !== undefined) return fromArray;
    }
  }
  return null;
}

function tryParse(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    try {
      // Remove trailing commas and stray control characters common in model output.
      const cleaned = value
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
      return JSON.parse(cleaned);
    } catch {
      return undefined;
    }
  }
}

/** Parse a loose boolean model answer ("yes", "approve", "1"). */
export function parseLooseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return ['true', 'yes', 'y', '1', 'approve', 'approved', 'ok', 'allow'].includes(normalized);
  }
  return false;
}
