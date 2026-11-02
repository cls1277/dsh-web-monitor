# 选择器排错：SenseCore 任务列表「检查不到」怎么修

> 适用对象：在扩展里监控 `https://console.sensecore.cn/cn-sh-01/acp/list?workspace=...` 的「状态」列。
> 本文结论来自两路证据：
> 1. 对真实站点**公开前端 bundle 的静态分析**（详见 [sensecore-dom-research.md](sensecore-dom-research.md)）；
> 2. `tools/browser-e2e.mjs` 新增的 **SenseCore 仿真页（Phase 1b）**——在真实 Chrome 里复现「两个 `#root` + 固定表头双 table + 11 列 + 状态格带耗时」的结构，逐条断言（脚本会打印每条证据）。
>
> 一句话结论：**你那条 `#root > div > …` 的位置长路径在本页不可靠（实测命中 0 行，断在第 6 段）；再加上 key/status 两个选择器各取错了一列。** 换成类选择器即可：

```json
{
  "mode": "tab",
  "extractMode": "rows",
  "rowSelector": ".acp-list tr.sensed-table-row[data-row-key]",
  "keySelector": "",
  "keyAttr": "data-row-key",
  "statusSelector": "td:nth-child(10) .status-tag-label",
  "statusAttr": "",
  "waitForSelector": ".acp-list tr.sensed-table-row",
  "settleMs": 2500,
  "rowsNotifyAdded": true,
  "rowsNotifyRemoved": false,
  "onlyStatuses": "排队中,运行中,成功,失败,已停止,限额中",
  "intervalMinutes": 5
}
```

---

## 1. 结论：三个候选原因，哪个是主因？

按「是否会导致 0 行」和证据强度排序：

| 排序 | 原因 | 会不会导致「检查不到」 | 实测证据 |
| --- | --- | --- | --- |
| **1（主因候选）** | **抓取方式还是 `direct`**：SPA 未登录/直接 fetch 只能拿到 1 个 HTML 外壳，DOM 里**根本没有 table** | **一定 0 行** | 真实站点直接抓：外壳仅 **1 363 字节**、`<table>` 数量 **0**（sensecore-dom-research.md 第 1 节）；仿真空壳断言：`tables=0 / tr=0 / #root=0`，`extractRows` → `rows-empty` |
| **2（主因候选）** | **`#root > …` 位置长路径失效**：本页有 **两个 `id="root"`**（区域子应用 + ACP 子应用），长路径里的 `:nth-of-type` 层级与当前实际 DOM 对不上 | **0 行** | 仿真页里 `#root` 命中 **2 个**；用户原样长选择器命中 **0 行**；前缀逐段定位：**第 6 段 `div:nth-of-type(4)` 断掉**（上一段还命中 1）；同页 `.acp-list tr.sensed-table-row[data-row-key]` 命中 **3 行** |
| 3 | **固定表头 / 列序**：`scroll.y` 把 thead 与 tbody 拆进两张 `<table>`；每行 11 个 td（第 1 个是复选框） | 锚到表头那张 table 时 `table tbody tr` = **0 行**；行能匹配时不会 0 行，但**值会错** | 表头表 `tbody tr` = **0**、表体表 = **3**；`td:nth-child(1)` 文本为空（复选框）、`td:nth-child(10)` 整格 = `运行中1d2h`（带耗时） |

**判定**：
- 如果扩展里配的是 **`direct` 模式** → 先改 `tab` 模式，这是最省事、最可能一击修好的。
- 如果已经是 `tab` 模式还不行 → 你的 `rowSelector` 属于「位置长链失效」（原因 2）：因为本页有两个 `#root`，DevTools「Copy selector」复制出的路径会随**复制时命中的那层/页面版本/加载状态**变化，一旦 DOM 多一层少一层就整体失配。改类锚点即可。
- 原因 3 一般不会让你「一行都看不到」，但会让你「看到行了、状态却是 `运行中1d2h`」或「键是空的（取到了复选框列）」——这三个选择器要一起改。

> 补充：`#root` 重复本身**不会**让一个正确的路径失效（CSS 的 `#root` 会同时匹配两个元素，只要路径描述的是表格所在的子树就能命中）。真正的问题是**路径描述的不是当前那棵子树**。下面的自检脚本会直接告诉你断在第几段。

---

