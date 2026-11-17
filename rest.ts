// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, all on the shared Store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  VIEWER,
  ZERO,
  globalId,
  isoTs,
  parseCommit,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestCtx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyText: string;
}

type Json = Record<string, unknown>;

function json(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(text);
}

function err(res: ServerResponse, status: number, message: string): void {
  json(res, status, { message });
}

function noContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-oauth-scopes': 'repo, read:org' });
  res.end();
}

function userJson(): Json {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', avatar_url: '', html_url: '' };
}

export function repoJson(repo: Repo): string {
  if (repo.jsonCache) return repo.jsonCache;
  const text = JSON.stringify({
    id: repo.id,
    node_id: globalId('R', `repo:${repo.id}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: `/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    size: 0,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  });
  repo.jsonCache = text;
  return text;
}

function labelJson(label: Label, repo: Repo): Json {
  return {
    id: label.id,
    node_id: globalId('L', `label:${repo.id}:${label.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: '',
  };
}

export function issueJson(issue: Issue, repo: Repo): string {
  if (issue.jsonCache) return issue.jsonCache;
  const text = JSON.stringify({
    id: issue.id,
    node_id: globalId('I', `issue:${repo.id}:${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(),
    labels: issue.labels.map((l) => labelJson(l, repo)),
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  });
  issue.jsonCache = text;
  return text;
}

function pullJson(store: Store, pull: Pull, repo: Repo): Json {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  let mergeable = false;
  if (pull.state === 'open' && !pull.merged) mergeable = !store.mergeConflict(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PR', `pr:${repo.id}:${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(),
    labels: [],
    assignees: [],
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headTip,
      user: userJson(),
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseTip,
      user: userJson(),
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    merged: pull.merged,
    mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
  };
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Paginate an array, setting the Link header when there are more pages. */
function paginate<T>(ctx: RestCtx, items: T[], total: number): T[] {
  const { page, perPage } = parsePage(ctx.query);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page < totalPages) {
    const origin = `http://${ctx.req.headers.host ?? '127.0.0.1'}`;
    const path = ctx.req.url?.split('?')[0] ?? '';
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(page + 1));
    q.set('per_page', String(perPage));
    const nextUrl = `${origin}${path}?${q.toString()}`;
    ctx.res.setHeader('Link', `<${nextUrl}>; rel="next"`);
  }
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function bodyObj(ctx: RestCtx): Json {
  if (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body)) return ctx.body as Json;
  return {};
}

function refTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function resolveRef(ctx: RestCtx, repo: Repo): string | undefined {
  const ref = ctx.query.get('ref');
  if (ref) return refTip(repo, ref);
  return refTip(repo, repo.defaultBranch);
}

export function handleRest(ctx: RestCtx): void {
  const { res, segments } = ctx;
  const seg = segments;

  // -- API root -------------------------------------------------------------
  if (seg.length === 0) {
    json(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      search_url: '/api/v3/search',
    });
    return;
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    json(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (ctx.req.method !== 'GET') return err(res, 405, 'Method Not Allowed');
    json(res, 200, userJson());
    return;
  }
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (ctx.req.method === 'GET') {
      const repos = ctx.store.viewerRepos();
      const page = paginate(ctx, repos, repos.length);
      json(res, 200, page.map((r) => JSON.parse(repoJson(r))));
      return;
    }
    if (ctx.req.method === 'POST') {
      const b = bodyObj(ctx);
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (name === '') return err(res, 422, 'name is required');
      if (ctx.store.getRepo(VIEWER.login, name)) return err(res, 422, 'Repository already exists');
      const repo = ctx.store.createRepo(VIEWER.login, name, {
        description: typeof b.description === 'string' ? b.description : '',
        isPrivate: b.private === true,
        defaultBranch: typeof b.default_branch === 'string' && b.default_branch !== '' ? b.default_branch : undefined,
      });
      json(res, 201, repoJson(repo));
      return;
    }
    return err(res, 405, 'Method Not Allowed');
  }

  // -- /repos/{owner}/{repo}/... --------------------------------------------
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeURIComponent(seg[1]);
    const name = decodeURIComponent(seg[2]);
    const repo = ctx.store.getRepo(owner, name);
    if (!repo) return err(res, 404, 'Not Found');
    handleRepo(ctx, repo, seg.slice(3));
    return;
  }

  err(res, 404, 'Not Found');
}

