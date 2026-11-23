import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { combinedCallCount, prepareCombinedProfile } from './combined-fixture.mjs'

const { values } = parseArgs({ options: {
  electron: { type: 'string', default: process.env.DSH_DESKTOP_EXE ?? '' },
  stage: { type: 'string', default: os.tmpdir() },
  package: { type: 'string', default: path.resolve(import.meta.dirname, '..') },
  output: { type: 'string' },
  flash: { type: 'string' },
  memo: { type: 'string' },
  mode: { type: 'string', default: 'danger-full-access' },
  baseline: { type: 'boolean', default: false },
  'permission-check': { type: 'boolean', default: false },
  'compare-powershell': { type: 'boolean', default: false },
  'paired-powershell': { type: 'boolean', default: false },
  'full-powershell': { type: 'boolean', default: false },
  'stdout-control': { type: 'boolean', default: false },
  benchmark: { type: 'boolean', default: false },
} })
assert.ok(['workspace-write', 'read-only', 'danger-full-access'].includes(values.mode))
const permissionCheck = values['permission-check']
const comparePowershell = values['compare-powershell']
const pairedPowershell = values['paired-powershell']
const fullPowershell = values['full-powershell']
assert.ok(!values.memo || (!values.baseline && !values.benchmark && !comparePowershell && !permissionCheck))
assert.ok(!values.benchmark || (!permissionCheck && !values.baseline && values.mode === 'danger-full-access'), 'Use --benchmark with the isolated full access fixture')
assert.ok(!permissionCheck || (!values.baseline && values.mode !== 'danger-full-access'), 'Use --permission-check with --mode workspace-write or --mode read-only')
assert.ok(!comparePowershell || permissionCheck, 'Use --compare-powershell with --permission-check')
assert.ok(!fullPowershell || (!permissionCheck && !values.memo && !values.baseline && !values.benchmark && values.mode === 'danger-full-access'))
assert.ok(!values['stdout-control'] || (permissionCheck && values.mode === 'workspace-write'))
assert.ok(!pairedPowershell || (values.mode === 'workspace-write' && !values.memo && !values.baseline && !permissionCheck && !values.benchmark))
assert.ok(values.electron, 'Pass --electron <path-to-DeepSeek-Harness.exe> or set DSH_DESKTOP_EXE')
const electron = path.resolve(values.electron)
const resources = path.join(path.dirname(electron), 'resources')
const runtime = path.join(resources, 'app.asar', 'dsh')
const liteNames = ['lite_exec', 'lite_grep', 'lite_read', 'lite_stat']
const ptcPreset = values.flash ? 'flash-lean-ptc-v3' : 'ptc'
const root = await mkdtemp(path.join(path.resolve(values.stage), 'dsh-lite-host-'))
const home = path.join(root, 'home')
const profile = path.join(home, 'profiles', 'desktop')
const modules = path.join(profile, 'node_modules')
const workspace = path.join(root, 'workspace')
const fixture = path.join(modules, 'lite-fixture')

