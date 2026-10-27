#!/usr/bin/env node
/**
 * Standalone memory hub (no DeepSeek Harness required).
 *
 * Runs the same SharedMemoryStore + HTTP API as the Harness plugin, in a plain
 * Node.js process. Any AI app that can speak MCP (via the bundled bridge) or
 * HTTP can then read and write the same memory store.
 *
 *   node standalone/server.mjs                 # http://127.0.0.1:7400/dsh-memory
 *   node standalone/server.mjs --port 7400 --host 127.0.0.1
 *   node standalone/server.mjs --store ~/.dsh/shared-memory --token secret
 *
 * It writes `runtime.json` next to the store so the MCP bridge discovers the
 * address automatically. Run EITHER this hub OR the DeepSeek Harness plugin
 * against one store directory — never both at the same time.
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SharedMemoryStore, resolveConfig, createApiHandler, PLUGIN_NAME, VERSION } from '../index.js'

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `Shared Memory standalone hub v${VERSION}

Usage: node standalone/server.mjs [options]

Options:
  -p, --port <port>       listen port (default 7400; 0 = random free port)
      --host <host>       bind address (default 127.0.0.1)
      --store <dir>       store directory (default ~/.dsh/shared-memory)
      --path <path>       HTTP route prefix (default /dsh-memory)
      --token <token>     require Authorization: Bearer <token> on /api/*
      --backup-dir <dir>  backup directory (default ~/.dsh/shared-memory-backups)
  -h, --help              show this help

Environment:
  SHARED_MEMORY_PORT, SHARED_MEMORY_HOST, SHARED_MEMORY_STORE, SHARED_MEMORY_TOKEN, SHARED_MEMORY_BACKUP_DIR

Note: run either this hub or the DeepSeek Harness plugin for a given store
directory, not both at once (single-writer assumption).
`

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${token} requires a value`)
      return next
    }
    if (token === '-h' || token === '--help') args.help = true
    else if (token === '-p' || token === '--port') args.port = value()
    else if (token === '--host') args.host = value()
    else if (token === '--store') args.store = value()
    else if (token === '--path') args.path = value()
    else if (token === '--token') args.token = value()
    else if (token === '--backup-dir') args.backupDir = value()
    else if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=', 2)
      if (inline !== undefined) {
        args[key] = inline
      } else {
        throw new Error(`unknown option: ${token}`)
      }
    } else {
      throw new Error(`unexpected argument: ${token}`)
    }
  }
  return args
}

/** Print a diagnostic line to stderr (stdout stays machine-readable). */
function log(message) {
  try {
    console.error(`[shared-memory] ${message}`)
  } catch {
    // stderr may be closed; the hub keeps running.
  }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    log(error.message)
    process.stderr.write(USAGE)
    process.exit(2)
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }

  const host = args.host ?? process.env.SHARED_MEMORY_HOST ?? '127.0.0.1'
  const port = Number(args.port ?? process.env.SHARED_MEMORY_PORT ?? 7400)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log(`invalid port: ${args.port}`)
    process.exit(2)
  }

  const config = resolveConfig({
    storeDir: args.store ?? process.env.SHARED_MEMORY_STORE,
    apiPath: args.path ?? '/dsh-memory',
    apiToken: args.token ?? process.env.SHARED_MEMORY_TOKEN ?? '',
    backupDir: args.backupDir ?? process.env.SHARED_MEMORY_BACKUP_DIR,
    // The hub has no Harness session events to capture and no prompt to inject.
    captureUserMessages: false,
    promptDigest: false,
    apiEnabled: true,
    writeHumanDigest: true,
  })

  const store = new SharedMemoryStore(config)
  await store.ready
  await store.materializeBridge(PACKAGE_DIR)
  await store.writeReadme()

  const diagnostics = []
  const diag = (error) => {
    const message = error instanceof Error ? error.message : String(error)
    diagnostics.push(message)
    if (diagnostics.length > 20) diagnostics.shift()
    log(message)
  }

  const handler = createApiHandler(store, config, diag)
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      diag(error)
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: { code: 'ERROR', message: String(error) } }))
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is already in use; pass --port <other>`))
        return
      }
      reject(error)
    })
    server.listen(port, host, resolve)
  })

  const bound = server.address()
  const actualPort = bound && typeof bound === 'object' ? bound.port : port
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const origin = `http://${displayHost}:${actualPort}`
  const apiBase = origin + config.apiPath

  const stopAutoBackup = store.startAutoBackup()
  await store.writeRuntime({ apiBase, origin, token: config.apiToken || null })
  await store.writeToken(config.apiToken)
  await store.writeHumanDigest()

  // Machine-readable handshake on stdout (used by scripts and the smoke test).
  process.stdout.write(
    JSON.stringify({
      event: 'listening',
      name: PLUGIN_NAME,
      version: VERSION,
      apiBase,
      storeDir: store.dir,
      pid: process.pid,
    }) + '\n',
  )

  log(`v${VERSION} listening on ${apiBase}`)
  log(`store: ${store.dir}`)
  log(`MCP bridge: node ${path.join(store.dir, 'mcp-server.mjs')}`)
  if (config.apiToken) log('bearer token required on /api/*')

  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    log(`${signal} received, flushing store`)
    if (typeof stopAutoBackup === 'function') stopAutoBackup()
    await new Promise((resolve) => server.close(() => resolve()))
    try {
      await store.flush()
      await store.writeHumanDigest()
    } catch (error) {
      log(`flush failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
