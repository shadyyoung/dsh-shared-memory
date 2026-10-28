<p align="center">
  <a href="https://github.com/shadyyoung/dsh-shared-memory/releases">
    <img src="docs/assets/banner.svg" alt="Shared Memory" width="100%">
  </a>
</p>

<h1 align="center">Shared Memory · AI Cross-Platform Memory Enhancement</h1>

<p align="center">
  <b>One memory, shared by every AI app.</b><br>
  Preferences, projects and "what I'm doing right now" — across sessions, workspaces and applications.
</p>

<p align="center">
  <a href="https://github.com/shadyyoung/dsh-shared-memory/releases"><img src="https://img.shields.io/github/v/release/shadyyoung/dsh-shared-memory?label=release&color=8b5cf6" alt="Release"></a>
  <a href="https://github.com/shadyyoung/dsh-shared-memory/actions/workflows/ci.yml"><img src="https://github.com/shadyyoung/dsh-shared-memory/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white" alt="Node >= 18">
  <img src="https://img.shields.io/badge/MCP-stdio-16a34a" alt="MCP stdio">
</p>

<p align="center">
  <a href="docs/API.md">API</a> ·
  <a href="docs/HOW-IT-WORKS.md">How it works</a> ·
  <a href="docs/CONNECT-APPS.md">Connect apps</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.md">中文</a>
</p>

---

## What it is

A **local-first shared memory layer**, shipped as a **DeepSeek Harness plugin** with a **zero-dependency MCP stdio bridge** and an **HTTP API**. Cursor, Claude Desktop, ChatGPT desktop (Codex), WorkBuddy and plain scripts read and write the same memory.

| | Feature | What it does |
|---|---|---|
| 🎯 | **Auto capture** | Every user message, current focus and session activity is stored |
| 🧠 | **Auto extraction** | Pulls durable facts (preference/identity/goal/project) into a **pending inbox** — only accepted items become memories |
| 🔍 | **BM25 search** | Inverted index over CJK bigrams, latin words and tags; relevance ranking |
| 💉 | **Relevant injection** | Each model request gets a ≤1200-char digest plus memories ranked against the current topic |

> [!NOTE]
> It is **not** an Agent Skill. The skill is only a client adapter; the actual service is the DSH plugin or the standalone hub, reached over MCP or HTTP.

> [!IMPORTANT]
> **Single writer**: never run the DSH plugin and the standalone hub against the same store at once.

## UI

<p align="center">
  <img src="docs/assets/ui.png" alt="Web UI: focus, backups, memory list, pending inbox, trash" width="100%">
</p>

Open `/dsh-memory/ui` (the port changes with every Harness restart — resolve it from `~/.dsh/shared-memory/runtime.json` or run `~/.dsh/shared-memory/open-ui.sh`).

## Quick start

### A. Install into DeepSeek Harness (recommended)

```bash
git clone https://github.com/shadyyoung/dsh-shared-memory.git
```

```text
plugin_manager: install_bundle  target=/abs/path/dsh-shared-memory
cordis_inspect_query: Tool.listTools   # expect memory_remember / memory_search / …
```

> [!TIP]
> Restart Harness after editing plugin source — HMR-registered schemas can differ from a cold start.

### B. Make other AI apps "ready on open"

```bash
cd dsh-shared-memory
npm run install-apps    # detect + configure Cursor / Claude Desktop / Codex / Claude Code / WorkBuddy (MCP + skill)
npm run autostart       # optional (macOS): open DSH at login so the service stays online
npm run doctor          # verify service, MCP handshake and every app config
```

- Existing configs are backed up before edits.
- Running apps must be **fully quit (`Cmd+Q`) and reopened** to load MCP — an app limitation.
- `npm run autostart:uninstall` removes the login item.

### C. Standalone hub (no DSH, cross-platform)

```bash
node standalone/server.mjs                       # http://127.0.0.1:7400/dsh-memory
node standalone/server.mjs --port 7400 --store ~/.dsh/shared-memory
```

Storage, search, HTTP and MCP — but no session capture or prompt injection.

## Integrations

