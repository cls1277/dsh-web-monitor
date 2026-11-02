/**
 * 浏览器内验证（可选，需要本机 Chrome + puppeteer-core）。
 *
 * Phase 1（一定会跑）：在真实 Chrome 里加载 src/extract.js，用真实 DOMParser / document
 *   验证 CSS、XPath、属性取值、空白归一化、SHA-256 与消息长度约束 —— 这正是离屏文档
 *   解析 HTML 的那条代码路径。
 *
 * Phase 1b（一定会跑）：SenseCore 控制台「任务列表」仿真页（/sensecore-harness），
 *   复现两个 id="root"、固定表头把 thead/tbody 拆成两张 table、每行 11 个 td 的真实结构，
 *   用来定位用户「检查不到」的原因（位置长链 0 行 / 表头表无 tbody / 状态文本被耗时污染 /
 *   direct 模式只拿到 SPA 空壳），并对照验证 detectTables 的能力边界。
 *
 * Phase 2（尽力而为）：通过 CDP Extensions.loadUnpacked 安装扩展，打开设置页，
 *   走「保存监控项 → 首次检查 → 内容变化 → 真实 POST 到 mock 的 DSH 接口」全链路。
 *   注意：Chrome 137+ 起命令行 --load-extension 被移除，且部分正式版会屏蔽自动化打开
 *   chrome-extension:// 页面（ERR_BLOCKED_BY_CLIENT）；被屏蔽时本阶段标记 SKIP，
 *   Phase 1 与 Node 测试仍然有效。
 *
 * 运行：
 *   node tools/browser-e2e.mjs
 *   HEADFUL=1 node tools/browser-e2e.mjs
 *
 * 依赖 puppeteer-core，默认从 DSH 桌面端 profile 解析，可用 PUPPETEER_CORE_PATH 覆盖。
 */
import { existsSync } from 'node:fs';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectTables } from '../src/detect.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.tmp');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/**
 * puppeteer-core 是可选依赖（本仓库不打包它）。
 * 解析顺序：PUPPETEER_CORE_PATH（指向含 node_modules 的目录）→ 本目录 → 全局。
 */
function loadPuppeteer() {
  const bases = [
    process.env.PUPPETEER_CORE_PATH,
    ROOT,
    join(ROOT, 'tools'),
  ].filter(Boolean);

  for (const base of bases) {
    try {
      const baseRequire = createRequire(base.endsWith('/') ? base : `${base}/`);
      return baseRequire('puppeteer-core');
    } catch {
      /* 试下一个 */
    }
  }
  try {
    return createRequire(import.meta.url)('puppeteer-core');
  } catch {
    return null;
  }
}

const puppeteer = loadPuppeteer();
if (!puppeteer) {
  console.error('找不到 puppeteer-core，跳过浏览器验证。');
  console.error('安装：npm i -D puppeteer-core（或设置 PUPPETEER_CORE_PATH 指向已安装它的目录）');
  process.exit(2);
}

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('找不到 Chrome，跳过浏览器验证。可用 CHROME_PATH 指定可执行文件。');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 测试服务：静态资源 + mock DSH-IM 投递接口
// ---------------------------------------------------------------------------

const world = { pageValue: '第一版内容', deliveries: [] };

const HARNESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>harness</title></head>
<body>
  <div id="content">  公告：\u00a0\u00a0系统维护  </div>
  <a id="link" href="/notice/42" data-count="42">详情</a>
  <ul id="list"><li class="item">A</li><li class="item">B</li></ul>
  <div id="rich"><span class="hl">高亮</span><span>普通</span></div>
</body>
<script type="module">
  import * as core from '/extract.js';
  window.__core = core;
  window.__ready = true;
</script>
</html>`;

/** 模拟算力平台的任务列表（antd/arco 风格的真实 <table>） */
const TASKS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>任务列表</title></head>
<body>
  <div class="arco-layout-content">
    <table class="arco-table">
      <thead>
        <tr><th>任务名称</th><th>任务 ID</th><th>状态</th><th>创建时间</th></tr>
      </thead>
      <tbody>
        <tr><td>训练任务A</td><td>job-1</td><td>运行中</td><td>2026-11-01 10:00</td></tr>
        <tr><td>训练任务B</td><td>job-2</td><td>排队中</td><td>2026-11-01 10:05</td></tr>
        <tr><td>训练任务C</td><td>job-3</td><td>已完成</td><td>2026-11-01 09:00</td></tr>
      </tbody>
    </table>
    <table class="arco-table-fixed"><tbody><tr><td>固定列占位</td><td>占位</td></tr></tbody></table>
  </div>
</body></html>`;

