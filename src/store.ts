// In-memory Store for the forge (Worker A).
// Implements the Store API from docs/CONTRACT.md exactly.
// All timestamps are trialNow(); no Date.now(), no Math.random(), no wall clock.

import {
  VIEWER,
  trialNow,
  trialNowSeconds,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './types.ts';
import {
  makeBlob,
  makeCommit,
  makeTree,
  parseCommit,
  parseObject,
  parseTree,
  readTreeRecursive,
  treeDiff,
} from './git-objects.ts';

export class RepoExistsError extends Error {
  constructor(name: string) {
    super(`repository already exists: ${name}`);
    this.name = 'RepoExistsError';
  }
}

export class StaleShaError extends Error {
  constructor() {
    super('stale sha: the file has changed since the given sha');
    this.name = 'StaleShaError';
  }
}

export class UnknownLabelError extends Error {
  label: string;
  constructor(label: string) {
    super(`unknown label: ${label}`);
    this.name = 'UnknownLabelError';
    this.label = label;
  }
}

const AUTHOR_NAME = 'adaiversen';
const AUTHOR_EMAIL = 'adaiversen@example.invalid';

interface FlatEntry {
  mode: string;
  sha: string;
}

export class Store {
  readonly viewer = VIEWER;
  private reposByName = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextEntityId = 1;
  private nextCommentId = 1;

  constructor() {}

  // ---------------------------------------------------------------- repos

  createRepo(name: string, isPrivate: boolean, description: string | null): Repo {
    if (this.reposByName.has(name)) throw new RepoExistsError(name);
    const now = trialNow();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER,
      private: isPrivate,
      description: description ?? null,
      default_branch: 'main',
      created_at: now,
      updated_at: now,
      pushed_at: now,
      refs: new Map<string, string>(),
      objects: new Map<string, Buffer>(),
      nextNumber: 1,
      nextLabelId: 1,
      labels: new Map<string, Label>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, Pull>(),
    };
    this.nextRepoId += 1;
    this.reposByName.set(name, repo);
    return repo;
  }

  getRepo(ownerLogin: string, name: string): Repo | undefined {
    if (ownerLogin !== this.viewer.login) return undefined;
    return this.reposByName.get(name);
  }

  listViewerRepos(): Repo[] {
    return [...this.reposByName.values()];
  }

  deleteRepo(ownerLogin: string, name: string): boolean {
    if (ownerLogin !== this.viewer.login) return false;
    return this.reposByName.delete(name);
  }

  updateRepo(
    ownerLogin: string,
    name: string,
    patch: { description?: string | null },
  ): Repo | undefined {
    const repo = this.getRepo(ownerLogin, name);
    if (repo === undefined) return undefined;
    if (patch.description !== undefined) repo.description = patch.description;
    repo.updated_at = trialNow();
    return repo;
  }

  // ---------------------------------------------------------------- git refs / commits

  createBranch(repo: Repo, branch: string, sha: string): { ref: string; sha: string } {
    if (!repo.objects.has(sha)) throw new Error(`unknown sha: ${sha}`);
    const ref = `refs/heads/${branch}`;
    repo.refs.set(ref, sha);
    return { ref, sha };
  }

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    return out;
  }

  /** Resolve a ref argument (branch name, full ref, or commit sha) to a commit sha. */
  private resolveRef(repo: Repo, ref?: string): string | undefined {
    if (ref === undefined || ref === '') {
      return repo.refs.get(`refs/heads/${repo.default_branch}`);
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const branchTip = repo.refs.get(`refs/heads/${ref}`);
    if (branchTip !== undefined) return branchTip;
    if (repo.objects.has(ref)) return ref;
    return undefined;
  }

  listCommits(repo: Repo, ref?: string): { sha: string; message: string }[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return [];
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    let current: string | undefined = tip;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const raw = repo.objects.get(current);
      if (raw === undefined) break;
      const parsed = parseCommit(parseObject(raw).payload);
      out.push({ sha: current, message: parsed.message });
      current = parsed.parents[0];
    }
    return out;
  }

  // ---------------------------------------------------------------- contents

  private treeShaOfCommit(repo: Repo, commitSha: string): string | undefined {
    const raw = repo.objects.get(commitSha);
    if (raw === undefined) return undefined;
    return parseCommit(parseObject(raw).payload).tree;
  }

  private flatMap(repo: Repo, commitSha: string | undefined): Map<string, FlatEntry> {
    if (commitSha === undefined) return new Map();
    const treeSha = this.treeShaOfCommit(repo, commitSha);
    if (treeSha === undefined) return new Map();
    return readTreeRecursive(repo.objects, treeSha);
  }

  /** Build (and store) nested trees for a flat path map; returns the root tree sha. */
  private buildTrees(repo: Repo, flat: Map<string, FlatEntry>): string {
    const build = (dir: string): string => {
      const entries: { mode: string; name: string; sha: string }[] = [];
      const subdirs = new Set<string>();
      for (const [path, entry] of flat) {
        if (dir === '') {
          const slash = path.indexOf('/');
          if (slash === -1) entries.push({ mode: entry.mode, name: path, sha: entry.sha });
          else subdirs.add(path.slice(0, slash));
        } else {
          const prefix = `${dir}/`;
          if (!path.startsWith(prefix)) continue;
          const rel = path.slice(prefix.length);
          const slash = rel.indexOf('/');
          if (slash === -1) entries.push({ mode: entry.mode, name: rel, sha: entry.sha });
          else subdirs.add(rel.slice(0, slash));
        }
      }
      for (const sub of subdirs) {
        entries.push({ mode: '40000', name: sub, sha: build(dir === '' ? sub : `${dir}/${sub}`) });
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const { sha, raw } = makeTree(entries);
      repo.objects.set(sha, raw);
      return sha;
    };
    return build('');
  }

  private commitTree(
    repo: Repo,
    flat: Map<string, FlatEntry>,
    parentTip: string | undefined,
    message: string,
  ): string {
    const treeSha = this.buildTrees(repo, flat);
    const { sha, raw } = makeCommit({
      tree: treeSha,
      parents: parentTip === undefined ? [] : [parentTip],
      message,
      authorName: AUTHOR_NAME,
      authorEmail: AUTHOR_EMAIL,
      timestamp: trialNowSeconds(),
    });
    repo.objects.set(sha, raw);
    return sha;
  }

  putContent(
    repo: Repo,
    path: string,
    o: { message: string; contentB64: string; branch?: string; sha?: string },
  ): { status: 201 | 200; contentSha: string; commitSha: string } {
    const branch = o.branch ?? repo.default_branch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined && repo.refs.size > 0) {
      throw new Error(`unknown branch: ${branch}`);
    }
    const content = Buffer.from(o.contentB64, 'base64');
    const { sha: blobSha, raw: blobRaw } = makeBlob(content);
    repo.objects.set(blobSha, blobRaw);

    const flat = this.flatMap(repo, tip);
    const existing = flat.get(path);
    if (o.sha !== undefined) {
      if (existing === undefined || existing.sha !== o.sha) throw new StaleShaError();
    }
    const isCreate = existing === undefined;
    flat.set(path, { mode: '100644', sha: blobSha });
    const commitSha = this.commitTree(repo, flat, tip, o.message);
    repo.refs.set(ref, commitSha);
    repo.updated_at = trialNow();
    repo.pushed_at = trialNow();
    return { status: isCreate ? 201 : 200, contentSha: blobSha, commitSha };
  }

  getContent(
    repo: Repo,
    path: string,
    ref?: string,
  ):
    | { kind: 'file'; sha: string; size: number; contentB64: string }
    | { kind: 'dir'; entries: { name: string; type: 'file' | 'dir'; sha: string; size: number }[] }
    | undefined {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return undefined;
    const treeSha = this.treeShaOfCommit(repo, tip);
    if (treeSha === undefined) return undefined;

    const flat = readTreeRecursive(repo.objects, treeSha);
    const file = flat.get(path);
    if (file !== undefined) {
      const raw = repo.objects.get(file.sha);
      if (raw === undefined) return undefined;
      const payload = parseObject(raw).payload;
      return { kind: 'file', sha: file.sha, size: payload.length, contentB64: payload.toString('base64') };
    }

    // Directory listing: walk to the subtree for `path` ('' = root).
    let dirTreeSha: string | undefined = treeSha;
    if (path !== '') {
      for (const segment of path.split('/')) {
        if (dirTreeSha === undefined) return undefined;
        const raw = repo.objects.get(dirTreeSha);
        if (raw === undefined) return undefined;
        const entries = parseTree(parseObject(raw).payload);
        const found = entries.find((e) => e.name === segment && e.mode === '40000');
        if (found === undefined) return undefined;
        dirTreeSha = found.sha;
      }
    }
    if (dirTreeSha === undefined) return undefined;
    const raw = repo.objects.get(dirTreeSha);
    if (raw === undefined) return undefined;
    const entries = parseTree(parseObject(raw).payload)
      .map((entry) => {
        if (entry.mode === '40000') {
          return { name: entry.name, type: 'dir' as const, sha: entry.sha, size: 0 };
        }
        const blobRaw = repo.objects.get(entry.sha);
        const size = blobRaw === undefined ? 0 : parseObject(blobRaw).payload.length;
        return { name: entry.name, type: 'file' as const, sha: entry.sha, size };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: 'dir', entries };
  }

  deleteContent(
    repo: Repo,
    path: string,
    o: { message: string; sha?: string; branch?: string },
  ): { commitSha: string } | undefined {
    const branch = o.branch ?? repo.default_branch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return undefined;
    const flat = this.flatMap(repo, tip);
    const existing = flat.get(path);
    if (existing === undefined) return undefined;
    if (o.sha !== undefined && existing.sha !== o.sha) throw new StaleShaError();
    flat.delete(path);
    const commitSha = this.commitTree(repo, flat, tip, o.message);
    repo.refs.set(ref, commitSha);
    repo.updated_at = trialNow();
    repo.pushed_at = trialNow();
    return { commitSha };
  }

  // ---------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color?: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = {
      id: repo.nextLabelId,
      name,
      color: color ?? 'ededed',
      description: null,
    };
    repo.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, o: { title: string; body?: string | null; labels?: string[] }): Issue {
    const labels: Label[] = [];
    for (const name of o.labels ?? []) {
      const label = repo.labels.get(name);
      if (label === undefined) throw new UnknownLabelError(name);
      labels.push(label);
    }
    const now = trialNow();
    const issue: Issue = {
      id: this.nextEntityId,
      number: repo.nextNumber,
      repoId: repo.id,
      title: o.title,
      body: o.body ?? null,
      state: 'open',
      labels,
      user: VIEWER,
      created_at: now,
      updated_at: now,
      comments: [],
    };
    this.nextEntityId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  listIssues(
    repo: Repo,
    o?: { state?: 'open' | 'closed' | 'all'; sort?: 'created' | 'updated'; direction?: 'asc' | 'desc' },
  ): Issue[] {
    const state = o?.state ?? 'all';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = o?.direction ?? 'desc';
    // created_at/updated_at are all the same constant, so number order is the
    // creation order; sort by number, direction decides ascending/descending.
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return list;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  updateIssue(
    repo: Repo,
    number: number,
    patch: { state?: 'open' | 'closed'; title?: string; body?: string | null },
  ): Issue | undefined {
    const issue = repo.issues.get(number);
    if (issue === undefined) return undefined;
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updated_at = trialNow();
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment | undefined {
    const issue = repo.issues.get(issueNumber);
    if (issue === undefined) return undefined;
    const now = trialNow();
    const comment: Comment = {
      id: this.nextCommentId,
      body,
      user: VIEWER,
      created_at: now,
      updated_at: now,
    };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    return repo.issues.get(issueNumber)?.comments ?? [];
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, o: { title: string; body?: string | null; head: string; base: string }): Pull {
    const headSha = repo.refs.get(`refs/heads/${o.head}`);
    const baseSha = repo.refs.get(`refs/heads/${o.base}`);
    if (headSha === undefined) throw new Error(`unknown branch: ${o.head}`);
    if (baseSha === undefined) throw new Error(`unknown branch: ${o.base}`);
    const now = trialNow();
    const pull: Pull = {
      id: this.nextEntityId,
      number: repo.nextNumber,
      repoId: repo.id,
      title: o.title,
      body: o.body ?? null,
      state: 'open',
      merged: false,
      head: { ref: o.head, sha: headSha },
      base: { ref: o.base, sha: baseSha },
      mergeable: true,
      user: VIEWER,
      created_at: now,
      updated_at: now,
      merged_at: null,
      merge_commit_sha: null,
    };
    this.nextEntityId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  listPulls(repo: Repo, o?: { state?: 'open' | 'closed' | 'all' }): Pull[] {
    const state = o?.state ?? 'open';
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => a.number - b.number);
    return list;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  listPullFiles(
    repo: Repo,
    number: number,
  ): { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[] {
    const pull = repo.pulls.get(number);
    if (pull === undefined) return [];
    const oldTree = this.treeShaOfCommit(repo, pull.base.sha);
    const newTree = this.treeShaOfCommit(repo, pull.head.sha);
    if (oldTree === undefined || newTree === undefined) return [];
    const diffs = treeDiff(repo.objects, oldTree, newTree);
    return diffs.map((diff) => {
      const oldText = diff.oldSha === undefined ? '' : blobText(repo, diff.oldSha);
      const newText = diff.newSha === undefined ? '' : blobText(repo, diff.newSha);
      const { additions, deletions } = lineDiff(oldText, newText);
      return {
        filename: diff.path,
        status: diff.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }

  mergePull(repo: Repo, number: number): { sha: string; merged: true; message: string } | 'not-found' | 'conflicted' {
    const pull = repo.pulls.get(number);
    if (pull === undefined) return 'not-found';
    if (pull.state === 'closed') return 'conflicted';
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    if (baseTip === undefined || headTip === undefined) return 'not-found';

    // Conflict condition (exactly the one checks-rest.ts's merge-conflict check
    // exercises): a path changed on BOTH sides since the merge-base, with
    // different resulting content, cannot be squash-merged.
    const mergeBase = findMergeBase(repo, headTip, baseTip);
    const baseTree = this.treeShaOfCommit(repo, baseTip);
    const headTree = this.treeShaOfCommit(repo, headTip);
    const mergeBaseTree = mergeBase === undefined ? null : this.treeShaOfCommit(repo, mergeBase);
    if (baseTree === undefined || headTree === undefined) return 'conflicted';
    const baseChanges = new Map(
      treeDiff(repo.objects, mergeBaseTree ?? null, baseTree).map((d) => [d.path, d.newSha]),
    );
    const headChanges = treeDiff(repo.objects, mergeBaseTree ?? null, headTree);
    for (const change of headChanges) {
      if (baseChanges.has(change.path) && baseChanges.get(change.path) !== change.newSha) {
        return 'conflicted';
      }
    }

    const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
    const { sha, raw } = makeCommit({
      tree: headTree,
      parents: [baseTip],
      message,
      authorName: AUTHOR_NAME,
      authorEmail: AUTHOR_EMAIL,
      timestamp: trialNowSeconds(),
    });
    repo.objects.set(sha, raw);
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = trialNow();
    pull.merge_commit_sha = sha;
    pull.updated_at = trialNow();
    repo.updated_at = trialNow();
    repo.pushed_at = trialNow();
    return { sha, merged: true, message };
  }
}

function blobText(repo: Repo, sha: string): string {
  const raw = repo.objects.get(sha);
  if (raw === undefined) return '';
  return parseObject(raw).payload.toString('utf8');
}

/** Added/deleted line counts between two texts (multiset line diff). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    if (text === '') return counts;
    for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const oldCounts = countLines(oldText);
  const newCounts = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(line) ?? 0));
  for (const [line, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

/** First common ancestor of two commits, walking first-parent chains. */
function findMergeBase(repo: Repo, headTip: string, baseTip: string): string | undefined {
  const baseAncestors = new Set<string>();
  let current: string | undefined = baseTip;
  while (current !== undefined && !baseAncestors.has(current)) {
    baseAncestors.add(current);
    const raw = repo.objects.get(current);
    if (raw === undefined) break;
    current = parseCommit(parseObject(raw).payload).parents[0];
  }
  current = headTip;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (baseAncestors.has(current)) return current;
    const raw = repo.objects.get(current);
    if (raw === undefined) break;
    current = parseCommit(parseObject(raw).payload).parents[0];
  }
  return undefined;
}
