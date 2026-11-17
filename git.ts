// git.ts — git smart HTTP: info/refs, git-upload-pack (v0 + v2), git-receive-pack.
// Pkt-line framing, pack building (plain objects, no deltas) and the receive-pack
// validation (fast-forward, per-ref ok/ng report) live here; the object model is in store.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, ZERO, parseCommit, parseTag, readPack, type Repo } from './store.ts';

// -- pkt-line helpers ---------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

interface PktLine {
  kind: 'line' | 'flush' | 'delim';
  text: string;
  raw: Buffer;
}

/** Parse pkt-lines from the start of a buffer; returns lines and the offset of the rest. */
export function parsePktLines(buf: Buffer, start = 0): { lines: PktLine[]; rest: number } {
  const lines: PktLine[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', off, off + 4);
    const len = Number.parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      lines.push({ kind: 'flush', text: '', raw: buf.subarray(off, off + 4) });
      off += 4;
      break;
    }
    if (len === 1) {
      lines.push({ kind: 'delim', text: '', raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (off + len > buf.length) break;
    const payload = buf.subarray(off + 4, off + len);
    lines.push({ kind: 'line', text: payload.toString('utf8'), raw: payload });
    off += len;
  }
  return { lines, rest: off };
}

/** Split sideband packets (band byte + payload) out of a byte stream. */
export function sidebandChunks(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(off + 65515, pack.length));
    off += chunk.length;
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  const body = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
  res.writeHead(404, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

const V0_UPLOAD_CAPS =
  'symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1 side-band-64k thin-pack ofs-delta multi_ack shallow';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs agent=forge/1.0 object-format=sha1';

function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const caps = service === 'upload' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=git-${service}-pack\n`), FLUSH];
  const tip = defaultTip(repo);
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (tip) lines.push(`${tip} HEAD`);
  for (const r of refs) {
    lines.push(`${r.oid} ${r.name}`);
    const obj = repo.objects.get(r.oid);
    if (obj && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const peeled = repo.objects.get(target);
      if (peeled && peeled.type === 'commit') lines.push(`${target} ${r.name}^{}`);
    }
  }
  if (lines.length === 0) {
    // Empty repo: the capabilities^{} line carries the caps.
    return Buffer.concat([...parts, pktLine(`${ZERO} capabilities^{}\0${caps}\n`), FLUSH]);
  }
  lines.forEach((line, i) => {
    parts.push(pktLine(i === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 ls-refs answer for one repo, filtered by ref-prefix args. */
function lsRefsResponse(
  repo: Repo,
  opts: { prefixes: string[]; peel: boolean; symrefs: boolean },
): Buffer {
  const parts: Buffer[] = [];
  const tip = defaultTip(repo);
  const matches = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (tip === null) {
    // Unborn: HEAD with a zero oid and its symref target (name HEAD, never a refs/ line).
    if (matches('HEAD')) {
      const suffix = opts.symrefs ? ' symref-target:refs/heads/main' : '';
      parts.push(pktLine(`${ZERO} HEAD${suffix}\n`));
    }
  } else {
    if (matches('HEAD')) {
      const suffix = opts.symrefs ? ' symref-target:refs/heads/main' : '';
      parts.push(pktLine(`${tip} HEAD${suffix}\n`));
    }
    for (const r of sortedRefs(repo)) {
      if (!matches(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      const obj = repo.objects.get(r.oid);
      if (opts.peel && obj && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        if (repo.objects.get(target)?.type === 'commit') line += ` peeled:${target}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

const V2_CAPS = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done filter\n'),
  pktLine('server-option\n'),
  pktLine('agent=forge/1.0\n'),
  pktLine('object-format=sha1\n'),
  FLUSH,
]);

/** Parse a v2 fetch request body into its arguments. */
function parseV2Fetch(body: Buffer): {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
} {
  const { lines } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const l of lines) {
    if (l.kind !== 'line') continue;
    const t = l.text;
    if (t.startsWith('want ')) wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) {
      const n = Number.parseInt(t.slice(7).trim(), 10);
      if (!Number.isNaN(n)) depth = n;
    }
  }
  return { wants, haves, shallow, depth };
}

