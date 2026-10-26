# Changelog

## v1.2.0 — 2026-10-26

### 新增 / Added

- **查看 / 编辑 UI**：`GET /dsh-memory/ui` 单文件页面（`ui/index.html`，无构建）——统计、焦点编辑、搜索/过滤、编辑正文/类型/标签、删除、加载更多、导出 JSONL；`apiToken` 模式下页面内输入 token。
- **新 HTTP 接口**：`POST /api/update`（按 id 原地编辑，保留 id 与创建时间）、`GET /api/items`（分页：limit/offset）、`GET /api/export`（JSONL 下载）。
- **新模型工具**：`memory_update`（纠正/更新旧记忆，而不是 forget + remember）。
- 搜索接口新增 `offset` 分页字段。
- `message` 原话缓存只读（可删除、不可编辑）。

### 测试 / Tests

- host-smoke 覆盖 `memory_update`、`/api/update`、404、`/api/items` 分页、`/api/export`、`/ui`。
- standalone-smoke 覆盖 Hub 上的 update / UI / export。
- 三平台 CI 继续跑（ubuntu / windows / macos × Node 20/22）。

## v1.1.0 — 2026-10-26

### 新增 / Added

- **独立 Hub（跨平台）**：`standalone/server.mjs`，不依赖 DeepSeek Harness，复用同一份 store / HTTP API / MCP 桥；支持 `--port/--host/--store/--token`，启动时写 `runtime.json` 并复制桥。
- **三平台 CI**：GitHub Actions 矩阵（ubuntu / windows / macos × Node 20/22）跑 host、MCP、standalone 三套测试。
- **端到端测试**：`test/standalone-smoke.mjs`（真实起 Hub → HTTP → MCP 桥 → 校验 `runtime.json`）。

### 修复 / Fixed（Windows 兼容）

- 原子写 `rename` 在 Windows 被杀软/索引占用（EPERM/EACCES）时改为“删除目标 + 重试一次”。
- MCP 桥与插件支持 `~\` 形式的主目录路径。
- Skill 改用 `os.homedir()` 取主目录（Windows 上没有 `HOME` 环境变量）。
- 版本号统一为 1.1.0（插件 / MCP 桥 / package）。

## Unreleased

### 名称 / Branding

- 中文项目名更改为 **AI 跨平台记忆增强 1.0**；**英文名保持 Shared Memory 不变**（CrossMemory 仅作为以后再考虑的候选，暂不采用）。
- 仓库内展示名、README、locale、Release 标题同步更新。
- 内部标识保持不变：包名 `@local/shared-memory`、loader 行 `shared-memory`、skill id `shared-memory`、存储目录 `~/.dsh/shared-memory`、runtime 服务名 `dsh-shared-memory`。

## v1.0.0 — 2026-10-26

首个公开版本 · First public release.

### 新增 / Added

- **DeepSeek Harness Host 插件**：监听 `session/event` 自动捕获根会话用户消息，维护跨会话「当前焦点」和会话动态。
- **系统提示注入**：每个模型请求前注入 `## 共享记忆` 摘要（用户画像 / 当前焦点 / 最近会话 / 最近记忆，≤1200 字符）。
- **模型工具**：`memory_remember` / `memory_search` / `memory_forget` / `memory_current`。
- **本地 HTTP API**：`/dsh-memory` 下的 `health` / `digest` / `search` / `recent` / `current` / `activity` / `remember` / `forget`，可选 Bearer token。
- **零依赖 MCP stdio 桥**：自动发现 `runtime.json`，为 Claude Desktop / Claude Code / Cursor / ChatGPT Codex 提供 `memory_*` 工具和 `memory://digest`、`memory://current` 资源。
- **可复用 Agent Skill**：`skills/shared-memory/SKILL.md`，供 WorkBuddy 等用 Bash + curl 接入。
- **两层记忆策略**：原话只做 30 天短期缓存；长期记忆只保留模型判断后的条目。
- **测试**：`test/host-smoke.mjs`（工具/捕获/提示/HTTP/鉴权）+ `test/mcp-smoke.mjs`（35 项协议断言）。

### 已验证 / Verified

- DeepSeek Harness 所有会话：读写 + 提示注入 ✅
- WorkBuddy（技能 + Bash/curl）：读写 ✅
- Cursor（MCP）：读写 ✅
- ChatGPT 桌面版 Codex（MCP）：读写 ✅
- ChatGPT 纯聊天 / 网页：不支持本机 stdio MCP（需远程 Connector）❌

### 修复 / Fixed

- 工具 `output.schema` 使用参数 DSL 的 `required: true` 写法被 dsh-tools 的严格 JSON Schema 校验拒绝（`JsonSchemaError`）；改为标准 JSON Schema（对象级 `required` 数组）。
- `forget()` 在写队列里重复入队导致自锁；改为直接 `await #rewriteMemories()`。
- 自动焦点会被「继续 / 再来一次」等短句覆盖；新增 `isSubstantiveTask()` 过滤。

### 已知限制 / Known limitations

- 无独立 Web UI 面板。
- HTTP 服务依附 Harness 进程。
- 原话缓存为明文；可通过 `captureUserMessages: false` 关闭。
