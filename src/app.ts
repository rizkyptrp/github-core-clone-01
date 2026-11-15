// The HTTP server: routing, auth, JSON plumbing and the health probe.
//
// Routes:
//   GET  /healthz                        -> 200 {"ok":true} (no auth)
//   GET  /{owner}/{repo}.git/info/refs   -> smart-HTTP advertisements
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//   /api/v3/...                          -> REST v3
//   POST /api/graphql                    -> GraphQL v4
//   POST /mcp                            -> MCP (JSON-RPC 2.0)
//
// Auth: `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` on everything except
// /healthz. When the token is empty (local testing), auth is not enforced.
// Every REST reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePackRequest, handleUploadPack } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type Body } from './rest.ts';
import { Store } from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function createApp(store: Store): Server {
  let requestCounter = 0;

  const sendJson = (res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
    requestCounter += 1;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-GitHub-Request-Id': `GH-${String(requestCounter).padStart(8, '0')}`,
      ...extraHeaders,
    };
    if (status === 204 || body === null || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    headers['Content-Length'] = String(Buffer.byteLength(payload));
    res.writeHead(status, headers);
    res.end(payload);
  };

  const sendBinary = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    requestCounter += 1;
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      'X-GitHub-Request-Id': `GH-${String(requestCounter).padStart(8, '0')}`,
    });
    res.end(body);
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const authorized = (req: IncomingMessage): boolean => {
    if (TOKEN === '') return true;
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${TOKEN}`;
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const path = decodeURIComponent(url.pathname);
        const method = (req.method ?? 'GET').toUpperCase();

        if (path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = gitMatch[1] as string;
          const repoName = gitMatch[2] as string;
          const service = gitMatch[3] as string;
          const repo = owner === store.viewer.login ? store.getRepo(owner, repoName) : undefined;
          const headers: Record<string, string | undefined> = {
            'git-protocol': req.headers['git-protocol'],
          };
          if (service === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            const out = handleInfoRefs(store, repo, url.searchParams.get('service'), headers);
            sendBinary(res, out.status, out.contentType, out.body);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          if (service === 'git-upload-pack') {
            const out = handleUploadPack(store, repo, body, headers);
            sendBinary(res, out.status, out.contentType, out.body);
            return;
          }
          const out = handleReceivePackRequest(store, repo, body);
          sendBinary(res, out.status, out.contentType, out.body);
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'malformed JSON body' }] });
            return;
          }
          const out = handleGraphQL(store, parsed);
          sendJson(res, out.status, out.body);
          return;
        }

        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const out = handleMcp(store, parsed);
          if (out.status === 202) {
            sendJson(res, 202, null);
            return;
          }
          sendJson(res, out.status, out.body);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path.slice('/api/v3'.length).split('/').filter((segment) => segment !== '');
          let body: Body | null = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'malformed JSON body' });
                return;
              }
              body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Body)
                : null;
            }
          }
          const out = handleRest({ store, req, segments, query: url.searchParams, body });
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'internal error';
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message });
          } catch {
            res.destroy();
          }
        } else {
          res.destroy();
        }
      }
    })();
  });

  return server;
}
