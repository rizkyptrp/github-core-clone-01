// REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests under /api/v3.
//
// Every reply is JSON with an X-GitHub-Request-Id header (added by the app
// layer). Errors are JSON with a string `message`. A repository belongs to the
// login the bearer token names: the same name under any other owner is a 404,
// never a 403.

import { parseCommit, parseTree, type GitObject } from './gitobj.ts';
import { DEFAULT_BRANCH, type Issue, type Label, type PullRequest, type Repo, type Store } from './store.ts';

export interface RestResult {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
}

export type Body = Record<string, unknown>;

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, headers, body };
}

function error(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------- serializers

function userJson(store: Store, login?: string) {
  const viewer = store.viewer;
  const name = login ?? viewer.login;
  return {
    login: name,
    id: name === viewer.login ? viewer.id : 1000 + name.length,
    avatar_url: `https://avatars.githubusercontent.invalid/${name}`,
    html_url: `https://github.invalid/${name}`,
    type: 'User',
  };
}

function repoJson(store: Store, repo: Repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store, repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label: Label) {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

function issueJson(store: Store, repo: Repo, issue: Issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(store),
    labels: issue.labels.map(labelJson),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest) {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userJson(store),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function branchJson(name: string, sha: string) {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/commits/${sha}` },
    protected: false,
  };
}

function commitJson(store: Store, repo: Repo, sha: string) {
  const object = repo.objects.get(sha) as GitObject | undefined;
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const message = commit.message.replace(/\n$/, '');
  return {
    sha,
    commit: {
      message,
      author: { name: store.viewer.name, email: store.viewer.email, date: repo.updatedAt },
      committer: { name: store.viewer.name, email: store.viewer.email, date: repo.updatedAt },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    author: userJson(store),
    committer: userJson(store),
  };
}

function contentJson(store: Store, repo: Repo, path: string, blobOid: string, branch: string) {
  const object = repo.objects.get(blobOid) as GitObject | undefined;
  const data = object?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    sha: blobOid,
    content: data.toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
  };
}

// ---------------------------------------------------------------- routing helpers

interface Ctx {
  readonly store: Store;
  readonly method: string;
  readonly host: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: Body | null;
}

function repoFrom(ctx: Ctx, ownerIndex: number): Repo | RestResult {
  const owner = ctx.segments[ownerIndex] as string;
  const name = ctx.segments[ownerIndex + 1] as string;
  if (owner !== ctx.store.viewer.login) return error(404, 'Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return error(404, 'Not Found');
  return repo;
}

function isRepo(value: Repo | RestResult): value is Repo {
  return (value as Repo).objects !== undefined;
}

/** The default branch tip, or undefined for an unborn repo. */
function defaultTip(store: Store, repo: Repo): string | undefined {
  return store.branchTip(repo, repo.defaultBranch);
}

// ---------------------------------------------------------------- handlers

export function handleRest(ctx: Ctx): RestResult {
  const s = ctx.segments; // after /api/v3
  const method = ctx.method;
  if (s.length === 0) {
    return ok(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, {
      'X-OAuth-Scopes': 'repo, read:org',
    });
  }
  if (s[0] === 'meta' && s.length === 1) {
    return ok(200, { installed_version: '1.0.0', version: '1.0.0', verifiable_password_authentication: false });
  }
  if (s[0] === 'user' && s.length === 1 && method === 'GET') {
    const viewer = ctx.store.viewer;
    return ok(200, {
      login: viewer.login,
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      avatar_url: `https://avatars.githubusercontent.invalid/${viewer.login}`,
      html_url: `https://github.invalid/${viewer.login}`,
      type: 'User',
    });
  }
  if (s[0] === 'user' && s[1] === 'repos') {
    return userRepos(ctx, method);
  }
  if (s[0] === 'repos' && s.length >= 3) {
    return repoRoutes(ctx, method);
  }
  return error(404, 'Not Found');
}

