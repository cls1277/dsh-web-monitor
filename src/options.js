/**
 * options.js —— 设置页脚本
 *
 * 约定（见 docs/ARCHITECTURE.md）：
 *  - 普通脚本（非 ES module），由 options.html 通过 <script src> 引入；
 *  - 只通过 chrome.runtime.sendMessage 与 background 通信，不直接读写 chrome.storage；
 *  - 所有动态内容用 createElement / textContent 渲染，不用 innerHTML 拼接，避免 XSS；
 *  - 保存 / 立即检查前，必须在本文件内调用 chrome.permissions.request 申请站点权限。
 */
'use strict';

/* ============================== 常量 ============================== */

// 与 ARCHITECTURE.md 第 3.1 节一致；默认值仅用于首次加载时的占位显示。
const DEFAULT_SETTINGS = {
  dshBaseUrl: 'http://127.0.0.1:52020',
  botId: '',
  targetId: '',
  localFallback: true,
  quiet: false,
  silentTabs: true
};

// 与 ARCHITECTURE.md 第 3.3 节一致。
const DEFAULT_RUNTIME = {
  lastSweepAt: 0,
  lastDeliveryAt: 0,
  lastDeliveryError: '',
  lastDeliveryOk: null,
  counters: { checks: 0, changes: 0, sent: 0, failed: 0 },
  retry: null
};

// 与 ARCHITECTURE.md 第 3.2 节 watch.status 一致。
const DEFAULT_WATCH_STATUS = {
  lastCheckedAt: 0,
  lastChangedAt: 0,
  lastError: '',
  lastErrorAt: 0,
  consecutiveErrors: 0,
  lastValuePreview: ''
};

// 错误码中文提示：与 ARCHITECTURE.md 第 7 节文案保持一致。
// options.js / popup.js 都是普通脚本、不能互相 import，因此各自保留一份。
const ERROR_HINTS = {
  'missing-config': '还没填写 Bot ID 或 Target ID，请先在上方完成 DSH 投递设置',
  'bad-request': '请求格式不对：检查 Bot ID / Target ID 是否为空或含空格',
  'unknown-bot': 'Bot ID 不属于当前 DSH，请重新从设置页复制',
  'unknown-target': '该机器人下没有这个 Target ID，请检查或新建目标',
  'target-conflict': 'Target ID 已存在',
  'invalid-target': '目标类型或平台 ID 不符合渠道规则',
  'bot-not-connected': '机器人当前离线，恢复连接后会自动重试',
  'target-rejected': '平台拒绝了该目标（权限或 ID 不对）',
  'delivery-failed': '平台发送失败（微信常见 ret=-2 prepare failed：先给机器人发一条消息再重试）',
  'network-error': '连不上 DSH（确认 DSH 正在运行且地址/端口正确）',
  timeout: '请求超时',
  cancelled: '请求被取消',
  'session-sync-unavailable': '目标不是可确认的当前私聊会话',
  'payload-too-large': '消息体过大（超过 1 MiB）',
  'method-not-allowed': '接口方法不对（GET 了 POST 接口）',
  'unsupported-media-type': 'Content-Type 必须是 application/json'
};

// check 结果里 skipped 字段（代码）的中文提示，与 ARCHITECTURE.md 第 5 节语义一致。
const SKIP_HINTS = {
  disabled: '该监控项已停用',
  'not-due': '还没到检查时间',
  empty: '提取结果为空，已按「忽略空值」跳过',
  'selector-not-found': '选择器没有匹配到元素',
  'selector-invalid': '选择器语法有误'
};

// rows / tab 相关字段的默认值（与 ARCHITECTURE.md 第 3.2 节 watch 对象一致）。
const DEFAULT_EXTRACTION = {
  extractMode: 'single',
  rowSelector: '',
  keySelector: '',
  statusSelector: '',
  keyAttr: '',
  statusAttr: '',
  rowsNotifyAdded: true,
  rowsNotifyRemoved: false,
  onlyStatuses: '',
  waitForSelector: '',
  settleMs: 1500
};

const INTERVAL_MIN = 0.5;
const INTERVAL_MAX = 1440;
const TOAST_DURATION_MS = 4200;

/* ============================== DOM 引用 ============================== */

const dom = {};

function cacheDom() {
  // 顶部
  dom.appLogo = byId('app-logo');
  dom.headerState = byId('header-state');
  dom.toast = byId('toast');

  // ① DSH 投递设置
  dom.settingsForm = byId('settings-form');
  dom.inputBaseUrl = byId('setting-dshBaseUrl');
  dom.inputBotId = byId('setting-botId');
  dom.inputTargetId = byId('setting-targetId');
  dom.inputLocalFallback = byId('setting-localFallback');
  dom.inputQuiet = byId('setting-quiet');
  dom.saveSettings = byId('save-settings');
  dom.testDelivery = byId('test-delivery');
  dom.settingsStatus = byId('settings-status');
  dom.testResult = byId('test-result');
  dom.inputSilentTabs = byId('setting-silentTabs');

  // ① 一键添加监控
  dom.autoUrl = byId('auto-url');
  dom.autoInterval = byId('auto-interval');
  dom.autoAddWatch = byId('auto-add-watch');
  dom.autoAddPage = byId('auto-add-page');
  dom.autoStatus = byId('auto-status');
  dom.autoDiagnostics = byId('auto-diagnostics');
  dom.copyAutoDiagnostics = byId('copy-auto-diagnostics');
  dom.autoAddResult = byId('auto-add-result');
  dom.autoAddSummary = byId('auto-add-summary');
  dom.autoAddRows = byId('auto-add-rows');
  dom.autoBaseline = byId('auto-baseline');
  dom.detectCurrentTab = byId('detect-current-tab');

  // ② 监控项
  dom.watchList = byId('watch-list');
  dom.watchCount = byId('watch-count');
  dom.addWatch = byId('add-watch');
  dom.runCheckAll = byId('run-check-all');
  dom.listStatus = byId('list-status');

  dom.watchForm = byId('watch-form');
  dom.watchFormTitle = byId('watch-form-title');
  dom.inputName = byId('watch-name');
  dom.inputUrl = byId('watch-url');
  dom.inputMode = byId('watch-mode');
  dom.modeHint = byId('mode-hint');
  dom.inputSelectorType = byId('watch-selectorType');
  dom.inputSelector = byId('watch-selector');
  dom.selectorHint = byId('selector-hint');
  dom.inputValueKind = byId('watch-valueKind');
  dom.inputAttrName = byId('watch-attrName');
  dom.inputInterval = byId('watch-intervalMinutes');
  dom.inputKeyword = byId('watch-keyword');
  dom.inputIgnoreEmpty = byId('watch-ignoreEmpty');
  dom.inputNotifyFirstRun = byId('watch-notifyOnFirstRun');
  dom.inputEnabled = byId('watch-enabled');
  dom.saveWatch = byId('save-watch');
  dom.cancelWatch = byId('cancel-watch');
  dom.watchFormStatus = byId('watch-form-status');
  dom.advancedForm = byId('advanced-form');

  // 监控方式 / rows / tab 字段
  dom.inputExtractMode = byId('watch-extractMode');
  dom.extractModeHint = byId('extract-mode-hint');
  dom.singleFields = byId('watch-single-fields');
  dom.rowsFields = byId('watch-rows-fields');
  dom.tabFields = byId('watch-tab-fields');
  dom.inputRowSelector = byId('watch-rowSelector');
  dom.inputKeySelector = byId('watch-keySelector');
  dom.inputStatusSelector = byId('watch-statusSelector');
  dom.inputKeyAttr = byId('watch-keyAttr');
  dom.inputStatusAttr = byId('watch-statusAttr');
  dom.inputRowsNotifyAdded = byId('watch-rowsNotifyAdded');
  dom.inputRowsNotifyRemoved = byId('watch-rowsNotifyRemoved');
  dom.inputOnlyStatuses = byId('watch-onlyStatuses');
  dom.inputWaitForSelector = byId('watch-waitForSelector');
  dom.inputSettleMs = byId('watch-settleMs');

  // 自动探测 / 预览
  dom.detectTable = byId('detect-table');
  dom.detectResult = byId('detect-result');
  dom.detectSummary = byId('detect-summary');
  dom.detectCandidates = byId('detect-candidates');
  dom.previewWatch = byId('preview-watch');
  dom.previewResult = byId('preview-result');
  dom.previewSummary = byId('preview-summary');
  dom.previewBody = byId('preview-body');

  // ③ 运行状态
  dom.runtimeSweep = byId('runtime-sweep');
  dom.runtimeDeliveryAt = byId('runtime-delivery-at');
  dom.runtimeDeliveryState = byId('runtime-delivery-state');
  dom.runtimeChecks = byId('runtime-checks');
  dom.runtimeChanges = byId('runtime-changes');
  dom.runtimeSentFailed = byId('runtime-sent-failed');
  dom.runtimeRetry = byId('runtime-retry');
  dom.runtimeError = byId('runtime-error');
  dom.refreshState = byId('refresh-state');
}

/* ============================== 页面状态 ============================== */

const state = {
  settings: Object.assign({}, DEFAULT_SETTINGS),
  watches: [],
  runtime: Object.assign({}, DEFAULT_RUNTIME, {
    counters: Object.assign({}, DEFAULT_RUNTIME.counters)
  }),
  lastAutoWatchId: '', // 最近一次「一键添加」创建的 watch.id（供「立即建立基线」用）
  lastAutoError: '',   // 最近一次一键添加失败的 error 文本（供复制诊断）
  lastAutoDiagnostics: null // 最近一次一键添加失败的 diagnostics 对象
};

let editingId = null;       // null 表示「新增」；否则为正在编辑的 watch.id
let settingsTouched = false; // 用户是否改动过设置表单（避免自动刷新覆盖输入）
let toastTimer = 0;

