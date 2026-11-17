// The GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues, comments
// and pull requests, with the statuses and shapes the conformance suite pins down.
//
// Conventions the checks rely on:
//   - every error body is {"message": string}; 401 without the token, 404 for anything absent or
//     foreign, 422 for validation failures, 409 for a stale contents sha, 405 for a conflicted merge
//   - a repository is created with POST /user/repos (201, or 422 "already exists") and is born
//     unborn with default branch "main"; PUT /contents makes its first commit
//   - issues and pull requests share one number sequence per repository, as on GitHub
//   - list endpoints paginate with Link rel="next"/"last" headers on this origin

import { Forge, Repo, buildCommit, lineDiffCounts, type IssueRec, type PullRec } from './store.ts';
import { parseJsonBody, type Req, type Res } from './http.ts';

const NOT_FOUND = { message: 'Not Found' };

function isoOfSeq(seq: number): string {
  return new Date(1_735_689_600_000 + seq * 60_000).toISOString();
}

function ownerOf(forge: Forge, addressed: string): string {
  return forge.viewerLogin ?? addressed;
}

export function repoJson(forge: Forge, repo: Repo, addressedOwner: string): Record<string, unknown> {
  const owner = ownerOf(forge, addressedOwner);
  return {
    id: repo.id,
    databaseId: repo.id,
    node_id: `R_doris_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: isoOfSeq(repo.id),
    updated_at: isoOfSeq(repo.id),
    html_url: `/${owner}/${repo.name}`,
  };
}

export function issueJson(forge: Forge, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.seq,
    node_id: `I_doris_${issue.seq}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: forge.viewerLogin ?? 'viewer', id: 1, type: 'User' },
    comments: 0,
    created_at: isoOfSeq(issue.seq),
    updated_at: isoOfSeq(issue.seq),
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  const owner = forge.viewerLogin ?? 'viewer';
  const headSha = repo.branchTip(pull.headRef) ?? '0000000000000000000000000000000000000000';
  const baseSha = repo.branchTip(pull.baseRef) ?? '0000000000000000000000000000000000000000';
  return {
    id: pull.seq,
    node_id: `PR_doris_${pull.seq}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}`, repo: { name: repo.name, full_name: `${owner}/${repo.name}` } },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}`, repo: { name: repo.name, full_name: `${owner}/${repo.name}` } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner, id: 1, type: 'User' },
    created_at: isoOfSeq(pull.seq),
    updated_at: isoOfSeq(pull.seq),
  };
}

/** Slice one page out of a list and build the Link header GitHub would send. */
function paginate(req: Req, items: readonly unknown[]): { page: unknown[]; headers: Record<string, string> } {
  const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(req.query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (page < lastPage) {
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const next = `http://${req.host}${req.rawPath}?${params.toString()}`;
    params.set('page', String(lastPage));
    const last = `http://${req.host}${req.rawPath}?${params.toString()}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: slice, headers };
}

function bodyOf(req: Req, res: Res): Record<string, unknown> | null {
  try {
    return parseJsonBody(req.body) ?? {};
  } catch {
    res.json(400, { message: 'Malformed JSON' });
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function handleRest(forge: Forge, req: Req, res: Res): Promise<boolean> {
  const seg = req.segments.slice(2); // after ['api', 'v3']

  if (!req.authed) {
    res.json(401, { message: 'Bad credentials' });
    return true;
  }

  // The API root and meta.
  if (seg.length === 0) {
    if (req.method === 'GET') {
      res.json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    res.json(404, NOT_FOUND);
    return true;
  }
  if (seg.length === 1 && seg[0] === 'meta' && req.method === 'GET') {
    res.json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }
  if (seg.length === 1 && seg[0] === 'user' && req.method === 'GET') {
    res.json(200, { login: forge.viewerLogin ?? 'viewer', id: 1, type: 'User' });
    return true;
  }

  // The viewer's repository collection.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (req.method === 'POST') {
      const body = bodyOf(req, res);
      if (body === null) return true;
      const name = str(body.name);
      if (name === '') {
        res.json(422, { message: 'Repository name is required' });
        return true;
      }
      const repo = forge.createRepo(name, str(body.description), body.private !== false);
      if (repo === null) {
        res.json(422, { message: 'Repository already exists' });
        return true;
      }
      res.json(201, repoJson(forge, repo, forge.viewerLogin ?? 'viewer'));
      return true;
    }
    if (req.method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id).map((repo) => repoJson(forge, repo, forge.viewerLogin ?? 'viewer'));
      const { page, headers } = paginate(req, all);
      res.json(200, page, headers);
      return true;
    }
    res.json(404, NOT_FOUND);
    return true;
  }

  // Everything under /repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1] as string;
    const repo = forge.resolveRepo(owner, seg[2] as string);
    if (repo === null) {
      res.json(404, NOT_FOUND);
      return true;
    }
    const rest = seg.slice(3);
    return routeRepo(forge, repo, owner, rest, req, res);
  }

  res.json(404, NOT_FOUND);
  return true;
}

async function routeRepo(forge: Forge, repo: Repo, owner: string, rest: string[], req: Req, res: Res): Promise<boolean> {
  // The repository itself.
  if (rest.length === 0) {
    if (req.method === 'GET') {
      res.json(200, repoJson(forge, repo, owner));
      return true;
    }
    if (req.method === 'PATCH') {
      const body = bodyOf(req, res);
      if (body === null) return true;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      res.json(200, repoJson(forge, repo, owner));
      return true;
    }
    if (req.method === 'DELETE') {
      forge.deleteRepo(repo.name);
      res.empty(204);
      return true;
    }
    res.json(404, NOT_FOUND);
    return true;
  }

  if (rest[0] === 'branches') return routeBranches(repo, rest.slice(1), req, res);
  if (rest[0] === 'commits' && rest.length === 1 && req.method === 'GET') return listCommits(repo, req, res);
  if (rest[0] === 'git' && rest[1] === 'refs') return routeGitRefs(repo, rest.slice(2), req, res);
  if (rest[0] === 'contents') return routeContents(forge, repo, rest.slice(1).join('/'), req, res);
  if (rest[0] === 'labels') return routeLabels(repo, rest.slice(1), req, res);
  if (rest[0] === 'issues') return routeIssues(forge, repo, rest.slice(1), req, res);
  if (rest[0] === 'pulls') return routePulls(forge, repo, rest.slice(1), req, res);

  res.json(404, NOT_FOUND);
  return true;
}

function routeBranches(repo: Repo, rest: string[], req: Req, res: Res): boolean {
  if (rest.length === 0 && req.method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
    const { page, headers } = paginate(req, branches);
    res.json(200, page, headers);
    return true;
  }
  if (rest.length >= 1 && req.method === 'GET') {
    const name = rest.join('/');
    const sha = repo.branchTip(name);
    if (sha === null) {
      res.json(404, NOT_FOUND);
      return true;
    }
    res.json(200, { name, commit: { sha }, protected: false });
    return true;
  }
  res.json(404, NOT_FOUND);
  return true;
}

function listCommits(repo: Repo, req: Req, res: Res): boolean {
  const ref = req.query.get('sha') ?? repo.defaultBranch;
  const tip = repo.resolveCommit(ref);
  if (tip === null) {
    res.json(200, []);
    return true;
  }
  const commits = repo.listCommits(tip).map((sha) => {
    const info = repo.commitInfo(sha);
    return {
      sha,
      commit: {
        message: info?.message ?? '',
        author: { name: (info?.author ?? '').replace(/ <.*$/, ''), date: isoOfSeq(0) },
        committer: { name: (info?.committer ?? '').replace(/ <.*$/, '') },
        tree: { sha: info?.tree ?? '' },
      },
      parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
    };
  });
  const { page, headers } = paginate(req, commits);
  res.json(200, page, headers);
  return true;
}

function routeGitRefs(repo: Repo, rest: string[], req: Req, res: Res): boolean {
  if (rest.length === 0 && req.method === 'POST') {
    const body = (() => {
      try {
        return parseJsonBody(req.body) ?? {};
      } catch {
        res.json(400, { message: 'Malformed JSON' });
        return null;
      }
    })();
    if (body === null) return true;
    const ref = str(body.ref);
    const sha = str(body.sha).toLowerCase();
    if (!ref.startsWith('refs/') || repo.commitInfo(sha) === null) {
      res.json(422, { message: 'Invalid ref or sha' });
      return true;
    }
    if (repo.refs.has(ref)) {
      res.json(422, { message: 'Reference already exists' });
      return true;
    }
    repo.setRef(ref, sha);
    res.json(201, { ref, object: { sha, type: 'commit' } });
    return true;
  }
  if (rest.length >= 1 && req.method === 'GET') {
    const ref = `refs/${rest.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      res.json(404, NOT_FOUND);
      return true;
    }
    res.json(200, { ref, object: { sha, type: 'commit' } });
    return true;
  }
  res.json(404, NOT_FOUND);
  return true;
}

