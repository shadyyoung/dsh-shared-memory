#!/usr/bin/env node
/**
 * macOS login-item helper: keep the memory host (DeepSeek Harness) running so
 * Cursor / Claude / ChatGPT desktop can use shared memory right after login.
 *
 *   node scripts/autostart.mjs status
 *   node scripts/autostart.mjs install
 *   node scripts/autostart.mjs uninstall
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = os.homedir()
const LABEL = 'com.kai.dsh-shared-memory'
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const APP = 'DeepSeek Harness'

function status() {
  const installed = fs.existsSync(PLIST)
  console.log(`登录项启动器 ${installed ? '已安装' : '未安装'}：${PLIST}`)
  try {
    const out = execFileSync('launchctl', ['list', LABEL], { encoding: 'utf8' }).trim()
    console.log(out.split('\n').slice(0, 4).join('\n'))
  } catch {
    console.log('launchctl: 未加载')
  }
}

function install() {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>${APP}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
`
  fs.writeFileSync(PLIST, plist)
  try {
    execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' })
  } catch {}
  execFileSync('launchctl', ['load', PLIST])
  console.log(`已安装并加载：登录后自动打开「${APP}」，共享记忆服务随之在线。`)
  console.log(`卸载：node scripts/autostart.mjs uninstall`)
}

function uninstall() {
  try {
    execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' })
  } catch {}
  if (fs.existsSync(PLIST)) fs.rmSync(PLIST)
  console.log('已移除登录项启动器。')
}

const action = process.argv[2] || 'status'
if (action === 'install') install()
else if (action === 'uninstall') uninstall()
else status()