## 2. 三个原因逐个拆：现象 → 如何确认 → 怎么改

### 原因 1：抓取方式是 `direct`，只拿到 SPA 空壳

- **现象**：预览/检查结果永远是「没有提取到任何任务行」（`rows-empty`）；扩展的本地通知也从不触发。
- **如何确认**（任选其一）：
  1. 看扩展里这条监控的「抓取方式」是不是 `direct`；
  2. 打开 `view-source:` 或直接访问 `https://console.sensecore.cn/cn-sh-01/acp/list?workspace=...`，未登录时 HTML 只有 `<div id="root-master"></div>` + 几个 `umi.*.js`，**一个 `<table>` 都没有**（真实外壳 1 363 字节）；
  3. 用第 4 节的 Console 自检脚本看 `table 数量`：等于 **0** 就是这个原因。
- **怎么改**：
  - `mode` 改成 **`tab`**（扩展会打开/复用一个真实标签页，等页面渲染完再抓）；
  - `waitForSelector` 填 `.acp-list tr.sensed-table-row`（最多等 25 秒）；
  - `settleMs` ≥ 2000（三层微前端 + 表格异步加载，首屏比普通页面慢）；
  - 该标签页必须保持**已登录**状态。

### 原因 2：`#root > …` 位置长路径失效（本页有两个 `#root`）

- **现象**：`tab` 模式、页面明明是登录的、肉眼能看到任务列表，但 `rowSelector` 命中 0 行；把 `rowSelector` 换成 `.acp-list tr.sensed-table-row[data-row-key]` 立刻能出 3 行。
- **如何确认**：
  1. Console 自检脚本会打印 `#root 数量`（本页是 2）；
  2. 脚本会把你的长选择器**逐段前缀**跑一遍，哪一段从 N 变成 0，断点就在那（仿真页实测断在第 6 段）；
  3. 同一个脚本里 `.acp-list` 版本命中 >0，而你的选择器 0，即可确诊。
- **怎么改**：不要把 DevTools「Copy selector」的长路径粘进扩展，改用稳定类锚点：
  - 行：`.acp-list tr.sensed-table-row[data-row-key]`
  - 键：`keySelector` 留空 + `keyAttr = data-row-key`（取行属性 `data-row-key`，就是任务 name）
  - 状态：`td:nth-child(10) .status-tag-label`
- **为什么 `#root` 长路径天生不可靠**：本页是三层 qiankun 微前端（主应用 → 区域子应用 `core-cn-sh-01-app` → ACP 子应用 `core-acpv2-app`），区域子应用和 ACP 子应用的 HTML 外壳里各有一个 `<div id="root">`；长路径里大量 `div:nth-of-type(n)` 是「按当时那层 DOM 的兄弟顺序」写死的，多一个横幅/加载占位/版本改版都会整体失配。

### 原因 3：固定表头双 table + 列序（不会让你 0 行，但会让值错；锚到表头表时会 0 行）

- **现象**：
  - 状态值变成 `运行中1d2h` / `成功2h` 这种「状态+耗时」串；
  - 或者键全为空 → 新版 extractRows 会返回 **`rows-key-empty`**（因为 `td:nth-child(1)` 是复选框列）；
  - 或者你把选择器锚到了**表头那张 table**（`... > table tbody tr` 落在只有 thead 的 table 上）→ 0 行。
- **如何确认**：
  - 自检脚本里看「首行 td 数」（应为 11）、「首行第 1 格文本」（空=复选框）、「首行第 10 格整格文本」（带耗时）；
  - 看「table 明细」：会有两张 table，其中一张 `thead行=1, tbody行=0`（表头表），另一张 `tbody行=3`（表体表）。
- **怎么改**：
  - 状态必须取 **`.status-tag-label`** 而不是整个 td：`td:nth-child(10) .status-tag-label`；
  - 键不要用 `td:nth-child(1)`：用 `keyAttr = data-row-key`（最稳）或 `td:nth-child(2)`；
  - 备选（列数变了也能活）：`statusSelector = ".status-tag-label"`（主列表每行只有一个状态标签；风险是以后新增别的标签列时会取错）。

---

## 3. 你现在这三个选择器，分别错在哪

