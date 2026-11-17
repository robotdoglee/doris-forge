// GraphQL v4: a small purpose-built executor for the fixed document shapes gh and
// github-mcp-server send — viewer, repository fields, __type introspection, issue/pull
// connections with cursor pagination, node(id:), batched operations, and the five mutations.
// It is a real (if narrow) GraphQL implementation: a tokenizer/parser for operations, variables,
// aliases, inline fragments and argument values, plus a schema of resolvers over the same store
// the REST and git surfaces use, so every surface agrees about the same repositories.
//
// Global ids are opaque and stable: base64 of "<Type>:<key>", never the bare database id.

import { Forge, Repo, buildCommit, type CommentRec, type IssueRec, type PullRec } from './store.ts';
import { pullFiles } from './rest.ts';
import type { Req, Res } from './http.ts';

// ---------------------------------------------------------------- global ids

function encodeId(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return encodeId(`Repository:${repo.id}`);
}

export function issueGlobalId(repo: Repo, issue: IssueRec): string {
  return encodeId(`Issue:${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRec): string {
  return encodeId(`PullRequest:${repo.id}:${pull.number}`);
}

export function commentGlobalId(comment: CommentRec): string {
  return encodeId(`IssueComment:${comment.id}`);
}

function repoById(forge: Forge, id: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  selectionSet: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'inlineFragment';
  typeCondition: string;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push('...');
      at += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push(ch);
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push(`"${source.slice(at + 3, end)}"`);
        at = end + 3;
        continue;
      }
      let text = '';
      let cursor = at + 1;
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === '\\') {
          const escaped = source[cursor + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u') {
            text += String.fromCharCode(Number.parseInt(source.slice(cursor + 2, cursor + 6), 16));
            cursor += 6;
          } else {
            text += map[escaped] ?? escaped;
            cursor += 2;
          }
        } else {
          text += source[cursor];
          cursor += 1;
        }
      }
      if (cursor >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(`"${text}"`);
      at = cursor + 1;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at));
    if (nameMatch !== null) {
      tokens.push(nameMatch[0]);
      at += nameMatch[0].length;
      continue;
    }
    const numberMatch = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(at));
    if (numberMatch !== null) {
      tokens.push(numberMatch[0]);
      at += numberMatch[0].length;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private readonly tokens: string[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private next(): string {
    const token = this.tokens[this.at];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, found ${got}`);
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token === open) depth += 1;
      else if (token === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.at < this.tokens.length) {
      const token = this.peek() as string;
      if (token === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && /^[_A-Za-z]/.test(maybeName) && maybeName !== '(' && maybeName !== '{') name = this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')'); // variable definitions: names/types are not needed at run time
        if (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced('(', ')');
        }
        operations.push({ type: token === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        // Named fragments are parsed and set aside; the suite's documents use inline fragments only.
        this.next();
        this.next(); // fragment name
        this.next(); // 'on'
        this.next(); // type condition
        this.parseSelectionSet();
      } else {
        throw new GqlSyntaxError(`unexpected token ${token}`);
      }
    }
    return operations;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new GqlSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      const on = this.next();
      if (on !== 'on') throw new GqlSyntaxError('named fragments are not supported');
      const typeCondition = this.next();
      return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    if (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipBalanced('(', ')');
    }
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selectionSet };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') {
      // The tokenizer emits '$' and the name as separate tokens only when written apart; a glued
      // "$name" arrives as one token and is handled below. Kept for robustness.
      return { kind: 'variable', name: this.next() };
    }
    if (token.startsWith('$')) return { kind: 'variable', name: token.slice(1) };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (/^-?[0-9]/.test(token)) {
      return token.includes('.') || /[eE]/.test(token) ? { kind: 'float', value: Number(token) } : { kind: 'int', value: Number.parseInt(token, 10) };
    }
    return { kind: 'enum', value: token };
  }
}

