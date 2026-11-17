// graphql.ts — a small GraphQL parser and executor for the exact documents the
// suite sends (variables, aliases, inline input objects, fragments, batches,
// introspection). It is not a general GraphQL engine; unknown fields produce the
// standard "Cannot query field" error the suite checks for.

import { Store, VIEWER, decodeGlobalId, globalId, isoTs, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer + parser
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const raw = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end === -1 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (e === 'u' && j + 5 < n) {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[e] ?? e;
            j += 2;
          }
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      const raw = src.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number.parseFloat(raw) } : { kind: 'int', value: Number.parseInt(raw, 10) });
      i = j;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<[string, GqlValue]> };

export interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<[string, GqlValue]>;
  directives: Array<{ name: string; args: Array<[string, GqlValue]> }>;
  selections: GqlSelection[] | null;
}

export type GqlSelection =
  | GqlField
  | { kind: 'fragmentSpread'; name: string; directives: Array<{ name: string; args: Array<[string, GqlValue]> }> }
  | { kind: 'inlineFragment'; typeCond: string | null; directives: Array<{ name: string; args: Array<[string, GqlValue]> }>; selections: GqlSelection[] };

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
}

export interface GqlFragment {
  name: string;
  typeCond: string;
  selections: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlFragment>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected '${v}'`);
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected a name');
    return t.value;
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return !!t && t.kind === 'punct' && t.value === v;
  }

  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operations: [], fragments: new Map() };
    while (this.pos < this.tokens.length) {
      const t = this.peek() as Token;
      if (t.kind === 'punct' && t.value === '{') {
        doc.operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = t.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const nt = this.peek();
        if (nt?.kind === 'name') {
          name = this.next().value as string;
        }
        const varDefs = this.isPunct('(') ? this.parseVarDefs() : [];
        doc.operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment');
        const typeCond = this.expectName();
        doc.fragments.set(name, { name, typeCond, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(t)}`);
    }
    return doc;
  }

  private parseVarDefs(): Array<{ name: string; defaultValue: GqlValue | null }> {
    const defs: Array<{ name: string; defaultValue: GqlValue | null }> = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      // Skip the type (Name, [..], !).
      let depth = 0;
      for (;;) {
        const t = this.next();
        if (t.kind === 'punct' && t.value === '[') depth += 1;
        else if (t.kind === 'punct' && t.value === ']') {
          depth -= 1;
          if (depth === 0) {
            if (this.isPunct('!')) this.next();
            break;
          }
        } else if (t.kind === 'punct' && t.value === '!') {
          if (depth === 0) break;
          continue;
        } else if (t.kind === 'name') {
          if (depth === 0) {
            if (this.isPunct('!')) this.next();
            break;
          }
          continue;
        } else throw new Error('bad variable type');
      }
      let defaultValue: GqlValue | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: GqlValue[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<[string, GqlValue]> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push([name, this.parseValue()]);
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('bad value');
  }

  private parseArguments(): Array<[string, GqlValue]> {
    const args: Array<[string, GqlValue]> = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push([name, this.parseValue()]);
    }
    this.expectPunct(')');
    return args;
  }

  private parseDirectives(): Array<{ name: string; args: Array<[string, GqlValue]> }> {
    const dirs: Array<{ name: string; args: Array<[string, GqlValue]> }> = [];
    while (this.isPunct('@')) {
      this.next();
      const name = this.expectName();
      const args = this.isPunct('(') ? this.parseArguments() : [];
      dirs.push({ name, args });
    }
    return dirs;
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const sels: GqlSelection[] = [];
    while (!this.isPunct('}')) {
      const t = this.peek() as Token;
      if (t.kind === 'spread') {
        this.next();
        const nt = this.peek();
        if (nt?.kind === 'name' && nt.value === 'on') {
          this.next();
          const typeCond = this.expectName();
          const directives = this.parseDirectives();
          sels.push({ kind: 'inlineFragment', typeCond, directives, selections: this.parseSelectionSet() });
        } else if (nt?.kind === 'name') {
          const name = this.next().value as string;
          const directives = this.parseDirectives();
          sels.push({ kind: 'fragmentSpread', name, directives });
        } else {
          const directives = this.parseDirectives();
          sels.push({ kind: 'inlineFragment', typeCond: null, directives, selections: this.parseSelectionSet() });
        }
        continue;
      }
      if (t.kind === 'name') {
        let alias: string | null = null;
        let name = this.next().value as string;
        if (this.isPunct(':')) {
          this.next();
          alias = name;
          name = this.expectName();
        }
        const args = this.isPunct('(') ? this.parseArguments() : [];
        const directives = this.parseDirectives();
        const selections = this.isPunct('{') ? this.parseSelectionSet() : null;
        sels.push({ kind: 'field', alias, name, args, directives, selections });
        continue;
      }
      throw new Error('bad selection');
    }
    this.expectPunct('}');
    return sels;
  }
}