function userRepos(ctx: Ctx, method: string): RestResult {
  if (method === 'POST') {
    const name = asString(ctx.body?.name);
    if (name === '') return error(422, 'name is required');
    const created = ctx.store.createRepo(name, {
      description: asString(ctx.body?.description),
      private: asBoolean(ctx.body?.private),
    });
    if ('error' in created) return error(422, created.error);
    return ok(201, repoJson(ctx.store, created));
  }
  if (method === 'GET') {
    const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
    const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
    const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const all = ctx.store.viewerRepos();
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    const host = ctx.host;
    const base = `http://${host}/api/v3/user/repos`;
    const links: string[] = [];
    if (page * perPage < all.length) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
    if (links.length > 0) headers.Link = links.join(', ');
    return ok(200, slice.map((repo) => repoJson(ctx.store, repo)), headers);
  }
  return error(404, 'Not Found');
}

function repoRoutes(ctx: Ctx, method: string): RestResult {
  const repoOrError = repoFrom(ctx, 1);
  if (!isRepo(repoOrError)) return repoOrError;
  const repo = repoOrError;
  const s = ctx.segments;
  const rest = s.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(ctx.store, repo));
    if (method === 'PATCH') {
      if (typeof ctx.body?.description === 'string') repo.description = ctx.body.description;
      if (typeof ctx.body?.private === 'boolean') repo.private = ctx.body.private;
      repo.updatedAt = ctx.store.nowIso();
      return ok(200, repoJson(ctx.store, repo));
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo);
      return ok(204, null);
    }
    return error(404, 'Not Found');
  }
  if (rest[0] === 'git' && rest[1] === 'refs') return gitRefs(ctx, repo, method, rest.slice(2));
  if (rest[0] === 'branches') return branches(ctx, repo, method, rest.slice(1));
  if (rest[0] === 'commits') return commits(ctx, repo, method, rest.slice(1));
  if (rest[0] === 'contents') return contents(ctx, repo, method, rest.slice(1));
  if (rest[0] === 'labels') return labels(ctx, repo, method, rest.slice(1));
  if (rest[0] === 'issues') return issues(ctx, repo, method, rest.slice(1));
  if (rest[0] === 'pulls') return pulls(ctx, repo, method, rest.slice(1));
  return error(404, 'Not Found');
}

// ---------------------------------------------------------------- git refs / branches / commits

