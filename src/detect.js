/**
 * 页面结构探测：在真实页面上找「任务列表」的表格结构，给扩展 rows 模式推荐选择器。
 *
 * 重要约束：本函数会被 chrome.scripting.executeScript 序列化后注入页面执行，
 * 所以它必须是**完全自包含**的（不能引用模块外变量、不能 import），
 * 只能依赖参数 doc 与浏览器 DOM API。
 *
 * @param {Document} [doc]
 * @returns {{loginRequired: boolean, stats: {tables: number, trs: number, roots: number},
 *   candidates: Array<{
 *     rowSelector: string, keySelector: string, statusSelector: string,
 *     headers: string[], samples: Array<{key: string, value: string}>,
 *     rowCount: number, note: string
 *   }>}}
 */
export function detectTables(doc = document) {
  const norm = (value) => String(value ?? '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
  const STATUS_RE = /^(排队中?|等待中|运行中?|执行中|已完成?|完成|成功|失败|已失败|已取消|取消中|创建中|初始化中?|启动中|停止中|已停止|终止|异常|超时|限额中|恢复中|重启中|删除中|pending|queued|queueing|running|succeeded|success|failed|failedtostart|cancelled|canceled|creating|starting|stopping|completed|error)$/iu;
  const HEADER_STATUS_RE = /状态|status/iu;
  const HEADER_KEY_RE = /名称|任务|作业|标识|编号|id|name|job|task/iu;

  /** 生成一条对 document 唯一的 CSS 路径（类似 DevTools 的 Copy selector）。 */
  function cssPath(node) {
    const parts = [];
    for (let el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el.id) {
        parts.unshift(`#${el.id.replace(/[^\w-]/gu, '\\$&')}`);
        break;
      }
      let part = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  const textOf = (cell) => norm(cell?.textContent ?? '');

  // 全页表头行（固定表头时 thead 与 tbody 可能分属两个 table，需要跨表对齐）
  const headerRows = Array.from(doc.querySelectorAll('thead tr')).map(
    (row) => Array.from(row.children).map(textOf),
  );

  function pickHeaders(localHeaders, columnCount) {
    if (Array.isArray(localHeaders) && localHeaders.length === columnCount) return localHeaders;
    const hit = headerRows.find((row) => row.length === columnCount);
    if (hit) return hit;
    return (Array.isArray(localHeaders) && localHeaders.length > 0) ? localHeaders : (headerRows[0] ?? []);
  }

  function firstNonEmptyColumn(samples, exclude) {
    const columnCount = samples.reduce((max, cells) => Math.max(max, cells.length), 0);
    for (let index = 0; index < columnCount; index += 1) {
      if (index === exclude) continue;
      const values = samples.map((cells) => cells[index] ?? '').filter(Boolean);
      if (values.length === samples.length && values.length > 0) return index;
    }
    return -1;
  }

  /**
   * 状态单元格里常常是「标签 + 耗时」（例如 `<span class="status-tag-label">运行中</span>
   * <div class="acp-list-time">1d2h</div>`）。直接取 td 文本会得到 "运行中1d2h"，
   * 每次耗时变化都会误报，所以这里找出单元格里的「语义标签」子元素，优先取它。
   */
  function findNestedLabel(cellElement) {
    if (!cellElement) return null;
    const cellText = textOf(cellElement);
    const descendants = Array.from(cellElement.querySelectorAll('span, div, em, i, b, strong'));
    const candidates = descendants
      .map((el) => ({
        el,
        text: textOf(el),
        classes: Array.from(el.classList ?? []),
      }))
      .filter((item) => item.text && item.text !== cellText && cellText.includes(item.text));
    if (candidates.length === 0) return null;

    const scoreOf = (item) => {
      // 越像「纯文本标签」越优先：label/text/value 优先于 tag/status/badge，最后才是普通元素
      const classHits = (re) => item.classes.some((cls) => re.test(cls));
      let semantic = 2;
      if (classHits(/label|text|value|title/iu)) semantic = 0;
      else if (classHits(/tag|status|badge|chip|state/iu)) semantic = 1;
      return semantic * 1000 + item.text.length;
    };
    candidates.sort((a, b) => scoreOf(a) - scoreOf(b));
    const best = candidates[0];

    // 去掉可能带构建 hash 的 class，找不到稳定 class 就返回空选择器（调用方保留整格文本）
    const stableClass = best.classes.find(
      (cls) => /^[a-z][\w-]{2,40}$/iu.test(cls) && !/[a-f0-9]{6,}/iu.test(cls),
    );
    return { selector: stableClass ? `.${stableClass}` : '', text: best.text };
  }

  function buildCandidate(rowNodes, cellSelector, localHeaders, rowSelector, extraNote) {
    if (rowNodes.length === 0) return null;
    const sampleRows = rowNodes.slice(0, 3);
    const cellElements = sampleRows.map((row) => Array.from(row.querySelectorAll(cellSelector)));
    const samples = cellElements.map((cells) => cells.map(textOf));
    const columnCount = samples.reduce((max, cells) => Math.max(max, cells.length), 0);
    if (columnCount === 0) return null;

    const headers = pickHeaders(localHeaders, columnCount);
    let statusIndex = headers.findIndex((text) => HEADER_STATUS_RE.test(text));
    let keyIndex = headers.findIndex((text) => HEADER_KEY_RE.test(text));
    let note = extraNote || '';

    // 没有「状态」表头时，用「取值最像状态枚举」的列兜底
    if (statusIndex < 0) {
      let bestIndex = -1;
      let bestScore = 0;
      for (let index = 0; index < columnCount; index += 1) {
        const values = samples.map((cells) => cells[index] ?? '').filter(Boolean);
        if (values.length === 0) continue;
        const score = values.filter((value) => STATUS_RE.test(value)).length / values.length;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0 && bestScore >= 0.5) {
        statusIndex = bestIndex;
        note += '（没找到「状态」表头，按取值猜测状态列，请用预览确认）';
      }
    }
    if (statusIndex < 0) return null;

    // 键列：优先表头匹配，其次「第一个每行都有文字的列」（跳过复选框等空列）
    if (keyIndex < 0 || keyIndex === statusIndex) {
      const fallback = firstNonEmptyColumn(samples, statusIndex);
      keyIndex = fallback >= 0 ? fallback : (statusIndex === 0 ? 1 : 0);
    }

    // 状态列若「标签 + 耗时」混排，下沉到内部语义标签，避免耗时变化被当成状态变化
    const nested = findNestedLabel(cellElements[0]?.[statusIndex]);
    let statusSelector = `${cellSelector}:nth-child(${statusIndex + 1})`;
    let statusValues = samples.map((cells) => cells[statusIndex] ?? '');
    if (nested?.selector) {
      statusSelector = `${statusSelector} ${nested.selector}`;
      statusValues = cellElements.map(
        (cells) => textOf(cells[statusIndex]?.querySelector(nested.selector) ?? cells[statusIndex]),
      );
      note += `（状态取的是内部标签 ${nested.selector}，已自动去掉耗时文本）`;
    } else if (nested?.text) {
      note += '（状态单元格里混有耗时等文字，建议手动加稳定 class 精确定位状态标签）';
    }

    return {
      rowSelector,
      keySelector: `${cellSelector}:nth-child(${keyIndex + 1})`,
      statusSelector,
      headers,
      samples: samples.map((cells, index) => ({
        key: cells[keyIndex] ?? '',
        value: statusValues[index] ?? '',
      })),
      rowCount: rowNodes.length,
      note,
    };
  }

  const found = [];
  const seenSelectors = new Set();
  const push = (candidate) => {
    if (!candidate || seenSelectors.has(candidate.rowSelector)) return;
    seenSelectors.add(candidate.rowSelector);
    found.push(candidate);
  };

  // 1) 标准 <table>（含「表头单独一个 table + 表体另一个 table」的固定表头结构）
  for (const table of doc.querySelectorAll('table')) {
    const className = typeof table.className === 'string' ? table.className : '';
    // antd/sensed 的固定列 / 测量用隐藏表格，跳过
    if (/-(fixed|measure|hidden)|measure-row/iu.test(className)) continue;

    const allRows = Array.from(table.querySelectorAll('tbody tr'));
    const rowNodes = allRows.filter((row) => row.querySelectorAll('td').length > 1);
    if (rowNodes.length === 0) continue;

    const headerCells = Array.from(table.querySelectorAll('thead tr:last-child th, thead tr:last-child td'));
    const localHeaders = headerCells
      .map((cell) => norm(cell.textContent))
      .filter((text) => text !== '操作');
    push(buildCandidate(rowNodes, 'td', localHeaders, `${cssPath(table)} tbody tr`, ''));
  }

  // 2) role="row" 结构的表格（Arco / Ant Design 的可访问性结构）
  const groups = new Map();
  for (const row of doc.querySelectorAll('[role="row"]')) {
    const parent = row.parentElement;
    if (!parent) continue;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(row);
  }
  const columnHeaders = Array.from(doc.querySelectorAll('[role="columnheader"]'))
    .map((cell) => norm(cell.textContent))
    .filter(Boolean);

  for (const [parent, rows] of groups) {
    const dataRows = rows.filter((row) => row.children.length > 1);
    if (dataRows.length < 2) continue;
    const firstChild = dataRows[0].children[0];
    const cellSelector = firstChild?.getAttribute('role') === 'gridcell'
      ? '[role="gridcell"]'
      : (dataRows[0].querySelector('td') ? 'td' : '[role="cell"]');
    push(buildCandidate(
      dataRows,
      cellSelector,
      columnHeaders,
      `${cssPath(parent)} [role="row"]`,
      '（非标准 <table> 结构，选择器可能需要微调）',
    ));
  }

  // 3) 常见组件库的行 class 兜底
  const classSelectors = ['.arco-table-tr', '.ant-table-row', '[class*="table-row"]'];
  for (const selector of classSelectors) {
    const rows = Array.from(doc.querySelectorAll(selector)).filter((row) => row.querySelector('td'));
    if (rows.length < 2) continue;
    const firstRow = rows[0];
    const parent = firstRow.parentElement;
    const headerCells = Array.from(doc.querySelectorAll('.arco-table-th, .ant-table-thead th, [class*="table-th"]'));
    const localHeaders = headerCells.map((cell) => norm(cell.textContent)).filter(Boolean);
    const base = parent ? `${cssPath(parent)} > ${selector.split(',')[0].trim()}` : selector;
    push(buildCandidate(rows, 'td', localHeaders, base, '（组件库行 class，构建升级后 class 可能变化）'));
  }

  // 有「状态」表头的、行数多的排前面
  found.sort((left, right) => {
    const leftKnown = left.note.includes('猜测') ? 1 : 0;
    const rightKnown = right.note.includes('猜测') ? 1 : 0;
    if (leftKnown !== rightKnown) return leftKnown - rightKnown;
    return right.rowCount - left.rowCount;
  });

  // 未登录 / 空列表判断：只看页面可见文字，不动任何凭据
  const locationHref = typeof doc.location?.href === 'string' ? doc.location.href : '';
  const bodyText = norm(doc.body?.innerText ?? '').slice(0, 1000);
  const loginRequired = found.length === 0
    && /登录|扫码|login|signin|sign in/iu.test(`${locationHref} ${bodyText}`);

  return {
    loginRequired,
    stats: {
      tables: doc.querySelectorAll('table').length,
      trs: doc.querySelectorAll('tr').length,
      roots: doc.querySelectorAll('#root').length,
    },
    candidates: found.slice(0, 5),
  };
}

/**
 * 通用兜底：页面里没有「列表」时，找出最像「主要内容」的那块区域。
 * 同样会被 executeScript 序列化，所以必须自包含。
 *
 * @param {Document} [doc]
 * @returns {{ok: true, selector: string, length: number, preview: string} | {ok: false, reason: string}}
 */
export function detectMainContent(doc = document) {
  const norm = (value) => String(value ?? '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();

  function cssPath(node) {
    const parts = [];
    for (let el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el.id) {
        parts.unshift(`#${el.id.replace(/[^\w-]/gu, '\\$&')}`);
        break;
      }
      let part = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  const SELECTORS = [
    'main',
    'article',
    '[role="main"]',
    '#root',
    '.acp-list',
    '[class*="content" i]',
    '[class*="main" i]',
  ];

  let best = null;
  for (const selector of SELECTORS) {
    let nodes = [];
    try {
      nodes = Array.from(doc.querySelectorAll(selector));
    } catch {
      nodes = [];
    }
    for (const node of nodes) {
      const text = norm(node.textContent);
      if (text.length < 120) continue;
      // 选「文字多、层级尽量靠上」的容器
      const score = text.length;
      if (!best || score > best.score) best = { node, text, score };
    }
  }

  if (best) {
    return {
      ok: true,
      selector: cssPath(best.node),
      length: best.text.length,
      preview: best.text.slice(0, 160),
    };
  }

  const bodyText = norm(doc.body?.textContent ?? '');
  if (bodyText.length < 80) return { ok: false, reason: 'content-empty' };
  return {
    ok: true,
    selector: 'body',
    length: bodyText.length,
    preview: bodyText.slice(0, 160),
  };
}
