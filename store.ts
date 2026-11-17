// The forge's data model and git object layer.
//
// Everything lives in memory: one process, one trial, no persistence. Git objects are stored by
// their SHA-1 over the exact payload bytes, so anything pushed through the git protocol round-trips
// byte-for-byte (the header is a pure function of type and length). On top of the object store sit
// the repository records the REST, GraphQL and MCP surfaces share: refs, issues, pull requests,
// labels and comments.
//
// The viewer login is learned, not configured: the trial's bearer token belongs to one seeded user
// whose login the entry is never told. The first owner segment that addresses an existing
// repository binds as the token owner's login; any other owner is a stranger and reads as 404.

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface StoredObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

/** The git object id: sha1 of "<type> <len>\0" followed by the payload. */
export function objectId(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree object's payload into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const mode = data.toString('utf8', at, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: by name, directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries (sorted the git way) into a tree payload. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's payload. Author and committer keep their raw "Name <mail> ts tz" form. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialise a commit payload. */
export function buildCommit(input: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** Parse a tag object's payload (target, type, name, message). */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message: split === -1 ? '' : text.slice(split + 2) };
}

/** "Name <email> epoch +0000" from a name, email and epoch seconds. */
export function identLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

/** Split text into lines the way a line diff counts them (a trailing newline ends the last line). */
export function textLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line diff counts between two texts: lines only in `next` are additions, and conversely. */
export function lineDiffCounts(before: string, next: string): { additions: number; deletions: number } {
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(textLines(before));
  const b = count(textLines(next));
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of b) additions += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) deletions += Math.max(0, n - (b.get(line) ?? 0));
  return { additions, deletions };
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface FlatEntry {
  sha: string;
  mode: string;
}

const ZERO_SHA = '0000000000000000000000000000000000000000';
export { ZERO_SHA };

export class Repo {
  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly objects = new Map<string, StoredObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, { name: string; color: string }>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  readonly comments = new Map<number, CommentRec[]>();
  nextNumber = 1;
  private readonly commitCache = new Map<string, CommitInfo>();
  /** Cached fetch results (pack + selection), keyed by the want set; cleared on any ref move. */
  readonly packCache = new Map<string, { pack: Buffer; shallow: Set<string>; objects: Set<string> }>();