| 字段 | 你现在填的 | 实测结果 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| `rowSelector` | `#root > div > div:nth-of-type(2) > … > table tbody tr` | 命中 **0 行**（仿真页），断在第 6 段 `div:nth-of-type(4)` | 位置长链 + 两个 `#root`，与当前 DOM 不符 | `.acp-list tr.sensed-table-row[data-row-key]` |
| `keySelector` | `td:nth-child(1)` | 该格文本为 **空**（复选框列） | 取到了复选框；新版 extractRows 直接报 `rows-key-empty` | `keySelector` 留空 + `keyAttr: "data-row-key"`（或 `td:nth-child(2)`） |
| `statusSelector` | `td:nth-child(10)` | 文本 = `运行中1d2h`（标签 + 耗时） | 没取到 `.status-tag-label`，状态被耗时污染 | `td:nth-child(10) .status-tag-label` |
| `mode` | （未知，若为 `direct`） | 真实站点 direct 抓取 = 1 363 B 空壳、0 张表 | SPA 不执行 JS 就没有 DOM | `tab` + `waitForSelector` + `settleMs ≥ 2000` |

---

## 4. 现场自检脚本（粘到目标页 DevTools Console）

在**已登录、任务列表已加载**的 `console.sensecore.cn/cn-sh-01/acp/list?workspace=...` 页面打开 DevTools → Console，把下面整段粘进去（第一行 `USER_ROW_SELECTOR` 换成你在扩展里填的那条 `rowSelector`；留空则只做类选择器检查）：

