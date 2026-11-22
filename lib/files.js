import path from 'node:path';
import { openAsarEntry, splitAsar } from './asar.js';
import { decodeText, decodeWindow, detectUtf16, getBom, getEncoding } from './encoding.js';
import { failure, issue } from './errors.js';
import { spillIssue, spillStatus } from './spill.js';

const kib = 1024;
const mib = kib * kib;
const chunkBytes = 64 * kib;
const scanBytesLimit = 1024 * mib;
const scanEntriesLimit = 100_000;
const scanTimeoutMs = 30_000;
const depthLimit = 128;
const fileBytesLimit = 256 * mib;
const lineBytesLimit = 32 * mib;
const spillBytesLimit = 16 * mib;

function filePath(value) {
  if (typeof value === 'string' && value.length && !value.includes('\0')) return value;
  throw issue('EINVAL', 'Expected a nonempty file path.');
}

function integer(value, name, min, max) {
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  throw issue('EINVAL', `${name} must be an integer between ${min} and ${max}.`);
}

function isAsar(value) {
  return Boolean(typeof value === 'string' && splitAsar(value));
}

function isAsarContainer(value) {
  return splitAsar(value)?.entry.length === 0;
}

function missing(error) {
  return ['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND'].includes(error.code);
}

function checkSignal(invocation) {
  if (invocation?.signal?.aborted) throw issue('ABORTED', 'File operation was canceled.');
}

function resultPath(target, args) {
  const value = target ?? args?.path;
  return typeof value === 'string' ? { path: value } : {};
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let bytes = 0;
  while (bytes < length) {
    const result = await handle.read(buffer, bytes, length - bytes, position + bytes);
    if (!result.bytesRead) break;
    bytes += result.bytesRead;
  }
  return buffer.subarray(0, bytes);
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const previous = row[j];
      row[j] = Math.min(previous + 1, row[j - 1] + 1, diagonal + (left[i - 1] !== right[j - 1]));
      diagonal = previous;
    }
  }
  return row[right.length];
}

function matchSegment(pattern, value) {
  let i = 0;
  let j = 0;
  let star = -1;
  let retry = 0;
  while (j < value.length) {
    if (pattern[i] === '*') {
      star = i++;
      retry = j;
    } else if (pattern[i] === '?' || pattern[i] === value[j]) {
      i++;
      j++;
    } else if (star !== -1) {
      i = star + 1;
      j = ++retry;
    } else return false;
  }
  while (pattern[i] === '*') i++;
  return i === pattern.length;
}

function matchPath(pattern, parts) {
  let reachable = new Array(parts.length + 1).fill(false);
  reachable[0] = true;
  for (const segment of pattern) {
    const next = new Array(parts.length + 1).fill(false);
    if (segment === '**') {
      next[0] = reachable[0];
      for (let i = 1; i <= parts.length; i++) next[i] = reachable[i] || next[i - 1];
    } else {
      for (let i = 1; i <= parts.length; i++) next[i] = reachable[i - 1] && matchSegment(segment, parts[i - 1]);
    }
    reachable = next;
  }
  return reachable[parts.length];
}

