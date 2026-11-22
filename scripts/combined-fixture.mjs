import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const graphTag = 'type:dead-end'
const missingTag = 'topic:combined-fixture-absent'
const missingId = 'mem_00000000000000000000000000000000'
const calendarTitle = '组合回归日历事项'

export async function prepareCombinedProfile(memoPackage, { home, modules, workspace }) {
  const source = path.resolve(memoPackage)
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-memo-personal')
  await cp(source, path.join(modules, manifest.name), { recursive: true })

  const memory = path.join(home, 'memory')
  const memoryRoot = path.join(memory, 'workspaces')
  const workspaceKey = '--' + workspace.replace(/[\\/:*?"<>|]/g, '-') + '--'
  const handoff = path.join(memoryRoot, workspaceKey, 'handoff')
  await mkdir(handoff, { recursive: true })
  await writeFile(path.join(handoff, 'PLAN.md'), [
    '# 组合回归白板', '', '## 已试方案',
    '<!-- memory:mem_0123456789abcdef0123456789abcdef -->',
    graphTag, '测试灯塔的旧灯罩出现裂纹。', '', '## 后续', graphTag, '检查备用灯罩。', '',
  ].join('\n'))
  await writeFile(path.join(home, 'dsh-auto-memory.json'), JSON.stringify({
    userMemoryDir: memory, memoryRoot, boardMode: 'graph',
    semanticEngineMode: 'off', pythonBackendEnabled: false, associativeMemoryEnabled: false,
    teamEnabled: false, autoConsolidate: false, autoArchiveEnabled: false,
    autoDeleteEnabled: false, autoContinueEnabled: false, welcomeTourEnabled: false,
  }))
  return manifest.name
}

const calls = [
  ['lite_stat', { path: 'fixture.txt' }],
  ['memory_expand', { tag: graphTag, limit: 1 }],
  ['memory_trace', { id: missingId }],
  ['memory_expand', { tag: missingTag }],
  ['memory_trace', { id: missingId }],
  ['calendar_add', { title: calendarTitle }],
  ['calendar_list', {}],
  ['lite_exec', { shell: 'powershell', command: "Write-Output ('combined-lite-' + ('x' * 128))", maxOutputBytes: 64 }],
]

export const combinedCallCount = calls.length

function parse(text) {
  try { return JSON.parse(text) } catch { return undefined }
}

export function combinedCall(step, events) {
  const [name, fixedArguments] = calls[step]
  if (step !== 2) return { name, arguments: fixedArguments }
  const expansion = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'lite-check-1')
  const id = parse(expansion?.data.message.content?.[0]?.text)?.entries?.[0]?.id
  return { name, arguments: { id: id ?? missingId } }
}

export function summarizeCombinedCalls(results) {
  const values = calls.map((_, index) => results.get(`lite-check-${index}`))
  const resultText = values.map(value => value?.content?.[0]?.text)
  const [stat, expansion, trace, emptyExpansion, emptyTrace] = resultText.map(parse)
  const exec = parse(resultText[7])
  const receipt = /^已加入日历:\s+(\d{4}-\d{2}-\d{2})\s+--:--\s+组合回归日历事项\s+\(未分类\)$/u.exec(resultText[5] ?? '')
  const checks = [
    stat?.ok === true && stat.exists === true && stat.isDir === false,
    expansion?.mode === 'graph' && expansion.tag === graphTag && expansion.total === 2
      && expansion.truncated === true && expansion.entries?.length === 1,
    trace?.found === true && trace.entry?.id === expansion?.entries?.[0]?.id
      && ['cues', 'tags', 'neighbors', 'versions'].every(field => Array.isArray(trace[field]))
      && trace.tags.includes(graphTag) && trace.neighbors.length > 0,
    emptyExpansion?.mode === 'graph' && emptyExpansion.total === 0 && emptyExpansion.entries?.length === 0,
    emptyTrace?.found === false && emptyTrace.reason === 'no-entry',
    Boolean(receipt),
    Boolean(receipt && resultText[6]?.includes(`${receipt[1]} --:-- | 未分类 | ${calendarTitle}`)),
    exec?.ok === true && exec.exitCode === 0 && exec.shellUsed === 'powershell' && exec.shellFallback === false
      && exec.truncated === true && exec.stdout.startsWith('combined-lite-'),
  ]
  return calls.map(([name], index) => ({
    name, isError: values[index]?.isError ?? null, text: typeof resultText[index] === 'string',
    passed: values[index]?.isError === false && checks[index] === true,
  }))
}
