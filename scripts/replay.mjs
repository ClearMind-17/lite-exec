import fs from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, matchesGlob, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectCorpus, pathKey, targets } from './replay-corpus.mjs'

const WINDOW_BYTES = 64 * 1024
const MISSING = new Set(['ENOENT', 'ENOTDIR'])
const electron = Boolean(process.versions.electron && !process.noAsar)
const nativeFs = electron ? createRequire(import.meta.url)('original-fs') : fs
const statuses = [
  'passed', 'originalMissing', 'environmentUnavailable', 'changedPath',
  'targetUnverified', 'unsupportedArguments', 'resultUnverified', 'pluginFailed',
]

async function probe(path, backend = fs) {
  try {
    const info = await backend.promises.stat(path)
    return { status: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
  } catch (error) {
    return { status: MISSING.has(error.code) ? 'missing' : 'unavailable' }
  }
}

async function readBytes(path, position, size, backend = fs) {
  const fd = await backend.promises.open(path, 'r')
  try {
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await fd.read(buffer, offset, size - offset, position + offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset)
  } finally {
    await fd.close()
  }
}

// The official read uses 1-based UTF-8 line offsets. Lite read takes byte windows.
async function lineWindow(path, startLine, limitLines, backend) {
  if (startLine === 1 && limitLines === undefined) return { offsetBytes: 0, limitBytes: WINDOW_BYTES }
  let line = 1
  let bytePosition = 0
  let offsetBytes = startLine === 1 ? 0 : undefined
  for await (const chunk of backend.createReadStream(path, { highWaterMark: WINDOW_BYTES })) {
    let index = -1
    while ((index = chunk.indexOf(10, index + 1)) >= 0) {
      line++
      const next = bytePosition + index + 1
      if (line === startLine) offsetBytes = next
      if (offsetBytes !== undefined && (line === startLine + limitLines || next - offsetBytes >= WINDOW_BYTES)) {
        return { offsetBytes, limitBytes: Math.min(WINDOW_BYTES, next - offsetBytes) }
      }
    }
    bytePosition += chunk.length
    if (offsetBytes !== undefined && bytePosition - offsetBytes >= WINDOW_BYTES) {
      return { offsetBytes, limitBytes: WINDOW_BYTES }
    }
  }
  if (offsetBytes === undefined) return { offsetBytes: bytePosition, limitBytes: 1, beyondEof: true }
  return { offsetBytes, limitBytes: Math.max(1, bytePosition - offsetBytes) }
}

function expectedEncoding(bytes, atEnd) {
  const [first, second, third] = bytes
  const candidates = []
  if (first === 255 && second === 254) candidates.push('utf-16le')
  else if (first === 254 && second === 255) candidates.push('utf-16be')
  else if (first === 239 && second === 187 && third === 191) candidates.push('utf-8')
  else {
    const zeros = [0, 0]
    for (let index = 0; index < bytes.length; index++) {
      if (!bytes[index]) zeros[index % 2]++
    }
    if (zeros[0] >= 8 && zeros[1] === 0) candidates.push('utf-16be')
    if (zeros[1] >= 8 && zeros[0] === 0) candidates.push('utf-16le')
    if (!zeros[0] && !zeros[1]) candidates.push('utf-8', 'gbk')
  }
  for (const encoding of candidates) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: !atEnd })
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) return encoding
    } catch {
      // Try the next plausible encoding.
    }
  }
  return 'binary'
}

function correctEncoding(result, bytes, info) {
  const encoding = expectedEncoding(bytes, bytes.length === info.size)
  if (encoding === 'binary') return exactBinary(result, bytes)
  const actual = typeof result?.encoding === 'string' ? result.encoding.toLowerCase().replace(/_/g, '-') : ''
  if (result?.ok !== true || result.binary === true || typeof result.content !== 'string') return false
  if (actual !== encoding && !(encoding === 'gbk' && actual === 'cp936')) return false
  const expected = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: bytes.length < info.size })
  return result.content === expected || result.content === expected.replace(/^\uFEFF/, '')
}

function exactBinary(result, bytes) {
  const hex = result?.content ?? result?.hex
  return result?.binary === true && typeof hex === 'string' &&
    hex.replace(/\s/g, '').toLowerCase() === bytes.subarray(0, 512).toString('hex')
}

