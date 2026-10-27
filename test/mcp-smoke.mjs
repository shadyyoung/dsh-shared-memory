#!/usr/bin/env node
/**
 * 共享记忆 MCP 桥冒烟测试
 *
 * 启动一个最小 mock HTTP API（实现 API.md 的 health/search/remember/current/digest/forget），
 * 用 DSH_MEMORY_URL 把 mcp/server.mjs 指过去，然后通过 stdio 驱动桥：
 * initialize → ping → tools/list → tools/call ×N → resources → 异常路径 → EOF 退出。
 *
 * 运行：node test/mcp-smoke.mjs
 * 成功退出码 0；失败打印明确原因并以非 0 退出。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.resolve(HERE, '..', 'mcp', 'server.mjs');
const TOKEN = 'smoke-test-token';
const TMP_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shared-memory-smoke-'));

const expectedTools = [
  'memory_current',
  'memory_digest',
  'memory_forget',
  'memory_remember',
  'memory_search',
  'memory_status',
  'memory_update',
];

// ---------------------------------------------------------------------------
// 最小 mock HTTP API
// ---------------------------------------------------------------------------

const now = Date.now();
const store = {
  memories: [
    {
      id: 'mem_seed_1',
      kind: 'preference',
      text: '用户喜欢直接给结论',
      tags: ['写作'],
      source: { app: 'dsh', sessionId: 'sess_alpha' },
      createdAt: now - 600_000,
      updatedAt: now - 600_000,
    },
  ],
  focus: null,
  activity: [
    {
      sessionId: 'sess_alpha',
      cwd: '/Users/kai/Documents/deepseek-harness/default-workspace',
      app: 'dsh',
      lastUser: '帮我做共享记忆插件',
      lastAssistant: '好的，先写 MCP 桥。',
      messageCount: 12,
      updatedAt: now - 120_000,
    },
  ],
  requests: [],
  lastRememberBody: null,
  lastDigestMaxChars: null,
  memorySeq: 0,
};

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function stats() {
  return {
    memories: store.memories.length,
    messages: store.memories.filter((m) => m.kind === 'message').length,
    sessions: store.activity.length,
    hasFocus: Boolean(store.focus && store.focus.text),
  };
}

const apiServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  store.requests.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    authorization: req.headers.authorization || '',
  });

  if (url.pathname === '/dsh-memory/health' && req.method === 'GET') {
    return reply(200, {
      ok: true,
      name: 'dsh-shared-memory',
      version: '1.0.0',
      startedAt: now - 3_600_000,
      storeDir: TMP_STORE,
      stats: stats(),
    });
  }

  if (!url.pathname.startsWith('/dsh-memory/api/')) {
    return reply(404, { error: { code: 'NOT_FOUND', message: `未知路径：${url.pathname}` } });
  }

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return reply(401, { error: { code: 'UNAUTHORIZED', message: 'missing or invalid token' } });
  }

  if (url.pathname === '/dsh-memory/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const kinds = (url.searchParams.get('kind') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const tag = url.searchParams.get('tag') || '';
    const rawLimit = Number(url.searchParams.get('limit') || 20);
    const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));

    let items = store.memories.filter((memory) => {
      if (q) {
        const haystack = [memory.text, ...(memory.tags || [])].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (kinds.length && !kinds.includes(memory.kind)) return false;
      if (tag && !(memory.tags || []).includes(tag)) return false;
      return true;
    });
    items = items.slice().sort((a, b) => b.createdAt - a.createdAt);
    return reply(200, { items: items.slice(0, limit), total: items.length, query: q });
  }

  if (url.pathname === '/dsh-memory/api/current' && req.method === 'GET') {
    return reply(200, {
      focus: store.focus,
      activity: store.activity.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      recent: store.memories.filter((m) => m.kind !== 'message').slice(0, 10),
    });
  }

  if (url.pathname === '/dsh-memory/api/current' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body) return reply(400, { error: { code: 'BAD_REQUEST', message: '非法 JSON' } });
    if (body.clear === true) {
      store.focus = null;
      return reply(200, { focus: null });
    }
    if (body.focus === undefined && body.nextSteps === undefined) {
      return reply(400, {
        error: { code: 'BAD_REQUEST', message: 'focus/nextSteps/clear 至少一个' },
      });
    }
    if (typeof body.focus === 'string') {
      store.focus = {
        text: body.focus,
        nextSteps: Array.isArray(body.nextSteps) ? body.nextSteps : [],
        updatedAt: Date.now(),
        updatedBy: 'mcp',
        auto: false,
      };
    } else if (store.focus) {
      store.focus.nextSteps = Array.isArray(body.nextSteps)
        ? body.nextSteps
        : store.focus.nextSteps;
      store.focus.updatedAt = Date.now();
    }
    return reply(200, { focus: store.focus });
  }

  if (url.pathname === '/dsh-memory/api/digest' && req.method === 'GET') {
    store.lastDigestMaxChars = url.searchParams.get('maxChars');
    const text = [
      '# 共享记忆摘要（mock）',
      '',
      `- 当前焦点：${store.focus ? store.focus.text : '暂无'}`,
      `- 记忆总数：${store.memories.length}`,
      `- 请求 maxChars：${store.lastDigestMaxChars ?? '未传'}`,
      '',
    ].join('\n');
    return reply(200, { text, generatedAt: Date.now() });
  }

  if (url.pathname === '/dsh-memory/api/remember' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || typeof body.text !== 'string' || !body.text.trim()) {
      return reply(400, { error: { code: 'BAD_REQUEST', message: 'text 必填' } });
    }
    store.lastRememberBody = body;
    const kind = body.kind || 'note';
    const existing = store.memories.find((m) => m.kind === kind && m.text === body.text);
    if (existing) return reply(200, { item: existing, deduped: true });
    store.memorySeq += 1;
    const item = {
      id: `mem_test_${store.memorySeq}`,
      kind,
      text: body.text,
      tags: Array.isArray(body.tags) ? body.tags : [],
      source: body.source || { app: 'http' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.memories.unshift(item);
    return reply(200, { item, deduped: false });
  }

  if (url.pathname === '/dsh-memory/api/forget' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || (!body.id && !body.q)) {
      return reply(400, { error: { code: 'BAD_REQUEST', message: 'id 或 q 必填' } });
    }
    const removed = store.memories.filter((memory) => {
      if (body.id) return memory.id === body.id;
      const matchText = memory.text.toLowerCase().includes(String(body.q).toLowerCase());
      const matchKind = !body.kind || memory.kind === body.kind;
      return matchText && matchKind;
    });
    if (removed.length) {
      const ids = new Set(removed.map((m) => m.id));
      store.memories = store.memories.filter((m) => !ids.has(m.id));
    }
    return reply(200, { deleted: removed.length, ids: removed.map((m) => m.id) });
  }

  if (url.pathname === '/dsh-memory/api/update' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const item = Array.isArray(store.memories) ? store.memories.find((memory) => memory.id === (body && body.id)) : null;
    if (!item) return reply(404, { error: { code: 'NOT_FOUND', message: '记忆不存在' } });
    if (typeof body.text === 'string') item.text = body.text;
    if (typeof body.kind === 'string') item.kind = body.kind;
    if (Array.isArray(body.tags)) item.tags = body.tags;
    item.updatedAt = Date.now();
    return reply(200, { item });
  }

  return reply(404, {
    error: { code: 'NOT_FOUND', message: `未知 API：${req.method} ${url.pathname}` },
  });
});

// ---------------------------------------------------------------------------
// MCP 客户端（stdio 驱动）
// ---------------------------------------------------------------------------

function createClient({ env = {}, args = [] } = {}) {
  const child = spawn(process.execPath, [BRIDGE_PATH, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  const waiters = new Map();
  const nonProtocolLines = [];
  let buffer = '';
  let stderr = '';
  let exited = false;
  let nextId = 1;

  child.stdin.on('error', () => {});

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(`MCP 桥提前退出（code=${code}, signal=${signal}）。stderr:\n${stderr}`),
        );
      }
      waiters.clear();
      if (buffer.trim()) nonProtocolLines.push(buffer);
      buffer = '';
      resolve({ code, signal, stderr });
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        nonProtocolLines.push(line);
        continue;
      }
      if (message && typeof message === 'object' && Object.hasOwn(message, 'id')) {
        const waiter = waiters.get(message.id);
        if (waiter) {
          waiters.delete(message.id);
          waiter.resolve(message);
        }
      }
    }
  });

  function waitFor(id, label, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`等待 ${label}（id=${id}）响应超时。stderr:\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          try {
            assert.equal(message.jsonrpc, '2.0', `${label}: jsonrpc 必须是 2.0`);
            assert.equal(message.id, id, `${label}: 响应 id 必须回显请求 id`);
            resolve(message);
          } catch (error) {
            reject(error);
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
    });
  }

  function writeRaw(line) {
    if (exited) throw new Error('MCP 桥已退出，无法写入');
    child.stdin.write(line.endsWith('\n') ? line : `${line}\n`);
  }

  function sendWithId(id, method, params, timeoutMs) {
    const promise = waitFor(id, method, timeoutMs);
    writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return promise;
  }

  function request(method, params) {
    const id = nextId;
    nextId += 1;
    return sendWithId(id, method, params);
  }

  async function close({ expectExitCode = 0 } = {}) {
    if (!exited) child.stdin.end();
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('MCP 桥在 stdin EOF 后 5 秒内没有退出')),
        5_000,
      );
      timer.unref?.();
    });
    const info = await Promise.race([exitPromise, timeout]);
    assert.equal(info.signal, null, 'MCP 桥不应被信号杀死');
    assert.equal(info.code, expectExitCode, 'MCP 桥退出码不对');
    assert.deepEqual(
      nonProtocolLines,
      [],
      `stdout 出现非协议输出：${nonProtocolLines.join('\n')}`,
    );
    return info;
  }

  function kill() {
    if (!exited) child.kill('SIGKILL');
  }

  return { request, sendWithId, waitFor, writeRaw, close, kill, getStderr: () => stderr };
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------

let checks = 0;
function check(name, fn) {
  try {
    fn();
    checks += 1;
    process.stdout.write(`✔ ${name}\n`);
  } catch (error) {
    throw new Error(`断言失败「${name}」：${error.message}`);
  }
}

async function main() {
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiPort = apiServer.address().port;
  const apiBase = `http://127.0.0.1:${apiPort}/dsh-memory`;

  // 一个必然没有服务监听的端口，用于测试优雅错误文本。
  const deadProbe = http.createServer(() => {});
  await new Promise((resolve) => deadProbe.listen(0, '127.0.0.1', resolve));
  const deadPort = deadProbe.address().port;
  await new Promise((resolve) => deadProbe.close(resolve));
  const deadBase = `http://127.0.0.1:${deadPort}/dsh-memory`;

  const clients = [];
  const client = createClient({
    env: { DSH_MEMORY_URL: apiBase, DSH_MEMORY_TOKEN: TOKEN },
    args: [`--store=${TMP_STORE}`],
  });
  clients.push(client);

  // 1. initialize：版本回显 + 能力 + serverInfo
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke-test', version: '1.0.0' },
  });
  check('initialize 回显受支持的协议版本', () => {
    assert.equal(init.result.protocolVersion, '2025-06-18');
  });
  check('initialize serverInfo.name 为 dsh-shared-memory', () => {
    assert.equal(init.result.serverInfo.name, 'dsh-shared-memory');
    assert.equal(typeof init.result.serverInfo.version, 'string');
  });
  check('initialize 声明 tools/resources 能力（listChanged:false）', () => {
    assert.deepEqual(init.result.capabilities.tools, { listChanged: false });
    assert.deepEqual(init.result.capabilities.resources, {
      listChanged: false,
      subscribe: false,
    });
  });

  // 2. initialized 通知 + ping
  client.writeRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const ping = await client.request('ping', {});
  check('ping 返回空对象', () => {
    assert.deepEqual(ping.result, {});
  });

  // 3. tools/list：名称、schema、双语描述
  const list = await client.request('tools/list', {});
  check('tools/list 暴露 API.md 规定的 7 个工具', () => {
    const names = list.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, expectedTools);
  });
  check('每个工具都有 object inputSchema 和中英双语 description', () => {
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema.type`);
      assert.ok(tool.inputSchema.properties, `${tool.name} 缺少 properties`);
      assert.ok(tool.description.length > 20, `${tool.name} description 太短`);
      assert.match(tool.description, /[\u4e00-\u9fff]/, `${tool.name} description 需要中文`);
      assert.match(tool.description, /[A-Za-z]{3}/, `${tool.name} description 需要英文`);
    }
    const remember = list.result.tools.find((tool) => tool.name === 'memory_remember');
    assert.deepEqual(remember.inputSchema.required, ['text']);
  });

  // 4. memory_status
  const status = await client.request('tools/call', {
    name: 'memory_status',
    arguments: {},
  });
  check('memory_status 返回服务状态文本（isError:false）', () => {
    assert.equal(status.result.isError, false);
    const text = status.result.content[0].text;
    assert.equal(status.result.content[0].type, 'text');
    assert.match(text, /共享记忆服务运行中/);
    assert.match(text, /dsh-shared-memory/);
    assert.ok(text.includes(apiBase), '状态文本应包含当前 API 地址');
  });
  check('memory_status 请求带上了 Bearer token 并命中 /health', () => {
    const health = store.requests.find((request) => request.path === '/dsh-memory/health');
    assert.ok(health, '没有请求 /health');
    assert.equal(health.authorization, `Bearer ${TOKEN}`);
  });

  // 5. memory_remember + dedupe
  const remember = await client.request('tools/call', {
    name: 'memory_remember',
    arguments: { text: '用户要求回答保持简洁', kind: 'preference', tags: ['写作', '风格'] },
  });
  check('memory_remember 返回可读结果且 id 前缀正确', () => {
    assert.equal(remember.result.isError, false);
    const text = remember.result.content[0].text;
    assert.match(text, /已记住/);
    assert.match(text, /mem_test_1/);
    assert.match(text, /preference/);
    assert.match(text, /#写作/);
  });
  check('memory_remember 自动标注 source.app = mcp', () => {
    assert.equal(store.lastRememberBody.source.app, 'mcp');
    assert.deepEqual(store.lastRememberBody.tags, ['写作', '风格']);
  });
  const dedupe = await client.request('tools/call', {
    name: 'memory_remember',
    arguments: { text: '用户要求回答保持简洁', kind: 'preference' },
  });
  check('重复写入返回 deduped 提示', () => {
    assert.equal(dedupe.result.isError, false);
    assert.match(dedupe.result.content[0].text, /deduped：true/);
  });

  // 6. memory_search：带 q 和只取最近
  const search = await client.request('tools/call', {
    name: 'memory_search',
    arguments: { q: '结论', limit: 5 },
  });
  check('memory_search 输出 id/kind/日期/正文的项目符号列表', () => {
    assert.equal(search.result.isError, false);
    const text = search.result.content[0].text;
    assert.match(text, /共 1 条，显示 1 条/);
    assert.match(
      text,
      /- \[mem_seed_1\] preference · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 用户喜欢直接给结论/,
    );
    assert.match(text, /#写作/);
  });
  check('memory_search 把 q/limit 传给后端', () => {
    const request = [...store.requests]
      .reverse()
      .find((item) => item.path === '/dsh-memory/api/search' && item.query.q === '结论');
    assert.ok(request, '没有找到 q=结论 的搜索请求');
    assert.equal(request.query.limit, '5');
  });
  const recent = await client.request('tools/call', {
    name: 'memory_search',
    arguments: { limit: 2 },
  });
  check('memory_search 不带 q 时按最近记忆展示', () => {
    const text = recent.result.content[0].text;
    assert.match(text, /最近记忆：共 2 条，显示 2 条/);
  });

  // 7. memory_current：读取 / 设置 / 再读取
  const currentEmpty = await client.request('tools/call', {
    name: 'memory_current',
    arguments: {},
  });
  check('memory_current 无参数时读取焦点、动态和最近记忆', () => {
    assert.equal(currentEmpty.result.isError, false);
    const text = currentEmpty.result.content[0].text;
    assert.match(text, /## 当前焦点/);
    assert.match(text, /暂无焦点/);
    assert.match(text, /## 最近会话动态（1）/);
    assert.match(text, /\[dsh\] sess_alpha/);
    assert.match(text, /## 最近记忆（2）/);
  });
  const setFocus = await client.request('tools/call', {
    name: 'memory_current',
    arguments: { focus: '完成共享记忆 MCP 桥', nextSteps: ['写 server.mjs', '跑冒烟测试'] },
  });
  check('memory_current 设置焦点并格式化下一步', () => {
    assert.equal(setFocus.result.isError, false);
    const text = setFocus.result.content[0].text;
    assert.match(text, /已更新当前焦点：完成共享记忆 MCP 桥/);
    assert.match(text, /1\. 写 server\.mjs/);
    assert.match(text, /2\. 跑冒烟测试/);
  });
  const currentAfter = await client.request('tools/call', {
    name: 'memory_current',
    arguments: {},
  });
  check('memory_current 重新读取能看到刚设置的焦点', () => {
    const text = currentAfter.result.content[0].text;
    assert.match(text, /完成共享记忆 MCP 桥/);
    assert.match(text, /下一步：/);
    assert.match(text, /更新于 \d{4}-\d{2}-\d{2}/);
  });

  // 8. memory_digest
  const digest = await client.request('tools/call', {
    name: 'memory_digest',
    arguments: { maxChars: 500 },
  });
  check('memory_digest 返回 Markdown 摘要且透传 maxChars', () => {
    assert.equal(digest.result.isError, false);
    assert.match(digest.result.content[0].text, /共享记忆摘要（mock）/);
    assert.equal(store.lastDigestMaxChars, '500');
  });

  // 9. memory_forget
  const forget = await client.request('tools/call', {
    name: 'memory_forget',
    arguments: { q: '简洁' },
  });
  check('memory_forget 按关键词删除并返回 id', () => {
    assert.equal(forget.result.isError, false);
    const text = forget.result.content[0].text;
    assert.match(text, /已删除 1 条记忆/);
    assert.match(text, /mem_test_1/);
  });
  const searchGone = await client.request('tools/call', {
    name: 'memory_search',
    arguments: { q: '简洁' },
  });
  check('删除后搜索不到该记忆', () => {
    assert.match(searchGone.result.content[0].text, /没有找到匹配的共享记忆/);
  });

  // 9b. memory_update
  await client.request('tools/call', {
    name: 'memory_remember',
    arguments: { text: '临时记忆：待更新', kind: 'note' },
  });
  const target = store.memories.find((memory) => memory.text === '临时记忆：待更新');
  const update = await client.request('tools/call', {
    name: 'memory_update',
    arguments: { id: target.id, text: '更新后的正文', kind: 'project', tags: ['updated'] },
  });
  check('memory_update 原地编辑并保留 id', () => {
    assert.equal(update.result.isError, false);
    const text = update.result.content[0].text;
    assert.match(text, /更新后的正文/);
    assert.equal(target.text, '更新后的正文');
    assert.equal(target.kind, 'project');
    assert.deepEqual(target.tags, ['updated']);
  });

  // 10. resources/list + resources/read
  const resources = await client.request('resources/list', {});
  check('resources/list 暴露 memory://digest 与 memory://current', () => {
    const uris = resources.result.resources.map((resource) => resource.uri).sort();
    assert.deepEqual(uris, ['memory://current', 'memory://digest']);
    for (const resource of resources.result.resources) {
      assert.ok(resource.mimeType);
      assert.ok(resource.description);
    }
  });
  const readDigest = await client.request('resources/read', { uri: 'memory://digest' });
  check('resources/read memory://digest 返回 Markdown 文本', () => {
    const content = readDigest.result.contents[0];
    assert.equal(content.uri, 'memory://digest');
    assert.equal(content.mimeType, 'text/markdown');
    assert.match(content.text, /共享记忆摘要（mock）/);
  });
  const readCurrent = await client.request('resources/read', { uri: 'memory://current' });
  check('resources/read memory://current 返回可解析的 JSON', () => {
    const content = readCurrent.result.contents[0];
    assert.equal(content.mimeType, 'application/json');
    const parsed = JSON.parse(content.text);
    assert.equal(parsed.focus.text, '完成共享记忆 MCP 桥');
    assert.equal(parsed.activity.length, 1);
  });

  // 11. 异常路径
  const badMethod = await client.request('tools/unknown_method', {});
  check('未知方法返回 JSON-RPC -32601', () => {
    assert.equal(badMethod.error.code, -32601);
    assert.match(badMethod.error.message, /未知方法/);
  });
  const badResource = await client.request('resources/read', { uri: 'memory://nope' });
  check('未知资源返回 JSON-RPC 错误', () => {
    assert.ok(badResource.error, '应当返回 error');
    assert.match(badResource.error.message, /未知资源/);
  });
  const badTool = await client.request('tools/call', {
    name: 'memory_nope',
    arguments: {},
  });
  check('未知工具返回 isError:true 的可读提示', () => {
    assert.equal(badTool.result.isError, true);
    assert.match(badTool.result.content[0].text, /未知工具/);
  });
  const missingText = await client.request('tools/call', {
    name: 'memory_remember',
    arguments: {},
  });
  check('memory_remember 缺 text 时返回 isError:true 提示', () => {
    assert.equal(missingText.result.isError, true);
    assert.match(missingText.result.content[0].text, /缺少必填参数 text/);
  });

  // 12. 坏 JSON 行：能恢复 id 就回 -32700
  const badClient = createClient({
    env: { DSH_MEMORY_URL: apiBase, DSH_MEMORY_TOKEN: TOKEN },
    args: [`--store=${TMP_STORE}`],
  });
  clients.push(badClient);
  const initBad = await badClient.request('initialize', {
    protocolVersion: '2099-01-01',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke-test-bad-json', version: '1.0.0' },
  });
  check('未知协议版本回退到 2024-11-05', () => {
    assert.equal(initBad.result.protocolVersion, '2024-11-05');
  });
  const badJsonPromise = badClient.waitFor(778, 'malformed-json-line');
  badClient.writeRaw('{"jsonrpc":"2.0","id":778,"method":"tools/list"');
  const badJson = await badJsonPromise;
  check('坏 JSON 行可恢复 id 时返回 -32700', () => {
    assert.equal(badJson.error.code, -32700);
    assert.match(badJson.error.message, /JSON 解析失败/);
  });
  await badClient.close();
  check('异常客户端 stdout 无日志污染', () => {
    assert.match(badClient.getStderr(), /MCP 桥已启动/);
  });

  // 13. EOF 干净退出
  await client.close();
  check('主客户端 stdin EOF 后退出码 0', () => {
    checks += 0;
  });

  // 14. 服务不可达时的优雅错误文本（额外客户端，指到死端口）
  const deadClient = createClient({
    env: { DSH_MEMORY_URL: deadBase, DSH_MEMORY_TOKEN: '' },
    args: [`--store=${TMP_STORE}`],
  });
  clients.push(deadClient);
  await deadClient.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke-test-dead', version: '1.0.0' },
  });
  const deadStatus = await deadClient.request('tools/call', {
    name: 'memory_status',
    arguments: {},
  });
  check('服务未运行时 memory_status 返回 isError:true 和中文提示', () => {
    assert.equal(deadStatus.result.isError, true);
    const text = deadStatus.result.content[0].text;
    assert.match(text, /共享记忆服务未运行/);
    assert.match(text, /不可达/);
    assert.match(text, /请先打开 DeepSeek Harness/);
    assert.ok(text.includes(deadBase), '错误文本应包含不可达的 URL');
  });
  await deadClient.close();

  // 15. 401 token 提示（/api/* 需要 token；/health 不需要）
  const noTokenClient = createClient({
    env: { DSH_MEMORY_URL: apiBase, DSH_MEMORY_TOKEN: '' },
    args: [`--store=${TMP_STORE}`],
  });
  clients.push(noTokenClient);
  await noTokenClient.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke-test-no-token', version: '1.0.0' },
  });
  const unauthorized = await noTokenClient.request('tools/call', {
    name: 'memory_search',
    arguments: { q: '结论' },
  });
  check('401 时提示 DSH_MEMORY_TOKEN', () => {
    assert.equal(unauthorized.result.isError, true);
    const text = unauthorized.result.content[0].text;
    assert.match(text, /HTTP 401/);
    assert.match(text, /DSH_MEMORY_TOKEN/);
  });
  await noTokenClient.close();

  // 16. CLI --url 覆盖 env（便捷参数）
  const cliClient = createClient({
    env: { DSH_MEMORY_URL: deadBase, DSH_MEMORY_TOKEN: TOKEN },
    args: [`--store=${TMP_STORE}`, `--url=${apiBase}`],
  });
  clients.push(cliClient);
  await cliClient.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke-test-cli', version: '1.0.0' },
  });
  const cliStatus = await cliClient.request('tools/call', {
    name: 'memory_status',
    arguments: {},
  });
  check('--url 优先于 DSH_MEMORY_URL', () => {
    assert.equal(cliStatus.result.isError, false);
    assert.match(cliStatus.result.content[0].text, /共享记忆服务运行中/);
  });
  await cliClient.close();

  check('mock 服务收到至少 10 个 API 请求', () => {
    assert.ok(store.requests.length >= 10, `只有 ${store.requests.length} 个请求`);
  });

  return clients;
}

main()
  .then(async () => {
    await new Promise((resolve) => {
      apiServer.closeAllConnections?.();
      apiServer.close(resolve);
    });
    fs.rmSync(TMP_STORE, { recursive: true, force: true });
    process.stdout.write(`\n✅ MCP 冒烟测试通过：${checks} 项断言\n`);
    process.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(`\n❌ MCP 冒烟测试失败：${error && error.message}\n`);
    if (error && error.stack) process.stderr.write(`${error.stack}\n`);
    apiServer.closeAllConnections?.();
    apiServer.close();
    try {
      fs.rmSync(TMP_STORE, { recursive: true, force: true });
    } catch {
      // ignore
    }
    process.exit(1);
  });