/** 模拟被踢到登录页（没有任何任务表格） */
const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>登录 - SenseCore</title></head>
<body><div class="login-panel"><h1>请登录</h1><p>扫码登录 / 账号登录</p></div></body></html>`;

// ---------------------------------------------------------------------------
// SenseCore 控制台「任务列表」仿真页（用于复现用户「检查不到」的真实 DOM 陷阱）
//
// 仿真的关键事实（来自对 console.sensecore.cn 公开 bundle 的静态分析）：
//   * 三层 qiankun 微前端：区域子应用 root 里还套着 ACP 子应用 root → 页面上有 **两个 id="root"**；
//   * 表格是 SenseD/rc-table，scroll.y 固定表头把 thead 和 tbody 拆进 **两张 <table>**；
//   * 每行 11 个 td，第 1 个是复选框列，状态在第 10 个 td 的 span.status-tag-label 里，
//     同一格后面还会跟一个 div.acp-list-time（耗时），所以 td 的 textContent 会被耗时污染；
//   * 行是 tr.sensed-table-row[data-row-key]。
// ---------------------------------------------------------------------------

/** 用户在扩展里手工填的那条 rowSelector（原样复现，不做任何「修正」）。 */
const USER_LONG_ROW_SELECTOR = '#root > div > div:nth-of-type(2) > div > div > div:nth-of-type(4) > div > div > div > div > div > div > div:nth-of-type(2) > table tbody tr';

const SENSECORE_HEADERS = ['', '显示名称/名称', '关联集群', '框架', '任务规格', '副本数', '创建时间', '提交者', '优先级', '状态', '操作'];

const SENSECORE_ROWS = [
  {
    key: 'train-bert',
    name: 'bert-finetune',
    cluster: 'cn-sh-01 / public',
    framework: 'PyTorch DDP',
    spec: 'A100-80G × 1',
    replicas: '1',
    created: '2026-11-01 10:00:00',
    user: 'alice',
    priority: 'NORMAL',
    status: '运行中',
    duration: '1d2h',
    tagColor: 'rgb(14,156,255)',
    tagBg: 'rgba(14,156,255,0.1)',
  },
  {
    key: 'train-gpt',
    name: 'gpt-pretrain',
    cluster: 'cn-sh-01 / public',
    framework: 'TensorFlow PS',
    spec: 'H800 × 8',
    replicas: '8',
    created: '2026-11-01 10:05:00',
    user: 'bob',
    priority: 'HIGH',
    status: '排队中',
    duration: '',
    tagColor: 'rgb(0,106,230)',
    tagBg: 'rgba(0,106,230,0.1)',
  },
  {
    key: 'train-llama',
    name: 'llama-sft',
    cluster: 'cn-sh-01 / public',
    framework: 'SenseParrots',
    spec: 'A100-80G × 4',
    replicas: '4',
    created: '2026-11-01 09:00:00',
    user: 'carol',
    priority: 'NORMAL',
    status: '成功',
    duration: '2h',
    tagColor: 'rgb(18,185,41)',
    tagBg: 'rgba(18,185,41,0.1)',
  },
];

/** 生成 rc-table 风格的 tbody 行（11 个 td）。withDuration=false 用来做「状态单元格不含耗时」的对照样本。 */
function buildSenseCoreRowHtml(withDuration) {
  return SENSECORE_ROWS.map((row) => {
    const durationHtml = withDuration && row.duration
      ? `<div class="acp-list-time">${row.duration}</div>`
      : '';
    const cells = [
      '<td class="sensed-table-cell sensed-table-selection-column"><label class="sensed-checkbox"><input type="checkbox"></label></td>',
      `<td class="sensed-table-cell"><div class="ellipsis"><span>${row.name}</span></div></td>`,
      `<td class="sensed-table-cell">${row.cluster}</td>`,
      `<td class="sensed-table-cell">${row.framework}</td>`,
      `<td class="sensed-table-cell">${row.spec}</td>`,
      `<td class="sensed-table-cell">${row.replicas}</td>`,
      `<td class="sensed-table-cell">${row.created}</td>`,
      `<td class="sensed-table-cell">${row.user}</td>`,
      `<td class="sensed-table-cell">${row.priority}</td>`,
      `<td class="sensed-table-cell"><div style="width:fit-content"><div class="status-tag status" style="color:${row.tagColor};background:${row.tagBg}"><span class="dot" style="background:${row.tagColor}"></span><span class="status-tag-label">${row.status}</span></div></div>${durationHtml}</td>`,
      '<td class="sensed-table-cell"><a class="action">复制</a><a class="action">日志</a><a class="action">事件</a><a class="action">监控</a><a class="action">停止</a></td>',
    ];
    return `<tr class="sensed-table-row sensed-table-row-level-0" data-row-key="${row.key}">${cells.join('')}</tr>`;
  }).join('\n                      ');
}

/**
 * 生成仿真控制台页面。
 * @param {{withDuration?: boolean}} [options] withDuration=false 时状态单元格只留标签文本（对照样本）
 */
function buildSenseCoreHtml({ withDuration = true } = {}) {
  const colgroup = `<colgroup>${Array.from({ length: 11 }, (_, index) => (index === 0 ? '<col style="width:46px">' : '<col>')).join('')}</colgroup>`;
  const headerCells = SENSECORE_HEADERS.map((text, index) => (index === 0
    ? '<th class="sensed-table-cell sensed-table-selection-column"><label class="sensed-checkbox"><input type="checkbox"></label></th>'
    : `<th class="sensed-table-cell">${text}</th>`)).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>SenseCore · ACP 任务列表（仿真）</title>
<style>
  body { margin: 0; font: 13px/1.5 -apple-system, "Microsoft YaHei", sans-serif; color: #323c47; }
  .sensed-layout { display: flex; min-height: 100vh; }
  .sensed-layout-sider { width: 200px; background: #1f2733; color: #cbd3df; padding: 12px; }
  .sensed-layout-content { flex: 1; padding: 16px; background: #f5f7fa; }
  .acp-list.page-container { background: #fff; border-radius: 6px; padding: 16px; }
  .list-header h2 { margin: 0 0 8px; font-size: 16px; }
  .toolbar { margin: 8px 0; color: #566a7f; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border-bottom: 1px solid #eef1f5; padding: 6px 8px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  th { background: #fafbfc; color: #566a7f; font-weight: 500; }
  .status-tag { display: inline-flex; align-items: center; height: 22px; border-radius: 4px; padding: 0 8px; font-size: 12px; }
  .status-tag .dot { display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 100%; }
  .status-tag-label { line-height: 1; }
  .acp-list-time { font-size: 12px; line-height: 20px; color: #566a7f; }
  .action { margin-right: 8px; color: #006ae6; cursor: pointer; }
</style></head>
<body>
<!-- 第 1 层：区域子应用 core-cn-sh-01-app 的根（id="root"）。真实页面里它只剩布局/导航的外壳，
     但 ACP 子应用挂载在它的子树里，所以从它出发的「位置路径」看起来也能一路往下写。 -->
<div id="root" class="region-root">
  <div class="sensed-layout">
    <div class="sensed-layout-sider">SenseCore 导航</div>
    <div class="sensed-layout-content">
      <div class="qiankun-container" data-micro-app="core-acpv2-app">
        <!-- 第 2 层：ACP 子应用 core-acpv2-app 的根 —— 又一个 id="root"（真实页面上确实是两个 #root） -->
        <div id="root" class="acp-root">
          <div class="acp-list page-container">
            <div class="list-header"><h2>任务列表</h2></div>
            <div class="toolbar"><span>全部</span> | <span>我的任务</span></div>
            <div class="sensed-spin-nested-loading"><div class="sensed-spin-container">
              <div class="sensed-table sensed-table-fixed-header">
                <div class="sensed-table-container">
                  <!-- 固定表头：scroll.y 生效时 rc-table 把 thead 与 tbody 拆进两张 table。
                       表头这张 table 只有 thead，没有 tbody —— 若把选择器锚到它，「table tbody tr」命中 0。 -->
                  <div class="sensed-table-header">
                    <table style="table-layout:fixed">${colgroup}<thead class="sensed-table-thead"><tr>${headerCells}</tr></thead></table>
                  </div>
                  <div class="sensed-table-body">
                    <table style="table-layout:fixed">${colgroup}<tbody class="sensed-table-tbody">
                      ${buildSenseCoreRowHtml(withDuration)}
                    </tbody></table>
                  </div>
                </div>
              </div>
            </div></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script type="module">
  import * as core from '/extract.js';
  window.__core = core;
  window.__ready = true;
</script>
</body></html>`;
}