```js
(() => {
  const USER_ROW_SELECTOR = ''; // ← 把扩展里的 rowSelector 粘这里，例如 '#root > div > div:nth-of-type(2) > ...'
  const norm = (v) => String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const q = (selector, root = document) => {
    try { return [...root.querySelectorAll(selector)]; } catch { return []; }
  };

  const roots = q('#root');
  const tables = q('table');
  const allTr = q('tr');
  const dataRowsGlobal = q('tr.sensed-table-row[data-row-key]');
  const dataRowsInList = q('.acp-list tr.sensed-table-row[data-row-key]');
  const userRows = USER_ROW_SELECTOR ? q(USER_ROW_SELECTOR) : [];
  const labels = q('.status-tag-label');
  const firstRow = userRows[0] ?? dataRowsInList[0] ?? dataRowsGlobal[0] ?? null;
  const cells = firstRow ? [...firstRow.children] : [];

  const prefixWalk = [];
  if (USER_ROW_SELECTOR) {
    const parts = USER_ROW_SELECTOR.split('>').map((part) => part.trim());
    for (let index = 1; index <= parts.length; index += 1) {
      const selector = parts.slice(0, index).join(' > ');
      prefixWalk.push({ 段: index, 命中: q(selector).length, 选择器: selector });
    }
  }

  const report = {
    '#root 数量': roots.length,
    '每个 #root': roots.map((root, index) => ({
      序号: index + 1,
      class: root.className,
      含_acp_list: Boolean(root.querySelector('.acp-list')),
      含表格数: root.querySelectorAll('table').length,
    })),
    'table 数量': tables.length,
    'table 明细': tables.map((table, index) => ({
      序号: index + 1,
      thead行: table.querySelectorAll('thead tr').length,
      tbody行: table.querySelectorAll('tbody tr').length,
      表格内tr: table.querySelectorAll('tr').length,
    })),
    'tr 总数': allTr.length,
    '数据行(全局 tr.sensed-table-row)': dataRowsGlobal.length,
    '数据行(.acp-list 内)': dataRowsInList.length,
    '你的 rowSelector 命中': USER_ROW_SELECTOR ? userRows.length : '(未填)',
    '.status-tag-label 数量': labels.length,
    '首行 td 数': cells.length,
    '首行各格文本': cells.map((cell, index) => `${index + 1}. ${norm(cell.textContent).slice(0, 24)}`),
    '首行状态标签': firstRow ? norm(firstRow.querySelector('.status-tag-label')?.textContent) : null,
    '首行第10格整格文本': cells[9] ? norm(cells[9].textContent) : null,
    '首行第1格文本': cells[0] ? norm(cells[0].textContent) : null,
  };

  console.log('—— SenseCore 选择器自检 ——');
  console.table(report['每个 #root']);
  console.table(report['table 明细']);
  console.log(JSON.stringify(report, null, 2));
  if (prefixWalk.length) console.table(prefixWalk);

  const verdict = [];
  if (tables.length === 0) {
    verdict.push('❌ 页面里没有 <table>：① direct 模式只拿到 SPA 空壳；或页面未加载完 / 被踢到登录页。→ 改 tab 模式 + waitForSelector=.acp-list tr.sensed-table-row，settleMs≥2000');
  }
  if (roots.length > 1) {
    verdict.push(`⚠ document 里有 ${roots.length} 个 #root：任何以 #root 开头的位置长路径都不可靠 → 用 .acp-list / tr.sensed-table-row[data-row-key] 锚点`);
  }
  if (USER_ROW_SELECTOR && userRows.length === 0 && dataRowsInList.length > 0) {
    verdict.push(`❌ 你的 rowSelector 命中 0 行，但 .acp-list 类选择器命中 ${dataRowsInList.length} 行 → 位置路径失效，改用 .acp-list tr.sensed-table-row[data-row-key]`);
    const broken = prefixWalk.find((item) => item.命中 === 0);
    if (broken) verdict.push(`   断点：第 ${broken.段} 段「${broken.选择器}」已命中 0`);
  }
  if (dataRowsInList.length === 0 && tables.length > 0) {
    verdict.push('❌ 有表格但没有 tr.sensed-table-row[data-row-key]：行结构变了/数据还没加载，等出现数据后再跑一次');
  }
  if (dataRowsInList.length > 0 && labels.length === 0) {
    verdict.push('❌ 行匹配到了，但 .status-tag-label 为 0：列序或状态选择器不对（改版后 status 不再在第 10 列）');
  }
  if (labels.length > 0) {
    verdict.push(`✅ 找到 ${labels.length} 个状态标签 → 推荐 statusSelector = "td:nth-child(10) .status-tag-label"`);
  }
  if (cells.length > 0 && cells.length !== 11) {
    verdict.push(`⚠ 首行有 ${cells.length} 个 td（之前是 11）→ 列序变了：改用 statusSelector=".status-tag-label"（不依赖列号）`);
  }
  if (cells[0] && norm(cells[0].textContent) === '') {
    verdict.push('⚠ 第 1 个 td 是复选框（文本为空）→ keySelector 不能写 td:nth-child(1)：用 keyAttr="data-row-key" 或 td:nth-child(2)');
  }
  if (cells[9] && norm(cells[9].textContent) !== norm(cells[9].querySelector('.status-tag-label')?.textContent)) {
    verdict.push('⚠ 第 10 格整格文本带耗时（如 运行中1d2h）→ 状态必须取 .status-tag-label');
  }
  console.log('\n—— 判定 ——');
  verdict.forEach((line) => console.log(line));
  return report;
})();
```

### 判定表（把脚本输出对照着看）

| 脚本输出 | 结论 | 处理 |
| --- | --- | --- |
| `table 数量 = 0` | 原因 1（direct/未加载/登录页） | 改 `tab` 模式；`waitForSelector` + `settleMs`；确认登录 |
| `#root 数量 = 2` 且 `你的 rowSelector 命中 = 0`、`数据行(.acp-list 内) > 0` | 原因 2（位置路径失效） | 换 `.acp-list tr.sensed-table-row[data-row-key]` |
| `table 明细` 中一张 `thead行=1, tbody行=0`、另一张 `tbody行>0` | 原因 3：固定表头双 table（正常现象，别锚错表） | 行选择器里不要出现「表头表」的路径；用类选择器 |
| `首行 td 数 = 11`、`首行第1格文本 = 空` | 第 1 列是复选框 | `keyAttr="data-row-key"`（或 `td:nth-child(2)`），不要 `td:nth-child(1)` |
| `首行第10格整格文本 = 运行中1d2h` | 状态必须取标签 | `td:nth-child(10) .status-tag-label` |
| `首行 td 数 ≠ 11`，但 `.status-tag-label > 0` | 列序变了 | `statusSelector = ".status-tag-label"` |
| `table 数量 > 0`、`数据行(.acp-list 内) = 0`、`tr 总数` 也少 | 页面还没渲染出表格数据 | 提高 `settleMs`/等待选择器，或换更靠后的时机 |

---

## 5. 推荐选择器与风险

