#!/usr/bin/env node
/**
 * 共享记忆 (Shared Memory) — MCP stdio 桥
 *
 * 把本机 DeepSeek Harness 进程里运行的共享记忆 HTTP API 桥接给任意 MCP 客户端
 * （Claude Desktop、Claude Code、Cursor、Codex CLI 等）。
 *
 * - 传输：stdin/stdout 逐行 JSON-RPC 2.0；stdout 只写协议消息，诊断一律写 stderr。
 * - 发现顺序（见 docs/API.md）：
 *     URL:   --url= > DSH_MEMORY_URL > ~/.dsh/shared-memory/runtime.json .apiBase > 默认地址
 *     token: DSH_MEMORY_TOKEN > runtime.json .token > <storeDir>/token 文件 > 无
 * - 无 npm 依赖，只用 node: 内置模块。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SERVER_NAME = 'dsh-shared-memory';
const SERVER_VERSION = '1.4.0';
const DEFAULT_API_BASE = 'http://127.0.0.1:62877/dsh-memory';
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const DEFAULT_PROTOCOL = '2024-11-05';
const HTTP_TIMEOUT_MS = 5000;
const DEFAULT_STORE_DIR = path.join(os.homedir(), '.dsh', 'shared-memory');
const VALID_KINDS = ['note', 'profile', 'preference', 'goal', 'project', 'task', 'message'];

const KINDS_HINT = VALID_KINDS.join(' / ');

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function log(...parts) {
  process.stderr.write(`[${SERVER_NAME}] ${parts.join(' ')}\n`);
}

function expandHome(p) {
  if (typeof p !== 'string' || p === '') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTokenFile(file) {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function clip(value, max = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function fmtDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '未知时间';
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function normalizeTags(value) {
  if (value === undefined || value === null) return [];
  let raw = [];
  if (Array.isArray(value)) raw = value;
  else if (typeof value === 'string') raw = value.split(/[,，、\s]+/);
  else return null;
  const tags = [];
  for (const item of raw) {
    const tag = asString(item);
    if (tag === undefined) return null;
    const trimmed = tag.trim();
    if (trimmed) tags.push(trimmed);
  }
  return tags;
}

class BridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeError';
  }
}

class MethodNotFoundError extends Error {
  constructor(method) {
    super(`未知方法：${method}`);
    this.name = 'MethodNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// CLI / 服务发现
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const opts = { url: undefined, store: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg.startsWith('--url=')) {
      opts.url = arg.slice('--url='.length);
    } else if (arg === '--url') {
      opts.url = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--store=')) {
      opts.store = arg.slice('--store='.length);
    } else if (arg === '--store') {
      opts.store = argv[i + 1];
      i += 1;
    }
    // 未知参数忽略，避免客户端注入额外参数时崩溃。
  }
  return opts;
}

const CLI = parseCliArgs(process.argv.slice(2));

if (CLI.help) {
  process.stderr.write(
    [
      '共享记忆 MCP 桥（stdio）',
      '',
      '用法: node mcp-server.mjs [--url=<apiBase>] [--store=<storeDir>]',
      '',
      '可选参数:',
      '  --url=<apiBase>   覆盖 HTTP API 地址，例如 http://127.0.0.1:62877/dsh-memory',
      '  --store=<storeDir> 共享记忆存储目录（用于查找 runtime.json / token），默认 ~/.dsh/shared-memory',
      '',
      '环境变量:',
      '  DSH_MEMORY_URL    同 --url，优先级低于 --url',
      '  DSH_MEMORY_TOKEN  Bearer token（仅当插件 config apiToken 非空时需要）',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

let warnedBadRuntime = false;

function storeDirFromCli() {
  const raw = CLI.store ? expandHome(CLI.store) : DEFAULT_STORE_DIR;
  return path.resolve(raw);
}

/**
 * 每次请求都重新发现，这样 Harness 在 MCP 客户端之后启动也能自动连上。
 */