function includeFilter(include) {
  if (include === undefined) return () => true;
  const globs = Array.isArray(include) ? include : [include];
  if (!globs.length || globs.length > 32 || globs.some(glob => typeof glob !== 'string' || !glob.length || glob.length > 256)) {
    throw issue('EINVAL', 'include must be a glob or up to 32 globs of at most 256 characters each.');
  }
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const patterns = globs.map(glob => normalize(glob).replaceAll('\\', '/').replace(/^\.\//u, '').split('/'));
  return (relative, name) => patterns.some(pattern => pattern.length === 1
    ? matchSegment(pattern[0], normalize(name))
    : matchPath(pattern, normalize(relative).split('/')));
}

const foldCase = text => text.toLowerCase().toUpperCase();

function literalPosition(text, needle, ignoreCase) {
  if (!ignoreCase) return text.indexOf(needle);
  const folded = foldCase(text);
  const index = folded.indexOf(needle);
  if (index <= 0 || folded.length === text.length) return index;
  // A case mapping such as ß → SS can shift the original UTF-16 column.
  let offset = 0;
  let foldedOffset = 0;
  for (const character of text) {
    foldedOffset += foldCase(character).length;
    if (foldedOffset > index) break;
    offset += character.length;
  }
  return offset;
}

async function* directoryEntries(fs, directory) {
  // Older Electron versions support readdir in ASAR directories, but not opendir.
  if (isAsar(directory)) {
    yield* await fs.readdir(directory, { withFileTypes: true });
    return;
  }
  yield* await fs.opendir(directory);
}

function scanEncoding(buffer, more) {
  const bom = getBom(buffer);
  const encoding = bom.encoding ?? detectUtf16(buffer, 0);
  const body = buffer.subarray(bom.length);
  const valid = encoding
    ? decodeText(body, encoding, { more }) !== null
    : decodeText(body, 'utf-8', { more }) !== null || decodeText(body, 'gbk', { more }) !== null;
  return { encoding, bomBytes: bom.length, valid };
}

async function* fileLines(handle, scan, skipped) {
  const first = await readAt(handle, 0, chunkBytes);
  scan(first.length);
  if (!first.length) return;
  const { encoding, bomBytes, valid } = scanEncoding(first, first.length === chunkBytes);
  if (!valid) {
    skipped.binaryFiles++;
    return;
  }

  const wide = encoding === 'utf-16le' || encoding === 'utf-16be';
  const newline = wide ? Buffer.from(encoding === 'utf-16le' ? [10, 0] : [0, 10]) : 10;
  let pieces = [];
  let pending = 0;
  let line = 0;
  let position = first.length;
  let buffer = first.subarray(bomBytes);
  while (buffer.length) {
    let offset = 0;
    while (offset < buffer.length) {
      let end = buffer.indexOf(newline, offset);
      while (wide && end !== -1 && end % 2) end = buffer.indexOf(newline, end + 1);
      const part = buffer.subarray(offset, end === -1 ? buffer.length : end);
      pending += part.length;
      if (pending > lineBytesLimit) throw issue('LIMIT', 'A line exceeds the 32 MiB scan limit.');
      if (end === -1) {
        pieces.push(part);
        break;
      }
      const bytes = pieces.length ? Buffer.concat([...pieces, part], pending) : part;
      const text = decodeLine(bytes, encoding);
      line++;
      if (text === null) skipped.undecodableLines++;
      else yield { line, text };
      pieces = [];
      pending = 0;
      offset = end + (wide ? 2 : 1);
      scan(0);
    }
    if (position % chunkBytes) break;
    buffer = await readAt(handle, position, chunkBytes);
    scan(buffer.length);
    position += buffer.length;
    if (position > fileBytesLimit) throw issue('LIMIT', 'A file exceeds the 256 MiB scan limit.');
  }
  if (pending) {
    const text = decodeLine(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, pending), encoding);
    if (text === null) skipped.undecodableLines++;
    else yield { line: line + 1, text };
  }
}

function decodeLine(buffer, encoding) {
  const text = encoding
    ? decodeText(buffer, encoding)
    : decodeText(buffer, 'utf-8') ?? decodeText(buffer, 'gbk');
  return text?.endsWith('\r') ? text.slice(0, -1) : text;
}

export function createFileTools({ fs, originalFs, authorize, spill, workspaceSpillDirectory }) {
  const host = fs.promises;
  const native = originalFs?.promises;

  async function openText(target, info, invocation) {
    const archive = splitAsar(target);
    if (archive?.entry.length) {
      if (!native && process.versions.electron) throw issue('ENOTSUP', 'Bounded ASAR access requires Electron original-fs.');
      if (native) {
        const handle = await openAsarEntry(native, target, Number(info.size), authorize, invocation);
        if (handle) return handle;
      }
    }
    return host.open(target, 'r');
  }

  async function candidates(value, invocation) {
    const name = path.basename(value).toLowerCase();
    const maxDistance = Math.max(2, Math.ceil(name.length / 3));
    const best = [];
    let directory;
    let seen = 0;
    try {
      directory = await authorize(path.dirname(value), invocation);
      for await (const entry of directoryEntries(host, directory)) {
        checkSignal(invocation);
        if (++seen > 10_000) break;
        if (!entry.isFile() || Math.abs(entry.name.length - name.length) > maxDistance) continue;
        const distance = editDistance(name, entry.name.toLowerCase());
        if (distance > maxDistance) continue;
        best.push({ name: entry.name, distance });
        best.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
        if (best.length > 12) best.pop();
      }
    } catch (error) {
      if (missing(error) || error.code === 'EACCES' || error.code === 'EPERM') return [];
      throw error;
    }
    const result = [];
    for (const entry of best) {
      checkSignal(invocation);
      try {
        result.push(await authorize(path.join(directory, entry.name), invocation));
        if (result.length === 3) break;
      } catch (error) {
        if (!missing(error) && error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
      }
    }
    return result;
  }

  async function read(args, invocation) {
    let target;
    try {
      const { path: value, offsetBytes = 0, limitBytes = chunkBytes, encoding } = args ?? {};
      filePath(value);
      const explicit = getEncoding(encoding);
      integer(limitBytes, 'limitBytes', 1, mib);
      integer(offsetBytes, 'offsetBytes', 0, Number.MAX_SAFE_INTEGER - limitBytes);
      checkSignal(invocation);
      target = await authorize(value, invocation);
      let info = await host.stat(target);
      const rawArchive = info.isDirectory() && native && isAsarContainer(target);
      if (rawArchive) info = await native.stat(target);
      if (info.isDirectory()) throw issue('EISDIR', 'Expected a file path.');
      if (!info.isFile()) throw issue('EINVAL', 'Expected a regular file.');
      checkSignal(invocation);
      const handle = rawArchive ? await native.open(target, 'r') : await openText(target, info, invocation);
      try {
        const buffer = await readAt(handle, offsetBytes, limitBytes);
        // The only read outside the requested window is the file header used to recognize a BOM.
        const head = offsetBytes === 0 && buffer.length >= 3 ? buffer : await readAt(handle, 0, 3);
        const truncated = offsetBytes + buffer.length < Number(info.size);
        checkSignal(invocation);
        return {
          ok: true, path: target, bytes: buffer.length, truncated,
          ...decodeWindow(buffer, getBom(head), explicit, offsetBytes, truncated),
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (args?.path && missing(error)) {
        const absent = { path: target ?? args.path, exists: false };
        try {
          return failure(error, { ...absent, candidates: await candidates(absent.path, invocation) });
        } catch (candidateError) {
          return failure(candidateError, { ...absent, candidates: [] });
        }
      }
      return failure(error, resultPath(target, args));
    }
  }

  async function stat(args, invocation) {
    let target;
    try {
      checkSignal(invocation);
      target = await authorize(filePath(args?.path), invocation);
      const info = await (native && isAsarContainer(target) ? native : host).stat(target);
      checkSignal(invocation);
      return {
        ok: true, exists: true, isDir: info.isDirectory(), size: Number(info.size),
        mtime: info.mtime.toISOString(), isAsar: isAsar(target),
      };
    } catch (error) {
      if (missing(error)) {
        return { ok: true, exists: false, isDir: false, size: null, mtime: null, isAsar: false };
      }
      return failure(error, resultPath(target, args));
    }
  }

  async function* files(root, rootInfo, accept, invocation, countEntry, skipped, excluded) {
    if (excluded) {
      const relative = path.relative(excluded, root);
      if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return;
    }
    if (rootInfo.isFile()) {
      const name = path.basename(root);
      if (accept(name, name)) yield root;
      return;
    }
    if (!rootInfo.isDirectory()) throw issue('EINVAL', 'Expected a regular file or directory.');

    const directories = [{ target: root, relative: '', depth: 0 }];
    while (directories.length) {
      const { target, relative, depth } = directories.pop();
      const directory = target === root ? root : await authorize(target, invocation);
      if (excluded && path.relative(excluded, directory) === '') continue;
      for await (const entry of directoryEntries(host, directory)) {
        countEntry();
        if (entry.isSymbolicLink()) continue;
        const child = path.join(directory, entry.name);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (excluded && path.relative(excluded, child) === '') continue;
          if (depth === depthLimit) throw issue('LIMIT', 'Search exceeded the 128-level directory depth limit.');
          directories.push({ target: child, relative: childRelative, depth: depth + 1 });
        }
        else if (entry.isFile() && accept(childRelative, entry.name)) {
          // A native directory listing includes archives as files. An explicitly
          // selected archive is instead traversed as a virtual directory.
          if (native && isAsarContainer(child)) skipped.archives++;
          else yield await authorize(child, invocation);
        }
      }
    }
  }

  async function grep(args, invocation) {
    const matches = [];
    let matchCount = 0;
    let inlineBytes = 2;
    let scannedBytes = 0;
    let scannedEntries = 0;
    const skipped = { archives: 0, binaryFiles: 0, undecodableLines: 0 };
    let spillBytes = 0;
    let sink;
    let spillError;
    let batch = '';
    let batchBytes = 0;
    let target;
    const deadline = performance.now() + scanTimeoutMs;
    const scan = bytes => {
      checkSignal(invocation);
      if (performance.now() >= deadline) throw issue('TIMEOUT', 'Search exceeded 30 seconds.');
      scannedBytes += bytes;
      if (scannedBytes > scanBytesLimit) throw issue('LIMIT', 'Search exceeded the 1 GiB scan limit.');
    };
    const countEntry = () => {
      scan(0);
      if (++scannedEntries > scanEntriesLimit) throw issue('LIMIT', 'Search exceeded the 100,000-entry scan limit.');
    };
    const rejectSpill = async error => {
      spillError = error;
      batch = '';
      batchBytes = 0;
      if (sink) await sink.discard().catch(() => {});
      sink = undefined;
    };
    const writeSpill = async (value, bytes) => {
      spillBytes += bytes;
      if (spillBytes > spillBytesLimit) throw spillIssue('LIMIT', 'Search output exceeded the 16 MiB spill limit.');
      batch += value;
      batchBytes += bytes;
      if (batchBytes < chunkBytes) return;
      await sink.write(batch);
      batch = '';
      batchBytes = 0;
    };
    const finishSpill = async () => {
      try {
        if (batch) await sink.write(batch);
        await sink.commit();
      } catch (error) {
        await rejectSpill(error);
      }
    };
    try {
      const { pattern, include, ignoreCase = false, maxMatches = 100, maxBytes = chunkBytes } = args ?? {};
      if (typeof pattern !== 'string' || pattern.length > chunkBytes) {
        throw issue('EINVAL', 'pattern must be a literal string of at most 65,536 characters.');
      }
      integer(maxMatches, 'maxMatches', 1, 5000);
      integer(maxBytes, 'maxBytes', 1, mib);
      if (typeof ignoreCase !== 'boolean') throw issue('EINVAL', 'ignoreCase must be a boolean.');
      const needle = ignoreCase ? foldCase(pattern) : pattern;
      const accept = includeFilter(include);
      scan(0);
      target = await authorize(filePath(args?.path), invocation);
      const rootInfo = await host.stat(target);
      const excluded = await workspaceSpillDirectory?.(invocation);
      for await (const file of files(target, rootInfo, accept, invocation, countEntry, skipped, excluded)) {
        scan(0);
        const info = file === target ? rootInfo : await host.stat(file);
        if (!info.isFile()) throw issue('EINVAL', 'Expected a regular file.');
        if (Number(info.size) > fileBytesLimit) throw issue('LIMIT', 'A file exceeds the 256 MiB scan limit.');
        const handle = await openText(file, info, invocation);
        try {
          let fileBytes = 0;
          const scanFile = bytes => {
            fileBytes += bytes;
            if (fileBytes > fileBytesLimit) throw issue('LIMIT', 'A file exceeds the 256 MiB scan limit.');
            scan(bytes);
          };
          for await (const record of fileLines(handle, scanFile, skipped)) {
            const position = literalPosition(record.text, needle, ignoreCase);
            if (position < 0) continue;
            matchCount++;
            if (spillError) continue;
            const match = { path: file, ...record, column: position + 1 };
            const serialized = JSON.stringify(match);
            const bytes = Buffer.byteLength(serialized);
            if (!sink && matches.length < maxMatches && inlineBytes + bytes + Number(matches.length > 0) <= maxBytes) {
              inlineBytes += bytes + Number(matches.length > 0);
              matches.push(match);
              continue;
            }
            try {
              if (!sink) {
                sink = await spill.open(invocation);
                for (const earlier of matches) {
                  const entry = `${JSON.stringify(earlier)}\n`;
                  await writeSpill(entry, Buffer.byteLength(entry));
                }
              }
              await writeSpill(`${serialized}\n`, bytes + 1);
            } catch (error) {
              await rejectSpill(error);
            }
          }
        } finally {
          await handle.close();
        }
      }
      scan(0);
      if (sink) await finishSpill();
      return {
        ok: true, matches, matchCount, truncated: matchCount > matches.length,
        fullResultPath: sink?.path ?? null, complete: true, skipped,
        ...spillStatus(spillError),
        ...(matchCount === 0 ? { hint: 'Literal only. Use native grep for regex in regular files.' } : {}),
      };
    } catch (error) {
      if (sink) await sink.discard().catch(() => {});
      return failure(error, {
        ...resultPath(target, args), matches, matchCount, truncated: matchCount > matches.length,
        fullResultPath: null, complete: false, skipped,
        ...spillStatus(spillError),
      });
    }
  }

  return { read, grep, stat };
}
