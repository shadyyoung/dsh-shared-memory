#!/usr/bin/env node
/**
 * One-shot installer: detect installed AI apps and register the shared-memory
 * MCP server in every config we know about. Run: npm run install-apps
 *
 * Safe by design: existing files are backed up before edits, unknown files are
 * left alone, and every step is reported. Restart each app once afterwards.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = os.homedir()
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE = path.resolve(HERE, '..')
const NODE = process.execPath
const BRIDGE = path.join(HOME, '.dsh', 'shared-memory', 'mcp-server.mjs')
const SKILL_SOURCE = path.join(PACKAGE, 'skills', 'shared-memory', 'SKILL.md')
const rows = []

function report(app, status, detail) {
  rows.push({ app, status, detail })
}

function backup(file) {
  if (!fs.existsSync(file)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(file, `${file}.bak-${stamp}`)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

/** Register the bridge in a JSON config with an mcpServers object. */
function installJsonConfig(app, file, { create }) {
  const exists = fs.existsSync(file)
  if (!exists && !create) return report(app, 'SKIP', `未发现 ${file}（应用未安装或未配置）`)
  const current = exists ? readJson(file) : {}
  if (current === null) return report(app, 'WARN', `${file} 不是合法 JSON，已跳过`)
  if (current.mcpServers && current.mcpServers['shared-memory']) {
    return report(app, 'OK', `已登记 shared-memory（${file}）`)
  }
  backup(file)
  current.mcpServers = { ...(current.mcpServers || {}), 'shared-memory': { command: NODE, args: [BRIDGE] } }
  writeJson(file, current)
  report(app, exists ? 'WROTE' : 'CREATED', `${file}`)
}

/** Append a TOML table when absent (Codex / ChatGPT desktop). */
function installTomlConfig(app, file) {
  if (!fs.existsSync(file)) return report(app, 'SKIP', `未发现 ${file}`)
  const raw = fs.readFileSync(file, 'utf8')
  if (raw.includes('[mcp_servers.shared-memory]')) return report(app, 'OK', 'config.toml 已登记')
  backup(file)
  const block = `\n[mcp_servers.shared-memory]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(BRIDGE)}]\n`
  fs.appendFileSync(file, block)
  report(app, 'WROTE', `${file}`)
}

function appInstalled(...names) {
  return names.some((name) => fs.existsSync(`/Applications/${name}.app`) || fs.existsSync(path.join(HOME, 'Applications', `${name}.app`)))
}

function installWorkBuddy() {
  const target = path.join(HOME, '.workbuddy', 'skills', 'shared-memory', 'SKILL.md')
  if (fs.existsSync(target)) return report('WorkBuddy', 'OK', 'skill 已安装')
  if (!fs.existsSync(path.dirname(path.dirname(path.dirname(target))))) {
    return report('WorkBuddy', 'SKIP', '未发现 WorkBuddy 配置目录')
  }
  if (!fs.existsSync(SKILL_SOURCE)) return report('WorkBuddy', 'WARN', '包内缺少 skills/shared-memory/SKILL.md')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(SKILL_SOURCE, target)
  report('WorkBuddy', 'CREATED', target)
}

function main() {
  if (!fs.existsSync(BRIDGE)) {
    console.error(`缺少 MCP 桥：${BRIDGE}\n先启动一次 DSH 让它生成，再运行本脚本。`)
    process.exit(1)
  }

  installJsonConfig('Cursor', path.join(HOME, '.cursor', 'mcp.json'), { create: appInstalled('Cursor') })
  installJsonConfig('Claude Desktop', path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), {
    create: appInstalled('Claude'),
  })
  installTomlConfig('Codex / ChatGPT 桌面', path.join(HOME, '.codex', 'config.toml'))
  installJsonConfig('Claude Code', path.join(HOME, '.claude.json'), { create: false })
  installJsonConfig('Windsurf', path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), { create: appInstalled('Windsurf') })
  installJsonConfig('WorkBuddy (MCP)', path.join(HOME, '.workbuddy', 'mcp.json'), { create: appInstalled('WorkBuddy') })
  installWorkBuddy()

  console.log('\n共享记忆 · 应用接入安装\n')
  for (const row of rows) console.log(`${row.status.padEnd(8)} ${row.app.padEnd(18)} ${row.detail}`)
  console.log('\n下一步：')
  console.log('1) 完全退出（Cmd+Q）并重新打开上面显示 WROTE/CREATED/OK 的应用')
  console.log('2) 在应用里说「调 memory_status」验证')
  console.log('3) 想让服务在 DSH 关闭时也在线：把 DeepSeek Harness 设为登录项（系统设置 → 通用 → 登录项）\n')
}

main()