/** 仿真「direct 模式抓到的 SPA 空壳」：真实站点未登录/直接 fetch 时只有外壳，没有任何 <table>。 */
const SENSECORE_SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>SenseCore</title>
<link rel="stylesheet" href="/umi.70881c42.css">
<script src="/preload_helper.21b4d82a.js"></script></head>
<body><div id="root-master"></div>
<script src="/umi.31807360.js"></script></body></html>`;

const SENSECORE_HTML = buildSenseCoreHtml({ withDuration: true });
const SENSECORE_CLEAN_HTML = buildSenseCoreHtml({ withDuration: false });

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/extract.js') {
    readFile(join(ROOT, 'src/extract.js'))
      .then((buffer) => {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(buffer);
      })
      .catch(() => response.writeHead(500).end('no extract.js'));
    return;
  }

  if (url.pathname === '/harness') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(HARNESS_HTML);
    return;
  }

  if (url.pathname === '/tasks-harness') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(TASKS_HTML);
    return;
  }

  if (url.pathname === '/login-harness') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(LOGIN_HTML);
    return;
  }

  // SenseCore 控制台仿真页：两个 #root、固定表头双 table、11 列、状态单元格带耗时
  if (url.pathname === '/sensecore-harness') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(SENSECORE_HTML);
    return;
  }

  // 同一结构的对照样本：状态单元格不含 .acp-list-time（用于证明「耗时文本」是探测失效的原因）
  if (url.pathname === '/sensecore-harness-clean') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(SENSECORE_CLEAN_HTML);
    return;
  }

  if (url.pathname === '/page') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>e2e</title></head><body>
      <div id="content">${world.pageValue}</div>
      <ul id="list"><li class="item">A</li><li class="item">B</li></ul>
    </body></html>`);
    return;
  }

  if (url.pathname === '/api/dsh-im/delivery/messages' && request.method === 'POST') {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      try {
        world.deliveries.push(JSON.parse(raw));
      } catch {
        world.deliveries.push({ raw });
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ sent: true }));
    });
    return;
  }

  response.writeHead(404).end('nope');
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const base = `http://127.0.0.1:${server.address().port}`;

