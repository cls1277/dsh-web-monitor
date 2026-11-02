/**
 * DSH 网页监控 · Service Worker
 *
 * 职责：
 *  1. 用 chrome.alarms 周期性唤醒，按每个监控项自己的 interval 判断是否到期；
 *  2. 抓取页面（直接 fetch 或后台标签页 outerHTML）；
 *  3. 交给离屏文档用 DOMParser 提取内容，算指纹并与上次比较；
 *  4. 有变化就 POST 到 DSH-IM 的主动投递接口，把消息推到微信；
 *  5. 失败时做本地通知兜底，并按 60s / 最多 3 次重试。
 *
 * 所有状态都在 chrome.storage.local，Service Worker 随时可能被 Chrome 回收，
 * 因此这里不依赖任何模块级可变状态（除单飞锁与离屏文档句柄）。
 */
import {
  buildBaselineMessage,
  buildChangeMessage,
  buildRowsBaselineMessage,
  buildRowsChangeMessage,
  buildTestMessage,
  clipMessage,
  diffRows,
  filterRowsDiff,
  hashValue,
  parseRows,
  previewOf,
  rowsPreview,
  serializeRows,
} from './extract.js';
import { detectTables } from './detect.js';
const SWEEP_ALARM = 'sweep';
const RETRY_ALARM = 'retry-delivery';

const MAX_HTML_CHARS = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const DELIVERY_TIMEOUT_MS = 15_000;
const TAB_LOAD_TIMEOUT_MS = 30_000;
const WAIT_SELECTOR_TIMEOUT_MS = 25_000;
const DETECT_TIMEOUT_MS = 25_000;
const DEFAULT_SETTLE_MS = 1_500;
const MAX_SETTLE_MS = 20_000;
const RETRY_DELAY_MS = 60_000;
const MAX_RETRY = 3;
const MIN_INTERVAL_MINUTES = 0.5;
const MAX_INTERVAL_MINUTES = 1440;

const DEFAULT_SETTINGS = {
  dshBaseUrl: 'http://127.0.0.1:52020',
  botId: '',
  targetId: '',
  localFallback: true,
  quiet: false,
  silentTabs: true, // true=在最小化的隐藏窗口里常驻抓取标签页，用户看不到标签页闪动
};

const DEFAULT_COUNTERS = { checks: 0, changes: 0, sent: 0, failed: 0 };

const DEFAULT_RUNTIME = {
  lastSweepAt: 0,
  lastDeliveryAt: 0,
  lastDeliveryOk: null,
  lastDeliveryError: '',
  counters: DEFAULT_COUNTERS,
  retry: null,
  hiddenWindowId: null, // 「静默抓取」用的隐藏窗口
  hiddenTabs: {},       // { watchId: tabId }
};

/** 错误码 → 中文可执行提示（HTTP/RPC 返回的 code 均覆盖）。 */
export const ERROR_HINTS = {
  'missing-config': '还没填写 Bot ID 或 Target ID，请先在上方完成 DSH 投递设置',
  'bad-request': '请求格式不对：检查 Bot ID / Target ID 是否为空或含空格',
  'unknown-bot': 'Bot ID 不属于当前 DSH，请重新从「设置 → IM机器人」复制',
  'unknown-target': '该机器人下没有这个 Target ID，请检查或新建投递目标',
  'target-conflict': 'Target ID 已存在，换一个别名',
  'invalid-target': '目标类型或平台原生 ID 不符合渠道规则',
  'bot-not-connected': '机器人当前离线，恢复连接后会自动重试',
  'target-rejected': '平台拒绝了该目标（多为权限或用户 ID 不对）',
  'delivery-failed': '平台发送失败；微信常见 ret=-2 prepare failed，先给机器人发一条消息再重试',
  'session-sync-unavailable': '目标不是可确认的当前私聊会话',
  'payload-too-large': '消息体过大（超过 1 MiB）',
  'network-error': '连不上 DSH：确认 DSH 正在运行，且地址/端口与「设置 → 关于」显示的一致',
  timeout: '请求超时，稍后会自动重试',
  cancelled: '请求被取消',
  'method-not-allowed': '接口方法不对（GET 了 POST 接口）',
  'unsupported-media-type': 'Content-Type 必须是 application/json',
  disabled: '该监控项已停用',
  'not-due': '还没到检查时间',
  empty: '提取结果为空，已按「忽略空值」跳过',
  'selector-not-found': '选择器没有匹配到元素',
  'selector-invalid': '选择器语法有误',
  'parse-error': '页面解析失败',
  'rows-empty': '没有提取到任何任务行（选择器可能不对，或列表还没加载出来）',
  'rows-key-empty': '匹配到任务行，但「行键选择器」在每行里都取不到内容',
  'rows-status-empty': '匹配到任务行，但「状态选择器」在每行里都取不到内容',
  'wait-selector-timeout': '等待页面元素出现超时：页面可能没加载完，或选择器不对',
  'login-required': '页面要求登录：请先在 Chrome 里登录该站点，再点「立即检查」或「自动探测」',
  'detect-failed': '没有自动识别到表格，请手工填写选择器（右键任务行 → 检查 → Copy selector）',
  'no-permission': '缺少该站点的访问权限，请在设置页重新保存该监控项以授权',
  'invalid-watch': '监控项配置不完整',
  'unknown-message': '未知消息类型',
};

const RETRYABLE_CODES = new Set([
  'bot-not-connected',
  'delivery-failed',
  'network-error',
  'timeout',
  'http-500',
  'http-502',
  'http-503',
]);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function errorText(code, detail) {
  const hint = ERROR_HINTS[code] ?? `发送失败（${code}）`;
  return detail ? `${hint}：${detail}` : hint;
}

function reasonText(reason) {
  return ERROR_HINTS[reason] ?? `提取失败（${reason}）`;
}

/**
 * rows 模式失败时给出「照着改就能好」的中文诊断：
 * 带上命中行数、整页 tr 数、首行各单元格文本，避免只回一句「检查不到」。
 */
function rowsFailureText(extracted, watch) {
  const reason = extracted?.reason;
  const sample = Array.isArray(extracted?.sample) && extracted.sample.length
    ? extracted.sample.join(' | ')
    : '(空)';

  if (reason === 'rows-empty') {
    const totalTr = Number(extracted?.totalTr) || 0;
    const tbodyTr = Number(extracted?.tbodyTr) || 0;
    const modeHint = watch.mode === 'direct'
      ? '当前抓取方式是「direct」——登录态页面通常只能拿到页面外壳，请改成「tab · 后台标签页渲染后读取」。'
      : '先确认表格已经渲染出来（可加大「额外等待(ms)」或检查「等待选择器」）。';
    const tableHint = tbodyTr > 0
      ? `页面里其实有 ${tbodyTr} 个 tbody tr，说明表格在，只是路径不对；可先把行选择器改成 tbody tr 或 .acp-list tr[data-row-key] 试一次。`
      : '页面里连 tbody tr 都没有，基本可以确定抓到的是未登录外壳或空白页。';
    return `${ERROR_HINTS['rows-empty']}：行选择器命中 0 个元素（整个页面共有 ${totalTr} 个 <tr>）。`
      + `${modeHint}${tableHint}另外不要用 #root 开头的长路径——该控制台页面里有多个 #root。`;
  }

  if (reason === 'rows-status-empty') {
    return `${ERROR_HINTS['rows-status-empty']}：匹配到 ${extracted?.matched ?? 0} 行，`
      + `但「${watch.statusSelector}」在每行里都没取到内容。第 1 行的单元格是：${sample}。`
      + '请按实际列序改状态选择器（如 td:nth-child(k)），或直接取状态文本节点（如 .status-tag-label）。';
  }

  if (reason === 'rows-key-empty') {
    return `${ERROR_HINTS['rows-key-empty']}：匹配到 ${extracted?.matched ?? 0} 行，`
      + `但「${watch.keySelector || '(空)'}」取不到内容。第 1 行的单元格是：${sample}。`
      + '可把「行键属性名」改成 data-row-key，或换成有文字的列（如 td:nth-child(2)）。';
  }

  return reasonText(reason);
}

function httpStatusToCode(status) {
  if (status === 413) return 'payload-too-large';
  if (status === 415) return 'unsupported-media-type';
  if (status === 405) return 'method-not-allowed';
  return `http-${status}`;
}

function originPatternFor(url) {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return '';
  }
}

