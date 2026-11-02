/**
 * 后台逻辑集成测试（Node，零依赖）。
 *
 * 做法：用最小 mock 实现 chrome.* API，把 src/background.js 当 ESM 模块加载，
 * 再起一个本地 HTTP 服务同时扮演「被监控的网页」和「DSH-IM 投递接口」，
 * 从而真实地跑一遍：保存监控 → 建立基线 → 内容变化 → 投递成功/失败 → 重试 → 关键词过滤。
 *
 * 运行：node tools/integration.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeValue } from '../src/extract.js';

// ---------------------------------------------------------------------------
// 1. mock chrome.*
// ---------------------------------------------------------------------------

const store = new Map();
const listeners = { message: [], alarm: [], installed: [], startup: [] };
const alarms = new Map();
const notifications = [];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// ---------------------------------------------------------------------------
// 标签页 / 窗口的轻量模型（模拟「静默抓取」用的隐藏窗口与常驻标签页）
// ---------------------------------------------------------------------------

const PROBE_TAB_ID = 901;
const tabWorld = {
  nextId: 900,
  nextWindowId: 1,
  windows: new Map(),
  tabs: new Map(),
  windowCreates: 0,
  tabCreates: 0,
  tabUpdates: 0,
  createOptions: [],
};

function renderPageHtml() {
  return `<!doctype html><html><body><div id="content" data-value="${world.pageValue}">${world.pageValue}</div></body></html>`;
}

function renderTasksHtml() {
  const rows = world.tasks
    .map((task) => `<tr data-key="${task.key}" data-status="${task.status}"><td>${task.key}</td><td>${task.status}</td></tr>`)
    .join('');
  return `<!doctype html><html><body><table><tbody>${rows}</tbody></table></body></html>`;
}

function pageHtmlFor(url) {
  const text = String(url ?? '');
  if (text.includes('/tasks') || text.includes('console.sensecore.cn')) return renderTasksHtml();
  if (text.includes('/page')) return renderPageHtml();
  return '<!doctype html><html><body></body></html>';
}

/** 标签页 id → 当前 URL（PROBE_TAB_ID 是「用户正开着的页面」的虚拟标签页）。 */
function urlForTab(tabId) {
  if (tabId === PROBE_TAB_ID) return world.probeTabUrl ?? `${base}/tasks`;
  return tabWorld.tabs.get(tabId)?.url ?? '';
}

/** 模拟 detectTables：只要 HTML 里有 tr[data-key] 就给一个可用候选。 */
function detectResultForHtml(html) {
  const keys = [...String(html ?? '').matchAll(/data-key="([^"]*)"/gu)].map((match) => match[1]);
  if (keys.length === 0) {
    return { loginRequired: false, stats: { tables: 1, trs: 0, roots: 1 }, candidates: [] };
  }
  return {
    loginRequired: false,
    stats: { tables: 1, trs: keys.length, roots: 1 },
    candidates: [{
      rowSelector: 'tbody tr',
      keySelector: 'td:nth-child(1)',
      statusSelector: 'td:nth-child(2)',
      headers: ['任务名称', '状态'],
      samples: keys.slice(0, 3).map((key) => ({ key, value: '' })),
      rowCount: keys.length,
      note: '',
    }],
  };
}

