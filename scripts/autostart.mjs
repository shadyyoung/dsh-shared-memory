#!/usr/bin/env node
/**
 * Cross-platform login autostart helper: keep the memory host running so
 * Cursor / Claude / ChatGPT desktop can use shared memory right after login.
 *
 *   node scripts/autostart.mjs status
 *   node scripts/autostart.mjs install [--mode app|hub] [--target <exe>]
 *                                      [--port 7400] [--store <dir>] [--dry-run]
 *   node scripts/autostart.mjs uninstall [--dry-run]
 *
 * Platform backends:
 *   macOS   LaunchAgent          ~/Library/LaunchAgents/com.kai.dsh-shared-memory.plist
 *   Windows Scheduled Task       ONLOGON, wrapper script in %LOCALAPPDATA%\dsh-shared-memory
 *   Linux   systemd --user unit  ~/.config/systemd/user/dsh-shared-memory.service
 *
 * Two run modes:
 *   app  launch DeepSeek Harness (default on macOS / Windows). Not available on
 *        Linux, which has no DSH desktop build.
 *   hub  run the standalone hub (`standalone/server.mjs`) — useful on Linux and
 *        on any machine that should serve memory without DSH.
 *
 * `--dry-run` prints the planned files and commands without touching the
 * system; it is also what the test suite exercises.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOME = os.homedir()
const LABEL = 'com.kai.dsh-shared-memory'
const WIN_TASK = 'dsh-shared-memory'
const LINUX_UNIT = 'dsh-shared-memory.service'
const APP = 'DeepSeek Harness'
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SERVER = path.join(REPO, 'standalone', 'server.mjs')

/** Parse `--key value` / `--flag` CLI options. */
export function parseArgs(argv) {
  const options = { action: 'status', mode: '', target: '', port: '7400', store: '', dryRun: false }
  const actions = new Set(['status', 'install', 'uninstall'])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (actions.has(arg)) {
      options.action = arg
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--mode') {
      options.mode = String(argv[++index] ?? '')
      continue
    }
    if (arg === '--target') {
      options.target = String(argv[++index] ?? '')
      continue
    }
    if (arg === '--port') {
      options.port = String(argv[++index] ?? '7400')
      continue
    }
    if (arg === '--store') {
      options.store = String(argv[++index] ?? '')
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }
  if (options.mode && options.mode !== 'app' && options.mode !== 'hub') throw new Error('--mode 只支持 app 或 hub')
  if (!/^\d+$/.test(options.port)) throw new Error('--port 必须是数字')
  return options
}

/** Build the platform-specific autostart plan without touching the system. */
export function buildPlan({
  platform = process.platform,
  home = HOME,
  repo = REPO,
  server = '',
  mode = '',
  target = '',
  port = '7400',
  store = '',
  nodePath = process.execPath,
  app = APP,
  label = LABEL,
  taskName = WIN_TASK,
  unitName = LINUX_UNIT,
  localAppData = process.env.LOCALAPPDATA || '',
  programFiles = process.env.ProgramFiles || 'C:\\Program Files',
}) {
  // Generate paths for the TARGET platform, not for the host running the script
  // (tests build Windows and Linux plans from macOS, and `--dry-run` must print
  // the real target paths).
  const p = platform === 'win32' ? path.win32 : path.posix
  const local = localAppData || p.join(home, 'AppData', 'Local')
  const serverPath = server || p.join(repo, 'standalone', 'server.mjs')
  const hubArgs = [serverPath, '--port', port]
  if (store) hubArgs.push('--store', store)
  const chosenMode = mode || (platform === 'linux' ? 'hub' : 'app')

  if (chosenMode === 'app' && platform === 'linux') {
    throw new Error('Linux 没有 DeepSeek Harness 桌面版，请用 --mode hub（或 --mode app --target <可执行文件>）')
  }

  if (platform === 'darwin') {
    const file = p.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
    const programArguments =
      chosenMode === 'hub'
        ? [nodePath, ...hubArgs]
        : ['/usr/bin/open', '-a', app]
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${arg}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
`
    return {
      platform,
      mode: chosenMode,
      kind: 'LaunchAgent',
      file,
      content: plist,
      installCommands: [
        ['launchctl', ['unload', file], { tolerate: true }],
        ['launchctl', ['load', file]],
      ],
      uninstallCommands: [['launchctl', ['unload', file], { tolerate: true }]],
      statusCommands: [['launchctl', ['list', label], { tolerate: true }]],
      describe: `登录后自动${chosenMode === 'hub' ? '启动独立 Hub' : `打开「${app}」`}，共享记忆服务随之在线。`,
    }
  }

  if (platform === 'win32') {
    const dir = p.join(local, 'dsh-shared-memory')
    const file = p.join(dir, 'autostart.cmd')
    const exeTargets = [
      p.join(local, 'Programs', app, `${app}.exe`),
      p.join(local, app, `${app}.exe`),
      p.join(programFiles, app, `${app}.exe`),
    ]
    const appTarget = target || exeTargets.find((candidate) => fs.existsSync(candidate)) || ''
    if (chosenMode === 'app' && !appTarget) {
      throw new Error(
        `没找到「${app}」的安装路径，请用 --target "C:\\...\\${app}.exe" 指定，或改用 --mode hub`,
      )
    }
    const launch =
      chosenMode === 'hub'
        ? `start "" "${nodePath}" ${hubArgs.map((arg) => `"${arg}"`).join(' ')}`
        : `start "" "${appTarget}"`
    const content = `@echo off\r\nrem dsh-shared-memory autostart (generated)\r\n${launch}\r\n`
    const createCommand = ['schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', taskName, '/TR', file]]
    return {
      platform,
      mode: chosenMode,
      kind: 'Scheduled Task (ONLOGON)',
      file,
      content,
      // schtasks accepts the wrapper path directly; quoting is handled by execFileSync.
      installCommands: [createCommand],
      uninstallCommands: [['schtasks', ['/Delete', '/F', '/TN', taskName], { tolerate: true }]],
      statusCommands: [['schtasks', ['/Query', '/TN', taskName], { tolerate: true }]],
      describe: `登录后自动${chosenMode === 'hub' ? '启动独立 Hub' : `打开「${app}」`}（计划任务 ${taskName}）。`,
    }
  }

  if (platform === 'linux') {
    const file = p.join(home, '.config', 'systemd', 'user', unitName)
    const execLine = [nodePath, ...hubArgs].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')
    const content = `[Unit]
Description=Shared Memory hub (dsh-shared-memory)
After=network.target

[Service]
Type=simple
ExecStart=${execLine}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
    return {
      platform,
      mode: chosenMode,
      kind: 'systemd user unit',
      file,
      content,
      installCommands: [
        ['systemctl', ['--user', 'daemon-reload']],
        ['systemctl', ['--user', 'enable', '--now', unitName]],
      ],
      uninstallCommands: [
        ['systemctl', ['--user', 'disable', '--now', unitName], { tolerate: true }],
        ['systemctl', ['--user', 'daemon-reload'], { tolerate: true }],
      ],
      statusCommands: [['systemctl', ['--user', 'is-enabled', unitName], { tolerate: true }]],
      describe: `登录后自动启动独立 Hub（systemd 用户单元 ${unitName}）。`,
    }
  }

  throw new Error(`不支持的平台：${platform}`)
}