export function parseDocument(src: string): GqlDocument {
  return new Parser(tokenize(src)).parseDocument();
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type GqlObject =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string; id: number }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; repo: Repo; items: Issue[]; total: number; endCursor: string | null; hasNextPage: boolean }
  | { __typename: 'PullRequestConnection'; repo: Repo; items: Pull[]; total: number; endCursor: string | null; hasNextPage: boolean }
  | { __typename: 'PullRequestFileConnection'; files: Array<{ path: string; additions: number; deletions: number; changes: number }> }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: '__Type'; name: string; kind: string; fields: string[]; enumValues: string[] }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: 'CommentEdge'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __typename: 'IssueEdge'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequestEdge'; repo: Repo; pull: Pull }
  | { __typename: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changes: number };

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'mergedAt', 'createdAt', 'updatedAt', 'author', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  SearchType: [],
};
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'ORGANIZATION'],
};

function encodeCursor(number: number): string {
  return Buffer.from(`c:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('c:')) return null;
    const n = Number.parseInt(text.slice(2), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function resolveValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return vars[v.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.items.map((i) => resolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = resolveValue(val, vars);
      return out;
    }
  }
}

function argsMap(args: Array<[string, GqlValue]>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of args) out[k] = resolveValue(v, vars);
  return out;
}

function directiveSkip(directives: Array<{ name: string; args: Array<[string, GqlValue]> }>, vars: Record<string, unknown>): boolean {
  for (const d of directives) {
    const m = argsMap(d.args, vars);
    if (d.name === 'skip' && m.if === true) return true;
    if (d.name === 'include' && m.if === false) return true;
  }
  return false;
}

interface ExecCtx {
  store: Store;
  vars: Record<string, unknown>;
  doc: GqlDocument;
  errors: Array<{ message: string }>;
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const dec = decodeGlobalId(id);
  if (!dec || dec.kind !== 'R') return null;
  const m = /^repo:(\d+)$/.exec(dec.payload);
  if (!m) return null;
  const dbId = Number.parseInt(m[1], 10);
  return store.repoOrder.find((r) => r.id === dbId) ?? null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const dec = decodeGlobalId(id);
  if (!dec || dec.kind !== 'I') return null;
  const m = /^issue:(\d+):(\d+)$/.exec(dec.payload);
  if (!m) return null;
  const repo = store.repoOrder.find((r) => r.id === Number.parseInt(m[1], 10));
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === Number.parseInt(m[2], 10));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const dec = decodeGlobalId(id);
  if (!dec || dec.kind !== 'PR') return null;
  const m = /^pr:(\d+):(\d+)$/.exec(dec.payload);
  if (!m) return null;
  const repo = store.repoOrder.find((r) => r.id === Number.parseInt(m[1], 10));
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === Number.parseInt(m[2], 10));
  return pull ? { repo, pull } : null;
}

function paginateConnection<T extends { number: number }>(
  sortedDesc: T[],
  first: number | undefined,
  after: string | null | undefined,
): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const n = decodeCursor(after);
    if (n !== null) {
      const idx = sortedDesc.findIndex((i) => i.number === n);
      if (idx >= 0) start = idx + 1;
    }
  }
  const size = first ?? sortedDesc.length;
  const page = sortedDesc.slice(start, start + size);
  const hasNextPage = start + page.length < sortedDesc.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return { page, hasNextPage, endCursor };
}

function resolveField(ctx: ExecCtx, parent: GqlObject, field: GqlField): { value: unknown; typeName: string | null } {
  const store = ctx.store;
  const name = field.name;
  const args = argsMap(field.args, ctx.vars);
  const type = parent.__typename;

  // -- introspection on any type ---------------------------------------------
  if (name === '__typename') return { value: type, typeName: null };

  if (type === 'Query') {
    if (name === 'viewer') return { value: { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as GqlObject, typeName: 'User' };
    if (name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return { value: repo ? ({ __typename: 'Repository', repo } as GqlObject) : null, typeName: 'Repository' };
    }
    if (name === 'node') {
      const id = String(args.id ?? '');
      const dec = decodeGlobalId(id);
      if (!dec) return { value: null, typeName: null };
      if (dec.kind === 'R') {
        const repo = findRepoByGlobalId(store, id);
        return { value: repo ? ({ __typename: 'Repository', repo } as GqlObject) : null, typeName: 'Repository' };
      }
      if (dec.kind === 'I') {
        const found = findIssueByGlobalId(store, id);
        return { value: found ? ({ __typename: 'Issue', repo: found.repo, issue: found.issue } as GqlObject) : null, typeName: 'Issue' };
      }
      if (dec.kind === 'PR') {
        const found = findPullByGlobalId(store, id);
        return { value: found ? ({ __typename: 'PullRequest', repo: found.repo, pull: found.pull } as GqlObject) : null, typeName: 'PullRequest' };
      }
      if (dec.kind === 'U') return { value: { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as GqlObject, typeName: 'User' };
      if (dec.kind === 'C') {
        const m = /^comment:(\d+):(\d+)$/.exec(dec.payload);
        if (m) {
          const repo = store.repoOrder.find((r) => r.id === Number.parseInt(m[1], 10));
          const issue = repo?.issues.flatMap((i) => i.comments.map((c) => ({ issue: i, c }))).find((x) => x.c.id === Number.parseInt(m[2], 10));
          if (repo && issue) {
            return { value: { __typename: 'IssueComment', repo, issue: issue.issue, commentId: issue.c.id, body: issue.c.body } as GqlObject, typeName: 'IssueComment' };
          }
        }
        return { value: null, typeName: null };
      }
      return { value: null, typeName: null };
    }
    if (name === '__type') {
      const tname = String(args.name ?? '');
      const fields = TYPE_FIELDS[tname];
      const enums = TYPE_ENUMS[tname];
      if (fields === undefined && enums === undefined) return { value: null, typeName: '__Type' };
      return {
        value: { __typename: '__Type', name: tname, kind: enums !== undefined ? 'ENUM' : 'OBJECT', fields: fields ?? [], enumValues: enums ?? [] } as GqlObject,
        typeName: '__Type',
      };
    }
    if (name === '__schema') {
      return { value: { __typename: '__Type', name: '__Schema', kind: 'OBJECT', fields: ['queryType', 'mutationType', 'types'], enumValues: [] } as GqlObject, typeName: '__Type' };
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
    return { value: null, typeName: null };
  }

  if (type === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return { value: null, typeName: 'CreateIssuePayload' };
      }
      const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { value: { __typename: 'CreateIssuePayload', repo, issue } as GqlObject, typeName: 'CreateIssuePayload' };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Issue not found' });
        return { value: null, typeName: 'CloseIssuePayload' };
      }
      found.issue.state = 'closed';
      found.issue.closedAt = isoTs(store.nextSeq());
      found.issue.jsonCache = null;
      return { value: { __typename: 'CloseIssuePayload', repo: found.repo, issue: found.issue } as GqlObject, typeName: 'CloseIssuePayload' };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return { value: null, typeName: 'CreatePullRequestPayload' };
      }
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'head or base branch does not exist' });
        return { value: null, typeName: 'CreatePullRequestPayload' };
      }
      const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
      if (existing) return { value: { __typename: 'CreatePullRequestPayload', repo, pull: existing } as GqlObject, typeName: 'CreatePullRequestPayload' };
      const files = store.diffFiles(repo, store.treeMap(repo, baseSha), store.treeMap(repo, headSha));
      const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headSha, baseSha, files);
      return { value: { __typename: 'CreatePullRequestPayload', repo, pull } as GqlObject, typeName: 'CreatePullRequestPayload' };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Pull request not found' });
        return { value: null, typeName: 'MergePullRequestPayload' };
      }
      if (!found.pull.merged && found.pull.state === 'open') {
        const oid = store.squashMerge(found.repo, found.pull);
        if (!oid) {
          ctx.errors.push({ message: 'Merge conflict' });
          return { value: null, typeName: 'MergePullRequestPayload' };
        }
      }
      return { value: { __typename: 'MergePullRequestPayload', repo: found.repo, pull: found.pull } as GqlObject, typeName: 'MergePullRequestPayload' };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'Subject not found' });
        return { value: null, typeName: 'AddCommentPayload' };
      }
      const seq = store.nextSeq();
      const comment = { id: store.nextCommentId, body: String(input.body ?? ''), user: VIEWER.login, createdAt: isoTs(seq), seq };
      store.nextCommentId += 1;
      found.issue.comments.push(comment);
      found.issue.jsonCache = null;
      return {
        value: { __typename: 'AddCommentPayload', repo: found.repo, issue: found.issue, commentId: comment.id, body: comment.body } as GqlObject,
        typeName: 'AddCommentPayload',
      };
    }
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
    return { value: null, typeName: null };
  }

  if (type === 'Repository') {
    const repo = (parent as { repo: Repo }).repo;
    switch (name) {
      case 'id': return { value: globalId('R', `repo:${repo.id}`), typeName: null };
      case 'databaseId': return { value: repo.id, typeName: null };
      case 'name': return { value: repo.name, typeName: null };
      case 'nameWithOwner': return { value: `${repo.owner}/${repo.name}`, typeName: null };
      case 'owner': return { value: { __typename: 'User', login: repo.owner, id: VIEWER.id } as GqlObject, typeName: 'User' };
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return { value: tip ? ({ __typename: 'Ref', name: repo.defaultBranch } as GqlObject) : null, typeName: 'Ref' };
      }
      case 'viewerPermission': return { value: 'ADMIN', typeName: null };
      case 'hasIssuesEnabled': return { value: true, typeName: null };
      case 'description': return { value: repo.description, typeName: null };
      case 'private': return { value: repo.isPrivate, typeName: null };
      case 'url': return { value: `/${repo.owner}/${repo.name}`, typeName: null };
      case 'createdAt': return { value: repo.createdAt, typeName: null };
      case 'updatedAt': return { value: repo.updatedAt, typeName: null };
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return { value: issue ? ({ __typename: 'Issue', repo, issue } as GqlObject) : null, typeName: 'Issue' };
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states) {
          const want = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => want.has(i.state));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const dir = String(orderBy.direction ?? 'DESC').toUpperCase();
        list.sort((a, b) => (dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        const first = typeof args.first === 'number' ? args.first : undefined;
        const { page, hasNextPage, endCursor } = paginateConnection(list, first, typeof args.after === 'string' ? args.after : null);
        return {
          value: { __typename: 'IssueConnection', repo, items: page, total: list.length, endCursor, hasNextPage } as GqlObject,
          typeName: 'IssueConnection',
        };
      }
      case 'pullRequests': {
        let list = [...repo.pulls];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states) {
          const want = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((p) => want.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
        }
        list.sort((a, b) => b.seq - a.seq);
        const first = typeof args.first === 'number' ? args.first : undefined;
        const { page, hasNextPage, endCursor } = paginateConnection(list, first, typeof args.after === 'string' ? args.after : null);
        return {
          value: { __typename: 'PullRequestConnection', repo, items: page, total: list.length, endCursor, hasNextPage } as GqlObject,
          typeName: 'PullRequestConnection',
        };
      }
      case 'pullRequest': {
        const pull = repo.pulls.find((p) => p.number === Number(args.number));
        return { value: pull ? ({ __typename: 'PullRequest', repo, pull } as GqlObject) : null, typeName: 'PullRequest' };
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "Repository".` });
        return { value: null, typeName: null };
    }
  }

  if (type === 'Issue') {
    const { repo, issue } = parent as { repo: Repo; issue: Issue };
    switch (name) {
      case 'id': return { value: globalId('I', `issue:${repo.id}:${issue.number}`), typeName: null };
      case 'number': return { value: issue.number, typeName: null };
      case 'title': return { value: issue.title, typeName: null };
      case 'state': return { value: issue.state.toUpperCase(), typeName: null };
      case 'body': return { value: issue.body, typeName: null };
      case 'url': return { value: `/${repo.owner}/${repo.name}/issues/${issue.number}`, typeName: null };
      case 'createdAt': return { value: issue.createdAt, typeName: null };
      case 'updatedAt': return { value: issue.updatedAt, typeName: null };
      case 'closedAt': return { value: issue.closedAt, typeName: null };
      case 'author': return { value: { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as GqlObject, typeName: 'User' };
      case 'repository': return { value: { __typename: 'Repository', repo } as GqlObject, typeName: 'Repository' };
      case 'labels': return { value: issue.labels.map((l) => l.name), typeName: null };
      case 'comments': return { value: issue.comments.length, typeName: null };
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "Issue".` });
        return { value: null, typeName: null };
    }
  }

  if (type === 'PullRequest') {
    const { repo, pull } = parent as { repo: Repo; pull: Pull };
    switch (name) {
      case 'id': return { value: globalId('PR', `pr:${repo.id}:${pull.number}`), typeName: null };
      case 'number': return { value: pull.number, typeName: null };
      case 'title': return { value: pull.title, typeName: null };
      case 'body': return { value: pull.body, typeName: null };
      case 'state': return { value: pull.merged ? 'MERGED' : pull.state.toUpperCase(), typeName: null };
      case 'merged': return { value: pull.merged, typeName: null };
      case 'mergeable': {
        if (pull.state !== 'open') return { value: 'UNKNOWN', typeName: null };
        return { value: store.mergeConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE', typeName: null };
      }
      case 'headRefName': return { value: pull.headRef, typeName: null };
      case 'baseRefName': return { value: pull.baseRef, typeName: null };
      case 'headRef': return { value: { __typename: 'Ref', name: pull.headRef } as GqlObject, typeName: 'Ref' };
      case 'baseRef': return { value: { __typename: 'Ref', name: pull.baseRef } as GqlObject, typeName: 'Ref' };
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : undefined;
        const files = first !== undefined ? pull.files.slice(0, first) : pull.files;
        return {
          value: {
            __typename: 'PullRequestFileConnection',
            files: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes })),
          } as GqlObject,
          typeName: 'PullRequestFileConnection',
        };
      }
      case 'mergedAt': return { value: pull.mergedAt, typeName: null };
      case 'createdAt': return { value: pull.createdAt, typeName: null };
      case 'updatedAt': return { value: pull.updatedAt, typeName: null };
      case 'author': return { value: { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as GqlObject, typeName: 'User' };
      case 'url': return { value: `/${repo.owner}/${repo.name}/pull/${pull.number}`, typeName: null };
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequest".` });
        return { value: null, typeName: null };
    }
  }

  if (type === 'User') {
    const u = parent as { login: string; id: number };
    switch (name) {
      case 'id': return { value: globalId('U', `user:${u.id}`), typeName: null };
      case 'login': return { value: u.login, typeName: null };
      case 'name': return { value: VIEWER.name, typeName: null };
      case 'email': return { value: VIEWER.email, typeName: null };
      case 'avatarUrl': return { value: '', typeName: null };
      case 'url': return { value: `/${u.login}`, typeName: null };
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "User".` });
        return { value: null, typeName: null };
    }
  }

  if (type === 'Ref') {
    if (name === 'name') return { value: (parent as { name: string }).name, typeName: null };
    if (name === 'id') return { value: globalId('Ref', `ref:${(parent as { name: string }).name}`), typeName: null };
    ctx.errors.push({ message: `Cannot query field "${name}" on type "Ref".` });
    return { value: null, typeName: null };
  }

  if (type === 'IssueConnection' || type === 'PullRequestConnection') {
    const conn = parent as { items: Array<Issue | Pull>; total: number; endCursor: string | null; hasNextPage: boolean; repo: Repo };
    switch (name) {
      case 'nodes': {
        if (type === 'IssueConnection') {
          return {
            value: (conn.items as Issue[]).map((i) => ({ __typename: 'Issue', repo: conn.repo, issue: i }) as GqlObject),
            typeName: 'Issue',
          };
        }
        return {
          value: (conn.items as Pull[]).map((p) => ({ __typename: 'PullRequest', repo: conn.repo, pull: p }) as GqlObject),
          typeName: 'PullRequest',
        };
      }
      case 'edges': {
        const edges = conn.items.map((item) => {
          if (type === 'IssueConnection') return { __typename: 'IssueEdge', repo: conn.repo, issue: item as Issue } as GqlObject;
          return { __typename: 'PullRequestEdge', repo: conn.repo, pull: item as Pull } as GqlObject;
        });
        return { value: edges, typeName: type === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge' };
      }
      case 'pageInfo':
        return {
          value: { __typename: 'PageInfo', hasNextPage: conn.hasNextPage, hasPreviousPage: false, startCursor: conn.items.length > 0 ? encodeCursor(conn.items[0].number) : null, endCursor: conn.endCursor } as GqlObject,
          typeName: 'PageInfo',
        };
      case 'totalCount': return { value: conn.total, typeName: null };
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
        return { value: null, typeName: null };
    }
  }

  if (type === 'PageInfo') {
    const p = parent as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
    switch (name) {
      case 'hasNextPage': return { value: p.hasNextPage, typeName: null };
      case 'hasPreviousPage': return { value: p.hasPreviousPage, typeName: null };
      case 'startCursor': return { value: p.startCursor, typeName: null };
      case 'endCursor': return { value: p.endCursor, typeName: null };
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "PageInfo".` });
        return { value: null, typeName: null };
    }
  }

  if (type === 'PullRequestFileConnection') {
    const c = parent as { files: Array<{ path: string; additions: number; deletions: number; changes: number }> };
    switch (name) {
      case 'nodes':
        return {
          value: c.files.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path, additions: f.additions, deletions: f.deletions, changes: f.changes }) as GqlObject),
          typeName: 'PullRequestChangedFile',
        };
      case 'totalCount': return { value: c.files.length, typeName: null };
      case 'pageInfo':
        return { value: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } as GqlObject, typeName: 'PageInfo' };
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestFileConnection".` });
        return { value: null, typeName: null };
    }
  }

  if (type === 'PullRequestChangedFile') {
    const f = parent as { path: string; additions: number; deletions: number; changes: number };
    switch (name) {
      case 'path': return { value: f.path, typeName: null };
      case 'additions': return { value: f.additions, typeName: null };
      case 'deletions': return { value: f.deletions, typeName: null };
      case 'changes': return { value: f.changes, typeName: null };
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestChangedFile".` });
        return { value: null, typeName: null };
    }
  }

  if (type === 'IssueEdge') {
    const e = parent as { repo: Repo; issue: Issue };
    if (name === 'node') return { value: { __typename: 'Issue', repo: e.repo, issue: e.issue } as GqlObject, typeName: 'Issue' };
    if (name === 'cursor') return { value: encodeCursor(e.issue.number), typeName: null };
    ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueEdge".` });
    return { value: null, typeName: null };
  }

  if (type === 'PullRequestEdge') {
    const e = parent as { repo: Repo; pull: Pull };
    if (name === 'node') return { value: { __typename: 'PullRequest', repo: e.repo, pull: e.pull } as GqlObject, typeName: 'PullRequest' };
    if (name === 'cursor') return { value: encodeCursor(e.pull.number), typeName: null };
    ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestEdge".` });
    return { value: null, typeName: null };
  }

  if (type === 'IssueComment') {
    const c = parent as { commentId: number; body: string };
    switch (name) {
      case 'id': return { value: globalId('C', `comment:${(parent as { repo: Repo }).repo.id}:${c.commentId}`), typeName: null };
      case 'body': return { value: c.body, typeName: null };
      case 'author': return { value: { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as GqlObject, typeName: 'User' };
      case 'createdAt': return { value: isoTs(0), typeName: null };
      case 'url': return { value: '', typeName: null };
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueComment".` });
        return { value: null, typeName: null };
    }
  }

  if (type === '__Type') {
    const t = parent as { name: string; kind: string; fields: string[]; enumValues: string[] };
    switch (name) {
      case 'name': return { value: t.name, typeName: null };
      case 'kind': return { value: t.kind, typeName: null };
      case 'fields': {
        const list = t.fields.map((f) => ({ __typename: '__Type', name: f, kind: 'FIELD', fields: [], enumValues: [] }) as GqlObject);
        return { value: list, typeName: '__Type' };
      }
      case 'enumValues': {
        const list = t.enumValues.map((e) => ({ __typename: '__Type', name: e, kind: 'ENUM_VALUE', fields: [], enumValues: [] }) as GqlObject);
        return { value: list, typeName: '__Type' };
      }
      case 'description': return { value: null, typeName: null };
      default:
        ctx.errors.push({ message: `Cannot query field "${name}" on type "__Type".` });
        return { value: null, typeName: null };
    }
  }

  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    const p = parent as { repo: Repo; issue: Issue };
    if (name === 'issue') return { value: { __typename: 'Issue', repo: p.repo, issue: p.issue } as GqlObject, typeName: 'Issue' };
    if (name === 'clientMutationId') return { value: null, typeName: null };
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
    return { value: null, typeName: null };
  }

  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    const p = parent as { repo: Repo; pull: Pull };
    if (name === 'pullRequest') return { value: { __typename: 'PullRequest', repo: p.repo, pull: p.pull } as GqlObject, typeName: 'PullRequest' };
    if (name === 'clientMutationId') return { value: null, typeName: null };
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
    return { value: null, typeName: null };
  }

  if (type === 'AddCommentPayload') {
    const p = parent as { repo: Repo; issue: Issue; commentId: number; body: string };
    if (name === 'commentEdge') {
      return { value: { __typename: 'CommentEdge', repo: p.repo, issue: p.issue, commentId: p.commentId, body: p.body } as GqlObject, typeName: 'CommentEdge' };
    }
    if (name === 'subject') return { value: { __typename: 'Issue', repo: p.repo, issue: p.issue } as GqlObject, typeName: 'Issue' };
    if (name === 'clientMutationId') return { value: null, typeName: null };
    ctx.errors.push({ message: `Cannot query field "${name}" on type "AddCommentPayload".` });
    return { value: null, typeName: null };
  }

  if (type === 'CommentEdge') {
    const e = parent as { repo: Repo; issue: Issue; commentId: number; body: string };
    if (name === 'node') return { value: { __typename: 'IssueComment', repo: e.repo, issue: e.issue, commentId: e.commentId, body: e.body } as GqlObject, typeName: 'IssueComment' };
    if (name === 'cursor') return { value: encodeCursor(e.commentId), typeName: null };
    ctx.errors.push({ message: `Cannot query field "${name}" on type "CommentEdge".` });
    return { value: null, typeName: null };
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
  return { value: null, typeName: null };
}

