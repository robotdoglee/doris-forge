// Git smart HTTP, implemented from the protocol up: pkt-lines, ref advertisements (v0 and v2),
// ls-refs, the v2 fetch with shallow/deepen support, v0 receive-pack with report-status, and
// packfile read/write with delta resolution. No git binary exists in the trial; node:zlib and
// node:crypto are the only machinery.
//
// Choices that keep the suite's client happy:
//   - upload-pack answers v2 only when the request carries `Git-Protocol: version=2`; otherwise v0
//   - packs sent to the client are complete (never thin) and delta-free; packs received from the
//     client may carry OFS/REF deltas and are fully resolved before anything is stored
//   - fetch object selection is exact set arithmetic: the closure of the wants (depth-limited when
//     asked) minus the closure the client provably holds (haves walked fully, shallow boundaries
//     walked to their trees but not their parents)

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';
import { Forge, Repo, ZERO_SHA, parseTag, type ObjType } from './store.ts';
import type { Req, Res } from './http.ts';

const AGENT = 'doris-forge/1.0';
const ZERO = ZERO_SHA;

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer): Buffer {
  const length = payload.length + 4;
  const head = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'ascii'), payload]);
}

export function pktText(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Split a buffer into pkt-lines; returns the packets and the unparsed remainder (a pack, usually). */
export function splitPkts(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let at = 0;
  while (at + 4 <= buffer.length) {
    const head = buffer.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      // A flush ends the pkt-line section of a receive-pack request; what follows is the pack.
      return { packets, rest: buffer.subarray(at) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, rest: buffer.subarray(at) };
}

// ---------------------------------------------------------------- packfiles

const TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjType | 'ofs' | 'ref'> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs', 7: 'ref' };

function inflateAt(buffer: Buffer, offset: number): Promise<{ data: Buffer; bytesRead: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), bytesRead: stream.bytesRead }));
    stream.on('error', reject);
    stream.end(buffer.subarray(offset));
  });
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size (the base length; trusted)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[at++] as number;
      if (op & 0x02) offset |= (delta[at++] as number) << 8;
      if (op & 0x04) offset |= (delta[at++] as number) << 16;
      if (op & 0x08) offset |= (delta[at++] as number) << 24;
      if (op & 0x10) size = delta[at++] as number;
      if (op & 0x20) size |= (delta[at++] as number) << 8;
      if (op & 0x40) size |= (delta[at++] as number) << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta size mismatch');
  return result;
}

export interface PackObject {
  type: ObjType;
  data: Buffer;
}

/**
 * Read a packfile fully, resolving deltas. Bases may live inside the pack or, for a thin pack,
 * in `external` (the receiving repository). Returns the objects by id.
 */
