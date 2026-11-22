import { createHash } from 'node:crypto';
import path from 'node:path';
import { issue } from './errors.js';

const headerLimit = 16 * 1024 * 1024;
const blockLimit = 16 * 1024 * 1024;
const chunkBytes = 64 * 1024;
const headerCache = new Map();

function invalid() {
  return issue('ASAR_INVALID', 'Invalid ASAR header, entry metadata or data range.');
}

// ASAR stores an eight-byte size Pickle, a JSON-header Pickle, then packed data.
// https://github.com/electron/asar/blob/main/src/disk.ts
export function splitAsar(target) {
  const match = /(?:^|[\\/])[^\\/]+\.asar(?=[\\/]|$)/iu.exec(target);
  if (!match) return null;
  const end = match.index + match[0].length;
  return { archive: target.slice(0, end), entry: target.slice(end).split(/[\\/]+/u).filter(Boolean) };
}

async function readExactly(handle, buffer, start, length, position) {
  let offset = 0;
  while (offset < length) {
    const part = await handle.read(buffer, start + offset, length - offset, position + offset);
    if (!part.bytesRead) throw invalid();
    offset += part.bytesRead;
  }
}

function stamp(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

async function readHeader(handle, info) {
  const size = Buffer.alloc(8);
  await readExactly(handle, size, 0, size.length, 0);
  const headerSize = size.readUInt32LE(4);
  if (size.readUInt32LE(0) !== 4 || headerSize < 8 || BigInt(headerSize + 8) > info.size) throw invalid();
  if (headerSize > headerLimit) throw issue('LIMIT', 'ASAR header exceeds 16 MiB.');
  const header = Buffer.alloc(headerSize);
  await readExactly(handle, header, 0, header.length, 8);
  const jsonLength = header.readUInt32LE(4);
  if (header.readUInt32LE(0) !== headerSize - 4 || jsonLength > headerSize - 8) throw invalid();
  let tree;
  try {
    tree = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(8, 8 + jsonLength)));
  } catch {
    throw invalid();
  }
  if (!tree?.files || !Object.hasOwn(tree, 'files') || typeof tree.files !== 'object' || Array.isArray(tree.files)) throw invalid();
  return { tree, dataOffset: headerSize + 8, size: Number(info.size), stamp: stamp(info) };
}

export async function checkAsarHeaderSize(native, archive) {
  const info = await native.stat(archive, { bigint: true });
  if (info.isDirectory()) return null;
  if (!info.isFile()) throw invalid();
  const version = stamp(info);
  const existing = headerCache.get(archive);
  if (existing?.stamp === version) return existing.header;
  const pending = (async () => {
    const handle = await native.open(archive, 'r');
    try {
      const opened = await handle.stat({ bigint: true });
      if (stamp(opened) !== version) throw invalid();
      return await readHeader(handle, opened);
    } finally {
      await handle.close();
    }
  })();
  if (headerCache.size >= 2) headerCache.delete(headerCache.keys().next().value);
  headerCache.set(archive, { stamp: version, header: pending });
  try {
    return await pending;
  } catch (error) {
    if (headerCache.get(archive)?.header === pending) headerCache.delete(archive);
    throw error;
  }
}

function lookup(tree, names) {
  let entry = tree;
  for (const name of names) {
    if (!entry.files || !Object.hasOwn(entry.files, name)) throw issue('ENOENT', 'ASAR entry was not found.');
    entry = entry.files[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
    if (Object.hasOwn(entry, 'link')) throw issue('EACCES', 'ASAR symbolic links must resolve to a regular entry.');
  }
  return entry;
}

async function openUnpacked(native, archive, names, authorize, invocation) {
  const unpacked = `${archive}.unpacked`;
  const expected = path.join(unpacked, ...names);
  const canonical = await authorize(expected, invocation);
  const relative = path.relative(unpacked, canonical);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw issue('EACCES', 'Unpacked ASAR entry resolves outside its companion directory.');
  }
  const info = await native.stat(canonical);
  if (!info.isFile()) throw issue('EACCES', 'Unpacked ASAR entry must resolve to a regular file.');
  const handle = await native.open(canonical, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw issue('EACCES', 'Unpacked ASAR entry changed while opening.');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function openAsarEntry(native, target, expectedSize, authorize, invocation) {
  const parts = splitAsar(target);
  if (!parts?.entry.length) return null;
  const { archive, entry: names } = parts;
  const header = await checkAsarHeaderSize(native, archive);
  if (!header) return null;
  const entry = lookup(header.tree, names);
  if (entry.size !== expectedSize || !Number.isSafeInteger(entry.size) || entry.size < 0) throw invalid();
  if (entry.unpacked === true) return openUnpacked(native, archive, names, authorize, invocation);
  if (typeof entry.offset !== 'string' || !/^\d+$/u.test(entry.offset)) throw invalid();
  const offset = header.dataOffset + Number(entry.offset);
  if (!Number.isSafeInteger(offset + entry.size) || offset + entry.size > header.size) throw invalid();
  const integrity = entry.integrity;
  if (integrity !== undefined && (integrity?.algorithm !== 'SHA256'
      || !Number.isInteger(integrity.blockSize) || integrity.blockSize < chunkBytes || integrity.blockSize > blockLimit
      || !Array.isArray(integrity.blocks) || integrity.blocks.length !== Math.max(1, Math.ceil(entry.size / integrity.blockSize)))) {
    throw invalid();
  }

  const handle = await native.open(archive, 'r');
  try {
    if (stamp(await handle.stat({ bigint: true })) !== header.stamp) throw invalid();
  } catch (error) {
    await handle.close();
    throw error;
  }
  let lastVerified = -1;
  let buffer;
  async function verify(block) {
    if (block === lastVerified) return;
    const expected = integrity.blocks[block];
    if (typeof expected !== 'string' || !/^[a-f\d]{64}$/iu.test(expected)) throw invalid();
    buffer ??= Buffer.alloc(chunkBytes);
    const hash = createHash('sha256');
    const start = block * integrity.blockSize;
    const end = Math.min(start + integrity.blockSize, entry.size);
    for (let position = start; position < end; position += buffer.length) {
      invocation?.signal?.throwIfAborted();
      const length = Math.min(buffer.length, end - position);
      await readExactly(handle, buffer, 0, length, offset + position);
      hash.update(buffer.subarray(0, length));
    }
    if (hash.digest('hex') !== expected.toLowerCase()) throw issue('ASAR_INTEGRITY', 'ASAR entry block failed SHA-256 verification.');
    lastVerified = block;
  }

  return {
    async read(target, start, length, position) {
      const bytesRead = Math.max(0, Math.min(length, entry.size - position));
      if (bytesRead && integrity) {
        const first = Math.floor(position / integrity.blockSize);
        const last = Math.floor((position + bytesRead - 1) / integrity.blockSize);
        for (let block = first; block <= last; block++) await verify(block);
      }
      if (bytesRead) await readExactly(handle, target, start, bytesRead, offset + position);
      return { bytesRead };
    },
    async close() { await handle.close(); },
  };
}
