/** Integration service contracts. Concrete clients live beside this file. */

export interface IntegrationStatus {
  name: string;
  label: string;
  configured: boolean;
  detail: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  attendees?: string[];
  description?: string;
  htmlLink?: string;
  all_day?: boolean;
  source?: string;
}

export interface CalendarFeedSummary {
  id: string;
  label: string;
  host: string;
  addedAt: string;
}

export interface CalendarFeedService {
  list(): CalendarFeedSummary[];
  add(args: {url: string; label?: string}): Promise<CalendarFeedSummary>;
  remove(id: string): boolean;
  events(args: {timeMin: string; timeMax: string}): Promise<{events: CalendarEvent[]; warnings: string[]}>;
}

export interface CanvasCourse {
  id: string;
  name: string;
  courseCode?: string;
  term?: string;
  url?: string;
}

export interface CanvasAssignment {
  id: string;
  courseId: string;
  courseName: string;
  name: string;
  dueAt?: string;
  points?: number;
  url?: string;
  submitted?: boolean;
  type: string;
}

export interface CanvasTodo {
  type: string;
  title: string;
  courseId?: string;
  courseName?: string;
  dueAt?: string;
  url?: string;
}

export interface CanvasService {
  status(): Promise<{connected: boolean; name?: string; email?: string}>;
  courses(): Promise<CanvasCourse[]>;
  assignments(courseId: string, bucket?: string): Promise<CanvasAssignment[]>;
  upcoming(limit?: number): Promise<CanvasAssignment[]>;
  todo(limit?: number): Promise<CanvasTodo[]>;
}

export interface GoogleService {
  isAuthorized(): boolean;
  authUrl(state?: string): {url: string; state: string};
  exchangeCode(code: string): Promise<void>;
  status(): Promise<{authorized: boolean; email?: string}>;
  listEvents(args: {timeMin: string; timeMax: string; maxResults?: number; calendarId?: string}): Promise<CalendarEvent[]>;
  createEvent(args: {
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    calendarId?: string;
  }): Promise<CalendarEvent>;
  freeBusy(args: {timeMin: string; timeMax: string}): Promise<Array<{start: string; end: string}>>;
  gmailSearch(args: {query: string; maxResults?: number}): Promise<
    Array<{id: string; threadId: string; from?: string; subject?: string; date?: string; snippet?: string; unread?: boolean}>
  >;
  gmailGet(id: string): Promise<{
    id: string;
    threadId: string;
    from?: string;
    to?: string;
    subject?: string;
    date?: string;
    body: string;
    labels?: string[];
  }>;
  gmailSend(args: {to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[]}): Promise<{id: string}>;
  gmailDraft(args: {to: string[]; subject: string; body: string; cc?: string[]}): Promise<{id: string}>;
  tasksList(): Promise<Array<{id: string; title: string; due?: string; notes?: string; status: string}>>;
  tasksCreate(args: {title: string; due?: string; notes?: string}): Promise<{id: string}>;
}

export interface NotionService {
  search(query: string, limit?: number): Promise<Array<{id: string; title: string; url?: string; type: string}>>;
  getPage(id: string): Promise<{id: string; title: string; text: string; url?: string}>;
  appendText(pageId: string, text: string): Promise<void>;
  createPage(args: {parentId: string; title: string; content: string}): Promise<{id: string; url?: string}>;
}

export interface GitHubService {
  viewer(): Promise<{login: string; name?: string; repos?: number}>;
  notifications(limit?: number): Promise<Array<{id: string; title: string; repo: string; reason: string; unread: boolean; url?: string}>>;
  listIssues(args: {repo: string; state?: string; limit?: number}): Promise<Array<{number: number; title: string; state: string; url: string; author?: string}>>;
  createIssue(args: {repo: string; title: string; body: string; labels?: string[]}): Promise<{number: number; url: string}>;
  comment(args: {repo: string; number: number; body: string}): Promise<{url: string}>;
  listPullRequests(args: {repo: string; state?: string; limit?: number}): Promise<Array<{number: number; title: string; state: string; url: string; author?: string; draft?: boolean}>>;
  search(args: {query: string; limit?: number}): Promise<Array<{title: string; url: string; type: string; state?: string}>>;
}

export interface HomeAssistantService {
  states(filter?: string): Promise<Array<{entity_id: string; state: string; name?: string; unit?: string; last_changed?: string}>>;
  callService(args: {domain: string; service: string; entityId?: string; data?: Record<string, unknown>}): Promise<unknown>;
}

export interface LinearService {
  myIssues(limit?: number): Promise<Array<{identifier: string; title: string; state: string; url?: string; priority?: number}>>;
  createIssue(args: {title: string; description?: string; teamId?: string; priority?: number}): Promise<{identifier: string; url?: string}>;
  searchIssues(query: string, limit?: number): Promise<Array<{identifier: string; title: string; state: string; url?: string}>>;
}

export interface EmailService {
  search(query: string, limit?: number): Promise<Array<{uid: number; from?: string; subject?: string; date?: string; seen?: boolean}>>;
  read(uid: number): Promise<{uid: number; from?: string; to?: string; subject?: string; date?: string; text: string}>;
  send(args: {to: string[]; subject: string; body: string; cc?: string[]}): Promise<void>;
  recent(limit?: number): Promise<Array<{uid: number; from?: string; subject?: string; date?: string; seen?: boolean}>>;
}

export interface SupabaseService {
  status(): Promise<{configured: boolean; reachable: boolean; detail: string}>;
  push(): Promise<{pushed: number; tables: string[]}>;
  pull(): Promise<{pulled: number}>;
}

export interface RssService {
  digest(args: {limit?: number; urls?: string[]}): Promise<Array<{title: string; link: string; source: string; published?: string; summary?: string}>>;
}

export interface IntegrationServices {
  google: GoogleService | null;
  notion: NotionService | null;
  github: GitHubService | null;
  homeAssistant: HomeAssistantService | null;
  linear: LinearService | null;
  canvas: CanvasService | null;
  email: EmailService | null;
  supabase: SupabaseService | null;
  rss: RssService | null;
  calendarFeeds: CalendarFeedService;
}

export interface IntegrationHub {
  readonly services: IntegrationServices;
  status(): IntegrationStatus[];
  has(name: keyof IntegrationServices): boolean;
}

export type IntegrationName = keyof IntegrationServices;
