import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { combinedCall, combinedCallCount, summarizeCombinedCalls } from './combined-fixture.mjs'

const info = { provider: 'lite-fixture', id: 'lite-check', name: 'Isolated fixture' }
const psLiteral = value => `'${value.replaceAll("'", "''")}'`
function permissionCommands(workspace) {
  const literal = filename => psLiteral(path.resolve(workspace, filename))
  return [
    "echo hi",
    `Set-Content -LiteralPath ${literal('boundary-inside.txt')} -Value 'inside-fixture' -ErrorAction Stop`,
    `Set-Content -LiteralPath ${literal('../guard/boundary-outside.txt')} -Value 'outside-fixture' -ErrorAction Stop`,
    "1..500 | ForEach-Object { Write-Output 'boundary-spill-abcdefghijklmnop' }",
    `Set-Content -LiteralPath ${literal('../guard/boundary-nonterminating-outside.txt')} -Value 'outside-fixture'; Write-Output 'continued-after-denial'`,
    'Write-Output (Get-Location).Path',
    `Get-Content -LiteralPath ${literal('fixture.txt')} -ErrorAction Stop`,
    "printf '%s\\n' bash-control-fixture",
  ]
}

const pairedProbeNames = ['cwd', 'read-absolute', 'read-relative', 'write-absolute', 'write-relative', 'write-outside']

function pairedCall(step, workspace) {
  const name = step % 2 === 0 ? 'lite_exec' : 'pwsh'
  const tool = name === 'lite_exec' ? 'lite' : 'native'
  const probe = pairedProbeNames[Math.floor(step / 2)]
  const absolute = filename => psLiteral(path.resolve(workspace, filename))
  const write = (target, value) => `Set-Content -LiteralPath ${target} -Value '${value}' -NoNewline -ErrorAction Stop; Write-Output 'paired-write-complete'`
  const commands = {
    cwd: 'Write-Output (Get-Location).Path; Write-Output $PSHOME; Write-Output $PSVersionTable.PSVersion.ToString()',
    'read-absolute': `Get-Content -LiteralPath ${absolute('fixture.txt')} -ErrorAction Stop`,
    'read-relative': "Get-Content -LiteralPath './fixture.txt' -ErrorAction Stop",
    'write-absolute': write(absolute(`paired-${tool}-absolute.txt`), 'paired-absolute'),
    'write-relative': `if ((Get-Location).Path -ine ${psLiteral(workspace)}) { throw 'PAIR_CWD_MISMATCH' }; `
      + write(psLiteral(`./paired-${tool}-relative.txt`), 'paired-relative'),
    'write-outside': write(absolute(`../guard/paired-${tool}-outside.txt`), 'paired-outside'),
  }
  const args = { command: commands[probe], timeoutMs: 6_000 }
  return { name, probe, arguments: name === 'lite_exec' ? { ...args, cwd: workspace, maxOutputBytes: 2_048 }
    : { ...args, workdir: workspace, description: 'Check PowerShell with a synthetic fixture' } }
}

const workspaceOutputCommand = "$block = 'x' * (60KB - 2); foreach ($n in 1..256) { Write-Output $block }"
const windowsTimeoutCommand = '$child = Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" '
  + '-ArgumentList "-NoProfile","-Command","Start-Sleep -Seconds 30" -WindowStyle Hidden -PassThru; '
  + 'Write-Output $child.Id; Start-Sleep -Seconds 30'
