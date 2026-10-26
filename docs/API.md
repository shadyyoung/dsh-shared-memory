# AI 跨平台记忆增强 (Shared Memory) — 冻结接口约定 v1

本文件是 Host 插件、MCP 桥、其他 AI 应用共同遵守的契约。改动前先改本文件。

## 1. 存储布局（全局，跨会话跨应用）

默认目录：`~/.dsh/shared-memory/`（可由插件 config `storeDir` 覆盖）

| 文件 | 内容 |
|---|---|
| `memories.jsonl` | 一行一条 JSON 记忆记录（追加写，唯一写者 = DSH Host 插件） |
| `focus.json` | 当前焦点：`{ text, nextSteps: string[], updatedAt, updatedBy, auto }` |
| `activity.json` | 每个根会话的动态：`{ "<sessionId>": Activity }` |
| `runtime.json` | Host 插件激活时写入，供 MCP 桥发现地址 |
| `digest.md` | 人类可读快照（插件定期重写） |
| `mcp-server.mjs` | 插件激活时复制出来的 MCP 桥（stdio） |
| `README.md` | 连接说明（插件激活时写入） |
| `token` | 仅当 config `apiToken` 非空时写入 |

### Memory 记录

```json
{
  "id": "mem_<uuid>",
  "kind": "note | profile | preference | goal | project | task | message",
  "text": "记忆正文",
  "tags": ["tag"],
  "source": { "app": "dsh | mcp | http | <app名>", "sessionId": "...", "cwd": "..." },
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000
}
```

- `message` 为自动捕获的用户消息（`text` 为纯文本，最多 8000 字符）。
- 相同 `kind + text` 的写入视为重复，返回已存在记录并带 `deduped: true`。

### Activity

```json
{
  "sessionId": "...",
  "cwd": "/abs/path",
  "app": "dsh",
  "lastUser": "最近一条用户消息（截断 400 字符）",
  "lastAssistant": "最近一条助手回复（截断 400 字符）",
  "messageCount": 12,
  "updatedAt": 1700000000000
}
```

### runtime.json

```json
{
  "name": "dsh-shared-memory",
  "version": "1.1.0",
  "apiBase": "http://127.0.0.1:62877/dsh-memory",
  "origin": "http://127.0.0.1:62877",
  "storeDir": "/Users/<user>/.dsh/shared-memory",
  "pid": 12345,
  "startedAt": 1700000000000,
  "token": null
}
```

## 2. HTTP API

Base：`runtime.json.apiBase`，即 `{origin}/dsh-memory`。

- 响应一律 `application/json; charset=utf-8`。
- 错误：`{ "error": { "code": "BAD_REQUEST", "message": "..." } }`，状态码 400/401/404/405/500。
- 鉴权：仅当插件 config `apiToken` 非空时，`/api/*` 需要
  `Authorization: Bearer <token>` 或 `?token=<token>`；`/health` 永远开放。失败返回 401。
- CORS：`Access-Control-Allow-Origin: *`；`OPTIONS` 返回 204。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康与统计 |
| GET | `/api/digest?maxChars=1500` | 模型可直接用的 Markdown 摘要 |
| GET | `/api/search?q=&kind=&tag=&limit=&days=&session=` | 搜索 |
| GET | `/api/recent?limit=20` | 最近记忆（等价 search 无 q） |
| GET | `/api/current` | 焦点 + 最近会话动态 + 最近记忆 |
| GET | `/api/activity?limit=10` | 最近会话动态 |
| POST | `/api/remember` | 新增记忆 |
| POST | `/api/forget` | 删除记忆 |
| POST | `/api/current` | 设置/清除焦点 |

### GET /health

```json
{
  "ok": true,
  "name": "dsh-shared-memory",
  "version": "1.1.0",
  "startedAt": 1700000000000,
  "storeDir": "/Users/.../.dsh/shared-memory",
  "stats": { "memories": 42, "messages": 30, "sessions": 3, "hasFocus": true }
}
```

### GET /api/digest

`{ "text": "## 共享记忆...", "generatedAt": 1700000000000 }`

`maxChars` 默认 1500，范围 200–8000。

### GET /api/search

参数：`q`（大小写不敏感的子串，匹配 text/tags）、`kind`（可重复或逗号分隔）、
`tag`、`limit`（默认 20，最大 100）、`days`（只返回最近 N 天）、`session`（精确匹配 source.sessionId）。

```json
{ "items": [Memory], "total": 3, "query": "..." }
```