function routeContents(forge: Forge, repo: Repo, path: string, req: Req, res: Res): boolean {
  if (req.method === 'GET') {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const tip = repo.branchTip(ref) ?? repo.resolveCommit(ref);
    if (tip === null) {
      res.json(404, NOT_FOUND);
      return true;
    }
    const info = repo.commitInfo(tip);
    if (info === null) {
      res.json(404, NOT_FOUND);
      return true;
    }
    if (path === '') {
      const entries = repo.listDir(info.tree, '');
      if (entries === null) {
        res.json(404, NOT_FOUND);
        return true;
      }
      res.json(200, entries.map((entry) => dirEntryJson(entry, entry.name)));
      return true;
    }
    const entry = repo.entryAtPath(info.tree, path);
    if (entry === null) {
      res.json(404, NOT_FOUND);
      return true;
    }
    if (entry.type === 'dir') {
      const entries = repo.listDir(info.tree, path) ?? [];
      res.json(200, entries.map((child) => dirEntryJson(child, `${path}/${child.name}`)));
      return true;
    }
    const blob = repo.getObject(entry.sha);
    if (blob === undefined) {
      res.json(404, NOT_FOUND);
      return true;
    }
    res.json(200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: entry.sha,
      size: blob.data.length,
      name: path.split('/').pop() ?? path,
      path,
    });
    return true;
  }

  if (req.method === 'PUT' || req.method === 'DELETE') {
    const body = bodyOf(req, res);
    if (body === null) return true;
    const branch = str(body.branch) || repo.defaultBranch;
    const tip = repo.branchTip(branch);
    const tree = tip === null ? null : (repo.commitInfo(tip)?.tree ?? null);
    const existing = tree === null ? null : repo.entryAtPath(tree, path);

    if (req.method === 'PUT') {
      const content = Buffer.from(str(body.content).replace(/[\s]+/g, ''), 'base64');
      if (existing !== null && existing.type === 'file') {
        const givenSha = str(body.sha);
        if (givenSha !== '' && givenSha.toLowerCase() !== existing.sha) {
          res.json(409, { message: 'sha does not match' });
          return true;
        }
        if (givenSha === '') {
          res.json(422, { message: 'sha is required to update a file' });
          return true;
        }
      }
      const result = repo.commitFiles({
        branch,
        changes: new Map([[path, content]]),
        message: str(body.message) || 'Update file',
        authorLine: forge.authorLine(),
      });
      if (result === null) {
        res.json(422, { message: 'Could not commit' });
        return true;
      }
      const blobSha = repo.entryAtPath(result.treeSha, path)?.sha ?? '';
      res.json(existing !== null ? 200 : 201, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
      return true;
    }

    // DELETE
    if (existing === null || existing.type !== 'file') {
      res.json(404, NOT_FOUND);
      return true;
    }
    const givenSha = str(body.sha);
    if (givenSha !== '' && givenSha.toLowerCase() !== existing.sha) {
      res.json(409, { message: 'sha does not match' });
      return true;
    }
    const result = repo.commitFiles({
      branch,
      changes: new Map([[path, null]]),
      message: str(body.message) || 'Delete file',
      authorLine: forge.authorLine(),
    });
    if (result === null) {
      res.json(422, { message: 'Could not commit' });
      return true;
    }
    res.json(200, { content: null, commit: { sha: result.commitSha } });
    return true;
  }

  res.json(404, NOT_FOUND);
  return true;
}

