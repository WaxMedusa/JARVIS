import {postJson} from '../core/http.js';
import {JarvisError} from '../core/errors.js';
import type {LinearService} from './types.js';

interface LinearIssueNode {
  identifier: string;
  title: string;
  url?: string;
  priority?: number;
  state?: {name?: string} | null;
}

export class LinearClient implements LinearService {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  static create(token: string): LinearClient | null {
    return token ? new LinearClient(token) : null;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const payload = await postJson<{data?: T; errors?: Array<{message: string}>}>(
      'https://api.linear.app/graphql',
      {query, variables},
      {headers: {authorization: this.token}, service: 'Linear', timeoutMs: 30_000},
    );
    if (payload.errors?.length) throw new JarvisError('UNAVAILABLE', `Linear error: ${payload.errors.map((error) => error.message).join('; ')}`);
    if (!payload.data) throw new JarvisError('UNAVAILABLE', 'Linear returned no data');
    return payload.data;
  }

  async myIssues(limit = 15): Promise<Array<{identifier: string; title: string; state: string; url?: string; priority?: number}>> {
    const data = await this.graphql<{viewer: {assignedIssues: {nodes: LinearIssueNode[]}}}>(
      `query($n: Int!) { viewer { assignedIssues(first: $n, filter: {state: {type: {neq: "completed"}}}) { nodes { identifier title url priority state { name } } } } }`,
      {n: Math.min(limit, 50)},
    );
    return data.viewer.assignedIssues.nodes.map((issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state?.name ?? 'unknown',
      url: issue.url,
      priority: issue.priority,
    }));
  }

  async searchIssues(query: string, limit = 10): Promise<Array<{identifier: string; title: string; state: string; url?: string}>> {
    const data = await this.graphql<{searchIssues: {nodes: LinearIssueNode[]}}>(
      `query($term: String!, $n: Int!) { searchIssues(term: $term, first: $n) { nodes { identifier title url state { name } } } }`,
      {term: query, n: Math.min(limit, 30)},
    );
    return data.searchIssues.nodes.map((issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state?.name ?? 'unknown',
      url: issue.url,
    }));
  }

  async createIssue(args: {title: string; description?: string; teamId?: string; priority?: number}): Promise<{identifier: string; url?: string}> {
    let teamId = args.teamId;
    if (!teamId) {
      const teams = await this.graphql<{teams: {nodes: Array<{id: string; key: string}>}}>(`query { teams(first: 1) { nodes { id key } } }`);
      teamId = teams.teams.nodes[0]?.id;
      if (!teamId) throw new JarvisError('UNAVAILABLE', 'No Linear team available for issue creation');
    }
    const data = await this.graphql<{issueCreate: {issue: {identifier: string; url?: string}}}>(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }`,
      {input: {title: args.title, description: args.description, teamId, ...(args.priority !== undefined ? {priority: args.priority} : {})}},
    );
    return {identifier: data.issueCreate.issue.identifier, url: data.issueCreate.issue.url};
  }
}