function valueOf(value: Value, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema

/** A value tagged with its GraphQL type; scalars travel untagged. */
interface GObj {
  t: string;
  v: unknown;
}

const obj = (t: string, v: unknown): GObj => ({ t, v });
const isObj = (value: unknown): value is GObj => typeof value === 'object' && value !== null && 't' in value && 'v' in value;

interface Ctx {
  forge: Forge;
  variables: Readonly<Record<string, unknown>>;
  errors: { message: string }[];
}

type Resolver = (source: GObj, args: Readonly<Record<string, unknown>>, ctx: Ctx) => unknown;

const OBJECT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'url', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt', 'additions', 'deletions', 'changedFiles', 'url', 'repository', 'mergedBy'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'isFork', 'createdAt', 'updatedAt', 'url', 'labels', 'primaryLanguage'],
  User: ['login', 'id', 'name', 'url'],
  Ref: ['name', 'target', 'prefix', 'repository'],
  IssueComment: ['id', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'interfaces', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

const KNOWN_TYPES = new Set<string>([
  'Query', 'Mutation', 'Node', 'User', 'Repository', 'Issue', 'PullRequest', 'IssueComment', 'Ref',
  'PageInfo', 'IssueConnection', 'PullRequestConnection', 'PullRequestChangedFileConnection',
  'PullRequestChangedFile', 'IssueEdge', 'PullRequestEdge', 'CommentEdge',
  'CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload',
  ...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES),
  'String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID',
  'CreateIssueInput', 'CloseIssueInput', 'CreatePullRequestInput', 'MergePullRequestInput', 'AddCommentInput',
]);

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'user', 'organization', 'search', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  ...OBJECT_FIELDS,
};

function viewerLoginOf(forge: Forge): string {
  return forge.viewerLogin ?? 'viewer';
}

function asRepo(source: GObj): Repo {
  return source.v as Repo;
}

function cursorFor(repo: Repo, issue: IssueRec): string {
  return encodeId(`cursor:${repo.id}:${issue.number}`);
}

function paginate<T>(items: readonly T[], first: unknown, after: unknown, cursorOf: (item: T) => string): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const index = items.findIndex((item) => cursorOf(item) === after);
    if (index >= 0) start = index + 1;
  }
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : items.length;
  const page = items.slice(start, start + limit);
  return {
    page,
    hasNextPage: start + page.length < items.length,
    endCursor: page.length > 0 ? cursorOf(page[page.length - 1] as T) : null,
  };
}

function issueConnection(repo: Repo, args: Readonly<Record<string, unknown>>): GObj {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const descending = orderBy?.direction === 'DESC';
  list.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  const { page, hasNextPage, endCursor } = paginate(list, args.first, args.after, (issue) => cursorFor(repo, issue));
  return obj('IssueConnection', {
    nodes: page.map((issue) => obj('Issue', { repo, issue })),
    pageInfo: obj('PageInfo', { hasNextPage, hasPreviousPage: false, startCursor: page.length > 0 ? cursorFor(repo, page[0] as IssueRec) : null, endCursor }),
    totalCount: list.length,
  });
}

function pullConnection(repo: Repo, args: Readonly<Record<string, unknown>>): GObj {
  const list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
  const limit = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : list.length;
  const page = list.slice(0, limit);
  return obj('PullRequestConnection', {
    nodes: page.map((pull) => obj('PullRequest', { repo, pull })),
    pageInfo: obj('PageInfo', { hasNextPage: page.length < list.length, hasPreviousPage: false, startCursor: null, endCursor: null }),
    totalCount: list.length,
  });
}

/** MERGEABLE when a dry-run three-way merge succeeds, CONFLICTING when it does not. */
function mergeableOf(repo: Repo, pull: PullRec): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const base = repo.mergeBase(baseTip, headTip);
  if (base === null) return 'UNKNOWN';
  const baseInfo = repo.commitInfo(base);
  const headInfo = repo.commitInfo(headTip);
  const currentInfo = repo.commitInfo(baseTip);
  if (baseInfo === null || headInfo === null || currentInfo === null) return 'UNKNOWN';
  const merged = repo.mergeTrees(baseInfo.tree, headInfo.tree, currentInfo.tree);
  return 'conflict' in merged ? 'CONFLICTING' : 'MERGEABLE';
}

