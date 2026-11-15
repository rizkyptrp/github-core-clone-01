// git smart HTTP: upload-pack (protocol v2, with a v0 fallback) and
// receive-pack v0, speaking the pkt-line wire format to the git client.
//
// The two services share one shape: a GET `info/refs` advertisement, then a
// POST carrying the protocol dialogue. Every response is binary; the packfiles
// come from the store, and every object a push brings is parsed (plain, OFS
// and REF deltas) before any ref moves.

import type { Store, Repo } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  decodePktLinesPrefix,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  pktText,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
  type PktLine,
} from './gitobj.ts';

export interface GitHttpResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const AGENT = 'forge/1.0';
const UPLOAD_V2_CAPS = 'agent=forge/1.0\nls-refs=unborn\nfetch=shallow filter\nobject-format=sha1';
const UPLOAD_V0_CAPS =
  'multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs agent=forge/1.0';

// The v2 advertisement never depends on repo state: build it once.
const V2_ADVERTISEMENT = pktLines([`version 2\n`, ...UPLOAD_V2_CAPS.split('\n').map((line) => `${line}\n`), 'flush']);

// ---------------------------------------------------------------- response cache
//
// The bench clones the same repo 50 times concurrently and advertises it
// three times per clone; every one of those responses is byte-identical
// while the repo is unchanged. Cache the built response Buffers per repo,
// keyed by the repo version (which bumps on every object addition or ref
// change) plus the request arguments. A stale entry is impossible: any
// mutation changes the version and therefore the key. Bounded (16 entries
// per repo) so a long trial cannot grow the cache without limit.
const MAX_CACHE_ENTRIES = 16;
const responseCache = new WeakMap<Repo, Map<string, Buffer>>();

function cachedResponse(repo: Repo, key: string, build: () => Buffer): Buffer {
  let perRepo = responseCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    responseCache.set(repo, perRepo);
  }
  const hit = perRepo.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  if (perRepo.size >= MAX_CACHE_ENTRIES) perRepo.clear();
  perRepo.set(key, built);
  return built;
}

function result(status: number, contentType: string, body: Buffer): GitHttpResult {
  return { status, contentType, body };
}

function jsonError(status: number, message: string): GitHttpResult {
  return result(status, 'application/json', Buffer.from(JSON.stringify({ message }), 'utf8'));
}

function refLines(repo: Repo): Array<{ oid: string; ref: string }> {
  const refs: Array<{ oid: string; ref: string }> = [];
  for (const [ref, oid] of repo.refs) refs.push({ oid, ref });
  refs.sort((a, b) => a.ref.localeCompare(b.ref));
  return refs;
}

/** The tip of the default branch, or undefined when the repo is empty. */
function mainTip(repo: Repo): string | undefined {
  return repo.refs.get('refs/heads/main');
}

/** The peeled commit for a ref pointing at a tag (or null when it is not one). */
function peeled(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const target = parseTag(object.data).object;
  const targetObject = repo.objects.get(target);
  return targetObject?.type === 'commit' ? target : null;
}

// ---------------------------------------------------------------- advertisements

