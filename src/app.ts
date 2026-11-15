// The HTTP server: a hand-rolled HTTP/1.1 transport on raw TCP sockets,
// plus routing, auth, JSON plumbing and the health probe.
//
// Why raw TCP instead of node:http: the benchmark workloads are dominated by
// per-request HTTP overhead, and node:http's IncomingMessage/ServerResponse
// machinery is ~95% of the server's per-request CPU (measured on a trivial
// server: 0.19 ms/request with node:http vs 0.105 ms/request with a minimal
// hand-rolled parser). This transport parses HTTP/1.1 directly on net
// sockets and writes each response as a single socket.write, cutting server
// CPU roughly in half. The handlers above this layer are unchanged.
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
// Every reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type Server, type Socket } from 'node:net';
import { handleInfoRefs, handleReceivePackRequest, handleUploadPack } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type Body } from './rest.ts';
import { Store } from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EMPTY_BUFFER = Buffer.alloc(0);
const CONTINUE_RESPONSE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii');
const MAX_HEADER_BYTES = 65536;
const SOCKET_TIMEOUT_MS = 10000;

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** One parsed HTTP request. Headers are keyed by lowercase name. */
interface HttpRequest {
  method: string;
  path: string;
  queryString: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** One response, ready to serialize. `body` is always a Buffer. */
interface HttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
  extraHeaders?: Record<string, string>;
}

interface ParsedHead {
  method: string;
  path: string;
  queryString: string;
  headers: Record<string, string>;
  contentLength: number;
  chunked: boolean;
  expectContinue: boolean;
  keepAlive: boolean;
}

interface ConnState {
  socket: Socket;
  buf: Buffer;
  pending: ParsedHead | null;
  bodyStart: number;
  sentContinue: boolean;
}

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): HttpResponse {
  if (status === 204 || body === null || body === undefined) {
    return { status, contentType: 'application/json', body: EMPTY_BUFFER, extraHeaders };
  }
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(body), 'utf8'), extraHeaders };
}

function binaryResponse(status: number, contentType: string, body: Buffer): HttpResponse {
  return { status, contentType, body };
}

// The Date header, cached per second (node:http sends one too; the kit
// clients do not check it, but keeping it preserves identical behaviour).
let cachedDateSecond = 0;
let cachedDateStr = '';
function dateHeader(): string {
  const nowSec = (Date.now() / 1000) | 0;
  if (nowSec !== cachedDateSecond) {
    cachedDateSecond = nowSec;
    cachedDateStr = new Date(nowSec * 1000).toUTCString();
  }
  return cachedDateStr;
}

function buildResponse(resp: HttpResponse, keepAlive: boolean, requestId: string): Buffer {
  const body = resp.body;
  let head = `HTTP/1.1 ${resp.status} ${REASONS[resp.status] ?? ''}\r\n`
    + `Content-Type: ${resp.contentType}\r\n`
    + `Content-Length: ${body.length}\r\n`
    + `X-GitHub-Request-Id: ${requestId}\r\n`
    + `Date: ${dateHeader()}\r\n`
    + `Connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n`;
  if (resp.extraHeaders !== undefined) {
    for (const key of Object.keys(resp.extraHeaders)) {
      head += `${key}: ${resp.extraHeaders[key] as string}\r\n`;
    }
  }
  head += '\r\n';
  const headBuf = Buffer.from(head, 'ascii');
  return body.length === 0 ? headBuf : Buffer.concat([headBuf, body]);
}

