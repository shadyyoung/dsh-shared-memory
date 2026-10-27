#!/usr/bin/env node
/**
 * Connectivity doctor: checks the running shared-memory service, the MCP bridge,
 * and every app integration config this machine has. Run: node scripts/doctor.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE = path.resolve(HERE, '..')
const HOME = os.homedir()
const rows = []
const add = (name, status, detail) => rows.push({ name, status, detail })
const ok = (name, detail) => add(name, 'OK', detail)
const warn = (name, detail) => add(name, 'WARN', detail)
const fail = (name, detail) => add(name, 'FAIL', detail)

async function checkRuntime() {
  const file = path.join(HOME, '.dsh', 'shared-memory', 'runtime.json')
  try {
    const runtime = JSON.parse(fs.readFileSync(file, 'utf8'))
    const res = await fetch(`${runtime.origin}/dsh-memory/health`)
    const health = await res.json()
    if (!health.ok) throw new Error('health.ok is false')
    ok('DSH 服务', `${runtime.origin} · v${health.version} · ${health.stats.memories} 条记忆 / ${health.stats.messages} 条原话`)
    return { runtime, health }
  } catch (error) {
    fail('DSH 服务', `${file} 读取或 /health 失败：${error.message}`)
    return null
  }
}

async function checkBridge() {
  const bridge = path.join(HOME, '.dsh', 'shared-memory', 'mcp-server.mjs')
  if (!fs.existsSync(bridge)) {
    fail('MCP 桥', `缺少 ${bridge}（重启 DSH 会重新生成）`)
    return
  }
  const child = spawn(process.execPath, [bridge], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let exited = false
  child.stderr.on('data', () => {})
  child.on('exit', () => { exited = true })
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'doctor', version: '1.0.0' } } })
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('"id":1')) {
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      }
      if (buffer.includes('"id":2')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', () => { clearTimeout(timer); resolve() })
  })
  try { child.kill() } catch {}
  const lines = buffer.split('\n').filter(Boolean)
  const replies = []
  for (const line of lines) {
    try { replies.push(JSON.parse(line)) } catch {}
  }
  const tools = replies.find((reply) => reply.id === 2)
  if (exited && !tools) {
    fail('MCP 桥', '桥进程提前退出，可能是运行时不可达')
    return
  }
  if (!tools || !tools.result || !Array.isArray(tools.result.tools)) {
    fail('MCP 桥', 'initialize/tools/list 握手失败')
    return
  }
  ok('MCP 桥', `握手成功 · ${tools.result.tools.length} 个工具`)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function checkApp(name, file, extractor) {
  if (!fs.existsSync(file)) {
    warn(name, `未发现配置文件 ${file}（未安装或未配置）`)
    return
  }
  const found = extractor()
  if (found) ok(name, found)
  else warn(name, `配置文件存在，但没找到 shared-memory 配置：${file}`)
}

async function main() {
  add('运行环境', 'OK', `Node ${process.version} · ${process.platform} · ${process.execPath}`)
  await checkRuntime()
  await checkBridge()
  checkApp('Cursor', path.join(HOME, '.cursor', 'mcp.json'), () => {
    const json = readJson(path.join(HOME, '.cursor', 'mcp.json'))
    const servers = json && json.mcpServers
    return servers && servers['shared-memory'] ? `mcpServers.shared-memory → ${servers['shared-memory'].command}` : ''
  })
  checkApp('Codex / ChatGPT 桌面', path.join(HOME, '.codex', 'config.toml'), () => {
    const raw = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8')
    return raw.includes('shared-memory') ? 'config.toml 含 [mcp_servers.shared-memory]' : ''
  })
  checkApp('Claude Desktop', path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), () => {
    const json = readJson(path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
    const servers = json && json.mcpServers
    return servers && servers['shared-memory'] ? `mcpServers.shared-memory → ${servers['shared-memory'].command}` : ''
  })
  checkApp('WorkBuddy', path.join(HOME, '.workbuddy', 'skills', 'shared-memory', 'SKILL.md'), () => {
    const raw = fs.readFileSync(path.join(HOME, '.workbuddy', 'skills', 'shared-memory', 'SKILL.md'), 'utf8')
    return raw.includes('shared-memory') ? 'skill 已安装' : ''
  })

  const width = Math.max(...rows.map((row) => row.name.length)) + 2
  console.log('\n共享记忆接入自检\n')
  for (const row of rows) {
    console.log(`${row.status.padEnd(5)} ${row.name.padEnd(width)} ${row.detail}`)
  }
  const failed = rows.filter((row) => row.status === 'FAIL').length
  console.log(`\n${failed ? '存在失败项，请按上面提示修复。' : '全部检查通过。'}\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