| 角色 | 推荐值 | 可信度 | 风险 |
| --- | --- | --- | --- |
| `rowSelector` | `.acp-list tr.sensed-table-row[data-row-key]` | 高 | 依赖 `.acp-list`/`sensed-table-row` 两个类名（跨构建稳定，但如果未来改组件库会变） |
| `keySelector` + `keyAttr` | `""` + `data-row-key` | 高 | 依赖 `rowKey="name"`；若某行缺 `data-row-key` 会退化成整行文本 |
| `statusSelector` | `td:nth-child(10) .status-tag-label` | 中高 | 依赖「11 列/状态在第 10 列」；数量变了就失效 |
| 备选状态 | `.status-tag-label`（行内） | 中 | 不依赖列序；若以后一行出现多个状态标签会取错第一个 |
| 备选状态（不推荐） | `td:nth-child(10)` | 低 | 值会带耗时（`运行中1d2h`） |
| `mode` | `tab` | — | 必须有已登录标签页 |

**别用**：`#root` 开头的长路径、`#root`（本页不唯一）、`table.sensed-table`（grid 根是 `div.sensed-table`，不是 `table`）、`.ant-table-*`（本站前缀是 `sensed-`）、`xxx___hash` 这类 CSS Modules 名。

---

## 6. `detectTables`（扩展的「自动探测」）在这个页面上表现如何

用真实的 `src/detect.js` 在仿真页 DOM 上跑（Node 自检，见第 7 节）：

```text
candidates = 2
best: rowSelector   = #root > div > div:nth-of-type(3) > div > div > div > div:nth-of-type(2) > table tbody tr
      keySelector   = td:nth-child(2)
      statusSelector= td:nth-child(10)
      rowCount      = 3
      samples       = [{bert-finetune, 运行中}, {gpt-pretrain, 排队中}, {llama-sft, 成功}]
```

结论：
- **能识别**：即使表头与表体分属两张 `<table>`，`detectTables` 会跨表对齐表头（`thead tr` 对齐列数），所以「状态」表头被正确识别为第 10 列；
- **键列正确**：表头「显示名称/名称」命中，`keySelector = td:nth-child(2)`（跳过了复选框列）；
- **生成的 `rowSelector` 能真的命中**（在两个 `#root` 下命中 3 行）——自动探测的输出可以直接用，但它是**位置路径**，改版可能失效；
- 新增 `stats`（表数/tr 数/`#root` 数）可用于排查「0 候选 / 登录页 / 空壳」。

所以：**优先点扩展的「自动探测」，再按第 4 节的脚本复核**；如果探测不出来，多半就是原因 1（空壳/未加载）而不是探测器本身的问题。

---

## 7. 证据与复现

### 7.1 `tools/browser-e2e.mjs` 新增的 Phase 1b（真实 Chrome，需 danger-full-access）

| 断言 | 证据 |
| --- | --- |
| 仿真页有 **2 个 `#root`**、2 张 table（表头表 tbody=0 / 表体表 tbody=3）、11 个 th、每行 11 个 td、3 个 `.status-tag-label` | 结构用例 |
| 用户原样长选择器命中 **0 行**；`.acp-list …` 命中 **3 行**；`#root table tbody tr` 命中 **3 行**；表头表路径 **0 行** | 选择器用例 |
| 前缀逐段定位断点（第 6 段），打印断点选择器与上一段命中数 | 同上 |
| 行内相对 CSS：`td:nth-child(1)` 空（复选框）、`td:nth-child(2)`=任务名、`td:nth-child(10) .status-tag-label`=`运行中`、`td:nth-child(10)`=`运行中1d2h` | 单元格用例 |
| `extractRows` 推荐选择器 → `ok:true, count:3, statusMissing:0`；`keyAttr=data-row-key` → 键为 `train-bert/train-gpt/train-llama` | 提取用例 |
| 用户选择器 → `rows-empty, matched:0, totalTr:4, tbodyTr:3`；`keySelector=td1` → `rows-key-empty, matched:3, sample:["1.\"\"",…]`；`statusSelector=td99` → `rows-status-empty, matched:3` | 失败语义用例 |
| SPA 空壳 → `tables=0, tr=0, #root=0`，`extractRows` → `rows-empty, matched:0, totalTr:0, tbodyTr:0` | direct 模式用例 |
| `detectTables` 真实/对照结构均 ≥1 候选，`statusSelector=td:nth-child(10)`、`keySelector=td:nth-child(2)`、`rowCount=3`、生成的 rowSelector 命中 3 行、`stats={tables:2,trs:4,roots:2}` | 探测用例 |