按 `createdAt` 倒序。`q` 为空时即“最近记忆”。

### GET /api/current

```json
{
  "focus": { "text": "...", "nextSteps": ["..."], "updatedAt": 0, "updatedBy": "dsh", "auto": true },
  "activity": [Activity],
  "recent": [Memory]
}
```

`focus` 可能为 `null`；`activity` 最多 10 条、按 `updatedAt` 倒序；`recent` 不含 `message` 类，最多 10 条。

### GET /api/activity

```json
{ "activity": [Activity] }
```

### POST /api/remember

```json
{ "text": "用户喜欢直接给结论", "kind": "preference", "tags": ["写作"], "source": { "app": "claude" } }
```

`text` 必填（1–8000），`kind` 缺省 `note`，`tags` 最多 20 个，`source.app` 缺省 `http`。
返回 `{ "item": Memory, "deduped": false }`。

### POST /api/forget

```json
{ "id": "mem_..." }
```
或
```json
{ "q": "旧手机号", "kind": "profile", "before": 1700000000000 }
```

`id` 与 `q` 二选一。返回 `{ "deleted": 1, "ids": ["mem_..."] }`。

### POST /api/current

```json
{ "focus": "完成共享记忆插件 v1", "nextSteps": ["安装", "验证"] }
```

`clear: true` 清除焦点。至少提供其中一个字段。返回 `{ "focus": ... }`。

## 3. MCP 桥（其他 AI 应用接入）

- 文件：`~/.dsh/shared-memory/mcp-server.mjs`，通过 `node <该文件>` 以 stdio 启动。
- 传输：stdin/stdout 逐行 JSON-RPC 2.0；日志只能写 stderr。
- serverName：`shared-memory`；发现顺序：`DSH_MEMORY_URL` env → `~/.dsh/shared-memory/runtime.json` 的 `apiBase` → 默认 `http://127.0.0.1:62877/dsh-memory`。
- token：`DSH_MEMORY_TOKEN` env → `runtime.json.token` → 同名目录 `token` 文件 → 无。
- `initialize` 支持协议版本 `2024-11-05` / `2025-03-26` / `2025-06-18`（回显客户端版本，未知则回 `2024-11-05`）。
- 能力：`tools`（listChanged: false）、`resources`（listChanged: false, subscribe: false）。

工具（MCP `tools/list` 暴露的名称、参数）：

| 工具 | 参数 | 后端调用 |
|---|---|---|
| `memory_remember` | `text` 必填；`kind`、`tags` 可选 | POST /api/remember |
| `memory_search` | `q`、`kind`、`tag`、`limit` 可选 | GET /api/search |
| `memory_forget` | `id` 或 `q`(+`kind`) | POST /api/forget |
| `memory_current` | `focus`、`nextSteps`、`clear` 可选（都不给=读取） | GET/POST /api/current |
| `memory_digest` | `maxChars` 可选 | GET /api/digest |
| `memory_status` | 无 | GET /health |

资源：`memory://digest`（当前摘要）、`memory://current`（焦点与最近动态 JSON）。

`tools/call` 结果：`{ "content": [{ "type": "text", "text": "<可读文本或格式化 JSON>" }], "isError": false }`；
失败时 `isError: true` 且 `text` 说明原因（例如 Host 未启动：`共享记忆服务未运行：<url> 不可达`）。

## 4. Host 插件 config（cordis.patch.yml 行 config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `storeDir` | `~/.dsh/shared-memory` | 存储目录 |
| `captureUserMessages` | `true` | 自动捕获根会话的用户消息（短期原话缓存） |
| `messageRetentionDays` | `30` | 原话缓存保留天数，0=永久；到期自动删除（只删 message，不删主动记忆） |
| `promptDigest` | `true` | 把共享记忆摘要注入系统提示 |
| `maxDigestChars` | `1200` | 摘要注入上限 |
| `maxStoredMessages` | `3000` | 原话缓存的条数上限（超出丢最旧） |
| `maxActivitySessions` | `200` | 会话动态最多保留多少个会话（超出丢最旧） |
| `apiEnabled` | `true` | 是否注册 HTTP 路由 |
| `apiPath` | `/dsh-memory` | 路由前缀 |
| `apiToken` | `""` | 非空则要求 Bearer token |
| `autoFocusMinutes` | `90` | 自动焦点刷新间隔，0 关闭 |
| `writeHumanDigest` | `true` | 写 `digest.md` |