async function hasSitePermission(url) {
  const origin = originPatternFor(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 状态读写：所有写操作串行化，避免 sweep / 手动检查 / 弹窗保存互相覆盖
// ---------------------------------------------------------------------------

let writeQueue = Promise.resolve();

function withLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

async function getState() {
  const stored = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS,
    watches: [],
    runtime: DEFAULT_RUNTIME,
  });

  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
  settings.dshBaseUrl = String(settings.dshBaseUrl ?? '').replace(/\/+$/u, '');
  settings.botId = String(settings.botId ?? '').trim();
  settings.targetId = String(settings.targetId ?? '').trim();
  settings.localFallback = settings.localFallback !== false;
  settings.quiet = settings.quiet === true;
  settings.silentTabs = settings.silentTabs !== false;

  const runtimeRaw = stored.runtime ?? {};
  const runtime = {
    ...DEFAULT_RUNTIME,
    ...runtimeRaw,
    counters: { ...DEFAULT_COUNTERS, ...(runtimeRaw.counters ?? {}) },
    hiddenTabs: { ...(runtimeRaw.hiddenTabs ?? {}) },
  };

  const watches = Array.isArray(stored.watches) ? stored.watches : [];
  return { settings, watches, runtime };
}

/**
 * 在锁内读-改-写整个状态。mutator 可直接改 state.settings / state.watches / state.runtime，
 * 返回值会作为 mutateState 的结果透出。
 */
function mutateState(mutator) {
  return withLock(async () => {
    const state = await getState();
    const result = await mutator(state);
    await chrome.storage.local.set({
      settings: state.settings,
      watches: state.watches,
      runtime: state.runtime,
    });
    return result;
  });
}

function mutateWatch(id, mutator) {
  return mutateState((state) => {
    const index = state.watches.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const next = mutator(structuredClone(state.watches[index]));
    state.watches[index] = next;
    return next;
  });
}

function bumpCounters(delta) {
  return mutateState((state) => {
    for (const [key, value] of Object.entries(delta)) {
      state.runtime.counters[key] = (state.runtime.counters[key] ?? 0) + value;
    }
  });
}

/** 返回给界面的精简 watch（不带完整 last.value，避免消息体过大）。 */
function toPublicWatch(watch) {
  return {
    ...watch,
    last: watch.last
      ? {
        hash: watch.last.hash,
        at: watch.last.at,
        count: watch.last.count ?? null,
        valuePreview: previewOf(watch.last.value, 200),
      }
      : null,
  };
}

// ---------------------------------------------------------------------------
// 抓取：直接 fetch 或后台标签页
// ---------------------------------------------------------------------------

async function fetchHtml(url) {
  const response = await fetch(url, {
    credentials: 'include', // 带上目标站点的登录 Cookie，扩展有该站点 host 权限时可用
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
  });

  if (!response.ok) {
    const hint = response.status === 403 || response.status === 401
      ? '（可能需要登录，试试改用「后台标签页」抓取方式）'
      : '';
    throw Object.assign(new Error(`目标网页返回 HTTP ${response.status}${hint}`), {
      code: 'http-status',
    });
  }

  const text = await response.text();
  return text.length > MAX_HTML_CHARS ? text.slice(0, MAX_HTML_CHARS) : text;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    const onUpdated = (updatedId, info) => {
      if (updatedId !== tabId || settled) return;
      if (info.status === 'complete') {
        cleanup();
        resolve();
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('后台标签页加载超时'));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);

    // 页面可能在监听器挂上之前就已经加载完
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (!settled && tab?.status === 'complete') {
          cleanup();
          resolve();
        }
      })
      .catch(() => {});
  });
}

/** 读取标签页当前的 URL / 标题，用于判断是否被踢回登录页。 */
async function tabInfo(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ url: location.href, title: document.title }),
    });
    return result ?? { url: '', title: '' };
  } catch {
    return { url: '', title: '' };
  }
}

/** 轮询等待某个 CSS 选择器出现（给 SPA 表格用），超时时区分「登录页」与普通超时。 */
async function waitForSelectorInTab(tabId, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let found = false;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (css) => Boolean(document.querySelector(css)),
        args: [selector],
      });
      found = result === true;
    } catch {
      /* 页面可能还在导航，下一轮再试 */
    }
    if (found) return;
    await sleep(500);
  }

  const info = await tabInfo(tabId);
  if (/login|signin|passport|登录|扫码/iu.test(`${info.url} ${info.title}`)) {
    throw Object.assign(new Error(ERROR_HINTS['login-required']), { code: 'login-required' });
  }
  throw Object.assign(
    new Error(`${ERROR_HINTS['wait-selector-timeout']}（${selector}）`),
    { code: 'wait-selector-timeout' },
  );
}

// ---------------------------------------------------------------------------
// 静默抓取：一个最小化的隐藏窗口 + 常驻标签页（用户看不到标签页闪动）
// ---------------------------------------------------------------------------

/** 不传 url 时用 about:blank 先建窗口，再让第一个监控的 tab 复用这个空白页。 */
async function createHiddenWindow() {
  const attempts = [
    // 优先「屏幕外的 popup 窗口」：既不抢焦点，通常也不在任务栏占位
    { focused: false, type: 'popup', width: 480, height: 360, left: -32000, top: -32000, url: 'about:blank' },
    { focused: false, state: 'minimized', type: 'popup', url: 'about:blank' },
    { focused: false, state: 'minimized', url: 'about:blank' },
  ];
  let lastError = null;
  for (const options of attempts) {
    try {
      return await chrome.windows.create(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('无法创建隐藏窗口');
}

async function getHiddenWindowId() {
  const { runtime } = await getState();
  if (runtime.hiddenWindowId) {
    try {
      await chrome.windows.get(runtime.hiddenWindowId);
      return runtime.hiddenWindowId;
    } catch {
      /* 窗口被用户关了，下面重建 */
    }
  }

  if (!hiddenWindowPromise) {
    hiddenWindowPromise = (async () => {
      const win = await createHiddenWindow();
      await mutateState((state) => {
        state.runtime.hiddenWindowId = win.id;
        state.runtime.hiddenTabs = {};
      });
      return win.id;
    })().finally(() => {
      hiddenWindowPromise = null;
    });
  }
  return hiddenWindowPromise;
}

/** 为一个监控项拿到（必要时创建）隐藏窗口里的标签页；失败返回 null 表示退回普通标签页。 */
async function ensureWatchTab(watch) {
  const state = await getState();
  if (state.settings.silentTabs === false) return null;

  let windowId;
  try {
    windowId = await getHiddenWindowId();
  } catch {
    return null; // 创建隐藏窗口失败：降级为「开一个后台标签页」
  }

  const storedTabId = state.runtime.hiddenTabs?.[watch.id];
  if (storedTabId) {
    try {
      const tab = await chrome.tabs.get(storedTabId);
      if (tab && tab.windowId === windowId) return storedTabId;
    } catch {
      /* 标签页已不在，重建 */
    }
  }

  // 优先复用窗口自带的空白页，避免每次多一个标签页
  let createdTab = null;
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const blank = tabs.find((tab) => !tab.url || tab.url === 'about:blank');
    if (blank) createdTab = await chrome.tabs.update(blank.id, { url: watch.url });
  } catch {
    /* 忽略，下面直接新建 */
  }

  if (!createdTab) {
    createdTab = await chrome.tabs.create({ windowId, url: watch.url, active: false });
  }

  await mutateState((current) => {
    current.runtime.hiddenTabs = { ...(current.runtime.hiddenTabs ?? {}), [watch.id]: createdTab.id };
  });

  return createdTab.id;
}

/** 关闭某个监控项占用的隐藏标签页。 */
async function closeWatchTab(watchId) {
  const { runtime } = await getState();
  const tabId = runtime.hiddenTabs?.[watchId];
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* 标签页可能已经不在 */
  }
  await mutateState((state) => {
    const next = { ...(state.runtime.hiddenTabs ?? {}) };
    delete next[watchId];
    state.runtime.hiddenTabs = next;
  });
}

/** 没有任何启用的监控项时，关掉隐藏窗口，避免留一个窗口后台常驻。 */
async function closeHiddenWindowIfUnused() {
  const { watches, runtime } = await getState();
  if (watches.some((watch) => watch.enabled)) return;
  if (!runtime.hiddenWindowId) return;
  try {
    await chrome.windows.remove(runtime.hiddenWindowId);
  } catch {
    /* 已关闭 */
  }
  await mutateState((state) => {
    state.runtime.hiddenWindowId = null;
    state.runtime.hiddenTabs = {};
  });
}

/** 轮询 document.readyState，比 tabs.onUpdated 更适合「复用标签页再导航」的场景。 */
async function waitForDocumentReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.readyState,
      });
      if (result === 'complete') return;
    } catch {
      /* 导航中，executeScript 会失败，继续等 */
    }
    await sleep(300);
  }
  throw Object.assign(new Error('等待页面加载超时'), { code: 'wait-selector-timeout' });
}

