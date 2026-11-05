/**
 * Tool-output contract test: reproduces the DeepSeek Harness rules every tool
 * result must satisfy before the model can see it.
 *
 *  1. `snapshotJsonValue` — the value must be lossless JSON: no `undefined`,
 *     no non-finite number, plain objects/arrays only.
 *  2. `validateJsonSchemaValue` — the strict schema subset, including
 *     `required`, `properties`, `items`, `oneOf` and `additionalProperties: false`.
 *  3. The same snapshot rule applies to whatever `output.render` returns.
 *
 * Those rules are why store records must not leak optional `undefined` fields
 * or bookkeeping keys into a tool value. Run with
 * `node test/tool-output-contract.mjs`.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { apply } from '../index.js'

/** Mirror of the host's walkJsonValue: reject anything JSON cannot carry. */
function snapshot(value) {
  const seen = new Set()
  const walk = (entry) => {
    if (entry === null) return { ok: true, value: null }
    const type = typeof entry
    if (type === 'string' || type === 'boolean') return { ok: true, value: entry }
    if (type === 'number') return Number.isFinite(entry) && !Object.is(entry, -0) ? { ok: true, value: entry } : { ok: false }
    if (type !== 'object') return { ok: false }
    if (seen.has(entry)) return { ok: false }
    if (Array.isArray(entry)) {
      if (Object.getPrototypeOf(entry) !== Array.prototype) return { ok: false }
      if (Reflect.ownKeys(entry).length !== entry.length + 1) return { ok: false }
      seen.add(entry)
      const out = []
      for (const item of entry) {
        const result = walk(item)
        if (!result.ok) return { ok: false }
        out.push(result.value)
      }
      return { ok: true, value: out }
    }
    const prototype = Object.getPrototypeOf(entry)
    if (prototype !== Object.prototype && prototype !== null) return { ok: false }
    seen.add(entry)
    const out = {}
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) return { ok: false }
      const result = walk(entry[key])
      if (!result.ok) return { ok: false }
      out[key] = result.value
    }
    return { ok: true, value: out }
  }
  return walk(value)
}

/** Mirror of the host's checkValue over the strict value-schema subset. */
function validate(schema, value, at = 'value', violations = []) {
  if (schema && Array.isArray(schema.oneOf)) {
    let matches = 0
    for (const branch of schema.oneOf) {
      const local = []
      validate(branch, value, at, local)
      if (local.length === 0) matches++
    }
    if (matches !== 1) violations.push(`${at} must match exactly one oneOf branch (matched ${matches})`)
    return violations
  }
  if (!schema || typeof schema !== 'object') return violations
  const type = schema.type
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${at} must be an object`)
      return violations
    }
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`missing required property "${at}.${key}"`)
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue
      validate(child, value[key], `${at}.${key}`, violations)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) violations.push(`"${at}.${key}" is not a declared property (additionalProperties: false)`)
    }
    return violations
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${at} must be an array`)
      return violations
    }
    if (schema.items !== undefined) value.forEach((entry, index) => validate(schema.items, entry, `${at}[${index}]`, violations))
    return violations
  }
  if (type === 'string') {
    if (typeof value !== 'string') violations.push(`${at} must be a string`)
    else if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${at} must be one of the enum`)
    return violations
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') violations.push(`${at} must be a boolean`)
    return violations
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${at} must be a finite number`)
    else if (type === 'integer' && !Number.isInteger(value)) violations.push(`${at} must be an integer`)
    return violations
  }
  if (type === 'null') {
    if (value !== null) violations.push(`${at} must be null`)
    return violations
  }
  return violations
}

const storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shared-memory-contract-'))
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
const listeners = new Map()
const ctx = {
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on(event, listener) {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
  get() {
    return undefined
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  systemPrompt: { section: () => () => {} },
  webServer: {
    register(route) {
      routeHandler = route.handler
      return () => {
        routeHandler = undefined
      }
    },
    getOrigin: () => origin,
  },
}

apply(ctx, {
  storeDir,
  captureUserMessages: true,
  promptDigest: true,
  maxDigestChars: 1200,
  maxStoredMessages: 100,
  apiEnabled: true,
  apiPath: '/dsh-memory',
  apiToken: '',
  backupDir: path.join(storeDir, 'backups'),
  autoBackupHours: 0,
  autoExtract: 'rules',
  maxExtractPerDay: 50,
  autoFocusMinutes: 90,
  writeHumanDigest: true,
})

const exec = { signal: new AbortController().signal }
const checked = []

/** Run one tool and assert its value + rendered content satisfy the host contract. */
async function checkToolOutput(name, args = {}) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} registered`)
  const raw = await definition.execute(args, exec)
  const value = snapshot(raw)
  assert.ok(value.ok, `${name}: value is not lossless JSON`)
  const violations = validate(definition.output.schema, value.value)
  assert.deepEqual(violations, [], `${name}: invalid output: ${violations.join('; ')}`)
  const rendered = snapshot(definition.output.render(args, value.value))
  assert.ok(rendered.ok, `${name}: render output is not lossless JSON`)
  checked.push(name)
  return value.value
}

// Seed an activity entry the way a live session does: its optional fields are
// absent, which is exactly the shape that used to break the snapshot.
const session = { id: 'sess_contract_1', header: { id: 'sess_contract_1', cwd: '/tmp/contract-demo' } }
listeners.get('session/event')?.(session, { type: 'user/message', data: { content: '输出契约测试：先记住一条记忆', source: { kind: 'user' } } })

const remembered = await checkToolOutput('memory_remember', { text: '输出契约测试 alpha 记录', kind: 'note', tags: ['contract'] })
await checkToolOutput('memory_search', { q: '输出契约测试', limit: 5 })
await checkToolOutput('memory_search', { kind: 'message', limit: 3 })
await checkToolOutput('memory_current', {})
await checkToolOutput('memory_current', { focus: '校验工具输出契约', nextSteps: ['跑一遍所有记忆工具'] })
await checkToolOutput('memory_update', { id: remembered.item.id, text: '输出契约测试 alpha 记录（已改）' })
await checkToolOutput('memory_forget', { id: remembered.item.id })
await checkToolOutput('memory_restore', { id: remembered.item.id })
await checkToolOutput('memory_forget', { q: '输出契约测试', purge: true })
await checkToolOutput('memory_current', { clear: true })

console.log(`ok tool outputs satisfy the host contract: ${[...new Set(checked)].join(', ')}`)
server.close()
process.exit(0)
