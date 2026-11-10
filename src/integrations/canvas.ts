import {JarvisError} from '../core/errors.js';
import type {CanvasAssignment, CanvasCourse, CanvasService, CanvasTodo} from './types.js';

const REQUEST_TIMEOUT_MS = 20_000;
const COURSE_CACHE_MS = 5 * 60_000;

interface CanvasOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

interface CanvasCoursePayload {
  id: number | string;
  name?: string;
  course_code?: string;
  html_url?: string;
  term?: {name?: string};
  enrollments?: Array<{type?: string}>;
}

interface CanvasAssignmentPayload {
  id: number | string;
  name?: string;
  description?: string;
  due_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
  submission?: {workflow_state?: string; submitted_at?: string | null};
}

interface CanvasTodoPayload {
  type?: string;
  course_id?: number | string;
  html_url?: string;
  assignment?: {id?: number | string; name?: string; due_at?: string | null};
  quiz?: {id?: number | string; title?: string; due_at?: string | null};
}

/**
 * Normalize a school's Canvas URL. Accepts both the bare origin
 * (https://school.instructure.com) and a URL that already ends in /api/v1.
 */
export function normalizeCanvasBaseUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) throw new JarvisError('VALIDATION', 'Canvas URL is required.');
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new JarvisError('VALIDATION', 'Enter a valid Canvas URL, for example https://school.instructure.com.');
  }
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new JarvisError('VALIDATION', 'Canvas URLs must use https.');
  }
  if (url.username || url.password) throw new JarvisError('VALIDATION', 'Do not put credentials in the Canvas URL.');
  url.hash = '';
  url.search = '';
  let base = url.toString().replace(/\/+$/, '');
  if (base.toLowerCase().endsWith('/api/v1')) base = base.slice(0, -'/api/v1'.length);
  return base;
}

/** Read-only Canvas LMS client. No assignment submission, no writes. */
export class CanvasClient implements CanvasService {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private courseCache: {at: number; courses: CanvasCourse[]} | null = null;

  constructor(options: CanvasOptions) {
    this.baseUrl = normalizeCanvasBaseUrl(options.baseUrl);
    this.token = String(options.token || '').trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static create(options: CanvasOptions): CanvasClient | null {
    if (!options.baseUrl?.trim() || !options.token?.trim()) return null;
    return new CanvasClient(options);
  }

  async status(): Promise<{connected: boolean; name?: string; email?: string}> {
    try {
      const profile = await this.request<{name?: string; short_name?: string; primary_email?: string; login_id?: string}>(
        '/api/v1/users/self/profile',
        {},
        false,
      );
      return {
        connected: true,
        name: profile.name || profile.short_name,
        email: profile.primary_email || profile.login_id,
      };
    } catch (error) {
      return {connected: false, name: undefined, email: undefined, ...(typeof error === 'object' ? {} : {})};
    }
  }

  async courses(): Promise<CanvasCourse[]> {
    if (this.courseCache && Date.now() - this.courseCache.at < COURSE_CACHE_MS) return this.courseCache.courses;
    const payload = await this.request<CanvasCoursePayload[]>('/api/v1/courses', {
      enrollment_state: 'active',
      per_page: '100',
      'include[]': 'term',
    });
    const courses = (Array.isArray(payload) ? payload : [])
      .map((course) => ({
        id: String(course.id),
        name: course.name || course.course_code || `Course ${course.id}`,
        courseCode: course.course_code,
        term: course.term?.name,
        url: course.html_url,
      }))
      .filter((course) => Boolean(course.id));
    this.courseCache = {at: Date.now(), courses};
    return courses;
  }

  async assignments(courseId: string, bucket = 'upcoming'): Promise<CanvasAssignment[]> {
    const id = String(courseId || '').trim();
    if (!/^\d+$/.test(id)) throw new JarvisError('VALIDATION', 'A numeric Canvas course id is required.');
    const allowed = ['upcoming', 'future', 'past', 'undated'];
    const selected = allowed.includes(bucket) ? bucket : 'upcoming';
    const payload = await this.request<CanvasAssignmentPayload[]>(`/api/v1/courses/${id}/assignments`, {
      bucket: selected,
      per_page: '50',
      order_by: 'due_at',
    });
    const course = (await this.courses()).find((item) => item.id === id);
    return (Array.isArray(payload) ? payload : []).map((assignment) => this.mapAssignment(assignment, course));
  }

  async upcoming(limit = 25): Promise<CanvasAssignment[]> {
    const courses = await this.courses();
    const selected = courses.slice(0, 20);
    const results: CanvasAssignment[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < selected.length) {
        const course = selected[cursor++];
        if (!course) continue;
        try {
          const rows = await this.assignments(course.id, 'upcoming');
          results.push(...rows);
        } catch {
          // One unavailable course must not hide the rest of the degree.
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(5, selected.length)}, () => worker()));
    return results
      .sort((a, b) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999'))
      .slice(0, Math.min(Math.max(limit, 1), 100));
  }

  async todo(limit = 30): Promise<CanvasTodo[]> {
    const payload = await this.request<CanvasTodoPayload[]>('/api/v1/users/self/todo', {per_page: '50'});
    const courses = await this.courses().catch(() => []);
    const byId = new Map(courses.map((course) => [course.id, course.name]));
    const items = (Array.isArray(payload) ? payload : []).map((item) => {
      const assignment = item.assignment;
      const quiz = item.quiz;
      const courseId = item.course_id === undefined ? undefined : String(item.course_id);
      return {
        type: item.type || (assignment ? 'assignment' : quiz ? 'quiz' : 'todo'),
        title: assignment?.name || quiz?.title || 'Canvas item',
        courseId,
        courseName: courseId ? byId.get(courseId) : undefined,
        dueAt: assignment?.due_at ?? quiz?.due_at ?? undefined,
        url: item.html_url,
      };
    });
    return items.slice(0, Math.min(Math.max(limit, 1), 100));
  }

  private mapAssignment(assignment: CanvasAssignmentPayload, course?: CanvasCourse): CanvasAssignment {
    return {
      id: String(assignment.id),
      courseId: course?.id ?? '',
      courseName: course?.name ?? 'Canvas',
      name: assignment.name || 'Untitled assignment',
      dueAt: assignment.due_at ?? undefined,
      points: typeof assignment.points_possible === 'number' ? assignment.points_possible : undefined,
      url: assignment.html_url,
      submitted: Boolean(assignment.submission?.submitted_at || assignment.submission?.workflow_state === 'submitted'),
      type: 'assignment',
    };
  }

  private async request<T>(path: string, params: Record<string, string> = {}, retry = true): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'user-agent': 'JARVIS/1.0 (+personal assistant)',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new JarvisError('UNAVAILABLE', 'Canvas did not respond in time.');
      }
      throw new JarvisError('UNAVAILABLE', `Could not reach Canvas: ${(error as Error).message}`, {cause: error});
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new JarvisError('AUTH', 'Canvas rejected the API token. Generate a new token in Canvas → Account → Settings → New Access Token.');
    }
    if (!response.ok) {
      const detail = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
      throw new JarvisError('UNAVAILABLE', `Canvas returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    try {
      return (text.trim() ? JSON.parse(text) : {}) as T;
    } catch (error) {
      if (retry && /^\s*</.test(text)) {
        // Some Canvas deployments redirect to a login page with HTML; surface a clear message.
        throw new JarvisError('AUTH', 'Canvas returned a sign-in page instead of JSON. Check the school URL and token.');
      }
      throw new JarvisError('UNAVAILABLE', 'Canvas returned an unexpected response.', {cause: error});
    }
  }
}