await mkdir(TMP, { recursive: true });
const PROFILE_DIR = join(TMP, 'chrome-e2e');
await rm(PROFILE_DIR, { recursive: true, force: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: process.env.HEADFUL ? false : true,
  userDataDir: PROFILE_DIR,
  pipe: true,
  args: [
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});

const failures = [];
let passed = 0;
let skipped = 0;

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}（实际：${JSON.stringify(actual)}）`);
  }
}

console.log(`浏览器验证（Chrome ${await browser.version()}）`);


// ---------------------------------------------------------------------------
// Phase 1：真实 DOM 提取
// ---------------------------------------------------------------------------

const page = await browser.newPage();
await page.goto(`${base}/harness`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true', { timeout: 10_000 });

const runExtract = (options) => page.evaluate((opts) => {
  const core = window.__core;
  // 模拟离屏文档：把 HTML 字符串交给 DOMParser 解析，再提取
  const doc = new DOMParser().parseFromString(opts.html, 'text/html');
  return core.extractValue(doc, opts.extraction);
}, options);

/** 打开一个仿真页面并等待 src/extract.js 注入完成。 */
async function openFixturePage(pathname) {
  const fixturePage = await browser.newPage();
  await fixturePage.goto(`${base}${pathname}`, { waitUntil: 'domcontentloaded' });
  await fixturePage.waitForFunction('window.__ready === true', { timeout: 10_000 });
  return fixturePage;
}

/** 把一段 HTML 丢给 DOMParser 后跑 extractRows（完全复用离屏文档那条代码路径）。 */
const runRowsOnHtml = (targetPage, html, extraction) => targetPage.evaluate((payload) => {
  const doc = new DOMParser().parseFromString(payload.html, 'text/html');
  return window.__core.extractRows(doc, payload.extraction);
}, { html, extraction });

// extractRows 的失败语义（现已落地）：
//   rows-empty       0 行命中，带 matched=0 / totalTr / tbodyTr
//   rows-key-empty   命中行但键全空，带 matched / keySelector / keyAttr / sample
//   rows-status-empty 命中行但状态全空，带 matched / statusSelector / sample
const rowsFailure = (result) => `${result?.reason ?? 'ok:true'}（${JSON.stringify(result).slice(0, 300)}…）`;

console.log('\nPhase 1：真实 DOMParser 提取');

await step('CSS 选择器提取 + 空白归一化（含全角空格）', async () => {
  const result = await runExtract({
    html: '<div id="content">  公告：\u00a0\u00a0系统维护  </div>',
    extraction: { selectorType: 'css', selector: '#content' },
  });
  assertEqual(result, { ok: true, value: '公告： 系统维护' }, '提取结果不对');
});

await step('CSS 提取属性值', async () => {
  const result = await runExtract({
    html: '<a id="link" href="/notice/42" data-count="42">详情</a>',
    extraction: { selectorType: 'css', selector: '#link', valueKind: 'attr', attrName: 'href' },
  });
  assertEqual(result, { ok: true, value: '/notice/42' }, '属性提取不对');
});

await step('CSS 提取 outerHTML', async () => {
  const result = await runExtract({
    html: '<div id="rich"><span class="hl">高亮</span><span>普通</span></div>',
    extraction: { selectorType: 'css', selector: '#rich', valueKind: 'html' },
  });
  assert(result.ok === true, '应提取成功');
  assert(result.value.includes('<span class="hl">高亮</span>'), `HTML 提取不完整：${result.value}`);
});

await step('XPath 选择器提取', async () => {
  const result = await runExtract({
    html: '<ul id="list"><li class="item">A</li><li class="item">B</li></ul>',
    extraction: { selectorType: 'xpath', selector: '//*[@id="list"]/li[2]' },
  });
  assertEqual(result, { ok: true, value: 'B' }, 'XPath 提取不对');
});

await step('选择器未命中 / 语法错误区分清楚', async () => {
  const missing = await runExtract({
    html: '<div id="content">x</div>',
    extraction: { selectorType: 'css', selector: '#no-such' },
  });
  assertEqual(missing, { ok: false, reason: 'selector-not-found' }, '未命中原因不对');

  const invalid = await runExtract({
    html: '<div id="content">x</div>',
    extraction: { selectorType: 'css', selector: 'div[' },
  });
  assertEqual(invalid, { ok: false, reason: 'selector-invalid' }, '语法错误原因不对');

  const invalidXPath = await runExtract({
    html: '<div id="content">x</div>',
    extraction: { selectorType: 'xpath', selector: '//*[' },
  });
  assertEqual(invalidXPath, { ok: false, reason: 'selector-invalid' }, 'XPath 语法错误原因不对');
});

await step('页面脚本无法注入执行（XSS 面）', async () => {
  const result = await runExtract({
    html: '<div id="content"><script>window.__pwned = true<\/script>安全</div>',
    extraction: { selectorType: 'css', selector: '#content' },
  });
  assert(result.ok === true, '应提取成功');
  const pwned = await page.evaluate(() => Boolean(window.__pwned));
  assert(pwned === false, 'DOMParser 文档中的脚本不应执行');
});

await step('真实 crypto.subtle 计算指纹', async () => {
  const hash = await page.evaluate(() => window.__core.hashValue('abc'));
  assertEqual(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '指纹不对');
});

await step('消息文案在真实环境下不超长', async () => {
  const result = await page.evaluate(() => {
    const core = window.__core;
    const text = core.buildChangeMessage(
      { name: '公告页', url: 'https://example.com/notice' },
      '旧内容',
      '新内容'.repeat(5000),
    );
    return { length: text.length, max: core.MAX_MESSAGE_CHARS, head: text.slice(0, 20) };
  });
  assert(result.length <= result.max, `消息超长：${result.length} > ${result.max}`);
  assert(result.head.includes('【内容变更】'), '消息标题不对');
});

await step('rows 模式：真实 DOMParser 提取「任务名 → 状态」', async () => {
  const result = await page.evaluate(() => {
    const core = window.__core;
    const html = '<table><tbody>'
      + '<tr><td>训练任务A</td><td>job-1</td><td>运行中</td></tr>'
      + '<tr><td>训练任务B</td><td>job-2</td><td>排队中</td></tr>'
      + '</tbody></table>';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return core.extractRows(doc, {
      rowSelector: 'tbody tr',
      keySelector: 'td:nth-child(1)',
      statusSelector: 'td:nth-child(3)',
    });
  });
  assertEqual(result.ok, true, '提取应成功');
  assertEqual(result.count, 2, '行数不对');
  assertEqual(result.rows, [
    { key: '训练任务A', value: '运行中' },
    { key: '训练任务B', value: '排队中' },
  ], '提取内容不对');
});

await step('detectTables 在真实表格页识别出「状态」列', async () => {
  const tablePage = await browser.newPage();
  await tablePage.goto(`${base}/tasks-harness`, { waitUntil: 'domcontentloaded' });
  const result = await tablePage.evaluate(detectTables);
  await tablePage.close();

  assert(result.candidates.length > 0, '应识别到候选表格');
  const best = result.candidates[0];
  assert(best.rowSelector.includes('tbody tr'), `行选择器不对：${best.rowSelector}`);
  assertEqual(best.statusSelector, 'td:nth-child(3)', '状态列索引不对');
  assertEqual(best.keySelector, 'td:nth-child(1)', '任务名索引不对');
  assertEqual(best.samples[0], { key: '训练任务A', value: '运行中' }, '样例行不对');
  assert(!String(best.note).includes('猜测'), '有表头时不应走「猜状态列」逻辑');
  assert(!best.rowSelector.includes('arco-table-fixed'), '不应选中固定列占位表');
});

await step('detectTables 能识别登录页', async () => {
  const loginPage = await browser.newPage();
  await loginPage.goto(`${base}/login-harness`, { waitUntil: 'domcontentloaded' });
  const result = await loginPage.evaluate(detectTables);
  await loginPage.close();
  assertEqual(result.loginRequired, true, '应识别为需要登录');
  assertEqual(result.candidates.length, 0, '登录页不应识别出表格');
});

// ---------------------------------------------------------------------------
// Phase 1b：SenseCore 控制台仿真 —— 复现用户「检查不到」的真实 DOM 陷阱
//
// 用户手工填写:
//   rowSelector   = USER_LONG_ROW_SELECTOR（#root > div > … 的位置长链）
//   keySelector   = 'td:nth-child(1)'      ← 第 1 列是复选框
//   statusSelector= 'td:nth-child(10)'     ← 值会被耗时污染
// 本阶段用真实 Chrome 在仿真 DOM 上取证：到底是哪种原因让「检查不到」。
// ---------------------------------------------------------------------------

console.log('\nPhase 1b：SenseCore 控制台仿真（两个 #root / 固定表头双 table / 11 列）');

const sensecorePage = await openFixturePage('/sensecore-harness');
const sensecoreHtml = await sensecorePage.evaluate(() => document.documentElement.outerHTML);

await step('仿真 DOM：两个 id="root"、表头/表体两张 table、每行 11 个 td', async () => {
  const stats = await sensecorePage.evaluate(() => {
    const rows = document.querySelectorAll('.acp-list tr.sensed-table-row[data-row-key]');
    const roots = Array.from(document.querySelectorAll('#root'));
    return {
      rootCount: roots.length,
      rootClasses: roots.map((root) => root.className),
      tableCount: document.querySelectorAll('table').length,
      headerThCount: document.querySelectorAll('.sensed-table-header thead th').length,
      headerTableBodyRows: document.querySelectorAll('.sensed-table-header table tbody tr').length,
      bodyTableRows: document.querySelectorAll('.sensed-table-body table tbody tr').length,
      dataRows: rows.length,
      cellsPerRow: rows[0]?.children.length ?? 0,
      statusLabels: document.querySelectorAll('.acp-list .status-tag-label').length,
    };
  });

  assertEqual(stats.rootCount, 2, '页面上应有 2 个 id="root"（区域子应用 + ACP 子应用）');
  assertEqual(stats.tableCount, 2, '固定表头应把 thead / tbody 拆成两张 table');
  assertEqual(stats.headerThCount, 11, '表头应有 11 个 th（含复选框列）');
  assertEqual(stats.headerTableBodyRows, 0, '表头 table 里没有 tbody 行 —— 锚到它就会 0 行');
  assertEqual(stats.bodyTableRows, 3, '表体 table 里应有 3 行');
  assertEqual(stats.dataRows, 3, '应有 3 个 tr.sensed-table-row[data-row-key]');
  assertEqual(stats.cellsPerRow, 11, '每行应有 11 个 td（第 1 个是复选框列）');
  assertEqual(stats.statusLabels, 3, '应有 3 个 .status-tag-label');
  console.log(`    两个 #root 的 class：${stats.rootClasses.join(' / ')}`);
});

