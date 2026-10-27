/**
 * Standalone hub smoke test (no DeepSeek Harness required).
 *
 * Starts `standalone/server.mjs` on a random port with a temp store, drives the
 * HTTP API, then verifies the bundled MCP bridge can read through it.
 * Run with `node test/standalone-smoke.mjs`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-standalone-'))
const serverPath = path.join(ROOT, 'standalone', 'server.mjs')
const bridgePath = path.join(ROOT, 'mcp', 'server.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Start the hub and wait for its JSON listening line. */
async function startHub() {
  const child = spawn(process.execPath, [serverPath, '--port', '0', '--store', storeDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))

  const startedAt = Date.now()
  while (Date.now() - startedAt < 15000) {
    const line = stdout.split('\n').find((entry) => entry.includes('"listening"'))
    if (line) {
      const info = JSON.parse(line)
      assert.equal(info.event, 'listening')
      assert.match(info.apiBase, /^http:\/\/127\.0\.0\.1:\d+\/dsh-memory$/)
      return { child, info, log: () => ({ stdout, stderr }) }
    }
    if (child.exitCode !== null) {
      throw new Error(`hub exited early (${child.exitCode})\nstdout: ${stdout}\nstderr: ${stderr}`)
    }
    await sleep(50)
  }
  child.kill()
  throw new Error(`hub did not start in time\nstdout: ${stdout}\nstderr: ${stderr}`)
}

/** Run one MCP tool call through the bundled bridge against a live hub. */
function callBridgeTool(apiBase, tool, args = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, DSH_MEMORY_URL: apiBase },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
      }) + '\n',
    )
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n')
    child.stdin.end()
    child.on('close', (code) => {
      try {
        const replies = stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        const reply = replies.find((entry) => entry.id === 2)
        assert.ok(reply, `no reply from bridge\nstdout: ${stdout}\nstderr: ${stderr}`)
        assert.ok(reply.result, `bridge error: ${JSON.stringify(reply.error)}`)
        resolve(reply.result)
      } catch (error) {
        reject(error)
      }
    })
  })
}

const { child, info } = await startHub()
const base = info.apiBase
const api = async (suffix, init) => {
  const response = await fetch(base + suffix, init)
  return { status: response.status, body: await response.json() }
}
const post = (suffix, body) =>
  api(suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

try {
  // 1. health
  const health = await api('/health')
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)
  assert.equal(health.body.name, 'dsh-shared-memory')
  console.log('ok health:', health.body.version)

  // 2. write + search
  const remembered = await post('/api/remember', {
    text: 'standalone hub smoke test memory',
    kind: 'note',
    tags: ['selftest'],
    source: { app: 'standalone-test' },
  })
  assert.equal(remembered.status, 200)
  assert.equal(remembered.body.item.source.app, 'standalone-test')
  const id = remembered.body.item.id

  const search = await api('/api/search?q=standalone%20hub')
  assert.equal(search.body.total, 1)
  assert.equal(search.body.items[0].id, id)
  console.log('ok http write + search')

  // 3. focus + digest
  const focus = await post('/api/current', { focus: 'standalone smoke', nextSteps: ['bridge check'] })
  assert.equal(focus.body.focus.text, 'standalone smoke')
  const digest = await api('/api/digest?maxChars=800')
  assert.match(digest.body.text, /## 共享记忆/)
  assert.ok(digest.body.text.length <= 800)
  console.log('ok focus + digest')

  // 3b. update + UI + export
  const updated = await post('/api/update', { id, text: 'standalone hub edited', kind: 'project', tags: ['edited'] })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.item.text, 'standalone hub edited')
  assert.equal(updated.body.item.kind, 'project')
  const uiResponse = await fetch(base + '/ui')
  assert.equal(uiResponse.status, 200)
  assert.match(await uiResponse.text(), /共享记忆/)
  const exportResponse = await fetch(base + '/api/export')
  assert.equal(exportResponse.status, 200)
  assert.match(await exportResponse.text(), /standalone hub edited/)
  const page = await api('/api/items?limit=1&offset=0')
  assert.equal(page.body.limit, 1)
  console.log('ok update + UI + export')

  // 3c. soft delete + restore
  const trashed = await post('/api/forget', { id })
  assert.equal(trashed.status, 200)
  assert.equal(trashed.body.mode, 'trash')
  const trashPage = await api('/api/items?deleted=1')
  assert.ok(trashPage.body.items.some((entry) => entry.id === id))
  const restored = await post('/api/restore', { id })
  assert.equal(restored.status, 200)
  assert.equal(restored.body.restored, true)
  console.log('ok soft delete + restore')

  // 4. MCP bridge against the same hub
  const status = await callBridgeTool(base, 'memory_status')
  assert.equal(status.isError, false)
  assert.match(status.content[0].text, /共享记忆服务运行中/)
  const bridged = await callBridgeTool(base, 'memory_search', { q: 'standalone hub' })
  assert.equal(bridged.isError, false)
  assert.match(bridged.content[0].text, /standalone hub edited/)
  console.log('ok MCP bridge against standalone hub')

  // 5. discovery file
  const runtime = JSON.parse(await fsp.readFile(path.join(storeDir, 'runtime.json'), 'utf8'))
  assert.equal(runtime.apiBase, base)
  assert.equal(runtime.name, 'dsh-shared-memory')
  console.log('ok runtime.json discovery')
} finally {
  child.kill()
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('close', resolve)
    setTimeout(resolve, 3000)
  })
  await fsp.rm(storeDir, { recursive: true, force: true })
}

console.log('\nAll standalone hub smoke tests passed.')