const benchmarkCommand = "printf '%s\\n' lite-benchmark"
const asarManifest = path.join(process.argv[2], 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
const fileChecks = [
  { name: 'lite_stat', arguments: { path: 'fixture.txt' }, check: value => value.exists === true && value.isDir === false },
  { name: 'lite_read', arguments: { path: 'fixture.txt' }, check: value => value.content?.includes('lightweight fixture') },
  { name: 'lite_grep', arguments: { path: 'fixture.txt', pattern: 'lightweight fixture' }, check: value => value.matchCount === 1 && value.matches[0]?.text === 'lightweight fixture' },
  { name: 'lite_read', arguments: { path: asarManifest, limitBytes: 1024 }, check: value => value.content?.includes('@deepseek-ai/dsh-tools') },
  { name: 'lite_grep', arguments: { path: asarManifest, pattern: '@deepseek-ai/dsh-tools' }, check: value => value.matchCount >= 1 && value.matches[0]?.text.includes('@deepseek-ai/dsh-tools') },
]

function execArguments(index) {
  const commands = [
    'git -c safe.directory="$(pwd -W)" status --short',
    'git -c safe.directory="$(pwd -W)" log -1 --oneline',
    `printf '%s\\n' lite-check-${index}`,
    `for n in {1..2400}; do printf '%s\\n' lite-log-${index}-abcdefghijklmnop; done`,
  ]
  return { command: commands[index % commands.length], timeoutMs: 8_000, maxOutputBytes: 2_048 }
}

function serialArguments(index, workspace, scenario) {
  const explicit = scenario === 'exec-powershell' || scenario === 'ptc-powershell'
  const commands = [
    `Write-Output 'lite-serial-${index}'`,
    scenario === 'serial-stdout' ? `@('lite', 'serial', ${index}) -join '-'`
      : `Get-Content -LiteralPath ${psLiteral(path.join(workspace, 'fixture.txt'))} -ErrorAction Stop`,
    `1..${explicit ? 400 : 16} | ForEach-Object { Write-Output "lite-row-${index}-$_" }`,
  ]
  return { command: commands[index % commands.length], timeoutMs: 8_000, maxOutputBytes: 2_048,
    ...(explicit ? { shell: 'powershell' } : {}) }
}

function matchesSerialOutput(index, stdout, scenario) {
  const expected = [
    `lite-serial-${index}`,
    scenario === 'serial-stdout' ? `lite-serial-${index}` : 'lightweight fixture',
    Array.from({ length: 16 }, (_, row) => `lite-row-${index}-${row + 1}`).join('\n'),
  ]
  return stdout?.replaceAll('\r\n', '\n') === expected[index % expected.length]
}

export const name = 'lite-fixture'
export const inject = ['llm', 'tools', 'agents', 'tokenMeter', 'sessionController', 'sessionProjections', 'sessions']

export function apply(ctx) {
  const steps = new Map()
  const measurements = new Map()
  const outcomes = new Map()
  const benchmarks = new Map()
  const workspaces = new Map()
  const pairedResults = new Map()
  ctx.llm.registerAdapter([info.provider], {
    providerInfo: id => ({ id, name: id }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [info],
    resolveModel: async () => info,
    prepareCall: async () => ({ model: info, stream: async function* (request) {
      const { sessionId, messages, signal } = request
      signal?.throwIfAborted()
      const step = steps.get(sessionId) ?? 0
      steps.set(sessionId, step + 1)
      const user = messages.find(message => message.role === 'user' && (!message.source || message.source.kind === 'user'))
      const scenario = user?.content.find(block => block.type === 'text')?.text
      const workspace = workspaces.get(sessionId)
      const probes = scenario === 'permission' ? permissionCommands(workspace) : undefined
      const count = scenario === 'combined' ? combinedCallCount : ['exec', 'exec-powershell', 'serial', 'serial-stdout'].includes(scenario) ? 20
        : ['ptc', 'ptc-powershell', 'timeout', 'timeout-cleanup', 'timeout-powershell', 'workspace-output', 'workspace-grep'].includes(scenario) ? 1
        : scenario === 'paired-powershell' ? pairedProbeNames.length * 2
        : scenario === 'permission' ? probes.length : scenario === 'benchmark' ? 21 : scenario === 'files' ? fileChecks.length : 0
      if (step === 0) {
        const agent = ctx.agents.get(sessionId)
        const injected = messages.filter(message => message.role === 'developer' || (message.role === 'user'
          && message.source && ((message.source.kind && message.source.kind !== 'user') || message.source.form)
          && !['skill-invocation', 'skill-catalog'].includes(message.source.kind)))
        measurements.set(sessionId, {
          declaredTools: (request.tools ?? []).map(tool => tool.name).sort(),
          registeredTools: ctx.tools.definitions(agent).map(tool => tool.name).sort(),
          injectTokens: injected.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0),
          injectMessages: injected.length,
          expectedCalls: count,
          firstRequestContextBreakdown: ctx.sessionProjections.snapshot(agent.session, ['contextBreakdown']).values.contextBreakdown,
        })
      }
      if (step < count) {
        let args = execArguments(step)
        if (scenario === 'timeout') args = { command: 'sleep 30 & echo $!; wait', timeoutMs: 1_000, maxOutputBytes: 2_048 }
        if (scenario === 'permission') args = { command: probes[step], timeoutMs: 8_000, maxOutputBytes: 2_048,
          ...(step === probes.length - 1 ? { shell: 'bash' } : {}) }
        if (['serial', 'serial-stdout', 'exec-powershell', 'ptc-powershell'].includes(scenario)) args = serialArguments(step, workspace, scenario)
        if (scenario === 'workspace-output') args = { command: workspaceOutputCommand, timeoutMs: 15_000, maxOutputBytes: 2_048 }
        if (['timeout-cleanup', 'timeout-powershell'].includes(scenario)) args = { command: windowsTimeoutCommand, timeoutMs: 3_000,
          maxOutputBytes: 2_048, ...(scenario === 'timeout-powershell' ? { shell: 'powershell' } : {}) }
        if (scenario === 'benchmark') args = { command: benchmarkCommand, timeoutMs: 8_000, maxOutputBytes: 2_048 }
        const ptc = scenario === 'ptc' || scenario === 'ptc-powershell'
        const invocation = scenario === 'combined' ? combinedCall(step, ctx.agents.get(sessionId).session.snapshotEvents())
          : scenario === 'paired-powershell' ? pairedCall(step, workspace) : ptc ? {
          name: 'run_code',
          arguments: { code: `console.log(await tools.lite_exec(${JSON.stringify(args)}))`, description: 'Check the local Git worktree' },
        } : scenario === 'files' ? fileChecks[step] : scenario === 'workspace-grep' ? {
          name: 'lite_grep', arguments: { path: 'grep-fixture.txt', pattern: 'needle', maxMatches: 3 },
        } : { name: 'lite_exec', arguments: args }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: {
          type: 'tool-call', id: `lite-check-${step}`, name: invocation.name,
          arguments: JSON.stringify(invocation.arguments),
        } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = 'lite-check finished'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }),
  })
  ctx.on('tools/execute', async (exec, next) => {
    const benchmark = benchmarks.get(exec.agent?.id)
    const first = benchmark && benchmark.samples.length % 2 === 0
    const direct = first ? await bareBash(exec.agent, benchmark.cwd) : undefined
    const started = performance.now()
    const result = await next()
    const durationMs = Number((performance.now() - started).toFixed(2))
    const paired = pairedResults.get(exec.agent?.id)
    if (paired && ['lite_exec', 'pwsh'].includes(exec.name)) {
      const value = result.value
      const stdout = typeof value?.stdout === 'string' ? value.stdout : value?.stdout?.text
      const stderr = typeof value?.stderr === 'string' ? value.stderr : value?.stderr?.text
      paired.push({ name: exec.name, isError: result.isError, code: value?.code ?? result.error?.info?.code,
        cwd: value?.cwd, exitCode: value?.exitCode, ok: value?.ok, stdout: stdout?.trim(), stderr: stderr?.slice(-2048),
        shellUsed: value?.shellUsed, shellFallback: value?.shellFallback, suspectedSandboxDenial: value?.suspectedSandboxDenial,
        nativeSandbox: value?.sandbox, durationMs })
    }
    if (benchmark) {
      const baseline = direct ?? await bareBash(exec.agent, benchmark.cwd)
      benchmark.samples.push({ ...baseline, liteMs: durationMs, liteOk: result.isError === false && result.value?.ok === true,
        liteCode: result.value?.code ?? result.error?.info?.code, liteExitCode: result.value?.exitCode,
        liteStderrBytes: Buffer.byteLength(result.value?.stderr ?? ''), deltaMs: Number((durationMs - baseline.bareMs).toFixed(2)) })
    }
    if (exec.name === 'lite_exec') {
      const sessionId = exec.agent?.id
      const entries = outcomes.get(sessionId) ?? []
      entries.push({ isError: result.isError, ok: result.value?.ok, code: result.value?.code ?? result.error?.info?.code,
        shell: result.value?.shell, exitCode: result.value?.exitCode, truncated: result.value?.truncated, spill: Boolean(result.value?.spillPath),
        diagnosticCode: result.value?.diagnostic?.code,
        msysStartupDenied: /(?:NtCreateDirectoryObject|0xC0000022)/iu.test(result.value?.stderr ?? ''),
        gitDubiousOwnership: /dubious ownership/iu.test(result.value?.stderr ?? ''),
        windowsSandboxRunnerFailure: /windows-acl-run: /iu.test(result.value?.stderr ?? ''),
        durationMs })
      outcomes.set(sessionId, entries)
    }
    return result
  })

  async function runSession({ workspace, agentPreset, scenario }) {
    const { sessionId } = await ctx.sessionController.create({ cwd: workspace, agentPreset })
    const agent = ctx.agents.get(sessionId)
    const permission = ctx.sessionProjections.snapshot(agent.session, ['permissions']).values.permissions?.currentValue
    workspaces.set(sessionId, workspace)
    if (scenario === 'powershell-control') return { permission, calls: await powershellControl(agent, workspace) }
    if (scenario === 'benchmark') benchmarks.set(sessionId, { cwd: workspace, samples: [] })
    if (scenario === 'paired-powershell') pairedResults.set(sessionId, [])
    const signal = AbortSignal.timeout(35_000)
    const accepted = await ctx.sessionController.prompt({ sessionId, requestId: randomUUID(), mode: 'queue', clientTimeZone: 'UTC', content: [{ type: 'text', text: scenario }] }, signal)
    if (!accepted.accepted) throw new Error('Fixture prompt was not accepted')
    while (!agent.session.snapshotEvents().some(event => event.type === 'turn/end')) await sleep(200, null, { signal })
    await ctx.sessions.flush(agent.session)
    const events = agent.session.snapshotEvents()
    const measurement = measurements.get(sessionId)
    if (!measurement) throw new Error('Fixture adapter did not complete: ' + JSON.stringify(events.at(-1)?.data))
    const outputs = new Map(events.filter(event => event.type === 'tool/result').map(event => [event.data.message.toolCallId, event.data.message]))
    const paired = pairedResults.get(sessionId)?.map((result, index) => {
      const { probe, name: expectedTool, arguments: args } = pairedCall(index, workspace)
      const stored = outputs.get(`lite-check-${index}`)
      return { ...result, probe, expectedTool, requestedCwd: args.cwd ?? args.workdir,
        durableResult: Boolean(stored), durableError: stored?.isError }
    })
    const durableCalls = events.filter(event => event.type === 'tool/call' && event.data.name === 'lite_exec').map(({ data }, index) => {
      const result = outputs.get(data.callId)
      let value
      try { value = JSON.parse(result?.content?.[0]?.text) } catch { /* host error text */ }
      const stdout = value?.stdout?.trim()
      return { isError: result?.isError, ok: value?.ok, code: value?.code, exitCode: value?.exitCode,
        shell: value?.shell, truncated: value?.truncated, spill: Boolean(value?.spillPath),
        shellUsed: value?.shellUsed, shellFallback: value?.shellFallback, diagnosticCode: value?.diagnostic?.code,
        suspectedSandboxDenial: value?.suspectedSandboxDenial,
        childPidEmitted: scenario === 'timeout' && /^\d+$/u.test(stdout ?? ''),
        ...(['timeout-cleanup', 'timeout-powershell'].includes(scenario) ? { childPid: /^\d+$/u.test(stdout ?? '') ? Number(stdout) : null } : {}),
        ...(['serial', 'serial-stdout'].includes(scenario) ? { sawExpectedOutput: matchesSerialOutput(index, stdout, scenario) } : {}),
        ...(['permission', 'workspace-output'].includes(scenario) ? { sawReadableFixture: stdout === 'hi',
          sawBashFixture: stdout === 'bash-control-fixture',
          ...(scenario === 'permission' && index === 5 ? { shellCwd: stdout } : {}),
          sawFixtureFile: stdout === 'lightweight fixture',
          continuedAfterDenial: stdout === 'continued-after-denial',
          stderrBytes: Buffer.byteLength(value?.stderr ?? ''),
          ...(value?.ok !== true || stdout === 'continued-after-denial' && value?.suspectedSandboxDenial !== true
            ? { failureStderr: value?.stderr } : {}),
          spillPath: value?.spillPath, spillReason: value?.spill?.reason, spillMessage: value?.spill?.message,
          sawSpillPreview: Boolean(stdout?.startsWith(scenario === 'workspace-output' ? 'x' : 'boundary-spill-abcdefghijklmnop')),
          previewBytes: Buffer.byteLength(value?.stdout ?? '') + Buffer.byteLength(value?.stderr ?? '') } : {}) }
    })
    const ptcError = events.find(event => event.type === 'tool/result' && event.data.message.isError)?.data.error?.code
    const files = scenario === 'files' ? fileChecks.map(({ name, check }, index) => {
      const result = outputs.get(`lite-check-${index}`)
      let value
      try { value = JSON.parse(result?.content?.[0]?.text) } catch { /* host error text */ }
      return { name, ok: result?.isError === false && value?.ok === true && Boolean(check(value)), code: value?.code }
    }) : undefined
    let grep
    if (scenario === 'workspace-grep') {
      const result = outputs.get('lite-check-0')
      let value
      try { value = JSON.parse(result?.content?.[0]?.text) } catch { /* host error text */ }
      grep = { isError: result?.isError, ok: value?.ok, code: value?.code, matchCount: value?.matchCount, complete: value?.complete,
        truncated: value?.truncated, matches: value?.matches, spillPath: value?.fullResultPath,
        spillReason: value?.spill?.reason, spillMessage: value?.spill?.message }
    }
    const spillResult = scenario === 'workspace-grep' ? grep : scenario === 'workspace-output' ? durableCalls[0] : undefined
    const spillReadback = spillResult?.spillPath
      ? await readWorkspaceSpill(ctx.tools, agent, workspace, spillResult.spillPath, scenario === 'workspace-grep')
      : undefined
    const breakdown = ctx.sessionProjections.snapshot(agent.session, ['contextBreakdown']).values.contextBreakdown
    return { sessionId, permission, ...measurement, finalToolsTokens: breakdown.toolsTokens,
      runtime: { electron: process.versions.electron, node: process.versions.node, dsh: process.env.DSH_CLIENT_VERSION },
      calls: outcomes.get(sessionId) ?? [], durableCalls, ptcError, files, grep, paired, spillReadback,
      pairs: benchmarks.get(sessionId)?.samples.slice(1),
      ...(scenario === 'combined' ? { combinedCalls: summarizeCombinedCalls(outputs) } : {}) }
  }

  const onMessage = async message => {
    if (message.type !== 'lite-run-session') return
    try { process.send?.({ type: 'lite-session-done', result: await runSession(message) }) }
    catch (error) { process.send?.({ type: 'lite-session-done', error: String(error.stack ?? error) }) }
  }
  process.on('message', onMessage)
  ctx.on('dispose', () => process.off('message', onMessage))
}

async function readWorkspaceSpill(tools, agent, workspace, target, grep) {
  const spillDir = path.join(workspace, '.dsh-lite-exec', 'spill')
  if (!/^slot-\d+[/\\][\da-f-]{36}\.done\.log$/u.test(path.relative(spillDir, target))) {
    return { error: 'Spill path outside the fixture spill directory' }
  }
  const hash = createHash('sha256')
  const chunks = []
  const signal = AbortSignal.timeout(8_000)
  let offset = 0
  const limitBytes = 1024 * 1024
  while (offset < 16 * limitBytes) {
    const { results: [{ result: { value, isError } }] } = await tools.execute({
      agent, signal, calls: [{ type: 'tool-call', id: randomUUID(), name: 'lite_read',
        arguments: JSON.stringify({ path: target, encoding: 'utf-8', limitBytes, offsetBytes: offset }) }],
    })
    if (isError || value?.ok !== true || typeof value.content !== 'string' || value.binary) {
      return { error: 'lite_read could not read the spill', code: value?.code }
    }
    const contentBytes = Buffer.byteLength(value.content)
    if (contentBytes > value.bytes || value.bytes - contentBytes > 3 || (!contentBytes && value.truncated)) {
      return { error: 'Invalid window while reading the spill' }
    }
    hash.update(value.content)
    offset += contentBytes
    if (grep) chunks.push(value.content)
    if (!value.truncated) {
      const summary = { bytes: offset, sha256: hash.digest('hex') }
      if (!grep) return summary
      try {
        const records = chunks.join('').trimEnd().split('\n').map(line => JSON.parse(line))
        const input = path.join(workspace, 'grep-fixture.txt')
        return { ...summary, records: records.length, ordered: records.every((row, index) =>
          path.relative(input, row.path) === '' && row.line === index + 1 && row.column === 1 && row.text === `needle-${index + 1}`) }
      } catch {
        return { ...summary, error: 'Invalid grep spill records' }
      }
    }
  }
  return { error: 'Spill readback exceeded the 16 MiB storage limit' }
}

async function bareBash(agent, cwd) {
  const subprocess = agent.ctx.get('subprocess')
  const signal = AbortSignal.timeout(8_000)
  const program = path.join(process.env.ProgramW6432 ?? process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
  const executable = await subprocess.resolveExecutable(program, undefined, signal)
  const started = performance.now()
  const handle = subprocess.spawn({ argv: [executable, '--noprofile', '--norc', '-c', benchmarkCommand], cwd, signal, graceMs: 500,
    env: { BASH_ENV: '', ENV: '', CDPATH: '' }, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
  const [result, stdout, stderr] = await Promise.all([handle.done, readStream(handle.stdout), readStream(handle.stderr), handle.waitForExit()])
  return { bareMs: Number((performance.now() - started).toFixed(2)), bareOk: result.exitCode === 0 && stdout.trim() === 'lite-benchmark',
    bareExitCode: result.exitCode, bareStderrBytes: Buffer.byteLength(stderr) }
}

async function readStream(stream) {
  const buffers = []
  for await (const chunk of stream) buffers.push(Buffer.from(chunk))
  return Buffer.concat(buffers).toString()
}

async function powershellControl(agent, cwd) {
  const policy = agent.ctx.get('sandboxPolicy').resolve({ session: agent.session })
  if (!['workspace-write', 'read-only'].includes(policy.mode)) throw new Error('PowerShell control requires a restricted session')
  const sandbox = agent.ctx.get('sandbox')
  const subprocess = agent.ctx.get('subprocess')
  const program = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const preamble = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n'
  const commands = [
    ['small', "Write-Output 'ps-readable-fixture'"],
    ['inside', "Set-Content -LiteralPath './ps-boundary-inside.txt' -Value 'ps-inside-fixture' -ErrorAction Stop"],
    ['outside', "Set-Content -LiteralPath '../guard/ps-boundary-outside.txt' -Value 'ps-outside-fixture' -ErrorAction Stop"],
    ['large', "1..500 | ForEach-Object { Write-Output 'ps-boundary-spill-abcdefghijklmnop' }"],
  ]
  const calls = []
  for (const [name, command] of commands) {
    const signal = AbortSignal.timeout(8_000)
    const argv = [program, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(preamble + command, 'utf16le').toString('base64')]
    try {
      const confinement = await sandbox.confine(argv, policy, signal)
      const handle = subprocess.spawn({ argv: confinement.argv, cwd, signal, graceMs: 500,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
      const [result, stdout, stderr] = await Promise.all([handle.done, readStream(handle.stdout), readStream(handle.stderr), handle.waitForExit()])
      calls.push({ name, exitCode: result.exitCode, stdoutBytes: Buffer.byteLength(stdout), sawOutput: stdout.includes('ps-readable-fixture'),
        permissionDenied: /permission denied|access is denied|unauthorizedaccessexception|access to the path/iu.test(stderr),
        constrainedLanguage: /constrained|core types/iu.test(stderr), runnerFailure: /windows-acl-run: /iu.test(stderr),
        stderrBytes: Buffer.byteLength(stderr) })
    } catch (error) {
      calls.push({ name, code: error.code ?? error.name })
    }
  }
  return calls
}