async function replayRead(item, invoke, details) {
  const container = /\.asar$/i.test(item.path)
  const backend = container ? nativeFs : fs
  if (/\.asar[\\/]/i.test(item.path) && !electron) return 'environmentUnavailable'
  const info = await probe(item.path, backend)
  if (info.status === 'missing') return 'originalMissing'
  if (info.status !== 'file') return 'environmentUnavailable'
  if (item.kind === 'encoding') {
    const bytes = await readBytes(item.path, 0, WINDOW_BYTES)
    const result = await invoke('read', { path: item.path })
    return correctEncoding(result, bytes, info) ? 'passed' : 'pluginFailed'
  }
  const { offset = 1, limit } = item.args
  if (!Number.isSafeInteger(offset) || offset < 1 ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) return 'unsupportedArguments'
  const { beyondEof, ...window } = await lineWindow(item.path, offset, limit, backend)
  const result = await invoke('read', { path: item.path, ...window })
  if (result?.ok !== true || typeof result.content !== 'string') return 'pluginFailed'
  const bytes = await readBytes(item.path, window.offsetBytes, window.limitBytes, backend)
  if (result.bytes !== bytes.length) return 'pluginFailed'
  if (beyondEof) {
    details.readBeyondEof++
    return bytes.length === 0 && result.content === '' ? 'passed' : 'pluginFailed'
  }
  if (container && result.binary === true) return exactBinary(result, bytes) ? 'passed' : 'pluginFailed'
  if (result.binary === true) return 'pluginFailed'
  const expected = new TextDecoder(container ? result.encoding : 'utf-8', { fatal: true })
    .decode(bytes, { stream: window.offsetBytes + bytes.length < info.size })
  return result.content === expected ? 'passed' : 'pluginFailed'
}

async function replayMissing(item, invoke, details) {
  const before = await probe(item.path)
  if (!['file', 'missing'].includes(before.status)) return 'environmentUnavailable'
  const result = await invoke('read', { path: item.path })
  if (before.status === 'file') {
    if (result?.ok || result?.binary) return 'changedPath'
    return 'pluginFailed'
  }
  const candidates = result?.candidates
  if (result?.ok !== false || result.code !== 'ENOENT' || !Array.isArray(candidates) || candidates.length > 3) {
    return 'pluginFailed'
  }
  details.structuredMissing++
  const parent = dirname(item.path)
  const parentInfo = await probe(parent)
  if (parentInfo.status === 'missing') return 'originalMissing'
  if (parentInfo.status !== 'directory') return 'environmentUnavailable'
  let confirmed = false
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') return 'pluginFailed'
    const path = isAbsolute(candidate) ? candidate : join(parent, candidate)
    if (pathKey(dirname(path)) !== pathKey(parent) || (await probe(path)).status !== 'file') return 'pluginFailed'
    if (item.confirmedTarget && pathKey(path) === pathKey(item.confirmedTarget)) confirmed = true
  }
  if (candidates.length) details.withExistingSuggestions++
  if (confirmed) return 'passed'
  if (item.confirmedTarget && (await probe(item.confirmedTarget)).status === 'file') return 'pluginFailed'
  return 'targetUnverified'
}

function matchesInclude(file, root, pattern) {
  if (!pattern) return true
  const input = pattern.includes('/') ? relative(root, file).replace(/\\/g, '/') : basename(file)
  return matchesGlob(input, pattern)
}

// Support the archived regex forms that have a required literal in every branch.
// Lite grep keeps its literal API. Recheck matches against the original expression.
function grepPlan(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 2048) return undefined
  const branches = pattern.split('|')
  const literals = []
  for (const branch of branches) {
    if (!/^(?:[\p{L}\p{N}_/ :@-]|\\\.|\.\*)+$/u.test(branch)) return undefined
    const [literal] = branch.split('.*').sort((a, b) => b.length - a.length)
    if (!literal) return undefined
    literals.push(literal.replace(/\\\./g, '.'))
  }
  return { regex: new RegExp(pattern, 'u'), literals: [...new Set(literals)] }
}

async function replayGlob(item, invoke) {
  const pattern = item.args.pattern
  if (typeof pattern !== 'string' || !pattern || pattern.length > 2048) return 'unsupportedArguments'
  const directories = [item.path]
  while (directories.length) {
    const directory = directories.pop()
    const entries = await fs.promises.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(path)
      if (!entry.isFile() || !matchesInclude(path, item.path, pattern)) continue
      const result = await invoke('read', { path, limitBytes: 512 })
      const bytes = await readBytes(path, 0, 512)
      return result?.ok === true && result.bytes === bytes.length && typeof result.content === 'string'
        ? 'passed' : 'pluginFailed'
    }
  }
  return 'resultUnverified'
}

