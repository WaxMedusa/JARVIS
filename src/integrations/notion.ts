import {fetchCapped} from '../core/http.js';
import {JarvisError} from '../core/errors.js';
import type {NotionService} from './types.js';

interface NotionConfig {
  token: string;
  version: string;
}

export class NotionClient implements NotionService {
  private readonly config: NotionConfig;

  constructor(config: NotionConfig) {
    this.config = config;
  }

  static create(config: NotionConfig): NotionClient | null {
    return config.token ? new NotionClient(config) : null;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchCapped(`https://api.notion.com/v1${path}`, {
      ...init,
      timeoutMs: 30_000,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        'notion-version': this.config.version,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      service: 'Notion',
    });
    try {
      return JSON.parse(response.text) as T;
    } catch (error) {
      throw new JarvisError('UNAVAILABLE', 'Notion returned invalid JSON', {cause: error});
    }
  }

  async search(query: string, limit = 8): Promise<Array<{id: string; title: string; url?: string; type: string}>> {
    const payload = await this.request<{
      results?: Array<{
        id: string;
        url?: string;
        object: string;
        title?: Array<{plain_text?: string}>;
        properties?: Record<string, {title?: Array<{plain_text?: string}>}>;
      }>;
    }>('/search', {
      method: 'POST',
      body: JSON.stringify({query, page_size: Math.min(limit, 20)}),
    });
    return (payload.results ?? []).slice(0, limit).map((item) => {
      const propertyTitle = item.properties ? Object.values(item.properties).find((property) => property.title)?.title : undefined;
      const title = item.title ?? propertyTitle ?? [];
      return {
        id: item.id,
        title: title.map((part) => part.plain_text ?? '').join('').trim() || 'Untitled',
        url: item.url,
        type: item.object,
      };
    });
  }

  async getPage(id: string): Promise<{id: string; title: string; text: string; url?: string}> {
    const page = await this.request<{id: string; url?: string; properties?: Record<string, {title?: Array<{plain_text?: string}>}>}>(`/pages/${id}`);
    const titleParts = page.properties ? Object.values(page.properties).find((property) => property.title)?.title : [];
    const title = (titleParts ?? []).map((part) => part.plain_text ?? '').join('').trim() || 'Untitled';
    const lines: string[] = [];
    await this.collectBlocks(id, lines, 0);
    return {id, title, url: page.url, text: lines.join('\n').slice(0, 120_000)};
  }

  private async collectBlocks(blockId: string, lines: string[], depth: number): Promise<void> {
    if (depth > 3 || lines.join('\n').length > 100_000) return;
    const payload = await this.request<{
      results?: Array<{
        id: string;
        type: string;
        has_children?: boolean;
        [key: string]: unknown;
      }>;
    }>(`/blocks/${blockId}/children?page_size=100`);
    for (const block of payload.results ?? []) {
      const data = block[block.type] as {rich_text?: Array<{plain_text?: string}>; language?: string} | undefined;
      const text = (data?.rich_text ?? []).map((part) => part.plain_text ?? '').join('');
      if (text) lines.push(block.type === 'heading_1' ? `# ${text}` : block.type === 'heading_2' ? `## ${text}` : block.type === 'heading_3' ? `### ${text}` : block.type === 'bulleted_list_item' ? `- ${text}` : text);
      if (block.has_children && depth < 2) await this.collectBlocks(block.id, lines, depth + 1).catch(() => undefined);
    }
  }

  async appendText(pageId: string, text: string): Promise<void> {
    const chunks = text.match(/[\s\S]{1,1800}/g) ?? [text];
    for (const chunk of chunks) {
      await this.request(`/blocks/${pageId}/children`, {
        method: 'PATCH',
        body: JSON.stringify({
          children: [{object: 'block', type: 'paragraph', paragraph: {rich_text: [{type: 'text', text: {content: chunk}}]}}],
        }),
      });
    }
  }

  async createPage(args: {parentId: string; title: string; content: string}): Promise<{id: string; url?: string}> {
    const children = args.content
      ? [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {rich_text: [{type: 'text', text: {content: args.content.slice(0, 1800)}}]},
          },
        ]
      : [];
    const build = (parentKey: 'page_id' | 'database_id') => ({
      parent: {[parentKey]: args.parentId},
      properties: {title: {title: [{type: 'text', text: {content: args.title}}]}},
      children,
    });

    let payload: {id: string; url?: string};
    try {
      payload = await this.request('/pages', {method: 'POST', body: JSON.stringify(build('page_id'))});
    } catch {
      payload = await this.request('/pages', {method: 'POST', body: JSON.stringify(build('database_id'))});
    }
    return {id: payload.id, url: payload.url};
  }
}
