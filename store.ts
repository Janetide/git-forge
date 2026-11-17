// store.ts — in-memory forge state plus the git object model.
// Everything the REST, GraphQL, MCP and git-smart-HTTP layers share lives here so the four
// surfaces always see the same store (ids, refs, issues and PRs never drift between them).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO = '0'.repeat(40);
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};
export const DEFAULT_BRANCH = 'main';
export const EPOCH = 1735689600; // 2025-01-01T00:00:00Z — deterministic timestamp base.

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  return sha1Hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]));
}

export function isoTs(seq: number): string {
  return new Date((EPOCH + seq) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) n += 1;
  if (buf[buf.length - 1] !== 0x0a) n += 1;
  return n;
}

export interface GitObject {
  type: string;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTreeObject(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Issues / pull requests / labels / comments
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
  jsonCache: string | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  baseTipAtCreate: string;
  files: PullFile[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number; // shared issue + PR counter, GitHub-style
  nextLabelId: number;
  version: number; // bumped on any ref/object mutation; invalidates caches
  packCache: Map<string, Buffer>;
  entryCache: Map<string, Buffer>; // oid -> packed object entry bytes
  jsonCache: string | null;
}

export class Store {
  repos = new Map<string, Repo>();
  repoOrder: Repo[] = [];
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo {
    const seq = this.nextSeq();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? DEFAULT_BRANCH,
      createdSeq: seq,
      createdAt: isoTs(seq),
      updatedAt: isoTs(seq),
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextLabelId: 1,
      version: 0,
      packCache: new Map(),
      entryCache: new Map(),
      jsonCache: null,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    const idx = this.repoOrder.indexOf(repo);
    if (idx >= 0) this.repoOrder.splice(idx, 1);
  }

  viewerRepos(): Repo[] {
    return this.repoOrder.filter((r) => r.owner === VIEWER.login);
  }

  // -- git objects ---------------------------------------------------------

  storeObject(repo: Repo, type: string, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.version += 1;
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Build (and store) the nested tree for a flat path -> {oid, mode} map. */
  buildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, TreeEntry>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, f] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let child = node.dirs.get(parts[i]);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(parts[i], child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1], { mode: f.mode, name: parts[parts.length - 1], oid: f.oid });
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [...node.files.values()];
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.storeObject(repo, 'tree', buildTreeObject(entries));
    };
    return build(root);
  }

  /** Flat path -> {oid, mode} map for the tree of a commit. */
  treeMap(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return out;
    const info = parseCommit(obj.data);
    const walk = (treeOid: string, prefix: string): void => {
      const t = repo.objects.get(treeOid);
      if (!t || t.type !== 'tree') return;
      for (const e of parseTree(t.data)) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, p);
        else out.set(p, { oid: e.oid, mode: e.mode });
      }
    };
    walk(info.tree, '');
    return out;
  }

  /** Immediate entries of a directory inside a commit's tree. */
  treeEntries(repo: Repo, commitOid: string, dir: string): TreeEntry[] | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    const info = parseCommit(obj.data);
    let treeOid = info.tree;
    if (dir !== '') {
      for (const part of dir.split('/')) {
        const t = repo.objects.get(treeOid);
        if (!t || t.type !== 'tree') return null;
        const next = parseTree(t.data).find((e) => e.name === part && e.mode === '40000');
        if (!next) return null;
        treeOid = next.oid;
      }
    }
    const t = repo.objects.get(treeOid);
    if (!t || t.type !== 'tree') return null;
    return parseTree(t.data);
  }

  /** Create a commit on a branch from a flat file map; returns the commit oid. */
  commitOnBranch(
    repo: Repo,
    branch: string,
    files: Map<string, { oid: string; mode: string }>,
    message: string,
  ): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const treeOid = this.buildTree(repo, files);
    const seq = this.nextSeq();
    const ts = EPOCH + seq;
    const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
    let head = `tree ${treeOid}\n`;
    if (parent) head += `parent ${parent}\n`;
    head += `author ${ident}\ncommitter ${ident}\n\n${message}`;
    const oid = this.storeObject(repo, 'commit', Buffer.from(head, 'utf8'));
    repo.refs.set(ref, oid);
    repo.version += 1;
    return oid;
  }

  /** Newest-first walk from a ref tip following all parents (linear histories stay linear). */
  commitWalk(repo: Repo, tipOid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tipOid];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const info = parseCommit(obj.data);
      for (const p of info.parents) queue.push(p);
    }
    return out;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    // Fast path: the common case (a push) has the old tip as the new tip's parent.
    const headObj = repo.objects.get(descendant);
    if (headObj && headObj.type === 'commit') {
      const parents = parseCommit(headObj.data).parents;
      if (parents.includes(ancestor)) return true;
      if (parents.length === 0) return false;
    }
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      for (const p of info.parents) {
        if (p === ancestor) return true;
        stack.push(p);
      }
    }
    return false;
  }

  /** Peel an object (tag -> target, recursively) to a commit oid, or null. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let cur = oid;
    for (let i = 0; i < 16; i += 1) {
      const obj = repo.objects.get(cur);
      if (!obj) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') {
        cur = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Full closure of an object: the object plus everything reachable from it. */
  closure(repo: Repo, oid: string, out: Set<string>): void {
    if (out.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      this.closureTree(repo, info.tree, out);
      for (const p of info.parents) this.closure(repo, p, out);
    } else if (obj.type === 'tree') {
      this.closureTree(repo, oid, out);
    } else if (obj.type === 'tag') {
      this.closure(repo, parseTag(obj.data).object, out);
    }
  }

  closureTree(repo: Repo, treeOid: string, out: Set<string>): void {
    if (out.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    out.add(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') this.closureTree(repo, e.oid, out);
      else out.add(e.oid);
    }
  }

  /**
   * Compute the object set for a fetch, following the client's shallow/depth semantics.
   * wants: commit/tag oids. haves: already-held commit oids. shallow: the client's
   * shallow boundary oids. depth: undefined for a full fetch.
   * Returns {oids, shallow, unshallow}: shallow = new boundary commits (deepest sent
   * commits when depth is finite), unshallow = previous boundaries now fully sent.
   */
  fetchSet(
    repo: Repo,
    wants: string[],
    haves: string[],
    shallow: string[],
    depth: number | undefined,
  ): { oids: Set<string>; shallow: string[]; unshallow: string[] } {
    const wanted = new Set<string>();
    const boundary = new Set<string>(); // deepest included commits, when depth is finite
    const included = new Set<string>(); // commits included with their trees
    // BFS over commits with depth from the wants.
    const q: Array<{ oid: string; d: number }> = [];
    for (const w of wants) {
      const c = this.peelToCommit(repo, w);
      if (c) q.push({ oid: c, d: 0 });
      else if (repo.objects.has(w)) wanted.add(w);
    }
    const seenCommit = new Set<string>();
    while (q.length > 0) {
      const { oid, d } = q.shift() as { oid: string; d: number };
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (depth !== undefined && d >= depth) continue; // at the boundary: not sent
      included.add(oid);
      wanted.add(oid);
      const info = parseCommit(obj.data);
      this.closureTree(repo, info.tree, wanted);
      if (depth !== undefined && d === depth - 1) {
        boundary.add(oid);
      } else {
        for (const p of info.parents) q.push({ oid: p, d: d + 1 });
      }
    }
    // Tag objects in the wants are sent too.
    for (const w of wants) {
      const obj = repo.objects.get(w);
      if (obj && obj.type === 'tag') {
        wanted.add(w);
        const c = this.peelToCommit(repo, w);
        if (c && included.has(c)) {
          // tag target already in the wanted set via the commit walk
        }
      }
    }
    // Held objects: full closure, except a shallow have holds only itself + its tree.
    const held = new Set<string>();
    const shallowSet = new Set(shallow);
    for (const h of haves) {
      const obj = repo.objects.get(h);
      if (!obj) continue;
      if (shallowSet.has(h) && obj.type === 'commit') {
        held.add(h);
        this.closureTree(repo, parseCommit(obj.data).tree, held);
      } else {
        this.closure(repo, h, held);
      }
    }
    const oids = new Set<string>();
    for (const o of wanted) if (!held.has(o)) oids.add(o);
    const shallowOut = depth !== undefined ? [...boundary].sort() : [];
    const unshallowOut = shallow.filter((s) => {
      if (depth !== undefined) {
        // No longer a boundary once it is included at a depth below the new boundary.
        return included.has(s) && !boundary.has(s);
      }
      return included.has(s);
    });
    return { oids, shallow: shallowOut, unshallow: unshallowOut };
  }

  /** Pack entry bytes for one object (header varint + deflate), cached per repo. */
  packEntry(repo: Repo, oid: string): Buffer | null {
    const cached = repo.entryCache.get(oid);
    if (cached) return cached;
    const obj = repo.objects.get(oid);
    if (!obj) return null;
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    const header: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    while (remaining > 0) {
      header.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    header.push(first);
    const entry = Buffer.concat([Buffer.from(header), deflateSync(obj.data)]);
    if (repo.entryCache.size < 100_000) repo.entryCache.set(oid, entry);
    return entry;
  }

  /** Full pack bytes for an object set, cached on the sorted oid list. */
  pack(repo: Repo, oids: Set<string>): Buffer {
    const sorted = [...oids].sort();
    const key = sorted.join(',');
    const cached = repo.packCache.get(key);
    if (cached) return cached;
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(sorted.length, 8);
    const parts: Buffer[] = [header];
    for (const oid of sorted) {
      const entry = this.packEntry(repo, oid);
      if (entry) parts.push(entry);
    }
    const body = Buffer.concat(parts);
    const trailer = createHash('sha1').update(body).digest();
    const pack = Buffer.concat([body, trailer]);
    if (repo.packCache.size < 512) repo.packCache.set(key, pack);
    return pack;
  }

  // -- issues / PRs ----------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const seq = this.nextSeq();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdAt: isoTs(seq),
      updatedAt: isoTs(seq),
      closedAt: null,
      seq,
      jsonCache: null,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
    files: PullFile[],
  ): Pull {
    const seq = this.nextSeq();
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      baseTipAtCreate: baseSha,
      files,
      createdAt: isoTs(seq),
      updatedAt: isoTs(seq),
      seq,
    };
    this.nextPullId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Diff two flat tree maps into a PR files list. */
  diffFiles(
    repo: Repo,
    baseMap: Map<string, { oid: string; mode: string }>,
    headMap: Map<string, { oid: string; mode: string }>,
  ): PullFile[] {
    const out: PullFile[] = [];
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    for (const p of [...paths].sort()) {
      const b = baseMap.get(p);
      const h = headMap.get(p);
      if (b && !h) {
        const lines = countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
        out.push({ filename: p, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (!b && h) {
        const lines = countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
        out.push({ filename: p, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b && h && b.oid !== h.oid) {
        const bl = countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
        const hl = countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
        out.push({ filename: p, status: 'modified', additions: hl, deletions: bl, changes: hl + bl });
      }
    }
    return out;
  }

  /**
   * Merge-conflict test for a squash merge: the base moved since PR creation and the
   * head's changed paths (vs the merge-base tree) intersect the base's changed paths
   * with different content.
   */
  mergeConflict(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip || baseTip === pull.baseTipAtCreate) return false;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!headTip) return false;
    if (this.isAncestor(repo, headTip, baseTip)) return false; // already merged in
    const mergeBase = this.findMergeBase(repo, pull.baseTipAtCreate, headTip);
    const baseMap0 = this.treeMap(repo, mergeBase ?? pull.baseTipAtCreate);
    const baseMap = this.treeMap(repo, baseTip);
    const headMap = this.treeMap(repo, headTip);
    const changedVs = (m0: Map<string, { oid: string }>, m1: Map<string, { oid: string }>): Map<string, string | null> => {
      const out = new Map<string, string | null>();
      for (const [p, f] of m1) if (m0.get(p)?.oid !== f.oid) out.set(p, f.oid);
      for (const p of m0.keys()) if (!m1.has(p)) out.set(p, null);
      return out;
    };
    const headChanged = changedVs(baseMap0, headMap);
    const baseChanged = changedVs(baseMap0, baseMap);
    for (const [p, hOid] of headChanged) {
      if (baseChanged.has(p) && baseChanged.get(p) !== hOid) return true;
    }
    return false;
  }

  /** First common ancestor of two commits (BFS from both, lowest depth wins). */
  findMergeBase(repo: Repo, a: string, b: string): string | null {
    const depthA = new Map<string, number>();
    const q: Array<{ oid: string; d: number }> = [{ oid: a, d: 0 }];
    while (q.length > 0) {
      const { oid, d } = q.shift() as { oid: string; d: number };
      if (depthA.has(oid)) continue;
      depthA.set(oid, d);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) q.push({ oid: p, d: d + 1 });
    }
    let best: string | null = null;
    let bestScore = Infinity;
    const q2: Array<{ oid: string; d: number }> = [{ oid: b, d: 0 }];
    const seenB = new Set<string>();
    while (q2.length > 0) {
      const { oid, d } = q2.shift() as { oid: string; d: number };
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (depthA.has(oid)) {
        const score = d + (depthA.get(oid) as number);
        if (score < bestScore) {
          bestScore = score;
          best = oid;
        }
      }
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) q2.push({ oid: p, d: d + 1 });
    }
    return best;
  }

  /** Squash-merge a PR onto its base branch. Returns the merge commit oid or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    if (this.mergeConflict(repo, pull)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return null;
    if (this.isAncestor(repo, headTip, baseTip)) {
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = baseTip;
      return baseTip;
    }
    const headMap = this.treeMap(repo, headTip);
    const seq = this.nextSeq();
    const mergeOid = this.commitOnBranch(
      repo,
      pull.baseRef,
      headMap,
      `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    );
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = isoTs(seq);
    pull.mergeCommitSha = mergeOid;
    pull.updatedAt = isoTs(seq);
    return mergeOid;
  }
}

export function globalId(kind: string, payload: string): string {
  return `${kind}_${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function decodeGlobalId(id: string): { kind: string; payload: string } | null {
  const idx = id.indexOf('_');
  if (idx <= 0) return null;
  const kind = id.slice(0, idx);
  try {
    const payload = Buffer.from(id.slice(idx + 1), 'base64url').toString('utf8');
    return { kind, payload };
  } catch {
    return null;
  }
}

/** Delta application, shared by the pack reader (clients here send plain objects, but be safe). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      out |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return out;
    }
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= delta[off] << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= delta[off] << (8 * i); off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      const chunk = base.subarray(cpOff, cpOff + cpSize);
      out.push(chunk);
      total += chunk.length;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (total !== dstSize || result.length !== dstSize) throw new Error('delta size mismatch');
  return result;
}

/** Read a pack buffer into objects; resolves OFS/REF deltas. */
export function readPack(pack: Buffer): Array<{ type: string; data: Buffer }> {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let off = 12;
  const byOffset = new Map<number, { type: string; data: Buffer }>();
  const byOid = new Map<string, { type: string; data: Buffer }>();
  const results: Array<{ type: string; data: Buffer }> = [];
  const typeNames: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let i = 0; i < count; i += 1) {
    const startOff = off;
    let b = pack[off];
    off += 1;
    const typeNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let type = typeNames[typeNum] ?? '';
    let baseObj: { type: string; data: Buffer } | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: negative offset
      let b = pack[off];
      off += 1;
      let neg = b & 0x7f;
      while (b & 0x80) {
        b = pack[off];
        off += 1;
        neg = ((neg + 1) << 7) | (b & 0x7f);
      }
      baseObj = byOffset.get(startOff - neg);
      if (!baseObj) throw new Error('ofs-delta base not found');
      type = baseObj.type;
    } else if (typeNum === 7) {
      // REF_DELTA: base oid
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      baseObj = byOid.get(baseOid);
      if (!baseObj) throw new Error('ref-delta base not found');
      type = baseObj.type;
    }
    const result = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    off += result.engine.bytesWritten;
    let data = Buffer.from(result.buffer);
    if (baseObj) data = applyDelta(baseObj.data, data);
    if (data.length !== size) throw new Error('object size mismatch in pack');
    const obj = { type, data };
    byOffset.set(startOff, obj);
    byOid.set(hashObject(type, data), obj);
    results.push(obj);
  }
  return results;
}