const stages = values.baseline ? ['baseline'] : permissionCheck || pairedPowershell || values.benchmark || values.memo ? ['enabled'] : ['baseline', 'disabled', 'enabled', 'removed']
const results = {}
try {
  await mkdir(fixture, { recursive: true })
  await mkdir(workspace)
  if (permissionCheck || pairedPowershell) await mkdir(path.join(root, 'guard'))
  if (permissionCheck) {
    const grepFixture = Array.from({ length: 5000 }, (_, index) => `needle-${index + 1}\n`).join('')
    await writeFile(path.join(workspace, 'grep-fixture.txt'), grepFixture)
  }
  await writeFile(path.join(workspace, 'fixture.txt'), 'lightweight fixture\n')
  for (const args of [['init', '-q'], ['-c', 'core.autocrlf=false', 'add', 'fixture.txt'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']]) {
    execFileSync('git', ['-c', 'safe.directory=' + workspace.replaceAll('\\', '/'), ...args], { cwd: workspace, windowsHide: true })
  }
  await cp(path.join(import.meta.dirname, 'host-fixture.mjs'), path.join(fixture, 'index.mjs'))
  await cp(path.join(import.meta.dirname, 'combined-fixture.mjs'), path.join(fixture, 'combined-fixture.mjs'))
  const memoBundle = values.memo && await prepareCombinedProfile(values.memo, { home, modules, workspace })
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'lite-fixture', version: '0.0.0', main: 'index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(path.join(fixture, 'cordis.patch.yml'), [
    '- insert:', '    - id: lite-fixture', '      name: lite-fixture',
    '- id: agent-default-model', '  config:', '    provider: lite-fixture', '    model: lite-check',
    '- id: session-title-llm', '  disabled: true',
  ].join('\n') + '\n')
  if (values.flash) await cp(path.resolve(values.flash), path.join(modules, 'dsh-flash-presets'), { recursive: true })
  await writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  for (const stage of stages) {
    const bundled = stage === 'disabled' || stage === 'enabled'
    const lite = path.join(modules, 'dsh-lite-exec')
    if (stage === 'disabled' || permissionCheck || pairedPowershell || values.benchmark || values.memo) {
      await mkdir(lite)
      for (const name of ['package.json', 'cordis.patch.yml', 'lib']) {
        await cp(path.join(values.package, name), path.join(lite, name), { recursive: true })
      }
    }
    if (stage === 'removed') await rm(lite, { recursive: true })
    const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'lite-fixture']
    if (values.flash) bundles.push('dsh-flash-presets')
    if (bundled) bundles.push('dsh-lite-exec')
    if (memoBundle) bundles.push(memoBundle)
    await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dsh: { profile: { bundles } } }))
    await writeFile(path.join(profile, 'cordis.patch.yml'), stage === 'disabled' ? '- id: dsh-lite-exec\n  config:\n    enabled: false\n' : '[]\n')
    results[stage] = await runStage(stage)
    process.stderr.write(`DSH host check completed ${stage}\n`)
  }
  const report = { scope: 'Installed Electron backend, isolated Desktop profile and deterministic local LLM adapter', permission: values.mode,
    presets: permissionCheck || pairedPowershell || values.benchmark || values.memo ? ['standard'] : ['standard', ptcPreset],
    ...(fullPowershell ? { shellControl: 'explicit powershell' } : {}), results }
  if (values.memo) {
    const calls = results.enabled.combined.combinedCalls
    report.checks = { combined: { passed: calls.length === combinedCallCount && calls.every(call => call.passed), count: calls.length } }
  } else if (permissionCheck) report.checks = await comparePermission(results.enabled)
  else if (pairedPowershell) report.checks = await comparePairedPowershell(results.enabled.paired)
  else if (values.benchmark) report.checks = compareBenchmark(results.enabled.native.pairs)
  else if (!values.baseline) report.checks = compare(results)
  const json = JSON.stringify(report, null, 2) + '\n'
  if (values.output) await writeFile(path.resolve(values.output), json)
  process.stdout.write(json)
  if (report.checks && Object.values(report.checks).some(check => check.passed === false)) process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 2 })
}

