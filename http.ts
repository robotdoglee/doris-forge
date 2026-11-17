// Minimal HTTP plumbing shared by the surface modules: a parsed request, and reply helpers that
// always stamp the X-GitHub-Request-Id header the protocol checks require on every response.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Req {
  method: string;
  /** The decoded path segments, e.g. ['api', 'v3', 'repos', 'o', 'r', 'issues']. */
  segments: string[];
  /** The raw (still encoded) pathname, no query string. */
  rawPath: string;
  query: URLSearchParams;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The request's Host header, for building absolute pagination links on this origin. */
  host: string;
  body: Buffer;
  /** Whether the request carried the trial's bearer token. */
  authed: boolean;
  requestId: string;
}

export interface Res {
  json(status: number, body: unknown, headers?: Readonly<Record<string, string>>): void;
  raw(status: number, body: Buffer, contentType: string, headers?: Readonly<Record<string, string>>): void;
  empty(status: number): void;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

export function makeRes(nodeRes: ServerResponse, requestId: string): Res {
  const stamp = (headers: Readonly<Record<string, string>>): Record<string, string> => ({
    'x-github-request-id': requestId,
    ...headers,
  });
  return {
    json(status, body, headers = {}) {
      const text = `${JSON.stringify(body)}\n`;
      nodeRes.writeHead(status, stamp({ 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers }));
      nodeRes.end(text);
    },
    raw(status, body, contentType, headers = {}) {
      nodeRes.writeHead(status, stamp({ 'content-type': contentType, 'content-length': body.length, ...headers }));
      nodeRes.end(body);
    },
    empty(status) {
      nodeRes.writeHead(status, stamp({ 'content-length': 0 }));
      nodeRes.end();
    },
  };
}

/** Read a whole request body (bounded; git packs are the only large bodies in the trial). */
export function readBody(req: IncomingMessage, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** Decode one path segment; a malformed escape is kept verbatim rather than throwing. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parse a JSON request body; returns undefined for an empty body, throws on malformed JSON. */
export function parseJsonBody(body: Buffer): Record<string, unknown> | undefined {
  if (body.length === 0) return undefined;
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}
