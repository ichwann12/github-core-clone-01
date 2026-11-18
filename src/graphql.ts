// GraphQL v4 router for the forge (Worker C).
// Mounted by the coordinator: handleGraphQL(req, res, store, auth?).
//   - req/res: node:http IncomingMessage / ServerResponse
//   - store: the shared Store instance
//   - auth: optional; a token string, { token }, or a (req) => boolean checker.
//     Defaults to process.env.MAKEFUN_SHOP_TOKEN; when that is empty any
//     non-empty Bearer token is accepted.
// POST /api/graphql, body {query, variables} (or a JSON array of operations
// for GitHub's operation batching). Every reply is application/json with a
// sequential X-GitHub-Request-Id ("req-<n>") from this module's own counter.
// Unauthenticated is exactly 401 JSON. Unknown field: HTTP 200 with an
// errors array naming it. Unknown repository: data.repository = null, no
// errors. No general GraphQL engine: a small parser + executor for the
// documents the suite sends (see program/env/src/checks-graphql.ts).
// No Date.now(), no Math.random(); all timestamps come from the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import type { Issue, Pull, Repo } from './types.ts';

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-github-request-id': `req-${requestCounter}`,
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Global (Relay) ids and cursors
// ---------------------------------------------------------------------------

function gid(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

function parseGid(value: unknown): { type: string; id: number } | null {
  if (typeof value !== 'string' || value === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([A-Za-z]+):(\d+)$/.exec(decoded);
  if (match === null) return null;
  return { type: match[1] as string, id: Number(match[2]) };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function parseCursor(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^cursor:(\d+)$/.exec(decoded);
  if (match !== null) return Number(match[1]);
  if (/^\d+$/.test(decoded)) return Number(decoded);
  return null;
}

// ---------------------------------------------------------------------------
// Schema table (introspection source of truth, and field validation)
// ---------------------------------------------------------------------------

interface TypeInfo {
  kind: string;
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Node: { kind: 'INTERFACE', fields: ['id'] },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
      'description', 'private', 'createdAt', 'updatedAt', 'url'],
  },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
      'body', 'author', 'createdAt', 'updatedAt', 'url'],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changes'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'comment', 'clientMutationId'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'directives'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  SearchType: { kind: 'ENUM', enumValues: ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'] },
};

// ---------------------------------------------------------------------------
// Tiny GraphQL parser (documents the suite sends; no directives in use)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < src.length) { out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$&():=@[]{}|'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    throw new Error(`Unexpected character "${ch}"`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selections: SelectionNode[] };