function gitRefs(ctx: Ctx, repo: Repo, method: string, rest: string[]): RestResult {
  if (method === 'POST' && rest.length === 0) {
    const ref = asString(ctx.body?.ref);
    const sha = asString(ctx.body?.sha);
    if (!ref.startsWith('refs/')) return error(422, 'ref must start with refs/');
    if (!/^[0-9a-f]{40}$/.test(sha)) return error(422, 'sha must be a 40-hex object id');
    if (!repo.objects.has(sha)) return error(422, `object ${sha} does not exist`);
    if (repo.refs.has(ref)) return error(422, `ref ${ref} already exists`);
    ctx.store.setRef(repo, ref, sha);
    return ok(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: '' });
  }
  if (method === 'GET' && rest.length >= 2) {
    const ref = `refs/${rest.join('/')}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) return error(404, 'Not Found');
    return ok(200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' }, url: '' });
  }
  return error(404, 'Not Found');
}

function branches(ctx: Ctx, repo: Repo, method: string, rest: string[]): RestResult {
  if (method !== 'GET') return error(404, 'Not Found');
  if (rest.length === 0) {
    const list: Array<{ name: string; commit: { sha: string } }> = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort()) {
      if (ref.startsWith('refs/heads/')) list.push(branchJson(ref.slice('refs/heads/'.length), sha));
    }
    return ok(200, list);
  }
  const name = rest.join('/');
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) return error(404, 'Not Found');
  return ok(200, branchJson(name, sha));
}

function commits(ctx: Ctx, repo: Repo, method: string, rest: string[]): RestResult {
  if (method !== 'GET') return error(404, 'Not Found');
  if (rest.length === 1) {
    const sha = ctx.store.resolveRef(repo, rest[0] as string);
    if (sha === undefined) return error(404, 'Not Found');
    const json = commitJson(ctx.store, repo, sha);
    return json === null ? error(404, 'Not Found') : ok(200, json);
  }
  if (rest.length === 0) {
    const shaParam = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = ctx.store.resolveRef(repo, shaParam);
    if (tip === undefined) return ok(200, []);
    const history = ctx.store.commitHistory(repo, tip, 100);
    const list: unknown[] = [];
    for (const oid of history) {
      const json = commitJson(ctx.store, repo, oid);
      if (json !== null) list.push(json);
    }
    return ok(200, list);
  }
  return error(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function contents(ctx: Ctx, repo: Repo, method: string, rest: string[]): RestResult {
  const path = rest.join('/');
  if (method === 'GET') {
    const refParam = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = ctx.store.resolveRef(repo, refParam);
    if (tip === undefined) return error(404, 'Not Found');
    if (path === '') {
      // The repository root: list the root tree.
      const treeOid = ctx.store.dirTreeAt(repo, tip, '');
      if (treeOid === undefined) return error(404, 'Not Found');
      const tree = repo.objects.get(treeOid) as GitObject | undefined;
      if (!tree || tree.type !== 'tree') return error(404, 'Not Found');
      const listing = parseTree(tree.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.name}`,
      }));
      return ok(200, listing);
    }
    // A file wins over a directory of the same name.
    const blobOid = ctx.store.blobAt(repo, tip, path);
    if (blobOid !== undefined) return ok(200, contentJson(ctx.store, repo, path, blobOid, refParam));
    const treeOid = ctx.store.dirTreeAt(repo, tip, path);
    if (treeOid === undefined) return error(404, 'Not Found');
    const tree = repo.objects.get(treeOid) as GitObject | undefined;
    if (!tree || tree.type !== 'tree') return error(404, 'Not Found');
    const listing = parseTree(tree.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${entry.name}`,
    }));
    return ok(200, listing);
  }
  if (path === '') return error(404, 'Not Found');
  if (method === 'PUT') {
    const message = asString(ctx.body?.message);
    const contentBase64 = asString(ctx.body?.content);
    if (message === '' || contentBase64 === '') return error(422, 'message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentBase64, 'base64');
    } catch {
      return error(422, 'content must be base64');
    }
    const targetBranch = asString(ctx.body?.branch, repo.defaultBranch) || repo.defaultBranch;
    let parent = ctx.store.branchTip(repo, targetBranch);
    if (parent === undefined) {
      // A new branch starts from the default branch's tip (or nothing).
      parent = defaultTip(ctx.store, repo);
    }
    const existing = parent === undefined ? undefined : ctx.store.blobAt(repo, parent, path);
    const shaParam = ctx.body?.sha;
    if (typeof shaParam === 'string' && shaParam !== '' && existing !== shaParam) {
      return error(409, 'sha does not match the current file');
    }
    const isCreate = existing === undefined;
    const commitOid = ctx.store.commitFiles(repo, parent ?? null, new Map([[path, content]]), message);
    ctx.store.setRef(repo, `refs/heads/${targetBranch}`, commitOid);
    const blobOid = ctx.store.blobAt(repo, commitOid, path) as string;
    return ok(isCreate ? 201 : 200, {
      content: contentJson(ctx.store, repo, path, blobOid, targetBranch),
      commit: { sha: commitOid, message },
    });
  }
  if (method === 'DELETE') {
    const message = asString(ctx.body?.message);
    const sha = asString(ctx.body?.sha);
    const targetBranch = asString(ctx.body?.branch, repo.defaultBranch) || repo.defaultBranch;
    const parent = ctx.store.branchTip(repo, targetBranch);
    if (parent === undefined) return error(404, 'Not Found');
    const existing = ctx.store.blobAt(repo, parent, path);
    if (existing === undefined) return error(404, 'Not Found');
    if (sha !== '' && existing !== sha) return error(409, 'sha does not match the current file');
    const commitOid = ctx.store.commitFiles(repo, parent, new Map([[path, null]]), message || `Delete ${path}`);
    ctx.store.setRef(repo, `refs/heads/${targetBranch}`, commitOid);
    return ok(200, { commit: { sha: commitOid, message } });
  }
  return error(404, 'Not Found');
}

// ---------------------------------------------------------------- labels / issues / comments

function labels(ctx: Ctx, repo: Repo, method: string, rest: string[]): RestResult {
  if (method === 'POST' && rest.length === 0) {
    const name = asString(ctx.body?.name);
    if (name === '') return error(422, 'name is required');
    const label = ctx.store.createLabel(repo, name, asString(ctx.body?.color));
    return ok(201, labelJson(label));
  }
  if (method === 'GET' && rest.length === 0) {
    return ok(200, [...repo.labels.values()].map(labelJson));
  }
  return error(404, 'Not Found');
}

function issues(ctx: Ctx, repo: Repo, method: string, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = asString(ctx.body?.title);
      if (title === '') return error(422, 'title is required');
      const labelNames = Array.isArray(ctx.body?.labels)
        ? (ctx.body.labels as unknown[]).filter((label): label is string => typeof label === 'string')
        : [];
      const created = ctx.store.createIssue(repo, title, asString(ctx.body?.body), labelNames);
      if ('error' in created) return error(422, created.error);
      return ok(201, issueJson(ctx.store, repo, created));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      return ok(200, list.map((issue) => issueJson(ctx.store, repo, issue)));
    }
    return error(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return error(404, 'Not Found');
  if (rest.length === 2 && rest[1] === 'comments') {
    const issue = repo.issues.get(number) ?? repo.pulls.get(number);
    if (!issue) return error(404, 'Not Found');
    if (method === 'POST') {
      const body = asString(ctx.body?.body);
      if (body === '') return error(422, 'body is required');
      const comment = ctx.store.createComment(repo, number, body);
      return ok(201, {
        id: comment.id,
        body: comment.body,
        user: userJson(ctx.store),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
      });
    }
    if (method === 'GET') {
      return ok(200, ctx.store.commentsOf(repo, number).map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: userJson(ctx.store),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
      })));
    }
    return error(404, 'Not Found');
  }
  if (rest.length === 1) {
    const issue = repo.issues.get(number);
    if (!issue) return error(404, 'Not Found');
    if (method === 'GET') return ok(200, issueJson(ctx.store, repo, issue));
    if (method === 'PATCH') {
      if (typeof ctx.body?.title === 'string') issue.title = ctx.body.title;
      if (typeof ctx.body?.body === 'string') issue.body = ctx.body.body;
      if (ctx.body?.state === 'open' || ctx.body?.state === 'closed') {
        issue.state = ctx.body.state;
        issue.closedAt = issue.state === 'closed' ? ctx.store.nowIso() : null;
      }
      issue.updatedAt = ctx.store.nowIso();
      return ok(200, issueJson(ctx.store, repo, issue));
    }
    return error(404, 'Not Found');
  }
  return error(404, 'Not Found');
}

// ---------------------------------------------------------------- pull requests

function pulls(ctx: Ctx, repo: Repo, method: string, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = asString(ctx.body?.title);
      const head = asString(ctx.body?.head);
      const base = asString(ctx.body?.base, DEFAULT_BRANCH);
      if (title === '' || head === '') return error(422, 'title and head are required');
      const created = ctx.store.createPull(repo, title, asString(ctx.body?.body), head, base);
      if ('error' in created) return error(created.status, created.error);
      return ok(201, pullJson(ctx.store, repo, created));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return ok(200, list.map((pull) => pullJson(ctx.store, repo, pull)));
    }
    return error(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return error(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return error(404, 'Not Found');
  ctx.store.refreshPull(repo, pull);
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    return ok(200, ctx.store.pullFiles(repo, pull));
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const merged = ctx.store.mergePull(repo, pull);
    if ('error' in merged) return error(merged.status, merged.error);
    return ok(200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  if (rest.length === 1) {
    if (method === 'GET') return ok(200, pullJson(ctx.store, repo, pull));
    if (method === 'PATCH') {
      if (typeof ctx.body?.title === 'string') pull.title = ctx.body.title;
      if (typeof ctx.body?.body === 'string') pull.body = ctx.body.body;
      if (ctx.body?.state === 'closed' && pull.state === 'open') {
        pull.state = 'closed';
        pull.closedAt = ctx.store.nowIso();
      }
      pull.updatedAt = ctx.store.nowIso();
      return ok(200, pullJson(ctx.store, repo, pull));
    }
    return error(404, 'Not Found');
  }
  return error(404, 'Not Found');
}