function discover() {
  const storeDir = storeDirFromCli();
  const runtimeFile = path.join(storeDir, 'runtime.json');
  const runtime = readJsonFile(runtimeFile);
  if (runtime === null && fs.existsSync(runtimeFile) && !warnedBadRuntime) {
    warnedBadRuntime = true;
    log(`runtime.json 无法解析，已忽略：${runtimeFile}`);
  }

  const runtimeApiBase =
    runtime && typeof runtime.apiBase === 'string' && runtime.apiBase.trim()
      ? runtime.apiBase.trim()
      : undefined;
  const runtimeStoreDir =
    runtime && typeof runtime.storeDir === 'string' && runtime.storeDir.trim()
      ? path.resolve(expandHome(runtime.storeDir.trim()))
      : undefined;

  let apiBase = DEFAULT_API_BASE;
  let urlSource = 'default';
  if (typeof CLI.url === 'string' && CLI.url.trim()) {
    apiBase = CLI.url.trim();
    urlSource = 'cli';
  } else if (typeof process.env.DSH_MEMORY_URL === 'string' && process.env.DSH_MEMORY_URL.trim()) {
    apiBase = process.env.DSH_MEMORY_URL.trim();
    urlSource = 'env';
  } else if (runtimeApiBase) {
    apiBase = runtimeApiBase;
    urlSource = 'runtime.json';
  }

  const tokenStoreDir = runtimeStoreDir || storeDir;
  const tokenFile = path.join(tokenStoreDir, 'token');

  let token = null;
  let tokenSource = 'none';
  if (typeof process.env.DSH_MEMORY_TOKEN === 'string' && process.env.DSH_MEMORY_TOKEN.trim()) {
    token = process.env.DSH_MEMORY_TOKEN.trim();
    tokenSource = 'env';
  } else if (runtime && typeof runtime.token === 'string' && runtime.token.trim()) {
    token = runtime.token.trim();
    tokenSource = 'runtime.json';
  } else {
    const fileToken = readTokenFile(tokenFile);
    if (fileToken) {
      token = fileToken;
      tokenSource = 'token 文件';
    }
  }

  return {
    apiBase: normalizeApiBase(apiBase),
    urlSource,
    token,
    tokenSource,
    tokenFile,
    storeDir,
  };
}

function tokenSourceLabel(cfg) {
  switch (cfg.tokenSource) {
    case 'env':
      return '环境变量 DSH_MEMORY_TOKEN';
    case 'runtime.json':
      return 'runtime.json .token';
    case 'token 文件':
      return cfg.tokenFile;
    default:
      return '无（服务端未要求 token）';
  }
}