const busy = {
  settings: false,
  testDelivery: false,
  watch: false,
  runAll: false,
  detect: false,
  preview: false,
  autoAdd: false,
  autoAddPage: false,
  autoBaseline: false,
  detectCurrent: false,
  checkingId: ''
};

// 最近一次「自动探测表格结构」的候选（供候选卡片点选复用）
const detectState = {
  candidates: [],
  activeIndex: -1
};

/* ============================== 通用工具 ============================== */

function byId(id) {
  return document.getElementById(id);
}

/** 创建元素：className 可为空；text 用 textContent 写入（不解析 HTML）。 */
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

/** 本地时间 YYYY-MM-DD HH:mm:ss；0 / 非法值显示占位符。 */
function formatTime(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
    ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

function formatInterval(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return String(value) + ' 分钟';
}

function errorMessageOf(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** 契约规则：originPattern = new URL(url).origin + '/*' */
function originPattern(url) {
  const raw = String(url === undefined || url === null ? '' : url).trim();
  if (!raw) throw new Error('请填写页面 URL');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error('URL 格式不正确，请填写完整地址，例如 https://example.com/notice');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持监控 http:// 或 https:// 开头的网页');
  }
  return parsed.origin + '/*';
}

function normalizeBaseUrl(value) {
  return String(value === undefined || value === null ? '' : value).trim().replace(/\/+$/, '');
}

function watchStatus(watch) {
  return Object.assign({}, DEFAULT_WATCH_STATUS, (watch && watch.status) || {});
}

function findWatch(id) {
  return state.watches.find(function (watch) {
    return watch.id === id;
  });
}

/* ============================== 后台通信 ============================== */

/** 发送一条消息，处理 lastError 与空响应。 */
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
          settle(reject, new Error('无法连接扩展后台：' + lastError.message + '（请确认扩展已加载，或刷新本页重试）'));
          return;
        }
        settle(resolve, response);
      });
    } catch (error) {
      settle(reject, new Error('无法连接扩展后台：' + errorMessageOf(error)));
    }
  });
}

/** 调用后台并校验统一响应格式 { ok: true, ... } / { ok: false, error }。 */
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

/* ============================== 站点权限 ============================== */

/**
 * 申请单个站点的访问权限（optional_host_permissions）。
 * 注意：chrome.permissions.request 必须在用户点击的同步调用栈内发起，
 * 因此这里在 Promise 构造器里「立即」调用，调用方不要在调用前 await 其他异步操作。
 */
function requestOriginPermission(url) {
  return new Promise(function (resolve, reject) {
    let pattern;
    try {
      pattern = originPattern(url);
    } catch (error) {
      reject(error);
      return;
    }
    if (!chrome.permissions || typeof chrome.permissions.request !== 'function') {
      resolve(true); // 非扩展环境下交给后台报权限错误
      return;
    }
    try {
      chrome.permissions.request({ origins: [pattern] }, function (granted) {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error('申请站点权限失败：' + lastError.message));
          return;
        }
        resolve(granted === true);
      });
    } catch (error) {
      reject(new Error('申请站点权限失败：' + errorMessageOf(error)));
    }
  });
}

/** 一次申请多个站点的访问权限（「立即检查全部」用）。 */
function requestOriginPermissions(urls) {
  return new Promise(function (resolve, reject) {
    const patterns = [];
    (urls || []).forEach(function (url) {
      let pattern = '';
      try {
        pattern = originPattern(url);
      } catch (error) {
        return; // 无效 URL 交给后台在检查结果里报告
      }
      if (patterns.indexOf(pattern) === -1) patterns.push(pattern);
    });
    if (!patterns.length) {
      resolve(true);
      return;
    }
    if (!chrome.permissions || typeof chrome.permissions.request !== 'function') {
      resolve(true);
      return;
    }
    try {
      chrome.permissions.request({ origins: patterns }, function (granted) {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error('申请站点权限失败：' + lastError.message));
          return;
        }
        resolve(granted === true);
      });
    } catch (error) {
      reject(new Error('申请站点权限失败：' + errorMessageOf(error)));
    }
  });
}

/**
 * 权限兜底（尽力而为）：
 * manifest 已把 http(s) 全站权限 放进 host_permissions，安装时即完成授权；
 * 这里只在少数缺权限场景尝试补充，失败 / 被拒绝都不阻塞主流程。
 */
function tryRequestOriginPermission(url) {
  try {
    return requestOriginPermission(url).catch(function () {
      return false;
    });
  } catch (error) {
    return Promise.resolve(false);
  }
}