export async function readPack(pack: Buffer, external?: (oid: string) => PackObject | undefined): Promise<Map<string, PackObject>> {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  interface RawEntry {
    offset: number;
    type: ObjType | 'ofs' | 'ref';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    const start = at;
    let byte = pack[at] as number;
    at += 1;
    const typeId = (byte >> 4) & 0x7;
    while (byte & 0x80) {
      byte = pack[at] as number;
      at += 1;
    }
    const type = ID_TYPES[typeId];
    if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
    const entry: RawEntry = { offset: start, type, data: Buffer.alloc(0) };
    if (type === 'ofs') {
      let b = pack[at] as number;
      at += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[at] as number;
        at += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = start - offset;
    } else if (type === 'ref') {
      entry.baseOid = pack.toString('hex', at, at + 20);
      at += 20;
    }
    const inflated = await inflateAt(pack, at);
    entry.data = inflated.data;
    at += inflated.bytesRead;
    byOffset.set(start, entries.length);
    entries.push(entry);
  }

  const resolved = new Map<string, PackObject>();
  const resolvedByIndex = new Map<number, PackObject & { oid: string }>();
  const resolveIndex = (index: number, depth: number): PackObject & { oid: string } => {
    const memo = resolvedByIndex.get(index);
    if (memo !== undefined) return memo;
    if (depth > 64) throw new Error('delta chain too deep');
    const entry = entries[index] as RawEntry;
    let object: PackObject;
    if (entry.type === 'ofs' || entry.type === 'ref') {
      let base: PackObject | undefined;
      if (entry.type === 'ofs') {
        const baseIndex = byOffset.get(entry.baseOffset as number);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
        base = resolveIndex(baseIndex, depth + 1);
      } else {
        const inPack = [...resolvedByIndex.values()].find((candidate) => candidate.oid === entry.baseOid);
        base = inPack ?? external?.(entry.baseOid as string);
        if (base === undefined) {
          // The base may be an unresolved pack entry: find it by scanning resolved ids later.
          for (let j = 0; j < entries.length; j += 1) {
            const candidate = resolveIndex(j, depth + 1);
            if (candidate.oid === entry.baseOid) {
              base = candidate;
              break;
            }
          }
        }
      }
      if (base === undefined) throw new Error('delta base not found');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    const { objectId } = awaitObjectId();
    const oid = objectId(object.type, object.data);
    const full = { ...object, oid };
    resolvedByIndex.set(index, full);
    resolved.set(oid, object);
    return full;
  };
  for (let i = 0; i < entries.length; i += 1) resolveIndex(i, 0);
  return resolved;
}

// objectId lives in store.ts; this indirection keeps the import graph flat and obvious.
import { objectId as storeObjectId } from './store.ts';
function awaitObjectId(): { objectId: typeof storeObjectId } {
  return { objectId: storeObjectId };
}

/** Serialise objects into a complete, delta-free packfile (version 2, sha1 trailer). */
export function writePack(objects: readonly (PackObject & { oid: string })[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const object of objects) {
    const size = object.data.length;
    const typeId = TYPE_IDS[object.type];
    const bytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    let rest = size;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- object selection

/** Tree-and-blob closure of one commit (the commit itself is not included). */
function treeClosure(repo: Repo, commitSha: string, into: Set<string>): void {
  const info = repo.commitInfo(commitSha);
  if (info === null) return;
  const walk = (treeSha: string): void => {
    if (into.has(treeSha)) return;
    const object = repo.getObject(treeSha);
    if (object === undefined || object.type !== 'tree') return;
    into.add(treeSha);
    for (const entry of parseTreeEntries(repo, treeSha)) {
      if (entry.mode === '40000') walk(entry.sha);
      else into.add(entry.sha);
    }
  };
  walk(info.tree);
}

import { parseTree } from './store.ts';
function parseTreeEntries(repo: Repo, treeSha: string): { mode: string; name: string; sha: string }[] {
  const object = repo.getObject(treeSha);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

export interface FetchSelection {
  objects: Set<string>;
  shallow: Set<string>;
}

/**
 * The objects a fetch sends: the wants' closure (generation-limited when `depth` is set), minus
 * what the client holds. `held` walks the haves fully except through shallow boundaries.
 */
export function selectFetchObjects(repo: Repo, wants: readonly string[], haves: readonly string[], clientShallow: ReadonlySet<string>, depth: number | null): FetchSelection {
  const include = new Set<string>();
  const shallow = new Set<string>();
  // Generation-limited (or full) walk from the wants.
  const generations = new Map<string, number>();
  let frontier: string[] = [];
  for (const want of wants) {
    const target = repo.peelToCommit(want);
    if (target === null) {
      if (repo.getObject(want) !== undefined) include.add(want);
      continue;
    }
    if (repo.getObject(want)?.type === 'tag') include.add(want);
    if (!generations.has(target)) {
      generations.set(target, 1);
      frontier.push(target);
    }
  }
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      const generation = generations.get(sha) as number;
      include.add(sha);
      treeClosure(repo, sha, include);
      const info = repo.commitInfo(sha);
      if (info === null) continue;
      const atLimit = depth !== null && generation >= depth;
      if (atLimit) {
        if (info.parents.length > 0) shallow.add(sha);
        continue;
      }
      for (const parent of info.parents) {
        if (!generations.has(parent)) {
          generations.set(parent, generation + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  // What the client already holds.
  const held = new Set<string>();
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const target = repo.peelToCommit(sha);
    if (target === null) continue;
    if (repo.getObject(sha)?.type === 'tag') held.add(sha);
    held.add(target);
    treeClosure(repo, target, held);
    if (clientShallow.has(sha) || clientShallow.has(target)) continue;
    const info = repo.commitInfo(target);
    if (info !== null) stack.push(...info.parents);
  }

  for (const oid of held) include.delete(oid);
  return { objects: include, shallow };
}

/** The full object closure of tips (used to validate pushes and compute fast-forwards). */
export function fullClosure(repo: Repo, tips: readonly string[]): Set<string> {
  return selectFetchObjects(repo, tips, [], new Set(), null).objects;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return repo.ancestorDepths(descendant).has(ancestor);
}

// ---------------------------------------------------------------- advertisements

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`
      : `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktText(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headTip = repo.branchTip(repo.defaultBranch);
    if (headTip !== null) {
      lines.push(pktText(`${headTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      lines.push(pktText(first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`));
      first = false;
      const peeled = repo.peelToCommit(oid);
      if (peeled !== null && peeled !== oid) lines.push(pktText(`${peeled} ${ref}^{}\n`));
    }
  }
  return Buffer.concat([pktText(`# service=${service}\n`), PKT_FLUSH, ...lines, PKT_FLUSH]);
}

function v2Advertisement(service: string): Buffer {
  const lines = [
    pktText('version 2\n'),
    pktText(`agent=${AGENT}\n`),
    pktText('ls-refs=unborn\n'),
    pktText('fetch=shallow\n'),
    pktText('object-format=sha1\n'),
  ];
  return Buffer.concat([pktText(`# service=${service}\n`), PKT_FLUSH, ...lines, PKT_FLUSH]);
}

// ---------------------------------------------------------------- ls-refs

function lsRefs(repo: Repo, packets: Pkt[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const target = headTarget(repo);
  const headTip = repo.branchTip(repo.defaultBranch);
  if (matches('HEAD')) {
    if (headTip !== null) {
      out.push(pktText(`${headTip} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      out.push(pktText(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = repo.peelToCommit(oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    out.push(pktText(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(packets: Pkt[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32_768;
  for (let at = 0; at < data.length; at += CHUNK) {
    const chunk = data.subarray(at, at + CHUNK);
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

function fetchResponse(repo: Repo, packets: Pkt[]): Buffer {
  const args = parseFetchArgs(packets);
  const clientShallow = new Set(args.shallow);
  const selection = selectFetchObjects(repo, args.wants, args.haves, clientShallow, args.depth);

  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktText('acknowledgments\n'));
  const existingHaves = args.haves.filter((have) => repo.getObject(have) !== undefined);
  if (existingHaves.length === 0) {
    parts.push(pktText('NAK\n'));
  } else {
    for (const have of existingHaves) parts.push(pktText(`ACK ${have}\n`));
    parts.push(pktText('ready\n'));
  }
  parts.push(PKT_DELIM);
  // shallow-info (only meaningful for depth fetches, but harmless to scope to them)
  if (args.depth !== null) {
    const unshallow = [...clientShallow].filter((oid) => selection.objects.has(oid) || (repo.commitInfo(oid) !== null && !selection.shallow.has(oid) && args.wants.length > 0 && repo.ancestorDepths(args.wants[0] as string).has(oid)));
    const shallowLines = [...selection.shallow];
    if (shallowLines.length > 0 || unshallow.length > 0) {
      parts.push(pktText('shallow-info\n'));
      for (const oid of shallowLines) parts.push(pktText(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktText(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
  }
  // packfile
  const cacheKey = `fetch|${[...args.wants].sort().join(',')}|${[...args.haves].sort().join(',')}|${args.depth ?? 'full'}|${[...clientShallow].sort().join(',')}`;
  let pack = repo.packCache.get(cacheKey);
  if (pack === undefined) {
    const objects = [...selection.objects]
      .map((oid) => {
        const object = repo.getObject(oid);
        return object === undefined ? null : { oid, type: object.type, data: object.data };
      })
      .filter((entry): entry is { oid: string; type: ObjType; data: Buffer } => entry !== null);
    pack = writePack(objects);
    repo.packCache.set(cacheKey, pack);
  }
  parts.push(pktText('packfile\n'));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function receivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  const { packets, rest } = splitPkts(body);
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean).map((cap) => cap.split('=')[0] as string));
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = await readPack(rest, (oid) => repo.getObject(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const reason = applyPushCommand(repo, command);
    reportLines.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pktText(`${line}\n`)), PKT_FLUSH]);

  if (capabilities.has('side-band-64k')) {
    return Buffer.concat([...sidebandPackets(report, 1), PKT_FLUSH]);
  }
  return report;
}

/** Apply one ref update; returns the refusal reason, or null when it applied. */
function applyPushCommand(repo: Repo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO;
  if (command.newOid === ZERO) {
    // delete
    if (current === ZERO) return 'reference not found';
    if (command.oldOid !== ZERO && command.oldOid !== current) return 'stale info';
    repo.setRef(command.ref, null);
    return null;
  }
  const newObject = repo.getObject(command.newOid);
  if (newObject === undefined) return 'not found';
  if (current === ZERO) {
    if (command.oldOid !== ZERO) return 'stale info';
    repo.setRef(command.ref, command.newOid);
    return null;
  }
  if (command.oldOid !== current) return 'stale info';
  if (current === command.newOid) return null;
  // update: branches must fast-forward (tags are peeled to commits for the same test)
  const oldCommit = repo.peelToCommit(current);
  const newCommit = repo.peelToCommit(command.newOid);
  if (oldCommit !== null && newCommit !== null && !isAncestor(repo, oldCommit, newCommit)) {
    return 'non-fast-forward';
  }
  repo.setRef(command.ref, command.newOid);
  return null;
}

// ---------------------------------------------------------------- the handler

export async function handleGit(forge: Forge, req: Req, res: Res, owner: string, repoName: string, rest: string[]): Promise<void> {
  if (!req.authed) {
    res.raw(401, Buffer.from('authentication required\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const repo = forge.resolveRepo(owner, repoName);
  if (repo === null) {
    res.raw(404, Buffer.from('repository not found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const path = rest.join('/');

  if (req.method === 'GET' && path === 'info/refs') {
    const service = req.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.raw(400, Buffer.from('unknown service\n', 'utf8'), 'text/plain; charset=utf-8');
      return;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    const body = wantsV2 ? v2Advertisement(service) : v0Advertisement(repo, service);
    res.raw(200, body, `application/x-${service}-advertisement`, { 'cache-control': 'no-cache' });
    return;
  }

  if (req.method === 'POST' && path === 'git-upload-pack') {
    const { packets } = splitPkts(req.body);
    const commandLine = packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
    if (commandLine === 'command=ls-refs') {
      res.raw(200, lsRefs(repo, packets), 'application/x-git-upload-pack-result');
      return;
    }
    if (commandLine === 'command=fetch') {
      res.raw(200, fetchResponse(repo, packets), 'application/x-git-upload-pack-result');
      return;
    }
    res.raw(400, Buffer.from('unknown command\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }

  if (req.method === 'POST' && path === 'git-receive-pack') {
    const report = await receivePack(repo, req.body);
    res.raw(200, report, 'application/x-git-receive-pack-result');
    return;
  }

  res.raw(404, Buffer.from('not found\n', 'utf8'), 'text/plain; charset=utf-8');
}