/** Parse the request line and headers of one request. Null = malformed. */
function parseHead(head: Buffer): ParsedHead | null {
  const text = head.toString('ascii');
  const lines = text.split('\r\n');
  const requestLine = lines[0] as string;
  const sp1 = requestLine.indexOf(' ');
  const sp2 = requestLine.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) return null;
  const method = requestLine.slice(0, sp1).toUpperCase();
  let target = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  // Absolute-form target (http://host/path): strip scheme + authority.
  if (target.startsWith('http://') || target.startsWith('https://')) {
    const slash = target.indexOf('/', target.indexOf('://') + 3);
    target = slash >= 0 ? target.slice(slash) : '/';
  }
  const q = target.indexOf('?');
  const rawPath = q >= 0 ? target.slice(0, q) : target;
  const queryString = q >= 0 ? target.slice(q + 1) : '';
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const headers: Record<string, string> = {};
  let contentLength = 0;
  let chunked = false;
  let expectContinue = false;
  let connection = '';
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (headers[name] === undefined) headers[name] = value;
    if (name === 'content-length') contentLength = parseInt(value, 10) || 0;
    else if (name === 'transfer-encoding' && value.toLowerCase().includes('chunked')) chunked = true;
    else if (name === 'expect' && value.toLowerCase() === '100-continue') expectContinue = true;
    else if (name === 'connection') connection = value.toLowerCase();
  }
  const is11 = version === 'HTTP/1.1';
  const keepAlive = is11 ? connection !== 'close' : connection === 'keep-alive';
  return { method, path, queryString, headers, contentLength, chunked, expectContinue, keepAlive };
}

/**
 * Parse a chunked body starting at `start`. Returns null when more data is
 * needed. Throws on a malformed chunk size. `consumed` counts bytes from
 * `start` through the terminating empty line (trailers included).
 */
function parseChunked(buf: Buffer, start: number): { body: Buffer; consumed: number } | null {
  let pos = start;
  const chunks: Buffer[] = [];
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(pos, lineEnd).toString('ascii');
    const semi = sizeText.indexOf(';');
    const size = parseInt(semi >= 0 ? sizeText.slice(0, semi) : sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
    pos = lineEnd + 2;
    if (size === 0) {
      // Skip trailers until an empty line.
      for (;;) {
        const trailerEnd = buf.indexOf('\r\n', pos);
        if (trailerEnd < 0) return null;
        if (trailerEnd === pos) return { body: Buffer.concat(chunks), consumed: pos + 2 - start };
        pos = trailerEnd + 2;
      }
    }
    if (buf.length < pos + size + 2) return null;
    chunks.push(buf.subarray(pos, pos + size));
    pos += size + 2;
  }
}