function dirEntryJson(entry: { mode: string; name: string; sha: string }, fullPath: string): Record<string, unknown> {
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: fullPath,
    sha: entry.sha,
    size: 0,
  };
}

function routeLabels(repo: Repo, rest: string[], req: Req, res: Res): boolean {
  if (rest.length === 0 && req.method === 'POST') {
    const body = (() => {
      try {
        return parseJsonBody(req.body) ?? {};
      } catch {
        res.json(400, { message: 'Malformed JSON' });
        return null;
      }
    })();
    if (body === null) return true;
    const name = str(body.name);
    if (name === '') {
      res.json(422, { message: 'Label name is required' });
      return true;
    }
    const color = str(body.color) || 'ededed';
    if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
    const label = repo.labels.get(name) as { name: string; color: string };
    res.json(201, { name: label.name, color: label.color });
    return true;
  }
  if (rest.length === 0 && req.method === 'GET') {
    res.json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    return true;
  }
  res.json(404, NOT_FOUND);
  return true;
}

function routeIssues(forge: Forge, repo: Repo, rest: string[], req: Req, res: Res): boolean {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = bodyOf(req, res);
      if (body === null) return true;
      const labelNames = Array.isArray(body.labels) ? body.labels.map((label) => (typeof label === 'string' ? label : str((label as Record<string, unknown>)?.name))) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) {
          res.json(422, { message: `Label "${name}" does not exist` });
          return true;
        }
      }
      const issue: IssueRec = {
        number: repo.nextNumber,
        title: str(body.title),
        body: str(body.body),
        state: 'open',
        labels: labelNames,
        seq: forge.nextSeq(),
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      res.json(201, issueJson(forge, issue));
      return true;
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, headers } = paginate(req, list.map((issue) => issueJson(forge, issue)));
      res.json(200, page, headers);
      return true;
    }
    res.json(404, NOT_FOUND);
    return true;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 1) {
    if (issue === undefined) {
      res.json(404, NOT_FOUND);
      return true;
    }
    if (req.method === 'GET') {
      res.json(200, issueJson(forge, issue));
      return true;
    }
    if (req.method === 'PATCH') {
      const body = bodyOf(req, res);
      if (body === null) return true;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const names = body.labels.map((label) => (typeof label === 'string' ? label : str((label as Record<string, unknown>)?.name)));
        for (const name of names) {
          if (!repo.labels.has(name)) {
            res.json(422, { message: `Label "${name}" does not exist` });
            return true;
          }
        }
        issue.labels = names;
      }
      res.json(200, issueJson(forge, issue));
      return true;
    }
    res.json(404, NOT_FOUND);
    return true;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) {
      res.json(404, NOT_FOUND);
      return true;
    }
    if (req.method === 'POST') {
      const body = bodyOf(req, res);
      if (body === null) return true;
      const comment = { id: forge.nextCommentIdValue(), body: str(body.body), seq: forge.nextSeq() };
      const list = repo.comments.get(issue.number) ?? [];
      list.push(comment);
      repo.comments.set(issue.number, list);
      res.json(201, { id: comment.id, body: comment.body, created_at: isoOfSeq(comment.seq) });
      return true;
    }
    if (req.method === 'GET') {
      const list = (repo.comments.get(issue.number) ?? []).map((comment) => ({ id: comment.id, body: comment.body, created_at: isoOfSeq(comment.seq) }));
      const { page, headers } = paginate(req, list);
      res.json(200, page, headers);
      return true;
    }
  }

  res.json(404, NOT_FOUND);
  return true;
}

