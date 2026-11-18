# Forge build — shared contract (read this before writing any module)

Entry: one Node 22 process, stdlib only (`node:http`, `node:zlib`, `node:crypto`).
Repo root: `main.ts` (lifecycle — DO NOT CHANGE), `app.ts` (HTTP server + routing — the
coordinator wires it at integration), `src/*.ts` (the modules below).
Runtime: pod runs `node /bot/main.ts`; repo read-only at `/bot`; write only under `/tmp`.
No git binary, no network, no dependencies.

## Fixed scenario constants (verified against the kit's own wire.ts buildScenario())

The suite's scenario is built from a FIXED seed (`SCENARIO_SEED = 0x6a09e667f3bcc909n`),
identical in every trial (practice and scored). The entry therefore hardcodes:

- `VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' }`
  — the login the bearer token names. Every repository belongs to this login.
- `STRANGER = { id: 1002, login: 'olgabauer', ... }` — another user; repos under this
  login are NEVER the viewer's: any route naming it as owner is 404, never 403.
- `TEAMMATE = { id: 1001, login: 'quinnkeller', ... }`
- `ORG = 'faint-meadow-org'`
- Labels the suite uses: `['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']`
  (labels are created per-repo through POST /labels; the list is just the seeded names).

## Auth

- Expected token: `process.env.MAKEFUN_SHOP_TOKEN`. If the env var is empty (local dev),
  accept any non-empty `Authorization: Bearer <token>`.
- Missing or wrong token on any `/api/v3/*`, `/api/graphql`, `/mcp`, or `/{owner}/{repo}.git/*`
  route is **401 JSON** `{"message": "Requires authentication"}` (exact message text is
  not checked; it must be JSON with a string `message`).
- `/healthz` takes no auth.
- A repo under any owner other than the viewer login is **404, never 403**.

## Determinism (scored — replays must be byte-identical)

- NEVER `Date.now()`, `new Date()`, or `Math.random()` in stored state or in any response
  that lands in the state export.
- All timestamps: the constant `TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? '2025-01-01T00:00:00Z'`
  (ISO string for REST/GraphQL; git commits use its Unix seconds).
- Git author/committer for entry-made commits: `adaiversen <adaiversen@example.invalid>`,
  timestamp = TRIAL_NOW seconds, timezone `+0000`.
- All IDs and numbers: sequential counters, starting at 1, in creation order.
  `X-GitHub-Request-Id`: sequential `req-<n>` (n = 1, 2, 3, … per process).
- Ordering everywhere: insertion order, or explicitly number DESC where the spec says so.

## Entity types (src/types.ts — every module imports these, nobody redefines them)

```ts
export interface User { id: number; login: string; name: string; email: string; }
export interface Label { id: number; name: string; color: string; description: string | null; }
export interface Comment { id: number; body: string; user: User; created_at: string; updated_at: string; }
export interface Issue {
  id: number; number: number; repoId: number; title: string; body: string | null;
  state: 'open' | 'closed'; labels: Label[]; user: User;
  created_at: string; updated_at: string; comments: Comment[];
}
export interface Pull {
  id: number; number: number; repoId: number; title: string; body: string | null;
  state: 'open' | 'closed'; merged: boolean;
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  mergeable: boolean; user: User;
  created_at: string; updated_at: string; merged_at: string | null;
  merge_commit_sha: string | null;
}
export interface Repo {
  id: number; name: string; owner: User; private: boolean;
  description: string | null; default_branch: string;
  created_at: string; updated_at: string; pushed_at: string;
  refs: Map<string, string>;          // 'refs/heads/main' -> commit sha
  objects: Map<string, Buffer>;       // sha -> raw object bytes ("type <len>\0<payload>", NOT zlib)
  nextNumber: number;                 // shared issues+PRs counter, starts at 1
  nextLabelId: number;                // starts at 1
  labels: Map<string, Label>;         // by name
  issues: Map<number, Issue>;         // by number
  pulls: Map<number, Pull>;           // by number
}
```

## Store API (src/store.ts — Worker A implements; Workers B and C call it)

