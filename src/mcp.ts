// MCP: JSON-RPC 2.0 over Streamable HTTP at /mcp, revision 2026-07-28
// (`server/discover`) with the 2025-11-25 `initialize` handshake as a
// fallback. Plain JSON answers — no SSE needed.
//
// The tools act on the same store as the REST and GraphQL surfaces, so a
// repository created through MCP is visible everywhere else and vice versa.

import type { Issue, PullRequest, Repo, Store } from './store.ts';

export interface McpResult {
  readonly status: number;
  readonly body: unknown;
}

type JsonRpcId = string | number | null;

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const PROTOCOL_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS: readonly Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The repository owner (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user\u2019s repositories.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools/list payload, cached so two calls are byte-identical. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
};

function jsonRpcResult(id: JsonRpcId, resultValue: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result: resultValue } };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function repoObject(store: Store, repo: Repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueObject(repo: Repo, issue: Issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
    user: { login: repo.owner },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function pullObject(repo: Repo, pull: PullRequest) {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** Wrap a tool result the way the suite reads it: text + structuredContent. */
function toolResult(value: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

type ToolOutcome = { ok: true; value: unknown } | { ok: false; code: number; message: string };

function findRepo(store: Store, args: Record<string, unknown>): Repo | { error: string } {
  const owner = asString(args.owner);
  const name = asString(args.repo);
  if (owner === '' || name === '') return { error: 'owner and repo are required' };
  if (owner !== store.viewer.login) return { error: 'Not Found' };
  const repo = store.getRepo(owner, name);
  return repo === undefined ? { error: 'Not Found' } : repo;
}

function isRepo(value: Repo | { error: string }): value is Repo {
  return (value as Repo).objects !== undefined;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { ok: false, code: -32601, message: `unknown tool ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, code: -32602, message: `missing required argument ${required}` };
    }
  }
  switch (name) {
    case 'create_repo': {
      const created = store.createRepo(asString(args.name), {
        description: asString(args.description),
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      if ('error' in created) return { ok: false, code: -32602, message: created.error };
      return { ok: true, value: repoObject(store, created) };
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      if (!isRepo(repo)) return { ok: false, code: -32602, message: repo.error };
      return { ok: true, value: repoObject(store, repo) };
    }
    case 'list_repos': {
      return { ok: true, value: store.viewerRepos().map((repo) => repoObject(store, repo)) };
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      if (!isRepo(repo)) return { ok: false, code: -32602, message: repo.error };
      const created = store.createIssue(repo, asString(args.title), asString(args.body), []);
      if ('error' in created) return { ok: false, code: -32602, message: created.error };
      return { ok: true, value: issueObject(repo, created) };
    }
    case 'get_issue': {
      const repo = findRepo(store, args);
      if (!isRepo(repo)) return { ok: false, code: -32602, message: repo.error };
      const number = asNumber(args.issue_number);
      const issue = number === null ? undefined : repo.issues.get(number);
      if (issue === undefined) return { ok: false, code: -32602, message: 'issue not found' };
      return { ok: true, value: issueObject(repo, issue) };
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (!isRepo(repo)) return { ok: false, code: -32602, message: repo.error };
      const state = asString(args.state, 'open');
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return { ok: true, value: issues.map((issue) => issueObject(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      if (!isRepo(repo)) return { ok: false, code: -32602, message: repo.error };
      const created = store.createPull(
        repo,
        asString(args.title),
        asString(args.body),
        asString(args.head),
        asString(args.base, 'main'),
      );
      if ('error' in created) return { ok: false, code: -32602, message: created.error };
      return { ok: true, value: pullObject(repo, created) };
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      if (!isRepo(repo)) return { ok: false, code: -32602, message: repo.error };
      const number = asNumber(args.pull_number);
      const pull = number === null ? undefined : repo.pulls.get(number);
      if (pull === undefined) return { ok: false, code: -32602, message: 'pull request not found' };
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return { ok: false, code: -32602, message: merged.error };
      return {
        ok: true,
        value: { merged: true, sha: merged.sha, message: 'Pull Request successfully merged', pull_request: pullObject(repo, pull) },
      };
    }
    default:
      return { ok: false, code: -32601, message: `unknown tool ${name}` };
  }
}

export function handleMcp(store: Store, body: unknown): McpResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: JsonRpcId = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};
  switch (method) {
    case 'server/discover': {
      return jsonRpcResult(id, {
        supportedVersions: [PROTOCOL_VERSION],
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = requested === PROTOCOL_VERSION
        ? PROTOCOL_VERSION
        : LEGACY_VERSIONS.includes(requested)
          ? requested
          : '2025-11-25';
      return jsonRpcResult(id, {
        protocolVersion: version,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    }
    case 'notifications/initialized':
      return { status: 202, body: null };
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
      const outcome = callTool(store, toolName, args);
      if (!outcome.ok) {
        if (outcome.code === -32601) return jsonRpcError(id, -32601, outcome.message);
        return jsonRpcResult(id, toolError(outcome.message));
      }
      return jsonRpcResult(id, toolResult(outcome.value));
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}
