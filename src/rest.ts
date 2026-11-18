// REST v3 router for the forge (Worker A).
// Mounted by the coordinator: handleRest(req, res, store, auth?).
//   - req/res: node:http IncomingMessage / ServerResponse
//   - store: the shared Store instance
//   - auth: optional; a token string, { token }, or a (req) => boolean checker.
//     Defaults to process.env.MAKEFUN_SHOP_TOKEN; when that is empty any
//     non-empty Bearer token is accepted.
// Every reply is application/json with a sequential X-GitHub-Request-Id
// ("req-<n>"). Errors are JSON {"message": string}. Unknown route: 404 JSON.
// Malformed JSON body: 400 JSON. Missing/wrong token: 401 JSON.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { RepoExistsError, StaleShaError, Store, UnknownLabelError } from './store.ts';
import { trialNow, type Comment, type Issue, type Label, type Pull, type Repo } from './types.ts';

let requestCounter = 0;

type AuthArg = string | { token?: string } | ((req: IncomingMessage) => boolean) | undefined;

function expectedToken(auth: AuthArg): string {
  if (typeof auth === 'string') return auth;
  if (auth !== undefined && typeof auth === 'object' && typeof auth.token === 'string') return auth.token;
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(req: IncomingMessage, auth: AuthArg): boolean {
  if (typeof auth === 'function') {
    try {
      return auth(req) === true;
    } catch {
      return false;
    }
  }
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const token = (match[1] ?? '').trim();
  if (token === '') return false;
  const expected = expectedToken(auth);
  if (expected === '') return true;
  return token === expected;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': `req-${requestCounter}`,
    ...extraHeaders,
  };
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, headers);
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function paginate<T>(
  req: IncomingMessage,
  url: URL,
  items: T[],
): { pageItems: T[]; linkHeader: string | null } {
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const total = items.length;
  if (start + perPage >= total) return { pageItems, linkHeader: null };
  const build = (p: number): string => {
    const next = new URL(`${baseUrlOf(req)}${url.pathname}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('page', String(p));
    next.searchParams.set('per_page', String(perPage));
    return next.toString();
  };
  const lastPage = Math.ceil(total / perPage);
  const linkHeader = `<${build(page + 1)}>; rel="next", <${build(lastPage)}>; rel="last"`;
  return { pageItems, linkHeader };
}

// ---------------------------------------------------------------- serializers

function userJson(user: { login: string; id: number }): { login: string; id: number } {
  return { login: user.login, id: user.id };
}

function repoJson(req: IncomingMessage, repo: Repo): Record<string, unknown> {
  const base = baseUrlOf(req);
  const fullName = `${repo.owner.login}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: fullName,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    html_url: `${base}/${fullName}`,
    url: `${base}/api/v3/repos/${fullName}`,
    clone_url: `${base}/${fullName}.git`,
    git_url: `git://${req.headers.host ?? 'localhost'}/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

function issueJson(req: IncomingMessage, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = baseUrlOf(req);
  const fullName = `${repo.owner.login}/${repo.name}`;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `${base}/${fullName}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${fullName}/issues/${issue.number}`,
  };
}

function pullJson(req: IncomingMessage, repo: Repo, pull: Pull): Record<string, unknown> {
  const base = baseUrlOf(req);
  const fullName = `${repo.owner.login}/${repo.name}`;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    mergeable: pull.mergeable,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: userJson(pull.user),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `${base}/${fullName}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${fullName}/pulls/${pull.number}`,
  };
}

function commentJson(req: IncomingMessage, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  const base = baseUrlOf(req);
  const fullName = `${repo.owner.login}/${repo.name}`;
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `${base}/${fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${base}/api/v3/repos/${fullName}/issues/comments/${comment.id}`,
  };
}

// ---------------------------------------------------------------- router

/**
 * Handle one request. Returns true when the path is under /api/v3 (handled,
 * including the 404-JSON for unknown /api/v3 routes); false otherwise so the
 * coordinator can fall through to another handler.
 */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  auth?: AuthArg,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;

  requestCounter += 1;
  const method = (req.method ?? 'GET').toUpperCase();

  if (!isAuthorized(req, auth)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  // Parse a JSON body when one is present (POST/PUT/PATCH/DELETE).
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    let raw = '';
    try {
      raw = await readBody(req);
    } catch {
      sendError(res, 400, 'Could not read request body');
      return true;
    }
    if (raw.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(raw);
        body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        sendError(res, 400, 'Malformed JSON in request body');
        return true;
      }
    }
  }

  const segments = pathname
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const seg = (i: number): string | undefined => segments[i];

  const strField = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  const boolField = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;

  // -- root -----------------------------------------------------------------
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, {}, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // -- /meta ----------------------------------------------------------------
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // -- /user/repos ----------------------------------------------------------
  if (segments.length === 2 && seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'GET') {
      const { pageItems, linkHeader } = paginate(req, url, store.listViewerRepos());
      sendJson(res, 200, pageItems.map((repo) => repoJson(req, repo)), linkHeader === null ? {} : { link: linkHeader });
      return true;
    }
    if (method === 'POST') {
      const name = strField(body.name);
      if (name === undefined || name === '') {
        sendError(res, 422, 'Repository name is required');
        return true;
      }
      try {
        const repo = store.createRepo(name, boolField(body.private, false), (body.description as string | null) ?? null);
        sendJson(res, 201, repoJson(req, repo));
      } catch (err) {
        if (err instanceof RepoExistsError) sendError(res, 422, err.message);
        else throw err;
      }
      return true;
    }
    return notFound(res);
  }

  // -- /repos/{owner}/{repo}[...] -------------------------------------------
  if (seg(0) === 'repos' && segments.length >= 3) {
    const owner = seg(1) as string;
    const repoName = seg(2) as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const repoPath = `${owner}/${repoName}`;

    // /repos/{o}/{r}
    if (segments.length === 3) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(req, repo));
        return true;
      }
      if (method === 'PATCH') {
        const updated = store.updateRepo(owner, repoName, {
          description: body.description === undefined ? undefined : (body.description as string | null),
        });
        sendJson(res, 200, repoJson(req, updated as Repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        requestCounter -= 0; // counter already incremented for this request
        res.writeHead(204, {
          'content-type': 'application/json',
          'x-github-request-id': `req-${requestCounter}`,
        });
        res.end();
        return true;
      }
      return notFound(res);
    }

    const sub = seg(3) as string;

    // /git/refs
    if (sub === 'git' && segments.length === 5 && seg(4) === 'refs') {
      if (method !== 'POST') return notFound(res);
      const ref = strField(body.ref);
      const sha = strField(body.sha);
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/heads/')) {
        sendError(res, 422, 'ref must be refs/heads/<branch> with a sha');
        return true;
      }
      try {
        const created = store.createBranch(repo, ref.slice('refs/heads/'.length), sha);
        sendJson(res, 201, {
          ref: created.ref,
          object: { sha: created.sha, type: 'commit' },
          url: `${baseUrlOf(req)}/api/v3/repos/${repoPath}/git/refs/${encodeURIComponent(created.ref)}`,
        });
      } catch {
        sendError(res, 422, 'Invalid sha: object does not exist');
      }
      return true;
    }

    // /branches
    if (sub === 'branches' && segments.length === 4) {
      if (method !== 'GET') return notFound(res);
      const branches = store.listBranches(repo).map((b) => ({
        name: b.name,
        commit: { sha: b.sha, url: `${baseUrlOf(req)}/api/v3/repos/${repoPath}/commits/${b.sha}` },
        protected: false,
      }));
      sendJson(res, 200, branches);
      return true;
    }

    // /commits
    if (sub === 'commits' && segments.length === 4) {
      if (method !== 'GET') return notFound(res);
      const ref = url.searchParams.get('sha') ?? undefined;
      const commits = store.listCommits(repo, ref).map((c) => ({
        sha: c.sha,
        commit: {
          message: c.message,
          author: { name: 'adaiversen', email: 'adaiversen@example.invalid', date: trialNow() },
          committer: { name: 'adaiversen', email: 'adaiversen@example.invalid', date: trialNow() },
        },
        author: { login: store.viewer.login, id: store.viewer.id },
        committer: { login: store.viewer.login, id: store.viewer.id },
      }));
      const { pageItems, linkHeader } = paginate(req, url, commits);
      sendJson(res, 200, pageItems, linkHeader === null ? {} : { link: linkHeader });
      return true;
    }

    // /contents/{path...}
    if (sub === 'contents') {
      const contentPath = segments.slice(4).join('/');
      const ref = url.searchParams.get('ref') ?? undefined;
      if (method === 'GET') {
        const result = store.getContent(repo, contentPath, ref);
        if (result === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (result.kind === 'file') {
          const name = contentPath.split('/').pop() ?? contentPath;
          sendJson(res, 200, {
            name,
            path: contentPath,
            sha: result.sha,
            size: result.size,
            encoding: 'base64',
            content: result.contentB64,
            type: 'file',
            url: `${baseUrlOf(req)}/api/v3/repos/${repoPath}/contents/${contentPath}`,
            html_url: `${baseUrlOf(req)}/${repoPath}/blob/${repo.default_branch}/${contentPath}`,
            download_url: null,
          });
          return true;
        }
        sendJson(
          res,
          200,
          result.entries.map((entry) => ({
            name: entry.name,
            path: contentPath === '' ? entry.name : `${contentPath}/${entry.name}`,
            sha: entry.sha,
            size: entry.size,
            type: entry.type,
            url: `${baseUrlOf(req)}/api/v3/repos/${repoPath}/contents/${contentPath === '' ? entry.name : `${contentPath}/${entry.name}`}`,
          })),
        );
        return true;
      }
      if (method === 'PUT') {
        const message = strField(body.message) ?? '';
        const contentB64 = strField(body.content);
        if (contentB64 === undefined) {
          sendError(res, 422, 'content is required');
          return true;
        }
        try {
          // GitHub takes the target branch from the `ref` query parameter on a PUT
          // (the body's `branch` field is the older form); the suite commits to a
          // branch with `?ref=<branch>`, so the query is the fallback when the
          // body names no branch.
          const out = store.putContent(repo, contentPath, {
            message,
            contentB64,
            branch: strField(body.branch) ?? ref,
            sha: strField(body.sha),
          });
          const name = contentPath.split('/').pop() ?? contentPath;
          sendJson(res, out.status, {
            content: {
              name,
              path: contentPath,
              sha: out.contentSha,
              size: Buffer.from(contentB64, 'base64').length,
              encoding: 'base64',
              content: contentB64,
              type: 'file',
              url: `${baseUrlOf(req)}/api/v3/repos/${repoPath}/contents/${contentPath}`,
              html_url: `${baseUrlOf(req)}/${repoPath}/blob/${repo.default_branch}/${contentPath}`,
              download_url: null,
            },
            commit: { sha: out.commitSha, message },
          });
        } catch (err) {
          if (err instanceof StaleShaError) sendError(res, 409, err.message);
          else sendError(res, 422, err instanceof Error ? err.message : 'Could not create content');
        }
        return true;
      }
      if (method === 'DELETE') {
        try {
          const out = store.deleteContent(repo, contentPath, {
            message: strField(body.message) ?? '',
            sha: strField(body.sha),
            branch: strField(body.branch),
          });
          if (out === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, { commit: { sha: out.commitSha } });
        } catch (err) {
          if (err instanceof StaleShaError) sendError(res, 409, err.message);
          else sendError(res, 422, err instanceof Error ? err.message : 'Could not delete content');
        }
        return true;
      }
      return notFound(res);
    }

    // /labels
    if (sub === 'labels' && segments.length === 4) {
      if (method !== 'POST') return notFound(res);
      const name = strField(body.name);
      if (name === undefined || name === '') {
        sendError(res, 422, 'Label name is required');
        return true;
      }
      const label = store.createLabel(repo, name, strField(body.color));
      sendJson(res, 201, labelJson(label));
      return true;
    }

    // /issues...
    if (sub === 'issues') {
      if (segments.length === 4) {
        if (method === 'POST') {
          const title = strField(body.title);
          if (title === undefined || title === '') {
            sendError(res, 422, 'Title is required');
            return true;
          }
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels: string[] = rawLabels.map((l) =>
            typeof l === 'string' ? l : (l as { name?: unknown }).name,
          ).filter((l): l is string => typeof l === 'string');
          try {
            const issue = store.createIssue(repo, {
              title,
              body: (body.body as string | null) ?? null,
              labels,
            });
            sendJson(res, 201, issueJson(req, repo, issue));
          } catch (err) {
            if (err instanceof UnknownLabelError) sendError(res, 422, err.message);
            else throw err;
          }
          return true;
        }
        if (method === 'GET') {
          const stateParam = url.searchParams.get('state') ?? 'open';
          const state = stateParam === 'open' || stateParam === 'closed' || stateParam === 'all'
            ? stateParam
            : 'open';
          const sortParam = url.searchParams.get('sort');
          const sort = sortParam === 'updated' ? 'updated' : 'created';
          const dirParam = url.searchParams.get('direction');
          const direction = dirParam === 'asc' ? 'asc' : 'desc';
          const issues = store.listIssues(repo, { state, sort, direction });
          const { pageItems, linkHeader } = paginate(req, url, issues);
          sendJson(res, 200, pageItems.map((i) => issueJson(req, repo, i)), linkHeader === null ? {} : { link: linkHeader });
          return true;
        }
        return notFound(res);
      }
      const number = Number.parseInt(seg(4) as string, 10);
      if (segments.length === 5) {
        if (Number.isNaN(number)) return notFound(res);
        if (method === 'GET') {
          const issue = store.getIssue(repo, number);
          if (issue === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, issueJson(req, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const patch: { state?: 'open' | 'closed'; title?: string; body?: string | null } = {};
          if (body.state === 'open' || body.state === 'closed') patch.state = body.state;
          if (typeof body.title === 'string') patch.title = body.title;
          if (body.body !== undefined) patch.body = body.body as string | null;
          const issue = store.updateIssue(repo, number, patch);
          if (issue === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, issueJson(req, repo, issue));
          return true;
        }
        return notFound(res);
      }
      if (segments.length === 6 && seg(5) === 'comments') {
        const issue = store.getIssue(repo, number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'POST') {
          const commentBody = strField(body.body);
          if (commentBody === undefined) {
            sendError(res, 422, 'Comment body is required');
            return true;
          }
          const comment = store.addComment(repo, number, commentBody);
          if (comment === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 201, commentJson(req, repo, issue, comment));
          return true;
        }
        if (method === 'GET') {
          const comments = store.listComments(repo, number);
          const { pageItems, linkHeader } = paginate(req, url, comments);
          sendJson(res, 200, pageItems.map((c) => commentJson(req, repo, issue, c)), linkHeader === null ? {} : { link: linkHeader });
          return true;
        }
        return notFound(res);
      }
      return notFound(res);
    }

    // /pulls...
    if (sub === 'pulls') {
      if (segments.length === 4) {
        if (method === 'POST') {
          const title = strField(body.title);
          const head = strField(body.head);
          const base = strField(body.base);
          if (title === undefined || head === undefined || base === undefined) {
            sendError(res, 422, 'title, head and base are required');
            return true;
          }
          try {
            const pull = store.createPull(repo, {
              title,
              body: (body.body as string | null) ?? null,
              head: head.includes(':') ? (head.split(':').pop() as string) : head,
              base: base.includes(':') ? (base.split(':').pop() as string) : base,
            });
            sendJson(res, 201, pullJson(req, repo, pull));
          } catch (err) {
            sendError(res, 422, err instanceof Error ? err.message : 'Could not create pull request');
          }
          return true;
        }
        if (method === 'GET') {
          const stateParam = url.searchParams.get('state') ?? 'open';
          const state = stateParam === 'open' || stateParam === 'closed' || stateParam === 'all'
            ? stateParam
            : 'open';
          const pulls = store.listPulls(repo, { state });
          const { pageItems, linkHeader } = paginate(req, url, pulls);
          sendJson(res, 200, pageItems.map((p) => pullJson(req, repo, p)), linkHeader === null ? {} : { link: linkHeader });
          return true;
        }
        return notFound(res);
      }
      const number = Number.parseInt(seg(4) as string, 10);
      if (Number.isNaN(number)) return notFound(res);
      if (segments.length === 5) {
        if (method !== 'GET') return notFound(res);
        const pull = store.getPull(repo, number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(req, repo, pull));
        return true;
      }
      if (segments.length === 6 && seg(5) === 'files') {
        if (method !== 'GET') return notFound(res);
        const pull = store.getPull(repo, number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, store.listPullFiles(repo, number));
        return true;
      }
      if (segments.length === 6 && seg(5) === 'merge') {
        if (method !== 'PUT') return notFound(res);
        const result = store.mergePull(repo, number);
        if (result === 'not-found') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (result === 'conflicted') {
          sendError(res, 405, 'Merge conflict: the pull request cannot be merged');
          return true;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: result.message });
        return true;
      }
      return notFound(res);
    }

    return notFound(res);
  }

  return notFound(res);
}

function notFound(res: ServerResponse): boolean {
  sendError(res, 404, 'Not Found');
  return true;
}

/** Create a standalone (req, res) handler bound to one store. */
export function createRestHandler(
  store: Store,
  auth?: AuthArg,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return (req, res) => handleRest(req, res, store, auth);
}