async function runStage(stage) {
  const host = spawn(electron, [
    '--expose-internals', '--import', pathToFileURL(path.join(import.meta.dirname, 'host-preload.mjs')).href,
    path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
    runtime, profile, path.join(resources, 'runtime', 'primary-runtime'),
  ], {
    cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_PERMISSION_MODE: values.mode, DSH_TELEMETRY_DISABLED: '1',
      USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, Path: process.env.Path ?? process.env.PATH,
      ProgramFiles: process.env.ProgramFiles, ProgramW6432: process.env.ProgramW6432,
    },
  })
  const hostClosed = once(host, 'exit')
  let logs = '', shutdownAcknowledged = false
  for (const stream of [host.stdout, host.stderr]) stream.on('data', data => { logs = (logs + data).slice(-5000) })
  host.on('message', message => {
    if (message.type === 'starting') host.send({ type: 'desktop-auth', secret: randomBytes(32).toString('base64url') })
    if (message.type === 'shutdown-complete') shutdownAcknowledged = true
  })
  const ready = new Promise((resolve, reject) => {
    host.on('message', message => {
      if (message.type === 'ready') resolve(new URL(message.url))
      if (message.type === 'fatal') reject(new Error(message.message))
    })
    hostClosed.then(([code]) => reject(new Error(`Electron host exited before ready (${code})`)), reject)
  })
  let failure
  try {
    const url = await bounded(ready, 25_000, 'Electron ready')
    assert.equal(url.hostname, '127.0.0.1')
    if (values.memo) return { combined: await session('standard', 'combined'), shutdownAcknowledged: true }
    if (values.benchmark) return { native: await session('standard', 'benchmark'), shutdownAcknowledged: true }
    if (pairedPowershell) return { paired: await session('standard', 'paired-powershell'), shutdownAcknowledged: true }
    if (permissionCheck) {
      const native = await session('standard', 'permission')
      const powershellControl = comparePowershell ? await session('standard', 'powershell-control') : undefined
      const grepSession = await session('standard', 'workspace-grep')
      const workspaceGrep = { ...grepSession.grep, readback: grepSession.spillReadback }
      const workspaceOutput = values.mode === 'workspace-write' ? await session('standard', 'workspace-output') : undefined
      const serial = values.mode === 'workspace-write' ? await session('standard', 'serial') : undefined
      const serialStdout = values['stdout-control'] ? await session('standard', 'serial-stdout') : undefined
      const timeoutCleanup = values.mode === 'workspace-write' ? await session('standard', 'timeout-cleanup') : undefined
      return { native, powershellControl, workspaceGrep, workspaceOutput, serial, serialStdout, timeoutCleanup, shutdownAcknowledged: true }
    }
    const suffix = fullPowershell ? '-powershell' : ''
    const native = await session('standard', stage === 'enabled' ? 'exec' + suffix : 'probe')
    const ptc = await session(ptcPreset, stage === 'enabled' ? 'ptc' + suffix : 'probe')
    const timeout = stage === 'enabled' ? await session('standard', 'timeout' + suffix) : undefined
    const files = stage === 'enabled' ? (await session('standard', 'files')).files : undefined
    return { native, ptc, timeout, files, shutdownAcknowledged: true }
  } catch (error) {
    failure = error
    const safeLogs = logs.replace(/([?&]token=)[^\s&"'<>]+/gu, '$1[redacted]')
    throw new Error(`${stage}: ${error.message}\n${safeLogs}`, { cause: error })
  } finally {
    if (host.connected) host.send({ type: 'shutdown' })
    const timer = setTimeout(() => host.kill(), 5_000)
    try {
      const [code] = await hostClosed
      if (!failure) assert.ok(shutdownAcknowledged && code === 0, 'Isolated host did not shut down cleanly')
    } finally { clearTimeout(timer) }
  }

  async function session(agentPreset, scenario) {
    let onMessage
    const response = new Promise((resolve, reject) => {
      onMessage = message => {
        if (message.type !== 'lite-session-done') return
        if (message.error) reject(new Error(message.error))
        else resolve(message.result)
      }
      host.on('message', onMessage)
      hostClosed.then(([code]) => reject(new Error(`Electron host exited during session (${code})`)), reject)
      host.send({ type: 'lite-run-session', workspace, agentPreset, scenario })
    })
    let result
    try { result = await bounded(response, 40_000, 'Session ' + scenario) }
    finally { host.off('message', onMessage) }
    assert.equal(result.permission, values.mode)
    if (scenario === 'powershell-control') return result
    const { sessionId, ...report } = result
    let persisted
    const deadline = Date.now() + 4_000
    do {
      persisted = await readProjection(sessionId)
      if (persisted?.toolsTokens === report.finalToolsTokens) break
      await sleep(100)
    } while (Date.now() < deadline)
    assert.equal(report.finalToolsTokens, persisted?.toolsTokens, 'Cached contextBreakdown.toolsTokens mismatch')
    const { toolsTokens, systemTokens } = report.firstRequestContextBreakdown
    assert.ok(Number.isInteger(toolsTokens))
    return { ...report, toolsTokens, systemTokens, persistedToolsTokens: persisted.toolsTokens }
  }
}

function compareBenchmark(pairs) {
  const sorted = pairs.map(pair => pair.deltaMs).sort((left, right) => left - right)
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1]
  const valid = pairs.length === 20 && pairs.every(pair => pair.liteOk && pair.bareOk)
  return { increment: { passed: valid && percentile(0.95) <= 50, valid, pairs: pairs.length,
    p50Ms: valid ? percentile(0.50) : null, p95Ms: valid ? percentile(0.95) : null, maxMs: valid ? sorted.at(-1) : null,
    scope: 'Tool body from host middleware vs direct DSH subprocess, same Git Bash executable, cwd, argv and pipe draining; one warm-up pair discarded' } }
}