await step('用户长路径选择器命中 0 行（复现「检查不到」）；类选择器命中 3 行', async () => {
  const diag = await sensecorePage.evaluate((userSelector) => {
    const parts = userSelector.split('>').map((part) => part.trim());
    const walk = [];
    for (let index = 1; index <= parts.length; index += 1) {
      const selector = parts.slice(0, index).join(' > ');
      let count = -1;
      try {
        count = document.querySelectorAll(selector).length;
      } catch {
        count = -1; // 语法错误
      }
      walk.push({ selector, count });
    }
    return {
      userRows: document.querySelectorAll(userSelector).length,
      classRows: document.querySelectorAll('.acp-list tr.sensed-table-row[data-row-key]').length,
      loosePathRows: document.querySelectorAll('#root table tbody tr').length,
      headerTablePathRows: document.querySelectorAll('.sensed-table-header table tbody tr').length,
      walk,
    };
  }, USER_LONG_ROW_SELECTOR);

  assertEqual(diag.userRows, 0, '用户原样长选择器应命中 0 行（复现失败）');
  assertEqual(diag.classRows, 3, '类选择器应命中 3 行');
  assertEqual(diag.loosePathRows, 3, '`#root table tbody tr` 应命中 3 行 → 证明表尾没问题，是中间位置链断了');
  assertEqual(diag.headerTablePathRows, 0, '锚到表头 table 时 `table tbody tr` 为 0（固定表头陷阱）');

  const firstZero = diag.walk.findIndex((item) => item.count === 0);
  assert(firstZero > 0, `应能用前缀逐段定位断点，实际：${JSON.stringify(diag.walk)}`);
  const broken = diag.walk[firstZero];
  const before = diag.walk[firstZero - 1];
  console.log(`    #root 前缀命中 ${diag.walk[0].count} 个（id 重复）`);
  console.log(`    断点：第 ${firstZero + 1} 段「${broken.selector}」命中 0；上一段「${before.selector}」命中 ${before.count}`);
  console.log('    → 位置链的中间段与当前 DOM 对不上（路径取自别的层 / 别的版本）；换成类锚点即可修好。');
});

