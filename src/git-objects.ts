// Pure git object functions (no I/O, no dates, no randomness).
// Object payloads are RAW bytes: "type <len>\0<payload>". zlib is used only
// inside packfiles (see git-pack.ts), never here.

import { createHash } from 'node:crypto';

/** SHA-1 of `data`, lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The loose-object bytes: "<type> <len>\0" + payload. */
export function encodeObject(type: 'blob' | 'tree' | 'commit' | 'tag', payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, 'utf8'), payload]);
}

/** git's object id: SHA-1 over the loose-object bytes. */
export function hashObject(type: string, payload: Buffer): string {
  return sha1Hex(encodeObject(type as 'blob' | 'tree' | 'commit' | 'tag', payload));
}

/** Split raw loose-object bytes into type + payload. */
export function parseObject(raw: Buffer): { type: string; payload: Buffer } {
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error('object has no header terminator');
  const header = raw.subarray(0, nul).toString('utf8');
  const space = header.indexOf(' ');
  if (space < 0) throw new Error(`object header has no size: ${JSON.stringify(header)}`);
  const type = header.slice(0, space);
  const size = Number(header.slice(space + 1));
  if (!Number.isInteger(size) || size < 0) throw new Error(`object header has a bad size: ${JSON.stringify(header)}`);
  const payload = raw.subarray(nul + 1);
  if (payload.length !== size) throw new Error(`object declares ${size} bytes but carries ${payload.length}`);
  return { type, payload: Buffer.from(payload) };
}

/** A blob object from content bytes. */
export function makeBlob(content: Buffer): { sha: string; raw: Buffer } {
  const raw = encodeObject('blob', content);
  return { sha: sha1Hex(raw), raw };
}

/** Compare two tree-entry names the way git sorts them: a directory entry
 *  (mode 40000) is compared as if its name ended in '/'. */
function compareTreeEntryNames(
  a: { mode: string; name: string },
  b: { mode: string; name: string },
): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** A tree object from entries (sorted in git tree order). */
export function makeTree(entries: { mode: string; name: string; sha: string }[]): { sha: string; raw: Buffer } {
  const sorted = [...entries].sort(compareTreeEntryNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!/^[0-9a-f]{40}$/.test(entry.sha)) throw new Error(`tree entry ${entry.name} has a bad sha ${JSON.stringify(entry.sha)}`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  const payload = Buffer.concat(parts);
  const raw = encodeObject('tree', payload);
  return { sha: sha1Hex(raw), raw };
}

/** Parse a tree payload into its entries, in stored order. */
export function parseTree(payload: Buffer): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = payload.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > payload.length) throw new Error('tree entry has a truncated object id');
    const mode = payload.subarray(offset, space).toString('ascii');
    const name = payload.subarray(space + 1, nul).toString('utf8');
    const sha = payload.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/**
 * A commit object. Format (git's exact layout):
 *   tree <sha>\n
 *   parent <sha>\n          (one line per parent, in order)
 *   author <name> <email> <ts> +0000\n
 *   committer <name> <email> <ts> +0000\n
 *   \n
 *   <message>\n
 * The message is used as given when it already ends with '\n', otherwise one
 * trailing '\n' is added, so the stored bytes always end with a newline.
 */
export function makeCommit(o: {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}): { sha: string; raw: Buffer } {
  const ident = `${o.authorName} <${o.authorEmail}> ${o.timestamp} +0000`;
  const lines = [`tree ${o.tree}`];
  for (const parent of o.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '');
  const message = o.message.endsWith('\n') ? o.message : `${o.message}\n`;
  const payload = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
  const raw = encodeObject('commit', payload);
  return { sha: sha1Hex(raw), raw };
}

/** Parse a commit payload: tree, parents (in order), message (after the blank line). */
export function parseCommit(payload: Buffer): { tree: string; parents: string[]; message: string } {
  const blank = payload.indexOf('\n\n');
  const headerEnd = blank < 0 ? payload.length : blank;
  const headerText = payload.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : payload.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
  }
  return { tree, parents, message };
}

/** Parse a tag payload's target object id (used to peel tags to commits). */
function parseTagTarget(payload: Buffer): string {
  const blank = payload.indexOf('\n\n');
  const headerEnd = blank < 0 ? payload.length : blank;
  for (const line of payload.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('object ')) return line.slice('object '.length).trim();
  }
  return '';
}

/** Peel a tag object (recursively) to the commit it ultimately points at. */
function peelToCommit(objects: Map<string, Buffer>, oid: string): string {
  const seen = new Set<string>();
  let current = oid;
  while (seen.add(current)) {
    const raw = objects.get(current);
    if (!raw) return current;
    let parsed;
    try {
      parsed = parseObject(raw);
    } catch {
      return current;
    }
    if (parsed.type !== 'tag') return current;
    const target = parseTagTarget(parsed.payload);
    if (!target) return current;
    current = target;
  }
  return current;
}

/**
 * True when `ancestor` is reachable from `descendant` by following commit
 * parents (all parents, not just first-parent). Equal ids count as ancestors.
 * Missing or non-commit objects make the answer false, never a throw.
 */
export function isAncestor(objects: Map<string, Buffer>, ancestor: string, descendant: string): boolean {
  const anc = peelToCommit(objects, ancestor);
  let desc = peelToCommit(objects, descendant);
  if (anc === desc) return true;
  const visited = new Set<string>();
  const queue: string[] = [desc];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === anc) return true;
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
    if (parsed.type !== 'commit') continue;
    for (const parent of parseCommit(parsed.payload).parents) queue.push(parent);
  }
  return false;
}

/**
 * Flatten a tree recursively: path -> { mode, sha }. Directories are walked,
 * not listed; gitlinks (mode 160000) are listed as files. A missing tree
 * yields an empty map.
 */
export function readTreeRecursive(
  objects: Map<string, Buffer>,
  treeSha: string,
  prefix = '',
): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  const walk = (sha: string, base: string): void => {
    const raw = objects.get(sha);
    if (!raw) return;
    let parsed;
    try {
      parsed = parseObject(raw);
    } catch {
      return;
    }
    if (parsed.type !== 'tree') return;
    for (const entry of parseTree(parsed.payload)) {
      const path = `${base}${entry.name}`;
      if (entry.mode === '40000') walk(entry.sha, `${path}/`);
      else out.set(path, { mode: entry.mode, sha: entry.sha });
    }
  };
  walk(treeSha, prefix);
  return out;
}

/** Diff two trees (old may be null for "no previous tree"), sorted by path. */
export function treeDiff(
  objects: Map<string, Buffer>,
  oldTree: string | null,
  newTree: string,
): { path: string; status: 'added' | 'removed' | 'modified'; oldSha?: string; newSha?: string }[] {
  const oldMap = oldTree === null ? new Map<string, { mode: string; sha: string }>() : readTreeRecursive(objects, oldTree);
  const newMap = readTreeRecursive(objects, newTree);
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  const diff: { path: string; status: 'added' | 'removed' | 'modified'; oldSha?: string; newSha?: string }[] = [];
  for (const path of paths) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry && !newEntry) diff.push({ path, status: 'removed', oldSha: oldEntry.sha });
    else if (!oldEntry && newEntry) diff.push({ path, status: 'added', newSha: newEntry.sha });
    else if (oldEntry && newEntry && oldEntry.sha !== newEntry.sha) {
      diff.push({ path, status: 'modified', oldSha: oldEntry.sha, newSha: newEntry.sha });
    }
  }
  return diff;
}