```ts
export class Store {
  readonly viewer: User;
  constructor();
  createRepo(name: string, isPrivate: boolean, description: string | null): Repo; // throws RepoExistsError on duplicate name
  getRepo(ownerLogin: string, name: string): Repo | undefined; // undefined unless ownerLogin === viewer.login
  listViewerRepos(): Repo[]; // creation order
  deleteRepo(ownerLogin: string, name: string): boolean;
  updateRepo(ownerLogin: string, name: string, patch: { description?: string | null }): Repo | undefined;
  createBranch(repo: Repo, branch: string, sha: string): { ref: string; sha: string }; // throws on unknown sha
  listBranches(repo: Repo): { name: string; sha: string }[]; // insertion order of refs
  listCommits(repo: Repo, ref?: string): { sha: string; message: string }[]; // newest first, walk first-parent chain
  putContent(repo: Repo, path: string, o: { message: string; contentB64: string; branch?: string; sha?: string }):
    { status: 201 | 200; contentSha: string; commitSha: string }; // throws StaleShaError -> 409; creates default branch on unborn repo
  getContent(repo: Repo, path: string, ref?: string):
    | { kind: 'file'; sha: string; size: number; contentB64: string }
    | { kind: 'dir'; entries: { name: string; type: 'file' | 'dir'; sha: string; size: number }[] }
    | undefined;
  deleteContent(repo: Repo, path: string, o: { message: string; sha?: string; branch?: string }): { commitSha: string } | undefined;
  createLabel(repo: Repo, name: string, color?: string): Label;
  getLabel(repo: Repo, name: string): Label | undefined;
  createIssue(repo: Repo, o: { title: string; body?: string | null; labels?: string[] }): Issue; // throws UnknownLabelError
  listIssues(repo: Repo, o?: { state?: 'open' | 'closed' | 'all'; sort?: 'created' | 'updated'; direction?: 'asc' | 'desc' }): Issue[];
  getIssue(repo: Repo, number: number): Issue | undefined;
  updateIssue(repo: Repo, number: number, patch: { state?: 'open' | 'closed'; title?: string; body?: string | null }): Issue | undefined;
  addComment(repo: Repo, issueNumber: number, body: string): Comment | undefined;
  listComments(repo: Repo, issueNumber: number): Comment[];
  createPull(repo: Repo, o: { title: string; body?: string | null; head: string; base: string }): Pull; // head/base are branch names; throws on unknown branch
  listPulls(repo: Repo, o?: { state?: 'open' | 'closed' | 'all' }): Pull[];
  getPull(repo: Repo, number: number): Pull | undefined;
  listPullFiles(repo: Repo, number: number): { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[];
  mergePull(repo: Repo, number: number): { sha: string; merged: true; message: string } | 'not-found' | 'conflicted';
}
export class RepoExistsError extends Error {}
export class StaleShaError extends Error {}
export class UnknownLabelError extends Error { constructor(public label: string) { super(...); } }
```

Notes for the implementer (Worker A):
- `putContent`: decode base64 -> blob; build a new tree from the branch tip's tree with the
  path replaced (create intermediate trees); commit with parent = tip (or none if unborn);
  update `refs/heads/<branch>`. `sha` given must equal the current blob sha at that path,
  else `StaleShaError`. A create (no existing file) returns 201, an update 200.
- `deleteContent`: same tree/commit machinery; removing the file; the file must exist.
- `getContent` directory listing: entries of that tree, sorted by name, files before dirs
  is NOT required — sort by name, dirs and files mixed is fine (GitHub sorts by name).
- `mergePull`: squash — new commit on the base branch whose tree is the head branch's tip
  tree, parent = base tip, message `Merge pull request #<n> from <head>`; update base ref;
  set PR `state='closed', merged=true, merged_at=TRIAL_NOW, merge_commit_sha=<sha>`.
  Return `'conflicted'` when the head and base tips are identical (nothing to merge) — NO,
  read the merge check in `program/env/src/checks-rest.ts` (search `conflict`) and implement
  exactly the condition it uses to expect 405.
- Issue/PR numbers share ONE counter per repo (`nextNumber`): the first issue is #1, the
  next PR is #2, etc. (GitHub behaviour).
- `listCommits` walks the first-parent chain from the ref tip (default branch unless given).

## Git pure functions (src/git-objects.ts + src/git-pack.ts — Worker B implements; Worker A calls them)