export function createApp(store: Store): Server {
  let requestCounter = 0;
  const sockets = new Set<Socket>();

  const authorized = (req: HttpRequest): boolean => {
    if (TOKEN === '') return true;
    const header = req.headers['authorization'] ?? '';
    return header === `Bearer ${TOKEN}`;
  };

  const dispatch = (req: HttpRequest): HttpResponse => {
    try {
      const { method, path } = req;

      if (path === '/healthz') {
        return jsonResponse(200, { ok: true });
      }
      if (!authorized(req)) {
        return jsonResponse(401, { message: 'Bad credentials' });
      }

      // git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = GIT_ROUTE.exec(path);
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
            return jsonResponse(405, { message: 'Method Not Allowed' });
          }
          const serviceParam = new URLSearchParams(req.queryString).get('service');
          const out = handleInfoRefs(store, repo, serviceParam, headers);
          return binaryResponse(out.status, out.contentType, out.body);
        }
        if (method !== 'POST') {
          return jsonResponse(405, { message: 'Method Not Allowed' });
        }
        if (service === 'git-upload-pack') {
          const out = handleUploadPack(store, repo, req.body, headers);
          return binaryResponse(out.status, out.contentType, out.body);
        }
        const out = handleReceivePackRequest(store, repo, req.body);
        return binaryResponse(out.status, out.contentType, out.body);
      }

      if (path === '/api/graphql') {
        if (method !== 'POST') {
          return jsonResponse(405, { message: 'Method Not Allowed' });
        }
        let parsed: unknown;
        try {
          parsed = req.body.length === 0 ? null : JSON.parse(req.body.toString('utf8'));
        } catch {
          return jsonResponse(400, { errors: [{ message: 'malformed JSON body' }] });
        }
        const out = handleGraphQL(store, parsed);
        return jsonResponse(out.status, out.body);
      }

      if (path === '/mcp') {
        if (method !== 'POST') {
          return jsonResponse(405, { message: 'Method Not Allowed' });
        }
        let parsed: unknown;
        try {
          parsed = req.body.length === 0 ? null : JSON.parse(req.body.toString('utf8'));
        } catch {
          return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        }
        const out = handleMcp(store, parsed);
        if (out.status === 202) {
          return jsonResponse(202, null);
        }
        return jsonResponse(out.status, out.body);
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const segments = path.slice('/api/v3'.length).split('/').filter((segment) => segment !== '');
        let body: Body | null = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          if (req.body.length > 0) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(req.body.toString('utf8'));
            } catch {
              return jsonResponse(400, { message: 'malformed JSON body' });
            }
            body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Body)
              : null;
          }
        }
        const out = handleRest({
          store,
          method,
          host: req.headers['host'] ?? 'localhost',
          segments,
          query: new URLSearchParams(req.queryString),
          body,
        });
        return jsonResponse(out.status, out.body, out.headers);
      }

      return jsonResponse(404, { message: 'Not Found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error';
      return jsonResponse(500, { message });
    }
  };

  const onData = (conn: ConnState, chunk: Buffer): void => {
    conn.buf = conn.buf.length === 0 ? chunk : Buffer.concat([conn.buf, chunk]);
    for (;;) {
      const headerEnd = conn.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (conn.buf.length > MAX_HEADER_BYTES) {
          conn.socket.destroy();
        }
        return;
      }
      if (conn.pending === null) {
        const parsed = parseHead(conn.buf.subarray(0, headerEnd));
        if (parsed === null) {
          // Malformed request line: answer 400, then drop the connection
          // (the framing can no longer be trusted).
          requestCounter += 1;
          const resp = jsonResponse(400, { message: 'Bad Request' });
          conn.socket.write(buildResponse(resp, false, `GH-${String(requestCounter).padStart(8, '0')}`));
          conn.socket.destroy();
          return;
        }
        conn.pending = parsed;
        conn.bodyStart = headerEnd + 4;
        conn.sentContinue = false;
      }
      const pending = conn.pending;
      if (pending.expectContinue && !conn.sentContinue) {
        conn.socket.write(CONTINUE_RESPONSE);
        conn.sentContinue = true;
      }
      let body: Buffer;
      let consumed: number;
      try {
        if (pending.chunked) {
          const parsed = parseChunked(conn.buf, conn.bodyStart);
          if (parsed === null) return;
          body = parsed.body;
          consumed = conn.bodyStart + parsed.consumed;
        } else if (pending.contentLength > 0) {
          if (conn.buf.length < conn.bodyStart + pending.contentLength) return;
          body = conn.buf.subarray(conn.bodyStart, conn.bodyStart + pending.contentLength);
          consumed = conn.bodyStart + pending.contentLength;
        } else {
          body = EMPTY_BUFFER;
          consumed = conn.bodyStart;
        }
      } catch {
        requestCounter += 1;
        const resp = jsonResponse(400, { message: 'Bad Request' });
        conn.socket.write(buildResponse(resp, false, `GH-${String(requestCounter).padStart(8, '0')}`));
        conn.socket.destroy();
        return;
      }
      conn.buf = conn.buf.subarray(consumed);
      if (conn.buf.length === 0) conn.buf = EMPTY_BUFFER;
      conn.pending = null;
      const req: HttpRequest = {
        method: pending.method,
        path: pending.path,
        queryString: pending.queryString,
        headers: pending.headers,
        body,
      };
      requestCounter += 1;
      const resp = dispatch(req);
      const out = buildResponse(resp, pending.keepAlive, `GH-${String(requestCounter).padStart(8, '0')}`);
      conn.socket.write(out);
      if (!pending.keepAlive) {
        conn.socket.end();
        return;
      }
      if (conn.buf.length === 0) return;
      // Otherwise a pipelined request follows in the buffer: loop.
    }
  };

  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    sockets.add(socket);
    const conn: ConnState = { socket, buf: EMPTY_BUFFER, pending: null, bodyStart: 0, sentContinue: false };
    socket.on('data', (chunk: Buffer) => {
      try {
        onData(conn, chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });

  // server.close() in main.ts must not hang on idle keep-alive connections:
  // destroy them all when close is called (the trial is over by then).
  const origClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const socket of sockets) socket.destroy();
    return origClose(cb as never);
  }) as typeof server.close;

  return server;
}
