import {describe, expect, it} from 'vitest';
import {CanvasClient, normalizeCanvasBaseUrl} from '../src/integrations/canvas.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

function clientWith(handler: (url: string) => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer canvas-token');
    return handler(url);
  }) as typeof fetch;
  return {
    calls,
    client: new CanvasClient({baseUrl: 'https://school.instructure.com', token: 'canvas-token', fetchImpl}),
  };
}

describe('Canvas', () => {
  it('normalizes school URLs and rejects insecure ones', () => {
    expect(normalizeCanvasBaseUrl('school.instructure.com')).toBe('https://school.instructure.com');
    expect(normalizeCanvasBaseUrl('https://school.instructure.com/api/v1/')).toBe('https://school.instructure.com');
    expect(normalizeCanvasBaseUrl('https://school.instructure.com/')).toBe('https://school.instructure.com');
    expect(() => normalizeCanvasBaseUrl('http://school.instructure.com')).toThrow(/https/);
    expect(() => normalizeCanvasBaseUrl('')).toThrow(/required/);
  });

  it('maps courses, assignments and the todo list', async () => {
    const {client, calls} = clientWith((url) => {
      if (url.includes('/api/v1/courses?')) {
        return json([
          {id: 1, name: 'Calculus II', course_code: 'MATH 201', term: {name: 'Fall 2026'}, html_url: 'https://school.instructure.com/courses/1'},
        ]);
      }
      if (url.includes('/api/v1/courses/1/assignments')) {
        return json([
          {
            id: 41,
            name: 'Problem set 4',
            due_at: '2026-11-12T23:59:00Z',
            points_possible: 20,
            html_url: 'https://school.instructure.com/courses/1/assignments/41',
            submission: {submitted_at: null, workflow_state: 'unsubmitted'},
          },
        ]);
      }
      if (url.includes('/api/v1/users/self/todo')) {
        return json([{type: 'grading', course_id: 1, assignment: {id: 41, name: 'Problem set 4', due_at: '2026-11-12T23:59:00Z'}, html_url: 'https://school.instructure.com/todo'}]);
      }
      if (url.includes('/api/v1/users/self/profile')) {
        return json({name: 'Ada Lovelace', primary_email: 'ada@school.edu'});
      }
      return json({error: 'unexpected'}, 404);
    });

    const profile = await client.status();
    expect(profile).toEqual({connected: true, name: 'Ada Lovelace', email: 'ada@school.edu'});

    const courses = await client.courses();
    expect(courses).toEqual([
      {id: '1', name: 'Calculus II', courseCode: 'MATH 201', term: 'Fall 2026', url: 'https://school.instructure.com/courses/1'},
    ]);

    const assignments = await client.assignments('1');
    expect(assignments[0]).toMatchObject({id: '41', courseName: 'Calculus II', name: 'Problem set 4', points: 20, submitted: false});
    expect(assignments[0]?.dueAt).toBe('2026-11-12T23:59:00Z');

    const todo = await client.todo();
    expect(todo[0]).toMatchObject({type: 'grading', title: 'Problem set 4', courseName: 'Calculus II'});

    // The course list is cached, so four requests were made for the endpoints above.
    expect(calls.filter((url) => url.includes('/courses?'))).toHaveLength(1);
  });

  it('merges upcoming work across courses and sorts by due date', async () => {
    const {client} = clientWith((url) => {
      if (url.includes('/api/v1/courses?')) {
        return json([
          {id: 1, name: 'Calculus II'},
          {id: 2, name: 'Design Studio'},
        ]);
      }
      if (url.includes('/api/v1/courses/1/assignments')) {
        return json([{id: 11, name: 'Late problem set', due_at: '2026-11-20T12:00:00Z'}]);
      }
      if (url.includes('/api/v1/courses/2/assignments')) {
        return json([{id: 21, name: 'Critique deck', due_at: '2026-11-11T09:00:00Z'}]);
      }
      return json({}, 404);
    });

    const upcoming = await client.upcoming();
    expect(upcoming.map((assignment) => assignment.name)).toEqual(['Critique deck', 'Late problem set']);
    expect(upcoming[0]?.courseName).toBe('Design Studio');
  });

  it('explains an expired Canvas token', async () => {
    const {client} = clientWith(() => json({errors: [{message: 'Invalid access token.'}]}, 401));
    await expect(client.courses()).rejects.toThrow(/Canvas rejected the API token/);
  });
});