globalThis.chrome = {
  storage: {
    local: {
      async get(defaults) {
        const out = {};
        for (const [key, fallback] of Object.entries(defaults)) {
          out[key] = store.has(key) ? clone(store.get(key)) : clone(fallback);
        }
        return out;
      },
      async set(patch) {
        for (const [key, value] of Object.entries(patch)) store.set(key, clone(value));
      },
    },
  },
  runtime: {
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    async sendMessage(message) {
      // 模拟离屏文档：解析（rows/single）与结构探测（detect）
      const html = String(message?.html ?? '');

      if (message?.type === 'offscreen/detect') {
        return detectResultForHtml(html);
      }

      if (message?.type === 'offscreen/detect-main') {
        const text = html.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
        if (text.length < 80) return { ok: false, reason: 'content-empty' };
        return { ok: true, selector: 'body', length: text.length, preview: text.slice(0, 160) };
      }

      if (message?.type === 'offscreen/parse') {
        const extraction = message.extraction ?? {};

        if (extraction.extractMode === 'rows') {
          if (!extraction.rowSelector || !extraction.statusSelector) {
            return { ok: false, reason: 'selector-invalid' };
          }
          const rows = [...html.matchAll(/<tr data-key="([^"]*)" data-status="([^"]*)">/gu)]
            .map((match) => ({ key: match[1], value: match[2] }));
          if (rows.length === 0) {
            // 模拟真实页面：表格与 tr 都在，只是行选择器路径不对
            return { ok: false, reason: 'rows-empty', matched: 0, totalTr: 13, tbodyTr: 11 };
          }
          // 只有「第 2 列是状态」这个选择器才取得到值，其他一律模拟取错列
          if (extraction.statusSelector !== 'td:nth-child(2)') {
            return {
              ok: false,
              reason: 'rows-status-empty',
              matched: rows.length,
              statusSelector: extraction.statusSelector,
              sample: rows.map((row, index) => `${index + 1}."${row.key}"`),
            };
          }
          if (rows.every((row) => !row.value)) {
            return {
              ok: false,
              reason: 'rows-status-empty',
              matched: rows.length,
              statusSelector: extraction.statusSelector,
              sample: rows.map((row, index) => `${index + 1}."${row.key}"`),
            };
          }
          return { ok: true, rows, count: rows.length };
        }

        const selector = String(extraction.selector ?? '');
        if (selector === 'body') {
          const text = html.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
          if (!text) return { ok: false, reason: 'selector-not-found' };
          return { ok: true, value: text };
        }
        if (selector !== '#content') return { ok: false, reason: 'selector-not-found' };
        const match = /data-value="([^"]*)"/u.exec(html);
        if (!match) return { ok: false, reason: 'selector-not-found' };
        return { ok: true, value: normalizeValue(match[1]) };
      }
      return undefined;
    },
  },
  alarms: {
    async clear(name) {
      alarms.delete(name);
      return true;
    },
    create(name, info) {
      alarms.set(name, info);
    },
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
  permissions: {
    async contains() {
      return true;
    },
  },
  offscreen: {
    async hasDocument() {
      return true;
    },
    async createDocument() {},
  },
  windows: {
    async create(options) {
      tabWorld.windowCreates += 1;
      tabWorld.createOptions.push(options ?? {});
      const id = tabWorld.nextWindowId++;
      tabWorld.windows.set(id, { id });
      const tab = { id: tabWorld.nextId++, windowId: id, url: 'about:blank' };
      tabWorld.tabs.set(tab.id, tab);
      return { id, tabs: [tab] };
    },
    async get(id) {
      if (!tabWorld.windows.has(id)) throw new Error(`No window with id: ${id}.`);
      return { id };
    },
    async remove(id) {
      tabWorld.windows.delete(id);
      for (const [tabId, tab] of [...tabWorld.tabs]) {
        if (tab.windowId === id) tabWorld.tabs.delete(tabId);
      }
    },
  },
  tabs: {
    async create({ windowId, url } = {}) {
      tabWorld.tabCreates += 1;
      const id = tabWorld.nextId++;
      const tab = { id, windowId: windowId ?? 1, url: url ?? 'about:blank' };
      tabWorld.tabs.set(id, tab);
      return tab;
    },
    async update(id, patch = {}) {
      tabWorld.tabUpdates += 1;
      const tab = tabWorld.tabs.get(id) ?? { id, windowId: 1, url: 'about:blank' };
      if (patch.url) tab.url = patch.url;
      tabWorld.tabs.set(id, tab);
      return tab;
    },
    async remove(id) {
      tabWorld.tabs.delete(id);
    },
    async get(id) {
      if (id === PROBE_TAB_ID) {
        return {
          id,
          windowId: 1,
          url: world.probeTabUrl ?? `${base}/tasks`,
          title: '训练任务列表',
          status: 'complete',
        };
      }
      const tab = tabWorld.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      return { ...tab, status: 'complete' };
    },
    async query(filters = {}) {
      if (filters.active) {
        return [{
          id: PROBE_TAB_ID,
          windowId: 1,
          url: world.probeTabUrl ?? `${base}/tasks`,
          title: '训练任务列表',
          active: true,
        }];
      }
      if (filters.windowId) {
        return [...tabWorld.tabs.values()].filter((tab) => tab.windowId === filters.windowId);
      }
      return [...tabWorld.tabs.values()];
    },
    onUpdated: { addListener() {}, removeListener() {} },
  },
  scripting: {
    async executeScript({ target, func, args } = {}) {
      const source = String(func);
      const url = urlForTab(target?.tabId);
      const html = pageHtmlFor(url);

      if (source.includes('readyState')) return [{ result: 'complete' }];
      if (source.includes('document.documentElement.outerHTML')) return [{ result: html }];
      if (source.includes('document.querySelector(css)')) return [{ result: true }];
      // detectTables 的源码里也含 location.href，必须先判断它
      if (source.includes('loginRequired')) {
        return [{ result: detectResultForHtml(html) }];
      }
      if (source.includes('location.href')) {
        return [{ result: { url, title: url.includes('/tasks') ? '训练任务列表' : '测试页面' } }];
      }
      void args;
      return [{ result: '' }];
    },
  },
  notifications: {
    async create(id, options) {
      notifications.push({ id, options });
      return id;
    },
  },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
  },
};

