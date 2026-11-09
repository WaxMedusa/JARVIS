import {fetchCapped} from '../core/http.js';
import {JarvisError} from '../core/errors.js';
import type {HomeAssistantService} from './types.js';

export class HomeAssistantClient implements HomeAssistantService {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: {baseUrl: string; token: string}) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  static create(config: {baseUrl: string; token: string}): HomeAssistantClient | null {
    return config.baseUrl && config.token ? new HomeAssistantClient(config) : null;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchCapped(`${this.baseUrl}${path}`, {
      ...init,
      timeoutMs: 20_000,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      service: 'Home Assistant',
    });
    if (!response.text.trim()) return {} as T;
    try {
      return JSON.parse(response.text) as T;
    } catch (error) {
      throw new JarvisError('UNAVAILABLE', 'Home Assistant returned invalid JSON', {cause: error});
    }
  }

  async states(filter?: string): Promise<Array<{entity_id: string; state: string; name?: string; unit?: string; last_changed?: string}>> {
    const states = await this.request<
      Array<{entity_id: string; state: string; attributes?: Record<string, unknown>; last_changed?: string}>
    >('/api/states');
    const needle = filter?.toLowerCase();
    return states
      .filter((state) => !needle || state.entity_id.toLowerCase().includes(needle) || String(state.attributes?.friendly_name ?? '').toLowerCase().includes(needle))
      .map((state) => ({
        entity_id: state.entity_id,
        state: state.state,
        name: typeof state.attributes?.friendly_name === 'string' ? state.attributes.friendly_name : undefined,
        unit: typeof state.attributes?.unit_of_measurement === 'string' ? state.attributes.unit_of_measurement : undefined,
        last_changed: state.last_changed,
      }));
  }

  async callService(args: {domain: string; service: string; entityId?: string; data?: Record<string, unknown>}): Promise<unknown> {
    const body: Record<string, unknown> = {...(args.data ?? {})};
    if (args.entityId) body.entity_id = args.entityId;
    return this.request(`/api/services/${encodeURIComponent(args.domain)}/${encodeURIComponent(args.service)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
