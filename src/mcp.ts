// MCP endpoint for the forge (Worker C).
// Mounted by the coordinator: handleMcp(req, res, store, auth?).
//   - req/res: node:http IncomingMessage / ServerResponse
//   - store: the shared Store instance (same objects REST reads)
//   - auth: optional; a token string, { token }, or a (req) => boolean checker.
//     Defaults to process.env.MAKEFUN_SHOP_TOKEN; when that is empty any
//     non-empty Bearer token is accepted.
// POST /mcp, JSON-RPC 2.0 over Streamable HTTP, answered as plain JSON
// (application/json). Speaks the modern 2026-07-28 revision (server/discover)
// and the legacy handshake era (initialize + notifications/initialized).
// Determinism: no Date.now(), no Math.random(); the tools list is built once
// at module load and reused, so two tools/list calls answer byte for byte.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { type Issue, type Pull, type Repo } from './types.ts';

type AuthArg = string | { token?: string } | ((req: IncomingMessage) => boolean) | undefined;

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

// ---------------------------------------------------------------- tools list (built once, reused verbatim)

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): ToolDef {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: { type: 'string', description: 'Name of the repository to create.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The owner (login) of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The owner (login) of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
    title: { type: 'string', description: 'The title of the issue.' },
    body: { type: 'string', description: 'The body of the issue.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'The owner (login) of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
    state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter issues by state.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository.', {
    owner: { type: 'string', description: 'The owner (login) of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
    title: { type: 'string', description: 'The title of the pull request.' },
    body: { type: 'string', description: 'The body of the pull request.' },
    head: { type: 'string', description: 'The head branch (the branch with the changes).' },
    base: { type: 'string', description: 'The base branch (the branch the changes go into).' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request in a repository.', {
    owner: { type: 'string', description: 'The owner (login) of the repository.' },
    repo: { type: 'string', description: 'The name of the repository.' },
    pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
  }, ['owner', 'repo', 'pull_number']),
]);

// ---------------------------------------------------------------- auth (same rule as REST)

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

// ---------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number | null;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** A tool result: human-readable text plus the structured value. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Best-effort id out of a body that failed to parse (the id is usually intact). */
function salvageId(text: string): JsonRpcId {
  const match = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(text);
  if (match === null) return null;
  const raw = match[1] ?? '';
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return null;
    }
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- serializers (same shapes as REST)

function baseUrlOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}

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

