// The forge's store: one in-memory home for every repository, git object,
// ref, issue, pull request, label and comment, plus the helpers that build
// commits and trees, diff them, and squash-merge pull requests.
//
// Everything lives in Maps; nothing touches the disk. Timestamps are
// deterministic: a fixed base (the trial's own now when the harness sets it)
// plus a monotonic counter, so two runs on the same instance agree.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { viewerIdentity, type ViewerIdentity } from './scenario.ts';

export const DEFAULT_BRANCH = 'main';

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly user: ViewerIdentity;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly seq: number;
}

export interface Comment {
  readonly id: number;
  readonly issueNumber: number;
  body: string;
  readonly user: ViewerIdentity;
  readonly createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly user: ViewerIdentity;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  readonly labels: Map<string, Label>;
  readonly comments: Map<number, Comment>;
  nextNumber: number;
  readonly createdSeq: number;
}

const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? '';
const BASE_EPOCH_MS = (() => {
  const parsed = Date.parse(TRIAL_NOW);
  return Number.isFinite(parsed) ? parsed : Date.parse('2025-01-01T00:00:00.000Z');
})();
/** Git commit timestamps start here and tick up one second per commit. */
const BASE_EPOCH_SEC = Math.floor(BASE_EPOCH_MS / 1000);

/** One store for the whole process. */
export class Store {
  readonly viewer = viewerIdentity();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextLabelId = 1;
  private nextCommentId = 1;
  private nextRepoSeq = 1;
  private clockTicks = 0;
  private commitTicks = 0;

  /** A deterministic ISO timestamp, one second later than the last one issued. */
  nowIso(): string {
    const ms = BASE_EPOCH_MS + this.clockTicks * 1000;
    this.clockTicks += 1;
    return new Date(ms).toISOString();
  }

