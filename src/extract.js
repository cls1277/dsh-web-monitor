/**
 * 纯函数层：内容归一化、指纹、DOM 提取、消息文案。
 *
 * 该文件同时被三方使用：
 *  - src/offscreen.js（浏览器，DOMParser 解析）
 *  - src/background.js（Service Worker，算哈希 / 拼文案）
 *  - tools/selftest.mjs（Node 自测）
 * 因此这里不能出现任何 chrome.* 或 DOM 全局依赖（extractValue 的 doc 由调用方传入）。
 */

/** 单条消息上限：微信主动投递按 1800 字符分段，控制在此以内可保证一次发送。 */
export const MAX_MESSAGE_CHARS = 1500;

/** 正则：连续空白（含全角空格、换行、制表符）。 */
const WHITESPACE_RE = /\s+/gu;

/**
 * 归一化文本：用来消除「只改了缩进/换行」的伪变化。
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeValue(input) {
  return String(input ?? '')
    .replace(/\u00a0/gu, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

/**
 * 生成一行预览，超长时截断并加省略号。
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function previewOf(value, max = 120) {
  const text = normalizeValue(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * 截断消息，保证不超长（宁可丢尾部，也不触发微信分段）。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clipMessage(text, max = MAX_MESSAGE_CHARS) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * 本地时间字符串：YYYY-MM-DD HH:mm:ss。
 * @param {number|Date} when
 * @returns {string}
 */