/** 把 URL 归一化（去掉 hash），用于「用户是否正开着同一页」的判断。 */
function normalizeTargetUrl(url) {
  try {
    const parsed = new URL(String(url));
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url ?? '');
  }
}

function samePage(left, right) {
  const a = normalizeTargetUrl(left);
  const b = normalizeTargetUrl(right);
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const first = new URL(a);
    const second = new URL(b);
    return first.origin === second.origin
      && first.pathname === second.pathname
      && first.search === second.search;
  } catch {
    return false;
  }
}

/**
 * 【零窗口策略】如果用户自己已经开着这个页面，直接读那个标签页的 DOM：
 * 不新开窗口、不导航、不抢焦点 —— 这是唯一 100% 不会出现任何可见窗口的方式。
 */
async function readFromUserTab(watch) {
  const { runtime } = await getState();
  const hiddenWindowId = runtime.hiddenWindowId ?? null;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return null;
  }

  const candidates = tabs.filter((tab) => tab?.id
    && tab.windowId !== hiddenWindowId
    && /^https?:/iu.test(tab.url ?? '')
    && samePage(tab.url, watch.url));

  for (const tab of candidates) {
    try {
      const html = await readOuterHtml(tab.id);
      if (html && html.length > 200) return { html, tabId: tab.id, strategy: 'tab-reuse' };
    } catch {
      /* 该标签页受保护（如 Chrome 内置页面），跳过 */
    }
  }
  return null;
}

/**
 * 按策略抓取 HTML：
 *   1) tab-reuse     读用户已打开的同一页面（无新窗口）
 *   2) hidden-window 隐藏窗口里的常驻标签页
 *   3) ephemeral-tab 临时标签页（兜底）
 *   4) direct        直接 fetch（非 tab 模式）
 * @returns {Promise<{html: string, strategy: string}>}
 */
async function readHtmlWithStrategy(watch) {
  if (watch.mode !== 'tab') {
    return { html: await fetchHtml(watch.url), strategy: 'direct' };
  }

  const adopted = await readFromUserTab(watch).catch(() => null);
  if (adopted) return adopted;

  const silentTabId = await ensureWatchTab(watch).catch(() => null);
  let tabId = silentTabId;
  let ephemeral = false;

  if (!tabId) {
    // 兜底：降级成「开一个后台标签页、读完就关」
    const tab = await chrome.tabs.create({ url: watch.url, active: false });
    tabId = tab.id;
    ephemeral = true;
  }

  try {
    if (silentTabId) {
      // 复用标签页：每次导航到目标 URL 拿最新数据
      await chrome.tabs.update(tabId, { url: watch.url });
      await waitForDocumentReady(tabId, TAB_LOAD_TIMEOUT_MS);
    } else {
      await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    }

    // SPA 场景：等目标元素真的出现，比固定 sleep 稳
    const waitSelector = String(watch.waitForSelector ?? '').trim();
    if (waitSelector) {
      await waitForSelectorInTab(tabId, waitSelector, WAIT_SELECTOR_TIMEOUT_MS);
    }

    // 再给渲染/接口回填留一点时间（settleMs 允许显式 0）
    const rawSettle = Number(watch.settleMs);
    const settleMs = clamp(
      Number.isFinite(rawSettle) ? rawSettle : DEFAULT_SETTLE_MS,
      0,
      MAX_SETTLE_MS,
    );
    await sleep(settleMs);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return {
      html: String(results?.[0]?.result ?? ''),
      strategy: silentTabId ? 'hidden-window' : 'ephemeral-tab',
    };
  } finally {
    if (ephemeral) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 标签页可能已被用户关掉 */
      }
    }
  }
}

/** 强制走隐藏窗口/临时标签页（用户那页可能停在别的筛选或还没登录时用）。 */
async function readHtmlViaHiddenTab(watch) {
  const silentTabId = await ensureWatchTab(watch).catch(() => null);
  let tabId = silentTabId;
  let ephemeral = false;

  if (!tabId) {
    const tab = await chrome.tabs.create({ url: watch.url, active: false });
    tabId = tab.id;
    ephemeral = true;
  }

  try {
    if (silentTabId) {
      await chrome.tabs.update(tabId, { url: watch.url });
      await waitForDocumentReady(tabId, TAB_LOAD_TIMEOUT_MS);
    } else {
      await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    }
    const waitSelector = String(watch.waitForSelector ?? '').trim();
    if (waitSelector) await waitForSelectorInTab(tabId, waitSelector, WAIT_SELECTOR_TIMEOUT_MS);
    const rawSettle = Number(watch.settleMs);
    const settleMs = clamp(Number.isFinite(rawSettle) ? rawSettle : DEFAULT_SETTLE_MS, 0, MAX_SETTLE_MS);
    await sleep(settleMs);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return {
      html: String(results?.[0]?.result ?? ''),
      strategy: silentTabId ? 'hidden-window' : 'ephemeral-tab',
    };
  } finally {
    if (ephemeral) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 忽略 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 离屏文档：解析 HTML
// ---------------------------------------------------------------------------

let offscreenReady = null;
let hiddenWindowPromise = null;

async function createOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: '用 DOMParser 解析被监控网页的 HTML，提取指定选择器的内容',
    });
  } catch (error) {
    // 并发创建时第二个会报「只能有一个离屏文档」，忽略即可
    if (!/already|exists/i.test(String(error?.message ?? error))) throw error;
  }
}

function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = createOffscreen().catch((error) => {
      offscreenReady = null;
      throw error;
    });
  }
  return offscreenReady;
}

async function parseHtml(html, extraction) {
  await ensureOffscreen();

  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'offscreen/parse',
        html,
        extraction,
      });
      if (result) return result;
      lastError = new Error('离屏文档没有返回结果');
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  // 离屏文档可能被系统关闭，重置句柄以便下次重新创建
  offscreenReady = null;
  throw lastError ?? new Error('离屏文档没有返回结果');
}

/** 在已抓到的 HTML 上找「页面主要内容」（通用兜底，不要求有表格）。 */
async function detectMainInHtml(html) {
  await ensureOffscreen();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'offscreen/detect-main', html });
      if (result) return result;
    } catch {
      /* 离屏文档还没就绪 */
    }
    await sleep(150);
  }
  offscreenReady = null;
  return null;
}

/** 在已抓到的 HTML 上跑一次结构探测（自动模式下用来「自愈」选择器）。 */
async function detectInHtml(html) {
  await ensureOffscreen();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'offscreen/detect', html });
      if (result) return result;
    } catch {
      /* 离屏文档还没就绪 */
    }
    await sleep(150);
  }
  offscreenReady = null;
  return null;
}

/**
 * 在已抓到的 HTML 上做提取（含自动模式自愈）。与「怎么抓到」解耦，便于多策略重试。
 * @returns {Promise<{ok: true, kind: 'single', value: string}
 *   | {ok: true, kind: 'rows', rows: Array, map: Record<string,string>, count: number, value: string,
 *      healed?: object}
 *   | {ok: false, error: string}>}
 */
async function extractFromHtml(html, extraction, watch, isRows) {
  let extracted;
  try {
    extracted = await parseHtml(html, extraction);
  } catch (error) {
    return { ok: false, error: `提取失败：${String(error?.message ?? error)}` };
  }

  // 自动模式自愈：页面改版导致选择器失效时，用同一份 HTML 重新识别并回填
  if (isRows && watch.autoDetect && extracted && extracted.ok !== true) {
    const detected = await detectInHtml(html);
    const candidate = Array.isArray(detected?.candidates) ? detected.candidates[0] : null;
    if (candidate) {
      let retried = null;
      try {
        retried = await parseHtml(html, rowsExtractionFrom(candidate));
      } catch {
        retried = null;
      }
      if (retried?.ok && Array.isArray(retried.rows) && retried.rows.length > 0) {
        const map = {};
        for (const row of retried.rows) map[row.key] = row.value;
        return {
          ok: true,
          kind: 'rows',
          rows: retried.rows,
          map,
          count: retried.count,
          value: serializeRows(map),
          healed: candidate,
        };
      }
    }
  }

  // 单值模式自愈：选择器失效时退回「页面主要内容」
  if (!isRows && watch.autoDetect && extracted && extracted.ok !== true) {
    const main = await detectMainInHtml(html);
    if (main?.ok && main.selector) {
      let retried = null;
      try {
        retried = await parseHtml(html, { selectorType: 'css', selector: main.selector, valueKind: 'text' });
      } catch {
        retried = null;
      }
      if (retried?.ok && retried.value) {
        return {
          ok: true,
          kind: 'single',
          value: retried.value,
          healedSingle: { selector: main.selector, length: main.length },
        };
      }
    }
  }

  if (!extracted?.ok) {
    return { ok: false, error: isRows ? rowsFailureText(extracted, watch) : reasonText(extracted?.reason) };
  }

  if (!isRows) return { ok: true, kind: 'single', value: extracted.value };

  const map = {};
  for (const row of extracted.rows) map[row.key] = row.value;
  return {
    ok: true,
    kind: 'rows',
    rows: extracted.rows,
    map,
    count: extracted.count,
    value: serializeRows(map),
  };
}