  /** A deterministic commit timestamp (unix seconds), ticking up per commit. */
  nextCommitTime(): number {
    const time = BASE_EPOCH_SEC + this.commitTicks;
    this.commitTicks += 1;
    return time;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === this.viewer.login)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo | { error: string } {
    if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      return { error: 'name is invalid' };
    }
    const key = this.repoKey(this.viewer.login, name);
    if (this.repos.has(key)) return { error: `Repository ${this.viewer.login}/${name} already exists` };
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewer.login,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      createdSeq: this.nextRepoSeq,
    };
    this.nextRepoId += 1;
    this.nextRepoSeq += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, a full ref or an oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref) && repo.objects.has(ref)) return peelToCommit(ref, this.lookup(repo)) ?? undefined;
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const tip = repo.refs.get(full);
    if (tip === undefined) return undefined;
    return peelToCommit(tip, this.lookup(repo)) ?? undefined;
  }

  /** The commit oid a branch name points at (no peeling: branches point at commits). */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  // ---------------------------------------------------------------- trees

  /** Flatten a tree into path -> {mode, oid}, recursively. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out: Map<string, TreeEntry> = new Map()): Map<string, TreeEntry> {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, { mode: entry.mode, name: path, oid: entry.oid });
    }
    return out;
  }

  /** The flattened tree of a commit (empty when the commit is null). */
  treeOfCommit(repo: Repo, commitOid: string | null): Map<string, TreeEntry> {
    if (commitOid === null) return new Map();
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(object.data).tree);
  }

  /** Build (and store) the tree for a flattened path map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, files: ReadonlyMap<string, TreeEntry>): string {
    interface Node {
      files: Map<string, TreeEntry>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        let child = node.dirs.get(name);
        if (!child) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The blob oid at `path` in a commit's tree, or undefined. */
  blobAt(repo: Repo, commitOid: string | null, path: string): string | undefined {
    return this.treeOfCommit(repo, commitOid).get(path)?.oid;
  }

  /** The tree oid of the directory `dir` in a commit ('' is the root), or undefined. */
  dirTreeAt(repo: Repo, commitOid: string | null, dir: string): string | undefined {
    if (commitOid === null) return undefined;
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    let treeOid = parseCommit(object.data).tree;
    if (dir === '') return treeOid;
    for (const segment of dir.split('/')) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return undefined;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return undefined;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  // ---------------------------------------------------------------- commits

  /** Create a commit on top of `parent` (null for a root), applying file changes. */
  commitFiles(
    repo: Repo,
    parent: string | null,
    changes: ReadonlyMap<string, Buffer | null>,
    message: string,
  ): string {
    const files = this.treeOfCommit(repo, parent);
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else files.set(path, { mode: '100644', name: path, oid: this.putObject(repo, 'blob', content) });
    }
    const tree = this.buildTreeFromMap(repo, files);
    const who = `${this.viewer.name} <${this.viewer.email}>`;
    const commit = buildCommit({
      tree,
      parents: parent === null ? [] : [parent],
      message,
      author: who,
      committer: who,
      timestamp: this.nextCommitTime(),
    });
    return this.putObject(repo, 'commit', commit);
  }

  /** The commit history from `tip`, newest first (following first parents). */
  commitHistory(repo: Repo, tip: string | undefined, limit = 100): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let current = tip;
    while (current !== undefined && out.length < limit && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') break;
      out.push(current);
      current = parseCommit(object.data).parents[0];
    }
    return out;
  }

  // ---------------------------------------------------------------- issues, labels, comments

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: this.nextLabelId, name, color: color || 'ededed', description: '' };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label "${name}" does not exist` };
      labels.push(label);
    }
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      user: this.viewer,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      seq: this.clockTicks,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment {
    const now = this.nowIso();
    const comment: Comment = {
      id: this.nextCommentId,
      issueNumber,
      body,
      user: this.viewer,
      createdAt: now,
      updatedAt: now,
    };
    this.nextCommentId += 1;
    repo.comments.set(comment.id, comment);
    return comment;
  }

  commentsOf(repo: Repo, issueNumber: number): Comment[] {
    return [...repo.comments.values()]
      .filter((comment) => comment.issueNumber === issueNumber)
      .sort((a, b) => a.id - b.id);
  }

  // ---------------------------------------------------------------- pull requests

  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): PullRequest | { error: string; status: number } {
    const headSha = this.branchTip(repo, head);
    if (headSha === undefined) return { error: `head branch "${head}" does not exist`, status: 422 };
    const baseSha = this.branchTip(repo, base);
    if (baseSha === undefined) return { error: `base branch "${base}" does not exist`, status: 422 };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        return { error: `a pull request already exists for ${head} into ${base}`, status: 422 };
      }
    }
    const now = this.nowIso();
    const pull: PullRequest = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      user: this.viewer,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      seq: this.clockTicks,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Refresh a pull's head/base shas from the live refs (branches move). */
  refreshPull(repo: Repo, pull: PullRequest): void {
    const headSha = this.branchTip(repo, pull.headRef);
    if (headSha !== undefined) pull.headSha = headSha;
    const baseSha = this.branchTip(repo, pull.baseRef);
    if (baseSha !== undefined) pull.baseSha = baseSha;
  }

  /** The three-way merge of `pull`: the merged file map, or the conflicting paths. */
  mergePlan(
    repo: Repo,
    pull: PullRequest,
  ): { merged: Map<string, TreeEntry>; conflicts: string[] } {
    const lookup = this.lookup(repo);
    const baseCommit = mergeBase(pull.baseSha, pull.headSha, lookup);
    const baseFiles = this.treeOfCommit(repo, baseCommit);
    const oursFiles = this.treeOfCommit(repo, pull.baseSha);
    const theirsFiles = this.treeOfCommit(repo, pull.headSha);
    const merged = new Map<string, TreeEntry>();
    const conflicts: string[] = [];
    const paths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const path of paths) {
      const base = baseFiles.get(path)?.oid;
      const ours = oursFiles.get(path);
      const theirs = theirsFiles.get(path);
      const oursOid = ours?.oid;
      const theirsOid = theirs?.oid;
      if (oursOid === theirsOid) {
        if (ours) merged.set(path, ours);
        continue;
      }
      if (base === oursOid) {
        // Only the head side changed: take theirs (or delete when theirs is gone).
        if (theirs) merged.set(path, theirs);
        continue;
      }
      if (base === theirsOid) {
        if (ours) merged.set(path, ours);
        continue;
      }
      conflicts.push(path);
    }
    return { merged, conflicts };
  }

  /** Squash-merge an open pull request onto its base branch. */
  mergePull(repo: Repo, pull: PullRequest): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'pull request is already closed', status: 405 };
    this.refreshPull(repo, pull);
    const { merged, conflicts } = this.mergePlan(repo, pull);
    if (conflicts.length > 0) {
      return { error: `merge conflict in ${conflicts.join(', ')}`, status: 405 };
    }
    const tree = this.buildTreeFromMap(repo, merged);
    const who = `${this.viewer.name} <${this.viewer.email}>`;
    const message = `${pull.title} (#${pull.number})\n\n${pull.body}`.trimEnd();
    const commit = buildCommit({
      tree,
      parents: [pull.baseSha],
      message,
      author: who,
      committer: who,
      timestamp: this.nextCommitTime(),
    });
    const sha = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    const now = this.nowIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
    pull.baseSha = sha;
    return { sha };
  }

  /** The files a pull request changes, base tip vs head tip, with line counts. */
  pullFiles(
    repo: Repo,
    pull: PullRequest,
  ): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseFiles = this.treeOfCommit(repo, pull.baseSha);
    const headFiles = this.treeOfCommit(repo, pull.headSha);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base?.oid === head?.oid) continue;
      const baseText = base ? (repo.objects.get(base.oid)?.data.toString('utf8') ?? '') : null;
      const headText = head ? (repo.objects.get(head.oid)?.data.toString('utf8') ?? '') : null;
      const count = (text: string | null): number => (text === null ? 0 : text.split('\n').length);
      let additions: number;
      let deletions: number;
      let status: string;
      if (baseText === null) {
        status = 'added';
        additions = count(headText);
        deletions = 0;
      } else if (headText === null) {
        status = 'removed';
        additions = 0;
        deletions = count(baseText);
      } else {
        status = 'modified';
        const baseLines = new Map<string, number>();
        for (const line of baseText.split('\n')) baseLines.set(line, (baseLines.get(line) ?? 0) + 1);
        additions = 0;
        for (const line of headText.split('\n')) {
          const left = baseLines.get(line) ?? 0;
          if (left > 0) baseLines.set(line, left - 1);
          else additions += 1;
        }
        const headLines = new Map<string, number>();
        for (const line of headText.split('\n')) headLines.set(line, (headLines.get(line) ?? 0) + 1);
        deletions = 0;
        for (const line of baseText.split('\n')) {
          const left = headLines.get(line) ?? 0;
          if (left > 0) headLines.set(line, left - 1);
          else deletions += 1;
        }
        if (additions === 0 && deletions === 0) {
          // Same lines, different bytes (or a trailing-newline change): still a change.
          additions = 1;
        }
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  // ---------------------------------------------------------------- git helpers

  /** True when `newOid` is a fast-forward of `oldOid` (or the ref is new). */
  isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
    if (oldOid === '0'.repeat(40)) return true;
    if (oldOid === newOid) return true;
    return isAncestor(oldOid, newOid, this.lookup(repo));
  }

  /** The objects reachable from `tips` that are not reachable from `haves`. */
  objectsForFetch(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    shallowBoundary: readonly string[],
    depth: number | null,
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    const lookup = this.lookup(repo);
    const oldShallow = new Set(shallowBoundary);
    // The commits to send: within `depth` of a want (or the whole closure when depth is null).
    const includedCommits = new Set<string>();
    const boundary = new Set<string>();
    const queue: Array<{ oid: string; distance: number }> = [];
    const tagObjects = new Set<string>();
    for (const want of wants) {
      const object = lookup(want);
      if (!object) continue;
      if (object.type === 'tag') {
        tagObjects.add(want);
        const target = peelToCommit(want, lookup);
        if (target !== null) queue.push({ oid: target, distance: 0 });
      } else if (object.type === 'commit') {
        queue.push({ oid: want, distance: 0 });
      } else {
        // A want naming a tree or blob directly: include it alone.
        includedCommits.add(want);
      }
    }
    const seenDistance = new Map<string, number>();
    while (queue.length) {
      const { oid, distance } = queue.shift() as { oid: string; distance: number };
      const known = seenDistance.get(oid);
      if (known !== undefined && known <= distance) continue;
      seenDistance.set(oid, distance);
      if (depth !== null && distance >= depth) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      includedCommits.add(oid);
      const parents = parseCommit(object.data).parents;
      const atBoundary = depth !== null && distance === depth - 1;
      if (atBoundary) boundary.add(oid);
      for (const parent of parents) queue.push({ oid: parent, distance: distance + 1 });
    }
    // Objects to send: each included commit plus its tree closure, plus wanted tags.
    const included = new Set<string>();
    for (const oid of includedCommits) {
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        included.add(oid);
        for (const entry of collectReachable([parseCommit(object.data).tree], lookup)) included.add(entry);
      } else {
        for (const entry of collectReachable([oid], lookup)) included.add(entry);
      }
    }
    for (const oid of tagObjects) {
      included.add(oid);
      const target = parseTag((lookup(oid) as GitObject).data).object;
      const targetObject = lookup(target);
      if (targetObject && targetObject.type !== 'commit') {
        for (const entry of collectReachable([target], lookup)) included.add(entry);
      }
    }
    // What the client already holds: the closure of its haves, not descending
    // past an old shallow boundary (its ancestors were never sent).
    const held = new Set<string>();
    const heldQueue: string[] = [...haves];
    while (heldQueue.length) {
      const oid = heldQueue.pop() as string;
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        for (const entry of collectReachable([parseCommit(object.data).tree], lookup)) held.add(entry);
        if (!oldShallow.has(oid)) {
          for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
        }
      } else if (object.type === 'tag') {
        heldQueue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of collectReachable([oid], lookup)) held.add(entry);
      }
    }
    const objects: GitObject[] = [];
    for (const oid of included) {
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (object) objects.push(object);
    }
    // Deterministic pack order: commits first (newest last is fine), then trees, then blobs.
    const order: Record<GitObjectType, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
    objects.sort((a, b) => order[a.type] - order[b.type]);
    const shallow = [...boundary].sort();
    const unshallow = [...oldShallow].filter((oid) => includedCommits.has(oid) && !boundary.has(oid)).sort();
    return { objects, shallow, unshallow };
  }
}
