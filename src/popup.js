/**
 * popup.js —— 工具栏弹出面板脚本
 *
 * 主流程：「监控这个页面的列表」→ probe-active-tab → 预览任务状态 → 保存为监控项。
 * 下方保留运行概览与原有操作（立即检查全部 / 打开设置）。
 *
 * 约定（见 docs/ARCHITECTURE.md）：
 *  - 普通脚本（非 ES module），由 popup.html 通过 <script src> 引入；
 *  - 只通过 chrome.runtime.sendMessage 与 background 通信，不直接读写 chrome.storage；
 *  - 动态内容全部用 textContent 渲染，不用 innerHTML 拼接。
 */
'use strict';

/* ============================== 常量 ============================== */

const DEFAULT_SETTINGS = {
  dshBaseUrl: 'http://127.0.0.1:52020',
  botId: '',
  targetId: '',
  localFallback: true,
  quiet: false,
  silentTabs: true
};

const DEFAULT_RUNTIME = {
  lastSweepAt: 0,
  lastDeliveryAt: 0,
  lastDeliveryError: '',
  lastDeliveryOk: null,
  counters: { checks: 0, changes: 0, sent: 0, failed: 0 },
  retry: null
};

const DEFAULT_WATCH_STATUS = {
  lastCheckedAt: 0,
  lastChangedAt: 0,
  lastError: '',
  lastErrorAt: 0,
  consecutiveErrors: 0,
  lastValuePreview: ''
};

/* ============================== DOM 引用 ============================== */

const dom = {};

function cacheDom() {
  dom.appLogo = byId('app-logo');
  dom.deliveryBadge = byId('delivery-badge');

  // 一键监控
  dom.pageTitle = byId('page-title');
  dom.pageDomain = byId('page-domain');
  dom.pageUnsupported = byId('page-unsupported');
  dom.monitorButton = byId('monitor-this-page');
  dom.probeStatus = byId('probe-status');
  dom.probeResult = byId('probe-result');
  dom.probeSummary = byId('probe-summary');
  dom.probeRows = byId('probe-rows');
  dom.monitorInterval = byId('monitor-interval');
  dom.saveButton = byId('save-auto-watch');
  dom.autoSaveStatus = byId('auto-save-status');
  dom.probeError = byId('probe-error');
  dom.probeErrorText = byId('probe-error-text');
  dom.probeDiagnostics = byId('probe-diagnostics');
  dom.copyDiagnostics = byId('copy-diagnostics');
  dom.pageFallbackButton = byId('monitor-page-fallback');
  dom.probeOpenOptions = byId('probe-open-options');

  // 运行概览
  dom.dshState = byId('dsh-state');
  dom.dshDetail = byId('dsh-detail');
  dom.watchCount = byId('watch-count');
  dom.watchDetail = byId('watch-detail');
  dom.lastCheck = byId('last-check');
  dom.weekChanges = byId('week-changes');
  dom.weekDetail = byId('week-detail');
  dom.totalChanges = byId('total-changes');
  dom.errorPanel = byId('error-panel');
  dom.latestError = byId('latest-error');
  dom.retryPanel = byId('retry-panel');
  dom.retryText = byId('retry-text');
  dom.runCheckAll = byId('run-check-all');
  dom.openOptions = byId('open-options');
  dom.popupStatus = byId('popup-status');
  dom.totalChecks = byId('total-checks');
  dom.totalSent = byId('total-sent');
  dom.totalFailed = byId('total-failed');
}

/* ============================== 页面状态 ============================== */

const state = {
  settings: Object.assign({}, DEFAULT_SETTINGS),
  watches: [],
  runtime: Object.assign({}, DEFAULT_RUNTIME, {
    counters: Object.assign({}, DEFAULT_RUNTIME.counters)
  }),
  tab: null,          // chrome.tabs.Tab 或 null
  tabSupported: false, // 当前页是否为 http(s)
  probe: null,        // 最近一次 probe-active-tab 的成功响应
  probeKind: 'rows',  // 'rows' | 'single'
  lastProbeError: '', // 最近一次识别失败的 error 文本（供复制诊断）
  lastDiagnostics: null // 最近一次识别失败的 diagnostics 对象
};

const busy = {
  probe: false,
  save: false,
  fallback: false,
  runAll: false
};

/* ============================== 通用工具 ============================== */

