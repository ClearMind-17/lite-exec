import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import path from 'node:path'

const manifest = path.join(process.argv[2], 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
process.env.DSH_CLIENT_VERSION = JSON.parse(fs.readFileSync(manifest, 'utf8')).version

// Electron's archive-aware realpath works when Windows native realpath is
// unavailable under the verification process' sandbox. Keep that fallback local.
const realpathNative = fs.realpathSync.native
const realpathPromise = fs.promises.realpath
const roots = [process.argv[2], process.env.USERPROFILE].map(value => path.resolve(value).toLowerCase())
function fallbackRealpath(file, options, error) {
  const target = path.resolve(String(file)).toLowerCase()
  if (error.code !== 'EPERM' || !roots.some(root => target === root || target.startsWith(root + path.sep))) throw error
  return fs.realpathSync(file, options)
}
fs.realpathSync.native = (file, options) => {
  try { return realpathNative(file, options) } catch (error) { return fallbackRealpath(file, options, error) }
}
fs.promises.realpath = async (file, options) => {
  try { return await realpathPromise(file, options) } catch (error) { return fallbackRealpath(file, options, error) }
}
syncBuiltinESMExports()

const loopback = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const [target, host] = Array.isArray(args[0]) ? args[0] : args
  const address = typeof target === 'object' ? (target.path ? '' : (target.host ?? 'localhost')) : (typeof target === 'number' && typeof host !== 'string' ? 'localhost' : host)
  if (!loopback.has(address)) throw new Error('Isolated host check permits only loopback connections')
  return connect.apply(this, args)
}