await step('行内相对 CSS：第 1 列是复选框、第 2 列才是任务名、第 10 列要取 .status-tag-label', async () => {
  const row = await sensecorePage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.acp-list tr.sensed-table-row[data-row-key]'));
    const first = rows[0];
    return {
      checkboxText: first.querySelector('td:nth-child(1)')?.textContent.trim() ?? null,
      nameText: first.querySelector('td:nth-child(2)')?.textContent.trim() ?? null,
      statusLabelText: first.querySelector('td:nth-child(10) .status-tag-label')?.textContent.trim() ?? null,
      statusCellText: first.querySelector('td:nth-child(10)')?.textContent.trim() ?? null,
      statuses: rows.map((node) => node.querySelector('.status-tag-label')?.textContent.trim() ?? ''),
    };
  });

  assertEqual(row.checkboxText, '', '第 1 个 td 是复选框列，文本为空 —— 用户 keySelector 正是取了它');
  assertEqual(row.nameText, 'bert-finetune', '第 2 个 td 才是任务名');
  assertEqual(row.statusLabelText, '运行中', '第 10 个 td 里的 .status-tag-label 才是干净状态文本');
  assertEqual(row.statusCellText, '运行中1d2h', '直接取第 10 个 td 会被耗时污染（用户 statusSelector 就会得到 运行中1d2h）');
  assertEqual(row.statuses, ['运行中', '排队中', '成功'], '三行状态应各不相同');
});

await step('DOMParser + extractRows：推荐选择器 → ok:true / 3 行', async () => {
  const bySelector = await runRowsOnHtml(sensecorePage, sensecoreHtml, {
    rowSelector: '.acp-list tr.sensed-table-row[data-row-key]',
    keySelector: 'td:nth-child(2)',
    statusSelector: 'td:nth-child(10) .status-tag-label',
  });
  assertEqual(bySelector.ok, true, `提取应成功，实际 ${JSON.stringify(bySelector)}`);
  assertEqual(bySelector.count, 3, '行数应为 3');
  assertEqual(bySelector.statusMissing, 0, 'statusMissing 应为 0（状态都取到了）');
  assertEqual(bySelector.rows, [
    { key: 'bert-finetune', value: '运行中' },
    { key: 'gpt-pretrain', value: '排队中' },
    { key: 'llama-sft', value: '成功' },
  ], '行内容不对');

  const byAttr = await runRowsOnHtml(sensecorePage, sensecoreHtml, {
    rowSelector: '.acp-list tr.sensed-table-row[data-row-key]',
    keySelector: '',
    keyAttr: 'data-row-key',
    statusSelector: 'td:nth-child(10) .status-tag-label',
  });
  assertEqual(byAttr.ok, true, `keyAttr 写法应成功，实际 ${JSON.stringify(byAttr)}`);
  assertEqual(byAttr.rows.map((row) => row.key), ['train-bert', 'train-gpt', 'train-llama'], 'keyAttr 应取到 data-row-key');
});

await step('DOMParser + extractRows：用户原样选择器 → rows-empty（matched=0 / totalTr=4 / tbodyTr=3）', async () => {
  const result = await runRowsOnHtml(sensecorePage, sensecoreHtml, {
    rowSelector: USER_LONG_ROW_SELECTOR,
    keySelector: 'td:nth-child(1)',
    statusSelector: 'td:nth-child(10)',
  });
  assertEqual(result.ok, false, `应失败，实际 ${rowsFailure(result)}`);
  assertEqual(result.reason, 'rows-empty', `失败原因应为 rows-empty，实际 ${rowsFailure(result)}`);
  assertEqual(result.matched, 0, 'matched 应为 0（0 行命中）');
  assertEqual(result.totalTr, 4, 'totalTr 应为整页 <tr> 数量（表头 1 + 数据 3）');
  assertEqual(result.tbodyTr, 3, 'tbodyTr 应为表体行数 3');
  console.log(`    诊断：matched=${result.matched}，totalTr=${result.totalTr}，tbodyTr=${result.tbodyTr}`);
});

