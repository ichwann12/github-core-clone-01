// Smart-HTTP git protocol (upload-pack v2/v0, receive-pack v0).
// Mounted by the coordinator, e.g.:
//
//   import { handleGit } from './src/git-protocol.ts';
//   if (await handleGit(req, res, store)) return; // true = git route, answered
//
// `handleGit` reads the request body itself. It returns true when the path is
// a git route (the response has been sent) and false otherwise, so the
// coordinator can fall through to the other surfaces. Auth: a missing or
// wrong Bearer token is 401 JSON; a repo under any owner other than the
// viewer login is 404 JSON (the store's getRepo already enforces that).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAncestor, parseCommit, parseObject } from './git-objects.ts';
import { buildPackFromShas, collectReachable, parsePack } from './git-pack.ts';
import { trialNow, type Repo } from './types.ts';

export const GIT_AGENT = 'github-core-clone-01/1.0';
const ZERO_OID = '0'.repeat(40);

/** The store surface this module needs (the Store class satisfies it). */
export interface GitStore {
  getRepo(ownerLogin: string, name: string): Repo | undefined;
}

/** Expected-token forms the coordinator may pass as `auth`. */
export type GitAuth = string | { token?: string } | ((req: IncomingMessage) => boolean) | undefined;

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktLinePacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from a complete buffer. Returns the packets plus the byte
 * offset just past the last packet consumed; trailing bytes (e.g. a packfile
 * after the receive-pack flush) are left unconsumed.
 */
export function decodePktLines(buf: Buffer, options: { stopAfterFlush?: boolean } = {}): { packets: PktLinePacket[]; consumed: number } {
  const packets: PktLinePacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (options.stopAfterFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buf.length && offset + 4 > buf.length) {
    throw new Error(`truncated pkt-line: ${buf.length - offset} trailing byte(s)`);
  }
  return { packets, consumed: offset };
}

