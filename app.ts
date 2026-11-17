// The forge's HTTP server: one process answering the four surfaces the suite drives — git smart
// HTTP, REST v3, GraphQL v4 and MCP — over one shared in-memory store.
//
// Routing is by path shape:
//   GET  /healthz                 the env's boot probe (no auth)
//   *    /api/v3/...              REST (rest.ts)
//   POST /api/graphql             GraphQL (graphql.ts)
//   POST /mcp                     MCP (mcp.ts)
//   *    /<owner>/<repo>.git/...  git smart HTTP (gitp.ts)
//   anything else                 404 {"message":"Not Found"}
//
// Every request is answered; a handler failure becomes a 500 JSON body, never a hung socket.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { decodeSegment, makeRes, readBody, type Req } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const NOT_FOUND = { message: 'Not Found' };

async function dispatch(forge: Forge, nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const requestId = forge.nextRequestId();
  const res = makeRes(nodeRes, requestId);
  try {
    const url = new URL(nodeReq.url ?? '/', 'http://entry');
    const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
    const body = await readBody(nodeReq);
    const token = process.env.MAKEFUN_SHOP_TOKEN;
    const authorization = nodeReq.headers.authorization ?? '';
    const req: Req = {
      method: (nodeReq.method ?? 'GET').toUpperCase(),
      segments,
      rawPath: url.pathname,
      query: url.searchParams,
      headers: nodeReq.headers,
      host: nodeReq.headers.host ?? 'localhost',
      body,
      authed: token === undefined || token === '' || authorization === `Bearer ${token}`,
      requestId,
    };

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.json(200, { ok: true });
      return;
    }
    if (segments[0] === 'api' && segments[1] === 'v3') {
      await handleRest(forge, req, res);
      return;
    }
    if (url.pathname === '/api/graphql') {
      await handleGraphql(forge, req, res);
      return;
    }
    if (url.pathname === '/mcp') {
      await handleMcp(forge, req, res);
      return;
    }
    if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).slice(0, -'.git'.length);
      await handleGit(forge, req, res, owner, repoName, segments.slice(2));
      return;
    }
    res.json(404, NOT_FOUND);
  } catch (err) {
    if (!nodeRes.headersSent) {
      res.json(500, { message: err instanceof Error ? err.message : 'Internal error' });
    } else if (!nodeRes.writableEnded) {
      nodeRes.end();
    }
  }
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((nodeReq, nodeRes) => {
    void dispatch(forge, nodeReq, nodeRes);
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}
