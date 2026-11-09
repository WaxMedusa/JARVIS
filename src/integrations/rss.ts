import {fetchCapped, stripHtml} from '../core/http.js';
import {getLogger} from '../core/logger.js';
import type {Policy} from '../security/policy.js';
import type {RssService} from './types.js';

export class RssClient implements RssService {
  private readonly feeds: string[];
  private readonly policy: Policy;

  constructor(feeds: string[], policy: Policy) {
    this.feeds = feeds;
    this.policy = policy;
  }

  async digest(args: {limit?: number; urls?: string[]} = {}): Promise<Array<{title: string; link: string; source: string; published?: string; summary?: string}>> {
    const urls = (args.urls?.length ? args.urls : this.feeds).slice(0, 12);
    const limit = args.limit ?? 12;
    const output: Array<{title: string; link: string; source: string; published?: string; summary?: string}> = [];
    await Promise.all(
      urls.map(async (url) => {
        const decision = this.policy.checkUrl(url);
        if (decision.action === 'deny') {
          getLogger().warn('blocked RSS feed', {url, reason: decision.reason});
          return;
        }
        try {
          const response = await fetchCapped(url, {
            timeoutMs: 20_000,
            maxBytes: 2 * 1024 * 1024,
            headers: {'user-agent': 'JARVIS/1.0 (+personal assistant)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml'},
            service: 'RSS',
          });
          const items = parseFeed(response.text, url);
          output.push(...items.slice(0, Math.max(3, Math.ceil(limit / urls.length))));
        } catch (error) {
          getLogger().debug('rss feed failed', {url, error: (error as Error).message});
        }
      }),
    );
    return output
      .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
      .slice(0, limit);
  }
}

export function parseFeed(xml: string, feedUrl: string): Array<{title: string; link: string; source: string; published?: string; summary?: string}> {
  let source = feedUrl;
  try {
    source = new URL(feedUrl).hostname.replace(/^www\./, '');
  } catch {
    // keep raw
  }
  const channelTitle = firstMatch(xml, /<channel[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i) ?? firstMatch(xml, /<feed[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  if (channelTitle) source = clean(channelTitle) || source;

  const blocks = [...xml.matchAll(/<(item|entry)[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => match[2] ?? '');
  return blocks
    .map((block) => {
      const title = clean(firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '');
      const link =
        clean(firstMatch(block, /<link[^>]*>([\s\S]*?)<\/link>/i) ?? '') ||
        firstMatch(block, /<link[^>]*href=["']([^"']+)["']/i) ||
        clean(firstMatch(block, /<guid[^>]*>([\s\S]*?)<\/guid>/i) ?? '');
      const published =
        clean(firstMatch(block, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ?? '') ||
        clean(firstMatch(block, /<updated[^>]*>([\s\S]*?)<\/updated>/i) ?? '') ||
        clean(firstMatch(block, /<published[^>]*>([\s\S]*?)<\/published>/i) ?? '');
      const summary = stripHtml(clean(firstMatch(block, /<description[^>]*>([\s\S]*?)<\/description>/i) ?? firstMatch(block, /<summary[^>]*>([\s\S]*?)<\/summary>/i) ?? '')).slice(0, 400);
      return {title, link, source, published: published ? new Date(published).toISOString() : undefined, summary};
    })
    .filter((item) => item.title && item.link);
}

function firstMatch(value: string, pattern: RegExp): string | null {
  return pattern.exec(value)?.[1] ?? null;
}

function clean(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