async function comparePermission({ native, powershellControl, workspaceGrep, workspaceOutput, serial, serialStdout, timeoutCleanup }) {
  const [read, inside, outside, spill, nonterminating, cwdControl, fileControl, bashControl] = native.durableCalls
  const exists = async filename => stat(filename).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  const insideCreated = await exists(path.join(workspace, 'boundary-inside.txt'))
  const outsideCreated = await exists(path.join(root, 'guard', 'boundary-outside.txt'))
  const nonterminatingCreated = await exists(path.join(root, 'guard', 'boundary-nonterminating-outside.txt'))
  const spillCreated = await exists(path.join(home, 'dsh-lite-exec', 'spill'))
  const workspaceWrite = values.mode === 'workspace-write'
  const workspaceSpill = path.join(workspace, '.dsh-lite-exec', 'spill')
  const workspaceSpillCreated = await exists(workspaceSpill)
  const control = powershellControl ? {
    insideCreated: await exists(path.join(workspace, 'ps-boundary-inside.txt')),
    outsideCreated: await exists(path.join(root, 'guard', 'ps-boundary-outside.txt')),
  } : undefined
  const checks = {
    smallCommand: { passed: read?.isError === false && read.ok === true && read.sawReadableFixture && isDefaultPowerShell(read),
      shell: read?.shell, shellFallback: read?.shellFallback, code: read?.code, stderr: read?.failureStderr },
    workspaceWrite: { passed: read?.ok === true && inside?.isError === false && inside.ok === workspaceWrite && insideCreated === workspaceWrite,
      allowed: workspaceWrite, created: insideCreated, code: inside?.code },
    outsideWrite: { passed: read?.ok === true && outside?.isError === false && outside.ok === false && !outsideCreated,
      created: outsideCreated, code: outside?.code },
    nonterminatingOutsideWrite: { passed: nonterminating?.isError === false && nonterminating.ok === true && nonterminating.exitCode === 0
        && nonterminating.continuedAfterDenial && nonterminating.suspectedSandboxDenial === true && !nonterminatingCreated,
      created: nonterminatingCreated, exitCode: nonterminating?.exitCode, suspectedSandboxDenial: nonterminating?.suspectedSandboxDenial,
      stderr: nonterminating?.failureStderr },
    spill: { passed: hasBoundedPreview(spill) && !spillCreated
        && (workspaceWrite ? validWorkspaceSpillResult(spill, workspaceSpill)
          : !workspaceSpillCreated && spill.spillPath === null && spill.spillReason === 'READ_ONLY'),
      workspaceSpillCreated, homeSpillCreated: spillCreated, code: spill?.code, spillReason: spill?.spillReason,
      spillMessage: spill?.spillMessage, previewBytes: spill?.previewBytes },
    explicitBash: { passed: bashControl?.isError === false && bashControl.shell === 'bash' && bashControl.shellUsed === 'bash'
        && bashControl.shellFallback === false && (bashControl.ok === true ? bashControl.sawBashFixture
          : bashControl.diagnosticCode === 'WINDOWS_BASH_STARTUP'),
      shell: bashControl?.shell, ok: bashControl?.ok, code: bashControl?.code, diagnosticCode: bashControl?.diagnosticCode,
      exitCode: bashControl?.exitCode },
    workingDirectoryControl: { matched: cwdControl?.shellCwd?.toLowerCase() === workspace.toLowerCase(), observed: cwdControl?.shellCwd },
    shellFileReadControl: { matched: fileControl?.ok === true && fileControl?.sawFixtureFile === true,
      code: fileControl?.code, suspectedSandboxDenial: fileControl?.suspectedSandboxDenial },
    ...(control ? { powershellControl: control } : {}),
  }
  const grepRows = workspaceWrite && hasWorkspaceSpill(workspaceGrep, workspaceSpill)
    ? (await readFile(workspaceGrep.spillPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line)) : []
  const matchPreview = workspaceGrep.matches ?? []
  const grepComplete = grepRows.length === 5000 && grepRows.every((match, index) => match.text === `needle-${index + 1}`)
    && JSON.stringify(grepRows.slice(0, 3)) === JSON.stringify(matchPreview)
    && workspaceGrep.readback?.records === 5000 && workspaceGrep.readback.ordered === true
  checks.grep = { passed: workspaceGrep.isError === false && workspaceGrep.ok === true && workspaceGrep.complete === true
      && workspaceGrep.truncated === true && workspaceGrep.matchCount === 5000 && matchPreview.length === 3
      && matchPreview.every((match, index) => match.text === `needle-${index + 1}`)
      && (workspaceWrite ? validWorkspaceSpillResult(workspaceGrep, workspaceSpill)
        : workspaceGrep.spillPath === null && workspaceGrep.spillReason === 'READ_ONLY'),
    matchCount: workspaceGrep.matchCount, previewCount: matchPreview.length, spillRecords: grepRows.length,
    spillReason: workspaceGrep.spillReason, spillMessage: workspaceGrep.spillMessage }
  if (workspaceWrite) {
    const [large] = workspaceOutput.durableCalls
    const largeOutput = hasWorkspaceSpill(large, workspaceSpill) ? await digestFile(large.spillPath) : { bytes: 0 }
    const expectedBlock = 'x'.repeat(60 * 1024 - 2) + '\r\n'
    const expectedHash = createHash('sha256')
    for (let i = 0; i < 256; i++) expectedHash.update(expectedBlock)
    const expectedSha256 = expectedHash.digest('hex')
    const largeBytesVerified = largeOutput.bytes === 15 * 1024 * 1024 && largeOutput.sha256 === expectedSha256
      && workspaceOutput.spillReadback?.bytes === largeOutput.bytes && workspaceOutput.spillReadback.sha256 === expectedSha256
    checks.largeOutput = { passed: hasBoundedPreview(large) && validWorkspaceSpillResult(large, workspaceSpill),
      expectedBytes: 15 * 1024 * 1024, previewBytes: large?.previewBytes, spillReason: large?.spillReason, spillMessage: large?.spillMessage }
    checks.workspaceSpillStorage = { passed: workspaceSpillCreated && hasWorkspaceSpill(spill, workspaceSpill) && largeBytesVerified && grepComplete,
      shellBytesOnDisk: largeOutput.bytes, shellSha256: largeOutput.sha256, expectedSha256,
      grepRecordsOnDisk: grepRows.length, largeBytesVerified, grepComplete,
      shellReadback: workspaceOutput.spillReadback, grepReadback: workspaceGrep.readback }
    checks.serial = compareSerial(serial)
    if (serialStdout) checks.serialStdout = compareSerial(serialStdout)
    const [timeout] = timeoutCleanup.durableCalls
    const timeoutDurationMs = timeoutCleanup.calls[0]?.durationMs
    const childExited = Number.isInteger(timeout?.childPid) && timeout.childPid > 1 && hasExited(timeout.childPid)
    checks.timeoutCleanup = { passed: timeout?.isError === false && timeout.code === 'TIMEOUT' && isDefaultPowerShell(timeout)
        && timeoutDurationMs < 7_000 && childExited,
      code: timeout?.code, durationMs: timeoutDurationMs, childPidEmitted: Boolean(timeout?.childPid), childExited }
  }
  return checks
}