function tryRequestOriginPermissions(urls) {
  try {
    return requestOriginPermissions(urls).catch(function () {
      return false;
    });
  } catch (error) {
    return Promise.resolve(false);
  }
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

/* ============================== 数据加载 / 渲染 ============================== */

/** 从后台拉取 settings / watches / runtime 并渲染。 */
async function refreshState(options) {
  const opts = options || {};
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

  const mayApplySettings = !settingsTouched || opts.forceSettings === true;
  if (mayApplySettings) {
    applySettings(state.settings);
    if (opts.forceSettings === true) settingsTouched = false;
  }

  renderWatches();
  renderRuntime();
  setHeaderState(true);
}

/** 静默刷新：失败时只提示，不抛异常（用于按钮 / 焦点事件）。 */
function safeRefresh(options) {
  refreshState(options).catch(function (error) {
    if (options && options.silent) return;
    showToast(errorMessageOf(error), 'error');
  });
}

function setHeaderState(connected, detail) {
  if (!dom.headerState) return;
  dom.headerState.textContent = connected ? '后台已连接' : '后台未连接';
  dom.headerState.classList.remove('badge-soft', 'badge-ok', 'badge-error');
  dom.headerState.classList.add(connected ? 'badge-ok' : 'badge-error');
  dom.headerState.title = detail || '';
}

/* ---------------------------- 设置区 ---------------------------- */

function applySettings(settings) {
  const value = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  dom.inputBaseUrl.value = value.dshBaseUrl || DEFAULT_SETTINGS.dshBaseUrl;
  dom.inputBotId.value = value.botId || '';
  dom.inputTargetId.value = value.targetId || '';
  dom.inputLocalFallback.checked = value.localFallback !== false;
  dom.inputQuiet.checked = value.quiet === true;
  dom.inputSilentTabs.checked = value.silentTabs !== false;
}

function markSettingsTouched() {
  settingsTouched = true;
}

function setSettingsStatus(kind, message) {
  if (!dom.settingsStatus) return;
  dom.settingsStatus.textContent = message || '';
  dom.settingsStatus.classList.remove('is-error', 'is-ok');
  if (kind === 'error') dom.settingsStatus.classList.add('is-error');
  if (kind === 'ok') dom.settingsStatus.classList.add('is-ok');
}

function setTestResult(kind, message) {
  if (!dom.testResult) return;
  dom.testResult.hidden = !message;
  dom.testResult.textContent = message || '';
  dom.testResult.classList.remove('result-ok', 'result-error');
  if (kind === 'ok') dom.testResult.classList.add('result-ok');
  if (kind === 'error') dom.testResult.classList.add('result-error');
}

/** 读取并校验 DSH 设置表单。 */
function readSettingsForm() {
  const baseUrlRaw = String(dom.inputBaseUrl.value || '').trim();
  if (!baseUrlRaw) throw new Error('请填写 DSH Host 地址（默认 http://127.0.0.1:52020）');
  if (/\s/.test(baseUrlRaw)) throw new Error('DSH Host 地址不能包含空格');

  const dshBaseUrl = normalizeBaseUrl(baseUrlRaw);
  let parsed;
  try {
    parsed = new URL(dshBaseUrl);
  } catch (error) {
    throw new Error('DSH Host 地址格式不正确，例如 http://127.0.0.1:52020');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('DSH Host 地址必须以 http:// 或 https:// 开头');
  }

  const botId = String(dom.inputBotId.value || '').trim();
  const targetId = String(dom.inputTargetId.value || '').trim();
  if (/\s/.test(botId)) throw new Error('Bot ID 不能包含空格');
  if (/\s/.test(targetId)) throw new Error('Target ID 不能包含空格');

  return {
    dshBaseUrl: dshBaseUrl,
    botId: botId,
    targetId: targetId,
    localFallback: dom.inputLocalFallback.checked,
    quiet: dom.inputQuiet.checked,
    silentTabs: dom.inputSilentTabs.checked
  };
}

/** 保存 DSH 设置（只发消息，不直接写 storage）。 */
async function handleSaveSettings() {
  if (busy.settings) return;
  let settings;
  try {
    settings = readSettingsForm();
  } catch (error) {
    setSettingsStatus('error', errorMessageOf(error));
    return;
  }

  busy.settings = true;
  setButtonBusy(dom.saveSettings, true, '保存中…');
  try {
    const response = await callBackground({ type: 'save-settings', settings: settings });
    state.settings = Object.assign({}, settings, response.settings || {});
    settingsTouched = false;
    applySettings(state.settings);
    setSettingsStatus('ok', '设置已保存');
    showToast('设置已保存');
  } catch (error) {
    setSettingsStatus('error', errorMessageOf(error));
    showToast(errorMessageOf(error), 'error');
  } finally {
    busy.settings = false;
    setButtonBusy(dom.saveSettings, false, '保存设置');
  }
}

/** 把后台返回的 code / message 转成中文提示。 */
function describeDeliveryFailure(response) {
  const code = response && response.code ? String(response.code) : '';
  const backendMessage = response && response.message ? String(response.message) : '';
  let hint = ERROR_HINTS[code] || '';
  // http-4xx / http-5xx 这类动态错误码
  if (!hint && /^http-\d{3}$/u.test(code)) {
    hint = 'DSH 返回 HTTP ' + code.slice(5) + '，请查看 DSH 日志';
  }
  let text = hint || backendMessage || '未知错误';
  if (hint && backendMessage && backendMessage !== hint) {
    text += '（后台信息：' + backendMessage + '）';
  }
  const extras = [];
  if (code) extras.push('错误码：' + code);
  if (response && response.httpStatus) extras.push('HTTP ' + response.httpStatus);
  if (extras.length) text += '［' + extras.join('，') + '］';
  return text;
}

/**
 * 测试发送：先保存当前设置（测试使用后台已保存的配置），再调用 test-delivery。
 * 结果用错误码中文提示展示。
 */
async function handleTestDelivery() {
  if (busy.testDelivery) return;
  let settings;
  try {
    settings = readSettingsForm();
  } catch (error) {
    setTestResult('error', '设置不完整：' + errorMessageOf(error));
    return;
  }

  busy.testDelivery = true;
  setButtonBusy(dom.testDelivery, true, '发送中…');
  setTestResult('', '');
  try {
    const saved = await callBackground({ type: 'save-settings', settings: settings });
    state.settings = Object.assign({}, settings, saved.settings || {});
    settingsTouched = false;
    applySettings(state.settings);
    setSettingsStatus('ok', '设置已保存，正在测试投递…');

    const response = await sendMessage({ type: 'test-delivery' });
    if (response && response.ok === true) {
      setTestResult('ok', '测试消息已发送 ✅ 请到微信查看是否收到。');
      setSettingsStatus('ok', '测试发送成功');
      showToast('测试消息已发送 ✅');
    } else {
      setTestResult('error', '投递失败：' + describeDeliveryFailure(response));
      setSettingsStatus('error', '测试发送失败');
    }
    safeRefresh({ silent: true }); // 测试会更新 runtime（最近投递 / 计数器）
  } catch (error) {
    setTestResult('error', '投递失败：' + errorMessageOf(error));
    setSettingsStatus('error', '测试发送失败');
  } finally {
    busy.testDelivery = false;
    setButtonBusy(dom.testDelivery, false, '测试发送');
  }
}

/* ---------------------------- 一键添加监控 ---------------------------- */

function setAutoStatus(kind, message) {
  if (!dom.autoStatus) return;
  dom.autoStatus.textContent = message || '';
  dom.autoStatus.classList.remove('is-error', 'is-ok');
  if (kind === 'error') dom.autoStatus.classList.add('is-error');
  if (kind === 'ok') dom.autoStatus.classList.add('is-ok');
}

/** 首次打开设置页时，用当前活动标签页地址填充「页面地址」（尽力而为，不阻塞）。 */
async function fillAutoUrlFromActiveTab() {
  if (!dom.autoUrl || dom.autoUrl.value) return;
  const tab = await queryActiveTab();
  const url = String((tab && tab.url) || '');
  if (/^https?:\/\//iu.test(url) && !dom.autoUrl.value) dom.autoUrl.value = url;
}

/** 读取「一键添加」的页面地址；为空时尝试用当前标签页兜底。 */
async function resolveAutoUrl() {
  let url = String(dom.autoUrl.value || '').trim();
  if (!url) {
    const tab = await queryActiveTab();
    const tabUrl = String((tab && tab.url) || '');
    if (/^https?:\/\//iu.test(tabUrl)) {
      url = tabUrl;
      dom.autoUrl.value = url;
    }
  }
  if (!url) throw new Error('请填写页面地址，或先打开要监控的页面再点「用当前标签页识别」');
  originPattern(url); // 校验 URL 格式（http/https）
  return url;
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

function clearAutoFailure() {
  state.lastAutoError = '';
  state.lastAutoDiagnostics = null;
  setHidden(dom.autoDiagnostics, true);
  setText(dom.autoDiagnostics, '');
  setHidden(dom.copyAutoDiagnostics, true);
}

/** 一键添加失败：展示中文 error + 诊断摘要 + 复制诊断入口。 */
function showAutoFailure(response) {
  const message = String((response && response.error) || '自动识别失败');
  state.lastAutoError = message;
  state.lastAutoDiagnostics = (response && response.diagnostics && typeof response.diagnostics === 'object')
    ? response.diagnostics
    : null;

  setAutoStatus('error', '添加失败：' + message + '。可点「直接监控整页内容」兜底，或展开「高级」区域手动配置。');
  const summary = formatDiagnosticsText(state.lastAutoDiagnostics);
  setHidden(dom.autoDiagnostics, !summary);
  setText(dom.autoDiagnostics, summary);
  setHidden(dom.copyAutoDiagnostics, !state.lastAutoDiagnostics);
}

/** 复制「error + diagnostics」到剪贴板，方便用户反馈。 */
async function handleCopyAutoDiagnostics() {
  const payload = {
    error: state.lastAutoError || '',
    diagnostics: state.lastAutoDiagnostics || null
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard-unavailable');
    }
    await navigator.clipboard.writeText(text);
    setAutoStatus('ok', '已复制诊断信息，可直接粘贴反馈。');
  } catch (error) {
    setAutoStatus('error', '复制失败，请截图或手动复制诊断信息反馈。');
  }
}

/** 按 kind 渲染一键添加结果：rows=任务列表；single=页面主要内容。 */
function renderAutoAddResult(response) {
  const preview = (response && response.preview) || {};
  const rows = Array.isArray(preview.rows) ? preview.rows : [];
  const watch = (response && response.watch) || {};
  const kind = response && response.kind === 'single' ? 'single' : 'rows';
  state.lastAutoWatchId = watch.id ? String(watch.id) : '';

  setHidden(dom.autoAddResult, false);
  dom.autoAddRows.textContent = '';

  if (kind === 'single') {
    const pageText = String((rows[0] && rows[0].value) || '');
    const length = Number.isFinite(Number(preview.length)) ? Number(preview.length) : pageText.length;
    setText(dom.autoAddSummary, '已添加，将监控这个页面的主要内容（约 ' + length + ' 字）');
    const text = pageText.slice(0, 160);
    dom.autoAddRows.appendChild(el('li', 'auto-row auto-preview-text',
      text ? text + (pageText.length > 160 ? '…' : '') : '（页面暂无文字预览）'));
  } else {
    const count = Number.isFinite(Number(preview.count)) ? Number(preview.count) : rows.length;
    setText(dom.autoAddSummary, '已添加，识别到 ' + count + ' 个任务');
    if (!rows.length) {
      dom.autoAddRows.appendChild(el('li', 'auto-row-empty', '（暂无预览数据）'));
    } else {
      rows.slice(0, 3).forEach(function (row) {
        const key = row && row.key !== undefined && row.key !== null ? String(row.key) : '';
        const value = row && row.value !== undefined && row.value !== null ? String(row.value) : '';
        dom.autoAddRows.appendChild(el('li', 'auto-row', key + ' → ' + value));
      });
    }
  }

  dom.autoBaseline.disabled = !state.lastAutoWatchId;
  setText(dom.autoBaseline, '立即建立基线');
  delete dom.autoBaseline.dataset.idleText;
}

/** 一键添加（识别列表 / 主要内容）：调 auto-add，成功按 kind 展示，失败展示诊断。 */
async function handleAutoAdd() {
  if (busy.autoAdd) return;
  busy.autoAdd = true;
  setButtonBusy(dom.autoAddWatch, true, '识别中…');
  setAutoStatus('', '正在识别页面里的列表和主要内容，请稍候…');
  setHidden(dom.autoAddResult, true);
  clearAutoFailure();

  try {
    const url = await resolveAutoUrl();
    const intervalMinutes = Number(dom.autoInterval.value) || 3;
    // 一键流程不再强制申请站点权限：manifest 已把 http(s) 全站权限 放进 host_permissions
    const response = await sendMessage({
      type: 'auto-add',
      url: url,
      intervalMinutes: intervalMinutes
    });
    if (!response || typeof response !== 'object') {
      throw new Error('扩展后台返回了无效结果，请重试');
    }
    if (response.ok !== true) {
      showAutoFailure(response);
      return;
    }

    renderAutoAddResult(response);
    setAutoStatus('ok', autoAddSuccessText(response) + '。');
    showToast('已添加监控项');
    safeRefresh({ silent: true });
  } catch (error) {
    state.lastAutoError = errorMessageOf(error);
    state.lastAutoDiagnostics = null;
    setAutoStatus('error', '添加失败：' + errorMessageOf(error)
      + '。可点「直接监控整页内容」兜底，或展开「高级」区域手动配置。');
    setHidden(dom.autoDiagnostics, true);
    setHidden(dom.copyAutoDiagnostics, true);
  } finally {
    busy.autoAdd = false;
    setButtonBusy(dom.autoAddWatch, false, '自动识别并添加');
  }
}

/** 一键添加成功文案（rows / single 两种 kind）。 */
function autoAddSuccessText(response) {
  const preview = (response && response.preview) || {};
  const rows = Array.isArray(preview.rows) ? preview.rows : [];
  if (response && response.kind === 'single') {
    const pageText = String((rows[0] && rows[0].value) || '');
    const length = Number.isFinite(Number(preview.length)) ? Number(preview.length) : pageText.length;
    return '已添加，将监控这个页面的主要内容（约 ' + length + ' 字）';
  }
  const count = Number.isFinite(Number(preview.count)) ? Number(preview.count) : rows.length;
  return '已添加，识别到 ' + count + ' 个任务';
}

/** 兜底：不识别结构，直接监控整页内容（forceKind:'page'）。 */
async function handleAutoAddPage() {
  if (busy.autoAddPage) return;
  busy.autoAddPage = true;
  setButtonBusy(dom.autoAddPage, true, '正在添加…');
  setAutoStatus('', '正在添加「整页内容监控」…');
  setHidden(dom.autoAddResult, true);
  clearAutoFailure();

  try {
    const url = await resolveAutoUrl();
    const intervalMinutes = Number(dom.autoInterval.value) || 3;
    const response = await sendMessage({
      type: 'auto-add',
      url: url,
      intervalMinutes: intervalMinutes,
      forceKind: 'page'
    });
    if (!response || typeof response !== 'object') {
      throw new Error('扩展后台返回了无效结果，请重试');
    }
    if (response.ok !== true) {
      showAutoFailure(response);
      return;
    }

    renderAutoAddResult(response);
    setAutoStatus('ok', autoAddSuccessText(response) + '。');
    showToast('已添加整页内容监控');
    safeRefresh({ silent: true });
  } catch (error) {
    state.lastAutoError = errorMessageOf(error);
    state.lastAutoDiagnostics = null;
    setAutoStatus('error', '添加失败：' + errorMessageOf(error)
      + '。可展开「高级」区域手动配置。');
    setHidden(dom.autoDiagnostics, true);
    setHidden(dom.copyAutoDiagnostics, true);
  } finally {
    busy.autoAddPage = false;
    setButtonBusy(dom.autoAddPage, false, '直接监控整页内容');
  }
}

/** 「立即建立基线」：对刚添加的自动监控项跑一次检查（首次只建基线）。 */
async function handleAutoBaseline() {
  if (busy.autoBaseline || !state.lastAutoWatchId) return;
  busy.autoBaseline = true;
  setButtonBusy(dom.autoBaseline, true, '建立中…');
  try {
    const response = await sendMessage({ type: 'run-check', id: state.lastAutoWatchId });
    const results = readCheckResults(response);
    const result = results[0] || null;
    if (result && result.error) {
      setAutoStatus('error', '建立基线失败：' + result.error);
    } else if (result && result.skipped) {
      setAutoStatus('ok', '已跳过：' + (SKIP_HINTS[result.skipped] || result.skipped) + '。');
    } else {
      setAutoStatus('ok', '基线已建立，之后内容变化会推送到微信。');
    }
    safeRefresh({ silent: true });
  } catch (error) {
    setAutoStatus('error', '建立基线失败：' + errorMessageOf(error));
  } finally {
    busy.autoBaseline = false;
    setButtonBusy(dom.autoBaseline, false, '立即建立基线');
  }
}

/** 把 rows 候选填进高级表单并展开「高级」区域。 */
function applyCandidateToAdvancedForm(candidate) {
  const rowSelector = String((candidate && candidate.rowSelector) || '');
  const statusSelector = String((candidate && candidate.statusSelector) || '');
  if (!rowSelector || !statusSelector) {
    throw new Error('识别结果不完整，请展开「高级」手动填写');
  }

  dom.inputExtractMode.value = 'rows';
  dom.inputRowSelector.value = rowSelector;
  dom.inputKeySelector.value = String((candidate && candidate.keySelector) || '');
  dom.inputStatusSelector.value = statusSelector;
  dom.advancedForm.open = true;
  syncFormVisibility();
  setFormMessage('ok', '已用当前标签页识别并填入表单，请确认后点「保存监控项」。');
  dom.advancedForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 把 single（页面主要内容）候选填进高级表单并展开「高级」区域。 */
function applySingleCandidateToAdvancedForm(candidate) {
  const selector = String((candidate && candidate.selector) || '');
  if (!selector) throw new Error('识别结果不完整，请展开「高级」手动填写');

  dom.inputExtractMode.value = 'single';
  dom.inputSelectorType.value = 'css';
  dom.inputSelector.value = selector;
  dom.inputValueKind.value = 'text';
  dom.advancedForm.open = true;
  syncFormVisibility();
  syncSelectorHint();
  syncValueKindFields();
  setFormMessage('ok', '已用当前标签页识别并填入表单（页面主要内容），请确认后点「保存监控项」。');
  dom.advancedForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 「用当前标签页识别」：probe-active-tab 成功后按 kind 回填高级表单。 */
async function handleDetectCurrentTab() {
  if (busy.detectCurrent) return;
  busy.detectCurrent = true;
  setButtonBusy(dom.detectCurrentTab, true, '识别中…');
  setAutoStatus('', '正在读取当前标签页里的列表和主要内容…');

  try {
    const response = await sendMessage({ type: 'probe-active-tab' });
    if (!response || typeof response !== 'object') {
      throw new Error('扩展后台返回了无效结果，请重试');
    }
    if (response.ok !== true) {
      throw new Error(response.error || '没有识别到内容');
    }
    if (response.kind === 'single') applySingleCandidateToAdvancedForm(response.candidate);
    else applyCandidateToAdvancedForm(response.candidate);
    if (!dom.autoUrl.value && response.url) dom.autoUrl.value = String(response.url);
    setAutoStatus('ok', '已填入下方「高级」表单，确认后点「保存监控项」即可。');
    showToast('已填入高级表单');
  } catch (error) {
    setAutoStatus('error', '识别失败：' + errorMessageOf(error)
      + '。已在页面中打开任务列表时再试，或展开「高级」手动填写。');
  } finally {
    busy.detectCurrent = false;
    setButtonBusy(dom.detectCurrentTab, false, '用当前标签页识别');
  }
}

/* ---------------------------- 监控项列表 ---------------------------- */

function renderWatches() {
  if (!dom.watchList) return;
  dom.watchList.textContent = '';
  setText(dom.watchCount, String(state.watches.length));

  if (!state.watches.length) {
    const empty = el('div', 'empty-state');
    empty.appendChild(el('p', 'empty-title', '还没有监控项'));
    empty.appendChild(el('p', 'empty-desc', '使用上方「一键添加监控」自动识别，或在下方「高级」里手动填写。'));
    dom.watchList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.watches.forEach(function (watch) {
    fragment.appendChild(renderWatchRow(watch));
  });
  dom.watchList.appendChild(fragment);
}

function renderWatchRow(watch) {
  const status = watchStatus(watch);
  const enabled = watch.enabled !== false;
  const isRows = watch.extractMode === 'rows';

  const row = el('article', 'watch-row' + (enabled ? '' : ' is-disabled'));

  // 头部：名称 / 标签 / 启用开关
  const head = el('div', 'watch-head');
  const titleWrap = el('div', 'watch-title');
  titleWrap.appendChild(el('h3', 'watch-name', watch.name || '(未命名监控项)'));

  const sub = el('p', 'watch-sub');
  sub.appendChild(el('span', 'watch-tag', watch.mode === 'tab' ? 'tab 抓取' : 'direct 抓取'));
  if (isRows) {
    sub.appendChild(el('span', 'watch-tag', '列表监控'));
    if (watch.autoDetect === true) sub.appendChild(el('span', 'watch-tag', '自动识别'));
    const lastCount = Number(watch.last && watch.last.count) || 0;
    const detectedCount = Number(watch.detection && watch.detection.rowCount) || 0;
    const rowCount = lastCount || detectedCount;
    sub.appendChild(el('span', 'watch-tag', rowCount ? '列表 ' + rowCount + ' 项 · 每行状态' : '每行状态'));
  } else {
    sub.appendChild(el('span', 'watch-tag', '单值监控'));
    sub.appendChild(el('span', 'watch-tag', watch.selectorType === 'xpath' ? 'XPath' : 'CSS'));
    sub.appendChild(el('span', 'watch-tag', describeValueKind(watch)));
  }
  sub.appendChild(el('span', 'watch-tag', '每 ' + formatInterval(watch.intervalMinutes)));
  titleWrap.appendChild(sub);
  head.appendChild(titleWrap);
  head.appendChild(createToggle(watch, enabled));
  row.appendChild(head);

  // 基本信息
  const meta = el('div', 'watch-meta');
  meta.appendChild(metaItem('URL', watch.url || '—', 'meta-url'));
  if (isRows) {
    meta.appendChild(metaItem('行选择器', watch.rowSelector || '—'));
    meta.appendChild(metaItem('状态选择器', watch.statusSelector || '—'));
  }
  meta.appendChild(metaItem('上次检查', status.lastCheckedAt ? formatTime(status.lastCheckedAt) : '尚未检查'));
  meta.appendChild(metaItem('最近变化', status.lastChangedAt ? formatTime(status.lastChangedAt) : '尚未变化'));
  row.appendChild(meta);

  // 当前内容预览（single: 内容；rows: 各行「键=状态」，后台已截断到 200 字）
  if (status.lastValuePreview) {
    const preview = el('p', 'watch-preview');
    preview.appendChild(el('span', 'watch-preview-label', isRows ? '当前状态' : '当前内容'));
    preview.appendChild(document.createTextNode(status.lastValuePreview));
    preview.title = status.lastValuePreview;
    row.appendChild(preview);
  }

  // 最近错误（有则红色显示）
  if (status.lastError) {
    const errorLine = el('p', 'watch-error');
    errorLine.appendChild(document.createTextNode('最近错误：' + status.lastError));
    if (status.lastErrorAt) {
      errorLine.appendChild(el('span', 'error-time', '（' + formatTime(status.lastErrorAt) + '）'));
    }
    row.appendChild(errorLine);
  }

  // 行内操作：渲染后的 DOM 形如
  //   <button type="button" data-action="check">立即检查</button>
  //   <button type="button" data-action="edit">编辑</button>
  //   <button type="button" data-action="delete">删除</button>
  // 启用开关：<input type="checkbox" data-action="toggle" ...>（见 createToggle）
  const actions = el('div', 'watch-actions');
  actions.appendChild(actionButton('check', watch.id, '立即检查'));
  actions.appendChild(actionButton('edit', watch.id, '编辑'));
  actions.appendChild(actionButton('delete', watch.id, '删除', 'btn-danger'));
  row.appendChild(actions);

  return row;
}

function describeValueKind(watch) {
  if (watch.valueKind === 'html') return 'HTML';
  if (watch.valueKind === 'attr') return 'attr: ' + (watch.attrName || '未填属性');
  return '文本';
}

function metaItem(label, value, extraClass) {
  const item = el('div', 'meta-item' + (extraClass ? ' ' + extraClass : ''));
  item.appendChild(el('span', 'meta-label', label));
  const valueNode = el('span', 'meta-value', value);
  valueNode.title = String(value);
  item.appendChild(valueNode);
  return item;
}

function actionButton(action, watchId, label, extraClass) {
  const button = el('button', 'btn btn-small' + (extraClass ? ' ' + extraClass : ''), label);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = watchId;
  return button;
}

function createToggle(watch, enabled) {
  const label = el('label', 'switch');
  label.title = enabled ? '点击停用该监控项' : '点击启用该监控项';

  const input = el('input', 'switch-input');
  input.type = 'checkbox';
  input.checked = enabled;
  input.dataset.action = 'toggle';
  input.dataset.id = watch.id;
  input.setAttribute('aria-label', '启用或停用监控项');

  label.appendChild(input);
  label.appendChild(el('span', 'switch-track'));
  label.appendChild(el('span', 'switch-text', enabled ? '已启用' : '已停用'));
  return label;
}

function showListStatus(kind, message) {
  if (!dom.listStatus) return;
  dom.listStatus.textContent = message || '';
  dom.listStatus.classList.remove('is-error', 'is-ok');
  if (kind === 'error') dom.listStatus.classList.add('is-error');
  if (kind === 'ok') dom.listStatus.classList.add('is-ok');
}

/* ---------------------------- 运行状态 ---------------------------- */

function renderRuntime() {
  const runtime = state.runtime || {};
  const counters = runtime.counters || {};

  setText(dom.runtimeSweep, runtime.lastSweepAt ? formatTime(runtime.lastSweepAt) : '尚未扫描');
  setText(dom.runtimeDeliveryAt, runtime.lastDeliveryAt ? formatTime(runtime.lastDeliveryAt) : '尚未投递');

  const deliveryState = dom.runtimeDeliveryState;
  if (deliveryState) {
    deliveryState.classList.remove('is-ok', 'is-error');
    if (runtime.lastDeliveryOk === true) {
      deliveryState.textContent = '投递正常';
      deliveryState.classList.add('is-ok');
    } else if (runtime.lastDeliveryOk === false) {
      deliveryState.textContent = '最近投递失败';
      deliveryState.classList.add('is-error');
    } else {
      deliveryState.textContent = '暂无投递记录';
    }
  }

  setText(dom.runtimeChecks, String(Number(counters.checks) || 0));
  setText(dom.runtimeChanges, String(Number(counters.changes) || 0));
  setText(dom.runtimeSentFailed, (Number(counters.sent) || 0) + ' / ' + (Number(counters.failed) || 0));

  // 最近一次投递错误
  if (runtime.lastDeliveryError) {
    setHidden(dom.runtimeError, false);
    setText(dom.runtimeError, '最近一次投递错误：' + runtime.lastDeliveryError);
  } else {
    setHidden(dom.runtimeError, true);
    setText(dom.runtimeError, '');
  }

  // 待重试（ARCHITECTURE.md 第 6 节：runtime.retry 非空时显示「待重试」）
  const retry = runtime.retry;
  if (retry) {
    const watch = retry.watchId ? findWatch(retry.watchId) : null;
    const parts = ['待重试'];
    if (watch) parts.push('监控项「' + (watch.name || watch.id) + '」');
    else if (retry.watchId) parts.push('监控项 ' + retry.watchId);
    if (retry.attempt) parts.push('第 ' + retry.attempt + ' 次');
    if (retry.dueAt) parts.push('预计 ' + formatTime(retry.dueAt) + ' 重试');
    setHidden(dom.runtimeRetry, false);
    setText(dom.runtimeRetry, parts.join('，') + '。');
  } else {
    setHidden(dom.runtimeRetry, true);
    setText(dom.runtimeRetry, '');
  }
}

/* ---------------------------- 监控项表单 ---------------------------- */

function syncModeHint() {
  if (!dom.modeHint) return;
  if (dom.inputMode.value === 'tab') {
    dom.modeHint.textContent = 'tab：后台打开标签页读取渲染后的 outerHTML，更接近看到的页面，速度稍慢。';
  } else {
    dom.modeHint.textContent = 'direct：直接 fetch 页面 HTML，速度快，但拿不到 JS 渲染出来的内容。';
  }
}

function syncSelectorHint() {
  if (!dom.selectorHint || !dom.inputSelector) return;
  const isXpath = dom.inputSelectorType.value === 'xpath';
  dom.inputSelector.placeholder = isXpath ? '//div[@id="notice"]//h1' : '#notice .title';
  dom.selectorHint.textContent = isXpath
    ? 'XPath：如 //div[@id="notice"]//h1（对应 document.evaluate）。'
    : 'CSS 选择器：如 #notice .title（对应 document.querySelector）。';
}

function syncValueKindFields() {
  if (!dom.inputAttrName) return;
  const isAttr = dom.inputValueKind.value === 'attr';
  dom.inputAttrName.disabled = !isAttr;
  dom.inputAttrName.placeholder = isAttr ? '例如 href / data-price' : '仅在取值方式为「属性」时填写';
  if (!isAttr) dom.inputAttrName.value = '';
}

/** 根据 extractMode / mode 显隐字段分组（single / rows / tab）。 */
function syncFormVisibility() {
  const extractMode = dom.inputExtractMode && dom.inputExtractMode.value === 'rows' ? 'rows' : 'single';
  const isTab = dom.inputMode && dom.inputMode.value === 'tab';

  setHidden(dom.singleFields, extractMode !== 'single');
  setHidden(dom.rowsFields, extractMode !== 'rows');
  setHidden(dom.tabFields, !isTab);

  if (dom.extractModeHint) {
    dom.extractModeHint.textContent = extractMode === 'rows'
      ? 'rows：逐行对比列表（如任务列表的状态列），需要「行选择器」+「行内状态选择器」，只支持 CSS。'
      : 'single：盯一段文字 / HTML / 属性，需要「选择器」与「取值方式」。';
  }
}

/** 客户端校验选择器语法，提前区分「语法有误」与「没匹配到节点」。 */
function validateSelector(selector, selectorType) {
  try {
    if (selectorType === 'xpath') {
      document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    } else {
      document.querySelector(selector);
    }
  } catch (error) {
    if (selectorType === 'xpath') {
      throw new Error('XPath 语法有误：' + selector);
    }
    throw new Error('CSS 选择器语法有误：' + selector);
  }
}

/**
 * 读取并校验监控项表单，返回可提交给后台的字段集合（single / rows 两套字段都会补齐）。
 * options.allowEmptyName 为 true 时允许名称为空（供「预览提取结果」使用）。
 */
function readWatchForm(options) {
  const opts = options || {};
  const name = String(dom.inputName.value || '').trim();
  if (!name && opts.allowEmptyName !== true) throw new Error('请填写监控项名称');
  if (name.length > 80) throw new Error('监控项名称请控制在 80 个字符以内');

  const url = String(dom.inputUrl.value || '').trim();
  originPattern(url); // 复用 URL 校验（同时保证权限申请能生成合法 originPattern）

  const mode = dom.inputMode.value === 'tab' ? 'tab' : 'direct';
  const extractMode = dom.inputExtractMode.value === 'rows' ? 'rows' : 'single';

  const values = {
    name: name,
    url: url,
    enabled: dom.inputEnabled.checked,
    mode: mode,
    extractMode: extractMode,
    // single 字段默认值（rows 模式会被忽略）
    selectorType: 'css',
    selector: '',
    valueKind: 'text',
    attrName: '',
    keyword: '',
    // rows 字段默认值（single 模式会被忽略）
    rowSelector: '',
    keySelector: '',
    statusSelector: '',
    keyAttr: '',
    statusAttr: '',
    rowsNotifyAdded: true,
    rowsNotifyRemoved: false,
    onlyStatuses: '',
    // tab 等待字段
    waitForSelector: '',
    settleMs: DEFAULT_EXTRACTION.settleMs,
    intervalMinutes: 0,
    ignoreEmpty: dom.inputIgnoreEmpty.checked,
    notifyOnFirstRun: dom.inputNotifyFirstRun.checked
  };

  if (extractMode === 'rows') {
    // rows 模式：只支持 CSS，不填 selector / valueKind / attrName / keyword
    values.rowSelector = String(dom.inputRowSelector.value || '').trim();
    if (!values.rowSelector) {
      throw new Error('列表监控请填写「行选择器」（一行一个任务，例如 tbody tr 或 .arco-table-tr）');
    }
    validateSelector(values.rowSelector, 'css');

    values.statusSelector = String(dom.inputStatusSelector.value || '').trim();
    if (!values.statusSelector) {
      throw new Error('列表监控请填写「状态选择器」（行内相对 CSS，例如 td:nth-child(5)）');
    }
    validateSelector(values.statusSelector, 'css');

    values.keySelector = String(dom.inputKeySelector.value || '').trim();
    if (values.keySelector) validateSelector(values.keySelector, 'css');

    values.keyAttr = String(dom.inputKeyAttr.value || '').trim();
    values.statusAttr = String(dom.inputStatusAttr.value || '').trim();
    values.onlyStatuses = String(dom.inputOnlyStatuses.value || '').trim();
    values.rowsNotifyAdded = dom.inputRowsNotifyAdded.checked;
    values.rowsNotifyRemoved = dom.inputRowsNotifyRemoved.checked;
  } else {
    values.selectorType = dom.inputSelectorType.value === 'xpath' ? 'xpath' : 'css';
    values.selector = String(dom.inputSelector.value || '').trim();
    if (!values.selector) throw new Error('请填写选择器');
    validateSelector(values.selector, values.selectorType);

    const valueKindRaw = dom.inputValueKind.value;
    values.valueKind = valueKindRaw === 'html' || valueKindRaw === 'attr' ? valueKindRaw : 'text';
    if (values.valueKind === 'attr') {
      values.attrName = String(dom.inputAttrName.value || '').trim();
      if (!values.attrName) throw new Error('取值方式为「属性」时必须填写属性名');
    }
    values.keyword = String(dom.inputKeyword.value || '').trim();
  }

  // tab 模式才展示并生效「等待选择器 / 额外等待」
  if (mode === 'tab') {
    values.waitForSelector = String(dom.inputWaitForSelector.value || '').trim();
    if (values.waitForSelector) validateSelector(values.waitForSelector, 'css');

    const settleRaw = String(dom.inputSettleMs.value === undefined || dom.inputSettleMs.value === null
      ? ''
      : dom.inputSettleMs.value).trim();
    const settleMs = settleRaw === '' ? DEFAULT_EXTRACTION.settleMs : Number(settleRaw);
    if (!Number.isFinite(settleMs)) throw new Error('额外等待时间必须是数字（毫秒）');
    if (settleMs < 0 || settleMs > 20000) throw new Error('额外等待时间需在 0 ~ 20000 毫秒之间');
    values.settleMs = Math.round(settleMs);
  }

  const intervalMinutes = Number(dom.inputInterval.value);
  if (!Number.isFinite(intervalMinutes)) throw new Error('检查间隔必须是数字');
  if (intervalMinutes < INTERVAL_MIN || intervalMinutes > INTERVAL_MAX) {
    throw new Error('检查间隔需在 0.5 ~ 1440 分钟之间');
  }
  values.intervalMinutes = intervalMinutes;

  return values;
}

/**
 * 生成提交给后台的 watch 对象：
 *  - 编辑：保留后台维护的 id / status / last / createdAt，只覆盖表单字段；
 *  - 新增：不带 id（由 background 按契约生成），附带默认 status / last。
 */
function buildWatchData(values) {
  const existing = editingId ? findWatch(editingId) : null;
  if (existing) {
    return Object.assign({}, existing, values, { id: existing.id });
  }
  return Object.assign({}, values, {
    createdAt: Date.now(),
    status: Object.assign({}, DEFAULT_WATCH_STATUS),
    last: null
  });
}

function resetWatchForm() {
  editingId = null;
  dom.inputName.value = '';
  dom.inputUrl.value = '';
  dom.inputMode.value = 'direct';
  dom.inputExtractMode.value = DEFAULT_EXTRACTION.extractMode;
  dom.inputSelectorType.value = 'css';
  dom.inputSelector.value = '';
  dom.inputValueKind.value = 'text';
  dom.inputAttrName.value = '';
  dom.inputKeyword.value = '';
  dom.inputRowSelector.value = DEFAULT_EXTRACTION.rowSelector;
  dom.inputKeySelector.value = DEFAULT_EXTRACTION.keySelector;
  dom.inputStatusSelector.value = DEFAULT_EXTRACTION.statusSelector;
  dom.inputKeyAttr.value = DEFAULT_EXTRACTION.keyAttr;
  dom.inputStatusAttr.value = DEFAULT_EXTRACTION.statusAttr;
  dom.inputRowsNotifyAdded.checked = DEFAULT_EXTRACTION.rowsNotifyAdded;
  dom.inputRowsNotifyRemoved.checked = DEFAULT_EXTRACTION.rowsNotifyRemoved;
  dom.inputOnlyStatuses.value = DEFAULT_EXTRACTION.onlyStatuses;
  dom.inputWaitForSelector.value = DEFAULT_EXTRACTION.waitForSelector;
  dom.inputSettleMs.value = String(DEFAULT_EXTRACTION.settleMs);
  dom.inputInterval.value = '5';
  dom.inputIgnoreEmpty.checked = true;
  dom.inputNotifyFirstRun.checked = false;
  dom.inputEnabled.checked = true;

  dom.watchFormTitle.textContent = '新增监控项';
  dom.cancelWatch.textContent = '重置表单';
  setButtonLabel(dom.saveWatch, '保存监控项');

  syncValueKindFields();
  syncSelectorHint();
  syncModeHint();
  syncFormVisibility();
  clearDetectResult();
  clearPreviewResult();
  setFormMessage('', '');
}

function startEditWatch(watchId) {
  const watch = findWatch(watchId);
  if (!watch) return;

  editingId = watch.id;
  dom.inputName.value = watch.name || '';
  dom.inputUrl.value = watch.url || '';
  dom.inputMode.value = watch.mode === 'tab' ? 'tab' : 'direct';
  dom.inputExtractMode.value = watch.extractMode === 'rows' ? 'rows' : 'single';
  dom.inputSelectorType.value = watch.selectorType === 'xpath' ? 'xpath' : 'css';
  dom.inputSelector.value = watch.selector || '';
  dom.inputValueKind.value = watch.valueKind === 'html' || watch.valueKind === 'attr' ? watch.valueKind : 'text';
  dom.inputAttrName.value = watch.attrName || '';
  dom.inputKeyword.value = watch.keyword || '';
  dom.inputRowSelector.value = watch.rowSelector || '';
  dom.inputKeySelector.value = watch.keySelector || '';
  dom.inputStatusSelector.value = watch.statusSelector || '';
  dom.inputKeyAttr.value = watch.keyAttr || '';
  dom.inputStatusAttr.value = watch.statusAttr || '';
  dom.inputRowsNotifyAdded.checked = watch.rowsNotifyAdded !== false;
  dom.inputRowsNotifyRemoved.checked = watch.rowsNotifyRemoved === true;
  dom.inputOnlyStatuses.value = watch.onlyStatuses || '';
  dom.inputWaitForSelector.value = watch.waitForSelector || '';
  dom.inputSettleMs.value = watch.settleMs !== undefined && watch.settleMs !== null
    ? String(watch.settleMs)
    : String(DEFAULT_EXTRACTION.settleMs);
  dom.inputInterval.value = watch.intervalMinutes !== undefined && watch.intervalMinutes !== null
    ? String(watch.intervalMinutes)
    : '5';
  dom.inputIgnoreEmpty.checked = watch.ignoreEmpty !== false;
  dom.inputNotifyFirstRun.checked = watch.notifyOnFirstRun === true;
  dom.inputEnabled.checked = watch.enabled !== false;

  dom.watchFormTitle.textContent = '编辑监控项：' + (watch.name || '(未命名)');
  dom.cancelWatch.textContent = '取消编辑';
  setButtonLabel(dom.saveWatch, '更新监控项');

  syncValueKindFields();
  syncSelectorHint();
  syncModeHint();
  syncFormVisibility();
  clearDetectResult();
  clearPreviewResult();
  setFormMessage('', '正在编辑「' + (watch.name || '未命名监控项') + '」。修改 URL / 选择器 / 监控方式会重置基线，下次检查重新建立。');

  dom.advancedForm.open = true;
  dom.watchForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  dom.inputName.focus();
}

function setFormMessage(kind, message) {
  if (!dom.watchFormStatus) return;
  dom.watchFormStatus.textContent = message || '';
  dom.watchFormStatus.classList.remove('is-error', 'is-ok');
  if (kind === 'error') dom.watchFormStatus.classList.add('is-error');
  if (kind === 'ok') dom.watchFormStatus.classList.add('is-ok');
}

/** 保存（新增或更新）监控项：先申请站点权限，被拒绝则不保存。 */
async function handleSaveWatch() {
  if (busy.watch) return;

  let values;
  try {
    values = readWatchForm();
  } catch (error) {
    setFormMessage('error', errorMessageOf(error));
    return;
  }

  busy.watch = true;
  setButtonBusy(dom.saveWatch, true, '保存中…');
  setFormMessage('', '正在保存…');
  try {
    // 安装时已一次性授权 http(s) 全站权限；这里只做权限兜底，失败/拒绝都不阻塞保存，
    // 真缺权限时 background 会返回可执行的中文错误。
    await tryRequestOriginPermission(values.url);

    const response = await callBackground({ type: 'save-watch', watch: buildWatchData(values) });
    applyWatchResponse(response);

    const savedName = (response.watch && response.watch.name) || values.name;
    resetWatchForm();
    renderWatches();
    setFormMessage('ok', '已保存监控项「' + savedName + '」，权限已授权。');
    showToast('已保存监控项「' + savedName + '」');
    safeRefresh({ silent: true });
  } catch (error) {
    setFormMessage('error', errorMessageOf(error));
  } finally {
    busy.watch = false;
    setButtonBusy(dom.saveWatch, false);
  }
}

function applyWatchResponse(response) {
  if (Array.isArray(response.watches)) {
    state.watches = response.watches;
    return;
  }
  const saved = response.watch;
  if (!saved || !saved.id) return;
  const index = state.watches.findIndex(function (watch) {
    return watch.id === saved.id;
  });
  if (index >= 0) state.watches[index] = saved;
  else state.watches.push(saved);
}

/* ---------------------------- 监控项操作 ---------------------------- */

async function handleDeleteWatch(watchId) {
  const watch = findWatch(watchId);
  if (!watch) return;
  const confirmed = window.confirm('确定要删除监控项「' + (watch.name || '未命名') + '」吗？该操作不可撤销。');
  if (!confirmed) return;

  try {
    const response = await callBackground({ type: 'delete-watch', id: watchId });
    state.watches = Array.isArray(response.watches)
      ? response.watches
      : state.watches.filter(function (item) {
        return item.id !== watchId;
      });
    if (editingId === watchId) resetWatchForm();
    renderWatches();
    showListStatus('ok', '已删除监控项「' + (watch.name || '未命名') + '」。');
    showToast('已删除监控项');
  } catch (error) {
    showToast(errorMessageOf(error), 'error');
  }
}

async function handleToggleWatch(watchId, enabled) {
  try {
    const response = await callBackground({ type: 'toggle-watch', id: watchId, enabled: enabled });
    if (response.watch && response.watch.id) {
      const index = state.watches.findIndex(function (watch) {
        return watch.id === response.watch.id;
      });
      if (index >= 0) state.watches[index] = response.watch;
    } else {
      const watch = findWatch(watchId);
      if (watch) watch.enabled = enabled;
    }
    renderWatches();
    showToast(enabled ? '已启用监控项' : '已停用监控项');
  } catch (error) {
    renderWatches(); // 恢复开关到后台真实状态
    showToast(errorMessageOf(error), 'error');
  }
}

/** 立即检查单个监控项。 */
async function handleCheckWatch(watchId) {
  if (busy.checkingId) return;
  const watch = findWatch(watchId);
  if (!watch) return;

  busy.checkingId = watchId;
  showListStatus('', '正在检查「' + (watch.name || '未命名') + '」…');
  try {
    // 权限兜底：失败也继续，交给 background 在结果里返回中文错误
    await tryRequestOriginPermission(watch.url);
    // 注意：run-check 的 ok 语义是「是否全部无错」，即使个别监控项失败也会返回 results，
    // 因此这里不用 callBackground（它会把 ok:false 当异常抛出），而是直接读 results。
    const response = await sendMessage({ type: 'run-check', id: watchId });
    const results = readCheckResults(response);
    const message = describeCheckResult(results[0] || null);
    const hasError = Boolean(results[0] && results[0].error);
    showListStatus(hasError ? 'error' : 'ok', message);
    showToast(message);
    await refreshState();
  } catch (error) {
    showListStatus('error', errorMessageOf(error));
    showToast(errorMessageOf(error), 'error');
  } finally {
    busy.checkingId = '';
  }
}

/** 立即检查全部启用的监控项。 */
async function handleRunCheckAll() {
  if (busy.runAll) return;
  const targets = state.watches.filter(function (watch) {
    return watch.enabled !== false;
  });
  if (!targets.length) {
    showListStatus('', '没有启用的监控项，请先新增或启用监控项。');
    return;
  }

  busy.runAll = true;
  setButtonBusy(dom.runCheckAll, true, '检查中…');
  showListStatus('', '正在检查全部监控项…');
  try {
    // 权限兜底：失败也继续，交给 background 在结果里返回中文错误
    await tryRequestOriginPermissions(targets.map(function (watch) {
      return watch.url;
    }));
    // 同上：个别监控项失败时 ok 为 false，但 results 仍然有效，不能当异常处理。
    const response = await sendMessage({ type: 'run-check' });
    const results = readCheckResults(response);
    const hasError = results.some(function (item) {
      return item && item.error;
    });
    showListStatus(hasError ? 'error' : 'ok', summarizeResults(results));
    showToast(summarizeResults(results));
    await refreshState();
  } catch (error) {
    showListStatus('error', errorMessageOf(error));
    showToast(errorMessageOf(error), 'error');
  } finally {
    busy.runAll = false;
    setButtonBusy(dom.runCheckAll, false, '立即检查全部');
  }
}

/**
 * 读取 run-check 响应中的 results。
 * 契约里 ok 表示「本次操作是否全部成功」；background 在个别监控项失败时仍会返回
 * { ok:false, results, error }，所以只有「ok:false 且完全没有 results」才算调用失败。
 */
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

/** 单条检查结果的中文描述。 */
function describeCheckResult(result) {
  if (!result) return '检查完成：没有返回结果';
  const name = result.name ? '「' + result.name + '」' : '';
  if (result.error) return '检查' + name + '失败：' + result.error;
  if (result.skipped) {
    return '已跳过' + name + '：' + (SKIP_HINTS[result.skipped] || result.skipped);
  }
  if (result.changed) {
    return result.notified
      ? '检测到' + name + '内容变化，已发送提醒'
      : '检测到' + name + '内容变化，但未发送提醒（关键词过滤或投递失败）';
  }
  return '检查完成' + name + '：内容无变化';
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

/* ---------------------------- 自动探测 / 预览 ---------------------------- */

/** 预览只读，不落库：名称为空时用占位名（background 校验要求非空名称）。 */
function buildPreviewWatch(values) {
  const watch = Object.assign({}, values);
  if (!watch.name) watch.name = '预览监控项';
  return watch;
}

function clearDetectResult() {
  detectState.candidates = [];
  detectState.activeIndex = -1;
  if (!dom.detectResult) return;
  dom.detectResult.hidden = true;
  setText(dom.detectSummary, '');
  if (dom.detectCandidates) dom.detectCandidates.textContent = '';
}

function setDetectPanelMessage(kind, message) {
  if (!dom.detectResult) return;
  dom.detectResult.hidden = false;
  dom.detectSummary.className = 'panel-sub' + (kind === 'error' ? ' is-error' : '');
  setText(dom.detectSummary, kind === 'error' ? '探测失败' : '未发现可用的表格结构');
  dom.detectCandidates.textContent = '';
  dom.detectCandidates.appendChild(el(
    'p',
    kind === 'error' ? 'preview-error' : 'preview-text',
    message
  ));
}

/** 渲染自动探测候选：headers 用文本、samples 用「键 → 值」，可点选其他候选。 */
function renderDetectCandidates(candidates, loginRequired) {
  detectState.candidates = candidates.slice();
  detectState.activeIndex = -1;

  if (!dom.detectResult) return;
  dom.detectResult.hidden = false;
  dom.detectSummary.className = 'panel-sub';
  setText(dom.detectSummary, '发现 ' + candidates.length + ' 个候选'
    + (loginRequired === true ? '（页面可能需要登录）' : ''));
  dom.detectCandidates.textContent = '';

  candidates.forEach(function (candidate, index) {
    dom.detectCandidates.appendChild(renderCandidateCard(candidate, index));
  });
  updateDetectActiveState();
}

function renderCandidateCard(candidate, index) {
  const card = el('div', 'candidate-card');
  card.dataset.candidateIndex = String(index);

  const head = el('div', 'candidate-head');
  head.appendChild(el('span', 'candidate-index', '候选 ' + (index + 1)));
  const useButton = el('button', 'btn btn-small candidate-btn', '使用此候选');
  useButton.type = 'button';
  useButton.dataset.candidateIndex = String(index);
  head.appendChild(useButton);
  card.appendChild(head);

  if (candidate && candidate.note) {
    card.appendChild(el('p', 'candidate-note', String(candidate.note)));
  }

  const headers = candidate && Array.isArray(candidate.headers) ? candidate.headers : [];
  card.appendChild(el('p', 'candidate-meta',
    '表头：' + (headers.length ? headers.join(' | ') : '（无表头信息）')));

  const samples = candidate && Array.isArray(candidate.samples) ? candidate.samples : [];
  if (samples.length) {
    const list = el('ul', 'candidate-samples');
    samples.slice(0, 3).forEach(function (sample) {
      const key = sample && sample.key !== undefined && sample.key !== null ? String(sample.key) : '';
      const value = sample && sample.value !== undefined && sample.value !== null ? String(sample.value) : '';
      list.appendChild(el('li', 'candidate-sample', key + ' → ' + value));
    });
    card.appendChild(list);
  } else {
    card.appendChild(el('p', 'candidate-meta', '样例：（无）'));
  }

  card.appendChild(el('p', 'candidate-meta candidate-selectors',
    '行选择器：' + (candidate && candidate.rowSelector ? candidate.rowSelector : '—')
    + ' · 键选择器：' + (candidate && candidate.keySelector ? candidate.keySelector : '（整行文本）')
    + ' · 状态选择器：' + (candidate && candidate.statusSelector ? candidate.statusSelector : '—')));

  return card;
}

function updateDetectActiveState() {
  if (!dom.detectCandidates || !dom.detectCandidates.children) return;
  const cards = dom.detectCandidates.children;
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (!card || !card.classList) continue;
    if (index === detectState.activeIndex) card.classList.add('candidate-active');
    else card.classList.remove('candidate-active');
  }
}

/** 把指定候选的 rowSelector / keySelector / statusSelector 填入表单（自动切到 rows 模式）。 */
function applyDetectCandidate(index) {
  const candidate = detectState.candidates[index];
  if (!candidate) return;

  dom.inputExtractMode.value = 'rows';
  dom.inputRowSelector.value = candidate.rowSelector || '';
  dom.inputKeySelector.value = candidate.keySelector || '';
  dom.inputStatusSelector.value = candidate.statusSelector || '';

  detectState.activeIndex = index;
  updateDetectActiveState();
  syncFormVisibility();
  setFormMessage('ok', '已填入候选 ' + (index + 1)
    + ' 的行 / 键 / 状态选择器，请确认后点击「保存监控项」。');
}

/**
 * 自动探测表格结构。
 * 权限申请必须在点击的同步调用栈内发起：本函数在第一个 await 之前
 * 只做同步的 URL 校验与 UI 状态更新，随后立刻调用 requestOriginPermission。
 */
async function handleDetectTable() {
  if (busy.detect) return;

  let url;
  try {
    url = String(dom.inputUrl.value || '').trim();
    if (!url) throw new Error('请先填写页面 URL，再自动探测表格结构');
    originPattern(url);
  } catch (error) {
    setFormMessage('error', errorMessageOf(error));
    return;
  }

  busy.detect = true;
  setButtonBusy(dom.detectTable, true, '探测中…');
  setFormMessage('', '正在探测页面表格结构…');
  try {
    // 权限兜底（安装时已授权 http(s) 全站权限），失败不阻塞
    await tryRequestOriginPermission(url);

    setFormMessage('', '正在探测页面表格结构…');
    const response = await sendMessage({ type: 'detect-table', url: url });
    if (!response || typeof response !== 'object') {
      throw new Error('扩展后台返回了无效结果，请重试');
    }
    if (response.ok !== true) {
      const message = response.error || '未知错误';
      setDetectPanelMessage('error', message);
      setFormMessage('error', '自动探测失败：' + message);
      return;
    }

    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    if (!candidates.length) {
      setDetectPanelMessage('empty',
        '没有自动探测到表格结构，暂不支持直接读取当前标签页的 DOM。'
        + '可手工填写：在目标页面右键元素 → 检查 → Copy selector，'
        + '再分别填写「行选择器」与「状态选择器」。');
      setFormMessage('error', '没有自动探测到表格结构，请手工填写选择器。');
      return;
    }

    renderDetectCandidates(candidates, response.loginRequired === true);
    applyDetectCandidate(0);
    if (response.loginRequired === true) {
      setFormMessage('error',
        '页面可能需要登录：已填入候选，但抓到的数据可能不完整。建议改用 tab 抓取方式，并在 Chrome 中保持已登录。');
    }
  } catch (error) {
    setFormMessage('error', '自动探测失败：' + errorMessageOf(error));
  } finally {
    busy.detect = false;
    setButtonBusy(dom.detectTable, false, '自动探测表格结构');
  }
}

function clearPreviewResult() {
  if (!dom.previewResult) return;
  dom.previewResult.hidden = true;
  setText(dom.previewSummary, '');
  if (dom.previewBody) dom.previewBody.textContent = '';
}

function setPreviewMessage(kind, message) {
  if (!dom.previewResult) return;
  dom.previewResult.hidden = false;
  dom.previewSummary.className = 'panel-sub' + (kind === 'error' ? ' is-error' : '');
  setText(dom.previewSummary, kind === 'error' ? '预览失败' : '');
  dom.previewBody.textContent = '';
  dom.previewBody.appendChild(el(
    'p',
    kind === 'error' ? 'preview-error' : 'preview-text',
    message
  ));
}

/** single：显示 valuePreview + 长度；rows：显示「共 N 行」+ 键 / 状态表格（最多 20 行）。 */
function renderPreviewResult(values, response) {
  if (!dom.previewResult) return;
  dom.previewResult.hidden = false;
  dom.previewSummary.className = 'panel-sub';
  dom.previewBody.textContent = '';

  if (values.extractMode === 'rows') {
    const rows = Array.isArray(response.rows) ? response.rows : [];
    const count = Number.isFinite(Number(response.count)) && Number(response.count) >= 0
      ? Number(response.count)
      : rows.length;
    setText(dom.previewSummary, '共 ' + count + ' 行');

    if (!rows.length) {
      dom.previewBody.appendChild(el('p', 'preview-text', '（没有提取到任何任务行）'));
      return;
    }

    const table = el('table', 'preview-table');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', null, '键'));
    headRow.appendChild(el('th', null, '状态'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    rows.slice(0, 20).forEach(function (row) {
      const tr = el('tr');
      tr.appendChild(el('td', 'preview-key', row && row.key !== undefined ? String(row.key) : ''));
      tr.appendChild(el('td', 'preview-status', row && row.value !== undefined ? String(row.value) : ''));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    dom.previewBody.appendChild(table);

    if (count > rows.length) {
      dom.previewBody.appendChild(el('p', 'preview-hint', '仅显示前 ' + rows.length + ' 行。'));
    }
    return;
  }

  const preview = response.valuePreview === undefined || response.valuePreview === null
    ? ''
    : String(response.valuePreview);
  const length = Number.isFinite(Number(response.length)) ? Number(response.length) : preview.length;
  setText(dom.previewSummary, '长度 ' + length + ' 字');
  dom.previewBody.appendChild(el('p', 'preview-value', preview || '（空）'));
}

/**
 * 预览提取结果（调用 get-preview，仅试抓取，不改状态）。
 * 与保存一样，权限申请在点击的同步调用栈内发起。
 */
async function handlePreview() {
  if (busy.preview) return;

  let values;
  try {
    values = readWatchForm({ allowEmptyName: true });
  } catch (error) {
    const message = errorMessageOf(error);
    setPreviewMessage('error', message);
    setFormMessage('error', message);
    return;
  }

  busy.preview = true;
  setButtonBusy(dom.previewWatch, true, '预览中…');
  setPreviewMessage('empty', '正在抓取并提取内容…');
  try {
    // 权限兜底（安装时已授权 http(s) 全站权限），失败不阻塞
    await tryRequestOriginPermission(values.url);

    setPreviewMessage('empty', '正在抓取并提取内容…');
    const response = await sendMessage({ type: 'get-preview', watch: buildPreviewWatch(values) });
    if (!response || typeof response !== 'object') {
      throw new Error('扩展后台返回了无效结果，请重试');
    }
    if (response.ok !== true) {
      setPreviewMessage('error', '预览失败：' + (response.error || '未知错误'));
      return;
    }

    renderPreviewResult(values, response);
    setFormMessage('ok', '预览完成。首次正式检查只建立基线，不会提醒。');
  } catch (error) {
    setPreviewMessage('error', '预览失败：' + errorMessageOf(error));
    setFormMessage('error', '预览失败：' + errorMessageOf(error));
  } finally {
    busy.preview = false;
    setButtonBusy(dom.previewWatch, false, '预览提取结果');
  }
}

/* ============================== 按钮 / 提示辅助 ============================== */

/** 直接设置按钮文案（同时清除上一次 busy 保存的旧文案）。 */
function setButtonLabel(button, text) {
  if (!button) return;
  button.textContent = text;
  delete button.dataset.idleText;
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

function showToast(message, kind) {
  if (!dom.toast || !message) return;
  dom.toast.textContent = message;
  dom.toast.className = 'toast show' + (kind === 'error' ? ' toast-error' : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    dom.toast.classList.remove('show');
  }, TOAST_DURATION_MS);
}

/* ============================== 事件绑定 ============================== */

function bindEvents() {
  // 图标缺失时不显示破图（不创建图标文件）
  if (dom.appLogo) {
    dom.appLogo.addEventListener('error', function () {
      dom.appLogo.style.display = 'none';
    });
  }

  // 设置区
  dom.saveSettings.addEventListener('click', handleSaveSettings);
  dom.testDelivery.addEventListener('click', handleTestDelivery);
  dom.settingsForm.addEventListener('submit', function (event) {
    event.preventDefault();
  });
  dom.settingsForm.addEventListener('input', markSettingsTouched);
  dom.settingsForm.addEventListener('change', markSettingsTouched);

  // 列表顶部
  dom.addWatch.addEventListener('click', function () {
    resetWatchForm();
    dom.advancedForm.open = true;
    setFormMessage('', '请填写下面的表单手动新增监控项。');
    dom.inputName.focus();
    dom.watchForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  dom.runCheckAll.addEventListener('click', handleRunCheckAll);

  // 监控项表单
  dom.saveWatch.addEventListener('click', handleSaveWatch);
  dom.cancelWatch.addEventListener('click', function () {
    resetWatchForm();
    setFormMessage('', '已重置表单。');
  });
  dom.watchForm.addEventListener('submit', function (event) {
    event.preventDefault();
    handleSaveWatch();
  });
  dom.inputValueKind.addEventListener('change', syncValueKindFields);
  dom.inputSelectorType.addEventListener('change', syncSelectorHint);
  dom.inputMode.addEventListener('change', function () {
    syncModeHint();
    syncFormVisibility();
  });
  dom.inputExtractMode.addEventListener('change', syncFormVisibility);

  // 自动探测 / 预览
  dom.detectTable.addEventListener('click', handleDetectTable);
  dom.previewWatch.addEventListener('click', handlePreview);
  dom.autoAddWatch.addEventListener('click', handleAutoAdd);
  dom.autoAddPage.addEventListener('click', handleAutoAddPage);
  dom.copyAutoDiagnostics.addEventListener('click', handleCopyAutoDiagnostics);
  dom.autoBaseline.addEventListener('click', handleAutoBaseline);
  dom.detectCurrentTab.addEventListener('click', handleDetectCurrentTab);
  dom.detectCandidates.addEventListener('click', function (event) {
    const button = event.target && event.target.closest
      ? event.target.closest('button[data-candidate-index]')
      : null;
    if (!button) return;
    const index = Number(button.dataset.candidateIndex);
    if (Number.isInteger(index)) applyDetectCandidate(index);
  });

  // 列表事件委托（行内按钮 + 开关）
  dom.watchList.addEventListener('click', function (event) {
    const button = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
    if (!button) return;
    const action = button.dataset.action;
    const watchId = button.dataset.id;
    if (action === 'edit') startEditWatch(watchId);
    else if (action === 'delete') handleDeleteWatch(watchId);
    else if (action === 'check') handleCheckWatch(watchId);
  });
  dom.watchList.addEventListener('change', function (event) {
    const input = event.target;
    if (!input || !input.matches || !input.matches('input[data-action="toggle"]')) return;
    handleToggleWatch(input.dataset.id, input.checked);
  });

  // 运行状态刷新
  dom.refreshState.addEventListener('click', function () {
    safeRefresh({ silent: false });
    showToast('状态已刷新');
  });

  // 窗口重新获得焦点时刷新一次（后台可能已更新检查结果）
  window.addEventListener('focus', function () {
    if (document.visibilityState === 'hidden') return;
    safeRefresh({ silent: true });
  });
}

/* ============================== 初始化 ============================== */

async function init() {
  cacheDom();
  bindEvents();
  applySettings(DEFAULT_SETTINGS);
  resetWatchForm();
  dom.advancedForm.open = false; // 「高级」默认折叠
  fillAutoUrlFromActiveTab();     // 用当前标签页地址预填「页面地址」（尽力而为）

  try {
    await refreshState({ forceSettings: true });
  } catch (error) {
    setHeaderState(false, errorMessageOf(error));
    renderWatches();
    renderRuntime();
    showToast(errorMessageOf(error), 'error');
  }
}

init().catch(function (error) {
  showToast('设置页初始化失败：' + errorMessageOf(error), 'error');
});