| App | Transport | R/W | Config |
|---|---|---|---|
| DeepSeek Harness | built-in plugin | ✅ | auto capture + injection + 6 tools |
| Cursor | MCP stdio | ✅ | `~/.cursor/mcp.json` |
| Claude Desktop | MCP stdio | ✅ | `claude_desktop_config.json` |
| Claude Code | MCP stdio | ✅ | `~/.claude.json` |
| ChatGPT desktop (Codex) | MCP stdio | ✅ | `~/.codex/config.toml` |
| WorkBuddy | MCP stdio + skill | ✅ | `~/.workbuddy/mcp.json` (trust the local MCP once) |
| Any script / browser | HTTP | ✅ | `/dsh-memory/api/*` |
| ChatGPT web | ❌ | — | remote connectors only |

## Tools

**DSH tools (6)**: `memory_remember` · `memory_search` · `memory_forget` · `memory_update` · `memory_restore` · `memory_current`
**MCP tools (7)**: the same six + `memory_digest` · `memory_status`

`memory_forget` soft-deletes to trash by default (`purge: true` to erase); `memory_update` keeps an edit history; `memory_restore` brings records back.

## HTTP API (summary)

Full contract: [docs/API.md](docs/API.md). Prefix `/dsh-memory`:

`/health` · `/api/digest` · `/api/search` · `/api/items` · `/api/current` · `/api/remember` · `/api/forget` · `/api/restore` · `/api/purge-trash` · `/api/update` · `/api/candidates/*` · `/api/import` · `/api/backups` · `/api/backup` · `/api/restore-backup` · `/api/export` · `/ui`

## Configuration

Edit [cordis.patch.yml](cordis.patch.yml) and reload the bundle.

| Key | Default | Meaning |
|---|---|---|
| `storeDir` | `~/.dsh/shared-memory` | Data directory |
| `captureUserMessages` | `true` | Capture root-session user messages |
| `messageRetentionDays` | `30` | Raw-message retention (0 = forever) |
| `maxStoredMessages` | `3000` | Raw-message cap |
| `promptDigest` | `true` | Inject the digest every step |
| `maxDigestChars` | `1200` | Digest budget |
| `maxRelevantMemories` | `4` | Related-memory lines (0 = off) |
| `autoFocusMinutes` | `90` | Auto-focus refresh (0 = off) |
| `trashRetentionDays` | `30` | Trash retention |
| `maxRevisions` | `20` | Edit-history versions |
| `backupDir` | `~/.dsh/shared-memory-backups` | Backups outside the store; point it at iCloud/Dropbox for offsite |
| `backupKeep` | `14` | Backups kept |
| `autoBackupHours` | `24` | Auto-backup interval |
| `autoExtract` | `rules` | `off` / `rules` (free) / `llm` |
| `extractModel` | empty | Provider/model for LLM extraction (default model when empty) |
| `maxExtractPerDay` | `30` | Daily LLM budget |
| `piiPolicy` | `redact` | `off` / `warn` / `redact` |

## Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Architecture" width="100%">
</p>

`session/event` → capture/extract → `memories.jsonl` (+ index) → digest / tools / HTTP → other apps. Backups live outside the store (24h snapshots, 14 kept, plus a `before-restore` snapshot). See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Tests & CI

```bash
node test/host-smoke.mjs
node test/mcp-smoke.mjs
node test/standalone-smoke.mjs
node test/search-bench.mjs
npm run doctor
```

GitHub Actions runs the matrix on ubuntu / macos / windows × Node 20/22.

## Repository layout

```text
index.js                 # host plugin (store/capture/extract/inject/tools/HTTP/UI)
cordis.patch.yml         # bundle declaration + defaults
standalone/server.mjs    # standalone hub
ui/index.html            # single-file web UI
mcp/server.mjs           # zero-dependency MCP stdio bridge
skills/shared-memory/    # agent skill (WorkBuddy etc.)
scripts/                 # install-apps · autostart · doctor
docs/                    # API · HOW-IT-WORKS · CONNECT-APPS · assets
test/                    # host · mcp · standalone · bench
```

## License

[MIT](LICENSE)