function fetchResponse(store: Store, repo: Repo, req: { wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined }, v2: boolean): Buffer {
  const { oids, shallow, unshallow } = store.fetchSet(repo, req.wants, req.haves, req.shallow, req.depth);
  const pack = store.pack(repo, oids);
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM);
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(DELIM);
    }
    parts.push(pktLine('packfile\n'));
  } else {
    parts.push(pktLine('NAK\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  }
  parts.push(...sidebandChunks(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse a v0 fetch request: wants section, then haves section. */
function parseV0Fetch(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0; // 0 = wants, 1 = haves
  let off = 0;
  while (off + 4 <= body.length) {
    const len = Number.parseInt(body.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len) || len === 0) {
      section += 1;
      off += 4;
      continue;
    }
    const text = body.toString('utf8', off + 4, off + len);
    off += len;
    const first = text.split(' ')[0];
    if (section === 0) {
      if (first.startsWith('want')) wants.push(text.slice(5, 45));
      else if (first === 'shallow') shallow.push(text.slice(8, 48).trim());
      else if (first === 'deepen') {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (!Number.isNaN(n)) depth = n;
      }
    } else if (first === 'have') {
      haves.push(text.slice(5, 45));
    }
  }
  return { wants, haves, shallow, depth };
}

export interface GitHandler {
  (store: Store, req: IncomingMessage, res: ServerResponse, owner: string, name: string, kind: string, body: Buffer): void;
}

export const handleGit: GitHandler = (store, req, res, owner, name, kind, body) => {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res);
    return;
  }
  const url = req.url ?? '';
  const query = url.split('?')[1] ?? '';

  if (kind === 'info/refs') {
    const service = new URLSearchParams(query).get('service') ?? '';
    if (service === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        send(res, 200, 'application/x-git-upload-pack-advertisement', V2_CAPS);
      } else {
        send(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'upload'));
      }
      return;
    }
    if (service === 'git-receive-pack') {
      send(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'receive'));
      return;
    }
    const b = Buffer.from(JSON.stringify({ message: 'unknown service' }), 'utf8');
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': b.length });
    res.end(b);
    return;
  }

  if (kind === 'git-upload-pack') {
    if ((req.headers['git-protocol'] ?? '') === 'version=2') {
      const { lines } = parsePktLines(body);
      const first = lines.find((l) => l.kind === 'line')?.text ?? '';
      if (first.startsWith('command=ls-refs')) {
        const prefixes: string[] = [];
        let peel = false;
        let symrefs = false;
        for (const l of lines) {
          if (l.kind !== 'line') continue;
          const t = l.text.trim();
          if (t.startsWith('ref-prefix ')) prefixes.push(t.slice(11).trim());
          else if (t === 'peel') peel = true;
          else if (t === 'symrefs') symrefs = true;
        }
        send(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, { prefixes, peel, symrefs }));
        return;
      }
      if (first.startsWith('command=fetch')) {
        const parsed = parseV2Fetch(body);
        send(res, 200, 'application/x-git-upload-pack-result', fetchResponse(store, repo, parsed, true));
        return;
      }
      const b = Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8');
      res.writeHead(400, { 'content-type': 'application/json', 'content-length': b.length });
      res.end(b);
      return;
    }
    // v0 fetch
    const parsed = parseV0Fetch(body);
    send(res, 200, 'application/x-git-upload-pack-result', fetchResponse(store, repo, parsed, false));
    return;
  }

  if (kind === 'git-receive-pack') {
    handleReceivePack(store, repo, res, body);
    return;
  }

  notFound(res);
};

interface ReceiveCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, res: ServerResponse, body: Buffer): void {
  const { lines, rest } = parsePktLines(body);
  const commands: ReceiveCommand[] = [];
  for (const l of lines) {
    if (l.kind !== 'line') continue;
    const text = l.text.split('\0')[0];
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text.trim());
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const packBytes = body.subarray(rest);
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const o of objects) store.storeObject(repo, o.type, o.data);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const report: string[] = [];
  if (unpackOk) report.push('unpack ok\n');
  else report.push(`unpack error ${unpackError}\n`);
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    const isTag = cmd.ref.startsWith('refs/tags/');
    if (cmd.newOid === ZERO) {
      // delete
      if (!current) report.push(`ng ${cmd.ref} ref does not exist\n`);
      else if (cmd.oldOid !== current) report.push(`ng ${cmd.ref} non-fast-forward\n`);
      else {
        repo.refs.delete(cmd.ref);
        repo.version += 1;
        report.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (!newObj) {
      report.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (cmd.oldOid === ZERO) {
      // create
      if (current) report.push(`ng ${cmd.ref} already exists\n`);
      else {
        repo.refs.set(cmd.ref, cmd.newOid);
        repo.version += 1;
        report.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    // update
    if (!current || cmd.oldOid !== current) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    if (!isTag) {
      const newCommit = store.peelToCommit(repo, cmd.newOid);
      if (!newCommit || !store.isAncestor(repo, cmd.oldOid, newCommit)) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    repo.version += 1;
    report.push(`ok ${cmd.ref}\n`);
  }
  const reportText = Buffer.concat(report.map((r) => pktLine(r)));
  const parts: Buffer[] = [...sidebandChunks(reportText), FLUSH];
  send(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}

export { parseCommit };
