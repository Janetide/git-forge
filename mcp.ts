// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
// Modern `server/discover` era plus the legacy `initialize` fallback. The tools
// act on the same Store as REST/GraphQL, so ids never drift between surfaces.

import { Store, VIEWER, globalId, isoTs, type Repo } from './store.ts';
import { issueJson, repoJson } from './rest.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface RpcError {
  code: number;
  message: string;
}

type RpcResult =
  | { ok: true; result: unknown }
  | { ok: false; error: RpcError };

function missingArg(name: string): RpcResult {
  return { ok: false, error: { code: -32602, message: `missing required argument: ${name}` } };
}

function notFound(what: string): RpcResult {
  return {
    ok: true,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ message: `${what} not found` }) }],
      structuredContent: { message: `${what} not found` },
      isError: true,
    },
  };
}

function toolResult(value: unknown): RpcResult {
  return {
    ok: true,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
    },
  };
}

/** Map the client's argument synonyms onto the canonical property names. */
function normalizeArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...raw };
  if (typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      args.owner ??= parts[0];
      args.repo ??= parts[1];
    }
  }
  if (typeof args.owner_login === 'string') args.owner ??= args.owner_login;
  if (typeof args.repository === 'string') args.repo ??= args.repository;
  if (typeof args.repo_name === 'string') args.repo ??= args.repo_name;
  if (typeof args.pull_request_number === 'number') args.pull_number ??= args.pull_request_number;
  if (typeof args.number === 'number') {
    args.issue_number ??= args.number;
    args.pull_number ??= args.number;
  }
  return args;
}

function requireFields(args: Record<string, unknown>, fields: string[]): RpcResult | null {
  for (const f of fields) {
    if (args[f] === undefined || args[f] === null || args[f] === '') return missingArg(f);
  }
  return null;
}

function callTool(store: Store, name: string, rawArgs: unknown): RpcResult {
  const args = normalizeArgs(rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {});

  if (name === 'create_repo') {
    const missing = requireFields(args, ['name']);
    if (missing) return missing;
    const repoName = String(args.name);
    const owner = typeof args.owner === 'string' && args.owner !== '' ? String(args.owner) : VIEWER.login;
    let repo = store.getRepo(owner, repoName);
    if (!repo) {
      repo = store.createRepo(owner, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
    }
    return toolResult({
      id: repo.id,
      node_id: globalId('R', `repo:${repo.id}`),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER.id },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `/${repo.owner}/${repo.name}`,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
    });
  }

  if (name === 'get_repo') {
    const missing = requireFields(args, ['owner', 'repo']);
    if (missing) return missing;
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (!repo) return notFound('Repository');
    return toolResult(JSON.parse(repoJson(repo)));
  }

  if (name === 'list_repos') {
    return toolResult(store.viewerRepos().map((r) => JSON.parse(repoJson(r))));
  }

  if (name === 'create_issue') {
    const missing = requireFields(args, ['owner', 'repo', 'title']);
    if (missing) return missing;
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (!repo) return notFound('Repository');
    const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return toolResult(JSON.parse(issueJson(issue, repo)));
  }

  if (name === 'get_issue') {
    const missing = requireFields(args, ['owner', 'repo', 'issue_number']);
    if (missing) return missing;
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (!repo) return notFound('Repository');
    const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
    if (!issue) return notFound('Issue');
    return toolResult(JSON.parse(issueJson(issue, repo)));
  }

  if (name === 'list_issues') {
    const missing = requireFields(args, ['owner', 'repo']);
    if (missing) return missing;
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (!repo) return notFound('Repository');
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((i) => state === 'all' || i.state === state);
    return toolResult(list.map((i) => JSON.parse(issueJson(i, repo))));
  }

  if (name === 'create_pull_request') {
    const missing = requireFields(args, ['owner', 'repo', 'title', 'head', 'base']);
    if (missing) return missing;
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (!repo) return notFound('Repository');
    const headRef = String(args.head).split(':').pop() as string;
    const baseRef = String(args.base).split(':').pop() as string;
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      return { ok: false, error: { code: -32602, message: 'head or base branch does not exist' } };
    }
    const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
    if (existing) {
      return toolResult({
        id: existing.id,
        node_id: globalId('PR', `pr:${repo.id}:${existing.number}`),
        number: existing.number,
        title: existing.title,
        body: existing.body,
        state: existing.state,
        head: { ref: existing.headRef, sha: existing.headSha },
        base: { ref: existing.baseRef, sha: existing.baseSha },
        merged: existing.merged,
      });
    }
    const files = store.diffFiles(repo, store.treeMap(repo, baseSha), store.treeMap(repo, headSha));
    const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', headRef, baseRef, headSha, baseSha, files);
    return toolResult({
      id: pull.id,
      node_id: globalId('PR', `pr:${repo.id}:${pull.number}`),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      merged: pull.merged,
    });
  }

  if (name === 'merge_pull_request') {
    const missing = requireFields(args, ['owner', 'repo', 'pull_number']);
    if (missing) return missing;
    const repo = store.getRepo(String(args.owner), String(args.repo));
    if (!repo) return notFound('Repository');
    const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
    if (!pull) return notFound('Pull request');
    if (pull.merged) {
      return toolResult({ number: pull.number, merged: true, sha: pull.mergeCommitSha, state: pull.state });
    }
    if (pull.state !== 'open') {
      return { ok: false, error: { code: -32602, message: 'Pull request is closed' } };
    }
    const oid = store.squashMerge(repo, pull);
    if (!oid) {
      return { ok: false, error: { code: -32602, message: 'Merge conflict' } };
    }
    return toolResult({ number: pull.number, merged: true, sha: oid, state: pull.state, merge_commit_sha: oid });
  }

  return { ok: false, error: { code: -32602, message: `unknown tool: ${name}` } };
}

export function handleMcp(store: Store, bodyText: string): { status: number; body: string } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';

  // Notifications (no id) are answered 202 with an empty body.
  if (req.id === undefined || req.id === null) {
    if (method.startsWith('notifications/')) return { status: 202, body: '' };
    return {
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }

  const params = (req.params ?? {}) as Record<string, unknown>;
  const respond = (result: unknown): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  });
  const fail = (error: RpcError): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, error }),
  });

  if (method === 'server/discover') {
    return respond({
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    return respond({
      protocolVersion: requested,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') return respond({});
  if (method === 'tools/list') {
    // The tools array is a module-level constant: identical on every call.
    return respond({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const outcome = callTool(store, toolName, params.arguments ?? {});
    if (!outcome.ok) return fail(outcome.error);
    return respond(outcome.result);
  }
  return fail({ code: -32601, message: `Method not found: ${method}` });
}

export { isoTs, type Repo };