async function digestFile(filename) {
  let bytes = 0
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length
    hash.update(chunk)
  }
  return { bytes, sha256: hash.digest('hex') }
}

function compareSerial({ durableCalls, calls }) {
  const failures = durableCalls.filter(call => call.isError !== false || call.ok !== true || !call.sawExpectedOutput
    || !isDefaultPowerShell(call)).length
  const startupFailures = calls.filter(isTargetedStartupFailure).length
  return { passed: durableCalls.length === 20 && failures <= 1 && startupFailures === 0, count: durableCalls.length, failures, startupFailures }
}

async function comparePairedPowershell({ paired, expectedCalls, declaredTools }) {
  const samePath = (left, right) => left?.toLowerCase() === right.toLowerCase()
  const inside = (tool, kind) => readFile(path.join(workspace, `paired-${tool}-${kind}.txt`), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const outside = async tool => stat(path.join(root, 'guard', `paired-${tool}-outside.txt`)).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  const checks = {
    pairedExecution: { passed: paired.length === expectedCalls && ['lite_exec', 'pwsh'].every(tool => declaredTools.includes(tool))
        && paired.every(call => call.name === call.expectedTool && call.durableResult && samePath(call.cwd, workspace)),
      count: paired.length, expectedCalls },
  }
  for (const [tool, name] of [['lite', 'lite_exec'], ['native', 'pwsh']]) {
    const data = Object.fromEntries(paired.filter(call => call.name === name).map(call => [call.probe, call]))
    const success = call => call?.isError === false && call.exitCode === 0
    const [location, shellHome, version] = data.cwd?.stdout?.split(/\r?\n/u) ?? []
    const absolute = await inside(tool, 'absolute')
    const relative = await inside(tool, 'relative')
    const outsideCreated = await outside(tool)
    checks[`${tool}Cwd`] = { passed: success(data.cwd) && samePath(location, workspace), observed: location, shellHome, version }
    checks[`${tool}AbsoluteRead`] = { passed: success(data['read-absolute']) && data['read-absolute'].stdout === 'lightweight fixture' }
    checks[`${tool}RelativeRead`] = { passed: success(data['read-relative']) && data['read-relative'].stdout === 'lightweight fixture' }
    checks[`${tool}AbsoluteWrite`] = { passed: success(data['write-absolute']) && absolute === 'paired-absolute', contentMatches: absolute === 'paired-absolute' }
    checks[`${tool}RelativeWrite`] = { passed: success(data['write-relative']) && relative === 'paired-relative', contentMatches: relative === 'paired-relative' }
    checks[`${tool}OutsideWrite`] = { passed: Number.isInteger(data['write-outside']?.exitCode) && data['write-outside'].exitCode !== 0 && !outsideCreated,
      created: outsideCreated }
  }
  return checks
}

function hasWorkspaceSpill(call, workspaceSpill) {
  if (typeof call?.spillPath !== 'string') return false
  const slot = path.dirname(call.spillPath)
  return /^slot-\d+$/u.test(path.basename(slot)) && path.dirname(slot).toLowerCase() === workspaceSpill.toLowerCase()
}

function hasBoundedPreview(call) {
  return call?.isError === false && call.ok === true && call.exitCode === 0 && call.truncated === true
    && call.sawSpillPreview && call.previewBytes > 0 && call.previewBytes <= 2_048
}

function validWorkspaceSpillResult(call, workspaceSpill) {
  return hasWorkspaceSpill(call, workspaceSpill) || call?.spillPath === null && ['UNAVAILABLE', 'ACL_DENIED'].includes(call.spillReason) && Boolean(call.spillMessage)
}

function isDefaultPowerShell(call) {
  return call?.shell === 'powershell' && call.shellUsed === 'powershell' && call.shellFallback === false
}

function isTargetedStartupFailure(call) {
  return call.diagnosticCode === 'WINDOWS_BASH_STARTUP' || call.msysStartupDenied || call.windowsSandboxRunnerFailure
    || call.exitCode === 0xc0000142 || call.exitCode === -1073741502
}

function hasExited(pid) {
  try { process.kill(pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
  return false
}

async function bounded(promise, duration, operation) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(operation + ' timed out')), duration) })]) }
  finally { clearTimeout(timer) }
}