```ts
// git-objects.ts
export function sha1Hex(data: Buffer): string;
export function encodeObject(type: 'blob' | 'tree' | 'commit' | 'tag', payload: Buffer): Buffer; // "type <len>\0" + payload
export function hashObject(type: string, payload: Buffer): string;
export function parseObject(raw: Buffer): { type: string; payload: Buffer };
export function makeBlob(content: Buffer): { sha: string; raw: Buffer };
export function makeTree(entries: { mode: string; name: string; sha: string }[]): { sha: string; raw: Buffer };
export function parseTree(payload: Buffer): { mode: string; name: string; sha: string }[];
export function makeCommit(o: { tree: string; parents: string[]; message: string; authorName: string; authorEmail: string; timestamp: number }): { sha: string; raw: Buffer };
export function parseCommit(payload: Buffer): { tree: string; parents: string[]; message: string };
export function isAncestor(objects: Map<string, Buffer>, ancestor: string, descendant: string): boolean;
export function readTreeRecursive(objects: Map<string, Buffer>, treeSha: string, prefix?: string): Map<string, { mode: string; sha: string }>; // path -> entry
export function treeDiff(objects: Map<string, Buffer>, oldTree: string | null, newTree: string): { path: string; status: 'added' | 'removed' | 'modified'; oldSha?: string; newSha?: string }[];
// git-pack.ts
export function buildPack(objects: Map<string, Buffer>, wantShas: string[], haveShas: Set<string>): Buffer; // pack v2; delta-compress where it helps; include every object reachable from wants but not from haves
export function parsePack(buf: Buffer, objects: Map<string, Buffer>): string[]; // writes all objects into the map (resolves OFS/REF deltas, incl. thin packs against `objects`); returns the new shas
```