interface VarDef { name: string; defaultValue?: ValueNode }

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs: VarDef[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type Definition = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(): Token { return this.tokens[this.pos] as Token; }
  private next(): Token { const t = this.tokens[this.pos] as Token; this.pos += 1; return t; }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }
  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw new Error(`Expected "${value}" but found "${this.peek().value}"`);
    this.next();
  }
  private expectName(what = 'a name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected ${what} but found "${t.value}"`);
    return t.value;
  }

  parseDocument(): Definition[] {
    const defs: Definition[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): Definition {
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      return { kind: 'operation', operation: 'query', varDefs: [], selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName('an operation or fragment');
    if (keyword === 'fragment') {
      const name = this.expectName('a fragment name');
      const on = this.expectName('"on"');
      if (on !== 'on') throw new Error('Expected "on" in a fragment definition');
      const typeCondition = this.expectName('a type condition');
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`Unknown definition "${keyword}"`);
    }
    let name: string | undefined;
    if (this.peek().kind === 'name') name = this.next().value;
    const varDefs = this.isPunct('(') ? this.parseVarDefs() : [];
    this.skipDirectives();
    return { kind: 'operation', operation: keyword, name, varDefs, selections: this.parseSelectionSet() };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.isPunct('=')) { this.next(); defaultValue = this.parseValue(); }
      defs.push(defaultValue === undefined ? { name } : { name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.isPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName('a directive name');
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | undefined;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.isPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : undefined;
    return selections === undefined
      ? { kind: 'field', alias, name, args }
      : { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    this.next();
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: Number.parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Unexpected value "${t.value}"`);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Wrapper { __type: string; [key: string]: unknown }
interface GraphQLError { message: string; path?: (string | number)[] }

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: GraphQLError[];
  fragments: Map<string, FragmentNode>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': case 'int': case 'float': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, ctx.variables);
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoUrl(repo: Repo): string {
  return `https://github.com/${repo.owner.login}/${repo.name}`;
}

function userWrapper(store: Store): Wrapper {
  return { __type: 'User', user: store.viewer };
}

function repoWrapper(repo: Repo): Wrapper {
  return { __type: 'Repository', repo };
}

function issueWrapper(repo: Repo, issue: Issue): Wrapper {
  return { __type: 'Issue', repo, issue };
}

function pullWrapper(repo: Repo, pull: Pull): Wrapper {
  return { __type: 'PullRequest', repo, pull };
}

function pageInfoWrapper(hasNextPage: boolean, startCursor: string | null, endCursor: string | null): Wrapper {
  return { __type: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor };
}

function findRepoById(store: Store, id: number): Repo | undefined {
  return store.listViewerRepos().find((r) => r.id === id);
}

function findIssueByEntityId(store: Store, entityId: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.listViewerRepos()) {
    const issue = [...repo.issues.values()].find((i) => i.id === entityId);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function findPullByEntityId(store: Store, entityId: number): { repo: Repo; pull: Pull } | undefined {
  for (const repo of store.listViewerRepos()) {
    const pull = [...repo.pulls.values()].find((p) => p.id === entityId);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

function nodeFromGlobalId(store: Store, idValue: unknown): Wrapper | null {
  const parsed = parseGid(idValue);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = findRepoById(store, parsed.id);
    return repo === undefined ? null : repoWrapper(repo);
  }
  if (parsed.type === 'Issue') {
    const found = findIssueByEntityId(store, parsed.id);
    return found === undefined ? null : issueWrapper(found.repo, found.issue);
  }
  if (parsed.type === 'PullRequest') {
    const found = findPullByEntityId(store, parsed.id);
    return found === undefined ? null : pullWrapper(found.repo, found.pull);
  }
  if (parsed.type === 'User' && parsed.id === store.viewer.id) return userWrapper(store);
  return null;
}

function sortedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let list = [...repo.issues.values()];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((i) => wanted.has(issueState(i)));
  }
  const orderBy = isRecord(args['orderBy']) ? args['orderBy'] : null;
  const direction = orderBy !== null && orderBy['direction'] === 'ASC' ? 1 : -1;
  const field = orderBy !== null ? String(orderBy['field'] ?? 'CREATED_AT') : 'CREATED_AT';
  const keyOf = (i: Issue): number | string => {
    if (field === 'UPDATED_AT') return i.updated_at;
    if (field === 'COMMENTS') return i.comments.length;
    return i.created_at;
  };
  list.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -direction;
    if (ka > kb) return direction;
    return (a.number - b.number) * direction;
  });
  // No orderBy at all: creation order (number ASC), which the cursor check needs.
  if (orderBy === null) list.sort((a, b) => a.number - b.number);
  return list;
}

function paginate<T extends { number: number }>(
  sorted: T[],
  args: Record<string, unknown>,
): { page: T[]; hasNextPage: boolean; startCursor: string | null; endCursor: string | null } {
  let start = 0;
  const after = parseCursor(args['after']);
  if (after !== null) {
    const idx = sorted.findIndex((item) => item.number === after);
    start = idx === -1 ? sorted.length : idx + 1;
  }
  const first = args['first'];
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : sorted.length - start;
  const page = sorted.slice(start, start + limit);
  const hasNextPage = start + page.length < sorted.length;
  return {
    page,
    hasNextPage,
    startCursor: page.length === 0 ? null : cursorFor(page[0]?.number as number),
    endCursor: page.length === 0 ? null : cursorFor(page[page.length - 1]?.number as number),
  };
}

function sortedPulls(repo: Repo, args: Record<string, unknown>): Pull[] {
  let list = [...repo.pulls.values()];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((p) => wanted.has(pullState(p)));
  }
  list.sort((a, b) => a.number - b.number);
  return list;
}