await step('DOMParser + extractRows：键列/状态列写错 → rows-key-empty / rows-status-empty', async () => {
  // 用户 keySelector=td:nth-child(1)（复选框列）→ 键全空 → rows-key-empty（带 11 格 sample）
  const keyWrong = await runRowsOnHtml(sensecorePage, sensecoreHtml, {
    rowSelector: '.acp-list tr.sensed-table-row[data-row-key]',
    keySelector: 'td:nth-child(1)',
    statusSelector: 'td:nth-child(10) .status-tag-label',
  });
  assertEqual(keyWrong.ok, false, `键列写错应失败，实际 ${rowsFailure(keyWrong)}`);
  assertEqual(keyWrong.reason, 'rows-key-empty', `原因应为 rows-key-empty，实际 ${rowsFailure(keyWrong)}`);
  assertEqual(keyWrong.matched, 3, 'rows-key-empty 的 matched 应为 3');
  assertEqual(keyWrong.keySelector, 'td:nth-child(1)', '诊断里应回显 keySelector');
  assertEqual(keyWrong.sample?.[0], '1.""', 'sample 第 1 格应是空复选框（1.""）');
  assertEqual(keyWrong.sample?.length, 11, 'sample 应含 11 个单元格');
  console.log(`    诊断：rows-key-empty（matched=${keyWrong.matched}，sample[0]=${keyWrong.sample?.[0]}）`);

  // 用户 statusSelector=td:nth-child(10)（带耗时）→ 能取到值但被耗时污染
  const polluted = await runRowsOnHtml(sensecorePage, sensecoreHtml, {
    rowSelector: '.acp-list tr.sensed-table-row[data-row-key]',
    keySelector: 'td:nth-child(2)',
    statusSelector: 'td:nth-child(10)',
  });
  assertEqual(polluted.ok, true, 'td:nth-child(10) 能取到文本（只是不干净）');
  assertEqual(polluted.rows[0].value, '运行中1d2h', '用户 statusSelector 得到的值会带耗时');

  // 状态列完全写错 → rows-status-empty（带 statusSelector 回显与 sample）
  const statusWrong = await runRowsOnHtml(sensecorePage, sensecoreHtml, {
    rowSelector: '.acp-list tr.sensed-table-row[data-row-key]',
    keySelector: 'td:nth-child(2)',
    statusSelector: 'td:nth-child(99)',
  });
  assertEqual(statusWrong.ok, false, `状态列写错应失败，实际 ${rowsFailure(statusWrong)}`);
  assertEqual(statusWrong.reason, 'rows-status-empty', `原因应为 rows-status-empty，实际 ${rowsFailure(statusWrong)}`);
  assertEqual(statusWrong.matched, 3, 'rows-status-empty 的 matched 应为 3');
  assertEqual(statusWrong.statusSelector, 'td:nth-child(99)', '诊断里应回显 statusSelector');
  assertEqual(statusWrong.sample?.length, 11, 'sample 应含 11 个单元格');
  console.log(`    诊断：rows-status-empty（matched=${statusWrong.matched}，statusSelector=${statusWrong.statusSelector}）`);
});

await step('SPA 空壳（direct 模式的抓取结果）→ 0 个 table，extractRows → rows-empty', async () => {
  const shell = await sensecorePage.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return {
      tables: doc.querySelectorAll('table').length,
      rows: doc.querySelectorAll('tr').length,
      rootIds: doc.querySelectorAll('#root').length,
      rootMasterIds: doc.querySelectorAll('#root-master').length,
      hasAcpList: Boolean(doc.querySelector('.acp-list')),
    };
  }, SENSECORE_SHELL_HTML);

  assertEqual(shell.tables, 0, 'SPA 空壳里不应有 table');
  assertEqual(shell.rows, 0, 'SPA 空壳里不应有 tr');
  assertEqual(shell.rootIds, 0, 'SPA 空壳里连 #root 都没有（只有一个空的 #root-master）');
  assertEqual(shell.rootMasterIds, 1, 'SPA 空壳只应有 #root-master 挂载点');
  assertEqual(shell.hasAcpList, false, 'SPA 空壳里没有 .acp-list');

  const result = await runRowsOnHtml(sensecorePage, SENSECORE_SHELL_HTML, {
    rowSelector: '.acp-list tr.sensed-table-row[data-row-key]',
    keySelector: 'td:nth-child(2)',
    statusSelector: 'td:nth-child(10) .status-tag-label',
  });
  assertEqual(result.ok, false, `空壳应失败，实际 ${rowsFailure(result)}`);
  assertEqual(result.reason, 'rows-empty', `空壳失败原因应为 rows-empty，实际 ${rowsFailure(result)}`);
  assertEqual(result.matched, 0, '空壳 matched 应为 0');
  assertEqual(result.totalTr, 0, '空壳 totalTr 应为 0');
  assertEqual(result.tbodyTr, 0, '空壳 tbodyTr 应为 0');
});

// detectTables 在「表头/表体拆两张 table」+「状态单元格含耗时」的真实结构上的表现
const sensecoreCleanPage = await openFixturePage('/sensecore-harness-clean');

await step('detectTables：真实结构（分离表头 + 状态带耗时）也能定位第 10 列', async () => {
  const onReal = await sensecorePage.evaluate(detectTables);
  const onClean = await sensecoreCleanPage.evaluate(detectTables);

  for (const [label, result] of [['真实结构', onReal], ['无耗时对照', onClean]]) {
    assert(result.candidates.length > 0, `${label}应识别出候选表格，实际 ${JSON.stringify(result)}`);
    const best = result.candidates[0];
    assert(
      best.statusSelector === 'td:nth-child(10)' || best.statusSelector.startsWith('td:nth-child(10) '),
      `${label}的状态列应是第 10 列（含复选框列后 index=9），实际 ${best.statusSelector}`,
    );
    // 带耗时的那份应自动下沉到内部状态标签，避免「运行中1d2h」这种值一直变
    if (label === '真实结构') {
      assert(
        best.statusSelector.includes('status-tag-label'),
        `真实结构应下沉到 .status-tag-label，实际 ${best.statusSelector}`,
      );
    } else {
      assertEqual(best.statusSelector, 'td:nth-child(10)', `${label}没有耗时时可只取第 10 列`);
    }
    assertEqual(best.keySelector, 'td:nth-child(2)', `${label}的键列应是第 2 列任务名（跳过复选框列）`);
    assert(best.rowSelector.includes('tbody tr'), `${label}的行选择器应包含 tbody tr，实际 ${best.rowSelector}`);
    assertEqual(best.rowCount, 3, `${label} 应识别 3 行`);
    assertEqual(best.samples.map((sample) => sample.value), ['运行中', '排队中', '成功'], `${label}的状态取值不对`);
    assertEqual(best.samples.map((sample) => sample.key), ['bert-finetune', 'gpt-pretrain', 'llama-sft'], `${label}的键取值不对`);
    console.log(`    ${label}：rowSelector=${best.rowSelector}`);
    console.log(`    ${label}：keySelector=${best.keySelector}，statusSelector=${best.statusSelector}，note=${best.note || '（空）'}`);
  }

  // 生成的路径必须真的能命中（两个 #root 下也能定位）
  const realMatched = await sensecorePage.evaluate(
    (selector) => document.querySelectorAll(selector).length,
    onReal.candidates[0].rowSelector,
  );
  assertEqual(realMatched, 3, '真实结构：detectTables 生成的 rowSelector 应命中 3 行');
  const cleanMatched = await sensecoreCleanPage.evaluate(
    (selector) => document.querySelectorAll(selector).length,
    onClean.candidates[0].rowSelector,
  );
  assertEqual(cleanMatched, 3, '对照结构：detectTables 生成的 rowSelector 应命中 3 行');

  // 新增的 stats 诊断：表数 / tr 数 / #root 数
  if (onReal.stats) {
    assertEqual(onReal.stats.roots, 2, 'stats.roots 应为 2（两个 #root）');
    assertEqual(onReal.stats.tables, 2, 'stats.tables 应为 2（表头表 + 表体表）');
    assertEqual(onReal.stats.trs, 4, 'stats.trs 应为 4（1 表头 + 3 数据）');
    console.log(`    stats：${JSON.stringify(onReal.stats)}`);
  }
});