/**
 * 抓一次并提取：不改任何状态，供 get-preview / 正式检查共用。
 *
 * 抓取策略（见 readHtmlWithStrategy）优先复用用户已打开的标签页（零窗口）；
 * 如果从「你的标签页」里取到内容对不上（例如停在其他筛选/未登录），自动退回隐藏窗口再试一次。
 */
async function observe(watch) {
  if (!(await hasSitePermission(watch.url))) {
    return { ok: false, error: errorText('no-permission') };
  }

  const isRows = watch.extractMode === 'rows';

  const extraction = isRows
    ? {
      extractMode: 'rows',
      rowSelector: watch.rowSelector,
      keySelector: watch.keySelector,
      statusSelector: watch.statusSelector,
      keyAttr: watch.keyAttr,
      statusAttr: watch.statusAttr,
    }
    : {
      selectorType: watch.selectorType,
      selector: watch.selector,
      valueKind: watch.valueKind,
      attrName: watch.attrName,
    };

  let fetched = null;
  try {
    fetched = await readHtmlWithStrategy(watch);
  } catch (error) {
    const detail = String(error?.message ?? error);
    const code = error?.code;
    if (code === 'login-required' || code === 'wait-selector-timeout') {
      return { ok: false, error: detail };
    }
    const isTimeout = error?.name === 'TimeoutError' || /超时/u.test(detail);
    return { ok: false, error: isTimeout ? '抓取超时：页面 20 秒内没有响应' : `抓取失败：${detail}` };
  }

  if (!fetched?.html || !fetched.html.trim()) return { ok: false, error: '抓取失败：页面返回空内容' };

  let result = await extractFromHtml(fetched.html, extraction, watch, isRows);

  // 从用户标签页取到的内容不可用 → 用隐藏窗口重新导航一次（常见于你停在别的筛选/未登录）
  if (result.ok !== true && fetched.strategy === 'tab-reuse') {
    let retriedFetch = null;
    try {
      retriedFetch = await readHtmlViaHiddenTab(watch);
    } catch {
      retriedFetch = null;
    }
    if (retriedFetch?.html?.trim()) {
      const retried = await extractFromHtml(retriedFetch.html, extraction, watch, isRows);
      if (retried.ok === true) {
        retried.strategy = retriedFetch.strategy;
        return retried;
      }
    }
  }

  if (result.ok === true) result.strategy = fetched.strategy;
  return result;
}

// ---------------------------------------------------------------------------
// 投递：POST DSH-IM 主动投递接口
// ---------------------------------------------------------------------------

async function deliverText(text, settings) {
  const base = String(settings.dshBaseUrl ?? '').replace(/\/+$/u, '');
  if (!base) {
    return { ok: false, code: 'missing-config', message: '未填写 DSH 地址' };
  }
  if (!settings.botId || !settings.targetId) {
    return { ok: false, code: 'missing-config', message: 'Bot ID / Target ID 为空' };
  }

  const body = {
    botId: settings.botId,
    targetId: settings.targetId,
    text: clipMessage(text),
    format: 'plain',
  };

  try {
    const response = await fetch(`${base}/api/dsh-im/delivery/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }

    if (response.ok && payload?.sent === true) {
      return { ok: true, httpStatus: response.status };
    }

    const code = payload?.error?.code ?? httpStatusToCode(response.status);
    return {
      ok: false,
      code,
      message: payload?.error?.message ?? (raw ? raw.slice(0, 300) : `HTTP ${response.status}`),
      httpStatus: response.status,
    };
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      code: isTimeout ? 'timeout' : 'network-error',
      message: String(error?.message ?? error),
    };
  }
}

async function notifyLocal(watch, text) {
  try {
    await chrome.notifications.create(`dsh-monitor-${watch.id}-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `网页有变化：${watch.name}`,
      message: previewOf(text, 200),
      contextMessage: 'DSH 微信推送失败，这是本地兜底通知',
    });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

async function setBadgeFailed(failed) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    await chrome.action.setBadgeText({ text: failed ? '!' : '' });
  } catch {
    /* 忽略 */
  }
}

/**
 * 发送并记录结果：成功清错误、失败写 runtime + 本地兜底 + 安排重试。
 */
async function sendAndRecord(watch, text, { allowRetry = true } = {}) {
  const { settings } = await getState();
  const result = await deliverText(text, settings);
  const at = Date.now();

  if (result.ok) {
    await mutateState((state) => {
      state.runtime.lastDeliveryAt = at;
      state.runtime.lastDeliveryOk = true;
      state.runtime.lastDeliveryError = '';
      state.runtime.retry = null;
      state.runtime.counters.sent += 1;
      const index = state.watches.findIndex((item) => item.id === watch.id);
      if (index >= 0) state.watches[index].status = { ...state.watches[index].status, lastError: '' };
    });
    await chrome.alarms.clear(RETRY_ALARM);
    await setBadgeFailed(false);
    return { ok: true };
  }

  const hint = errorText(result.code, result.message);
  await mutateState((state) => {
    state.runtime.lastDeliveryAt = at;
    state.runtime.lastDeliveryOk = false;
    state.runtime.lastDeliveryError = hint;
    state.runtime.counters.failed += 1;
    const index = state.watches.findIndex((item) => item.id === watch.id);
    if (index >= 0) {
      state.watches[index].status = {
        ...state.watches[index].status,
        lastError: hint,
        lastErrorAt: at,
      };
    }
  });
  await setBadgeFailed(true);

  if (settings.localFallback && !settings.quiet) await notifyLocal(watch, text);
  if (allowRetry && RETRYABLE_CODES.has(result.code)) await scheduleRetry(watch.id, text);

  return { ok: false, code: result.code, message: hint };
}

async function scheduleRetry(watchId, text) {
  const next = await mutateState((state) => {
    const same = state.runtime.retry?.watchId === watchId;
    const attempt = same ? state.runtime.retry.attempt + 1 : 1;
    if (attempt > MAX_RETRY) {
      state.runtime.retry = null;
      return { attempt, giveUp: true };
    }
    state.runtime.retry = { watchId, attempt, text, dueAt: Date.now() + RETRY_DELAY_MS };
    return { attempt, giveUp: false };
  });

  if (!next.giveUp) {
    chrome.alarms.create(RETRY_ALARM, { when: Date.now() + RETRY_DELAY_MS });
  }
}

async function runRetry() {
  const state = await getState();
  const retry = state.runtime.retry;
  if (!retry) return;

  const result = await deliverText(retry.text, state.settings);
  const at = Date.now();

  if (result.ok) {
    await mutateState((current) => {
      current.runtime.retry = null;
      current.runtime.lastDeliveryAt = at;
      current.runtime.lastDeliveryOk = true;
      current.runtime.lastDeliveryError = '';
      current.runtime.counters.sent += 1;
    });
    await setBadgeFailed(false);
    return;
  }

  const hint = errorText(result.code, result.message);
  const giveUp = retry.attempt >= MAX_RETRY;
  await mutateState((current) => {
    current.runtime.lastDeliveryAt = at;
    current.runtime.lastDeliveryOk = false;
    current.runtime.lastDeliveryError = hint;
    if (giveUp) {
      current.runtime.retry = null;
      current.runtime.counters.failed += 1;
    } else {
      current.runtime.retry = { ...retry, attempt: retry.attempt + 1, dueAt: at + RETRY_DELAY_MS };
    }
  });

  if (!giveUp) chrome.alarms.create(RETRY_ALARM, { when: at + RETRY_DELAY_MS });
  else await setBadgeFailed(true);
}

// ---------------------------------------------------------------------------
// 单个监控项的检查流程
// ---------------------------------------------------------------------------

function intervalMsOf(watch) {
  const minutes = clamp(Number(watch.intervalMinutes) || 5, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES);
  return minutes * 60_000;
}

/**
 * @param {string} id
 * @param {{force?: boolean}} options
 * @returns {Promise<{id:string,name:string,changed:boolean,notified:boolean,skipped?:string,error?:string,valuePreview?:string}>}
 */