function resolveField(
  parent: Wrapper,
  field: FieldNode,
  ctx: ExecCtx,
): { value: unknown; childType: string | null } {
  const store = ctx.store;
  const args = argsOf(field, ctx);
  const name = field.name;

  switch (parent.__type) {
    case 'Query': {
      if (name === 'viewer') return { value: userWrapper(store), childType: 'User' };
      if (name === 'repository') {
        const repo = store.getRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
        return { value: repo === undefined ? null : repoWrapper(repo), childType: 'Repository' };
      }
      if (name === 'node') return { value: nodeFromGlobalId(store, args['id']), childType: null };
      if (name === '__type') {
        const typeName = String(args['name'] ?? '');
        if (SCHEMA[typeName] === undefined) return { value: null, childType: '__Type' };
        return { value: { __type: '__Type', typeName }, childType: '__Type' };
      }
      if (name === '__schema') return { value: { __type: '__Schema' }, childType: '__Schema' };
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') return { value: mutateCreateIssue(args, ctx), childType: 'CreateIssuePayload' };
      if (name === 'closeIssue') return { value: mutateCloseIssue(args, ctx), childType: 'CloseIssuePayload' };
      if (name === 'createPullRequest') return { value: mutateCreatePullRequest(args, ctx), childType: 'CreatePullRequestPayload' };
      if (name === 'mergePullRequest') return { value: mutateMergePullRequest(args, ctx), childType: 'MergePullRequestPayload' };
      if (name === 'addComment') return { value: mutateAddComment(args, ctx), childType: 'AddCommentPayload' };
      break;
    }
    case 'User': {
      const user = parent['user'] as { id: number; login: string; name: string; email: string };
      if (name === 'id') return { value: gid('User', user.id), childType: null };
      if (name === 'databaseId') return { value: user.id, childType: null };
      if (name === 'login') return { value: user.login, childType: null };
      if (name === 'name') return { value: user.name, childType: null };
      if (name === 'email') return { value: user.email, childType: null };
      break;
    }
    case 'Repository': {
      const repo = parent['repo'] as Repo;
      if (name === 'id') return { value: gid('Repository', repo.id), childType: null };
      if (name === 'databaseId') return { value: repo.id, childType: null };
      if (name === 'name') return { value: repo.name, childType: null };
      if (name === 'nameWithOwner') return { value: `${repo.owner.login}/${repo.name}`, childType: null };
      if (name === 'owner') return { value: userWrapper(store), childType: 'User' };
      if (name === 'defaultBranchRef') return { value: { __type: 'Ref', name: repo.default_branch }, childType: 'Ref' };
      if (name === 'viewerPermission') return { value: 'ADMIN', childType: null };
      if (name === 'hasIssuesEnabled') return { value: true, childType: null };
      if (name === 'description') return { value: repo.description, childType: null };
      if (name === 'private') return { value: repo.private, childType: null };
      if (name === 'createdAt') return { value: repo.created_at, childType: null };
      if (name === 'updatedAt') return { value: repo.updated_at, childType: null };
      if (name === 'url') return { value: repoUrl(repo), childType: null };
      if (name === 'issue') {
        const issue = store.getIssue(repo, Number(args['number']));
        return { value: issue === undefined ? null : issueWrapper(repo, issue), childType: 'Issue' };
      }
      if (name === 'issues') {
        const sorted = sortedIssues(repo, args);
        const { page, hasNextPage, startCursor, endCursor } = paginate(sorted, args);
        return {
          value: {
            __type: 'IssueConnection',
            items: page.map((i) => issueWrapper(repo, i)),
            totalCount: sorted.length,
            pageInfo: pageInfoWrapper(hasNextPage, startCursor, endCursor),
          },
          childType: 'IssueConnection',
        };
      }
      if (name === 'pullRequest') {
        const pull = store.getPull(repo, Number(args['number']));
        return { value: pull === undefined ? null : pullWrapper(repo, pull), childType: 'PullRequest' };
      }
      if (name === 'pullRequests') {
        const sorted = sortedPulls(repo, args);
        const { page, hasNextPage, startCursor, endCursor } = paginate(sorted, args);
        return {
          value: {
            __type: 'PullRequestConnection',
            items: page.map((p) => pullWrapper(repo, p)),
            totalCount: sorted.length,
            pageInfo: pageInfoWrapper(hasNextPage, startCursor, endCursor),
          },
          childType: 'PullRequestConnection',
        };
      }
      break;
    }
    case 'Ref': {
      const refName = String(parent['name'] ?? '');
      if (name === 'id') return { value: gid('Ref', 0) + refName, childType: null };
      if (name === 'name') return { value: refName, childType: null };
      if (name === 'prefix') return { value: 'refs/heads/', childType: null };
      break;
    }
    case 'Issue': {
      const repo = parent['repo'] as Repo;
      const issue = parent['issue'] as Issue;
      if (name === 'id') return { value: gid('Issue', issue.id), childType: null };
      if (name === 'number') return { value: issue.number, childType: null };
      if (name === 'title') return { value: issue.title, childType: null };
      if (name === 'state') return { value: issueState(issue), childType: null };
      if (name === 'body') return { value: issue.body, childType: null };
      if (name === 'author') return { value: { __type: 'User', user: issue.user }, childType: 'User' };
      if (name === 'createdAt') return { value: issue.created_at, childType: null };
      if (name === 'updatedAt') return { value: issue.updated_at, childType: null };
      if (name === 'url') return { value: `${repoUrl(repo)}/issues/${issue.number}`, childType: null };
      break;
    }
    case 'IssueConnection': {
      const items = parent['items'] as Wrapper[];
      if (name === 'nodes') return { value: items, childType: 'Issue' };
      if (name === 'edges') {
        return {
          value: items.map((node) => ({ __type: 'IssueEdge', node, cursor: cursorFor((node['issue'] as Issue).number) })),
          childType: 'IssueEdge',
        };
      }
      if (name === 'pageInfo') return { value: parent['pageInfo'], childType: 'PageInfo' };
      if (name === 'totalCount') return { value: parent['totalCount'], childType: null };
      break;
    }
    case 'IssueEdge': {
      if (name === 'node') return { value: parent['node'], childType: 'Issue' };
      if (name === 'cursor') return { value: parent['cursor'], childType: null };
      break;
    }
    case 'PullRequest': {
      const repo = parent['repo'] as Repo;
      const pull = parent['pull'] as Pull;
      if (name === 'id') return { value: gid('PullRequest', pull.id), childType: null };
      if (name === 'number') return { value: pull.number, childType: null };
      if (name === 'title') return { value: pull.title, childType: null };
      if (name === 'state') return { value: pullState(pull), childType: null };
      if (name === 'merged') return { value: pull.merged, childType: null };
      if (name === 'headRefName') return { value: pull.head.ref, childType: null };
      if (name === 'baseRefName') return { value: pull.base.ref, childType: null };
      if (name === 'mergeable') return { value: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING', childType: null };
      if (name === 'body') return { value: pull.body, childType: null };
      if (name === 'author') return { value: { __type: 'User', user: pull.user }, childType: 'User' };
      if (name === 'createdAt') return { value: pull.created_at, childType: null };
      if (name === 'updatedAt') return { value: pull.updated_at, childType: null };
      if (name === 'url') return { value: `${repoUrl(repo)}/pull/${pull.number}`, childType: null };
      if (name === 'files') {
        const all = store.listPullFiles(repo, pull.number).map((f) => ({
          __type: 'PullRequestChangedFile',
          path: f.filename,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        }));
        const first = args['first'];
        const page = typeof first === 'number' ? all.slice(0, Math.max(0, Math.floor(first))) : all;
        return {
          value: {
            __type: 'PullRequestChangedFileConnection',
            items: page,
            totalCount: all.length,
            pageInfo: pageInfoWrapper(page.length < all.length, null, null),
          },
          childType: 'PullRequestChangedFileConnection',
        };
      }
      break;
    }
    case 'PullRequestConnection': {
      const items = parent['items'] as Wrapper[];
      if (name === 'nodes') return { value: items, childType: 'PullRequest' };
      if (name === 'edges') {
        return {
          value: items.map((node) => ({ __type: 'PullRequestEdge', node, cursor: cursorFor((node['pull'] as Pull).number) })),
          childType: 'PullRequestEdge',
        };
      }
      if (name === 'pageInfo') return { value: parent['pageInfo'], childType: 'PageInfo' };
      if (name === 'totalCount') return { value: parent['totalCount'], childType: null };
      break;
    }
    case 'PullRequestEdge': {
      if (name === 'node') return { value: parent['node'], childType: 'PullRequest' };
      if (name === 'cursor') return { value: parent['cursor'], childType: null };
      break;
    }
    case 'PullRequestChangedFileConnection': {
      const items = parent['items'] as Wrapper[];
      if (name === 'nodes') return { value: items, childType: 'PullRequestChangedFile' };
      if (name === 'edges') {
        return {
          value: items.map((node) => ({ __type: 'PullRequestChangedFileEdge', node, cursor: cursorFor(0) })),
          childType: 'PullRequestChangedFileEdge',
        };
      }
      if (name === 'pageInfo') return { value: parent['pageInfo'], childType: 'PageInfo' };
      if (name === 'totalCount') return { value: parent['totalCount'], childType: null };
      break;
    }
    case 'PullRequestChangedFileEdge': {
      if (name === 'node') return { value: parent['node'], childType: 'PullRequestChangedFile' };
      if (name === 'cursor') return { value: parent['cursor'], childType: null };
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return { value: parent['path'], childType: null };
      if (name === 'additions') return { value: parent['additions'], childType: null };
      if (name === 'deletions') return { value: parent['deletions'], childType: null };
      if (name === 'changes') return { value: parent['changes'], childType: null };
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return { value: parent['hasNextPage'], childType: null };
      if (name === 'hasPreviousPage') return { value: parent['hasPreviousPage'], childType: null };
      if (name === 'endCursor') return { value: parent['endCursor'], childType: null };
      if (name === 'startCursor') return { value: parent['startCursor'], childType: null };
      break;
    }
    case 'IssueComment': {
      const comment = parent['comment'] as { id: number; body: string; user: { id: number; login: string; name: string; email: string }; created_at: string; updated_at: string };
      if (name === 'id') return { value: gid('IssueComment', comment.id), childType: null };
      if (name === 'body') return { value: comment.body, childType: null };
      if (name === 'author') return { value: { __type: 'User', user: comment.user }, childType: 'User' };
      if (name === 'createdAt') return { value: comment.created_at, childType: null };
      if (name === 'updatedAt') return { value: comment.updated_at, childType: null };
      break;
    }
    case 'CommentEdge': {
      if (name === 'node') return { value: parent['node'], childType: 'IssueComment' };
      if (name === 'cursor') return { value: parent['cursor'], childType: null };
      break;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      if (name === 'issue') return { value: parent['issue'] ?? null, childType: 'Issue' };
      if (name === 'clientMutationId') return { value: parent['clientMutationId'] ?? null, childType: null };
      break;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return { value: parent['pullRequest'] ?? null, childType: 'PullRequest' };
      if (name === 'clientMutationId') return { value: parent['clientMutationId'] ?? null, childType: null };
      break;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return { value: parent['commentEdge'] ?? null, childType: 'CommentEdge' };
      if (name === 'comment') return { value: parent['comment'] ?? null, childType: 'IssueComment' };
      if (name === 'clientMutationId') return { value: parent['clientMutationId'] ?? null, childType: null };
      break;
    }
    case '__Type': {
      const info = SCHEMA[String(parent['typeName'] ?? '')];
      if (info === undefined) return { value: null, childType: null };
      if (name === 'name') return { value: parent['typeName'], childType: null };
      if (name === 'kind') return { value: info.kind, childType: null };
      if (name === 'description') return { value: null, childType: null };
      if (name === 'fields') {
        const fields = info.fields ?? null;
        return {
          value: fields === null ? null : fields.map((f) => ({ __type: '__Field', name: f })),
          childType: '__Field',
        };
      }
      if (name === 'enumValues') {
        const values = info.enumValues ?? null;
        return {
          value: values === null ? null : values.map((v) => ({ __type: '__EnumValue', name: v })),
          childType: '__EnumValue',
        };
      }
      break;
    }
    case '__Field': case '__EnumValue': {
      if (name === 'name') return { value: parent['name'], childType: null };
      if (name === 'description') return { value: null, childType: null };
      break;
    }
    case '__Schema': {
      if (name === 'types') {
        return {
          value: Object.keys(SCHEMA).map((t) => ({ __type: '__Type', typeName: t })),
          childType: '__Type',
        };
      }
      if (name === 'queryType') return { value: { __type: '__Type', typeName: 'Query' }, childType: '__Type' };
      if (name === 'mutationType') return { value: { __type: '__Type', typeName: 'Mutation' }, childType: '__Type' };
      if (name === 'directives') return { value: [], childType: null };
      break;
    }
  }
  // Reached only for a field the validator already rejected; keep it null.
  return { value: null, childType: null };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  return isRecord(args['input']) ? args['input'] : {};
}

function mutateCreateIssue(args: Record<string, unknown>, ctx: ExecCtx): Wrapper | null {
  const input = inputOf(args);
  const parsed = parseGid(input['repositoryId']);
  if (parsed === null || parsed.type !== 'Repository') {
    ctx.errors.push({ message: 'createIssue: repositoryId is not a Repository global id' });
    return null;
  }
  const repo = findRepoById(ctx.store, parsed.id);
  if (repo === undefined) {
    ctx.errors.push({ message: 'createIssue: repository not found' });
    return null;
  }
  const title = input['title'];
  if (typeof title !== 'string' || title === '') {
    ctx.errors.push({ message: 'createIssue: title is required' });
    return null;
  }
  try {
    const issue = ctx.store.createIssue(repo, {
      title,
      body: typeof input['body'] === 'string' ? input['body'] : null,
    });
    return {
      __type: 'CreateIssuePayload',
      issue: issueWrapper(repo, issue),
      clientMutationId: typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null,
    };
  } catch (err) {
    ctx.errors.push({ message: `createIssue: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  }
}

function mutateCloseIssue(args: Record<string, unknown>, ctx: ExecCtx): Wrapper | null {
  const input = inputOf(args);
  const parsed = parseGid(input['issueId']);
  if (parsed === null || parsed.type !== 'Issue') {
    ctx.errors.push({ message: 'closeIssue: issueId is not an Issue global id' });
    return null;
  }
  const found = findIssueByEntityId(ctx.store, parsed.id);
  if (found === undefined) {
    ctx.errors.push({ message: 'closeIssue: issue not found' });
    return null;
  }
  const updated = ctx.store.updateIssue(found.repo, found.issue.number, { state: 'closed' });
  if (updated === undefined) {
    ctx.errors.push({ message: 'closeIssue: issue not found' });
    return null;
  }
  return {
    __type: 'CloseIssuePayload',
    issue: issueWrapper(found.repo, updated),
    clientMutationId: typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null,
  };
}

function mutateCreatePullRequest(args: Record<string, unknown>, ctx: ExecCtx): Wrapper | null {
  const input = inputOf(args);
  const parsed = parseGid(input['repositoryId']);
  if (parsed === null || parsed.type !== 'Repository') {
    ctx.errors.push({ message: 'createPullRequest: repositoryId is not a Repository global id' });
    return null;
  }
  const repo = findRepoById(ctx.store, parsed.id);
  if (repo === undefined) {
    ctx.errors.push({ message: 'createPullRequest: repository not found' });
    return null;
  }
  const head = input['headRefName'];
  const base = input['baseRefName'];
  const title = input['title'];
  if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string' || title === '') {
    ctx.errors.push({ message: 'createPullRequest: headRefName, baseRefName and title are required' });
    return null;
  }
  try {
    const pull = ctx.store.createPull(repo, {
      title,
      body: typeof input['body'] === 'string' ? input['body'] : null,
      head,
      base,
    });
    return {
      __type: 'CreatePullRequestPayload',
      pullRequest: pullWrapper(repo, pull),
      clientMutationId: typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null,
    };
  } catch (err) {
    ctx.errors.push({ message: `createPullRequest: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  }
}

function mutateMergePullRequest(args: Record<string, unknown>, ctx: ExecCtx): Wrapper | null {
  const input = inputOf(args);
  const parsed = parseGid(input['pullRequestId']);
  if (parsed === null || parsed.type !== 'PullRequest') {
    ctx.errors.push({ message: 'mergePullRequest: pullRequestId is not a PullRequest global id' });
    return null;
  }
  const found = findPullByEntityId(ctx.store, parsed.id);
  if (found === undefined) {
    ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
    return null;
  }
  const result = ctx.store.mergePull(found.repo, found.pull.number);
  if (result === 'not-found' || result === 'conflicted') {
    ctx.errors.push({ message: `mergePullRequest: pull request cannot be merged (${result})` });
    return null;
  }
  const pull = ctx.store.getPull(found.repo, found.pull.number) ?? found.pull;
  return {
    __type: 'MergePullRequestPayload',
    pullRequest: pullWrapper(found.repo, pull),
    clientMutationId: typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null,
  };
}

function mutateAddComment(args: Record<string, unknown>, ctx: ExecCtx): Wrapper | null {
  const input = inputOf(args);
  const parsed = parseGid(input['subjectId']);
  if (parsed === null || parsed.type !== 'Issue') {
    ctx.errors.push({ message: 'addComment: subjectId is not an Issue global id' });
    return null;
  }
  const found = findIssueByEntityId(ctx.store, parsed.id);
  if (found === undefined) {
    ctx.errors.push({ message: 'addComment: issue not found' });
    return null;
  }
  const body = input['body'];
  if (typeof body !== 'string') {
    ctx.errors.push({ message: 'addComment: body is required' });
    return null;
  }
  const comment = ctx.store.addComment(found.repo, found.issue.number, body);
  if (comment === undefined) {
    ctx.errors.push({ message: 'addComment: issue not found' });
    return null;
  }
  const node: Wrapper = { __type: 'IssueComment', comment };
  return {
    __type: 'AddCommentPayload',
    commentEdge: { __type: 'CommentEdge', node, cursor: cursorFor(comment.id) },
    comment: node,
    clientMutationId: typeof input['clientMutationId'] === 'string' ? input['clientMutationId'] : null,
  };
}

// ---------------------------------------------------------------------------
// Selection execution
// ---------------------------------------------------------------------------

function childTypeOf(value: unknown, fallback: string | null): string | null {
  if (isRecord(value) && typeof value['__type'] === 'string') return value['__type'] as string;
  return fallback;
}

function executeSelections(
  selections: SelectionNode[],
  parent: Wrapper,
  parentType: string,
  ctx: ExecCtx,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}"`, path: [...path] });
        continue;
      }
      if (frag.typeCondition !== parentType && frag.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(frag.selections, parent, parentType, ctx, path));
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition !== undefined && sel.typeCondition !== parentType && sel.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(sel.selections, parent, parentType, ctx, path));
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    const fieldPath = [...path, responseKey];
    if (sel.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const known = SCHEMA[parentType]?.fields ?? [];
    if (!known.includes(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".`, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    let resolved: { value: unknown; childType: string | null };
    try {
      resolved = resolveField(parent, sel, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    if (sel.selections === undefined) {
      out[responseKey] = resolved.value;
      continue;
    }
    if (resolved.value === null || resolved.value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(resolved.value)) {
      out[responseKey] = resolved.value.map((item, index) => {
        if (item === null || item === undefined) return null;
        const itemType = childTypeOf(item, resolved.childType);
        if (itemType === null || !isRecord(item)) return item;
        return executeSelections(sel.selections as SelectionNode[], item as Wrapper, itemType, ctx, [...fieldPath, index]);
      });
      continue;
    }
    if (isRecord(resolved.value)) {
      const itemType = childTypeOf(resolved.value, resolved.childType);
      if (itemType === null) {
        out[responseKey] = resolved.value;
        continue;
      }
      out[responseKey] = executeSelections(sel.selections, resolved.value as Wrapper, itemType, ctx, fieldPath);
      continue;
    }
    out[responseKey] = resolved.value;
  }
  return out;
}

function executeDocument(
  query: string,
  variables: Record<string, unknown>,
  operationName: string | undefined,
  store: Store,
): Record<string, unknown> {
  let definitions: Definition[];
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation in the document' }] };
  } else {
    return { data: null, errors: [{ message: 'Multiple operations in the document; operationName is required' }] };
  }
  if (operation.operation === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported' }] };
  }
  const vars: Record<string, unknown> = { ...variables };
  for (const def of operation.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== undefined) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  const ctx: ExecCtx = { store, variables: vars, errors: [], fragments };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(operation.selections, { __type: rootType }, rootType, ctx, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result['errors'] = ctx.errors;
  return result;
}

function executeOperationBody(body: unknown, store: Store): Record<string, unknown> {
  if (!isRecord(body)) {
    return { data: null, errors: [{ message: 'GraphQL operation must be a JSON object with a query string' }] };
  }
  if (typeof body['query'] !== 'string' || body['query'] === '') {
    return { data: null, errors: [{ message: 'GraphQL operation needs a non-empty query string' }] };
  }
  const variables = isRecord(body['variables']) ? (body['variables'] as Record<string, unknown>) : {};
  const operationName = typeof body['operationName'] === 'string' ? body['operationName'] : undefined;
  return executeDocument(body['query'], variables, operationName, store);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * Handle one request. Returns true when the path is /api/graphql (handled);
 * false otherwise so the coordinator can fall through to another handler.
 */
export async function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  auth?: AuthArg,
): Promise<boolean> {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    pathname = '/';
  }
  if (pathname !== '/api/graphql' && pathname !== '/api/graphql/') return false;

  requestCounter += 1;
  const method = (req.method ?? 'POST').toUpperCase();

  // Drain the body first so the keep-alive connection stays usable, then
  // apply auth (401) before any parsing.
  let raw = '';
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Could not read request body' }] });
    return true;
  }

  if (!isAuthorized(req, auth)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  if (method === 'GET') {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Bad request URL' }] });
      return true;
    }
    const query = url.searchParams.get('query');
    if (query === null) {
      sendJson(res, 405, { message: 'Method not allowed' });
      return true;
    }
    let variables: Record<string, unknown> = {};
    const rawVars = url.searchParams.get('variables');
    if (rawVars !== null) {
      try {
        const parsed: unknown = JSON.parse(rawVars);
        if (isRecord(parsed)) variables = parsed;
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Malformed JSON in variables' }] });
        return true;
      }
    }
    sendJson(res, 200, executeDocument(query, variables, url.searchParams.get('operationName') ?? undefined, store));
    return true;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method not allowed' });
    return true;
  }

  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? null : JSON.parse(raw);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON in request body' }] });
    return true;
  }
  if (parsed === null || (typeof parsed !== 'object' && !Array.isArray(parsed))) {
    sendJson(res, 400, { errors: [{ message: 'GraphQL request body must be a JSON object or array' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => executeOperationBody(entry, store)));
    return true;
  }
  sendJson(res, 200, executeOperationBody(parsed, store));
  return true;
}