await Promise.all([sensecorePage.close(), sensecoreCleanPage.close()]);

await page.close();

// ---------------------------------------------------------------------------
// Phase 2：真实扩展全链路（可能被 Chrome 策略屏蔽）
// ---------------------------------------------------------------------------

console.log('\nPhase 2：扩展全链路');

async function tryLoadExtension() {
  if (typeof browser.installExtension !== 'function') {
    return { skip: '当前 puppeteer 版本没有 installExtension，且 Chrome 137+ 已移除 --load-extension' };
  }
  const extensionId = await browser.installExtension(ROOT);

  const client = await browser.target().createCDPSession();
  await client.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/src/options.html`,
  });
  const target = await browser.waitForTarget(
    (item) => item.url().includes('/src/options.html'),
    { timeout: 10_000 },
  );
  const optionsPage = await target.page();
  const blocked = await optionsPage.evaluate(() => document.body.innerText.includes('已被 Chrome 屏蔽'));
  if (blocked) {
    return { skip: `Chrome ${await browser.version()} 屏蔽了自动化打开 chrome-extension:// 页面（ERR_BLOCKED_BY_CLIENT）` };
  }
  return { optionsPage, extensionId };
}

const loaded = await tryLoadExtension();

if (loaded.skip) {
  skipped += 1;
  console.log(`  ⚠ SKIP：${loaded.skip}`);
  console.log('    → 扩展全链路未在本机 Chrome 验证；请手工执行 README「安装扩展」后用「测试发送」自检。');
} else {
  const { optionsPage } = loaded;
  const call = (message) => optionsPage.evaluate((payload) => new Promise((resolveCall, rejectCall) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) rejectCall(new Error(lastError.message));
      else resolveCall(response);
    });
  }), message);

  await step('设置页可打开且脚本已加载', async () => {
    assert(await optionsPage.$('#save-settings'), '设置页缺少 #save-settings');
  });

  await step('保存设置与监控项', async () => {
    const saved = await call({
      type: 'save-settings',
      settings: { dshBaseUrl: base, botId: 'bot_e2e', targetId: 'e2e-target', localFallback: false },
    });
    assert(saved?.ok === true, `保存设置失败：${saved?.error}`);
    const watch = await call({
      type: 'save-watch',
      watch: {
        name: 'E2E 页面',
        url: `${base}/page`,
        mode: 'direct',
        selectorType: 'css',
        selector: '#content',
        valueKind: 'text',
        intervalMinutes: 0.5,
      },
    });
    assert(watch?.ok === true, `保存监控项失败：${watch?.error}`);
  });

  await step('首次检查：fetch + 离屏 DOMParser 建立基线', async () => {
    const response = await call({ type: 'run-check' });
    const [result] = response.results ?? [];
    assert(result && result.error === undefined, `检查失败：${JSON.stringify(result)}`);
    assert(result.changed === false, `首次不应报变化：${JSON.stringify(result)}`);
    assertEqual(result.valuePreview, '第一版内容', '提取值不对');
  });

  await step('内容变化 → 真实 POST 到 DSH 接口', async () => {
    world.pageValue = '第二版内容（已变化）';
    const response = await call({ type: 'run-check' });
    const [result] = response.results ?? [];
    assert(result.changed === true && result.notified === true, `未触发提醒：${JSON.stringify(result)}`);
    assertEqual(world.deliveries.length, 1, '投递次数不对');
    const sent = world.deliveries[0];
    assert(sent.text.includes('【内容变更】E2E 页面'), '消息标题不对');
    assert(sent.text.includes('变更前：第一版内容'), '缺少变更前');
    assert(sent.text.includes('变更后：第二版内容（已变化）'), '缺少变更后');
    assertEqual([sent.botId, sent.targetId], ['bot_e2e', 'e2e-target'], '调用参数不对');
  });

  await step('清理监控项', async () => {
    const state = await call({ type: 'get-state' });
    for (const watch of state.watches) await call({ type: 'delete-watch', id: watch.id });
    const after = await call({ type: 'get-state' });
    assertEqual(after.watches.length, 0, '未清理干净');
  });
}

await browser.close().catch(() => {});
server.close();
await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});

console.log(`\n结果：${passed} 通过，${failures.length} 失败，${skipped} SKIP`);
if (failures.length > 0) process.exitCode = 1;
