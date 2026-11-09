/**
 * Autostart-plan test: verifies the per-platform launcher this repo would
 * install, for all three backends, without touching the host system.
 *
 * Run with `node test/autostart.mjs`. On macOS the live `status` command is
 * also exercised (read-only).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlan, parseArgs } from '../scripts/autostart.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'scripts', 'autostart.mjs')
const repo = '/opt/shared-memory'
const server = `${repo}/standalone/server.mjs`
const home = '/home/tester'

// ---- macOS · app mode (historical default, must not regress) ------------
const mac = buildPlan({ platform: 'darwin', home, repo, server, mode: 'app' })
assert.equal(mac.file, `${home}/Library/LaunchAgents/com.kai.dsh-shared-memory.plist`)
assert.equal(mac.kind, 'LaunchAgent')
assert.match(mac.content, /<string>\/usr\/bin\/open<\/string>/)
assert.match(mac.content, /<string>DeepSeek Harness<\/string>/)
assert.match(mac.content, /<key>RunAtLoad<\/key><true\/>/)
assert.equal(mac.installCommands[1][0], 'launchctl')
assert.deepEqual(mac.installCommands[1][1], ['load', mac.file])

// ---- macOS · hub mode ---------------------------------------------------
const macHub = buildPlan({ platform: 'darwin', home, repo, server, mode: 'hub', nodePath: '/usr/local/bin/node', port: '7401' })
assert.match(macHub.content, /<string>\/usr\/local\/bin\/node<\/string>/)
assert.ok(macHub.content.includes(server), 'hub plist runs the standalone server')
assert.ok(macHub.content.includes('7401'), 'hub plist forwards the port')

// ---- Windows · app mode (scheduled task + wrapper) -----------------------
const winHome = 'C:\\Users\\tester'
const win = buildPlan({
  platform: 'win32',
  home: winHome,
  mode: 'app',
  target: 'C:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe',
  localAppData: 'C:\\Users\\tester\\AppData\\Local',
  programFiles: 'C:\\Program Files',
})
assert.equal(win.kind, 'Scheduled Task (ONLOGON)')
assert.ok(win.file.endsWith('dsh-shared-memory\\autostart.cmd'), `unexpected wrapper path: ${win.file}`)
assert.match(win.content, /start "" "C:\\Apps\\DeepSeek Harness\\DeepSeek Harness\.exe"/)
assert.equal(win.installCommands.length, 1)
const [taskCommand, taskArgs] = win.installCommands[0]
assert.equal(taskCommand, 'schtasks')
assert.ok(taskArgs.includes('/SC') && taskArgs.includes('ONLOGON'), 'scheduled task runs at logon')
assert.ok(taskArgs.includes('/TN') && taskArgs.includes('dsh-shared-memory'), 'task name is stable')
assert.ok(taskArgs.includes(win.file), 'task runs the wrapper script')

// ---- Windows · hub mode -------------------------------------------------
const winHub = buildPlan({
  platform: 'win32',
  home: winHome,
  mode: 'hub',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  server: 'C:\\sm\\standalone\\server.mjs',
  port: '7402',
  store: 'C:\\store',
  localAppData: 'C:\\Users\\tester\\AppData\\Local',
})
assert.match(winHub.content, /node\.exe"/)
assert.match(winHub.content, /server\.mjs"/)
assert.ok(winHub.content.includes('7402') && winHub.content.includes('C:\\store'))

// Windows app mode without a discoverable target must explain the fix.
assert.throws(
  () => buildPlan({ platform: 'win32', home: winHome, mode: 'app', localAppData: 'C:\\nope', programFiles: 'C:\\nope' }),
  /--target/,
)

// ---- Linux · hub mode (systemd user unit) --------------------------------
const linux = buildPlan({ platform: 'linux', home, repo, server, nodePath: '/usr/bin/node', port: '7400' })
assert.equal(linux.mode, 'hub', 'Linux defaults to the hub: there is no DSH desktop build')
assert.equal(linux.kind, 'systemd user unit')
assert.equal(linux.file, `${home}/.config/systemd/user/dsh-shared-memory.service`)
assert.match(linux.content, /\[Install\][\s\S]*WantedBy=default\.target/)
assert.match(linux.content, /ExecStart=\/usr\/bin\/node /)
assert.ok(linux.content.includes(server))
assert.match(linux.content, /Restart=on-failure/)
assert.equal(linux.installCommands[0][0], 'systemctl')
assert.ok(linux.installCommands.some(([command, args]) => command === 'systemctl' && args.includes('enable') && args.includes('--now')))

// Linux app mode is impossible by design.
assert.throws(() => buildPlan({ platform: 'linux', mode: 'app' }), /Linux 没有 DeepSeek Harness 桌面版/)

// Unknown platforms fail loudly instead of writing a wrong file.
assert.throws(() => buildPlan({ platform: 'aix' }), /不支持的平台/)

// ---- CLI parsing --------------------------------------------------------
assert.deepEqual(parseArgs([]), { action: 'status', mode: '', target: '', port: '7400', store: '', dryRun: false })
assert.equal(parseArgs(['install', '--mode', 'hub', '--port', '7500', '--dry-run']).dryRun, true)
assert.deepEqual(parseArgs(['uninstall']), { action: 'uninstall', mode: '', target: '', port: '7400', store: '', dryRun: false })
assert.throws(() => parseArgs(['--mode', 'nope']), /app 或 hub/)
assert.throws(() => parseArgs(['--port', 'x']), /--port/)
assert.throws(() => parseArgs(['--bogus']), /未知参数/)

// ---- Live status on this host (read-only) -------------------------------
// On a runner without DeepSeek Harness installed (e.g. the Windows CI box) the
// CLI must explain what is missing instead of failing with a stack trace.
const statusOutput = execFileSync(process.execPath, [script, 'status'], { encoding: 'utf8' })
assert.match(statusOutput, /平台：/)
assert.match(statusOutput, /配置文件：|启动计划：不可用/)
assert.doesNotMatch(statusOutput, /Error:/)
console.log('ok autostart plan: macOS LaunchAgent, Windows scheduled task, Linux systemd user unit')

process.exit(0)
