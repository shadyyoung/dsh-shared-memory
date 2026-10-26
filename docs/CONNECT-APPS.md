# AI 跨平台记忆增强 · 接入其他 AI 应用（MCP 桥）

共享记忆的 HTTP API 跑在 **DeepSeek Harness 进程里**（本机默认 `http://127.0.0.1:62877/dsh-memory`）。
`mcp-server.mjs` 是一个**零依赖的 MCP stdio 桥**：其他 AI 应用（Claude Desktop、Claude Code、Cursor、Codex CLI……）只要配置启动这个桥，就能读写同一份共享记忆。

本机照抄信息：

| 项目 | 本机值 |
|---|---|
| Node | `which node` 的绝对路径（示例 `/usr/local/bin/node`） |
| 桥脚本 | `$HOME/.dsh/shared-memory/mcp-server.mjs` |
| 默认 API 地址 | `http://127.0.0.1:<端口>/dsh-memory`（端口随 Harness 启动变化，见 `runtime.json`） |
| 存储目录 | `$HOME/.dsh/shared-memory` |
| MCP 服务名 | `shared-memory`（serverInfo.name = `dsh-shared-memory`） |

---

## 第 1 步：启动记忆服务（二选一）

有两种方式，任选其一（**同一个 store 目录只能跑一个**）：

- **A. DeepSeek Harness（默认）**：插件激活后自动提供 HTTP API。
- **B. 独立 Hub（不需要 DSH，跨平台）**：
  ```bash
  node standalone/server.mjs --port 7400
  ```
  它同样写 `~/.dsh/shared-memory/runtime.json`，所以下面所有 MCP 配置都不用改。

> 下面的检查命令两种方式都适用，只要把 `.../dsh-memory` 换成对应地址（Hub 默认端口 7400）。

### 如果走 A：确认 DeepSeek Harness 已启动

HTTP API **不是一个独立后台服务**，它由 DeepSeek Harness 进程提供。所以：

1. 打开 DeepSeek Harness。
2. 确认「共享记忆」插件已启用（Lead 负责安装/启用）。
3. 在终端验证：

```bash
curl -s http://127.0.0.1:62877/dsh-memory/health
```

期望返回类似：

```json
{"ok":true,"name":"dsh-shared-memory","version":"1.1.0","startedAt":1700000000000,"storeDir":"$HOME/.dsh/shared-memory","stats":{"memories":0,"messages":0,"sessions":0,"hasFocus":false}}
```

- `ok: true` → 继续第 2 步。
- 连接失败 / 拒绝连接 → Harness 没启动，先打开它。
- HTTP 404 → Harness 在跑，但共享记忆插件的 HTTP 路由没注册（插件未启用，或 `apiPath` 被改过）。
- HTTP 401 → 后面所有 MCP 应用都要配 token（见「配置项」）。

> 插件激活时会写 `$HOME/.dsh/shared-memory/runtime.json`，并把 MCP 桥复制成 `$HOME/.dsh/shared-memory/mcp-server.mjs`。桥每次请求都会重新发现地址，所以 Harness 后启动也不用重启 MCP 应用。

---

## 第 2 步：确认桥能独立运行

### 2.1 文件就位

插件启用后应自动存在：

```bash
ls -l $HOME/.dsh/shared-memory/mcp-server.mjs
```

如果还没有（插件未激活），先从插件源码手动复制一份：

```bash
mkdir -p $HOME/.dsh/shared-memory
cp $REPO/mcp/server.mjs \
   $HOME/.dsh/shared-memory/mcp-server.mjs
chmod 755 $HOME/.dsh/shared-memory/mcp-server.mjs
```

### 2.2 直接运行（stdio）

```bash
/usr/local/bin/node $HOME/.dsh/shared-memory/mcp-server.mjs
```

它会安静地等待 stdin 输入；按 `Ctrl+D`（EOF）会以退出码 0 干净退出。**stdout 只有 JSON-RPC 协议消息**，诊断日志都在 stderr。