async function readProjection(sessionId) {
  const directory = path.join(home, 'storages', 'session_projcache', 'sessions')
  try {
    const files = await readdir(directory)
    const file = files.find(name => name === sessionId + '.json')
    if (file) return JSON.parse(await readFile(path.join(directory, file), 'utf8')).record?.rows?.contextBreakdown?.val?.breakdown
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return undefined
}

function compare({ baseline, disabled, enabled, removed }) {
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
  const modes = ['native', 'ptc']
  const namesMatch = modes.every(mode => same(disabled[mode].registeredTools, baseline[mode].registeredTools)
    && same(removed[mode].registeredTools, baseline[mode].registeredTools)
    && same(enabled[mode].registeredTools.filter(name => !liteNames.includes(name)), baseline[mode].registeredTools)
    && liteNames.every(name => enabled[mode].registeredTools.includes(name))
    && same(disabled[mode].declaredTools, baseline[mode].declaredTools)
    && same(removed[mode].declaredTools, baseline[mode].declaredTools)
    && same(enabled[mode].declaredTools.filter(name => !liteNames.includes(name)), baseline[mode].declaredTools))
    && liteNames.every(name => enabled.native.declaredTools.includes(name))
  const toolsTokens = enabled.native.toolsTokens - baseline.native.toolsTokens
  const ptcToolsTokens = enabled.ptc.toolsTokens - baseline.ptc.toolsTokens
  const ptcSystemTokens = enabled.ptc.systemTokens - baseline.ptc.systemTokens
  const zeroInject = modes.every(mode => [disabled, enabled, removed].every(stage => stage[mode].injectTokens === baseline[mode].injectTokens))
  const failedCalls = enabled.native.durableCalls.filter(call => call.isError !== false || call.ok !== true).length
  const startupFailures = enabled.native.calls.filter(isTargetedStartupFailure).length
  const failedPtc = enabled.ptc.calls.filter(call => call.isError !== false || call.ok !== true).length
  const timeout = enabled.timeout.calls[0]
  const durableTimeout = enabled.timeout.durableCalls[0]
  const timeoutChildEmitted = fullPowershell ? Boolean(durableTimeout?.childPid) : durableTimeout?.childPidEmitted === true
  const timeoutChildExited = fullPowershell && timeoutChildEmitted ? hasExited(durableTimeout.childPid) : undefined
  const longOutputSpills = enabled.native.durableCalls.filter(call => call.truncated && call.spill).length
  return {
    officialTools: { passed: namesMatch },
    schemaBudget: { passed: toolsTokens >= 0 && toolsTokens <= 800 && ptcToolsTokens + ptcSystemTokens <= 800, nativeDelta: toolsTokens,
      ptcToolSchemaDelta: ptcToolsTokens, ptcSystemDelta: ptcSystemTokens, unit: 'DSH heuristic tokens from contextBreakdown' },
    injection: { passed: zeroInject, nativeDelta: enabled.native.injectTokens - baseline.native.injectTokens,
      ptcDelta: enabled.ptc.injectTokens - baseline.ptc.injectTokens, unit: 'DSH estimates of injected user/developer messages' },
    exec: { passed: enabled.native.durableCalls.length === 20 && failedCalls <= 1 && startupFailures === 0 && (!fullPowershell || longOutputSpills > 0),
      count: enabled.native.durableCalls.length, failures: failedCalls, longOutputSpills,
      startupFailures, msysStartupDenied: enabled.native.calls.filter(call => call.msysStartupDenied).length },
    ptc: { passed: enabled.ptc.ptcResultOk && enabled.ptc.calls.length === 1 && failedPtc === 0, count: enabled.ptc.calls.length, failures: failedPtc },
    timeout: { passed: timeout?.code === 'TIMEOUT' && timeout.durationMs < 5_000 && timeoutChildEmitted && (!fullPowershell || timeoutChildExited),
      deadlineMs: fullPowershell ? 3_000 : 1_000, durationMs: timeout?.durationMs, code: timeout?.code,
      childPidEmitted: timeoutChildEmitted, childExited: timeoutChildExited },
    files: { passed: enabled.files.length === 5 && enabled.files.every(file => file.ok), count: enabled.files.length },
  }
}