async function replayAsar(item, invoke, details) {
  const container = item.path.match(/^(.+?\.asar)(?=[\\/]|$)/i)?.[1]
  if (!container) return 'unsupportedArguments'
  const outer = await probe(container, nativeFs)
  if (outer.status === 'missing') return 'originalMissing'
  if (outer.status !== 'file' && outer.status !== 'directory') return 'environmentUnavailable'
  if (!electron) return 'environmentUnavailable'
  const inner = await probe(item.path)
  if (inner.status === 'missing') return 'originalMissing'
  if (!['file', 'directory'].includes(inner.status)) return 'environmentUnavailable'
  if (item.kind === 'asarGlob') {
    if (inner.status !== 'directory') return 'unsupportedArguments'
    return replayGlob(item, invoke)
  }

  const plan = grepPlan(item.args.pattern)
  if (!plan) return 'unsupportedArguments'
  const include = item.args.include || undefined
  const samePath = (file) => {
    if (typeof file !== 'string' || !isAbsolute(file)) return false
    const suffix = relative(item.path, file)
    return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  }
  let verified = false
  let fullyChecked = true
  for (const literal of plan.literals) {
    let inspectedSpill = false
    const inspectMatch = (match) => {
      if (samePath(match?.path) && typeof match.text === 'string' &&
          matchesInclude(match.path, item.path, include) && plan.regex.test(match.text)) verified = true
    }
    const result = await invoke('grep', { path: item.path, pattern: literal, include, maxMatches: 64 }, {
      inspectSpill(match) {
        inspectedSpill = true
        inspectMatch(match)
      },
    })
    if (result?.ok !== true || !Array.isArray(result.matches)) {
      const code = ['BINARY', 'EACCES', 'ENOENT', 'LIMIT', 'SPILL', 'TIMEOUT'].includes(result?.code)
        ? result.code : 'OTHER'
      details.grepFailures[code] = (details.grepFailures[code] ?? 0) + 1
      return 'pluginFailed'
    }
    for (const match of result.matches) inspectMatch(match)
    if (result.complete !== true || (result.truncated && !inspectedSpill)) fullyChecked = false
    if (result.truncated) details.truncatedSearches++
    details.binaryFilesSkipped += result.skipped?.binaryFiles ?? 0
    details.undecodableLinesSkipped += result.skipped?.undecodableLines ?? 0
  }
  if (verified) return 'passed'
  if (fullyChecked) {
    details.zeroMatchSearches++
    return 'passed'
  }
  return 'resultUnverified'
}

function groupCounts(cases) {
  return Object.fromEntries(Object.entries(targets).map(([kind, target]) => [
    kind, { target, historical: cases.filter((item) => item.kind === kind).length },
  ]))
}

async function defaultInvocation() {
  const { createFileTools } = await import('../lib/files.js')
  // The replay verifies file tools without persisting captured paths or file contents.
  const spill = { async open(invocation) {
    return {
      path: 'replay-discarded-output',
      async write(chunk) {
        if (invocation?.inspectSpill) {
          for (const line of chunk.toString().split('\n')) {
            if (line) invocation.inspectSpill(JSON.parse(line))
          }
        }
      },
      async commit() { return 'replay-discarded-output' },
      async discard() {},
    }
  } }
  const tools = createFileTools({ fs, originalFs: nativeFs, authorize: async (path) => path, spill })
  return (name, args, invocation) => tools[name](args, invocation)
}

export async function replayHistory({
  sessions = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions'),
  inventory = false,
  invoke,
} = {}) {
  const { cases, counters } = await collectCorpus(sessions)
  const groups = groupCounts(cases)
  if (inventory) return { archives: counters, groups }
  invoke ??= await defaultInvocation()
  const details = {
    structuredMissing: 0, withExistingSuggestions: 0, truncatedSearches: 0,
    zeroMatchSearches: 0, readBeyondEof: 0, binaryFilesSkipped: 0, undecodableLinesSkipped: 0,
    grepFailures: {},
  }
  for (const group of Object.values(groups)) {
    for (const status of statuses) group[status] = 0
  }
  for (const item of cases) {
    let status
    if (!item.path) status = 'environmentUnavailable'
    else {
      try {
        if (item.kind === 'missing') status = await replayMissing(item, invoke, details)
        else if (item.kind.startsWith('asar')) status = await replayAsar(item, invoke, details)
        else status = await replayRead(item, invoke, details)
      } catch (error) {
        status = MISSING.has(error?.code) ? 'originalMissing' :
          ['EACCES', 'EPERM', 'EBUSY'].includes(error?.code) ? 'environmentUnavailable' : 'pluginFailed'
      }
    }
    groups[item.kind][status]++
  }
  const corpusValid = counters.archivesWithErrors === 0 && counters.invalidJson === 0
  const replayPassed = Object.entries(groups).every(([kind, group]) =>
    group.historical >= group.target && group.passed >= (kind === 'missing' ? 12 : group.target))
  return { archives: counters, groups, details, electron,
    passed: corpusValid && replayPassed }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.includes('--help')) {
      console.log('Usage: replay.mjs [--inventory] [--sessions PATH]')
    } else {
      const inventory = args.includes('--inventory')
      const option = args.indexOf('--sessions')
      const sessions = option === -1 ? undefined : args[option + 1]
      if (option !== -1 && (!sessions || sessions.startsWith('--'))) throw new Error('arguments')
      if (args.some((arg, index) => arg !== '--inventory' && arg !== '--sessions' &&
          !(option >= 0 && index === option + 1))) throw new Error('arguments')
      const report = await replayHistory({ sessions, inventory })
      console.log(JSON.stringify(report, null, 2))
      if (!inventory && !report.passed) process.exitCode = 1
    }
  } catch {
    console.error('Replay could not start. Check the arguments, archive directory, and plugin files.')
    process.exitCode = 2
  }
}