### 2.3 用一条命令自检握手 + 状态

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_status","arguments":{}}}' \
| /usr/local/bin/node $HOME/.dsh/shared-memory/mcp-server.mjs 2>/dev/null
```

期望输出两行 JSON；第二行里的 `content[0].text` 应该出现：

```
共享记忆服务运行中（dsh-shared-memory v1.1.0）
地址：http://127.0.0.1:62877/dsh-memory ...
```

如果出现 `共享记忆服务未运行：... 不可达（请先打开 DeepSeek Harness）`，回到第 1 步。

---

## 第 3 步：按应用配置（复制粘贴即可）

所有配置的核心都是同一组命令：

```text
命令: /usr/local/bin/node
参数: $HOME/.dsh/shared-memory/mcp-server.mjs
环境变量: 一般不需要；如插件设置了 apiToken，加 DSH_MEMORY_TOKEN
```

### 3.1 Claude Desktop

配置文件（已存在，但当前**没有** `mcpServers` 段）：

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

把下面这段合并进现有 JSON 的顶层（**不要覆盖**原有的 `preferences` / `deploymentMode`）：

```json
{
  "mcpServers": {
    "shared-memory": {
      "command": "/usr/local/bin/node",
      "args": ["$HOME/.dsh/shared-memory/mcp-server.mjs"],
      "env": {}
    }
  }
}
```

改完后**完全退出 Claude（⌘Q）再重新打开**。之后在对话里让它调用 `memory_status` 验证。

### 3.2 Claude Code

配置文件（已存在、当前没有 `mcpServers` 段）：

```text
~/.claude.json
```

优先用 CLI（如果你的 PATH 里有 `claude`）：

```bash
claude mcp add --transport stdio --scope user shared-memory -- \
  /usr/local/bin/node $HOME/.dsh/shared-memory/mcp-server.mjs