function runCommand([command, args, options = {}]) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    if (options.tolerate) return ''
    throw error
  }
}

function status(action) {
  console.log(`平台：${process.platform}`)
  let plan
  try {
    plan = buildPlan({})
  } catch (error) {
    // Not an error: a machine can be missing the DSH install (the Windows CI
    // runner, for example). Report what is missing and how to fix it.
    console.log(`启动计划：不可用 —— ${error instanceof Error ? error.message : String(error)}`)
    console.log('\n安装：node scripts/autostart.mjs install --target <可执行文件路径>')
    return
  }
  console.log(`方式：${plan.kind} · 模式：${plan.mode}`)
  console.log(`配置文件：${plan.file}（${fs.existsSync(plan.file) ? '已存在' : '不存在'}）`)
  const output = plan.statusCommands.map(runCommand).filter(Boolean).join('\n')
  console.log(output ? `状态：\n${output}` : '状态：未加载')
  if (action === 'status') console.log(`\n安装：node scripts/autostart.mjs install\n卸载：node scripts/autostart.mjs uninstall`)
}

function install(options) {
  const plan = buildPlan({ mode: options.mode, target: options.target, port: options.port, store: options.store })
  console.log(`平台：${plan.platform} · 方式：${plan.kind} · 模式：${plan.mode}`)
  console.log(`将写入：${plan.file}`)
  if (options.dryRun) {
    console.log('\n--- 文件内容 ---')
    console.log(plan.content.replace(/\r\n/g, '\n').trimEnd())
    console.log('\n--- 将执行 ---')
    for (const [command, args] of plan.installCommands) console.log(`${command} ${args.join(' ')}`)
    console.log('\n(dry run：未修改系统)')
    return
  }
  fs.mkdirSync(path.dirname(plan.file), { recursive: true })
  fs.writeFileSync(plan.file, plan.content)
  for (const command of plan.installCommands) runCommand(command)
  console.log(`\n✅ 已安装：${plan.describe}`)
  console.log(`卸载：node scripts/autostart.mjs uninstall`)
}

function uninstall(options) {
  const plan = buildPlan({})
  console.log(`平台：${plan.platform} · 方式：${plan.kind}`)
  if (options.dryRun) {
    for (const [command, args] of plan.uninstallCommands) console.log(`将执行：${command} ${args.join(' ')}`)
    console.log(`(dry run：未修改系统；配置文件 ${plan.file})`)
    return
  }
  for (const command of plan.uninstallCommands) runCommand(command)
  if (fs.existsSync(plan.file)) fs.rmSync(plan.file)
  console.log('✅ 已移除登录自启。')
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.action === 'install') install(options)
  else if (options.action === 'uninstall') uninstall(options)
  else status(options.action)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`autostart 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
