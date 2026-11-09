import {fetchCapped} from '../core/http.js';
import {JarvisError} from '../core/errors.js';
import type {GitHubService} from './types.js';

interface GitHubConfig {
  token: string;
  apiBase: string;
}

export class GitHubClient implements GitHubService {
  private readonly config: GitHubConfig;

  constructor(config: GitHubConfig) {
    this.config = config;
  }

  static create(config: GitHubConfig): GitHubClient | null {
    return config.token ? new GitHubClient(config) : null;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = this.config.apiBase.replace(/\/+$/, '');
    const response = await fetchCapped(`${base}${path}`, {
      ...init,
      timeoutMs: 30_000,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      service: 'GitHub',
    });
    if (!response.text.trim()) return {} as T;
    try {
      return JSON.parse(response.text) as T;
    } catch (error) {
      throw new JarvisError('UNAVAILABLE', 'GitHub returned invalid JSON', {cause: error});
    }
  }

  async viewer(): Promise<{login: string; name?: string; repos?: number}> {
    const user = await this.request<{login: string; name?: string; public_repos?: number; total_private_repos?: number}>('/user');
    return {login: user.login, name: user.name, repos: (user.public_repos ?? 0) + (user.total_private_repos ?? 0)};
  }

  async notifications(limit = 10): Promise<Array<{id: string; title: string; repo: string; reason: string; unread: boolean; url?: string}>> {
    const items = await this.request<
      Array<{id: string; unread: boolean; reason: string; subject: {title: string; url?: string}; repository: {full_name: string}}>
    >(`/notifications?all=false&per_page=${Math.min(limit, 50)}`);
    return items.slice(0, limit).map((item) => ({
      id: item.id,
      title: item.subject.title,
      repo: item.repository.full_name,
      reason: item.reason,
      unread: item.unread,
      url: item.subject.url ? item.subject.url.replace('https://api.github.com/repos/', 'https://github.com/') : undefined,
    }));
  }

  async listIssues(args: {repo: string; state?: string; limit?: number}): Promise<Array<{number: number; title: string; state: string; url: string; author?: string}>> {
    const state = args.state ?? 'open';
    const items = await this.request<
      Array<{number: number; title: string; state: string; html_url: string; user?: {login: string}; pull_request?: unknown}>
    >(`/repos/${encodeRepo(args.repo)}/issues?state=${state}&per_page=${Math.min(args.limit ?? 15, 50)}&sort=updated`);
    return items
      .filter((item) => !item.pull_request)
      .map((item) => ({number: item.number, title: item.title, state: item.state, url: item.html_url, author: item.user?.login}));
  }

  async createIssue(args: {repo: string; title: string; body: string; labels?: string[]}): Promise<{number: number; url: string}> {
    const item = await this.request<{number: number; html_url: string}>(`/repos/${encodeRepo(args.repo)}/issues`, {
      method: 'POST',
      body: JSON.stringify({title: args.title, body: args.body, labels: args.labels ?? []}),
    });
    return {number: item.number, url: item.html_url};
  }

  async comment(args: {repo: string; number: number; body: string}): Promise<{url: string}> {
    const item = await this.request<{html_url: string}>(`/repos/${encodeRepo(args.repo)}/issues/${args.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({body: args.body}),
    });
    return {url: item.html_url};
  }

  async listPullRequests(args: {repo: string; state?: string; limit?: number}): Promise<Array<{number: number; title: string; state: string; url: string; author?: string; draft?: boolean}>> {
    const items = await this.request<
      Array<{number: number; title: string; state: string; html_url: string; user?: {login: string}; draft?: boolean}>
    >(`/repos/${encodeRepo(args.repo)}/pulls?state=${args.state ?? 'open'}&per_page=${Math.min(args.limit ?? 15, 50)}&sort=updated`);
    return items.map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      url: item.html_url,
      author: item.user?.login,
      draft: item.draft,
    }));
  }

  async search(args: {query: string; limit?: number}): Promise<Array<{title: string; url: string; type: string; state?: string}>> {
    const items = await this.request<{
      items?: Array<{title: string; html_url: string; pull_request?: unknown; state?: string}>;
    }>(`/search/issues?q=${encodeURIComponent(args.query)}&per_page=${Math.min(args.limit ?? 10, 30)}`);
    return (items.items ?? []).map((item) => ({
      title: item.title,
      url: item.html_url,
      type: item.pull_request ? 'pr' : 'issue',
      state: item.state,
    }));
  }
}

function encodeRepo(repo: string): string {
  const parts = repo.split('/').filter(Boolean);
  if (parts.length !== 2) throw new JarvisError('VALIDATION', `Repository must be "owner/name", got "${repo}"`);
  return `${parts[0]}/${parts[1]}`;
}
