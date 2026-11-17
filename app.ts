// app.ts — the forge's HTTP server: one process serving git smart HTTP, REST v3,
// GraphQL v4 and MCP from a single in-memory Store. Auth is a bearer token taken
// from MAKEFUN_SHOP_TOKEN (any non-empty bearer is accepted when it is unset,
// which only happens in local development).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { executeOperation } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${process.pid}-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenValid(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = auth.slice('Bearer '.length);
  if (presented === '') return false;
  if (expected === '') return true; // local development fallback
  return presented === expected;
}

export function createApp(): Server {
  const store = new Store();

  const server = createServer((req, res) => {
    void (async () => {
      const rid = requestId();
      res.setHeader('x-github-request-id', rid);
      try {
        const rawUrl = req.url ?? '/';
        const qIndex = rawUrl.indexOf('?');
        const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
        const queryString = qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
        const method = req.method ?? 'GET';

        // Boot probe: no token.
        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!tokenValid(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }

        // GET requests carry no body in this suite; skip the body read.
        const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);

        // MCP over Streamable HTTP.
        if (pathname === '/mcp' && method === 'POST') {
          const out = handleMcp(store, body.toString('utf8'));
          if (out.status === 202) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, out.status, out.body);
          return;
        }

        // GraphQL v4 (single operation or a batch array).
        if (pathname === '/api/graphql' && method === 'POST') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Request body is not valid JSON' });
            return;
          }
          if (Array.isArray(parsed)) {
            sendJson(res, 200, parsed.map((op) => executeOperation(store, op as Record<string, unknown>)));
          } else if (parsed !== null && typeof parsed === 'object') {
            sendJson(res, 200, executeOperation(store, parsed as Record<string, unknown>));
          } else {
            sendJson(res, 400, { message: 'Request body must be a JSON object or array' });
          }
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const parts = pathname.split('/').filter((s) => s !== '');
          const segments = parts.slice(2);
          let parsedBody: unknown = null;
          if (body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
            try {
              parsedBody = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Request body is not valid JSON' });
              return;
            }
          }
          handleRest({ store, req, res, segments, query: new URLSearchParams(queryString), body: parsedBody, bodyText: body.toString('utf8') });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const name = decodeURIComponent(gitMatch[2]);
          const kind = gitMatch[3];
          handleGit(store, req, res, owner, name, kind, body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });

  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