Notes for Worker B: object payloads are the RAW (uncompressed) bytes; zlib (deflate/inflate)
is applied only inside packfiles and in loose-object framing if you use it (you don't have to —
the store keeps raw bytes). Deltas: REF_DELTA and/or OFS_DELTA, both must be PARSED on receive
(the suite's client may send either); on build, deltas are optional but help the clone
workload — at minimum emit undelted objects correctly, and prefer small deltas for blobs
with a common base. Thin packs: the suite may send a pack whose delta base is an object the
entry already has — resolve against `objects` before writing.

## Git protocol (src/git-protocol.ts — Worker B implements)

Handlers (all under `/{owner}/{repo}.git/...`, auth 401 as above, missing repo 404 JSON):
- `GET /info/refs?service=git-upload-pack` and `?service=git-receive-pack`: pkt-line
  advertisement. v0 opens with `# service=git-upload-pack\n` (resp. receive-pack) then a
  flush, then refs. upload-pack advertises `side-band-64k` (v0) and the v2 capabilities when
  `Git-Protocol: version=2` is requested. receive-pack advertises `report-status`,
  `side-band-64k`, `delete-refs`.
- `POST /git-upload-pack`: protocol v2 when the request carries `Git-Protocol: version=2`
  (advertisement starts with `version 2\n`, commands `ls-refs`, `fetch`), else v0.
  Serve exactly the objects the client wants (see buildPack). Support `?depth=1` shallow
  clones (clone workload uses depth 1): answer with the tip commit(s) only, marking them
  shallow (`shallow` lines in the response).
- `POST /git-receive-pack`: v0 only. Parse the pack, verify every update fast-forwards
  (or is a new branch / delete-refs), apply the fast-forward refs, refuse the others with
  `ng <ref> non-fast-forward`, answer one `ok`/`ng` report line per ref, `unpack ok`.
  A push to a repo with no commits yet (unborn) accepts the first push.

## REST (src/rest.ts — Worker A implements)

Routes (all under `/api/v3`, JSON, `X-GitHub-Request-Id` on EVERY reply, unknown route
404 JSON, malformed JSON body 400 JSON). See RULES.txt "The wire contract" and
`program/env/src/checks-rest.ts` (the endpoint list at the top of that file is authoritative).
Pagination: `?page=&per_page=` (default per_page 30); when more pages exist, a `Link`
header with `<url>; rel="next"` (and `rel="last"` is fine too). `GET /api/v3/` returns 200
with `X-OAuth-Scopes: repo, read:org`. `GET /api/v3/meta` returns 200
`{"installed_version": "1.0.0"}` (any non-empty string). Repository JSON must include at
least: `id, name, full_name, owner: {login, id}, private, description, default_branch,
created_at, updated_at, pushed_at, html_url, url, clone_url, git_url, ssh_url`.
Issue JSON: `id, number, title, body, state, labels: [{name, color}], user: {login, id},
created_at, updated_at, html_url, url`. Pull JSON: `id, number, title, body, state, merged,
head: {ref, sha}, base: {ref, sha}, mergeable, user, created_at, updated_at, html_url, url`.
Contents file JSON: `name, path, sha, size, encoding: 'base64', content (base64, no newlines
required), type: 'file', url, html_url, download_url: null`. Directory listing: array of
`{name, path, sha, size, type: 'file'|'dir', url}`.

## GraphQL (src/graphql.ts — Worker C implements)

`POST /api/graphql`, body `{query, variables}`. Unauthenticated is exactly 401.
Introspection must describe: `Issue {id, number, title, state, body}`,
`PullRequest {id, number, headRefName, baseRefName, mergeable, state, merged, files}`,
`Repository {id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission,
hasIssuesEnabled, issue, issues, pullRequests, pullRequest}`, and `SearchType` enum values
include `ISSUE`. `repository.issues(orderBy: {field: CREATED_AT, direction: DESC})` returns
numbers descending (ties by number DESC); `states: [OPEN]` omits closed. `createPullRequest`
takes a repository id + a head branch pushed over git and opens a PR REST reads back with
the same head/base. Two operation documents in one body answer two results in order.
Unknown field: HTTP 200 with an `errors` array naming it. Unknown repository:
`data.repository = null` with no errors. Global node ids: `Buffer.from('Repository:<dbid>').toString('base64')`
(and `Issue:<dbid>`, `PullRequest:<dbid>`); parse them back. Read
`program/env/src/checks-graphql.ts` + `graphql-client.ts` for the exact documents.

## MCP (src/mcp.ts — Worker C implements)

`POST /mcp`, JSON-RPC 2.0 over Streamable HTTP, `application/json` or SSE, every request
answered within 3 s. Revision `2026-07-28` (server/discover answers `supportedVersions` as a
non-empty list of `YYYY-MM-DD` revisions) or a handshake revision (`2025-11-25` or earlier)
via `initialize` + `notifications/initialized` with optional `Mcp-Session-Id`.
`tools/list`: at least six tools including `create_repo`, `get_repo`, `create_issue`,
`list_issues`, `create_pull_request`, `merge_pull_request` (a server prefix is allowed,
matched as suffix, case-insensitively); every tool has a non-empty description and an
`inputSchema` of type `object`; two `tools/list` calls answer the same list byte for byte.
Tool args as github-mcp-server documents them: `create_repo {name}`,
`get_repo {owner, repo}`, `create_issue {owner, repo, title, body?}`,
`list_issues {owner, repo, state?}`, `create_pull_request {owner, repo, title, head, base}`,
`merge_pull_request {owner, repo, pull_number}`; map each argument onto the schema's nearest
property name and fill `full_name` with `owner/repo`. Unknown tool: JSON-RPC `-32602` or
`-32601`, never HTTP 500. Missing required argument: `isError: true` or `-32602`. Non-JSON
body: HTTP 400 with `-32700` (200 with `-32700` for pre-2026-07-28 servers). No Authorization
header: 401. Tools act on the same store as REST (same objects, ids unchanged across reads).
Read `program/env/src/checks-mcp.ts` + `mcp-client.ts` for the exact expectations.

## Performance (everyone)

- Keep the store in memory; no per-request file I/O, no `await` on disk.
- Pack building must be fast: cache nothing that breaks determinism, but avoid re-walking
  the whole object graph per request when a simple ref-tip lookup suffices.
- Keep-alive: the server is `node:http` — it handles keep-alive by default; do not close
  connections per request.
- The read workload is 2,000 sequential `GET /repos/{o}/{r}/issues/{n}` on one keep-alive
  connection: the issue lookup must be O(1).