/** The data packets' payloads as text lines (control packets dropped). */
export function pktLinesToStrings(packets: readonly PktLinePacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

/** One sideband packet: band byte (1 data, 2 progress, 3 error) + data. */
export function encodeSidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return encodePktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a buffer into sideband packets of at most `chunkSize` data bytes. */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer, chunkSize = 65500): Buffer[] {
  const out: Buffer[] = [];
  if (data.length === 0) {
    out.push(encodeSidebandPacket(band, Buffer.alloc(0)));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    out.push(encodeSidebandPacket(band, data.subarray(offset, offset + chunkSize)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function resolveExpectedToken(auth: GitAuth): string {
  if (typeof auth === 'string') return auth;
  if (auth && typeof auth === 'object' && typeof auth.token === 'string') return auth.token;
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries an acceptable Bearer token. */
export function isAuthorized(req: IncomingMessage, auth: GitAuth = undefined): boolean {
  if (typeof auth === 'function') {
    try {
      return auth(req);
    } catch {
      return false;
    }
  }
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const expected = resolveExpectedToken(auth);
  if (expected === '') return match[1].length > 0;
  return match[1] === expected;
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

function headRefName(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}

/** Peel a tag object (recursively) to the non-tag object it points at. */
function peelObject(objects: Map<string, Buffer>, oid: string): { oid: string; type: string } {
  const seen = new Set<string>();
  let current = oid;
  while (seen.add(current)) {
    const raw = objects.get(current);
    if (!raw) return { oid: current, type: '' };
    let parsed;
    try {
      parsed = parseObject(raw);
    } catch {
      return { oid: current, type: '' };
    }
    if (parsed.type !== 'tag') return { oid: current, type: parsed.type };
    const blank = parsed.payload.indexOf('\n\n');
    const header = parsed.payload.subarray(0, blank < 0 ? parsed.payload.length : blank).toString('utf8');
    let target = '';
    for (const line of header.split('\n')) {
      if (line.startsWith('object ')) target = line.slice(7).trim();
    }
    if (!target) return { oid: current, type: 'tag' };
    current = target;
  }
  return { oid: current, type: '' };
}

function objectType(objects: Map<string, Buffer>, oid: string): string {
  const raw = objects.get(oid);
  if (!raw) return '';
  try {
    return parseObject(raw).type;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------
// fetch planning (full + shallow/deepen)
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Object ids to put in the pack. */
  send: Set<string>;
  /** New shallow-boundary commits (depth-limited fetches). */
  shallow: string[];
  /** Former shallow commits that are no longer boundaries. */
  unshallow: string[];
}

/** Tree closure (tree + subtrees + blobs) of one tree object. */
function treeClosure(objects: Map<string, Buffer>, treeSha: string): Set<string> {
  return collectReachable(objects, [treeSha], { allowMissing: true });
}

/**
 * Reachable objects from `roots`, but a walk through a commit in `cutoff`
 * stops at that commit (its tree is included, its parents are not). This is
 * how a shallow client's `have` lines are honoured: the client holds the
 * boundary commit but none of its ancestors.
 */
function collectReachableWithCutoff(
  objects: Map<string, Buffer>,
  roots: Iterable<string>,
  cutoff: Set<string>,
): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (/^[0-9a-f]{40}$/.test(root)) queue.push(root);
  const visited = new Set<string>();
  while (queue.length) {
    const oid = queue.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const raw = objects.get(oid);
    if (!raw) continue;
    let parsed;
    try {
      parsed = parseObject(raw);
    } catch {
      continue;
    }
    out.add(oid);
    if (parsed.type === 'commit') {
      const commit = parseCommit(parsed.payload);
      for (const entry of treeClosure(objects, commit.tree)) out.add(entry);
      if (!cutoff.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (parsed.type === 'tag') {
      const peeled = peelObject(objects, oid);
      if (peeled.oid !== oid) queue.push(peeled.oid);
    } else if (parsed.type === 'tree') {
      for (const entry of treeClosure(objects, oid)) out.add(entry);
    }
  }
  return out;
}

function planFetch(
  objects: Map<string, Buffer>,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  oldShallow: string[],
): FetchPlan {
  const cutoff = new Set(oldShallow);
  let included: Set<string>;
  let boundary: string[] = [];
  if (depth === undefined) {
    included = collectReachable(objects, wants);
  } else {
    // Breadth-first over commit parents, bounded by depth (want = distance 0).
    included = new Set<string>();
    const dist = new Map<string, number>();
    const queue: { oid: string; d: number }[] = [];
    for (const want of wants) {
      if (!/^[0-9a-f]{40}$/.test(want)) continue;
      const raw = objects.get(want);
      if (!raw) throw new Error(`want ${want} is not in the store`);
      const split = parseObject(raw);
      if (split.type === 'tag') {
        included.add(want);
        const peeled = peelObject(objects, want);
        if (peeled.oid !== want && peeled.type === 'commit') queue.push({ oid: peeled.oid, d: 0 });
        else if (peeled.oid !== want) {
          for (const entry of collectReachable(objects, [peeled.oid], { allowMissing: true })) included.add(entry);
        }
      } else if (split.type === 'commit') {
        queue.push({ oid: want, d: 0 });
      } else {
        for (const entry of collectReachable(objects, [want], { allowMissing: true })) included.add(entry);
      }
    }
    const boundarySet = new Set<string>();
    while (queue.length) {
      const { oid, d } = queue.shift()!;
      const known = dist.get(oid);
      if (known !== undefined && known <= d) continue;
      dist.set(oid, d);
      included.add(oid);
      const raw = objects.get(oid);
      if (!raw) continue;
      const commit = parseCommit(parseObject(raw).payload);
      for (const entry of treeClosure(objects, commit.tree)) included.add(entry);
      if (d + 1 < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, d: d + 1 });
      } else {
        boundarySet.add(oid);
      }
    }
    boundary = [...boundarySet].sort();
  }
  const held = collectReachableWithCutoff(objects, haves, cutoff);
  const send = new Set<string>();
  for (const oid of included) if (!held.has(oid)) send.add(oid);
  const unshallow = oldShallow.filter((oid) => included.has(oid) && !boundary.includes(oid)).sort();
  return { send, shallow: boundary, unshallow };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const headOid = repo.refs.get(headRefName(repo)) ?? ZERO_OID;
  const first = `${headOid} HEAD\0${caps}\n`;
  lines.push(encodePktLine(first));
  for (const [name, oid] of repo.refs) {
    lines.push(encodePktLine(`${oid} ${name}\n`));
    if (name.startsWith('refs/tags/') && objectType(repo.objects, oid) === 'tag') {
      const peeled = peelObject(repo.objects, oid);
      if (peeled.type === 'commit' && peeled.oid !== oid) {
        lines.push(encodePktLine(`${peeled.oid} ${name}^{}\n`));
      }
    }
  }
  return lines;
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${GIT_AGENT} symref=HEAD:${headRefName(repo)} object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${GIT_AGENT} symref=HEAD:${headRefName(repo)} object-format=sha1`;
  const parts: Buffer[] = [
    encodePktLine(`# service=${service}\n`),
    pktLineFlush(),
    ...v0RefLines(repo, caps),
    pktLineFlush(),
  ];
  return Buffer.concat(parts);
}

function advertiseV2(repo: Repo): Buffer {
  void repo;
  const caps = [
    'version 2\n',
    `agent=${GIT_AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    'server-option\n',
  ];
  const parts: Buffer[] = [
    encodePktLine('# service=git-upload-pack\n'),
    pktLineFlush(),
    ...caps.map((line) => encodePktLine(line)),
    pktLineFlush(),
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs + fetch
// ---------------------------------------------------------------------------------------------

function handleLsRefsV2(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const headOid = repo.refs.get(headRefName(repo));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  if (headOid) {
    if (keep('HEAD')) {
      const attrs = symrefs ? ` symref-target:${headRefName(repo)}` : '';
      lines.push(encodePktLine(`${headOid} HEAD${attrs}\n`));
    }
  } else if (unborn && keep('HEAD')) {
    lines.push(encodePktLine(`unborn HEAD symref-target:${headRefName(repo)}\n`));
  }
  for (const [name, oid] of repo.refs) {
    if (!keep(name)) continue;
    let attrs = '';
    if (peel && name.startsWith('refs/tags/') && objectType(repo.objects, oid) === 'tag') {
      const peeled = peelObject(repo.objects, oid);
      if (peeled.type === 'commit' && peeled.oid !== oid) attrs += ` peeled:${peeled.oid}`;
    }
    lines.push(encodePktLine(`${oid} ${name}${attrs}\n`));
  }
  lines.push(pktLineFlush());
  return Buffer.concat(lines);
}

function v2FetchResponse(repo: Repo, args: string[], queryDepth: number | undefined): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let deepen: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowArgs.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = Number.parseInt(arg.slice(7).trim(), 10);
  }
  const depth = deepen ?? queryDepth;
  const plan = planFetch(repo.objects, wants, haves, depth, shallowArgs);
  const pack = buildPackFromShas(repo.objects, plan.send);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent `have` lines: a fresh
  // clone sends none, and a real git client then expects the packfile section first
  // ("expected 'packfile', received 'acknowledgments'" otherwise).
  if (haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), pktLineDelim());
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  parts.push(encodePktLine('packfile\n'), ...sidebandPackets(1, pack), pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0: want/have negotiation
// ---------------------------------------------------------------------------------------------

function v0FetchResponse(repo: Repo, sections: string[][], queryDepth: number | undefined): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let deepen: number | undefined;
  for (const section of sections) {
    for (const line of section) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0].trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowArgs.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7).trim(), 10);
    }
  }
  const depth = deepen ?? queryDepth;
  const plan = planFetch(repo.objects, wants, haves, depth, shallowArgs);
  const pack = buildPackFromShas(repo.objects, plan.send);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(1, pack), pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Commands are pkt-lines up to the first flush; the rest is the packfile.
  const { packets, consumed } = decodePktLines(body, { stopAfterFlush: true });
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command: ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts;
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
      throw new Error(`bad object id in receive-pack command: ${JSON.stringify(line.slice(0, 60))}`);
    }
    if (!ref.startsWith('refs/')) throw new Error(`bad ref in receive-pack command: ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  if (!commands.length) throw new Error('receive-pack sent no commands');

  const packBytes = body.subarray(consumed);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      parsePack(packBytes, repo.objects);
    } catch (err) {
      unpackError = (err as Error).message.replace(/[\r\n]+/g, ' ').slice(0, 200);
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    let anyOk = false;
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = '';
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reason = 'no such ref';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
        else {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) reason = 'already exists';
        else if (!repo.objects.has(command.newOid)) reason = 'missing object';
        else {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else {
        // Update: old must match, new must exist, and old must be an ancestor.
        if (current === undefined) reason = 'non-fast-forward';
        else if (command.oldOid !== current) reason = 'non-fast-forward';
        else if (!repo.objects.has(command.newOid)) reason = 'missing object';
        else if (objectType(repo.objects, command.newOid) !== 'commit' || objectType(repo.objects, current) !== 'commit') {
          if (command.newOid === current) ok = true;
          else reason = 'non-fast-forward';
        } else if (isAncestor(repo.objects, current, command.newOid)) {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        } else {
          reason = 'non-fast-forward';
        }
      }
      if (ok) anyOk = true;
      reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
    }
    if (anyOk) repo.pushed_at = trialNow();
  }

  const report = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktLineFlush()]);
  return Buffer.concat([...sidebandPackets(1, report), pktLineFlush()]);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

interface GitRoute {
  owner: string;
  repoName: string;
  rest: string;
}

/** Split "/{owner}/{repo}.git/{rest...}" or return null when it is not a git path. */
function parseGitPath(pathname: string): GitRoute | null {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const repoSegment = segments[1];
  if (!repoSegment.endsWith('.git')) return null;
  return { owner: segments[0], repoName: repoSegment.slice(0, -4), rest: segments.slice(2).join('/') };
}

/**
 * Handle one request. Returns true when the path is a git route (a response
 * has been sent) and false when it is not, so the coordinator can fall
 * through to the other surfaces. Never throws for a git route: malformed
 * requests get a 400/500 JSON answer and the server stays up.
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: GitStore,
  auth: GitAuth = undefined,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const route = parseGitPath(url.pathname);
  if (!route) return false;
  const method = req.method ?? 'GET';

  try {
    if (!isAuthorized(req, auth)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return true;
    }
    const repo = store.getRepo(route.owner, route.repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const queryDepthRaw = url.searchParams.get('depth');
    const queryDepth =
      queryDepthRaw !== null && /^\d+$/.test(queryDepthRaw) ? Number.parseInt(queryDepthRaw, 10) : undefined;
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

    if (method === 'GET' && route.rest === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const body = wantsV2 ? advertiseV2(repo) : advertiseV0(repo, 'git-upload-pack');
        sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
        return true;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, advertiseV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
        return true;
      }
      sendJson(res, 400, { message: 'missing or unknown service parameter' });
      return true;
    }

    if (method === 'POST' && route.rest === 'git-upload-pack') {
      const body = await readBody(req);
      if (wantsV2) {
        const { packets } = decodePktLines(body);
        const lines = pktLinesToStrings(packets).map((line) => line.replace(/\n$/, ''));
        const commandLine = lines[0] ?? '';
        if (!commandLine.startsWith('command=')) {
          sendJson(res, 400, { message: 'expected a command= line' });
          return true;
        }
        const command = commandLine.slice('command='.length);
        const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
        const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
        const args = pktLinesToStrings(argPackets).map((line) => line.replace(/\n$/, ''));
        if (command === 'ls-refs') {
          sendBuffer(res, 200, handleLsRefsV2(repo, args), 'application/x-git-upload-pack-result');
          return true;
        }
        if (command === 'fetch') {
          sendBuffer(res, 200, v2FetchResponse(repo, args, queryDepth), 'application/x-git-upload-pack-result');
          return true;
        }
        sendJson(res, 400, { message: `unknown command ${command}` });
        return true;
      }
      // v0: sections split by flush packets.
      const { packets } = decodePktLines(body);
      const sections: string[][] = [[]];
      for (const packet of packets) {
        if (packet.kind === 'flush') {
          sections.push([]);
          continue;
        }
        if (packet.kind === 'data') sections[sections.length - 1].push(packet.payload.toString('utf8').replace(/\n$/, ''));
      }
      sendBuffer(res, 200, v0FetchResponse(repo, sections, queryDepth), 'application/x-git-upload-pack-result');
      return true;
    }

    if (method === 'POST' && route.rest === 'git-receive-pack') {
      const body = await readBody(req);
      sendBuffer(res, 200, handleReceivePack(repo, body), 'application/x-git-receive-pack-result');
      return true;
    }

    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  } catch (err) {
    if (!res.headersSent) {
      const message = err instanceof Error ? err.message : String(err);
      // A malformed pkt-line stream is a client error; anything else is a 500.
      const status = /pkt-line|truncated|bad receive-pack|no commands/i.test(message) ? 400 : 500;
      sendJson(res, status, { message });
    } else {
      try {
        res.end();
      } catch {
        // The response is already gone; nothing more to do.
      }
    }
    return true;
  }
}

/** Build a `(req, res) => Promise<boolean>` handler bound to a store + auth. */
export function createGitHandler(
  store: GitStore,
  auth: GitAuth = undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return (req, res) => handleGit(req, res, store, auth);
}