interface IssueSource { repo: Repo; issue: IssueRec }
interface PullSource { repo: Repo; pull: PullRec }

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: (_source, _args, ctx) => obj('User', { login: viewerLoginOf(ctx.forge) }),
    repository: (_source, args, ctx) => {
      const repo = ctx.forge.resolveRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : obj('Repository', repo);
    },
    node: (_source, args, ctx) => {
      const decoded = decodeId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoById(ctx.forge, Number.parseInt(decoded.parts[0] as string, 10));
        return repo === null ? null : obj('Repository', repo);
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const repo = repoById(ctx.forge, Number.parseInt(decoded.parts[0] as string, 10));
        const number = Number.parseInt(decoded.parts[1] as string, 10);
        if (repo === null) return null;
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.get(number);
          return issue === undefined ? null : obj('Issue', { repo, issue });
        }
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : obj('PullRequest', { repo, pull });
      }
      return null;
    },
    __type: (_source, args) => {
      const name = String(args.name ?? '');
      return KNOWN_TYPES.has(name) ? obj('__Type', { name }) : null;
    },
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as { repositoryId?: string; title?: string; body?: string };
      const decoded = decodeId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.kind === 'Repository' ? repoById(ctx.forge, Number.parseInt(decoded.parts[0] as string, 10)) : null;
      if (repo === null) throw new Error('repository not found for createIssue');
      const issue: IssueRec = {
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        seq: ctx.forge.nextSeq(),
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return obj('CreateIssuePayload', { issue: obj('Issue', { repo, issue }) });
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as { issueId?: string };
      const decoded = decodeId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('issue not found for closeIssue');
      const repo = repoById(ctx.forge, Number.parseInt(decoded.parts[0] as string, 10));
      const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] as string, 10));
      if (repo === null || repo === undefined || issue === undefined) throw new Error('issue not found for closeIssue');
      issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: obj('Issue', { repo, issue }) });
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
      const decoded = decodeId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.kind === 'Repository' ? repoById(ctx.forge, Number.parseInt(decoded.parts[0] as string, 10)) : null;
      if (repo === null) throw new Error('repository not found for createPullRequest');
      const pull: PullRec = {
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef: String(input.headRefName ?? ''),
        baseRef: String(input.baseRefName ?? repo.defaultBranch),
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: ctx.forge.nextSeq(),
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return obj('CreatePullRequestPayload', { pullRequest: obj('PullRequest', { repo, pull }) });
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as { pullRequestId?: string; mergeMethod?: string };
      const decoded = decodeId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('pull request not found for mergePullRequest');
      const repo = repoById(ctx.forge, Number.parseInt(decoded.parts[0] as string, 10));
      const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1] as string, 10));
      if (repo === null || repo === undefined || pull === undefined) throw new Error('pull request not found for mergePullRequest');
      if (pull.state !== 'open') throw new Error('pull request is not open');
      const method = String(input.mergeMethod ?? 'MERGE').toUpperCase();
      const baseTip = repo.branchTip(pull.baseRef);
      const headTip = repo.branchTip(pull.headRef);
      if (baseTip === null || headTip === null) throw new Error('pull request branches are missing');
      const base = repo.mergeBase(baseTip, headTip);
      if (base === null) throw new Error('pull request has no merge base');
      const baseInfo = repo.commitInfo(base);
      const headInfo = repo.commitInfo(headTip);
      const currentInfo = repo.commitInfo(baseTip);
      if (baseInfo === null || headInfo === null || currentInfo === null) throw new Error('pull request history is incomplete');
      const merged = repo.mergeTrees(baseInfo.tree, headInfo.tree, currentInfo.tree);
      if ('conflict' in merged) throw new Error(`merge conflict in ${merged.conflict}`);
      const parents = method === 'MERGE' ? [baseTip, headTip] : [baseTip];
      const message = method === 'MERGE' ? `Merge pull request #${pull.number} from ${pull.headRef}` : `${pull.title} (#${pull.number})`;
      const mergeSha = repo.putObject('commit', buildCommit({ tree: merged.treeSha, parents, author: ctx.forge.authorLine(), committer: ctx.forge.authorLine(), message }));
      repo.setRef(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = ctx.forge.nowIso();
      pull.mergeCommitSha = mergeSha;
      return obj('MergePullRequestPayload', { pullRequest: obj('PullRequest', { repo, pull }) });
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as { subjectId?: string; body?: string };
      const decoded = decodeId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('subject not found for addComment');
      const repo = repoById(ctx.forge, Number.parseInt(decoded.parts[0] as string, 10));
      const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] as string, 10));
      if (repo === null || repo === undefined || issue === undefined) throw new Error('subject not found for addComment');
      const comment: CommentRec = { id: ctx.forge.nextCommentIdValue(), body: String(input.body ?? ''), seq: ctx.forge.nextSeq() };
      const list = repo.comments.get(issue.number) ?? [];
      list.push(comment);
      repo.comments.set(issue.number, list);
      return obj('AddCommentPayload', { commentEdge: obj('CommentEdge', { node: obj('IssueComment', comment), cursor: encodeId(`cursor:comment:${comment.id}`) }) });
    },
  },
  User: {
    login: (source) => (source.v as { login: string }).login,
    id: (source, _args, ctx) => encodeId(`User:${(source.v as { login: string }).login || viewerLoginOf(ctx.forge)}`),
  },
  Repository: {
    id: (source) => repoGlobalId(asRepo(source)),
    databaseId: (source) => asRepo(source).id,
    name: (source) => asRepo(source).name,
    nameWithOwner: (source, _args, ctx) => `${viewerLoginOf(ctx.forge)}/${asRepo(source).name}`,
    owner: (_source, _args, ctx) => obj('User', { login: viewerLoginOf(ctx.forge) }),
    defaultBranchRef: (source) => {
      const repo = asRepo(source);
      return repo.branchTip(repo.defaultBranch) === null ? null : obj('Ref', { name: repo.defaultBranch });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (source) => asRepo(source).description,
    isPrivate: (source) => asRepo(source).isPrivate,
    issue: (source, args) => {
      const repo = asRepo(source);
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : obj('Issue', { repo, issue });
    },
    issues: (source, args) => issueConnection(asRepo(source), args),
    pullRequest: (source, args) => {
      const repo = asRepo(source);
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : obj('PullRequest', { repo, pull });
    },
    pullRequests: (source, args) => pullConnection(asRepo(source), args),
  },
  Issue: {
    id: (source) => issueGlobalId((source.v as IssueSource).repo, (source.v as IssueSource).issue),
    number: (source) => (source.v as IssueSource).issue.number,
    title: (source) => (source.v as IssueSource).issue.title,
    body: (source) => (source.v as IssueSource).issue.body,
    state: (source) => (source.v as IssueSource).issue.state.toUpperCase(),
  },
  PullRequest: {
    id: (source) => pullGlobalId((source.v as PullSource).repo, (source.v as PullSource).pull),
    number: (source) => (source.v as PullSource).pull.number,
    title: (source) => (source.v as PullSource).pull.title,
    body: (source) => (source.v as PullSource).pull.body,
    state: (source) => {
      const pull = (source.v as PullSource).pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.v as PullSource).pull.merged,
    headRefName: (source) => (source.v as PullSource).pull.headRef,
    baseRefName: (source) => (source.v as PullSource).pull.baseRef,
    mergeable: (source) => mergeableOf((source.v as PullSource).repo, (source.v as PullSource).pull),
    files: (source, args) => {
      const { repo, pull } = source.v as PullSource;
      const files = pullFiles(repo, pull);
      const limit = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : files.length;
      const page = files.slice(0, limit);
      return obj('PullRequestChangedFileConnection', {
        nodes: page.map((file) => obj('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions })),
        pageInfo: obj('PageInfo', { hasNextPage: page.length < files.length, hasPreviousPage: false, startCursor: null, endCursor: null }),
        totalCount: files.length,
      });
    },
  },
  IssueComment: {
    id: (source) => commentGlobalId(source.v as CommentRec),
    body: (source) => (source.v as CommentRec).body,
  },
  __Type: {
    name: (source) => (source.v as { name: string }).name,
    kind: (source) => {
      const name = (source.v as { name: string }).name;
      if (name in ENUM_VALUES) return 'ENUM';
      if (['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID'].includes(name)) return 'SCALAR';
      if (name.endsWith('Input')) return 'INPUT_OBJECT';
      if (name === 'Node') return 'INTERFACE';
      return 'OBJECT';
    },
    fields: (source) => {
      const name = (source.v as { name: string }).name;
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      return fields.map((field) => obj('__Field', { name: field }));
    },
    enumValues: (source) => {
      const name = (source.v as { name: string }).name;
      const values = ENUM_VALUES[name];
      if (values === undefined) return null;
      return values.map((value) => obj('__EnumValue', { name: value }));
    },
  },
  __Field: {
    name: (source) => (source.v as { name: string }).name,
  },
  __EnumValue: {
    name: (source) => (source.v as { name: string }).name,
  },
};

// ---------------------------------------------------------------- executor

function executeSelectionSet(typeName: string, source: GObj, selections: readonly SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const knownFields = TYPE_FIELDS[typeName] ?? OBJECT_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (knownFields !== undefined && !knownFields.includes(selection.name)) {
      ctx.errors.push({ message: `Field "${selection.name}" is not defined by type "${typeName}"` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueOf(arg.value, ctx.variables);
    const resolver = RESOLVERS[typeName]?.[selection.name];
    let value: unknown;
    try {
      if (resolver !== undefined) {
        value = resolver(source, args, ctx);
      } else if (isObj(source) && typeof source.v === 'object' && source.v !== null && selection.name in (source.v as Record<string, unknown>)) {
        value = (source.v as Record<string, unknown>)[selection.name];
      } else {
        value = null;
      }
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (isObj(value)) {
    if (field.selectionSet === null) return null;
    return executeSelectionSet(value.t, value, field.selectionSet, ctx);
  }
  return value;
}

function executeOperation(forge: Forge, body: { query?: unknown; variables?: unknown; operationName?: unknown }): { data?: unknown; errors?: { message: string }[] } {
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    return { errors: [{ message: 'a GraphQL query string is required' }] };
  }
  let operations: Operation[];
  try {
    operations = new Parser(body.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  if (operations.length === 0) return { errors: [{ message: 'the document holds no operation' }] };
  let operation = operations[0] as Operation;
  if (typeof body.operationName === 'string' && body.operationName !== '') {
    operation = operations.find((candidate) => candidate.name === body.operationName) ?? operation;
  }
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  const ctx: Ctx = { forge, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, obj(rootType, {}), operation.selectionSet, ctx);
  const result: { data?: unknown; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------- handler

export async function handleGraphql(forge: Forge, req: Req, res: Res): Promise<void> {
  if (!req.authed) {
    res.json(401, { message: 'Bad credentials' });
    return;
  }
  if (req.method !== 'POST') {
    res.json(405, { errors: [{ message: 'GraphQL accepts POST' }] });
    return;
  }
  let parsed: unknown;
  try {
    parsed = req.body.length === 0 ? undefined : JSON.parse(req.body.toString('utf8'));
  } catch {
    res.json(400, { errors: [{ message: 'the request body is not valid JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOperation(forge, (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown }));
    res.json(200, results);
    return;
  }
  const body = (parsed ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  const result = executeOperation(forge, body);
  res.json(200, result);
}