async function checkWatch(id, { force = false } = {}) {
  const { watches } = await getState();
  const watch = watches.find((item) => item.id === id);
  if (!watch) {
    return { id, name: '', changed: false, notified: false, error: '监控项不存在' };
  }
  if (!watch.enabled && !force) {
    return { id, name: watch.name, changed: false, notified: false, skipped: 'disabled' };
  }
  if (!force && Date.now() - (watch.status?.lastCheckedAt ?? 0) < intervalMsOf(watch)) {
    return { id, name: watch.name, changed: false, notified: false, skipped: 'not-due' };
  }

  const observed = await observe(watch);
  const at = Date.now();

  // 自动模式自愈成功：把新识别出的选择器写回监控项，后续检查就不用再猜
  if (observed.ok && observed.healed) {
    const healed = observed.healed;
    watch.rowSelector = healed.rowSelector;
    watch.keySelector = healed.keySelector;
    watch.statusSelector = healed.statusSelector;
    watch.waitForSelector = healed.rowSelector;
    await mutateWatch(id, (current) => ({
      ...current,
      rowSelector: healed.rowSelector,
      keySelector: healed.keySelector,
      statusSelector: healed.statusSelector,
      waitForSelector: healed.rowSelector,
      detection: {
        ...(current.detection ?? {}),
        source: 'auto-heal',
        at,
        headers: Array.isArray(healed.headers) ? healed.headers.slice(0, 20) : [],
      },
    }));
  }

  // 单值模式自愈：选择器失效后自动改用「页面主要内容」
  if (observed.ok && observed.healedSingle) {
    const healed = observed.healedSingle;
    watch.selector = healed.selector;
    watch.selectorType = 'css';
    await mutateWatch(id, (current) => ({
      ...current,
      selectorType: 'css',
      selector: healed.selector,
      detection: { ...(current.detection ?? {}), source: 'auto-heal', at },
    }));
  }

  // 记录这次实际用的抓取策略（tab-reuse=零窗口，hidden-window=隐藏窗口，direct=直连）
  if (observed.ok && observed.strategy) {
    watch.status = { ...watch.status, lastStrategy: observed.strategy };
    await mutateState((state) => {
      state.runtime.lastStrategy = observed.strategy;
      const index = state.watches.findIndex((item) => item.id === id);
      if (index >= 0) {
        state.watches[index].status = { ...state.watches[index].status, lastStrategy: observed.strategy };
      }
    });
  }

  if (!observed.ok) {
    await mutateWatch(id, (current) => ({
      ...current,
      status: {
        ...current.status,
        lastCheckedAt: at,
        lastError: observed.error,
        lastErrorAt: at,
        consecutiveErrors: (current.status?.consecutiveErrors ?? 0) + 1,
      },
    }));
    return { id, name: watch.name, changed: false, notified: false, error: observed.error };
  }

  return observed.kind === 'rows'
    ? applyRowsResult(watch, observed, at)
    : applySingleResult(watch, observed, at);
}

/** single 模式：整块内容做指纹比较。 */
async function applySingleResult(watch, observed, at) {
  const id = watch.id;
  const value = observed.value;
  const valuePreview = previewOf(value, 200);

  // 「忽略空值」：取不到内容时不更新基线，避免把空值当成一次真实变化
  if (watch.ignoreEmpty && !value) {
    await mutateWatch(id, (current) => ({
      ...current,
      status: { ...current.status, lastCheckedAt: at, lastError: '' },
    }));
    await bumpCounters({ checks: 1 });
    return { id, name: watch.name, changed: false, notified: false, skipped: 'empty', valuePreview };
  }

  const hash = await hashValue(value);
  const previous = watch.last;

  // 首次检查：只建立基线
  if (!previous) {
    await mutateWatch(id, (current) => ({
      ...current,
      last: { hash, value, at },
      status: {
        ...current.status,
        lastCheckedAt: at,
        lastError: '',
        consecutiveErrors: 0,
        lastValuePreview: valuePreview,
      },
    }));
    await bumpCounters({ checks: 1 });

    let notified = false;
    if (watch.notifyOnFirstRun) {
      const sent = await sendAndRecord(watch, buildBaselineMessage(watch, value, at));
      notified = sent.ok;
    }
    return { id, name: watch.name, changed: false, notified, valuePreview };
  }

  // 内容没变
  if (previous.hash === hash) {
    await mutateWatch(id, (current) => ({
      ...current,
      status: { ...current.status, lastCheckedAt: at, lastError: '', consecutiveErrors: 0 },
    }));
    await bumpCounters({ checks: 1 });
    return { id, name: watch.name, changed: false, notified: false, valuePreview };
  }

  // 内容变了：先落盘新基线，再发通知（避免发送失败导致重复提醒）
  await mutateWatch(id, (current) => ({
    ...current,
    last: { hash, value, at },
    status: {
      ...current.status,
      lastCheckedAt: at,
      lastChangedAt: at,
      lastError: '',
      consecutiveErrors: 0,
      lastValuePreview: valuePreview,
    },
  }));
  await bumpCounters({ checks: 1, changes: 1 });

  const keywordOk = !watch.keyword || value.includes(watch.keyword);
  if (!keywordOk) {
    return { id, name: watch.name, changed: true, notified: false, valuePreview };
  }

  const sent = await sendAndRecord(watch, buildChangeMessage(watch, previous.value, value, at));
  return {
    id,
    name: watch.name,
    changed: true,
    notified: sent.ok,
    error: sent.ok ? undefined : sent.message,
    valuePreview,
  };
}

/** rows 模式：逐行对比「键 → 状态」，把差异整理成一条消息。 */
async function applyRowsResult(watch, observed, at) {
  const id = watch.id;
  const { rows, map, value } = observed;
  const valuePreview = rowsPreview(rows);
  const hash = await hashValue(value);
  const previous = watch.last;

  // 首次检查：只建立基线
  if (!previous) {
    await mutateWatch(id, (current) => ({
      ...current,
      last: { hash, value, count: rows.length, at },
      status: {
        ...current.status,
        lastCheckedAt: at,
        lastError: '',
        consecutiveErrors: 0,
        lastValuePreview: valuePreview,
      },
    }));
    await bumpCounters({ checks: 1 });

    let notified = false;
    if (watch.notifyOnFirstRun) {
      const sent = await sendAndRecord(watch, buildRowsBaselineMessage(watch, map, at));
      notified = sent.ok;
    }
    return { id, name: watch.name, changed: false, notified, count: rows.length, valuePreview };
  }

  // 没有任何行变化
  if (previous.hash === hash) {
    await mutateWatch(id, (current) => ({
      ...current,
      status: { ...current.status, lastCheckedAt: at, lastError: '', consecutiveErrors: 0, lastValuePreview: valuePreview },
    }));
    await bumpCounters({ checks: 1 });
    return { id, name: watch.name, changed: false, notified: false, count: rows.length, valuePreview };
  }

  const rawDiff = diffRows(parseRows(previous.value), map);
  const totalChanges = rawDiff.changed.length + rawDiff.added.length + rawDiff.removed.length;

  // 按开关过滤：新增/消失行默认策略不同；再按 onlyStatuses 过滤
  const notifyDiff = {
    changed: rawDiff.changed,
    added: watch.rowsNotifyAdded === false ? [] : rawDiff.added,
    removed: watch.rowsNotifyRemoved === true ? rawDiff.removed : [],
  };
  const filtered = filterRowsDiff(notifyDiff, { onlyStatuses: watch.onlyStatuses });
  const notifyCount = filtered.changed.length + filtered.added.length + filtered.removed.length;

  // 先落盘新基线，再发通知（发送失败不会导致下一轮重复提醒）
  await mutateWatch(id, (current) => ({
    ...current,
    last: { hash, value, count: rows.length, at },
    status: {
      ...current.status,
      lastCheckedAt: at,
      lastChangedAt: at,
      lastError: '',
      consecutiveErrors: 0,
      lastValuePreview: valuePreview,
    },
  }));
  await bumpCounters({ checks: 1, changes: 1 });

  if (notifyCount === 0) {
    return {
      id,
      name: watch.name,
      changed: totalChanges > 0,
      notified: false,
      count: rows.length,
      valuePreview,
    };
  }

  const sent = await sendAndRecord(watch, buildRowsChangeMessage(watch, filtered, at));
  return {
    id,
    name: watch.name,
    changed: true,
    notified: sent.ok,
    error: sent.ok ? undefined : sent.message,
    count: rows.length,
    valuePreview,
  };
}

// ---------------------------------------------------------------------------
// 调度
// ---------------------------------------------------------------------------