function byId(id) {
  return document.getElementById(id);
}

function el(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function setText(node, text) {
  if (node) node.textContent = text === undefined || text === null ? '' : String(text);
}

function setHidden(node, hidden) {
  if (node) node.hidden = Boolean(hidden);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地时间 YYYY-MM-DD HH:mm:ss。 */
function formatTime(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
    ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

function errorMessageOf(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function watchStatus(watch) {
  return Object.assign({}, DEFAULT_WATCH_STATUS, (watch && watch.status) || {});
}

/** 本周起点：本地时间本周一 00:00:00。 */
function startOfWeekTime(now) {
  const date = new Date(now);
  const day = date.getDay(); // 0 = 周日
  const offset = (day + 6) % 7; // 距离周一的天数
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

/* ============================== 后台通信 ============================== */

function sendMessage(message) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const settle = function (callback, value) {
      if (settled) return;
      settled = true;
      callback(value);
    };
    try {
      chrome.runtime.sendMessage(message, function (response) {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          settle(reject, new Error('无法连接扩展后台：' + lastError.message));
          return;
        }
        settle(resolve, response);
      });
    } catch (error) {
      settle(reject, new Error('无法连接扩展后台：' + errorMessageOf(error)));
    }
  });
}

async function callBackground(message) {
  const response = await sendMessage(message);
  if (!response || typeof response !== 'object') {
    throw new Error('扩展后台返回了无效结果，请重试');
  }
  if (response.ok !== true) {
    throw new Error(response.error || '操作失败，请查看扩展后台日志');
  }
  return response;
}

/** 查询当前活动标签页（失败返回 null，不抛异常）。 */
function queryActiveTab() {
  return new Promise(function (resolve) {
    if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
      resolve(null);
      return;
    }
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve(null);
          return;
        }
        resolve(Array.isArray(tabs) && tabs.length ? tabs[0] : null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

/* ============================== 当前页面 ============================== */

async function loadCurrentTab() {
  state.tab = await queryActiveTab();
  renderCurrentPage();
}

function renderCurrentPage() {
  const tab = state.tab;
  const url = String((tab && tab.url) || '');
  const supported = /^https?:\/\//iu.test(url);
  state.tabSupported = supported;

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (error) {
    host = '';
  }

  if (!tab) {
    setText(dom.pageTitle, '无法读取当前页面');
    setText(dom.pageDomain, '请确认扩展已被允许访问当前标签页');
  } else {
    setText(dom.pageTitle, String(tab.title || '').trim() || host || '当前页面');
    setText(dom.pageDomain, host ? '域名：' + host : '');
  }

  setHidden(dom.pageUnsupported, supported);
  dom.monitorButton.disabled = !supported;
  if (!supported) {
    setHidden(dom.probeResult, true);
    setHidden(dom.probeError, true);
    setText(dom.probeStatus, '');
    state.probe = null;
  }
}

/* ============================== 一键监控流程 ============================== */

function setProbeStatus(kind, message) {
  if (!dom.probeStatus) return;
  dom.probeStatus.textContent = message || '';
  dom.probeStatus.classList.remove('is-ok', 'is-error');
  if (kind === 'ok') dom.probeStatus.classList.add('is-ok');
  if (kind === 'error') dom.probeStatus.classList.add('is-error');
}

function setAutoSaveStatus(kind, message) {
  if (!dom.autoSaveStatus) return;
  dom.autoSaveStatus.textContent = message || '';
  dom.autoSaveStatus.classList.remove('is-ok', 'is-error');
  if (kind === 'ok') dom.autoSaveStatus.classList.add('is-ok');
  if (kind === 'error') dom.autoSaveStatus.classList.add('is-error');
}

function setButtonBusy(button, isBusy, busyText) {
  if (!button) return;
  if (isBusy) {
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.disabled = true;
    if (busyText) button.textContent = busyText;
    return;
  }
  button.disabled = false;
  if (button.dataset.idleText) {
    button.textContent = button.dataset.idleText;
    delete button.dataset.idleText;
  }
}

/** 「任务名 → 状态」列表（rows 模式，最多 3 条）。 */
function renderProbeRows(rows) {
  dom.probeRows.textContent = '';
  if (!Array.isArray(rows) || rows.length === 0) {
    dom.probeRows.appendChild(el('li', 'probe-row-empty', '（没有预览数据）'));
    return;
  }
  rows.slice(0, 3).forEach(function (row) {
    const key = row && row.key !== undefined && row.key !== null ? String(row.key) : '';
    const value = row && row.value !== undefined && row.value !== null ? String(row.value) : '';
    dom.probeRows.appendChild(el('li', 'probe-row', key + ' → ' + value));
  });
}

/** single 模式：展示页面主要内容前 160 字预览。 */
function renderPagePreview(text) {
  dom.probeRows.textContent = '';
  const preview = String(text || '').slice(0, 160);
  dom.probeRows.appendChild(el(
    'li',
    'probe-row probe-preview-text',
    preview ? preview + (String(text || '').length > 160 ? '…' : '') : '（页面暂无文字预览）'
  ));
}

/** 诊断摘要，例如「页面：table 2 个 / tr 4 个 / HTML 12345 字符」。 */
function formatDiagnosticsText(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return '';
  const parts = [];
  const tables = Number(diagnostics.tables);
  if (Number.isFinite(tables)) parts.push('table ' + tables + ' 个');
  const trs = Number(diagnostics.trs);
  if (Number.isFinite(trs)) parts.push('tr ' + trs + ' 个');
  const roots = Number(diagnostics.roots);
  if (Number.isFinite(roots) && roots > 0) parts.push('roots ' + roots + ' 个');
  const candidates = Number(diagnostics.candidates);
  if (Number.isFinite(candidates)) parts.push('候选 ' + candidates + ' 个');
  const htmlLength = Number(diagnostics.htmlLength);
  if (Number.isFinite(htmlLength)) parts.push('HTML ' + htmlLength + ' 字符');
  if (diagnostics.detectError) parts.push('探测错误：' + String(diagnostics.detectError));
  return parts.length ? '页面：' + parts.join(' / ') : '';
}

/** 按 kind 渲染识别结果：rows=任务列表；single=页面主要内容。 */
function renderProbe(response) {
  const preview = response.preview || {};
  const rows = Array.isArray(preview.rows) ? preview.rows : [];
  const kind = response.kind === 'single' ? 'single' : 'rows';
  state.probeKind = kind;

  if (kind === 'single') {
    const pageText = String((rows[0] && rows[0].value) || '');
    const length = Number.isFinite(Number(preview.length))
      ? Number(preview.length)
      : pageText.length;
    setText(dom.probeSummary, '将监控这个页面的主要内容（约 ' + length + ' 字）');
    renderPagePreview(pageText);
  } else {
    const count = Number.isFinite(Number(preview.count)) ? Number(preview.count) : rows.length;
    const headers = Array.isArray(response.candidate && response.candidate.headers)
      ? response.candidate.headers.filter(function (text) {
        return Boolean(String(text || '').trim());
      })
      : [];
    setText(dom.probeSummary, '识别到 ' + count + ' 个任务'
      + (headers.length ? '（表头：' + headers.slice(0, 4).join('、') + '）' : ''));
    renderProbeRows(rows);
  }

  setHidden(dom.probeResult, false);
  setHidden(dom.probeError, true);
  setHidden(dom.probeDiagnostics, true);
  setHidden(dom.copyDiagnostics, true);
  setText(dom.probeDiagnostics, '');
  state.lastProbeError = '';
  state.lastDiagnostics = null;
  setProbeStatus('', '确认无误后点「保存为监控项」；首次检查只建立基线。');

  dom.saveButton.disabled = false;
  setText(dom.saveButton, '保存为监控项');
  delete dom.saveButton.dataset.idleText;
  setAutoSaveStatus('', '');
}

function showProbeError(message, diagnostics) {
  state.probe = null;
  state.lastProbeError = String(message || '没有识别到任务列表');
  state.lastDiagnostics = diagnostics && typeof diagnostics === 'object' ? diagnostics : null;

  setHidden(dom.probeResult, true);
  setHidden(dom.probeError, false);
  setText(dom.probeErrorText, state.lastProbeError);
  setProbeStatus('error', '识别失败：' + state.lastProbeError);

  const summary = formatDiagnosticsText(state.lastDiagnostics);
  setHidden(dom.probeDiagnostics, !summary);
  setText(dom.probeDiagnostics, summary);
  setHidden(dom.copyDiagnostics, !state.lastDiagnostics);

  dom.pageFallbackButton.disabled = false;
  setText(dom.pageFallbackButton, '改为监控整页内容');
  delete dom.pageFallbackButton.dataset.idleText;
}

/** 复制「error + diagnostics」到剪贴板，方便用户反馈。 */
async function handleCopyDiagnostics() {
  const payload = {
    error: state.lastProbeError || '',
    diagnostics: state.lastDiagnostics || null
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard-unavailable');
    }
    await navigator.clipboard.writeText(text);
    setProbeStatus('ok', '已复制诊断信息，可直接粘贴反馈。');
  } catch (error) {
    setProbeStatus('error', '复制失败，请截图或手动复制诊断信息反馈。');
  }
}

/** 失败兜底：不识别，直接把当前页建成「整页内容监控」。 */
async function handlePageFallback() {
  if (busy.fallback) return;
  const tab = state.tab || {};
  const url = String(tab.url || '');
  if (!/^https?:\/\//iu.test(url)) {
    setProbeStatus('error', '当前页面不支持监控（只支持 http / https 网页）。');
    return;
  }

  busy.fallback = true;
  setButtonBusy(dom.pageFallbackButton, true, '正在添加…');
  setProbeStatus('', '正在添加「整页内容监控」…');

  try {
    const intervalMinutes = Number(dom.monitorInterval.value) || 3;
    const response = await sendMessage({
      type: 'auto-add',
      tabId: tab.id,
      url: url,
      intervalMinutes: intervalMinutes,
      forceKind: 'page'
    });
    if (!response || typeof response !== 'object') {
      throw new Error('扩展后台返回了无效结果，请重试');
    }
    if (response.ok !== true) {
      showProbeError(response.error || '添加失败', response.diagnostics);
      return;
    }

    const watchName = response.watch && response.watch.name ? String(response.watch.name) : '整页内容';
    setHidden(dom.probeError, true);
    setHidden(dom.copyDiagnostics, true);
    setProbeStatus('ok', '已添加「' + watchName + '」：首次检查只建立基线，之后整页内容变化会推到微信。');
    setText(dom.pageFallbackButton, '已添加');
    dom.pageFallbackButton.disabled = true;
    delete dom.pageFallbackButton.dataset.idleText;
    try {
      await loadState();
    } catch (loadError) {
      /* 状态刷新失败不影响「已添加」结果 */
    }
  } catch (error) {
    setProbeStatus('error', '添加失败：' + errorMessageOf(error));
    dom.pageFallbackButton.disabled = false;
    setText(dom.pageFallbackButton, '改为监控整页内容');
  } finally {
    busy.fallback = false;
    if (!dom.pageFallbackButton.disabled) {
      setText(dom.pageFallbackButton, '改为监控整页内容');
      delete dom.pageFallbackButton.dataset.idleText;
    }
  }
}

async function handleMonitorThisPage() {
  if (busy.probe || !state.tabSupported) return;
  busy.probe = true;
  setButtonBusy(dom.monitorButton, true, '正在识别当前页面的任务列表…');
  setHidden(dom.probeResult, true);
  setHidden(dom.probeError, true);
  setHidden(dom.probeDiagnostics, true);
  setHidden(dom.copyDiagnostics, true);
  setProbeStatus('', '正在识别当前页面的任务列表…');

  try {
    const response = await sendMessage({ type: 'probe-active-tab' });
    if (!response || typeof response !== 'object') {
      throw new Error('扩展后台返回了无效结果，请重试');
    }
    if (response.ok !== true) {
      showProbeError(response.error || '没有识别到任务列表', response.diagnostics);
      return;
    }
    state.probe = response;
    renderProbe(response);
  } catch (error) {
    showProbeError(errorMessageOf(error), null);
  } finally {
    busy.probe = false;
    dom.monitorButton.textContent = '监控这个页面的列表';
    dom.monitorButton.disabled = !state.tabSupported;
  }
}

/** 保存成功文案（rows=任务状态变化；single=整页内容变化）。 */
function autoSaveSuccessText(watchName, kind) {
  const changeWord = kind === 'single' ? '内容变化' : '状态变化';
  const prefix = watchName ? '已添加「' + watchName + '」，' : '已添加，';
  return prefix + '首次检查只建立基线，之后' + changeWord + '会推到微信。';
}

async function handleSaveAutoWatch() {
  if (busy.save || !state.probe) {
    if (!state.probe) showProbeError('请先点「监控这个页面的列表」识别当前页面。');
    return;
  }

  busy.save = true;
  setButtonBusy(dom.saveButton, true, '正在保存…');
  setAutoSaveStatus('', '正在保存…');
  let saveOk = false;

  try {
    const probe = state.probe;
    const intervalMinutes = Number(dom.monitorInterval.value) || 3;
    const tab = state.tab || {};
    const response = await sendMessage({
      type: 'auto-add',
      tabId: probe.tabId !== undefined && probe.tabId !== null ? probe.tabId : tab.id,
      url: probe.url || tab.url || '',
      intervalMinutes: intervalMinutes
    });
    if (!response || typeof response !== 'object') {
      throw new Error('扩展后台返回了无效结果，请重试');
    }
    if (response.ok !== true) {
      // 保存失败也把 diagnostics 暴露出来，并给出「改为监控整页内容」兜底入口
      setAutoSaveStatus('error', '保存失败：' + (response.error || '未知错误'));
      showProbeError(response.error || '保存失败', response.diagnostics);
      return;
    }

    saveOk = true;
    const kind = response.kind === 'single' || state.probeKind === 'single' ? 'single' : 'rows';
    setAutoSaveStatus('ok', autoSaveSuccessText('', kind));
    setProbeStatus('', '');
    try {
      await loadState();
    } catch (loadError) {
      /* 状态刷新失败不影响「已添加」结果 */
    }

    const watchName = response.watch && response.watch.name ? String(response.watch.name) : '';
    if (watchName) setAutoSaveStatus('ok', autoSaveSuccessText(watchName, kind));
  } catch (error) {
    setAutoSaveStatus('error', '保存失败：' + errorMessageOf(error));
  } finally {
    busy.save = false;
    delete dom.saveButton.dataset.idleText;
    if (saveOk) {
      dom.saveButton.disabled = true;
      setText(dom.saveButton, '已添加');
    } else {
      dom.saveButton.disabled = false;
      setText(dom.saveButton, '保存为监控项');
    }
  }
}

/* ============================== 运行概览 ============================== */

async function loadState() {
  const response = await callBackground({ type: 'get-state' });
  state.settings = Object.assign({}, DEFAULT_SETTINGS, response.settings || {});
  state.watches = Array.isArray(response.watches) ? response.watches : [];

  const runtime = Object.assign({}, DEFAULT_RUNTIME, response.runtime || {});
  runtime.counters = Object.assign(
    {},
    DEFAULT_RUNTIME.counters,
    (response.runtime && response.runtime.counters) || {}
  );
  state.runtime = runtime;

  render();
}

/** 首次加载失败（例如后台尚未就绪）时把概览置为不可用状态。 */
function renderLoadError(message) {
  setBadge('未连接', 'badge-error');
  setText(dom.dshState, '未知');
  dom.dshState.className = 'stat-value is-error';
  setText(dom.dshDetail, message || '无法读取扩展状态');
  setText(dom.watchCount, '—');
  setText(dom.watchDetail, '启用 / 全部');
  setText(dom.lastCheck, '—');
  setText(dom.weekChanges, '—');
  setHidden(dom.errorPanel, true);
  setHidden(dom.retryPanel, true);
  setText(dom.totalChanges, '0');
  setText(dom.totalChecks, '0');
  setText(dom.totalSent, '0');
  setText(dom.totalFailed, '0');
}

function render() {
  const runtime = state.runtime;
  const counters = runtime.counters || {};

  renderDeliveryState();
  renderWatchSummary();
  renderLastCheck();
  renderWeekChanges();
  renderLatestError();
  renderRetry();

  setText(dom.totalChanges, String(Number(counters.changes) || 0));
  setText(dom.totalChecks, String(Number(counters.checks) || 0));
  setText(dom.totalSent, String(Number(counters.sent) || 0));
  setText(dom.totalFailed, String(Number(counters.failed) || 0));
}

function setBadge(text, className) {
  if (!dom.deliveryBadge) return;
  dom.deliveryBadge.textContent = text;
  dom.deliveryBadge.className = 'badge ' + className;
}

/**
 * DSH 连通状态：契约中的 runtime 没有独立「连通性」字段，
 * 这里用 settings 是否配置 + 最近一次投递结果推导，属于 UI 侧展示口径。
 */
function renderDeliveryState() {
  const settings = state.settings;
  const runtime = state.runtime;
  const configured = Boolean(
    String(settings.botId || '').trim() && String(settings.targetId || '').trim()
  );

  if (!configured) {
    setBadge('未配置', 'badge-soft');
    setText(dom.dshState, '未配置');
    dom.dshState.className = 'stat-value is-warn';
    setText(dom.dshDetail, '请到设置页填写 Bot ID 与 Target ID');
  } else if (runtime.lastDeliveryOk === true) {
    setBadge('正常', 'badge-ok');
    setText(dom.dshState, '正常');
    dom.dshState.className = 'stat-value is-ok';
    setText(dom.dshDetail, runtime.lastDeliveryAt
      ? '最近投递 ' + formatTime(runtime.lastDeliveryAt)
      : '最近投递成功');
  } else if (runtime.lastDeliveryOk === false) {
    setBadge('异常', 'badge-error');
    setText(dom.dshState, '异常');
    dom.dshState.className = 'stat-value is-error';
    setText(dom.dshDetail, '最近一次投递失败，详见下方错误');
  } else {
    setBadge('未测试', 'badge-soft');
    setText(dom.dshState, '未测试');
    dom.dshState.className = 'stat-value';
    setText(dom.dshDetail, '可在设置页点「测试发送」验证连通性');
  }

  // 有重试任务时，徽标优先提示「待重试」
  if (runtime.retry) setBadge('待重试', 'badge-warn');
}

function renderWatchSummary() {
  const total = state.watches.length;
  const enabled = state.watches.filter(function (watch) {
    return watch.enabled !== false;
  }).length;
  setText(dom.watchCount, enabled + ' / ' + total);
  setText(dom.watchDetail, '启用 / 全部');
}

function renderLastCheck() {
  let latest = Number(state.runtime.lastSweepAt) || 0;
  state.watches.forEach(function (watch) {
    const at = Number(watchStatus(watch).lastCheckedAt) || 0;
    if (at > latest) latest = at;
  });
  setText(dom.lastCheck, latest ? formatTime(latest) : '尚未检查');
}

/**
 * 本周变化次数：runtime.counters.changes 是累计值，没有按周分桶，
 * 这里用「本周内最近变化时间落在本周的监控项数量」近似统计（UI 展示口径）。
 */
function renderWeekChanges() {
  const weekStart = startOfWeekTime(Date.now());
  const count = state.watches.filter(function (watch) {
    return (Number(watchStatus(watch).lastChangedAt) || 0) >= weekStart;
  }).length;
  setText(dom.weekChanges, String(count));
  setText(dom.weekDetail, '按监控项最近变化时间统计');
}

function latestError() {
  let best = null;

  if (state.runtime.lastDeliveryError) {
    best = {
      text: '投递失败：' + state.runtime.lastDeliveryError,
      at: Number(state.runtime.lastDeliveryAt) || 0
    };
  }

  state.watches.forEach(function (watch) {
    const status = watchStatus(watch);
    if (!status.lastError) return;
    const at = Number(status.lastErrorAt) || 0;
    if (!best || at > best.at) {
      best = {
        text: (watch.name || '监控项') + '：' + status.lastError,
        at: at
      };
    }
  });

  return best;
}

function renderLatestError() {
  const latest = latestError();
  if (!latest) {
    setHidden(dom.errorPanel, true);
    setText(dom.latestError, '');
    return;
  }
  setHidden(dom.errorPanel, false);
  setText(dom.latestError, latest.text + (latest.at ? '（' + formatTime(latest.at) + '）' : ''));
}

function renderRetry() {
  const retry = state.runtime.retry;
  if (!retry) {
    setHidden(dom.retryPanel, true);
    setText(dom.retryText, '');
    return;
  }

  let watchName = '';
  if (retry.watchId) {
    const watch = state.watches.find(function (item) {
      return item.id === retry.watchId;
    });
    watchName = watch ? (watch.name || watch.id) : retry.watchId;
  }

  const parts = [];
  if (watchName) parts.push('监控项「' + watchName + '」');
  if (retry.attempt) parts.push('第 ' + retry.attempt + ' 次');
  if (retry.dueAt) parts.push('预计 ' + formatTime(retry.dueAt) + ' 重试');

  setHidden(dom.retryPanel, false);
  setText(dom.retryText, parts.length ? parts.join('，') + '。' : '有一条投递消息等待重试。');
}

/* ============================== 原有操作 ============================== */

function setStatus(kind, message) {
  if (!dom.popupStatus) return;
  dom.popupStatus.textContent = message || '';
  dom.popupStatus.classList.remove('is-ok', 'is-error');
  if (kind === 'ok') dom.popupStatus.classList.add('is-ok');
  if (kind === 'error') dom.popupStatus.classList.add('is-error');
}

function summarizeResults(results) {
  if (!Array.isArray(results) || !results.length) {
    return '检查完成：没有可检查的监控项';
  }
  const total = results.length;
  const changed = results.filter(function (item) {
    return item && item.changed === true;
  }).length;
  const errors = results.filter(function (item) {
    return item && item.error;
  }).length;
  const skipped = results.filter(function (item) {
    return item && item.skipped && !item.error;
  }).length;

  const parts = ['共 ' + total + ' 项'];
  if (changed) parts.push(changed + ' 项有变化');
  if (errors) parts.push(errors + ' 项出错');
  if (skipped) parts.push(skipped + ' 项跳过');
  if (!changed && !errors && !skipped) parts.push('暂无变化');
  return '检查完成：' + parts.join('，');
}

function readCheckResults(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('扩展后台返回了无效结果，请重试');
  }
  const results = Array.isArray(response.results) ? response.results : [];
  if (!results.length && response.ok !== true) {
    throw new Error(response.error || '检查失败，请查看扩展后台日志');
  }
  return results;
}

async function handleRunCheckAll() {
  if (busy.runAll) return;
  busy.runAll = true;
  setButtonBusy(dom.runCheckAll, true, '检查中…');
  setStatus('', '正在检查全部监控项…');
  try {
    // run-check 的 ok 语义是「是否全部无错」，个别监控项失败时仍会返回 results
    const response = await sendMessage({ type: 'run-check' });
    const results = readCheckResults(response);
    const summary = summarizeResults(results);
    const hasError = results.some(function (item) {
      return item && item.error;
    });
    try {
      await loadState();
    } catch (loadError) {
      // 检查已完成，只是状态刷新失败：仍然把检查结果告诉用户
      setStatus(hasError ? 'error' : 'ok', summary);
      return;
    }
    setStatus(hasError ? 'error' : 'ok', summary);
  } catch (error) {
    setStatus('error', errorMessageOf(error));
  } finally {
    busy.runAll = false;
    setButtonBusy(dom.runCheckAll, false, '立即检查全部');
  }
}

function handleOpenOptions() {
  try {
    if (chrome.runtime && typeof chrome.runtime.openOptionsPage === 'function') {
      chrome.runtime.openOptionsPage();
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html') });
    }
  } catch (error) {
    setStatus('error', '打开设置页失败：' + errorMessageOf(error));
    return;
  }
  window.close();
}

/* ============================== 事件绑定 / 初始化 ============================== */

function bindEvents() {
  // 图标缺失时不显示破图（不创建图标文件）
  if (dom.appLogo) {
    dom.appLogo.addEventListener('error', function () {
      dom.appLogo.style.display = 'none';
    });
  }
  dom.monitorButton.addEventListener('click', handleMonitorThisPage);
  dom.saveButton.addEventListener('click', handleSaveAutoWatch);
  dom.pageFallbackButton.addEventListener('click', handlePageFallback);
  dom.copyDiagnostics.addEventListener('click', handleCopyDiagnostics);
  dom.probeOpenOptions.addEventListener('click', handleOpenOptions);
  dom.runCheckAll.addEventListener('click', handleRunCheckAll);
  dom.openOptions.addEventListener('click', handleOpenOptions);
}

async function init() {
  cacheDom();
  bindEvents();
  // 未确定当前页面前先禁用主按钮，避免在 chrome:// 页面上误点
  dom.monitorButton.disabled = true;

  await loadCurrentTab();

  try {
    await loadState();
    setStatus('', '');
  } catch (error) {
    renderLoadError(errorMessageOf(error));
    setStatus('error', errorMessageOf(error));
  }
}

init().catch(function (error) {
  setStatus('error', '弹出面板初始化失败：' + errorMessageOf(error));
});
