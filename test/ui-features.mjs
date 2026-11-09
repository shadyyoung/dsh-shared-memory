/**
 * UI feature contract test: dashboard stats, duplicate detection, bulk actions
 * and the shipped UI shell. Run with `node test/ui-features.mjs`.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { apply } from '../index.js'

const storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shared-memory-ui-'))
let routeHandler
const server = http.createServer((req, res) => {
  if (routeHandler) void routeHandler(req, res)
  else {
    res.statusCode = 503
    res.end('no handler')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const tools = new Map()
const ctx = {
  effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  on() { return () => {} },
  get() { return undefined },
  tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  systemPrompt: { section: () => () => {} },
  webServer: {
    register(route) { routeHandler = route.handler; return () => { routeHandler = undefined } },
    getOrigin: () => origin,
  },
}

apply(ctx, {
  storeDir,
  captureUserMessages: true,
  promptDigest: false,
  apiEnabled: true,
  apiPath: '/dsh-memory',
  apiToken: '',
  backupDir: path.join(storeDir, 'backups'),
  autoBackupHours: 0,
  autoExtract: 'rules',
  maxExtractPerDay: 50,
  writeHumanDigest: false,
})

const call = async (pathname, init) => {
  const response = await fetch(origin + '/dsh-memory' + pathname, init)
  const text = await response.text()
  let body = text
  try { body = JSON.parse(text) } catch {}
  return { status: response.status, body }
}
const post = (pathname, payload) => call(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
const json = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

// A/B share one text with different kinds → exact duplicate group.
// C is a near-duplicate of A.
const noteA = await post('/api/remember', { text: '本周要完成共享记忆插件的 UI 改版', kind: 'note', tags: ['ui', 'plan'] })
const projectB = await post('/api/remember', { text: '本周要完成共享记忆插件的 UI 改版', kind: 'project', tags: ['ui'] })
const noteC = await post('/api/remember', { text: '本周要完成共享记忆插件的 UI 改版工作', kind: 'note', tags: ['ui'] })
assert.equal(noteA.status, 200)
assert.equal(projectB.status, 200)
assert.equal(noteC.status, 200)
const idA = noteA.body.item.id
const idB = projectB.body.item.id
const idC = noteC.body.item.id

// ---- /api/stats ---------------------------------------------------------
const stats = await call('/api/stats')
assert.equal(stats.status, 200)
assert.ok(stats.body.memories >= 3, 'stats counts memories')
assert.deepEqual(
  Object.keys(stats.body).filter((key) => ['byKind', 'series', 'topTags', 'topUsed', 'memories', 'messages', 'trash', 'sessions', 'candidates'].includes(key)).sort(),
  ['byKind', 'candidates', 'memories', 'messages', 'series', 'sessions', 'topTags', 'topUsed', 'trash'].sort(),
)
assert.equal(stats.body.series.length, 14, '14-day series by default')
assert.ok(stats.body.series.at(-1).count >= 3, 'today captures counted')
assert.ok(stats.body.byKind.note >= 2 && stats.body.byKind.project >= 1, 'kind histogram')
assert.ok(stats.body.topTags.some((tag) => tag.tag === 'ui' && tag.count >= 3), 'tag histogram')
const customSeries = await call('/api/stats?days=7')
assert.equal(customSeries.body.series.length, 7)

// ---- /api/duplicates ----------------------------------------------------
const duplicates = await call('/api/duplicates')
assert.equal(duplicates.status, 200)
assert.ok(duplicates.body.scanned >= 3)
assert.ok(duplicates.body.exact.length >= 1, 'exact duplicate group found')
const exactGroup = duplicates.body.exact.find((group) => group.items.some((item) => item.id === idA))
assert.ok(exactGroup, 'exact group contains the note')
assert.ok(exactGroup.items.some((item) => item.id === idB), 'exact group contains both kinds')
const loose = await call('/api/duplicates?minSimilarity=0.5')
assert.ok(loose.body.near.length >= 1, 'near duplicate pair found')
assert.ok(loose.body.near[0].similarity >= 0.5 && loose.body.near[0].similarity <= 1)
assert.doesNotMatch(JSON.stringify(loose.body.near), /本条记忆|undefined/, 'duplicates payload is clean')

// ---- /api/bulk ----------------------------------------------------------
const retag = await post('/api/bulk', { ids: [idA, idC], action: 'retag', tags: ['bulk', 'ui'] })
assert.equal(retag.status, 200)
assert.equal(retag.body.updated, 2)
const tagged = await call('/api/items?tag=bulk')
assert.equal(tagged.body.total, 2, 'retag applied to both items')

const setKind = await post('/api/bulk', { ids: [idA], action: 'kind', kind: 'task' })
assert.equal(setKind.body.updated, 1)
const tasks = await call('/api/items?kind=task')
assert.ok(tasks.body.items.some((item) => item.id === idA), 'kind change applied')

const forget = await post('/api/bulk', { ids: [idA, idB], action: 'forget' })
assert.equal(forget.body.deleted, 2)
const trash = await call('/api/items?deleted=1&limit=100')
assert.ok(trash.body.items.some((item) => item.id === idA))
assert.ok(trash.body.items.some((item) => item.id === idB))

const restored = await post('/api/bulk', { ids: [idA], action: 'restore' })
assert.equal(restored.body.restored, 1)
const afterRestore = await call('/api/items?deleted=1&limit=100')
assert.ok(!afterRestore.body.items.some((item) => item.id === idA), 'restored item leaves trash')

const purged = await post('/api/bulk', { ids: [idB], action: 'purge' })
assert.equal(purged.body.deleted, 1)
const afterPurge = await call('/api/items?deleted=1&limit=100&includeDeleted=1')
assert.ok(!afterPurge.body.items.some((item) => item.id === idB), 'purged item is gone')

assert.equal((await post('/api/bulk', { ids: [], action: 'forget' })).status, 400)
assert.equal((await post('/api/bulk', { ids: [idC], action: 'explode' })).status, 400)
assert.equal((await post('/api/bulk', { ids: [idC], action: 'kind', kind: 'nope' })).status, 400)

// ---- API discovery + UI shell ------------------------------------------
const root = await call('/')
for (const route of ['GET /api/stats', 'GET /api/duplicates', 'POST /api/bulk']) {
  assert.ok(root.body.endpoints.includes(route), `discovery lists ${route}`)
}

const ui = await call('/ui')
assert.equal(ui.status, 200)
const html = typeof ui.body === 'string' ? ui.body : ''
for (const marker of ['概览', '重复检测', '批量选择', '待确认', 'data-theme', '/api/stats', '/api/duplicates', '/api/bulk', 'prefers-reduced-motion']) {
  assert.ok(html.includes(marker), `UI contains ${marker}`)
}
assert.ok(html.length > 20000, 'UI is a full single-file app')
assert.doesNotMatch(html, /onclick="fetch\(/, 'no inline event handlers with user data')

console.log('ok ui features: stats, duplicates, bulk actions, discovery and UI shell')
server.close()
process.exit(0)