function normalizeApiBase(raw) {
  const value = String(raw).trim();
  if (!value) return value;
  // 容忍省略协议的写法，例如 127.0.0.1:62877/dsh-memory。
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

function endpoint(cfg, pathname, query) {
  let base;
  try {
    base = new URL(cfg.apiBase);
  } catch {
    throw new BridgeError(
      `共享记忆服务地址无效：${cfg.apiBase}（期望形如 http://127.0.0.1:62877/dsh-memory）`,
    );
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${pathname}`;
  base.hash = '';
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      base.searchParams.set(key, String(value));
    }
  }
  return base.toString();
}

/**
 * 调用共享记忆 HTTP API。成功返回解析后的 JSON；失败抛 BridgeError（消息直接给用户看）。
 */
async function httpRequest(cfg, method, pathname, { query, body } = {}) {
  const url = endpoint(cfg, pathname, query);
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;

  let response;
  let rawText = '';
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    rawText = await response.text();
  } catch (error) {
    const name = error && error.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new BridgeError(
        `共享记忆服务响应超时（${HTTP_TIMEOUT_MS / 1000} 秒）：${cfg.apiBase}`,
      );
    }
    throw new BridgeError(
      `共享记忆服务未运行：${cfg.apiBase} 不可达（请先打开 DeepSeek Harness）`,
    );
  }

  let data = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }
  }

  if (response.status === 401) {
    throw new BridgeError(
      `共享记忆服务要求 token（HTTP 401）：请把正确的 token 放进环境变量 DSH_MEMORY_TOKEN，或确认 ${cfg.tokenFile} 与插件 config 的 apiToken 一致。`,
    );
  }

  if (!response.ok) {
    const message =
      (data && data.error && data.error.message) ||
      (data && typeof data.message === 'string' && data.message) ||
      clip(rawText, 300) ||
      response.statusText ||
      '未知错误';
    if (response.status === 404) {
      throw new BridgeError(
        `共享记忆服务返回 HTTP 404：${message}（Harness 可能在运行，但共享记忆插件未启用，或 apiPath 与默认 /dsh-memory 不同）`,
      );
    }
    throw new BridgeError(`共享记忆服务返回 HTTP ${response.status}：${message}`);
  }

  if (data === null) {
    throw new BridgeError(
      `共享记忆服务返回了非 JSON 响应（HTTP ${response.status}）：${url}`,
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// 输出格式化（给模型看的可读文本，而不是原始 JSON dump）
// ---------------------------------------------------------------------------

function formatMemoryLine(memory) {
  const item = memory && typeof memory === 'object' ? memory : {};
  const tags =
    Array.isArray(item.tags) && item.tags.length ? `  #${item.tags.join(' #')}` : '';
  return `- [${item.id || '未知 id'}] ${item.kind || 'note'} · ${fmtDate(item.createdAt)} · ${clip(item.text, 400)}${tags}`;
}

function formatRemember(data) {
  const item = data && data.item ? data.item : null;
  if (!item) throw new BridgeError('共享记忆服务返回了意外的响应（缺少 item 字段）。');
  const lines = [];
  if (data.deduped) {
    lines.push(`这条记忆已经存在，返回已有记录（deduped：true，未重复写入）。`);
  } else {
    lines.push(`已记住（id：${item.id || '未知'}）`);
  }
  lines.push(`类型：${item.kind || 'note'}`);
  lines.push(`时间：${fmtDate(item.createdAt)}`);
  if (Array.isArray(item.tags) && item.tags.length) lines.push(`标签：#${item.tags.join(' #')}`);
  lines.push(`内容：${item.text ?? ''}`);
  if (item.source && item.source.app) lines.push(`来源应用：${item.source.app}`);
  return lines.join('\n');
}

function formatSearch(data, { q }) {
  const items = data && Array.isArray(data.items) ? data.items : [];
  const total = data && Number.isFinite(Number(data.total)) ? Number(data.total) : items.length;
  const label = q ? `查询“${q}”` : '最近记忆';
  if (!items.length) {
    return [
      `没有找到匹配的共享记忆（${label}）。`,
      '提示：换个关键词/去掉类型过滤，或不带 q 查看最近记忆；也可以用 memory_digest 了解全局。',
    ].join('\n');
  }
  return [
    `${label}：共 ${total} 条，显示 ${items.length} 条`,
    '',
    items.map((item) => formatMemoryLine(item)).join('\n'),
  ].join('\n');
}

function formatForget(data) {
  const deleted = Number.isFinite(Number(data && data.deleted)) ? Number(data.deleted) : 0;
  const ids = data && Array.isArray(data.ids) ? data.ids : [];
  if (!deleted) {
    return '没有找到要删除的记忆（deleted：0）。可以用 memory_search 先确认 id 或关键词。';
  }
  const lines = [`已删除 ${deleted} 条记忆。`];
  if (ids.length) lines.push(`id：${ids.join(', ')}`);
  return lines.join('\n');
}

function formatActivity(activity) {
  const lines = [];
  const list = Array.isArray(activity) ? activity : [];
  if (!list.length) {
    lines.push('（暂无活动记录）');
    return lines;
  }
  for (const a of list) {
    const item = a && typeof a === 'object' ? a : {};
    const app = item.app || 'unknown';
    const count = Number.isFinite(Number(item.messageCount)) ? item.messageCount : 0;
    lines.push(
      `- [${app}] ${item.sessionId || '未知会话'} · ${fmtDate(item.updatedAt)} · ${count} 条消息`,
    );
    if (item.cwd) lines.push(`  目录：${item.cwd}`);
    if (item.lastUser) lines.push(`  用户：${clip(item.lastUser, 200)}`);
    if (item.lastAssistant) lines.push(`  助手：${clip(item.lastAssistant, 200)}`);
  }
  return lines;
}

function formatCurrent(data) {
  const lines = ['## 当前焦点'];
  const focus = data && data.focus ? data.focus : null;
  if (focus && focus.text) {
    lines.push(String(focus.text));
    const steps = Array.isArray(focus.nextSteps) ? focus.nextSteps : [];
    if (steps.length) {
      lines.push('下一步：');
      steps.forEach((step, index) => lines.push(`${index + 1}. ${clip(step, 200)}`));
    }
    const meta = [`更新于 ${fmtDate(focus.updatedAt)}`];
    if (focus.updatedBy) meta.push(`by ${focus.updatedBy}`);
    meta.push(focus.auto ? '自动' : '手动');
    lines.push(`（${meta.join('，')}）`);
  } else {
    lines.push('（暂无焦点。可用 memory_current({ focus: "...", nextSteps: ["..."] }) 设置。）');
  }

  const activity = data && Array.isArray(data.activity) ? data.activity : [];
  lines.push('', `## 最近会话动态（${activity.length}）`);
  lines.push(...formatActivity(activity));

  const recent = data && Array.isArray(data.recent) ? data.recent : [];
  lines.push('', `## 最近记忆（${recent.length}）`);
  if (!recent.length) lines.push('（暂无记忆）');
  else recent.forEach((memory) => lines.push(formatMemoryLine(memory)));

  return lines.join('\n');
}

function formatFocusResult(data, cleared) {
  if (cleared) return '已清除当前焦点。';
  const focus = data && data.focus ? data.focus : null;
  if (!focus) return '焦点已更新，但服务返回的 focus 为空。';
  const lines = [`已更新当前焦点：${focus.text || ''}`];
  const steps = Array.isArray(focus.nextSteps) ? focus.nextSteps : [];
  if (steps.length) {
    lines.push('下一步：');
    steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  lines.push(`（更新于 ${fmtDate(focus.updatedAt)}）`);
  return lines.join('\n');
}

function formatStatus(data, cfg) {
  const stats = data && data.stats ? data.stats : {};
  const lines = [
    `共享记忆服务运行中（${data && data.name ? data.name : SERVER_NAME} v${(data && data.version) || '?'}）`,
    `地址：${cfg.apiBase}（来源：${describeUrlSource(cfg.urlSource)}）`,
    `存储目录：${(data && data.storeDir) || cfg.storeDir}`,
  ];
  if (data && data.startedAt) lines.push(`启动时间：${fmtDate(data.startedAt)}`);
  lines.push(
    `统计：记忆 ${stats.memories ?? '?'} 条 / 消息 ${stats.messages ?? '?'} 条 / 会话 ${stats.sessions ?? '?'} 个 / 当前焦点：${stats.hasFocus ? '有' : '无'}`,
  );
  lines.push(`鉴权：${tokenSourceLabel(cfg)}`);
  return lines.join('\n');
}

function describeUrlSource(source) {
  switch (source) {
    case 'cli':
      return '命令行 --url';
    case 'env':
      return '环境变量 DSH_MEMORY_URL';
    case 'runtime.json':
      return 'runtime.json';
    default:
      return '默认地址';
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'memory_remember',
    description:
      'Store a durable fact, preference, goal, project or task into the shared memory used by ALL AI apps. Use when the user says to remember something, or when you learn a stable preference/decision worth keeping. 把值得长期记住的事实、偏好、目标、项目或任务写入共享记忆（所有 AI 应用共享）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要记住的正文，1–8000 字符。The memory content to store.',
        },
        kind: {
          type: 'string',
          enum: VALID_KINDS,
          description:
            '记忆类型，缺省 note。note 笔记 / profile 个人档案 / preference 偏好 / goal 目标 / project 项目 / task 任务 / message 消息。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: '可选标签，最多 20 个，例如 ["写作","偏好"]。Optional tags.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description:
      'Search the shared memory that all AI apps write to. Use before asking the user to repeat context, when the user refers to something from another app/session, or to look up a known preference. 跨应用搜索共享记忆（关键词匹配正文和标签，按时间倒序）。',
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: '大小写不敏感的子串关键词；留空则返回最近记忆。Case-insensitive substring query.',
        },
        kind: {
          type: 'string',
          description: `只返回指定类型，可用逗号分隔多个，例如 "preference,profile"。可选值：${KINDS_HINT}。`,
        },
        tag: {
          type: 'string',
          description: '只返回带该标签的记忆（精确匹配）。Exact tag filter.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: '返回条数，默认 20，最大 100。Max results (default 20).',
        },
        sort: {
          type: 'string',
          enum: ['relevance', 'newest'],
          description: '排序：relevance（有查询词时默认，BM25 相关性）或 newest（时间倒序）。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_forget',
    description:
      'Delete memories from shared memory by id, or by a text query plus optional kind. Use when the user asks to forget, correct, or remove something previously remembered. 删除共享记忆中的记录（按 id，或按关键词 + 可选类型批量删除）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '要删除的记忆 id（形如 mem_...）。与 q 二选一。Memory id.',
        },
        q: {
          type: 'string',
          description: '按关键词匹配删除（与 id 二选一）。Delete by substring query.',
        },
        kind: {
          type: 'string',
          enum: VALID_KINDS,
          description: '配合 q 时限制记忆类型。Optional kind filter for q.',
        },
        purge: {
          type: 'boolean',
          description: 'true 表示彻底删除；默认只移到回收站（可恢复）。Permanently delete instead of moving to trash.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_update',
    description:
      'Edit an existing memory in place (text / kind / tags) while keeping its id and creation time. Use it to correct or update a fact instead of forgetting and re-remembering. 原地编辑已有记忆（正文/类型/标签），保留 id 和创建时间；原话缓存（kind=message）不可编辑。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '要编辑的记忆 id（形如 mem_...）。Memory id.',
        },
        text: {
          type: 'string',
          description: '新的正文（非空）。New text.',
        },
        kind: {
          type: 'string',
          enum: ['note', 'profile', 'preference', 'goal', 'project', 'task'],
          description: '新的记忆类型。New kind.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '替换后的标签列表。Replacement tags.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_current',
    description:
      'Read or update the current focus and next steps shared across all AI apps. Call with no arguments to read; pass focus and/or nextSteps to set; pass clear:true to clear. Use at the start of work to see what the user is doing elsewhere. 读取或更新跨应用共享的「当前焦点 / 下一步」；不带参数=读取。',
    inputSchema: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: '设置当前焦点（一句话）。New focus text.',
        },
        nextSteps: {
          type: 'array',
          items: { type: 'string' },
          description: '设置下一步列表，例如 ["安装","验证"]。Next steps list.',
        },
        clear: {
          type: 'boolean',
          description: 'true 清除当前焦点。Clear the focus.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_digest',
    description:
      'Get a compact Markdown digest of shared memory (focus, preferences, recent work). Use at the start of a task to align with what other AI apps already know. 获取共享记忆的 Markdown 摘要，适合直接放进上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: {
          type: 'integer',
          minimum: 200,
          maximum: 8000,
          description: '摘要最大字符数，默认 1500，范围 200–8000。Max characters (default 1500).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_status',
    description:
      'Check whether the shared-memory service is running, plus its version, store directory and counts. Use to diagnose connection problems (service not started, wrong port, token required). 查看共享记忆服务状态（是否运行、版本、存储目录、统计），连接失败时先用它诊断。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

function toolOk(text) {
  return { content: [{ type: 'text', text }], isError: false };
}

function toolFail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function requireValidKinds(kind) {
  if (kind === undefined) return;
  for (const part of String(kind).split(',')) {
    const k = part.trim();
    if (k && !VALID_KINDS.includes(k)) {
      throw new BridgeError(`kind 无效：${k}。可选值：${KINDS_HINT}。`);
    }
  }
}

function normalizeKindList(value) {
  if (Array.isArray(value)) return value.map((v) => asString(v)).filter(Boolean).join(',');
  return asString(value);
}

async function runTool(name, args, cfg) {
  switch (name) {
    case 'memory_remember': {
      const text = asString(args.text);
      if (!text || !text.trim()) {
        throw new BridgeError('缺少必填参数 text：请提供要记住的文字内容。');
      }
      if (text.length > 8000) throw new BridgeError('text 过长：最多 8000 字符。');
      const kind = asString(args.kind);
      requireValidKinds(kind);
      const tags = normalizeTags(args.tags);
      if (tags === null) throw new BridgeError('tags 必须是字符串数组。');
      if (tags.length > 20) throw new BridgeError('tags 最多 20 个。');

      const body = { text: text.trim(), source: { app: 'mcp' } };
      if (kind) body.kind = kind;
      if (tags.length) body.tags = tags;

      const data = await httpRequest(cfg, 'POST', '/api/remember', { body });
      return toolOk(formatRemember(data));
    }

    case 'memory_search': {
      const q = asString(args.q) || '';
      const kind = normalizeKindList(args.kind);
      const tag = asString(args.tag);
      let limit = asInt(args.limit);
      if (limit === undefined) limit = 20;
      if (Number.isNaN(limit)) throw new BridgeError('limit 必须是 1–100 的整数。');
      limit = Math.min(100, Math.max(1, limit));
      if (kind) requireValidKinds(kind);

      const sort = asString(args.sort);
      if (sort && sort !== 'relevance' && sort !== 'newest') throw new BridgeError('sort 只能是 relevance 或 newest。');
      const data = await httpRequest(cfg, 'GET', '/api/search', {
        query: { q, kind, tag, limit, sort },
      });
      return toolOk(formatSearch(data, { q }));
    }

    case 'memory_forget': {
      const id = asString(args.id);
      const q = asString(args.q);
      if (!id && !q) {
        throw new BridgeError('请提供 id，或提供 q（可加 kind）来按条件删除。');
      }
      if (id && q) throw new BridgeError('id 与 q 只能二选一。');
      const kind = asString(args.kind);
      if (kind) requireValidKinds(kind);
      const body = id ? { id } : { q };
      if (!id && kind) body.kind = kind;
      if (args.purge === true) body.purge = true;
      const data = await httpRequest(cfg, 'POST', '/api/forget', { body });
      return toolOk(formatForget(data));
    }

    case 'memory_update': {
      const id = asString(args.id);
      if (!id || !id.trim()) throw new BridgeError('缺少必填参数 id。');
      const body = { id: id.trim() };
      if (args.text !== undefined) {
        const text = asString(args.text);
        if (!text || !text.trim()) throw new BridgeError('text 不能为空。');
        body.text = text.trim();
      }
      if (args.kind !== undefined) {
        requireValidKinds(args.kind);
        body.kind = asString(args.kind);
      }
      if (args.tags !== undefined) {
        const tags = normalizeTags(args.tags);
        if (tags === null) throw new BridgeError('tags 必须是字符串数组。');
        body.tags = tags;
      }
      const data = await httpRequest(cfg, 'POST', '/api/update', { body });
      return toolOk(formatRemember(data));
    }

    case 'memory_current': {
      const hasFocus = args.focus !== undefined;
      const hasNextSteps = args.nextSteps !== undefined;
      const clear = args.clear === true;

      if (clear) {
        if (hasFocus || hasNextSteps) {
          throw new BridgeError('clear 不能与 focus / nextSteps 同时使用。');
        }
        const data = await httpRequest(cfg, 'POST', '/api/current', { body: { clear: true } });
        return toolOk(formatFocusResult(data, true));
      }

      if (hasFocus || hasNextSteps) {
        const body = {};
        if (hasFocus) {
          const focus = asString(args.focus);
          if (focus === undefined) throw new BridgeError('focus 必须是字符串。');
          if (!focus.trim()) throw new BridgeError('focus 不能为空；如需清除焦点请用 clear:true。');
          body.focus = focus.trim();
        }
        if (hasNextSteps) {
          if (!Array.isArray(args.nextSteps)) {
            throw new BridgeError('nextSteps 必须是字符串数组。');
          }
          const steps = args.nextSteps.map((step) => asString(step));
          if (steps.some((step) => step === undefined)) {
            throw new BridgeError('nextSteps 里只能放字符串。');
          }
          body.nextSteps = steps;
        }
        const data = await httpRequest(cfg, 'POST', '/api/current', { body });
        return toolOk(formatFocusResult(data, false));
      }

      const data = await httpRequest(cfg, 'GET', '/api/current');
      return toolOk(formatCurrent(data));
    }

    case 'memory_digest': {
      let maxChars = asInt(args.maxChars);
      if (maxChars === undefined) maxChars = 1500;
      if (Number.isNaN(maxChars)) throw new BridgeError('maxChars 必须是 200–8000 的整数。');
      maxChars = Math.min(8000, Math.max(200, maxChars));
      const data = await httpRequest(cfg, 'GET', '/api/digest', { query: { maxChars } });
      const text = data && typeof data.text === 'string' ? data.text : '';
      return toolOk(text.trim() ? text : '（共享记忆摘要为空）');
    }

    case 'memory_status': {
      const data = await httpRequest(cfg, 'GET', '/health');
      if (data && data.ok === false) {
        throw new BridgeError('共享记忆服务健康检查未通过（/health 返回 ok: false）。');
      }
      return toolOk(formatStatus(data, cfg));
    }

    default:
      return toolFail(
        `未知工具：${name}。可用工具：${TOOLS.map((tool) => tool.name).join('、')}。`,
      );
  }
}

async function callTool(name, args) {
  const cfg = discover();
  try {
    return await runTool(name, args, cfg);
  } catch (error) {
    if (error instanceof BridgeError) return toolFail(error.message);
    return toolFail(`共享记忆桥内部错误：${(error && error.message) || error}`);
  }
}

// ---------------------------------------------------------------------------
// 资源
// ---------------------------------------------------------------------------

const RESOURCES = [
  {
    uri: 'memory://digest',
    name: 'shared-memory-digest',
    title: '共享记忆摘要',
    description: '当前共享记忆的 Markdown 摘要，可直接作为上下文使用。',
    mimeType: 'text/markdown',
  },
  {
    uri: 'memory://current',
    name: 'shared-memory-current',
    title: '当前焦点与最近动态',
    description: '当前焦点、最近会话动态与最近记忆（JSON）。',
    mimeType: 'application/json',
  },
];

async function readResource(uri) {
  const cfg = discover();
  try {
    if (uri === 'memory://digest') {
      const data = await httpRequest(cfg, 'GET', '/api/digest');
      const text = data && typeof data.text === 'string' ? data.text : '';
      return {
        contents: [{ uri, mimeType: 'text/markdown', text: text || '（共享记忆摘要为空）' }],
      };
    }
    if (uri === 'memory://current') {
      const data = await httpRequest(cfg, 'GET', '/api/current');
      return {
        contents: [
          { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) },
        ],
      };
    }
    throw new BridgeError(`未知资源：${uri}。可用资源：memory://digest、memory://current。`);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(`读取资源失败：${(error && error.message) || error}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP 协议
// ---------------------------------------------------------------------------

const SERVER_INSTRUCTIONS =
  '共享记忆由本机所有 AI 应用共享（DeepSeek Harness、Claude、Cursor、Codex 等）。' +
  '开始任务时可用 memory_current 或 memory_digest 了解用户正在做的事；' +
  '用户说“记住”时用 memory_remember；需要跨应用找上下文时用 memory_search；' +
  '用户要求忘记/纠正时用 memory_forget；连接异常时用 memory_status 诊断。';

let warnedUnparseableLine = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

function negotiateProtocol(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)) return requested;
  return DEFAULT_PROTOCOL;
}

async function handleRequest(method, params, id) {
  switch (method) {
    case 'initialize': {
      const p = params && typeof params === 'object' ? params : {};
      return {
        protocolVersion: negotiateProtocol(p.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      };
    }

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call': {
      const p = params && typeof params === 'object' ? params : {};
      const name = typeof p.name === 'string' ? p.name : '';
      if (!name) {
        return toolFail('tools/call 缺少工具名 name。可用工具：' + TOOLS.map((t) => t.name).join('、'));
      }
      const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
      return callTool(name, args);
    }

    case 'resources/list':
      return { resources: RESOURCES };

    case 'resources/read': {
      const p = params && typeof params === 'object' ? params : {};
      const uri = typeof p.uri === 'string' ? p.uri : '';
      if (!uri) throw new BridgeError('resources/read 缺少参数 uri。');
      return readResource(uri);
    }

    case 'shutdown':
      return null;

    default:
      throw new MethodNotFoundError(method);
  }
}

function isNotification(method) {
  if (typeof method !== 'string') return false;
  return (
    method === 'notifications/initialized' ||
    method === 'initialized' ||
    method === 'notifications/cancelled' ||
    method === 'notifications/roots/list_changed' ||
    method === 'notifications/progress'
  );
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    const recovered = recoverId(trimmed);
    if (recovered.found) {
      sendError(recovered.id, -32700, `JSON 解析失败：${error.message}`);
    } else if (!warnedUnparseableLine) {
      warnedUnparseableLine = true;
      log(`忽略无法解析的输入行（没有可恢复的 id）：${clip(trimmed, 200)}`);
    } else {
      log(`忽略无法解析的输入行：${clip(trimmed, 200)}`);
    }
    return;
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    log('忽略非对象 JSON-RPC 消息。');
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = hasId ? message.id : undefined;
  const method = message.method;
  const params = message.params;

  if (typeof method !== 'string') {
    if (hasId) sendError(id, -32600, '无效请求：缺少 method 字符串。');
    else log('忽略没有 method 的消息。');
    return;
  }

  if (isNotification(method)) return;

  if (method === 'exit' && !hasId) {
    process.exit(0);
  }

  try {
    const result = await handleRequest(method, params, id);
    if (!hasId) return;
    if (result === undefined) return;
    sendResult(id, result);
  } catch (error) {
    if (error instanceof MethodNotFoundError) {
      if (hasId) sendError(id, -32601, error.message);
      else log(`忽略未知通知方法：${method}`);
      return;
    }
    if (!hasId) {
      log(`处理通知 ${method} 失败：${(error && error.message) || error}`);
      return;
    }
    if (error instanceof BridgeError) sendError(id, -32603, error.message);
    else sendError(id, -32603, `内部错误：${(error && error.message) || error}`);
  }
}

/**
 * 从一行坏 JSON 里尽量捞出 id，保证能回一个 JSON-RPC 错误而不是静默。
 */
function recoverId(line) {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(line);
  if (!match) return { found: false, id: null };
  try {
    return { found: true, id: JSON.parse(match[1]) };
  } catch {
    return { found: false, id: null };
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  let closed = false;

  rl.on('line', (line) => {
    chain = chain.then(() => handleLine(line)).catch((error) => {
      log(`处理输入行时出错：${(error && error.message) || error}`);
    });
  });

  rl.on('close', () => {
    closed = true;
    // stdin EOF：先等正在处理的请求（最多受 5s HTTP 超时约束）写完响应，再干净退出。
    chain.finally(() => process.exit(0));
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  process.on('uncaughtException', (error) => {
    log(`未捕获异常：${(error && error.stack) || error}`);
    if (!closed) {
      // 协议继续可用：不退出，交给客户端决定。
    }
  });

  process.on('unhandledRejection', (reason) => {
    log(`未处理的 Promise 拒绝：${(reason && reason.message) || reason}`);
  });

  log(`MCP 桥已启动（stdio）。服务地址解析：${describeUrlSource(discover().urlSource)}。`);
}

main();