  constructor(id: number, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  // ------------------------------------------------------------ objects

  putObject(type: ObjType, data: Buffer): string {
    const sha = objectId(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  getObject(sha: string): StoredObject | undefined {
    return this.objects.get(sha);
  }

  commitInfo(sha: string): CommitInfo | null {
    const cached = this.commitCache.get(sha);
    if (cached !== undefined) return cached;
    const object = this.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return null;
    const info = parseCommit(object.data);
    this.commitCache.set(sha, info);
    return info;
  }

  /** The commit a ref or sha names: a branch name, a full ref, or a commit sha itself. */
  resolveCommit(ref: string): string | null {
    if (this.refs.has(ref)) return this.refs.get(ref) ?? null;
    const branchRef = `refs/heads/${ref}`;
    if (this.refs.has(branchRef)) return this.refs.get(branchRef) ?? null;
    const tagRef = `refs/tags/${ref}`;
    if (this.refs.has(tagRef)) {
      const target = this.refs.get(tagRef) ?? null;
      return target === null ? null : this.peelToCommit(target);
    }
    if (/^[0-9a-f]{40}$/i.test(ref) && this.commitInfo(ref.toLowerCase()) !== null) return ref.toLowerCase();
    return null;
  }

  /** Follow tag objects until a commit (or something else) is reached. */
  peelToCommit(sha: string): string | null {
    let current = sha;
    for (let guard = 0; guard < 16; guard += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setRef(ref: string, sha: string | null): void {
    if (sha === null || sha === ZERO_SHA) this.refs.delete(ref);
    else this.refs.set(ref, sha);
    this.packCache.clear();
  }

  // ------------------------------------------------------------ trees

  /** Flatten a tree (recursively) into path -> {sha, mode} for files. */
  flattenTree(treeSha: string): Map<string, FlatEntry> {
    const out = new Map<string, FlatEntry>();
    const walk = (sha: string, prefix: string): void => {
      const object = this.objects.get(sha);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.sha, path);
        else out.set(path, { sha: entry.sha, mode: entry.mode });
      }
    };
    walk(treeSha, '');
    return out;
  }

  /** Build nested trees from a flat path map; returns the root tree sha. */
  buildTreeFromFlat(flat: ReadonlyMap<string, FlatEntry>): string {
    interface Node {
      files: Map<string, FlatEntry>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let next = node.dirs.get(part);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree entry at an exact path inside a tree, or null. */
  entryAtPath(treeSha: string, path: string): { type: 'file' | 'dir'; sha: string; mode: string } | null {
    const parts = path.split('/');
    let current = treeSha;
    for (let i = 0; i < parts.length; i += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
      if (entry === undefined) return null;
      if (i === parts.length - 1) {
        return entry.mode === '40000' ? { type: 'dir', sha: entry.sha, mode: entry.mode } : { type: 'file', sha: entry.sha, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      current = entry.sha;
    }
    return null;
  }

  /** Directory entries directly under a path ('' is the root), or null when the path is no directory. */
  listDir(treeSha: string, path: string): TreeEntry[] | null {
    let root = treeSha;
    if (path !== '') {
      const entry = this.entryAtPath(treeSha, path);
      if (entry === null || entry.type !== 'dir') return null;
      root = entry.sha;
    }
    const object = this.objects.get(root);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  // ------------------------------------------------------------ history

  /** Ancestor depths of a commit (itself at depth 0), breadth-first over parents. */
  ancestorDepths(tip: string): Map<string, number> {
    const depths = new Map<string, number>();
    let frontier = [tip];
    depths.set(tip, 0);
    let depth = 0;
    while (frontier.length > 0) {
      depth += 1;
      const next: string[] = [];
      for (const sha of frontier) {
        const info = this.commitInfo(sha);
        if (info === null) continue;
        for (const parent of info.parents) {
          if (!depths.has(parent)) {
            depths.set(parent, depth);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    return depths;
  }

  /** The best common ancestor of two commits (the one minimising summed depth), or null. */
  mergeBase(a: string, b: string): string | null {
    const depthsA = this.ancestorDepths(a);
    const depthsB = this.ancestorDepths(b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [sha, depthA] of depthsA) {
      const depthB = depthsB.get(sha);
      if (depthB === undefined) continue;
      const score = depthA + depthB;
      if (score < bestScore) {
        bestScore = score;
        best = sha;
      }
    }
    return best;
  }

  /** Commits reachable from a tip, newest first (depth order). */
  listCommits(tip: string): string[] {
    const depths = this.ancestorDepths(tip);
    return [...depths.entries()].sort((x, y) => x[1] - y[1]).map(([sha]) => sha);
  }

  // ------------------------------------------------------------ writes

  /**
   * Apply file changes on a branch and commit them. A missing branch is created from the default
   * branch's tip when there is one (the contents route doubles as branch creation for the MCP
   * fixture), otherwise the branch starts unborn. Returns the new commit sha, or null when the
   * branch is unborn and there is nothing to commit on.
   */
  commitFiles(input: {
    branch: string;
    changes: ReadonlyMap<string, Buffer | null>;
    message: string;
    authorLine: string;
  }): { commitSha: string; treeSha: string } | null {
    let tip = this.branchTip(input.branch);
    if (tip === null) {
      const fallback = input.branch === this.defaultBranch ? null : this.branchTip(this.defaultBranch);
      tip = fallback;
    }
    const baseTree = tip === null ? null : (this.commitInfo(tip)?.tree ?? null);
    const flat = baseTree === null ? new Map<string, FlatEntry>() : this.flattenTree(baseTree);
    for (const [path, content] of input.changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { sha: this.putObject('blob', content), mode: '100644' });
    }
    const treeSha = this.buildTreeFromFlat(flat);
    const commitSha = this.putObject(
      'commit',
      buildCommit({
        tree: treeSha,
        parents: tip === null ? [] : [tip],
        author: input.authorLine,
        committer: input.authorLine,
        message: input.message,
      }),
    );
    this.setRef(`refs/heads/${input.branch}`, commitSha);
    return { commitSha, treeSha };
  }

  /**
   * Three-way tree merge for a squash: per path, a side that did not move yields to the side that
   * did; both sides moving to the same bytes agree; both sides moving differently conflict.
   */
  mergeTrees(baseTree: string, headTree: string, currentTree: string): { treeSha: string } | { conflict: string } {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const current = this.flattenTree(currentTree);
    const paths = new Set<string>([...base.keys(), ...head.keys(), ...current.keys()]);
    const out = new Map<string, FlatEntry>();
    for (const path of paths) {
      const b = base.get(path)?.sha;
      const h = head.get(path)?.sha;
      const c = current.get(path)?.sha;
      let winner: FlatEntry | undefined;
      if (h === b) winner = current.get(path);
      else if (c === b) winner = head.get(path);
      else if (h === c) winner = head.get(path);
      else return { conflict: path };
      if (winner !== undefined) out.set(path, winner);
    }
    return { treeSha: this.buildTreeFromFlat(out) };
  }
}

export class Forge {
  viewerLogin: string | null = null;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextCommentId = 1;
  private seq = 0;
  private requestSeq = 0;

  /** A monotonically increasing sequence number (creation order across the whole forge). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A unique, non-empty request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `DORIS-${this.requestSeq.toString(16).toUpperCase().padStart(8, '0')}`;
  }

  /** Deterministic logical time: a fixed epoch plus the sequence, so runs never depend on a clock. */
  nowIso(): string {
    return new Date(1_735_689_600_000 + this.nextSeq() * 60_000).toISOString();
  }

  /** The identity contents and merge commits are authored under. */
  authorLine(): string {
    return identLine('Doris Forge', 'forge@doris.invalid', 1_735_689_600 + this.seq);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(this.nextRepoId, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * Resolve a repository addressed by an owner segment. The first owner that addresses an
   * existing repository binds as the viewer; after that, any other owner is foreign (null).
   */
  resolveRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      return repo;
    }
    return owner === this.viewerLogin ? repo : null;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  nextCommentIdValue(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}
