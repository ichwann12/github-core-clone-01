// Packfile build + parse (pack v2), Node stdlib only.
// Packs are the only place zlib is used. Object payloads in the `objects` map
// stay RAW ("type <len>\0<payload>"); the pack stores payloads, zlib-deflated.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, parseObject, parseTree } from './git-objects.ts';

type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const ZERO_OID = '0'.repeat(40);

/** Split a raw object into type + payload without throwing on bad input. */
function splitRaw(raw: Buffer): { type: ObjectType; payload: Buffer } | null {
  try {
    const parsed = parseObject(raw);
    if (parsed.type !== 'commit' && parsed.type !== 'tree' && parsed.type !== 'blob' && parsed.type !== 'tag') return null;
    return { type: parsed.type, payload: parsed.payload };
  } catch {
    return null;
  }
}

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target,
 *  tree -> entries except gitlinks). Missing objects are skipped when
 *  `allowMissing` is set, otherwise they throw. */
export function collectReachable(
  objects: Map<string, Buffer>,
  roots: Iterable<string>,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (/^[0-9a-f]{40}$/.test(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const raw = objects.get(oid);
    if (!raw) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    const split = splitRaw(raw);
    if (!split) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is corrupt`);
    }
    seen.add(oid);
    if (split.type === 'commit') {
      const blank = split.payload.indexOf('\n\n');
      const header = split.payload.subarray(0, blank < 0 ? split.payload.length : blank).toString('utf8');
      for (const line of header.split('\n')) {
        if (line.startsWith('tree ')) queue.push(line.slice(5).trim());
        else if (line.startsWith('parent ')) queue.push(line.slice(7).trim());
      }
    } else if (split.type === 'tag') {
      const blank = split.payload.indexOf('\n\n');
      const header = split.payload.subarray(0, blank < 0 ? split.payload.length : blank).toString('utf8');
      for (const line of header.split('\n')) {
        if (line.startsWith('object ')) queue.push(line.slice(7).trim());
      }
    } else if (split.type === 'tree') {
      for (const entry of parseTree(split.payload)) {
        if (entry.mode !== '160000') queue.push(entry.sha);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// delta encoding (git's delta format)
// ---------------------------------------------------------------------------------------------

/** Little-endian 7-bit varint, as git delta streams encode sizes. */
function encodeDeltaVarint(n: number): Buffer {
  const bytes: number[] = [];
  let value = n;
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

function commonPrefixLength(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffixLength(a: Buffer, b: Buffer, maxLen: number): number {
  const n = Math.min(a.length, b.length, maxLen);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/** Encode one copy instruction (copy `size` bytes from `offset` of the base). */
function deltaCopyOp(offset: number, size: number): Buffer {
  let opcode = 0x80;
  const offsetBytes: number[] = [];
  const sizeBytes: number[] = [];
  let o = offset;
  for (let bit = 0; bit < 4; bit += 1) {
    if (o & 0xff) {
      opcode |= 1 << bit;
      offsetBytes.push(o & 0xff);
    }
    o >>= 8;
  }
  let s = size === 0x10000 ? 0 : size;
  for (let bit = 0; bit < 3; bit += 1) {
    if (s & 0xff) {
      opcode |= 1 << (bit + 4);
      sizeBytes.push(s & 0xff);
    }
    s >>= 8;
  }
  return Buffer.concat([Buffer.from([opcode]), Buffer.from(offsetBytes), Buffer.from(sizeBytes)]);
}

/**
 * Build a delta turning `base` into `target` (copy common prefix + suffix,
 * insert the differing middle as literals). Returns null when the delta is
 * not smaller than the target itself.
 */
export function makeDelta(base: Buffer, target: Buffer): Buffer | null {
  if (base.equals(target)) return null;
  const prefix = commonPrefixLength(base, target);
  const suffix = commonSuffixLength(base, target, Math.min(base.length, target.length) - prefix);
  const middleStart = prefix;
  const middleEnd = target.length - suffix;
  const ops: Buffer[] = [];
  if (prefix > 0) ops.push(deltaCopyOp(0, prefix));
  let at = middleStart;
  while (at < middleEnd) {
    const chunk = Math.min(127, middleEnd - at);
    ops.push(Buffer.concat([Buffer.from([chunk]), target.subarray(at, at + chunk)]));
    at += chunk;
  }
  if (suffix > 0) ops.push(deltaCopyOp(base.length - suffix, suffix));
  const delta = Buffer.concat([encodeDeltaVarint(base.length), encodeDeltaVarint(target.length), ...ops]);
  return delta.length < target.length ? delta : null;
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

/** The type/size varint header of one pack entry. */
function writePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** git's OFS_DELTA base-offset encoding (distance back from the delta entry). */
function encodeOfsOffset(distance: number): Buffer {
  const bytes: number[] = [distance & 0x7f];
  let n = distance >> 7;
  while (n > 0) {
    n -= 1;
    bytes.unshift(0x80 | (n & 0x7f));
    n >>= 7;
  }
  return Buffer.from(bytes);
}

interface PackEntryPlan {
  oid: string;
  type: ObjectType;
  payload: Buffer;
  /** OFS_DELTA against this already-emitted oid, with its delta bytes. */
  deltaBaseOid?: string;
  delta?: Buffer;
}

/**
 * Build a pack v2 from an explicit set of object ids. Blobs that share a long
 * common prefix/suffix with an already-emitted full blob are sent as
 * OFS_DELTA against it (single level: delta bases are always full objects,
 * emitted before their deltas). Deterministic: full objects sorted by sha,
 * then deltas sorted by sha.
 */
/** True when the two payloads share their first `n` bytes (a cheap delta-candidate filter). */
function sharesHead(a: Buffer, b: Buffer, n: number): boolean {
  const m = Math.min(n, a.length, b.length);
  if (m === 0) return false;
  for (let i = 0; i < m; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function buildPackFromShas(objects: Map<string, Buffer>, shas: Set<string>): Buffer {
  const entries: PackEntryPlan[] = [];
  for (const oid of shas) {
    const raw = objects.get(oid);
    if (!raw) throw new Error(`object ${oid} is missing from the store`);
    const split = splitRaw(raw);
    if (!split) throw new Error(`object ${oid} is corrupt`);
    entries.push({ oid, type: split.type, payload: split.payload });
  }
  entries.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));

  // Choose deltas: for each blob, the best full blob already chosen as a base.
  // Two guards keep this cheap on a 200-file repo (the clone workload builds the
  // same pack 50 times): a pair is only tried when the blobs share a 32-byte head
  // (a delta between unrelated blobs is never smaller, and the O(payload) builder
  // is the expensive part), and the search stops at the first base that halves
  // the blob — trying every base is O(n^2) and dominates the pack build.
  const fullBlobs: PackEntryPlan[] = [];
  for (const entry of entries) {
    if (entry.type !== 'blob') continue;
    let best: { base: PackEntryPlan; delta: Buffer } | null = null;
    for (const base of fullBlobs) {
      if (base.payload.equals(entry.payload)) continue;
      if (!sharesHead(base.payload, entry.payload, 32)) continue;
      const delta = makeDelta(base.payload, entry.payload);
      if (delta && (!best || delta.length < best.delta.length)) best = { base, delta };
      if (best !== null && best.delta.length * 2 <= entry.payload.length) break;
    }
    if (best) {
      entry.deltaBaseOid = best.base.oid;
      entry.delta = best.delta;
    } else {
      fullBlobs.push(entry);
    }
  }

  const full = entries.filter((e) => !e.delta).sort((a, b) => (a.oid < b.oid ? -1 : 1));
  const deltas = entries.filter((e) => e.delta).sort((a, b) => (a.oid < b.oid ? -1 : 1));
  const ordered = [...full, ...deltas];
  const offsetByOid = new Map<string, number>();

  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(ordered.length, 8);
  parts.push(header);
  let offset = 12;
  for (const entry of ordered) {
    const entryOffset = offset;
    offsetByOid.set(entry.oid, entryOffset);
    if (entry.delta && entry.deltaBaseOid) {
      const baseOffset = offsetByOid.get(entry.deltaBaseOid);
      if (baseOffset === undefined) throw new Error('delta base was not emitted before its delta');
      const distance = entryOffset - baseOffset;
      const head = writePackObjectHeader(6, entry.delta.length);
      const ofs = encodeOfsOffset(distance);
      const data = deflateSync(entry.delta);
      parts.push(head, ofs, data);
      offset += head.length + ofs.length + data.length;
    } else {
      const head = writePackObjectHeader(TYPE_CODE[entry.type], entry.payload.length);
      const data = deflateSync(entry.payload);
      parts.push(head, data);
      offset += head.length + data.length;
    }
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Build a pack v2 holding every object reachable from `wantShas` but not
 * from `haveShas`.
 */
export function buildPack(objects: Map<string, Buffer>, wantShas: string[], haveShas: Set<string>): Buffer {
  const wanted = collectReachable(objects, wantShas);
  const held = collectReachable(objects, haveShas, { allowMissing: true });
  for (const oid of held) wanted.delete(oid);
  return buildPackFromShas(objects, wanted);
}

// ---------------------------------------------------------------------------------------------
// packfile parse
// ---------------------------------------------------------------------------------------------

function readPackSizeHeader(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream starting at `offset` (absolute in `buffer`). */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjectType;
  resolved?: Buffer;
  oid?: string;
}

/**
 * Parse a pack v2 and write every object into `objects` as raw loose-object
 * bytes. OFS_DELTA and REF_DELTA are both resolved; a thin pack's REF_DELTA
 * base may already live in `objects` (it is looked up there, and in objects
 * resolved earlier in this same pack). Returns the shas that were NEW to the
 * map (in pack order, deduplicated).
 */
export function parsePack(buf: Buffer, objects: Map<string, Buffer>): string[] {
  const buffer = buf;
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error(`pack trailer ${trailer} does not match its bytes ${computed}`);

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackSizeHeader(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const externalRaw = objects.get(wanted);
        const external = externalRaw ? splitRaw(externalRaw) : null;
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.payload, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  const newShas: string[] = [];
  const seenNew = new Set<string>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    const alreadyHad = objects.has(resolved.oid);
    if (!alreadyHad) {
      objects.set(resolved.oid, rawObjectBytes(resolved.type, resolved.data));
    }
    if (!alreadyHad && !seenNew.has(resolved.oid)) {
      seenNew.add(resolved.oid);
      newShas.push(resolved.oid);
    }
  }
  return newShas;
}

/** "type <len>\0" + payload, the raw bytes the store keeps per object. */
function rawObjectBytes(type: ObjectType, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, 'utf8'), payload]);
}

export { ZERO_OID };
