import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { decodeFrames } from './replay-zstd.mjs'

const TOOLS = new Set(['read', 'grep', 'glob'])
export const targets = { bigint: 6, encoding: 5, asarGrep: 7, asarGlob: 3, missing: 15 }

export const pathKey = (file) => process.platform === 'win32'
  ? normalize(file).toLowerCase()
  : normalize(file)

function targetPath(value, cwd) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return undefined
  if (isAbsolute(value)) return normalize(value)
  if (typeof cwd === 'string' && isAbsolute(cwd)) return resolve(cwd, value)
}

function classify(name, text) {
  if (/replaced the official tool|sessionProjections/i.test(text)) return undefined
  if (name === 'read') {
    if (/Cannot mix BigInt/i.test(text)) return 'bigint'
    if (/binary|non[- ]text|invalid (?:UTF|GBK)|(?:unsupported|invalid) encoding/i.test(text)) {
      return 'encoding'
    }
    if (/\bENOENT\b|not found|does not exist|cannot find|no such file|找不到|不存在/i.test(text)) {
      return 'missing'
    }
  } else if (/\brg:[^\r\n]*\.asar\b[^\r\n]*IO error/i.test(text)) {
    return name === 'grep' ? 'asarGrep' : 'asarGlob'
  }
}

async function* archives(root) {
  const entries = await readdir(root, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* archives(path)
    else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') yield path
  }
}

function oneEdit(left, right) {
  if (left.length > right.length) [left, right] = [right, left]
  if (right.length - left.length > 1) return false
  let index = 0
  while (index < left.length && left[index] === right[index]) index++
  return left.length === right.length
    ? left.slice(index + 1) === right.slice(index + 1)
    : left.slice(index) === right.slice(index + 1)
}

function correction(missing, retry) {
  if (!missing.path || !retry?.path || missing.turn !== retry.turn) return false
  const original = pathKey(missing.path)
  const corrected = pathKey(retry.path)
  return dirname(original) === dirname(corrected) && oneEdit(basename(original), basename(corrected))
}

export async function collectCorpus(root) {
  const cases = []
  const counters = {
    archives: 0, archivesWithErrors: 0, frames: 0, invalidJson: 0,
    matchedCalls: 0, malformedCalls: 0, unmatchedCalls: 0,
  }
  for await (const archive of archives(root)) {
    counters.archives++
    const pending = new Map()
    const archiveCases = []
    const completedReads = []
    let cwd
    try {
      for (const frame of decodeFrames(await readFile(archive))) {
        counters.frames++
        for (const line of frame.toString('utf8').split('\n')) {
          if (!line.trim()) continue
          let event
          try { event = JSON.parse(line) } catch {
            counters.invalidJson++
            continue
          }
          const data = event?.data
          if (event?.type === 'session') cwd = event.cwd
          if (event?.type === 'working-directory/change') cwd = data?.cwd
          if (event?.type === 'tool/call' && TOOLS.has(data?.name) && typeof data.callId === 'string') {
            let args
            try { args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments }
            catch { counters.malformedCalls++; continue }
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              counters.malformedCalls++
              continue
            }
            pending.set(data.callId, {
              name: data.name, args, turn: data.turn, seq: event.seq,
              path: targetPath(data.name === 'read' ? args.file_path : args.path ?? cwd, cwd),
            })
          }
          if (event?.type !== 'tool/result') continue
          const message = data?.message
          const callId = message?.toolCallId
          const call = pending.get(callId)
          if (!call || typeof message.isError !== 'boolean' ||
              (call.turn !== undefined && data.turn !== call.turn)) continue
          pending.delete(callId)
          counters.matchedCalls++
          if (call.name === 'read') completedReads.push({ ...call, success: !message.isError })
          if (!message.isError) continue
          const blocks = Array.isArray(message.content) ? message.content : []
          const text = [...blocks.filter((block) => block?.type === 'text').map((block) => block.text),
            data.error?.name, data.error?.message].join('\n')
          const kind = classify(call.name, text)
          if (kind) archiveCases.push({ ...call, kind })
        }
      }
    } catch {
      counters.archivesWithErrors++
    }
    counters.unmatchedCalls += pending.size
    for (const item of archiveCases) {
      if (item.kind === 'missing') {
        // Only the next successful correction of the same filename or a one-edit typo
        // in the same directory and turn supplies an independent target.
        const retry = completedReads.find((call) => call.turn === item.turn && call.seq > item.seq)
        if (retry?.success && correction(item, retry)) item.confirmedTarget = retry.path
      }
      cases.push(item)
    }
  }
  return { counters, cases }
}