function handleRepo(ctx: RestCtx, repo: Repo, rest: string[]): void {
  const { res, store } = ctx;
  const method = ctx.req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') return json(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const b = bodyObj(ctx);
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.isPrivate = b.private;
      if (typeof b.default_branch === 'string' && b.default_branch !== '') repo.defaultBranch = b.default_branch;
      repo.jsonCache = null;
      return json(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return noContent(res);
    }
    return err(res, 405, 'Method Not Allowed');
  }

  const head = rest[0];

  // -- branches --------------------------------------------------------------
  if (head === 'branches') {
    if (method !== 'GET') return err(res, 405, 'Method Not Allowed');
    if (rest.length === 1) {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) }, protected: false }));
      return json(res, 200, list);
    }
    const branch = rest.slice(1).join('/');
    const tip = refTip(repo, branch);
    if (!tip) return err(res, 404, 'Not Found');
    return json(res, 200, { name: branch, commit: { sha: tip }, protected: false });
  }

  // -- git refs ---------------------------------------------------------------
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const b = bodyObj(ctx);
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(res, 422, 'ref and sha are required');
      if (repo.refs.has(ref)) return err(res, 422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(res, 422, 'Object does not exist');
      repo.refs.set(ref, sha);
      repo.version += 1;
      return json(res, 201, { ref, node_id: globalId('G', `ref:${repo.id}:${ref}`), object: { sha, type: 'commit', url: '' } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const oid = repo.refs.get(ref);
      if (!oid) return err(res, 404, 'Not Found');
      const obj = repo.objects.get(oid);
      return json(res, 200, { ref, node_id: globalId('G', `ref:${repo.id}:${ref}`), object: { sha: oid, type: obj?.type ?? 'commit', url: '' } });
    }
    return err(res, 405, 'Method Not Allowed');
  }

  // -- commits ----------------------------------------------------------------
  if (head === 'commits') {
    if (method !== 'GET') return err(res, 405, 'Method Not Allowed');
    const shaParam = ctx.query.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = /^[0-9a-f]{40}$/.test(shaParam) ? (repo.objects.has(shaParam) ? shaParam : undefined) : refTip(repo, shaParam);
      if (!tip) return err(res, 404, 'Not Found');
    } else {
      tip = refTip(repo, repo.defaultBranch);
      if (!tip) return json(res, 200, []);
    }
    const walk = store.commitWalk(repo, tip);
    const list = walk.map((oid) => {
      const info = parseCommit(repo.objects.get(oid)?.data ?? Buffer.alloc(0));
      return {
        sha: oid,
        node_id: globalId('C', `commit:${repo.id}:${oid}`),
        commit: {
          message: info.message,
          author: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt },
          committer: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt },
          tree: { sha: info.tree },
        },
        author: userJson(),
        committer: userJson(),
        parents: info.parents.map((p) => ({ sha: p })),
      };
    });
    const page = paginate(ctx, list, list.length);
    return json(res, 200, page);
  }

  // -- contents ---------------------------------------------------------------
  if (head === 'contents') {
    return handleContents(ctx, repo, rest.slice(1).join('/'));
  }

  // -- labels -----------------------------------------------------------------
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return json(res, 200, [...repo.labels.values()].map((l) => labelJson(l, repo)));
    }
    if (method === 'POST' && rest.length === 1) {
      const b = bodyObj(ctx);
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      const color = typeof b.color === 'string' ? b.color : 'ededed';
      if (name === '') return err(res, 422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing) return json(res, 201, labelJson(existing, repo));
      const label: Label = { id: repo.nextLabelId, name, color };
      repo.nextLabelId += 1;
      repo.labels.set(name, label);
      return json(res, 201, labelJson(label, repo));
    }
    return err(res, 405, 'Method Not Allowed');
  }

  // -- issues -----------------------------------------------------------------
  if (head === 'issues') {
    return handleIssues(ctx, repo, rest.slice(1));
  }

  // -- pull requests ----------------------------------------------------------
  if (head === 'pulls') {
    return handlePulls(ctx, repo, rest.slice(1));
  }

  err(res, 404, 'Not Found');
}