function isObjectValue(v: unknown): v is GqlObject {
  return !!v && typeof v === 'object' && !Array.isArray(v) && '__typename' in (v as Record<string, unknown>);
}

/** Apply a selection set to a resolved parent object. */
function executeSelections(ctx: ExecCtx, parent: GqlObject, selections: GqlSelection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      if (directiveSkip(sel.directives, ctx.vars)) continue;
      const frag = ctx.doc.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      if (frag.typeCond !== parent.__typename && frag.typeCond !== 'Node') continue;
      Object.assign(out, executeSelections(ctx, parent, frag.selections));
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (directiveSkip(sel.directives, ctx.vars)) continue;
      if (sel.typeCond !== null && sel.typeCond !== parent.__typename && sel.typeCond !== 'Node') continue;
      Object.assign(out, executeSelections(ctx, parent, sel.selections));
      continue;
    }
    // field
    if (directiveSkip(sel.directives, ctx.vars)) continue;
    const key = sel.alias ?? sel.name;
    const { value, typeName } = resolveField(ctx, parent, sel);
    out[key] = resolveValueWithSelections(ctx, value, typeName, sel.selections);
  }
  return out;
}

function resolveValueWithSelections(
  ctx: ExecCtx,
  value: unknown,
  typeName: string | null,
  selections: GqlSelection[] | null,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (isObjectValue(item) && selections) return executeSelections(ctx, item, selections);
      return item;
    });
  }
  if (isObjectValue(value)) {
    if (!selections) return {};
    return executeSelections(ctx, value, selections);
  }
  return value;
}

/** Execute one operation object {query, variables, operationName}. */
export function executeOperation(
  store: Store,
  op: { query?: unknown; variables?: unknown; operationName?: unknown },
): Record<string, unknown> {
  const query = typeof op.query === 'string' ? op.query : '';
  const variables = (op.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof op.operationName === 'string' ? op.operationName : undefined;
  let doc: GqlDocument;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: GqlOperation | undefined;
  if (operationName) {
    operation = doc.operations.find((o) => o.name === operationName);
    if (!operation) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { errors: [{ message: 'No operations in document.' }] };
  } else {
    return { errors: [{ message: 'Multiple operations require an operationName.' }] };
  }
  const vars: Record<string, unknown> = { ...variables };
  for (const def of operation.varDefs) {
    if (!(def.name in vars) || vars[def.name] === undefined) {
      if (def.defaultValue) vars[def.name] = resolveValue(def.defaultValue, vars);
      else vars[def.name] = null;
    }
  }
  const ctx: ExecCtx = { store, vars, doc, errors: [] };
  const root: GqlObject = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(ctx, root, operation.selections);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}