function labelJson(label: { id: number; name: string; color: string; description: string | null }): Record<string, unknown> {
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

// ---------------------------------------------------------------- tool arguments

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First present value under any of the given argument names. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function argString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  const value = arg(args, ...names);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Resolve owner/repo from the arguments, accepting the github-mcp-server names
 * (owner/repo) and the documented alternates (owner_login, repository, or a
 * full_name of "owner/repo").
 */
function resolveOwnerRepo(args: Record<string, unknown>): { owner?: string; repo?: string } {
  let owner = argString(args, 'owner', 'owner_login', 'owner_name', 'user_login', 'login', 'org', 'organization', 'namespace');
  let repo = argString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name');
  const fullName = argString(args, 'full_name', 'repo_full_name', 'repository_full_name', 'fullName');
  if (fullName !== undefined && fullName.includes('/')) {
    const [fullOwner, fullRepo] = fullName.split('/', 2);
    if (owner === undefined && fullOwner !== '') owner = fullOwner;
    if (repo === undefined && fullRepo !== '') repo = fullRepo;
  }
  return { owner, repo };
}

function missingArgs(args: Record<string, unknown>, required: string[]): string[] {
  return required.filter((name) => {
    const value = args[name];
    return value === undefined || value === null || value === '';
  });
}

/** JSON-RPC -32602 for a missing/invalid argument, or null when all are present. */
function requireArgs(
  id: JsonRpcId,
  args: Record<string, unknown>,
  required: string[],
): Record<string, unknown> | null {
  const missing = missingArgs(args, required);
  if (missing.length > 0) {
    return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
  }
  return null;
}

// ---------------------------------------------------------------- tools/call dispatch

function callTool(
  req: IncomingMessage,
  res: ServerResponse,
  id: JsonRpcId,
  store: Store,
  name: unknown,
  args: unknown,
): void {
  if (typeof name !== 'string' || name === '') {
    sendJson(res, 200, rpcError(id, -32602, 'tools/call requires a tool name'));
    return;
  }
  if (!isRecord(args)) {
    sendJson(res, 200, rpcError(id, -32602, 'tools/call requires an arguments object'));
    return;
  }

  // The canonical names; a server prefix is the caller's business — the suite
  // calls tools by the exact name tools/list advertised, so match exactly.
  switch (name) {
    case 'create_repo': {
      const err = requireArgs(id, args, ['name']);
      if (err !== null) {
        sendJson(res, 200, err);
        return;
      }
      const repoName = argString(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name') ?? '';
      const description = argString(args, 'description', 'about', 'summary', 'body') ?? null;
      const isPrivate = arg(args, 'private', 'is_private') === true;
      try {
        const repo = store.createRepo(repoName, isPrivate, description);
        sendJson(res, 200, rpcResult(id, toolResult(repoJson(req, repo))));
      } catch (error) {
        sendJson(res, 200, rpcResult(id, toolError(error instanceof Error ? error.message : String(error))));
      }
      return;
    }
    case 'get_repo': {
      const { owner, repo } = resolveOwnerRepo(args);
      const err = requireArgs(id, { owner, repo }, ['owner', 'repo']);
      if (err !== null) {
        sendJson(res, 200, err);
        return;
      }
      const found = store.getRepo(owner ?? '', repo ?? '');
      if (found === undefined) {
        sendJson(res, 200, rpcResult(id, toolError(`Repository not found: ${owner}/${repo}`)));
        return;
      }
      sendJson(res, 200, rpcResult(id, toolResult(repoJson(req, found))));
      return;
    }
    case 'create_issue': {
      const { owner, repo } = resolveOwnerRepo(args);
      const title = argString(args, 'title', 'issue_title', 'subject');
      const body = argString(args, 'body', 'issue_body', 'description', 'content', 'text');
      const err = requireArgs(id, { owner, repo, title }, ['owner', 'repo', 'title']);
      if (err !== null) {
        sendJson(res, 200, err);
        return;
      }
      const found = store.getRepo(owner ?? '', repo ?? '');
      if (found === undefined) {
        sendJson(res, 200, rpcResult(id, toolError(`Repository not found: ${owner}/${repo}`)));
        return;
      }
      try {
        const issue = store.createIssue(found, { title: title ?? '', body: body ?? null });
        sendJson(res, 200, rpcResult(id, toolResult(issueJson(req, found, issue))));
      } catch (error) {
        sendJson(res, 200, rpcResult(id, toolError(error instanceof Error ? error.message : String(error))));
      }
      return;
    }
    case 'list_issues': {
      const { owner, repo } = resolveOwnerRepo(args);
      const state = argString(args, 'state', 'status');
      const err = requireArgs(id, { owner, repo }, ['owner', 'repo']);
      if (err !== null) {
        sendJson(res, 200, err);
        return;
      }
      if (state !== undefined && state !== 'open' && state !== 'closed' && state !== 'all') {
        sendJson(res, 200, rpcError(id, -32602, `Invalid state: ${state}`));
        return;
      }
      const found = store.getRepo(owner ?? '', repo ?? '');
      if (found === undefined) {
        sendJson(res, 200, rpcResult(id, toolError(`Repository not found: ${owner}/${repo}`)));
        return;
      }
      const issues = store.listIssues(found, state === undefined ? undefined : { state });
      sendJson(res, 200, rpcResult(id, toolResult(issues.map((issue) => issueJson(req, found, issue)))));
      return;
    }
    case 'create_pull_request': {
      const { owner, repo } = resolveOwnerRepo(args);
      const title = argString(args, 'title', 'pr_title', 'pull_request_title', 'subject');
      const body = argString(args, 'body', 'description', 'content', 'text');
      const head = argString(args, 'head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch');
      const base = argString(args, 'base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch');
      const err = requireArgs(id, { owner, repo, title, head, base }, ['owner', 'repo', 'title', 'head', 'base']);
      if (err !== null) {
        sendJson(res, 200, err);
        return;
      }
      const found = store.getRepo(owner ?? '', repo ?? '');
      if (found === undefined) {
        sendJson(res, 200, rpcResult(id, toolError(`Repository not found: ${owner}/${repo}`)));
        return;
      }
      try {
        const pull = store.createPull(found, { title: title ?? '', body: body ?? null, head: head ?? '', base: base ?? '' });
        sendJson(res, 200, rpcResult(id, toolResult(pullJson(req, found, pull))));
      } catch (error) {
        sendJson(res, 200, rpcResult(id, toolError(error instanceof Error ? error.message : String(error))));
      }
      return;
    }
    case 'merge_pull_request': {
      const { owner, repo } = resolveOwnerRepo(args);
      const rawNumber = arg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
      const pullNumber = typeof rawNumber === 'number'
        ? rawNumber
        : typeof rawNumber === 'string' && /^\d+$/.test(rawNumber)
          ? Number(rawNumber)
          : undefined;
      const err = requireArgs(id, { owner, repo, pull_number: pullNumber }, ['owner', 'repo', 'pull_number']);
      if (err !== null) {
        sendJson(res, 200, err);
        return;
      }
      const found = store.getRepo(owner ?? '', repo ?? '');
      if (found === undefined) {
        sendJson(res, 200, rpcResult(id, toolError(`Repository not found: ${owner}/${repo}`)));
        return;
      }
      const outcome = store.mergePull(found, pullNumber ?? 0);
      if (outcome === 'not-found') {
        sendJson(res, 200, rpcResult(id, toolError(`Pull request not found: #${String(pullNumber)}`)));
        return;
      }
      if (outcome === 'conflicted') {
        sendJson(res, 200, rpcResult(id, toolError(`Pull request #${String(pullNumber)} cannot be merged: conflicted`)));
        return;
      }
      const pull = store.getPull(found, pullNumber ?? 0);
      const value: Record<string, unknown> = pull !== undefined
        ? { ...pullJson(req, found, pull), sha: outcome.sha, message: outcome.message }
        : { sha: outcome.sha, merged: true, message: outcome.message, number: pullNumber, pull_number: pullNumber };
      sendJson(res, 200, rpcResult(id, toolResult(value)));
      return;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
      return;
    }
  }
}

// ---------------------------------------------------------------- JSON-RPC dispatch

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  body: Record<string, unknown>,
): void {
  const id: JsonRpcId = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
  const method = body.method;
  const isNotification = body.id === undefined;

  if (typeof method !== 'string' || method === '') {
    if (isNotification) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, rpcError(id, -32600, 'Invalid Request: missing method'));
    return;
  }

  // Notifications get no JSON-RPC response (202, empty body).
  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }

  const params = isRecord(body.params) ? body.params : {};

  switch (method) {
    case 'server/discover': {
      sendJson(res, 200, rpcResult(id, {
        serverInfo: serverInfo(),
        capabilities: { tools: {} },
        supportedVersions: [...SUPPORTED_VERSIONS],
        instructions: 'GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
        _meta: {
          'io.modelcontextprotocol/serverInfo': serverInfo(),
          'io.modelcontextprotocol/protocolVersion': PREFERRED_REVISION,
        },
      }));
      return;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const negotiated = offered !== undefined && SUPPORTED_VERSIONS.includes(offered) ? offered : PREFERRED_REVISION;
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      }));
      return;
    }
    case 'ping': {
      sendJson(res, 200, rpcResult(id, {}));
      return;
    }
    case 'tools/list': {
      // TOOLS is built once at module load and never mutated: two calls
      // answer the same list byte for byte.
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return;
    }
    case 'tools/call': {
      callTool(req, res, id, store, params.name, params.arguments);
      return;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
      return;
    }
  }
}

// ---------------------------------------------------------------- entry point

/**
 * Handle one request. Returns true when the path is /mcp (handled);
 * false otherwise so the coordinator can fall through to another handler.
 */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  auth?: AuthArg,
): Promise<boolean> {
  let path: string;
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (path !== '/mcp' && path !== '/mcp/') return false;

  if (req.method !== 'POST') {
    // No GET stream and no session lifecycle: anything but POST is refused,
    // but the path is ours.
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  if (!isAuthorized(req, auth)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    sendJson(res, 400, rpcError(salvageId(text), -32700, 'Parse error'));
    return true;
  }

  if (Array.isArray(parsed)) {
    // Batches are not part of this transport: refuse, do not crash.
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: batch requests are not supported'));
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object'));
    return true;
  }

  dispatch(req, res, store, parsed);
  return true;
}