function handleContents(ctx: RestCtx, repo: Repo, path: string): void {
  const { res, store } = ctx;
  const method = ctx.req.method ?? 'GET';
  const decodedPath = path.split('/').filter((p) => p !== '').map(decodeURIComponent).join('/');

  if (method === 'GET') {
    const tip = resolveRef(ctx, repo);
    if (!tip) return err(res, 404, 'Not Found');
    if (decodedPath === '') {
      const entries = store.treeEntries(repo, tip, '') ?? [];
      return json(res, 200, entries.map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: e.name,
        sha: e.oid,
        size: 0,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(e.name)}`,
      })));
    }
    const parent = decodedPath.split('/').slice(0, -1).join('/');
    const base = decodedPath.split('/').pop() as string;
    const entries = store.treeEntries(repo, tip, parent);
    if (!entries) return err(res, 404, 'Not Found');
    const entry = entries.find((e) => e.name === base);
    if (!entry) return err(res, 404, 'Not Found');
    if (entry.mode === '40000') {
      const sub = store.treeEntries(repo, tip, decodedPath) ?? [];
      return json(res, 200, sub.map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: `${decodedPath}/${e.name}`,
        sha: e.oid,
        size: 0,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(decodedPath)}/${encodeURIComponent(e.name)}`,
      })));
    }
    const blob = repo.objects.get(entry.oid);
    if (!blob) return err(res, 404, 'Not Found');
    return json(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: base,
      path: decodedPath,
      content: blob.data.toString('base64'),
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(decodedPath)}`,
    });
  }

  if (method === 'PUT') {
    const b = bodyObj(ctx);
    const message = typeof b.message === 'string' ? b.message : 'Update file';
    const contentB64 = typeof b.content === 'string' ? b.content.replace(/\s+/g, '') : '';
    if (contentB64 === '' && typeof b.content !== 'string') return err(res, 422, 'content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return err(res, 422, 'content is not valid base64');
    }
    const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
    let tip = refTip(repo, branch);
    if (!tip) {
      // Create the branch from the default tip (or unborn).
      const defTip = refTip(repo, repo.defaultBranch);
      if (defTip) {
        repo.refs.set(`refs/heads/${branch}`, defTip);
        repo.version += 1;
        tip = defTip;
      }
    }
    const files = tip ? store.treeMap(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const existing = files.get(decodedPath);
    const sha = typeof b.sha === 'string' ? b.sha : '';
    if (existing && sha !== '' && sha !== existing.oid) return err(res, 409, 'sha does not match the current file');
    if (existing && sha === '') return err(res, 409, 'sha is required to update a file');
    const blobOid = store.storeObject(repo, 'blob', content);
    files.set(decodedPath, { oid: blobOid, mode: '100644' });
    const commitOid = store.commitOnBranch(repo, branch, files, message);
    const created = !existing;
    return json(res, created ? 201 : 200, {
      content: {
        name: decodedPath.split('/').pop(),
        path: decodedPath,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(decodedPath)}`,
      },
      commit: {
        sha: commitOid,
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt },
        committer: { name: VIEWER.name, email: VIEWER.email, date: repo.createdAt },
      },
    });
  }

  if (method === 'DELETE') {
    const b = bodyObj(ctx);
    const message = typeof b.message === 'string' ? b.message : 'Delete file';
    const sha = typeof b.sha === 'string' ? b.sha : '';
    const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
    const tip = refTip(repo, branch);
    if (!tip) return err(res, 404, 'Not Found');
    const files = store.treeMap(repo, tip);
    const existing = files.get(decodedPath);
    if (!existing) return err(res, 404, 'Not Found');
    if (sha !== '' && sha !== existing.oid) return err(res, 409, 'sha does not match the current file');
    files.delete(decodedPath);
    const commitOid = store.commitOnBranch(repo, branch, files, message);
    return json(res, 200, { commit: { sha: commitOid, message } });
  }

  err(res, 405, 'Method Not Allowed');
}

function parseLabelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && typeof (item as Json).name === 'string') out.push((item as Json).name as string);
  }
  return out;
}

