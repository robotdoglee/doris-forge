// MCP (Model Context Protocol) over streamable HTTP: the modern, handshake-free era —
// `server/discover` answers identity, capabilities and supported revisions up front, and every
// later request is a self-contained JSON-RPC call. The legacy `initialize` handshake is answered
// too, for clients that negotiate down. Six tools mirror github-mcp-server's surface and act on
// the same store as REST/GraphQL/git, returning the REST JSON shapes so every surface agrees.
//
// Protocol discipline the suite checks: unknown tools and missing arguments are JSON-RPC -32602
// (never HTTP 500), a non-JSON body is HTTP 400 with -32700, an unauthenticated call is HTTP 401,
// and tools/list is a fixed list, byte-identical across calls.

import { Forge, Repo, buildCommit, type IssueRec, type PullRec } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Req, Res } from './http.ts';

const SERVER_INFO = { name: 'doris-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

const TOOLS: readonly Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner login.'), repo: stringProp('The repository name.') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch to merge from.'),
        base: stringProp('The base branch to merge into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request (squash), marking it merged.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type Json = Record<string, unknown>;

function toolResult(value: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The repository an owner/repo argument pair names, or a tool error. */
function resolve(forge: Forge, args: Json): { repo: Repo; owner: string } | { error: Json } {
  const owner = str(args.owner);
  const repo = forge.resolveRepo(owner, str(args.repo));
  if (repo === null) return { error: toolError(`repository ${owner}/${str(args.repo)} not found`) };
  return { repo, owner };
}

function callTool(forge: Forge, name: string, args: Json): { result?: Json; error?: { code: number; message: string } } {
  const missing = (fields: string[]): { error: { code: number; message: string } } => ({
    error: { code: INVALID_PARAMS, message: `missing required argument(s): ${fields.join(', ')}` },
  });
  const absent = (fields: readonly string[]): string[] => fields.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');

  switch (name) {
    case 'create_repo': {
      const miss = absent(['name']);
      if (miss.length > 0) return missing(miss);
      const repoName = str(args.name);
      const repo = forge.repos.get(repoName) ?? forge.createRepo(repoName, str(args.description), args.private === true);
      if (repo === null) return { result: toolError(`repository ${repoName} could not be created`) };
      return { result: toolResult(repoJson(forge, repo, forge.viewerLogin ?? 'viewer')) };
    }
    case 'get_repo': {
      const miss = absent(['owner', 'repo']);
      if (miss.length > 0) return missing(miss);
      const resolved = resolve(forge, args);
      if ('error' in resolved) return { result: resolved.error };
      return { result: toolResult(repoJson(forge, resolved.repo, resolved.owner)) };
    }
    case 'create_issue': {
      const miss = absent(['owner', 'repo', 'title']);
      if (miss.length > 0) return missing(miss);
      const resolved = resolve(forge, args);
      if ('error' in resolved) return { result: resolved.error };
      const issue: IssueRec = {
        number: resolved.repo.nextNumber,
        title: str(args.title),
        body: str(args.body),
        state: 'open',
        labels: [],
        seq: forge.nextSeq(),
      };
      resolved.repo.nextNumber += 1;
      resolved.repo.issues.set(issue.number, issue);
      return { result: toolResult(issueJson(forge, issue)) };
    }
    case 'list_issues': {
      const miss = absent(['owner', 'repo']);
      if (miss.length > 0) return missing(miss);
      const resolved = resolve(forge, args);
      if ('error' in resolved) return { result: resolved.error };
      const state = str(args.state) || 'open';
      let list = [...resolved.repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return { result: toolResult(list.map((issue) => issueJson(forge, issue))) };
    }
    case 'create_pull_request': {
      const miss = absent(['owner', 'repo', 'title', 'head', 'base']);
      if (miss.length > 0) return missing(miss);
      const resolved = resolve(forge, args);
      if ('error' in resolved) return { result: resolved.error };
      const repo = resolved.repo;
      const head = str(args.head);
      const base = str(args.base);
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing !== undefined) return { result: toolResult(pullJson(forge, repo, existing)) };
      const pull: PullRec = {
        number: repo.nextNumber,
        title: str(args.title),
        body: str(args.body),
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: forge.nextSeq(),
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return { result: toolResult(pullJson(forge, repo, pull)) };
    }
    case 'merge_pull_request': {
      const miss = absent(['owner', 'repo', 'pull_number']);
      if (miss.length > 0) return missing(miss);
      const resolved = resolve(forge, args);
      if ('error' in resolved) return { result: resolved.error };
      const repo = resolved.repo;
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { result: toolError(`pull request #${String(args.pull_number)} not found`) };
      if (pull.merged) return { result: toolResult(pullJson(forge, repo, pull)) };
      if (pull.state !== 'open') return { result: toolError(`pull request #${pull.number} is not open`) };
      const baseTip = repo.branchTip(pull.baseRef);
      const headTip = repo.branchTip(pull.headRef);
      if (baseTip === null || headTip === null) return { result: toolError('the pull request branches are missing') };
      const base = repo.mergeBase(baseTip, headTip);
      if (base === null) return { result: toolError('the pull request has no merge base') };
      const baseInfo = repo.commitInfo(base);
      const headInfo = repo.commitInfo(headTip);
      const currentInfo = repo.commitInfo(baseTip);
      if (baseInfo === null || headInfo === null || currentInfo === null) return { result: toolError('the pull request history is incomplete') };
      const merged = repo.mergeTrees(baseInfo.tree, headInfo.tree, currentInfo.tree);
      if ('conflict' in merged) return { result: toolError(`merge conflict in ${merged.conflict}`) };
      const mergeSha = repo.putObject(
        'commit',
        buildCommit({ tree: merged.treeSha, parents: [baseTip], author: forge.authorLine(), committer: forge.authorLine(), message: `${pull.title} (#${pull.number})` }),
      );
      repo.setRef(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = forge.nowIso();
      pull.mergeCommitSha = mergeSha;
      return { result: toolResult(pullJson(forge, repo, pull)) };
    }
    default:
      return { error: { code: INVALID_PARAMS, message: `unknown tool: ${name}` } };
  }
}

function discoverResult(): Json {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: { ...SERVER_INFO },
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
  };
}

export async function handleMcp(forge: Forge, req: Req, res: Res): Promise<void> {
  if (!req.authed) {
    res.json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'authentication required' } });
    return;
  }
  if (req.method === 'DELETE') {
    res.empty(204);
    return;
  }
  if (req.method !== 'POST') {
    res.json(405, { jsonrpc: '2.0', id: null, error: { code: METHOD_NOT_FOUND, message: 'MCP accepts POST' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    res.json(400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    res.json(400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  const message = parsed as { id?: unknown; method?: unknown; params?: unknown };
  // A message without an id is a notification: acknowledge it and move on.
  if (message.id === undefined) {
    res.empty(202);
    return;
  }
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Json;
  const reply = (result: unknown): void => {
    res.json(200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, text: string): void => {
    res.json(200, { jsonrpc: '2.0', id, error: { code, message: text } });
  };

  switch (method) {
    case 'server/discover':
      reply(discoverResult());
      return;
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      reply({ protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
      return;
    }
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: TOOLS });
      return;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Json;
      const outcome = callTool(forge, toolName, args);
      if (outcome.error !== undefined) {
        replyError(outcome.error.code, outcome.error.message);
        return;
      }
      reply(outcome.result ?? {});
      return;
    }
    default:
      replyError(METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}