let sweepInflight = null;

async function runSweep({ force = false } = {}) {
  const { watches } = await getState();
  const results = [];

  for (const watch of watches) {
    // 停用的监控项永远不参与批量检查（单条「立即检查」会用 force 单独放行）
    if (!watch.enabled) continue;
    if (!force && Date.now() - (watch.status?.lastCheckedAt ?? 0) < intervalMsOf(watch)) continue;
    try {
      results.push(await checkWatch(watch.id, { force }));
    } catch (error) {
      results.push({
        id: watch.id,
        name: watch.name,
        changed: false,
        notified: false,
        error: `检查异常：${String(error?.message ?? error)}`,
      });
    }
  }

  await mutateState((state) => {
    state.runtime.lastSweepAt = Date.now();
  });

  return results;
}

function sweep(options = {}) {
  if (sweepInflight) return sweepInflight;
  sweepInflight = runSweep(options).finally(() => {
    sweepInflight = null;
  });
  return sweepInflight;
}

async function ensureSweepAlarm() {
  const { watches } = await getState();
  const enabled = watches.filter((watch) => watch.enabled);
  await chrome.alarms.clear(SWEEP_ALARM);

  if (enabled.length === 0) return;

  const shortest = Math.min(...enabled.map((watch) => clamp(
    Number(watch.intervalMinutes) || 5,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
  )));

  chrome.alarms.create(SWEEP_ALARM, {
    periodInMinutes: Math.max(MIN_INTERVAL_MINUTES, shortest),
    delayInMinutes: MIN_INTERVAL_MINUTES,
  });
}

// ---------------------------------------------------------------------------
// 一键监控：探测当前标签页 / 按 URL 探测 / 自动创建监控项
// ---------------------------------------------------------------------------

/** 把探测到的候选行结构转成 extractRows 的入参。 */
function rowsExtractionFrom(candidate) {
  return {
    extractMode: 'rows',
    rowSelector: candidate?.rowSelector ?? '',
    keySelector: candidate?.keySelector ?? '',
    statusSelector: candidate?.statusSelector ?? '',
    keyAttr: '',
    statusAttr: '',
  };
}

async function readOuterHtml(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement.outerHTML,
  });
  return String(results?.[0]?.result ?? '');
}

/** 校验一个候选结构：用同一份 HTML 真跑一次 extractRows，取不到行就不算成功。 */
async function validateCandidate(html, candidate) {
  let parsed = null;
  try {
    parsed = await parseHtml(html, rowsExtractionFrom(candidate));
  } catch {
    parsed = null;
  }
  if (!parsed?.ok) return null;
  if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) return null;
  return parsed;
}

/** 在指定标签页上做结构探测 + 真实提取校验（不新开标签页）。 */
async function probeTab(tab) {
  if (!tab?.id) return { ok: false, error: '没有找到可用的标签页' };
  const url = String(tab.url ?? '');
  if (!/^https?:\/\//iu.test(url)) {
    return { ok: false, error: '当前页面不是普通网页（chrome://、about: 等），无法监控' };
  }

  let detected = null;
  let detectError = '';
  try {
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: detectTables,
    });
    detected = entry?.result ?? null;
  } catch (error) {
    detectError = String(error?.message ?? error);
  }
  if (!detected && !detectError) detectError = '无法读取当前页面结构';
  if (detected?.loginRequired) return { ok: false, error: ERROR_HINTS['login-required'] };

  let html = '';
  try {
    html = await readOuterHtml(tab.id);
  } catch (error) {
    return { ok: false, error: `无法读取当前页面：${detectError || String(error?.message ?? error)}` };
  }

  const base = { tabId: tab.id, url, title: tab.title ?? '', stats: detected?.stats ?? null };
  const candidates = Array.isArray(detected?.candidates) ? detected.candidates : [];

  // 1) 优先：识别成「列表」，逐行对比
  for (const candidate of candidates.slice(0, 3)) {
    const parsed = await validateCandidate(html, candidate);
    if (parsed) {
      return {
        ...base,
        ok: true,
        kind: 'rows',
        candidate,
        preview: { count: parsed.count, rows: parsed.rows.slice(0, 5) },
      };
    }
  }

  // 2) 通用兜底：监控页面「主要内容」整块变化（不要求有表格）
  const main = await detectMainInHtml(html);
  if (main?.ok && main.length >= 80) {
    return {
      ...base,
      ok: true,
      kind: 'single',
      candidate: {
        selectorType: 'css',
        selector: main.selector,
        valueKind: 'text',
        headers: [],
        samples: [],
        note: '页面主要内容',
        rowSelector: '',
        keySelector: '',
        statusSelector: '',
      },
      preview: {
        count: 1,
        rows: [{ key: '页面内容', value: main.preview }],
        length: main.length,
      },
    };
  }

  // 3) 都失败：给出可定位的诊断
  const diagnostics = {
    tables: detected?.stats?.tables ?? 0,
    trs: detected?.stats?.trs ?? 0,
    roots: detected?.stats?.roots ?? 0,
    candidates: candidates.length,
    htmlLength: html.length,
    detectError,
  };
  const reason = candidates.length > 0
    ? '识别到表格但没取到行（列结构可能特殊）'
    : (diagnostics.trs === 0 ? '页面里没有可识别的列表，也没找到主要内容（可能还在加载/未登录）' : '页面有表格但未识别出可用列');
  return {
    ok: false,
    error: `${reason}。可直接展开「高级」手动配置，或把下面的诊断发给开发者。`,
    diagnostics,
  };
}

/** 「一键监控当前页面」：对用户正在看的标签页做探测。 */
async function probeActiveTab() {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs?.[0] ?? null;
  } catch {
    tab = null;
  }
  if (!tab) return { ok: false, error: '没有找到当前标签页' };
  return probeTab(tab);
}