function routePulls(forge: Forge, repo: Repo, rest: string[], req: Req, res: Res): boolean {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = bodyOf(req, res);
      if (body === null) return true;
      const headRaw = str(body.head);
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = str(body.base) || repo.defaultBranch;
      if (repo.branchTip(head) === null) {
        res.json(422, { message: `Head branch "${head}" does not exist` });
        return true;
      }
      if (repo.branchTip(base) === null) {
        res.json(422, { message: `Base branch "${base}" does not exist` });
        return true;
      }
      const pull: PullRec = {
        number: repo.nextNumber,
        title: str(body.title),
        body: str(body.body),
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
      res.json(201, pullJson(forge, repo, pull));
      return true;
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.seq - a.seq);
      const { page, headers } = paginate(req, list.map((pull) => pullJson(forge, repo, pull)));
      res.json(200, page, headers);
      return true;
    }
    res.json(404, NOT_FOUND);
    return true;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) {
    res.json(404, NOT_FOUND);
    return true;
  }

  if (rest.length === 1 && req.method === 'GET') {
    res.json(200, pullJson(forge, repo, pull));
    return true;
  }

  if (rest.length === 2 && rest[1] === 'files' && req.method === 'GET') {
    res.json(200, pullFiles(repo, pull));
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge' && req.method === 'PUT') {
    return mergePull(forge, repo, pull, req, res);
  }

  res.json(404, NOT_FOUND);
  return true;
}