// ---------------------------------------------------------------------------
// 2. 本地服务器：//page 扮演网页，/api/... 扮演 DSH-IM
// ---------------------------------------------------------------------------

const world = {
  pageValue: '公告：原内容',
  pageStatus: 200,
  deliveryMode: 'ok', // ok | bot-not-connected | target-rejected
  deliveries: [],
  probeTabUrl: null, // 为 null 时用 /tasks（列表页）；测试通用兜底时改成 /page
  tasks: [
    { key: '训练任务A', status: '运行中' },
    { key: '训练任务B', status: '排队中' },
  ],
};

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/page') {
    if (world.pageStatus !== 200) {
      response.writeHead(world.pageStatus).end('nope');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderPageHtml());
    return;
  }

  if (url.pathname === '/tasks') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderTasksHtml());
    return;
  }

  if (url.pathname === '/api/dsh-im/delivery/messages' && request.method === 'POST') {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      world.deliveries.push({ body, raw });

      if (world.deliveryMode === 'bot-not-connected') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'bot-not-connected', message: 'bot-not-connected', details: {} } }));
        return;
      }
      if (world.deliveryMode === 'target-rejected') {
        response.writeHead(422, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'target-rejected', message: 'target-rejected', details: {} } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ sent: true }));
    });
    return;
  }

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { code: 'not-found', message: 'not-found', details: {} } }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const webPort = server.address().port;
const base = `http://127.0.0.1:${webPort}`;

// ---------------------------------------------------------------------------
// 3. 加载 background.js 并准备调用助手
// ---------------------------------------------------------------------------

await import('../src/background.js');
assert.equal(listeners.message.length, 1, 'background 应注册一个 onMessage 监听器');

function call(message) {
  return new Promise((resolve, reject) => {
    const returned = listeners.message[0](message, {}, resolve);
    assert.equal(returned, true, '监听器必须返回 true 以保持异步响应通道');
    setTimeout(() => reject(new Error(`消息 ${message.type} 超时未响应`)), 25_000).unref?.();
  });
}

function fireAlarm(name) {
  for (const listener of listeners.alarm) listener({ name });
}

