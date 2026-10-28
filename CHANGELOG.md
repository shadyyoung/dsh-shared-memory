# Changelog

## v1.6.2 — 2026-10-28

### 新增 / Added

- **WorkBuddy 改用 MCP 接入**：`install-apps` 现在同时写入 `~/.workbuddy/mcp.json` 的 `shared-memory` 条目，WorkBuddy 打开即拥有 7 个记忆工具（skill 仍保留作备份）。
- 已在本机写入并验证（原 `mcp.json` 自动备份）。

## v1.6.1 — 2026-10-28

### 新增 / Added

- **`npm run install-apps`**：自动检测已安装的 Cursor / Claude Desktop / ChatGPT(Codex) / Claude Code / Windsurf / WorkBuddy，备份后写入 `shared-memory` MCP 配置，新装应用重跑一次即可「打开即用」。
- **`npm run autostart`**：安装 macOS LaunchAgent，登录时自动打开 DeepSeek Harness，让记忆服务常驻；`autostart:uninstall` 可移除。
- 说明：已在运行的应用必须 `Cmd+Q` 重启一次才会加载 MCP（应用自身限制，无法热更新）。

## v1.6.0 — 2026-10-27

### 新增 / Added

- **自动抽取 + 待确认收件箱**：用户消息自动抽取长期事实（规则模式默认、免费；`autoExtract: llm` 可切模型抽取，`maxExtractPerDay` 日配额），全部进候选区，UI 接受才落库，可编辑/拒绝。
- **导入历史对话**：`POST /api/import` 支持 ChatGPT / Claude `conversations.json`、jsonl、txt/md；导入为原话并按同一管线生成候选；UI 备份卡片里可直接选文件导入。
- **PII 脱敏**：写入前识别常见密钥/令牌/身份证号，默认替换为 `[已脱敏]`；`piiPolicy` 可设为 off/warn/redact。
- **接入自检 `npm run doctor`**：检查 DSH 服务、MCP 桥握手、Cursor / Codex / Claude Desktop / WorkBuddy 配置。
- **UI**：新增「待确认」tab；备份卡片新增「导入历史对话」。
- Claude Desktop 配置已写入 `mcpServers.shared-memory`（备份原文件后修改）。

### 配置 / Config

- `autoExtract`（默认 `rules`；`off` / `llm`）
- `extractProvider` / `extractModel`（空=默认模型）
- `maxExtractPerDay`（默认 30）
- `extractMinChars`（默认 18）
- `piiPolicy`（默认 `redact`）

### 测试 / Tests

- host-smoke：候选创建/接受/拒绝、ChatGPT 导入生成候选与被检索、PII 脱敏。
- doctor 自检 7 项（含 Claude Desktop 已接入）。

## v1.5.0 — 2026-10-27

### 新增 / Added

- **自动备份**：启动后（距上次超过间隔时）及每小时检查一次，把全量数据（记录/焦点/动态/使用统计）gzip 快照到 `backupDir`（默认 `~/.dsh/shared-memory-backups`，在存储目录之外），按 `backupKeep`（默认 14）轮转清理。
- **手动备份 / 恢复**：
  - `POST /api/backup`、`GET /api/backups`、`POST /api/restore-backup`
  - 恢复前自动再备份当前状态（`before-restore`），恢复本身也可回退
  - 文件名白名单校验，防路径穿越；校验 schema 后原子写入并热重载内存
- **UI**：「备份与恢复」卡片，显示备份目录/间隔/上次时间，一键备份、列表、恢复。
- **standalone hub**：`--backup-dir` / `SHARED_MEMORY_BACKUP_DIR`，同样启用自动备份。
- **检索精度**：查询词覆盖率过滤（至少匹配一半词元），避免短查询被无关记录稀释。
- **摘要截断**：严格不超过 `maxChars`（预留省略号与围栏空间）。

### 配置 / Config

- `backupDir`（默认 `~/.dsh/shared-memory-backups`）
- `backupKeep`（默认 14）
- `autoBackupHours`（默认 24，0=关闭自动备份）

### 测试 / Tests

- host-smoke：创建备份 → 删除记录 → 恢复 → 记录回来；恢复前自动快照；非法文件名 400。
- standalone-smoke：hub 备份 + 恢复。
- 高覆盖率检索与摘要上限回归。

## v1.4.0 — 2026-10-27

### 新增 / Added

- **BM25 检索**：内存倒排索引（中文 bigram + 英文词 + tags），相关性排序；`sort=relevance|newest`；无查询词时仍按时间倒序。
- **相关性摘要注入**：摘要新增「相关记忆（与当前话题）」，用最近用户消息/当前焦点做查询，召回 top `maxRelevantMemories`（默认 4）条。
- **使用统计**：检索/注入命中的记忆累计 `usage.count`（`usage.json` 防抖落盘），参与相关性加权，UI 显示使用次数。
- **UI**：搜索高亮、排序切换（相关度/最新）、回收站「清空」。
- **接口**：`GET /api/items|/api/search` 支持 `sort`，返回项带 `usage`；新增 `POST /api/purge-trash`。
- **性能基准**：`test/search-bench.mjs`（10k 条建索引 + 查询），纳入 CI。

### 测试 / Tests

- host-smoke：TF 排序、`sort=newest`、标签索引、使用计数、清空回收站、相关性摘要段落。
- bench：10k 条索引构建 < 12s（实测约 20–100ms），平均查询 < 80ms（实测 <1ms）。
- 三平台 CI 继续跑（含 bench）。

### 配置 / Config

- `maxRelevantMemories`（默认 4，0=关闭相关记忆注入）

## v1.3.0 — 2026-10-27

### 新增 / Added

- **回收站（软删除）**：`forget` 默认只标记 `deletedAt`，`trashRetentionDays`（默认 30 天）后自动清理；`purge: true` 立即彻底删除；新增 `POST /api/restore` 与 `memory_restore` 工具。
- **编辑历史**：每次 `update` 保留上一版（`revisions`，默认最多 20 条）；UI 可查看/恢复任意历史版本。
- **MCP 桥补 `memory_update`**：外部应用（Claude/Cursor/Codex）现在可以原地编辑记忆；`memory_forget` 增加 `purge` 参数。
- **提示词注入防护**：摘要用 `<memory-data>` 围栏包裹 + `sanitizeMemoryText()` 过滤常见注入指令/伪造标签。
- **UI**：记忆 / 回收站切换、恢复、彻底删除、编辑历史查看与恢复；统计增加回收站条数。
- 搜索/列表支持 `deleted=1`、`includeDeleted=1`；摘要与检索默认排除回收站。

### 测试 / Tests

- host-smoke：软删除 → 回收站可见 → 恢复 → 彻底删除、编辑历史、digest 围栏与注入过滤。
- mcp-smoke：`memory_update` 工具（36 项断言）。
- standalone-smoke：Hub 上的软删除 + 恢复。

### 配置 / Config

- `trashRetentionDays`（默认 30，0=永久）
- `maxRevisions`（默认 20，0=不保留历史）

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