运行方式（**必须在允许启动 Chrome 的环境**，本仓库的 Lead 用 danger-full-access 跑）：

```bash
node tools/browser-e2e.mjs            # 无头
HEADFUL=1 node tools/browser-e2e.mjs  # 有头，方便肉眼看仿真页
```

### 7.2 本机沙箱限制的说明

写这份文档时，执行环境**不允许 puppeteer 启动 Chrome**（`spawn EPERM`），所以浏览器用例本身由 Lead 执行；本文用**同一套 fixture 生成代码 + 真实 `src/extract.js` / `src/detect.js` + 一个极简 DOM 垫片**在 Node 里做了 12 项自检，结果全部通过：

```text
✓ 两个 #root、两张 table、11 th、每行 11 td
✓ 用户长路径 0 行；类选择器 3 行；#root table tbody tr 3 行；表头路径 0 行
✓ 前缀逐段定位断点（第 6 段：div:nth-of-type(4)）
✓ td1 空 / td2=任务名 / td10 标签干净 / td10 整格带耗时
✓ extractRows：推荐选择器 → 3 行
✓ extractRows：keyAttr=data-row-key → train-bert/train-gpt/train-llama
✓ extractRows：用户选择器 → rows-empty（matched=0, totalTr=4, tbodyTr=3）
✓ extractRows：keySelector=td1 → rows-key-empty（matched=3）
✓ extractRows：statusSelector=td10 → 值带耗时；td99 → rows-status-empty（matched=3）
✓ detectTables：真实结构（带耗时）识别 3 行，status=td:nth-child(10)，key=td:nth-child(2)
✓ detectTables：无耗时对照同样识别
✓ SPA 空壳：0 table / 0 tr / 0 #root
```

---

## 8. 附：仿真页结构（为什么它能代表真实页面）

```
body
└─ div#root.region-root                     ← 第 1 个 #root（区域子应用，只有布局/导航）
   └─ div.sensed-layout
      ├─ div.sensed-layout-sider
      └─ div.sensed-layout-content
         └─ div.qiankun-container[data-micro-app="core-acpv2-app"]
            └─ div#root.acp-root             ← 第 2 个 #root（ACP 子应用）
               └─ div.acp-list.page-container
                  ├─ div.list-header / div.toolbar
                  └─ div.sensed-table
                     └─ div.sensed-table-container
                        ├─ div.sensed-table-header > table > thead > tr > 11 th   ← 只有表头
                        └─ div.sensed-table-body   > table > tbody
                           └─ tr.sensed-table-row.sensed-table-row-level-0[data-row-key="train-bert"]
                              └─ 11 个 td（td1 复选框；td2 任务名；td10 状态标签 + .acp-list-time；td11 操作）
```

关键点：**用户的长路径写的是「第 1 个 `#root` 往下」的层级**，而表格实际在「第 2 个 `#root`」的子树里且层级更浅/不同；第 6 段 `div:nth-of-type(4)` 先断，于是整体 0 命中。
（对应真实页面：`/micro/cn-sh-01/main/` 的区域子应用里再挂载 `/micro/cn-sh-01/acp/` 的 ACP 子应用，两块 UMI 外壳各有一个 `<div id="root">`。）

---

## 9. 未确认 / 限制

1. 本文的浏览器级断言写在 `tools/browser-e2e.mjs` 里，**我这边的沙箱没能启动 Chrome**，需 Lead 跑一次把 Phase 1b 跑绿（预期全绿）；Node 侧等价自检已全绿。
2. 仿真页与真实页的 DOM 是「按静态分析还原」的，真实页若比它多/少包裹层，前缀断点会移动（这是为什么我们建议用类选择器，而不是修那条长路径）。
3. 真实页面语言是中文时的状态文案为 `运行中/排队中/成功/...`；若用户界面切到英文，`onlyStatuses` 需换成英文（`Running/Queueing/Succeeded/...`）。
4. 若某天站点改成虚拟滚动（`sensed-table-tbody-virtual`）或去掉 `sensed-table-row` 类，推荐选择器会失效——先用第 4 节脚本复核，再回到 [sensecore-dom-research.md](sensecore-dom-research.md) 第 12 节重新分析 bundle。