/** 按 URL 探测：临时开一个隐藏标签页，探测完就关。 */
async function probeUrl(url) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//iu.test(target)) {
    return { ok: false, error: '页面地址必须以 http:// 或 https:// 开头' };
  }

  let tabId = null;
  try {
    const windowId = await getHiddenWindowId().catch(() => null);
    const tab = windowId
      ? await chrome.tabs.create({ windowId, url: target, active: false })
      : await chrome.tabs.create({ url: target, active: false });
    tabId = tab.id;

    await waitForDocumentReady(tabId, TAB_LOAD_TIMEOUT_MS);

    const [entry] = await chrome.scripting.executeScript({
      target: { tabId },
      func: detectTables,
    });
    const detected = entry?.result ?? null;
    if (detected?.loginRequired) return { ok: false, error: ERROR_HINTS['login-required'] };

    const html = await readOuterHtml(tabId);
    const info = await tabInfo(tabId);
    const base = { tabId: null, url: target, title: info.title, stats: detected?.stats ?? null };

    // 1) 列表
    const candidates = Array.isArray(detected?.candidates) ? detected.candidates : [];
    for (const candidate of candidates.slice(0, 3)) {
      const parsed = await validateCandidate(html, candidate);
      if (parsed) {
        return {
          ...base,
          ok: true,
          kind: 'rows',
          candidate,
          preview: { count: parsed.count, rows: parsed.rows.slice(0, 5) },
        };
      }
    }

    // 2) 通用兜底：页面主要内容
    const main = await detectMainInHtml(html);
    if (main?.ok && main.length >= 80) {
      return {
        ...base,
        ok: true,
        kind: 'single',
        candidate: {
          selectorType: 'css',
          selector: main.selector,
          valueKind: 'text',
          headers: [],
          samples: [],
          note: '页面主要内容',
          rowSelector: '',
          keySelector: '',
          statusSelector: '',
        },
        preview: {
          count: 1,
          rows: [{ key: '页面内容', value: main.preview }],
          length: main.length,
        },
      };
    }

    return {
      ok: false,
      error: '没在这个页面识别到内容（可能需要先登录，或页面还在加载）。可展开「高级」手动配置。',
      diagnostics: {
        tables: detected?.stats?.tables ?? 0,
        trs: detected?.stats?.trs ?? 0,
        candidates: candidates.length,
        htmlLength: html.length,
      },
    };
  } catch (error) {
    return { ok: false, error: `打开页面失败：${String(error?.message ?? error)}` };
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 从页面标题/域名生成一个像样的监控项名字。 */
function autoWatchName(title, url) {
  const clean = String(title ?? '').trim();
  if (clean) {
    return clean.split(/[|｜\-—·]/u)[0].trim().slice(0, 40) || clean.slice(0, 40);
  }
  try {
    return `${new URL(url).hostname} 列表`;
  } catch {
    return '网页列表监控';
  }
}

/** 「一键监控」：探测 + 直接创建 autoDetect 监控项（选择器全部自动填）。 */
async function autoAddWatch({ tabId, url, intervalMinutes, forceKind }) {
  const interval = clamp(Number(intervalMinutes) || 3, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES);

  // 兜底：完全不识别结构，直接监控整页内容（适用于任何页面）
  if (forceKind === 'page') {
    let targetUrl = String(url ?? '').trim();
    let title = '';
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(Number(tabId));
        targetUrl = tab?.url ?? targetUrl;
        title = tab?.title ?? '';
      } catch {
        /* 用传入的 url */
      }
    }
    if (!/^https?:\/\//iu.test(targetUrl)) {
      return { ok: false, error: '当前页面不是普通网页，无法监控' };
    }
    const savedPage = await saveWatch({
      name: autoWatchName(title, targetUrl),
      url: targetUrl,
      mode: 'tab',
      extractMode: 'single',
      selectorType: 'css',
      selector: 'body',
      valueKind: 'text',
      attrName: '',
      waitForSelector: '',
      settleMs: 2500,
      intervalMinutes: interval,
      ignoreEmpty: true,
      notifyOnFirstRun: false,
      enabled: true,
      autoDetect: true,
      detection: { source: 'auto', kind: 'single', at: Date.now(), rowCount: 1, headers: [] },
    });
    if (!savedPage.ok) return savedPage;
    return {
      ok: true,
      kind: 'single',
      watch: savedPage.watch,
      preview: { count: 1, rows: [{ key: '页面内容', value: '整页正文（每次检查对比整页文本）' }] },
    };
  }

  let probe = null;
  if (tabId) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(Number(tabId));
    } catch {
      tab = null;
    }
    if (!tab) return { ok: false, error: '标签页已关闭，请重新点击扩展图标' };
    probe = await probeTab(tab);
  } else {
    probe = await probeUrl(url);
  }
  if (!probe.ok) return probe;

  const candidate = probe.candidate;
  const kind = probe.kind === 'single' ? 'single' : 'rows';

  const common = {
    name: autoWatchName(probe.title, probe.url),
    url: probe.url,
    mode: 'tab',
    intervalMinutes: interval,
    ignoreEmpty: true,
    notifyOnFirstRun: false,
    enabled: true,
    autoDetect: true,
    settleMs: 2500,
    detection: {
      source: 'auto',
      kind,
      at: Date.now(),
      rowCount: kind === 'single' ? 1 : probe.preview.count,
      headers: Array.isArray(candidate.headers) ? candidate.headers.slice(0, 20) : [],
    },
  };

  const saved = await saveWatch(kind === 'single'
    ? {
      ...common,
      extractMode: 'single',
      selectorType: 'css',
      selector: candidate.selector,
      valueKind: 'text',
      attrName: '',
      waitForSelector: '',
    }
    : {
      ...common,
      extractMode: 'rows',
      rowSelector: candidate.rowSelector,
      keySelector: candidate.keySelector,
      statusSelector: candidate.statusSelector,
      keyAttr: '',
      statusAttr: '',
      rowsNotifyAdded: true,
      rowsNotifyRemoved: false,
      onlyStatuses: '',
      waitForSelector: candidate.rowSelector,
    });

  if (!saved.ok) return saved;
  return { ok: true, watch: saved.watch, preview: probe.preview, kind };
}

// ---------------------------------------------------------------------------
// 页面结构探测：开一个后台标签页，注入 detectTables 找「任务列表」表格
// ---------------------------------------------------------------------------

async function detectTableOnPage(url) {
  if (!(await hasSitePermission(url))) {
    return { ok: false, error: ERROR_HINTS['no-permission'] };
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (error) {
    return { ok: false, error: `打开页面失败：${String(error?.message ?? error)}` };
  }

  try {
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    const deadline = Date.now() + DETECT_TIMEOUT_MS;
    let lastResult = null;

    while (Date.now() < deadline) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: detectTables,
        });
        lastResult = result ?? null;
      } catch {
        /* 页面可能还在导航，下一轮再试 */
      }

      if (lastResult?.loginRequired) {
        return { ok: false, loginRequired: true, error: ERROR_HINTS['login-required'] };
      }
      if (Array.isArray(lastResult?.candidates) && lastResult.candidates.length > 0) {
        return { ok: true, candidates: lastResult.candidates, stats: lastResult.stats ?? null };
      }
      await sleep(1000);
    }

    // 超时后再确认一次是不是被踢到登录页
    const info = await tabInfo(tab.id);
    if (/login|signin|passport|登录|扫码/iu.test(`${info.url} ${info.title}`)) {
      return { ok: false, loginRequired: true, error: ERROR_HINTS['login-required'] };
    }

    // 带上页面结构统计，方便判断是「没登录/还在加载」还是「表格结构不认识」
    const stats = lastResult?.stats ?? null;
    const extra = stats
      ? `（页面里 table ${stats.tables} 个、tr ${stats.trs} 个`
        + `${stats.roots > 1 ? `、#root ${stats.roots} 个（重复，别用 #root 长路径）` : ''}）`
      : '';
    return { ok: false, error: `${ERROR_HINTS['detect-failed']}${extra}` };
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 监控项校验与保存
// ---------------------------------------------------------------------------

function validateWatch(input) {
  const errors = [];
  const source = input && typeof input === 'object' ? input : {};

  const name = String(source.name ?? '').trim();
  if (!name) errors.push('请填写监控名称');
  if (name.length > 80) errors.push('监控名称不要超过 80 个字');

  const url = String(source.url ?? '').trim();
  if (!url) {
    errors.push('请填写监控地址');
  } else if (!/^https?:\/\//iu.test(url)) {
    errors.push('监控地址必须以 http:// 或 https:// 开头');
  } else {
    try {
      new URL(url);
    } catch {
      errors.push('监控地址不是合法网址');
    }
  }

  const extractMode = source.extractMode === 'rows' ? 'rows' : 'single';

  // single 模式才校验单值选择器
  let selector = '';
  let selectorType = 'css';
  let valueKind = 'text';
  let attrName = '';
  if (extractMode === 'single') {
    selector = String(source.selector ?? '').trim();
    if (!selector) errors.push('请填写选择器');
    selectorType = source.selectorType === 'xpath' ? 'xpath' : 'css';
    valueKind = ['text', 'html', 'attr'].includes(source.valueKind) ? source.valueKind : 'text';
    attrName = String(source.attrName ?? '').trim();
    if (valueKind === 'attr' && !attrName) errors.push('取值方式选「属性」时必须填写属性名');
  }

  // rows 模式：行选择器 + 状态选择器必填，键选择器可留空（退化为整行文本）
  const rowSelector = extractMode === 'rows' ? String(source.rowSelector ?? '').trim() : '';
  const statusSelector = extractMode === 'rows' ? String(source.statusSelector ?? '').trim() : '';
  const keySelector = extractMode === 'rows' ? String(source.keySelector ?? '').trim() : '';
  const keyAttr = extractMode === 'rows' ? String(source.keyAttr ?? '').trim() : '';
  const statusAttr = extractMode === 'rows' ? String(source.statusAttr ?? '').trim() : '';
  const onlyStatuses = extractMode === 'rows' ? String(source.onlyStatuses ?? '').trim() : '';
  if (extractMode === 'rows') {
    if (!rowSelector) errors.push('列表模式必须填写「行选择器」');
    if (!statusSelector) errors.push('列表模式必须填写「状态选择器」');
  }

  const waitForSelector = String(source.waitForSelector ?? '').trim();
  const rawSettleMs = Number(source.settleMs);
  const settleMs = clamp(
    Number.isFinite(rawSettleMs) ? rawSettleMs : DEFAULT_SETTLE_MS,
    0,
    MAX_SETTLE_MS,
  );

  const intervalMinutes = clamp(
    Number(source.intervalMinutes) || 5,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
  );

  const keyword = extractMode === 'single' ? String(source.keyword ?? '').trim() : '';

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    watch: {
      id: String(source.id ?? '').trim(),
      name,
      url,
      enabled: source.enabled !== false,
      mode: source.mode === 'tab' ? 'tab' : 'direct',
      extractMode,
      selectorType,
      selector,
      valueKind,
      attrName,
      rowSelector,
      keySelector,
      statusSelector,
      keyAttr,
      statusAttr,
      rowsNotifyAdded: source.rowsNotifyAdded !== false,
      rowsNotifyRemoved: source.rowsNotifyRemoved === true,
      onlyStatuses,
      waitForSelector,
      settleMs,
      intervalMinutes,
      keyword,
      ignoreEmpty: source.ignoreEmpty !== false,
      notifyOnFirstRun: source.notifyOnFirstRun === true,
      autoDetect: source.autoDetect === true,
      detection: (source.detection && typeof source.detection === 'object') ? source.detection : null,
      createdAt: Number(source.createdAt) || Date.now(),
    },
  };
}