/** The changed-file list between a pull's merge base and its head tip. */
export function pullFiles(repo: Repo, pull: PullRec): Record<string, unknown>[] {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
  const baseInfo = repo.commitInfo(base);
  const headInfo = repo.commitInfo(headTip);
  if (baseInfo === null || headInfo === null) return [];
  const before = repo.flattenTree(baseInfo.tree);
  const after = repo.flattenTree(headInfo.tree);
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b?.sha === a?.sha) continue;
    const beforeText = b === undefined ? '' : (repo.getObject(b.sha)?.data.toString('utf8') ?? '');
    const afterText = a === undefined ? '' : (repo.getObject(a.sha)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(beforeText, afterText);
    files.push({
      filename: path,
      status: b === undefined ? 'added' : a === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: a?.sha ?? b?.sha ?? '',
    });
  }
  return files;
}

function mergePull(forge: Forge, repo: Repo, pull: PullRec, req: Req, res: Res): boolean {
  const body = bodyOf(req, res);
  if (body === null) return true;
  const method = str(body.merge_method) || 'merge';
  if (pull.state !== 'open') {
    res.json(405, { message: 'Pull Request is not mergeable' });
    return true;
  }
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) {
    res.json(405, { message: 'Pull Request is not mergeable' });
    return true;
  }
  const base = repo.mergeBase(baseTip, headTip);
  if (base === null) {
    res.json(405, { message: 'Pull Request is not mergeable' });
    return true;
  }
  const baseInfo = repo.commitInfo(base);
  const headInfo = repo.commitInfo(headTip);
  const currentInfo = repo.commitInfo(baseTip);
  if (baseInfo === null || headInfo === null || currentInfo === null) {
    res.json(405, { message: 'Pull Request is not mergeable' });
    return true;
  }
  const merged = repo.mergeTrees(baseInfo.tree, headInfo.tree, currentInfo.tree);
  if ('conflict' in merged) {
    res.json(405, { message: `Merge conflict in ${merged.conflict}` });
    return true;
  }
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const message = method === 'merge' ? `Merge pull request #${pull.number} from ${pull.headRef}` : `${pull.title} (#${pull.number})`;
  const mergeSha = repo.putObject(
    'commit',
    buildCommit({ tree: merged.treeSha, parents, author: forge.authorLine(), committer: forge.authorLine(), message }),
  );
  repo.setRef(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = mergeSha;
  res.json(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
  return true;
}