claude mcp list
```

> 当前 `command -v claude` 为空（PATH 中没检测到 Claude Code CLI），可以安装后使用上面的命令，或直接改配置文件。

手动方式：在 `~/.claude.json` 顶层加入（合并，不要整体替换；文件里已有 `firstStartTime` 等字段）：

```json
{
  "mcpServers": {
    "shared-memory": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["$HOME/.dsh/shared-memory/mcp-server.mjs"],
      "env": {}
    }
  }
}
```

项目级也可以用 `.mcp.json`（放在项目根目录，Claude Code 会询问是否信任该项目配置），结构同上：

```json
{
  "mcpServers": {
    "shared-memory": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["$HOME/.dsh/shared-memory/mcp-server.mjs"]
    }
  }
}
```

改完重启 Claude Code（或在会话里执行 `/mcp` 检查）。

### 3.3 Cursor

用户级配置（已写入 `~/.cursor/mcp.json`；Cursor 3.25 会热加载 MCP 配置，无需重启）：

```text
~/.cursor/mcp.json
```

内容：

```json
{
  "mcpServers": {
    "shared-memory": {
      "command": "/usr/local/bin/node",
      "args": ["$HOME/.dsh/shared-memory/mcp-server.mjs"],
      "env": {}
    }
  }
}
```

项目级配置：在项目根目录新建 `.cursor/mcp.json`，内容完全相同：

```text
<你的项目>/.cursor/mcp.json
```

保存后打开 Cursor 的 **Settings → Tools & MCP**（或 Customize → MCP）确认 `shared-memory` 已连接并启用；新服务器首次使用通常要点一次 Enable/允许。之后在 Agent 里让它调用 `memory_status`。

> 本机 2026-10-26 实测：写入配置后 Cursor 自动创建了 `user-shared-memory` 客户端并启动 `node ~/.dsh/shared-memory/mcp-server.mjs` 子进程，`memory_status` 可直接用。

### 3.4 Codex CLI / ChatGPT 桌面端（Codex 模式）

配置文件：`~/.codex/config.toml`（ChatGPT 桌面版与 Codex CLI 共用）。追加：

```toml
[mcp_servers.shared-memory]
command = "/usr/local/bin/node"
args = ["$HOME/.dsh/shared-memory/mcp-server.mjs"]
startup_timeout_sec = 20
```

- 已写入（备份 `~/.codex/config.toml.bak-<时间戳>`），`codex mcp list` 能看到 `shared-memory enabled`。
- 不需要配 `env`：桥会自动读 `~/.dsh/shared-memory/runtime.json` 发现端口，Harness 换端口也不用改配置。
- 改完重启 ChatGPT 桌面端 / Codex CLI。
- **本机 2026-10-26 实测通过**：Codex 工具列表出现 `mcp__shared_memory__memory_*`，成功读取摘要，并成功调用 `memory_remember` 写入「ChatGPT Codex 写入测试成功」（写入条目 `source.app=mcp`）。纯聊天窗口仍不支持本机 MCP。
- 注意：这影响的是 **Codex 模式（Agent）**；ChatGPT 的纯聊天窗口不读这份配置，见 3.6。

### 3.5 WorkBuddy（腾讯，本机 v5.8.3）

配置文件：`~/.workbuddy/mcp.json`（顶层 `mcpServers`，支持 stdio 与 streamableHttp）。合并这段（保留已有 rea / chatcut_desktop / lighthouse-ops 等条目）：

```json
{
  "mcpServers": {
    "shared-memory": {
      "command": "/usr/local/bin/node",
      "args": ["$HOME/.dsh/shared-memory/mcp-server.mjs"]
    }
  }
}
```

- 已写入（备份 `~/.workbuddy/mcp.json.bak-<时间戳>`）。
- **完全退出 WorkBuddy 再打开**（⌘Q），MCP 列表在启动时加载。
- 首次调用共享记忆工具会弹一次 MCP 授权确认，允许即可。
- 验证：让它调用 `memory_status`，或问“我在其他 AI 里说过什么”。
- WorkBuddy 自带的 `~/.workbuddy/memory/*_memory.md` 是它自己的记忆，不会自动互写；同步靠 MCP 工具读写共用存储。

### 3.6 纯 ChatGPT 聊天（网页 / 桌面聊天，不是 Codex）

ChatGPT 聊天侧**不能连接本机 stdio MCP**（只支持 OpenAI 服务器可达的远程 Connector），所以聊天窗口无法直接挂上共享记忆。三条路：

- **A（推荐，已配好）**：用同一台 Mac 上 ChatGPT 桌面版的 **Codex 模式**，它读 `~/.codex/config.toml`，已加入 `[mcp_servers.shared-memory]`。
- **B 手动同步**：把 `~/.dsh/shared-memory/digest.md` 贴给 ChatGPT，让它“写进记忆（Memory）”；之后定期贴增量。轻量但需要手动。
- **C 远程暴露（进阶）**：用 Cloudflare Tunnel / ngrok 把共享记忆包成 HTTPS MCP（或改写桥支持 streamable HTTP），在插件 config 里设 `apiToken`，再到 ChatGPT 设置 → Connectors 添加自定义连接器。等于把本机记忆暴露到公网，务必加鉴权并只在你信任的网络使用。

### 3.7 通用 stdio MCP 客户端

任何支持 MCP stdio 的客户端都填同样的三元组：

```json
{
  "mcpServers": {
    "shared-memory": {
      "command": "/usr/local/bin/node",
      "args": ["$HOME/.dsh/shared-memory/mcp-server.mjs"],
      "env": {
        "DSH_MEMORY_URL": "http://127.0.0.1:62877/dsh-memory"
      }
    }
  }
}
```

- 传输类型：`stdio`（不需要 SSE / Streamable HTTP）。
- 环境变量可以全部省略，桥会自动读 `~/.dsh/shared-memory/runtime.json`。
- 不会写任何文件、不需要 npm 依赖。

---

## 第 4 步：验证是否接通

在任意一个已配置的应用里：

1. 让它调用 **`memory_status`**。
   - 成功：返回「共享记忆服务运行中（dsh-shared-memory v1.1.0）」+ 存储目录 + 统计。
   - 失败：见下方排错表。
2. 让它调用 **`memory_remember`** 写入 `{ "text": "我偏好先给结论", "kind": "preference" }`。
3. 换一个应用，让它调用 **`memory_search`**（`q: "结论"`），应该能搜到刚才那条。
4. 支持 Resources 的客户端还可以读 `memory://digest`（Markdown 摘要）和 `memory://current`（焦点与最近动态 JSON）。

开发自检（不需要 Harness，内置 mock HTTP 服务）：

```bash
/usr/local/bin/node $REPO/test/mcp-smoke.mjs
```

期望最后一行：`✅ MCP 冒烟测试通过：35 项断言`。

---

## 配置项与发现顺序

桥的地址/token 发现顺序（每次请求重新解析，改完不用重启应用）：

| 项目 | 优先级（从高到低） |
|---|---|
| API 地址 | `--url=<apiBase>` → 环境变量 `DSH_MEMORY_URL` → `runtime.json` 的 `apiBase` → 默认 `http://127.0.0.1:62877/dsh-memory` |
| token | 环境变量 `DSH_MEMORY_TOKEN` → `runtime.json` 的 `token` → `<storeDir>/token` 文件 → 无 |

可选启动参数：

```bash
# 覆盖 API 地址
/usr/local/bin/node $HOME/.dsh/shared-memory/mcp-server.mjs --url=http://127.0.0.1:62877/dsh-memory

# 指向别的存储目录（影响 runtime.json / token 查找）
/usr/local/bin/node $HOME/.dsh/shared-memory/mcp-server.mjs --store=/path/to/store
```

什么时候需要 `DSH_MEMORY_TOKEN`：插件 config 里 `apiToken` 非空时，`/api/*` 需要 Bearer token。插件会把 token 写进 `runtime.json`，桥通常能自动读到；如果读不到或你手动改了 token，再在应用配置的 `env` 里加：

```json
"env": { "DSH_MEMORY_TOKEN": "<和插件 config 一致的 token>" }
```

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 工具返回 `共享记忆服务未运行：<url> 不可达（请先打开 DeepSeek Harness）` | Harness 没启动。打开 Harness；桥会自动重连，不用重启应用。 |
| 工具返回 `共享记忆服务响应超时（5 秒）` | Harness 卡住或端口被防火墙拦截；确认 `curl /health` 是否正常。 |
| `curl .../health` 返回 404 | 插件没启用或 `apiPath` 不同；在 Harness 里确认共享记忆插件已启用。 |
| 工具返回 `HTTP 401` / `要求 token` | 配置 `DSH_MEMORY_TOKEN`（见上），或确认 `<storeDir>/token` 与插件 `apiToken` 一致。 |
| 应用里看不到工具 | 检查 JSON/TOML 语法（逗号、引号、表名）；确认用了绝对路径 `/usr/local/bin/node` 和 `$HOME/.dsh/shared-memory/mcp-server.mjs`；完全重启应用；Claude Desktop 是 ⌘Q 退出而不是关窗口。 |
| 应用报 MCP 解析错误 | 桥不会往 stdout 写日志；确认启动命令没有被 shell 包装脚本额外打印内容。stderr 里能看到 `[dsh-shared-memory]` 诊断。 |
| 端口不是 62877 | 用环境变量 `DSH_MEMORY_URL` 或 `--url` 指到 Harness 实际地址（见 `runtime.json`）。 |
| 想换存储目录 | 改插件 config 的 `storeDir`；桥用 `--store` 只影响它去哪找 `runtime.json`/`token`，不移动数据。 |
| 多个应用同时写 | 正常：唯一写者是 Harness，所有应用都通过 HTTP 串行写入；相同 `kind + text` 会自动去重（`deduped: true`）。 |

---

## 安全说明

- 桥只连接本机 Harness，不直接读写记忆文件，也不落盘。
- 建议保持 `apiToken` 为空（仅监听 127.0.0.1）；若设置 token，不要把它提交进版本库或共享给他人。
- 诊断日志只写 stderr，不污染 MCP 协议。