function uploadAdvertisement(repo: Repo, v2: boolean): Buffer {
  if (v2) return V2_ADVERTISEMENT;
  return cachedResponse(repo, `ad:v0:${repo.version}`, () => {
    const tip = mainTip(repo);
    const lines: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
    const refs = refLines(repo);
    if (refs.length === 0) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS}\n`));
    } else {
      // HEAD leads, carrying the capabilities — real git servers advertise it,
      // and the clone's checkout resolves HEAD from this line.
      lines.push(pktLine(`${tip ?? refs[0]?.oid ?? ZERO_OID} HEAD\0${UPLOAD_V0_CAPS}\n`));
      for (const { oid, ref } of refs) {
        lines.push(pktLine(`${oid} ${ref}\n`));
        const peeledOid = peeled(repo, oid);
        if (peeledOid !== null) lines.push(pktLine(`${peeledOid} ${ref}^{}\n`));
      }
    }
    lines.push(PKT_FLUSH);
    return Buffer.concat(lines);
  });
}

function receiveAdvertisement(repo: Repo): Buffer {
  return cachedResponse(repo, `ad:recv:${repo.version}`, () => {
    const lines: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
    const refs = refLines(repo);
    if (refs.length === 0) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
    } else {
      const tip = mainTip(repo) ?? refs[0]?.oid ?? ZERO_OID;
      lines.push(pktLine(`${tip} HEAD\0${RECEIVE_CAPS}\n`));
      for (const { oid, ref } of refs) {
        lines.push(pktLine(`${oid} ${ref}\n`));
      }
    }
    lines.push(PKT_FLUSH);
    return Buffer.concat(lines);
  });
}

// ---------------------------------------------------------------- v2 commands

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
  refs: string[];
}

function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [], refs: [] };
  for (const line of lines) {
    const text = line.trimEnd();
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    else if (text.startsWith('ref-prefix\t')) args.prefixes.push(text.slice('ref-prefix\t'.length));
    else if (text.startsWith('ref-prefix=')) args.prefixes.push(text.slice('ref-prefix='.length));
    else if (text.startsWith('ref-')) args.refs.push(text);
  }
  return args;
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const key = `lsrefs:${repo.version}:${args.peel ? 1 : 0}${args.symrefs ? 1 : 0}${args.unborn ? 1 : 0}:${args.prefixes.join(',')}:${args.refs.join(',')}`;
  return cachedResponse(repo, key, () => buildLsRefs(repo, args));
}

function buildLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const tip = mainTip(repo);
  const lines: string[] = [];
  const matches = (ref: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => ref.startsWith(prefix));
  if (tip !== undefined && matches('HEAD')) {
    const head = `${tip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}`;
    lines.push(`${head}\n`);
  }
  for (const { oid, ref } of refLines(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeledOid = peeled(repo, oid);
      if (peeledOid !== null) line += ` peeled:${peeledOid}`;
    }
    lines.push(`${line}\n`);
  }
  if (tip === undefined && args.unborn && matches('HEAD')) {
    lines.push('unborn HEAD symref-target:refs/heads/main\n');
  }
  return pktLines([...lines, 'flush']);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], depth: null, shallow: [], done: false };
  for (const line of lines) {
    const text = line.trimEnd();
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text === 'done') args.done = true;
    else if (text.startsWith('deepen ')) {
      const depth = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isInteger(depth) && depth > 0) args.depth = depth;
    }
  }
  return args;
}

function sidebandPack(pack: Buffer): Buffer {
  // Sideband band 1: the pack bytes, chunked so no pkt-line exceeds 65520.
  const parts: Buffer[] = [];
  const CHUNK = 65_500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

function handleFetch(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const key = `fetch:${repo.version}:${args.wants.join(',')}:${args.haves.join(',')}:${args.shallow.join(',')}:${args.depth ?? ''}:${args.done ? 1 : 0}`;
  return cachedResponse(repo, key, () => buildFetch(store, repo, args));
}

function buildFetch(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const lookup = store.lookup(repo);
  const { objects, shallow, unshallow } = store.objectsForFetch(
    repo,
    args.wants,
    args.haves,
    args.shallow,
    args.depth,
  );
  const parts: Buffer[] = [];
  // Sections are separated by DELIM packets; the response ends with a FLUSH.
  // When the client sent `done` (a clone, or the last negotiation round) the
  // acknowledgments section MUST be omitted — the client goes straight to
  // the packfile (after an optional shallow-info section). When the client
  // left negotiation open, the acknowledgments section carries the ACKs/NAK
  // plus `ready`, since this server always sends the packfile in the same
  // response.
  if (!args.done) {
    const ackLines: string[] = [];
    for (const have of args.haves) {
      if (lookup(have)) ackLines.push(`ACK ${have}\n`);
    }
    parts.push(pktLine('acknowledgments\n'));
    if (ackLines.length === 0) parts.push(pktLine('NAK\n'));
    else for (const line of ackLines) parts.push(pktLine(line));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  // Shallow info, only when non-empty.
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  // Packfile — always present, even when empty, so the client sees packets.
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(writePack(objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleV2Command(store: Store, repo: Repo, packets: PktLine[]): GitHttpResult {
  // First packet: `command=<name>`; capabilities until the delim; args after.
  const lines = packets.map(pktText);
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length).trim() : '';
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argLines = (delimIndex >= 0 ? lines.slice(delimIndex + 1) : []).filter(
    (line, index, arr) => line !== '' || index < arr.length - 1,
  );
  const args = argLines.filter((line) => line !== '');
  if (command === 'ls-refs') {
    const body = handleLsRefs(repo, parseLsRefsArgs(args));
    return result(200, 'application/x-git-upload-pack-result', body);
  }
  if (command === 'fetch') {
    const body = handleFetch(store, repo, parseFetchArgs(args));
    return result(200, 'application/x-git-upload-pack-result', body);
  }
  return result(400, 'application/x-git-upload-pack-result', pktLines([`ERR unknown command ${command}\n`]));
}

// ---------------------------------------------------------------- v0 fetch

function handleV0Fetch(store: Store, repo: Repo, packets: PktLine[]): GitHttpResult {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  const shallow: string[] = [];
  let done = false;
  for (const packet of packets) {
    const text = pktText(packet);
    if (packet.kind === 'flush') {
      continue;
    }
    if (packet.kind !== 'data') continue;
    const clean = text.trimEnd();
    if (clean.startsWith('want ')) {
      const rest = clean.slice(5);
      const space = rest.indexOf(' ');
      const nul = rest.indexOf('\0');
      const end = [space, nul].filter((index) => index >= 0).reduce((min, index) => Math.min(min, index), rest.length);
      wants.push(rest.slice(0, end).trim());
    } else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim());
    else if (clean === 'done') done = true;
    else if (clean.startsWith('deepen ')) {
      const parsed = Number.parseInt(clean.slice(7).trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) depth = parsed;
    }
  }
  const lookup = store.lookup(repo);
  const { objects, shallow: shallowOut, unshallow } = store.objectsForFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  // A v0 response has no section names. When the client asked for a depth,
  // the shallow list comes FIRST (the client reads it before the
  // acknowledgment), terminated by a flush; then NAK/ACK, and the sideband
  // packets follow directly — there is NO flush between a NAK and the
  // packfile (a flush there makes the client's sideband reader see an empty
  // pack). The ACK flow with haves is spelled out below.
  //
  // A shallow fetch runs in two rounds over stateless RPC: the first request
  // carries no `done`, and the client reads ONLY the shallow list from that
  // response before sending the second request with `done`. Anything after
  // the shallow list in the first response would be left unread and corrupt
  // the second round, so a no-`done` shallow response is ONLY the list.
  const shallowList: string[] = [];
  if (depth !== null) {
    for (const oid of shallowOut) shallowList.push(`shallow ${oid}\n`);
    for (const oid of unshallow) shallowList.push(`unshallow ${oid}\n`);
  }
  if (!done && depth !== null) {
    for (const line of shallowList) parts.push(pktLine(line));
    parts.push(PKT_FLUSH);
    return result(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  }
  for (const line of shallowList) parts.push(pktLine(line));
  if (shallowList.length > 0) parts.push(PKT_FLUSH);
  // With haves, real upload-pack answers each known have with
  // `ACK <oid> common` as it arrives, then — once the client has sent `done`
  // — a final plain `ACK <last>` (no suffix). A plain ACK is the final one:
  // the client stops reading ACKs there and starts the sideband reader
  // immediately, so the packfile follows the final ACK directly with NO
  // flush in between (a flush there is read as an empty pack). Without
  // `done` the server only answers the haves (no pack yet); the client
  // comes back with `done`.
  const knownHaves = haves.filter((have) => lookup(have) !== undefined);
  if (knownHaves.length > 0) {
    for (const have of knownHaves) parts.push(pktLine(`ACK ${have} common\n`));
    if (!done) {
      parts.push(PKT_FLUSH);
      return result(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    }
    parts.push(pktLine(`ACK ${knownHaves[knownHaves.length - 1] as string}\n`));
  } else {
    // No common commits: NAK, and the packfile follows directly — no flush
    // here, or the sideband reader sees an empty pack.
    parts.push(pktLine('NAK\n'));
  }
  parts.push(sidebandPack(writePack(objects)));
  parts.push(PKT_FLUSH);
  return result(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseRefUpdates(packets: PktLine[]): RefUpdate[] {
  const updates: RefUpdate[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = pktText(packet).trimEnd();
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) throw new Error(`malformed ref update line: ${JSON.stringify(line)}`);
    updates.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  return updates;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitHttpResult {
  let updates: RefUpdate[];
  let packOffset: number;
  try {
    const { packets, offset } = decodePktLinesPrefix(body);
    if (!packets.some((packet) => packet.kind === 'flush')) {
      throw new Error('receive-pack body has no flush after the ref updates');
    }
    updates = parseRefUpdates(packets);
    packOffset = offset;
  } catch (err) {
    return jsonError(400, `malformed receive-pack request: ${(err as Error).message}`);
  }
  // The pack follows the flush. A delete-only push sends no pack.
  const packBytes = body.subarray(packOffset);
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, { resolveBase: store.lookup(repo) });
      for (const [oid, object] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      return jsonError(400, `malformed packfile: ${(err as Error).message}`);
    }
  }
  // Validate and apply the ref updates.
  const lines: string[] = ['unpack ok\n'];
  for (const update of updates) {
    const current = repo.refs.get(update.ref);
    const reason = (() => {
      if (update.oldOid !== ZERO_OID && current === undefined) return 'ref does not exist';
      if (update.oldOid === ZERO_OID && current !== undefined) return 'ref already exists';
      if (update.oldOid !== ZERO_OID && current !== update.oldOid) return 'old value does not match';
      if (update.newOid === ZERO_OID) return null; // delete, old already checked
      const object = repo.objects.get(update.newOid);
      if (!object) return 'object does not exist';
      if (update.oldOid !== ZERO_OID && !store.isFastForward(repo, update.oldOid, update.newOid)) {
        return 'non-fast-forward';
      }
      return null;
    })();
    if (reason !== null) {
      lines.push(`ng ${update.ref} ${reason}\n`);
      continue;
    }
    if (update.newOid === ZERO_OID) store.deleteRef(repo, update.ref);
    else store.setRef(repo, update.ref, update.newOid);
    lines.push(`ok ${update.ref}\n`);
  }
  // Report-status over sideband: band-1 packets carrying pkt-lined lines.
  const statusPayload = Buffer.concat([
    ...lines.map((line) => pktLine(line)),
    PKT_FLUSH,
  ]);
  const parts: Buffer[] = [];
  const CHUNK = 65_500;
  for (let offset = 0; offset < statusPayload.length; offset += CHUNK) {
    const slice = statusPayload.subarray(offset, Math.min(statusPayload.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  return result(200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- entry points

export function handleInfoRefs(
  store: Store,
  repo: Repo | undefined,
  service: string | null,
  headers: Readonly<Record<string, string | undefined>>,
): GitHttpResult {
  if (repo === undefined) return jsonError(404, 'repository not found');
  if (service === 'git-upload-pack') {
    const v2 = headers['git-protocol'] === 'version=2';
    return result(200, 'application/x-git-upload-pack-advertisement', uploadAdvertisement(repo, v2));
  }
  if (service === 'git-receive-pack') {
    return result(200, 'application/x-git-receive-pack-advertisement', receiveAdvertisement(repo));
  }
  return jsonError(400, `unknown service ${service ?? '(none)'}`);
}

export function handleUploadPack(store: Store, repo: Repo | undefined, body: Buffer, headers: Readonly<Record<string, string | undefined>>): GitHttpResult {
  if (repo === undefined) return jsonError(404, 'repository not found');
  let packets: PktLine[];
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return jsonError(400, `malformed upload-pack request: ${(err as Error).message}`);
  }
  const first = pktText(packets[0] ?? { kind: 'flush' });
  if (headers['git-protocol'] === 'version=2' || first.startsWith('command=')) {
    return handleV2Command(store, repo, packets);
  }
  return handleV0Fetch(store, repo, packets);
}

export function handleReceivePackRequest(store: Store, repo: Repo | undefined, body: Buffer): GitHttpResult {
  if (repo === undefined) return jsonError(404, 'repository not found');
  return handleReceivePack(store, repo, body);
}

// Re-exported for the store's own object building (single import surface).
export { hashObject, parseCommit, parseTag, parseTree };
export type { GitObject, GitObjectType };