function newWatchId() {
  return `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function saveWatch(input) {
  const validated = validateWatch(input);
  if (!validated.ok) {
    return { ok: false, error: validated.errors.join('；'), errors: validated.errors };
  }

  const draft = validated.watch;
  if (!(await hasSitePermission(draft.url))) {
    return { ok: false, error: ERROR_HINTS['no-permission'] };
  }

  const saved = await mutateState((state) => {
    const index = draft.id ? state.watches.findIndex((item) => item.id === draft.id) : -1;
    if (index >= 0) {
      // 更新：保留基线之外的运行时状态；URL/选择器一变就清空基线，下次重新建立
      const current = state.watches[index];
      const selectionChanged = current.url !== draft.url
        || current.mode !== draft.mode
        || current.extractMode !== draft.extractMode
        || current.selector !== draft.selector
        || current.selectorType !== draft.selectorType
        || current.valueKind !== draft.valueKind
        || current.attrName !== draft.attrName
        || current.rowSelector !== draft.rowSelector
        || current.keySelector !== draft.keySelector
        || current.statusSelector !== draft.statusSelector
        || current.keyAttr !== draft.keyAttr
        || current.statusAttr !== draft.statusAttr
        || current.waitForSelector !== draft.waitForSelector;

      const next = {
        ...current,
        ...draft,
        id: current.id,
        createdAt: current.createdAt,
        last: selectionChanged ? null : current.last,
        status: selectionChanged
          ? {
            lastCheckedAt: 0,
            lastChangedAt: 0,
            lastError: '',
            lastErrorAt: 0,
            consecutiveErrors: 0,
            lastValuePreview: '',
          }
          : current.status,
      };
      state.watches[index] = next;
      return next;
    }

    const created = {
      ...draft,
      id: newWatchId(),
      status: {
        lastCheckedAt: 0,
        lastChangedAt: 0,
        lastError: '',
        lastErrorAt: 0,
        consecutiveErrors: 0,
        lastValuePreview: '',
      },
      last: null,
    };
    state.watches.push(created);
    return created;
  });

  await ensureSweepAlarm();
  return { ok: true, watch: toPublicWatch(saved) };
}

async function deleteWatch(id) {
  await closeWatchTab(id);
  await mutateState((state) => {
    state.watches = state.watches.filter((item) => item.id !== id);
  });
  await ensureSweepAlarm();
  await closeHiddenWindowIfUnused();
  return { ok: true };
}

async function toggleWatch(id, enabled) {
  const watch = await mutateWatch(id, (current) => ({
    ...current,
    enabled: enabled === true,
  }));
  if (!watch) return { ok: false, error: '监控项不存在' };
  if (enabled !== true) await closeWatchTab(id);
  await ensureSweepAlarm();
  await closeHiddenWindowIfUnused();
  return { ok: true, watch: toPublicWatch(watch) };
}

async function saveSettings(patch) {
  const settings = await mutateState(async (state) => {
    const next = { ...state.settings, ...(patch && typeof patch === 'object' ? patch : {}) };
    next.dshBaseUrl = String(next.dshBaseUrl ?? '').trim().replace(/\/+$/u, '');
    next.botId = String(next.botId ?? '').trim();
    next.targetId = String(next.targetId ?? '').trim();
    next.localFallback = next.localFallback !== false;
    next.quiet = next.quiet === true;
    next.silentTabs = next.silentTabs !== false;

    // 投递地址不在常驻 host_permissions（本机）内时，先确认扩展确实拿到了该地址的权限，
    // 否则用户改动 DSH 地址后只会看到难懂的 network-error。
    if (next.dshBaseUrl) {
      let origin = '';
      try {
        origin = new URL(next.dshBaseUrl).origin;
      } catch {
        throw new Error('DSH 地址格式不正确，例如 http://127.0.0.1:52020');
      }
      const hostname = new URL(next.dshBaseUrl).hostname;
      const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
      const allowed = isLoopback
        ? true
        : await chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false);
      if (!allowed) {
        throw new Error(
          '当前扩展只被允许访问本机 DSH（127.0.0.1 / localhost）。'
          + '要使用其他地址，请在 manifest.json 的 host_permissions 里加上该地址后重新加载扩展。',
        );
      }
    }

    state.settings = next;
    return next;
  });
  return { ok: true, settings };
}

// ---------------------------------------------------------------------------
// 消息路由（options / popup 唯一入口）
// ---------------------------------------------------------------------------

async function handleMessage(message) {
  switch (message?.type) {
    case 'get-state': {
      const { settings, watches, runtime } = await getState();
      return {
        ok: true,
        settings,
        watches: watches.map(toPublicWatch),
        runtime,
      };
    }

    case 'save-settings':
      return saveSettings(message.settings);

    case 'save-watch': {
      const saved = await saveWatch(message.watch);
      if (!saved.ok) return saved;
      const { watches } = await getState();
      return { ok: true, watch: saved.watch, watches: watches.map(toPublicWatch) };
    }

    case 'delete-watch': {
      const removed = await deleteWatch(String(message.id ?? ''));
      if (!removed.ok) return removed;
      const { watches } = await getState();
      return { ok: true, watches: watches.map(toPublicWatch) };
    }

    case 'toggle-watch':
      return toggleWatch(String(message.id ?? ''), Boolean(message.enabled));

    case 'run-check': {
      const id = message.id ? String(message.id) : '';
      if (id) {
        const result = await checkWatch(id, { force: true });
        return { ok: !result.error, results: [result], error: result.error };
      }
      const results = await sweep({ force: true });
      const failed = results.filter((item) => item.error);
      return {
        ok: failed.length === 0,
        results,
        error: failed.length === 0 ? '' : `${failed.length} 个监控项检查失败`,
      };
    }

    case 'get-preview': {
      const validated = validateWatch(message.watch);
      if (!validated.ok) return { ok: false, error: validated.errors.join('；') };
      const observed = await observe(validated.watch);
      if (!observed.ok) return { ok: false, error: observed.error };

      if (observed.kind === 'rows') {
        return {
          ok: true,
          count: observed.count,
          rows: observed.rows.slice(0, 20),
          valuePreview: rowsPreview(observed.rows, 12),
        };
      }

      return {
        ok: true,
        length: observed.value.length,
        valuePreview: previewOf(observed.value, 400),
      };
    }

    case 'detect-table': {
      const url = String(message.url ?? '').trim();
      if (!url) return { ok: false, error: '请先填写监控地址，再点自动探测' };
      try {
        new URL(url);
      } catch {
        return { ok: false, error: '监控地址不是合法网址' };
      }
      return detectTableOnPage(url);
    }

    case 'probe-active-tab':
      return probeActiveTab();

    case 'auto-add':
      return autoAddWatch({
        tabId: message.tabId,
        url: message.url,
        intervalMinutes: message.intervalMinutes,
        forceKind: message.forceKind,
      });

    case 'test-delivery': {
      const { settings } = await getState();
      const text = typeof message.text === 'string' && message.text.trim()
        ? message.text
        : buildTestMessage();
      const result = await deliverText(text, settings);
      const at = Date.now();

      await mutateState((state) => {
        state.runtime.lastDeliveryAt = at;
        state.runtime.lastDeliveryOk = result.ok;
        state.runtime.lastDeliveryError = result.ok ? '' : errorText(result.code, result.message);
        if (result.ok) state.runtime.counters.sent += 1;
        else state.runtime.counters.failed += 1;
      });
      await setBadgeFailed(!result.ok);

      return result.ok
        ? { ok: true }
        : { ok: false, code: result.code, message: errorText(result.code, result.message) };
    }

    default:
      return { ok: false, error: ERROR_HINTS['unknown-message'] };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 离屏文档的就绪通知：只记录，不阻塞
  if (message?.type === 'offscreen/ready') return undefined;

  handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));

  return true; // 异步响应
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    // 初始化缺省设置（已存在时保留用户值）
    await mutateState(() => {});
    await ensureSweepAlarm();
    await sweep().catch(() => {});
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureSweepAlarm();
    await sweep().catch(() => {});
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) {
    void sweep().catch((error) => console.error('[dsh-monitor] sweep 失败', error));
  } else if (alarm.name === RETRY_ALARM) {
    void runRetry().catch((error) => console.error('[dsh-monitor] 重试失败', error));
  }
});