function handleIssues(ctx: RestCtx, repo: Repo, rest: string[]): void {
  const { res, store } = ctx;
  const method = ctx.req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      if (sort !== 'created') {
        // Only creation ordering is modelled; keep the same list.
      }
      const page = paginate(ctx, list, list.length);
      return json(res, 200, page.map((i) => JSON.parse(issueJson(i, repo))));
    }
    if (method === 'POST') {
      const b = bodyObj(ctx);
      const title = typeof b.title === 'string' ? b.title : '';
      if (title === '') return err(res, 422, 'title is required');
      const labelNames = parseLabelNames(b.labels);
      const labels: Label[] = [];
      for (const ln of labelNames) {
        const label = repo.labels.get(ln);
        if (!label) return err(res, 422, `Label '${ln}' does not exist`);
        labels.push(label);
      }
      const issue = store.createIssue(repo, title, typeof b.body === 'string' ? b.body : '', labels);
      return json(res, 201, issueJson(issue, repo));
    }
    return err(res, 405, 'Method Not Allowed');
  }

  const num = Number.parseInt(rest[0], 10);
  if (!Number.isInteger(num)) return err(res, 404, 'Not Found');
  const issue = repo.issues.find((i) => i.number === num);
  if (!issue) return err(res, 404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return json(res, 200, issueJson(issue, repo));
    if (method === 'PATCH') {
      const b = bodyObj(ctx);
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) {
        if (issue.state !== b.state) {
          issue.state = b.state;
          issue.closedAt = b.state === 'closed' ? isoTs(store.nextSeq()) : null;
        }
      }
      if (Array.isArray(b.labels)) {
        const labelNames = parseLabelNames(b.labels);
        const labels: Label[] = [];
        for (const ln of labelNames) {
          const label = repo.labels.get(ln);
          if (!label) return err(res, 422, `Label '${ln}' does not exist`);
          labels.push(label);
        }
        issue.labels = labels;
      }
      issue.updatedAt = isoTs(store.nextSeq());
      issue.jsonCache = null;
      return json(res, 200, issueJson(issue, repo));
    }
    return err(res, 405, 'Method Not Allowed');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      return json(res, 200, issue.comments.map((c) => ({
        id: c.id,
        node_id: globalId('C', `comment:${repo.id}:${c.id}`),
        body: c.body,
        user: userJson(),
        created_at: c.createdAt,
        updated_at: c.createdAt,
        html_url: '',
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${num}/comments/${c.id}`,
        issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${num}`,
      })));
    }
    if (method === 'POST') {
      const b = bodyObj(ctx);
      const body = typeof b.body === 'string' ? b.body : '';
      if (body === '') return err(res, 422, 'body is required');
      const seq = store.nextSeq();
      const comment = {
        id: store.nextCommentId,
        body,
        user: VIEWER.login,
        createdAt: isoTs(seq),
        seq,
      };
      store.nextCommentId += 1;
      issue.comments.push(comment);
      issue.jsonCache = null;
      return json(res, 201, {
        id: comment.id,
        node_id: globalId('C', `comment:${repo.id}:${comment.id}`),
        body: comment.body,
        user: userJson(),
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
        html_url: '',
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${num}/comments/${comment.id}`,
        issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${num}`,
      });
    }
    return err(res, 405, 'Method Not Allowed');
  }

  err(res, 404, 'Not Found');
}

function stripOwnerPrefix(ref: string): string {
  const idx = ref.indexOf(':');
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

function handlePulls(ctx: RestCtx, repo: Repo, rest: string[]): void {
  const { res, store } = ctx;
  const method = ctx.req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      list = [...list].sort((a, b) => b.seq - a.seq);
      const page = paginate(ctx, list, list.length);
      return json(res, 200, page.map((p) => pullJson(store, p, repo)));
    }
    if (method === 'POST') {
      const b = bodyObj(ctx);
      const title = typeof b.title === 'string' ? b.title : '';
      const headRaw = typeof b.head === 'string' ? b.head : '';
      const baseRaw = typeof b.base === 'string' ? b.base : '';
      if (title === '' || headRaw === '' || baseRaw === '') return err(res, 422, 'title, head and base are required');
      const headRef = stripOwnerPrefix(headRaw);
      const baseRef = stripOwnerPrefix(baseRaw);
      const headSha = refTip(repo, headRef);
      const baseSha = refTip(repo, baseRef);
      if (!headSha || !baseSha) return err(res, 422, 'head or base branch does not exist');
      if (headRef === baseRef) return err(res, 422, 'head and base are the same');
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
      if (dup) return err(res, 422, 'A pull request already exists for this head and base');
      const files = store.diffFiles(repo, store.treeMap(repo, baseSha), store.treeMap(repo, headSha));
      const pull = store.createPull(repo, title, typeof b.body === 'string' ? b.body : '', headRef, baseRef, headSha, baseSha, files);
      return json(res, 201, pullJson(store, pull, repo));
    }
    return err(res, 405, 'Method Not Allowed');
  }

  const num = Number.parseInt(rest[0], 10);
  if (!Number.isInteger(num)) return err(res, 404, 'Not Found');
  const pull = repo.pulls.find((p) => p.number === num);
  if (!pull) return err(res, 404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return json(res, 200, pullJson(store, pull, repo));
    return err(res, 405, 'Method Not Allowed');
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return err(res, 405, 'Method Not Allowed');
    return json(res, 200, pull.files);
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return err(res, 405, 'Method Not Allowed');
    if (pull.merged) return err(res, 405, 'Pull request already merged');
    if (pull.state !== 'open') return err(res, 405, 'Pull request is closed');
    const mergeOid = store.squashMerge(repo, pull);
    if (!mergeOid) return err(res, 405, 'Merge conflict');
    return json(res, 200, { sha: mergeOid, merged: true, message: `Pull request #${pull.number} merged` });
  }

  err(res, 404, 'Not Found');
}

export { ZERO };