let checks = 0;
const failures = [];
async function step(name, fn) {
  checks += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

console.log('后台逻辑集成测试');

// ---------------------------------------------------------------------------
// 4. 用例
// ---------------------------------------------------------------------------

await step('保存投递设置', async () => {
  const result = await call({
    type: 'save-settings',
    settings: { dshBaseUrl: `${base}/`, botId: ' bot_test ', targetId: ' my-target ', localFallback: true },
  });
  assert.equal(result.ok, true);
  assert.equal(result.settings.dshBaseUrl, base, '应去掉结尾斜杠');
  assert.equal(result.settings.botId, 'bot_test', '应 trim');
});

await step('保存监控项时校验非法输入', async () => {
  const result = await call({ type: 'save-watch', watch: { name: '', url: 'ftp://x', selector: '' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /监控名称/u);
});

await step('保存监控项（直接抓取 + CSS 选择器）', async () => {
  const result = await call({
    type: 'save-watch',
    watch: {
      name: '测试公告页',
      url: `${base}/page`,
      mode: 'direct',
      selectorType: 'css',
      selector: '#content',
      valueKind: 'text',
      intervalMinutes: 0.5,
      ignoreEmpty: true,
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.watch.id, /^w_/u);
  assert.equal(alarms.has('sweep'), true, '保存后应创建 sweep 闹钟');
});

await step('首次检查只建立基线、不提醒', async () => {
  const result = await call({ type: 'run-check' });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].changed, false);
  assert.equal(world.deliveries.length, 0, '基线阶段不应发送消息');
});

await step('内容变化 → 投递一次并带上新旧值', async () => {
  world.pageValue = '公告：新内容（已更新）';
  const result = await call({ type: 'run-check' });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].changed, true);
  assert.equal(result.results[0].notified, true);
  assert.equal(world.deliveries.length, 1);

  const sent = world.deliveries[0].body;
  assert.equal(sent.botId, 'bot_test');
  assert.equal(sent.targetId, 'my-target');
  assert.equal(sent.format, 'plain');
  assert.match(sent.text, /【内容变更】测试公告页/u);
  assert.match(sent.text, /变更前：公告：原内容/u);
  assert.match(sent.text, /变更后：公告：新内容（已更新）/u);
});

await step('内容不变时不重复发送', async () => {
  const result = await call({ type: 'run-check' });
  assert.equal(result.results[0].changed, false);
  assert.equal(world.deliveries.length, 1, '不应有新消息');
});

await step('只改缩进/换行不算变化（空白归一化）', async () => {
  world.pageValue = '公告：新内容（已更新）';
  const result = await call({ type: 'run-check', id: (await call({ type: 'get-state' })).watches[0].id });
  assert.equal(result.results[0].changed, false);
  assert.equal(world.deliveries.length, 1);
});

await step('关键词不匹配时记录变化但不提醒', async () => {
  const state = await call({ type: 'get-state' });
  const watch = state.watches[0];
  const saved = await call({ type: 'save-watch', watch: { ...watch, keyword: '只关心这个词' } });
  assert.equal(saved.ok, true);

  world.pageValue = '公告：又变了';
  const result = await call({ type: 'run-check' });
  assert.equal(result.results[0].changed, true);
  assert.equal(result.results[0].notified, false);
  assert.equal(world.deliveries.length, 1, '关键词不匹配不应发送');
});

await step('投递失败 → 记错误、触发本地兜底、安排重试', async () => {
  const state = await call({ type: 'get-state' });
  await call({ type: 'save-watch', watch: { ...state.watches[0], keyword: '' } });

  world.deliveryMode = 'bot-not-connected';
  world.pageValue = '公告：第三次变化';
  const result = await call({ type: 'run-check' });
  assert.equal(result.results[0].changed, true);
  assert.equal(result.results[0].notified, false);
  assert.match(result.results[0].error, /机器人当前离线/u);

  const after = await call({ type: 'get-state' });
  assert.match(after.runtime.lastDeliveryError, /机器人当前离线/u);
  assert.equal(after.runtime.retry?.attempt, 1, '应安排第 1 次重试');
  assert.equal(notifications.length, 1, '应发出本地兜底通知');
  assert.equal(alarms.has('retry-delivery'), true);
});

await step('重试成功 → 清空 retry 并记录成功', async () => {
  world.deliveryMode = 'ok';
  fireAlarm('retry-delivery');
  // runRetry 是异步的，等它落地
  for (let i = 0; i < 60; i += 1) {
    const state = await call({ type: 'get-state' });
    if (state.runtime.retry === null && state.runtime.lastDeliveryOk === true) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = await call({ type: 'get-state' });
  assert.equal(state.runtime.retry, null);
  assert.equal(state.runtime.lastDeliveryOk, true);
  assert.match(world.deliveries.at(-1).body.text, /【内容变更】/u);
});

await step('平台拒绝（target-rejected）不重试', async () => {
  world.deliveryMode = 'target-rejected';
  world.pageValue = '公告：第四次变化';
  const result = await call({ type: 'run-check' });
  assert.equal(result.results[0].notified, false);
  const state = await call({ type: 'get-state' });
  assert.equal(state.runtime.retry, null, '不可重试的错误不应排重试');
  assert.match(state.runtime.lastDeliveryError, /平台拒绝/u);
});

await step('测试发送接口走同一通道', async () => {
  world.deliveryMode = 'ok';
  const before = world.deliveries.length;
  const result = await call({ type: 'test-delivery' });
  assert.equal(result.ok, true);
  assert.equal(world.deliveries.length, before + 1);
  assert.match(world.deliveries.at(-1).body.text, /主动投递已打通/u);
});

await step('选择器失效时给出中文原因且不改基线', async () => {
  const state = await call({ type: 'get-state' });
  const watch = state.watches[0];
  await call({ type: 'save-watch', watch: { ...watch, selector: '#not-exist' } });
  const result = await call({ type: 'run-check' });
  assert.equal(result.ok, false);
  assert.match(result.results[0].error, /选择器没有匹配到元素/u);
});

await step('停用的监控项不参与批量检查', async () => {
  const state = await call({ type: 'get-state' });
  await call({ type: 'toggle-watch', id: state.watches[0].id, enabled: false });
  const result = await call({ type: 'run-check' });
  assert.equal(result.results.length, 0);
  const after = await call({ type: 'get-state' });
  assert.equal(after.watches[0].enabled, false);
});

await step('删除监控项', async () => {
  const state = await call({ type: 'get-state' });
  const removed = await call({ type: 'delete-watch', id: state.watches[0].id });
  assert.equal(removed.ok, true);
  assert.equal(removed.watches.length, 0);
  assert.equal(alarms.has('sweep'), false, '没有启用项时应清掉 sweep 闹钟');
});

await step('未知消息类型返回明确错误', async () => {
  const result = await call({ type: 'no-such-message' });
  assert.equal(result.ok, false);
  assert.match(result.error, /未知消息类型/u);
});

// ---------------------------------------------------------------------------
// 4.1 rows 模式：任务列表逐行状态对比
// ---------------------------------------------------------------------------

console.log('  —— rows 模式（任务列表）');

async function saveRowsWatch(overrides = {}) {
  const response = await call({
    type: 'save-watch',
    watch: {
      name: '任务列表',
      url: `${base}/tasks`,
      mode: 'direct',
      extractMode: 'rows',
      rowSelector: 'tbody tr',
      keySelector: 'td:nth-child(1)',
      statusSelector: 'td:nth-child(2)',
      intervalMinutes: 0.5,
      ...overrides,
    },
  });
  assert.equal(response.ok, true, `保存 rows 监控项失败：${response.error}`);
  return response.watch;
}

await step('保存 rows 监控项并建立基线（不提醒）', async () => {
  const watch = await saveRowsWatch();
  assert.equal(watch.extractMode, 'rows');
  const before = world.deliveries.length;
  const result = await call({ type: 'run-check', id: watch.id });
  const [entry] = result.results;
  assert.equal(entry.changed, false);
  assert.equal(entry.count, 2, `行数不对：${entry.count}`);
  assert.equal(world.deliveries.length, before, '基线阶段不应发送');
});

await step('某个任务状态变化 → 消息逐条列出「旧状态 → 新状态」', async () => {
  const state = await call({ type: 'get-state' });
  const watch = state.watches[0];
  const before = world.deliveries.length;

  world.tasks = [
    { key: '训练任务A', status: '已完成' },
    { key: '训练任务B', status: '排队中' },
  ];
  const result = await call({ type: 'run-check', id: watch.id });
  const [entry] = result.results;
  assert.equal(entry.changed, true, '应检测到变化');
  assert.equal(entry.notified, true, '应发送提醒');
  assert.equal(world.deliveries.length, before + 1);

  const text = world.deliveries.at(-1).body.text;
  assert.match(text, /【任务状态变化】任务列表/u);
  assert.match(text, /• 训练任务A：运行中 → 已完成/u);
  assert.match(text, /共 1 项变化/u);
});

await step('rows 模式内容不变时不重复发送', async () => {
  const state = await call({ type: 'get-state' });
  const before = world.deliveries.length;
  const result = await call({ type: 'run-check', id: state.watches[0].id });
  assert.equal(result.results[0].changed, false);
  assert.equal(world.deliveries.length, before);
});

await step('onlyStatuses 过滤：只关心「已完成」时，运行中不提醒', async () => {
  const state = await call({ type: 'get-state' });
  const saved = await saveRowsWatch({ ...state.watches[0], onlyStatuses: '已完成' });
  const before = world.deliveries.length;

  world.tasks = [
    { key: '训练任务A', status: '已完成' },
    { key: '训练任务B', status: '运行中' },
  ];
  const first = await call({ type: 'run-check', id: saved.id });
  assert.equal(first.results[0].changed, true, '变化应被记录');
  assert.equal(first.results[0].notified, false, '未命中 onlyStatuses 不应提醒');
  assert.equal(world.deliveries.length, before);

  world.tasks = [
    { key: '训练任务A', status: '已完成' },
    { key: '训练任务B', status: '已完成' },
  ];
  const second = await call({ type: 'run-check', id: saved.id });
  assert.equal(second.results[0].notified, true, '命中「已完成」应提醒');
  assert.match(world.deliveries.at(-1).body.text, /• 训练任务B：运行中 → 已完成/u);
});

await step('新增任务默认提醒，消失任务默认不提醒', async () => {
  const state = await call({ type: 'get-state' });
  const saved = await saveRowsWatch({ ...state.watches[0], onlyStatuses: '' });

  world.tasks = [
    { key: '训练任务A', status: '已完成' },
    { key: '训练任务C', status: '排队中' },
  ];
  const before = world.deliveries.length;
  const result = await call({ type: 'run-check', id: saved.id });
  assert.equal(result.results[0].changed, true);
  assert.equal(result.results[0].notified, true, '新增行默认应提醒');
  const text = world.deliveries.at(-1).body.text;
  assert.match(text, /• 训练任务C：新增，状态 排队中/u);
  assert.doesNotMatch(text, /已不在列表中/u, '消失行默认不应提醒');
  assert.equal(world.deliveries.length, before + 1);
});

await step('rows 模式 get-preview 返回行明细', async () => {
  const state = await call({ type: 'get-state' });
  const preview = await call({ type: 'get-preview', watch: state.watches[0] });
  assert.equal(preview.ok, true, `预览失败：${preview.error}`);
  assert.equal(preview.count, 2);
  assert.deepEqual(preview.rows.map((row) => row.key).sort(), ['训练任务A', '训练任务C']);
});

await step('rows 模式：行选择器命中 0 行时给出可定位的诊断', async () => {
  const state = await call({ type: 'get-state' });
  const invalid = await call({ type: 'save-watch', watch: { ...state.watches[0], statusSelector: '' } });
  assert.equal(invalid.ok, false, '状态选择器为空时应保存失败');
  assert.match(invalid.error, /状态选择器/u);

  const broken = await saveRowsWatch({ ...state.watches[0], statusSelector: 'td:nth-child(9)' });
  world.tasks = [];
  const result = await call({ type: 'run-check', id: broken.id });
  assert.match(result.results[0].error, /没有提取到任何任务行/u, `实际：${result.results[0].error}`);
  assert.match(result.results[0].error, /命中 0 个元素/u, '应说明行选择器命中数');
  assert.match(result.results[0].error, /其实有 11 个 tbody tr/u, '应说明表格其实存在，只是路径不对');
  world.tasks = [{ key: '训练任务A', status: '已完成' }];
});

await step('rows 模式：状态选择器取不到内容时给出单元格样本', async () => {
  const state = await call({ type: 'get-state' });
  const watch = state.watches[0];
  world.tasks = [{ key: '训练任务X', status: '' }];
  const result = await call({ type: 'run-check', id: watch.id });
  const [entry] = result.results;
  assert.match(entry.error, /状态选择器/u, `实际：${entry.error}`);
  assert.match(entry.error, /匹配到 1 行/u, '应带命中行数');
  assert.match(entry.error, /第 1 行的单元格/u, '应带首行单元格文本');
  world.tasks = [{ key: '训练任务A', status: '已完成' }];
});

await step('清理 rows 监控项', async () => {
  const state = await call({ type: 'get-state' });
  for (const watch of state.watches) await call({ type: 'delete-watch', id: watch.id });
  const after = await call({ type: 'get-state' });
  assert.equal(after.watches.length, 0);
});

// ---------------------------------------------------------------------------
// 4.2 一键监控 / 静默抓取
// ---------------------------------------------------------------------------

console.log('  —— 一键监控 / 静默抓取');

await step('probe-active-tab 识别当前页面并给出预览', async () => {
  world.tasks = [
    { key: '训练任务A', status: '运行中' },
    { key: '训练任务B', status: '排队中' },
  ];
  const result = await call({ type: 'probe-active-tab' });
  assert.equal(result.ok, true, `探测失败：${result.error}`);
  assert.equal(result.url, `${base}/tasks`);
  assert.equal(result.preview.count, 2);
  assert.equal(result.candidate.statusSelector, 'td:nth-child(2)');
  assert.deepEqual(result.preview.rows.map((row) => row.key).sort(), ['训练任务A', '训练任务B']);
});

await step('auto-add 直接用探测结果创建「自动模式」监控项', async () => {
  world.tasks = [
    { key: '训练任务A', status: '运行中' },
    { key: '训练任务B', status: '排队中' },
  ];
  const before = (await call({ type: 'get-state' })).watches.length;
  const result = await call({ type: 'auto-add', tabId: PROBE_TAB_ID, intervalMinutes: 3 });
  assert.equal(result.ok, true, `一键添加失败：${result.error}`);
  const watch = result.watch;
  assert.equal(watch.mode, 'tab');
  assert.equal(watch.extractMode, 'rows');
  assert.equal(watch.autoDetect, true);
  assert.equal(watch.rowSelector, 'tbody tr');
  assert.equal(watch.statusSelector, 'td:nth-child(2)');
  assert.equal(watch.intervalMinutes, 3);
  assert.equal(watch.detection.rowCount, 2);
  const after = await call({ type: 'get-state' });
  assert.equal(after.watches.length, before + 1);
});

await step('静默抓取：只创建 1 个最小化隐藏窗口，并复用同一个标签页', async () => {
  const beforeWindow = tabWorld.windowCreates;
  const beforeTabs = tabWorld.tabs.size;
  const beforeUpdate = tabWorld.tabUpdates;

  const state = await call({ type: 'get-state' });
  const watch = state.watches[0];
  const first = await call({ type: 'run-check', id: watch.id });
  assert.equal(first.results[0].error ?? '', '', `第一次检查失败：${first.results[0].error}`);
  const tabsAfterFirst = tabWorld.tabs.size;
  const second = await call({ type: 'run-check', id: watch.id });
  assert.equal(second.results[0].error ?? '', '', `第二次检查失败：${second.results[0].error}`);

  assert.equal(tabWorld.windowCreates, beforeWindow + 1, '两次检查只应创建 1 个隐藏窗口');
  assert.equal(tabsAfterFirst, beforeTabs + 1, '第一次检查应只多 1 个标签页');
  assert.equal(tabWorld.tabs.size, tabsAfterFirst, '第二次检查应复用同一个标签页，不再新建');
  assert.ok(tabWorld.tabUpdates >= beforeUpdate + 2, '每次检查都应让复用标签页重新导航');
  const lastWindowOptions = tabWorld.createOptions.at(-1) ?? {};
  assert.equal(lastWindowOptions.focused, false, '隐藏窗口不应抢焦点');
  assert.ok(
    lastWindowOptions.state === 'minimized'
    || (lastWindowOptions.left < 0 && lastWindowOptions.top < 0),
    `隐藏窗口应最小化或放到屏幕外，实际：${JSON.stringify(lastWindowOptions)}`,
  );
  const persisted = await call({ type: 'get-state' });
  assert.ok(persisted.runtime.hiddenWindowId, '隐藏窗口 id 应持久化，Service Worker 重启后还能复用');
  assert.equal(persisted.watches[0].status.lastStrategy, 'hidden-window');
});

await step('零窗口优先：用户自己开着这个页面时，直接读他的标签页（不新建窗口/不导航）', async () => {
  const beforeWindow = tabWorld.windowCreates;
  const beforeUpdate = tabWorld.tabUpdates;
  const beforeTabs = tabWorld.tabs.size;

  // 模拟用户正开着这个页面（在普通窗口里）
  const userTabId = tabWorld.nextId++;
  tabWorld.tabs.set(userTabId, { id: userTabId, windowId: 99, url: 'https://console.sensecore.cn/acp/list?workspace=w1' });
  const state = await call({ type: 'get-state' });
  const watch = state.watches[0];
  // 把监控地址换成用户开着的那个地址
  const saved = await call({
    type: 'save-watch',
    watch: { ...watch, url: 'https://console.sensecore.cn/acp/list?workspace=w1' },
  });
  assert.equal(saved.ok, true, `保存失败：${saved.error}`);

  const result = await call({ type: 'run-check', id: watch.id });
  assert.equal(result.results[0].error ?? '', '', `检查失败：${result.results[0].error}`);
  assert.equal(tabWorld.windowCreates, beforeWindow, '不应创建任何隐藏窗口');
  assert.equal(tabWorld.tabUpdates, beforeUpdate, '不应让任何标签页导航');
  assert.equal(tabWorld.tabs.size, beforeTabs + 1, '只多了用户自己那个标签页');

  const after = await call({ type: 'get-state' });
  assert.equal(after.watches[0].status.lastStrategy, 'tab-reuse');

  // 收尾：用户那个标签页由「用户」自己关掉
  tabWorld.tabs.delete(userTabId);
});

await step('通用兜底：没有表格的页面也能一键监控（整页内容）', async () => {
  world.probeTabUrl = `${base}/page`;
  world.pageValue = '这是一段比较长的页面正文内容，用来模拟没有表格的普通网页。它需要足够长，超过一百二十个字符，这样才能被识别成页面主要内容并建立监控。这里再多写一些字，确保长度达标：公告标题、发布时间、正文段落、联系人、备注信息，以及一段用于测试的重复文字。';

  const probe = await call({ type: 'probe-active-tab' });
  assert.equal(probe.ok, true, `探测失败：${probe.error}`);
  assert.equal(probe.kind, 'single');
  assert.equal(probe.candidate.selector, 'body');
  assert.ok(probe.preview.rows[0].value.length > 0, '预览内容不应为空');

  const added = await call({ type: 'auto-add', tabId: PROBE_TAB_ID, intervalMinutes: 5 });
  assert.equal(added.ok, true, `一键添加失败：${added.error}`);
  assert.equal(added.kind, 'single');
  assert.equal(added.watch.extractMode, 'single');
  assert.equal(added.watch.selector, 'body');
  assert.equal(added.watch.mode, 'tab');

  const check = await call({ type: 'run-check', id: added.watch.id });
  assert.equal(check.results[0].error ?? '', '', `检查失败：${check.results[0].error}`);
  world.probeTabUrl = null;
});

await step('强制兜底：forceKind=page 不做识别，直接监控整页内容', async () => {
  const result = await call({
    type: 'auto-add',
    tabId: PROBE_TAB_ID,
    intervalMinutes: 7,
    forceKind: 'page',
  });
  assert.equal(result.ok, true, `兜底添加失败：${result.error}`);
  assert.equal(result.kind, 'single');
  assert.equal(result.watch.extractMode, 'single');
  assert.equal(result.watch.selector, 'body');
  assert.equal(result.watch.mode, 'tab');
  assert.equal(result.watch.intervalMinutes, 7);

  const check = await call({ type: 'run-check', id: result.watch.id });
  assert.equal(check.results[0].error ?? '', '', `整页监控检查失败：${check.results[0].error}`);

  await call({ type: 'delete-watch', id: result.watch.id });
});

await step('自动模式自愈：状态选择器失效后自动重新识别并回填', async () => {
  const state = await call({ type: 'get-state' });
  const watch = state.watches[0];
  const saved = await call({
    type: 'save-watch',
    watch: { ...watch, statusSelector: 'td:nth-child(9)', last: null },
  });
  assert.equal(saved.ok, true, `保存失败：${saved.error}`);

  world.tasks = [
    { key: 'train-a', status: '运行中' },
    { key: 'train-b', status: '已完成' },
  ];
  const result = await call({ type: 'run-check', id: watch.id });
  const [entry] = result.results;
  assert.equal(entry.error ?? '', '', `应自愈成功：${entry.error}`);
  assert.equal(entry.count, 2);

  const after = await call({ type: 'get-state' });
  assert.equal(after.watches[0].statusSelector, 'td:nth-child(2)', '自愈后应回填正确选择器');
  assert.equal(after.watches[0].detection.source, 'auto-heal');
});

await step('删除监控项会关掉隐藏标签页与窗口', async () => {
  const state = await call({ type: 'get-state' });
  for (const watch of state.watches) await call({ type: 'delete-watch', id: watch.id });
  const after = await call({ type: 'get-state' });
  assert.equal(after.watches.length, 0);
  assert.equal(tabWorld.tabs.size, 0, '所有抓取标签页都应关闭');
  assert.equal(tabWorld.windows.size, 0, '没有启用的监控项时应关掉隐藏窗口');
  assert.equal(after.runtime.hiddenWindowId, null);
});

// ---------------------------------------------------------------------------
// 5. 收尾
// ---------------------------------------------------------------------------

server.close();
console.log(`\n结果：${checks} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  process.exitCode = 1;
} else {
  console.log('（注：DOM 真实解析在浏览器离屏文档中完成，此处用 data-value 桩替代，'
    + '选择器/XPath 的真实解析能力见 tools/selftest.mjs 与浏览器手工验证）');
}