export function formatTime(when = Date.now()) {
  const date = when instanceof Date ? when : new Date(when);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * SHA-256 指纹（小写 hex）。crypto.subtle 在 Service Worker / Node 18+ 都可用。
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function hashValue(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 按选择器取节点。
 * @param {Document} doc
 * @param {'css'|'xpath'} selectorType
 * @param {string} selector
 * @returns {{ok: true, node: Element|Node} | {ok: false, reason: string}}
 */
export function selectNode(doc, selectorType, selector) {
  const value = String(selector ?? '').trim();
  if (!value) return { ok: false, reason: 'selector-invalid' };
  try {
    if (selectorType === 'xpath') {
      // 9 === XPathResult.FIRST_ORDERED_NODE_TYPE
      const result = doc.evaluate(value, doc, null, 9, null);
      const node = result?.singleNodeValue ?? null;
      return node ? { ok: true, node } : { ok: false, reason: 'selector-not-found' };
    }
    const node = doc.querySelector(value);
    return node ? { ok: true, node } : { ok: false, reason: 'selector-not-found' };
  } catch {
    return { ok: false, reason: 'selector-invalid' };
  }
}

/**
 * 从节点读出原始值。
 * @param {Element|Node} node
 * @param {{valueKind?: 'text'|'html'|'attr', attrName?: string}} extraction
 * @returns {string}
 */
export function readValue(node, extraction = {}) {
  const { valueKind = 'text', attrName = '' } = extraction;
  if (valueKind === 'html') return node.outerHTML ?? '';
  if (valueKind === 'attr') {
    if (!attrName) return '';
    return node.getAttribute?.(attrName) ?? '';
  }
  return node.textContent ?? '';
}

/**
 * 在已解析的文档上执行一次提取。
 * @param {Document} doc
 * @param {{selectorType?: 'css'|'xpath', selector?: string, valueKind?: 'text'|'html'|'attr', attrName?: string}} extraction
 * @returns {{ok: true, value: string} | {ok: false, reason: string}}
 */
export function extractValue(doc, extraction = {}) {
  const selected = selectNode(doc, extraction.selectorType ?? 'css', extraction.selector ?? '');
  if (!selected.ok) return selected;
  const raw = readValue(selected.node, extraction);
  return { ok: true, value: normalizeValue(raw) };
}

/**
 * 「内容变更」消息文案。
 * @param {{name: string, url: string}} watch
 * @param {string} oldValue
 * @param {string} newValue
 * @param {number} [when]
 * @returns {string}
 */
export function buildChangeMessage(watch, oldValue, newValue, when = Date.now()) {
  const head = [
    `【内容变更】${watch.name}`,
    `页面：${watch.url}`,
    `时间：${formatTime(when)}`,
  ].join('\n');
  const oldPreview = previewOf(oldValue, 80) || '(空)';
  // 给「变更前」和头部留足空间，剩余给「变更后」
  const budget = Math.max(300, MAX_MESSAGE_CHARS - head.length - oldPreview.length - 64);
  const newPreview = previewOf(newValue, budget) || '(空)';
  return clipMessage(`${head}\n变更前：${oldPreview}\n变更后：${newPreview}`);
}

/**
 * 「监控启动 / 基线建立」消息文案。
 * @param {{name: string, url: string}} watch
 * @param {string} value
 * @param {number} [when]
 * @returns {string}
 */
export function buildBaselineMessage(watch, value, when = Date.now()) {
  const head = [
    `【监控启动】${watch.name}`,
    `页面：${watch.url}`,
    `时间：${formatTime(when)}`,
  ].join('\n');
  const preview = previewOf(value, Math.max(300, MAX_MESSAGE_CHARS - head.length - 64)) || '(空)';
  return clipMessage(`${head}\n基线已建立，当前内容：${preview}`);
}

/**
 * 「测试发送」消息文案。
 * @param {number} [when]
 * @returns {string}
 */
export function buildTestMessage(when = Date.now()) {
  return [
    '【DSH 监控测试】主动投递已打通 ✅',
    `时间：${formatTime(when)}`,
    '收到这条消息说明：Chrome 扩展 → DSH-IM → 微信 的通路正常。',
  ].join('\n');
}

/* ==========================================================================
 * 列表（rows）模式：逐行提取「键 → 状态」，比较整个映射表。
 * 典型场景：算力平台的任务列表，每行一个任务，关注「状态」列的变化。
 * ========================================================================== */

/** 单条消息里最多列出的变化条目数。 */
const MAX_ROW_ENTRIES = 12;

/**
 * 取一行的前若干个单元格文本，用于「检查不到」时告诉用户实际 DOM 长什么样。
 * @param {Element} rowNode
 * @param {number} max
 * @returns {string[]}
 */
function rowCellSample(rowNode, max = 12) {
  try {
    return Array.from(rowNode.children)
      .slice(0, max)
      .map((cell, index) => `${index + 1}."${previewOf(cell.textContent, 20)}"`);
  } catch {
    return [];
  }
}

/**
 * 从已解析的文档里按行提取「键 → 状态」。
 * 只支持 CSS（相对行的 CSS），不支持 XPath。
 *
 * 失败原因分三级，便于直接定位问题：
 *  - rows-empty        ：行选择器一个都没命中（多半是抓取方式错了，或路径选择器落到了错误子树）
 *  - rows-key-empty    ：命中了行，但行键选择器在每行里都取不到内容
 *  - rows-status-empty ：命中了行，但状态选择器在每行里都取不到内容（列序变了 / 取错了节点）
 *
 * @param {Document} doc
 * @param {{rowSelector?: string, keySelector?: string, statusSelector?: string,
 *          keyAttr?: string, statusAttr?: string}} extraction
 * @returns {{ok: true, rows: Array<{key: string, value: string}>, count: number, statusMissing: number}
 *          | {ok: false, reason: string, matched?: number, totalTr?: number,
 *             sample?: string[], statusSelector?: string, keySelector?: string}}
 */
export function extractRows(doc, extraction = {}) {
  const rowSelector = String(extraction.rowSelector ?? '').trim();
  const statusSelector = String(extraction.statusSelector ?? '').trim();
  const keySelector = String(extraction.keySelector ?? '').trim();
  const keyAttr = String(extraction.keyAttr ?? '').trim();
  const statusAttr = String(extraction.statusAttr ?? '').trim();

  if (!rowSelector || !statusSelector) return { ok: false, reason: 'selector-invalid' };

  let rowNodes;
  try {
    rowNodes = Array.from(doc.querySelectorAll(rowSelector));
  } catch {
    return { ok: false, reason: 'selector-invalid' };
  }

  let totalTr = 0;
  let tbodyTr = 0;
  try {
    totalTr = doc.querySelectorAll('tr').length;
    tbodyTr = doc.querySelectorAll('tbody tr').length;
  } catch {
    totalTr = 0;
    tbodyTr = 0;
  }

  if (rowNodes.length === 0) {
    return { ok: false, reason: 'rows-empty', matched: 0, totalTr, tbodyTr };
  }

  const readCell = (rowNode, selector, attr) => {
    let target = rowNode;
    if (selector) {
      try {
        target = rowNode.querySelector(selector);
      } catch {
        target = null;
      }
      if (!target) return '';
    }
    const raw = attr ? (target.getAttribute?.(attr) ?? '') : (target.textContent ?? '');
    return normalizeValue(raw);
  };

  const sample = rowCellSample(rowNodes[0]);
  const seen = new Map();
  const rows = [];
  let rawKeyMissing = 0;
  let statusMissing = 0;

  for (const rowNode of rowNodes) {
    const rawKey = readCell(rowNode, keySelector, keyAttr);
    if (!rawKey) rawKeyMissing += 1;
    // 没配行键（选择器与属性都为空）时用整行文本作键；否则用取到的键
    const key = (keySelector || keyAttr)
      ? (rawKey || previewOf(rowNode.textContent, 80))
      : previewOf(rowNode.textContent, 80);
    if (!key) continue; // 空占位行

    const value = readCell(rowNode, statusSelector, statusAttr);
    if (!value) statusMissing += 1;

    const repeat = (seen.get(key) ?? 0) + 1;
    seen.set(key, repeat);
    rows.push({ key: repeat > 1 ? `${key}#${repeat}` : key, value });
  }

  if (rowNodes.length > 0 && rawKeyMissing === rowNodes.length && (keySelector || keyAttr)) {
    return {
      ok: false,
      reason: 'rows-key-empty',
      matched: rowNodes.length,
      keySelector,
      keyAttr,
      sample,
    };
  }

  if (rows.length === 0) {
    return { ok: false, reason: 'rows-empty', matched: 0, totalTr };
  }

  if (statusMissing === rows.length) {
    return {
      ok: false,
      reason: 'rows-status-empty',
      matched: rows.length,
      statusSelector,
      sample,
    };
  }

  return { ok: true, rows, count: rows.length, statusMissing };
}

/**
 * 把 {key: value} 映射序列化成稳定字符串（键排序，顺序无关）用于算指纹。
 * @param {Record<string, string>} map
 * @returns {string}
 */
export function serializeRows(map) {
  const keys = Object.keys(map ?? {}).sort();
  return JSON.stringify(keys.map((key) => [key, map[key]]));
}

/**
 * 反序列化回映射（兼容旧数据：失败时返回空对象）。
 * @param {string} serialized
 * @returns {Record<string, string>}
 */
export function parseRows(serialized) {
  try {
    const parsed = JSON.parse(String(serialized ?? ''));
    if (!Array.isArray(parsed)) return {};
    return Object.fromEntries(parsed.filter((item) => Array.isArray(item) && typeof item[0] === 'string'));
  } catch {
    return {};
  }
}

/**
 * 比较两份映射。
 * @param {Record<string, string>} oldMap
 * @param {Record<string, string>} newMap
 * @returns {{changed: Array<{key: string, from: string, to: string}>,
 *            added: Array<{key: string, value: string}>,
 *            removed: Array<{key: string, value: string}>}}
 */
export function diffRows(oldMap = {}, newMap = {}) {
  const changed = [];
  const added = [];
  const removed = [];

  for (const [key, value] of Object.entries(newMap)) {
    if (!Object.hasOwn(oldMap, key)) added.push({ key, value });
    else if (oldMap[key] !== value) changed.push({ key, from: oldMap[key], to: value });
  }
  for (const [key, value] of Object.entries(oldMap)) {
    if (!Object.hasOwn(newMap, key)) removed.push({ key, value });
  }

  return { changed, added, removed };
}

/**
 * 按 onlyStatuses 过滤差异（只比较「新状态/新增行的状态」是否命中）。
 * @param {{changed: Array, added: Array, removed: Array}} diff
 * @param {{onlyStatuses?: string}} [options]
 * @returns {{changed: Array, added: Array, removed: Array}}
 */
export function filterRowsDiff(diff, options = {}) {
  const statuses = String(options.onlyStatuses ?? '')
    .split(/[,，]/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (statuses.length === 0) return diff;

  const hits = (value) => statuses.includes(String(value ?? '').trim());
  return {
    changed: diff.changed.filter((entry) => hits(entry.to)),
    added: diff.added.filter((entry) => hits(entry.value)),
    removed: diff.removed.filter((entry) => hits(entry.value)),
  };
}

/**
 * 列表模式下「有变化」的消息文案。
 * @param {{name: string, url: string}} watch
 * @param {{changed: Array, added: Array, removed: Array}} diff
 * @param {number} [when]
 * @returns {string}
 */
export function buildRowsChangeMessage(watch, diff, when = Date.now()) {
  const entries = [
    ...diff.changed.map((entry) => `• ${previewOf(entry.key, 60)}：${entry.from || '(空)'} → ${entry.to || '(空)'}`),
    ...diff.added.map((entry) => `• ${previewOf(entry.key, 60)}：新增，状态 ${entry.value || '(空)'}`),
    ...diff.removed.map((entry) => `• ${previewOf(entry.key, 60)}：已不在列表中（原状态 ${entry.value || '(空)'}）`),
  ];

  const total = entries.length;
  const head = [
    `【任务状态变化】${watch.name}`,
    `页面：${watch.url}`,
    `时间：${formatTime(when)}`,
  ].join('\n');

  const body = entries.slice(0, MAX_ROW_ENTRIES);
  if (total > MAX_ROW_ENTRIES) body.push(`…等 ${total} 项变化`);

  return clipMessage(`${head}\n${body.join('\n')}\n（共 ${total} 项变化）`);
}

/**
 * 列表模式首次建立基线的消息文案。
 * @param {{name: string, url: string}} watch
 * @param {Record<string, string>} map
 * @param {number} [when]
 * @returns {string}
 */
export function buildRowsBaselineMessage(watch, map, when = Date.now()) {
  const keys = Object.keys(map ?? {}).sort();
  const lines = keys.slice(0, 8).map((key) => `• ${previewOf(key, 60)}：${previewOf(map[key], 40) || '(空)'}`);
  const head = [
    `【列表监控启动】${watch.name}`,
    `页面：${watch.url}`,
    `时间：${formatTime(when)}`,
    `已记录 ${keys.length} 个任务，当前状态：`,
  ].join('\n');
  const tail = keys.length > 8 ? `…等 ${keys.length} 个任务` : '';
  return clipMessage([head, ...lines, tail].filter(Boolean).join('\n'));
}

/**
 * 「任务A=运行中；任务B=排队中」这样的一行预览，供状态列展示。
 * @param {Array<{key: string, value: string}>} rows
 * @param {number} [max]
 * @returns {string}
 */
export function rowsPreview(rows, max = 8) {
  return (rows ?? [])
    .slice(0, max)
    .map((row) => `${row.key}=${row.value || '(空)'}`)
    .join('；');
}

