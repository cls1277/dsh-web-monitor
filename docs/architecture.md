# 网页内容监控 → DSH-IM 微信提醒 · 架构与接口契约

本文件是扩展各文件之间的**唯一契约**。任何实现都必须严格按此处的存储键、数据结构、
消息协议和文案模板编写，不要私自改名或加减字段。

## 1. 数据流

```
chrome.alarms(sweep) ──► background.js 逐个处理到期的 watch
        │
        ├─ mode=direct : fetch(url)            ─► HTML 文本
        └─ mode=tab    : 后台标签页 outerHTML   ─► HTML 文本
                        │
                        ▼
             offscreen.html(DOMParser) ──► { ok, value, reason }
                        │
                 compare hash(旧值) vs hash(新值)
                        │ 变化
                        ▼
        POST {DSH}/api/dsh-im/delivery/messages  { botId, targetId, text }
                        │ 成功/失败
                        ▼
             chrome.storage.local(runtime) + 可选 chrome.notifications
```

## 2. 目录结构

```
manifest.json
src/
  background.js     # Service Worker（type: module）—— 唯一调度与投递者
  extract.js        # 纯函数：normalizeValue / extractValue / hashValue / 消息文案
  offscreen.html    # 离屏文档，仅用于 DOMParser 解析
  offscreen.js      # 接收 {type:'offscreen/parse'} 请求并返回提取结果
  options.html/js/css
  popup.html/js/css
docs/
  architecture.md    # 本文件
  dsh-im-delivery.md # 投递接口实测与配置步骤
tools/
  selftest.mjs        # 纯函数 + 工程完整性自测
  integration.mjs     # mock chrome.* + 本地 HTTP，跑通后台全链路
  browser-e2e.mjs     # 真实 Chrome：DOMParser 提取（必跑）+ 扩展全链路（尽力而为）
  probe-delivery.mjs  # DSH 投递接口探测
  make-icons.py       # 生成 16/32/48/128 图标
icons/ 16/32/48/128.png
```

## 3. chrome.storage.local 键

### 3.1 `settings`

```js
{
  dshBaseUrl: 'http://127.0.0.1:52020', // 不带结尾斜杠；UI 保存时也要裁掉
  botId: '',                            // 形如 wx_xxx / bot_xxx，从 DSH 设置页复制
  targetId: '',                         // 形如 tgt_xxx / release-alerts
  localFallback: true,                  // DSH 投递失败时是否同时发本地浏览器通知
  quiet: false,                         // true 时不发本地通知，仅投递
  silentTabs: true                      // true=在一个最小化的隐藏窗口里常驻抓取标签页（不闪标签页）
}
```

### 3.2 `watches`

`watch` 对象：

```js
{
  id: 'w_lkj3h2a9',            // 生成规则：'w_' + Date.now().toString(36) + 随机4位
  name: '某某公告页',
  url: 'https://example.com/notice',
  enabled: true,
  mode: 'direct',              // 'direct' | 'tab'
  extractMode: 'single',       // 'single'（单值）| 'rows'（列表逐行对比，新增）

  // ---- single 模式字段 ----
  selectorType: 'css',         // 'css' | 'xpath'
  selector: '#notice .title',  // single 模式必填
  valueKind: 'text',           // 'text' | 'html' | 'attr'
  attrName: '',                // valueKind==='attr' 时必须非空

  // ---- rows 模式字段（只支持 CSS，配合 mode:'tab' 使用最稳）----
  rowSelector: 'table tbody tr',        // rows 模式必填：一行一个任务
  keySelector: 'td:nth-child(1)',       // 行内相对选择器：行键（任务名/ID）；留空=整行文本
  statusSelector: 'td:nth-child(5)',    // 行内相对选择器：状态；必填
  keyAttr: '',                          // 可选：从属性取，如 'data-job-id'
  statusAttr: '',                       // 可选：从属性取，如 'title'
  rowsNotifyAdded: true,                // 新出现的行是否提醒
  rowsNotifyRemoved: false,             // 消失的行是否提醒（默认关闭，避免分页/排序误报）
  onlyStatuses: '',                     // 逗号分隔，如 '已完成,失败'：只有新状态命中才提醒

  // ---- tab 模式等待 ----
  waitForSelector: '',         // 出现该 CSS 选择器再抓（最多 25s）；rows 模式建议填 rowSelector
  settleMs: 1500,              // 页面加载完成后再等多少毫秒（0–20000），给 SPA 渲染时间

  // ---- 自动模式（「一键监控当前页面」创建，新增）----
  autoDetect: false,           // true 时：选择器失效会在抓取时自动重新识别并回填
  detection: null,             // 或 { source: 'auto', at: ts, rowCount, headers: [] }

  intervalMinutes: 5,          // 0.5 ~ 1440
  keyword: '',                 // 非空时，仅当新值包含该字符串才提醒（single 模式）
  ignoreEmpty: true,           // 提取结果为空时跳过，视为「未取到内容」
  notifyOnFirstRun: false,     // 首次建立基线时是否提醒一次
  createdAt: 1750000000000,
  status: {
    lastCheckedAt: 0,
    lastChangedAt: 0,
    lastError: '',             // 人类可读中文
    lastErrorAt: 0,
    consecutiveErrors: 0,
    lastValuePreview: ''       // 单值：内容预览；rows：形如 "任务A=运行中；任务B=已完成"，最长 200 字
  },
  last: null                   // single: { hash, value, at }；rows: { hash, value: '<稳定 JSON>', count, at }
}
```

### 3.3 `runtime`

```js
{
  lastSweepAt: 0,
  lastDeliveryAt: 0,
  lastDeliveryError: '',   // 最近一次投递失败的中文描述
  lastDeliveryOk: null,    // true/false/null
  counters: { checks: 0, changes: 0, sent: 0, failed: 0 },
  retry: null              // 或 { watchId, attempt, text, dueAt }
}
```

## 4. 消息协议（chrome.runtime.sendMessage）

所有请求 `{ type, ... }`，响应一律 `{ ok: true, ... }` 或 `{ ok: false, error: '中文错误' }`。
（`ok` 语义是「本次操作本身是否成功」，与「是否发生内容变化」无关。）

| type | 入参 | 响应 |
| --- | --- | --- |
| `get-state` | — | `{ ok, settings, watches, runtime }` |
| `save-settings` | `{ settings }` 部分字段 | `{ ok, settings }` |
| `save-watch` | `{ watch }`（含或不含 id；有 id 即更新） | `{ ok, watch, watches }` |
| `delete-watch` | `{ id }` | `{ ok, watches }` |
| `toggle-watch` | `{ id, enabled }` | `{ ok, watch }` |
| `run-check` | `{ id? }` 省略 id 表示全部 | `{ ok, results: [CheckResult] }` |
| `test-delivery` | `{ text? }` | `{ ok, code?, message?, httpStatus? }` |
| `get-preview` | `{ watch }` | single: `{ ok, length, valuePreview }`；rows: `{ ok, count, rows:[{key,value}] (≤20), valuePreview }`；仅试抓取，不改状态 |
| `detect-table` | `{ url }` | `{ ok, candidates:[{ rowSelector, keySelector, statusSelector, headers:[], samples:[{key,value}], note }], loginRequired? }` |
| `probe-active-tab` | — | `{ ok, tabId, url, title, kind:'rows'\|'single', candidate:{rowSelector,keySelector,statusSelector\|selector,headers,samples,note}, preview:{count, rows:[{key,value}] (≤5), length?}, stats?, diagnostics? }`（对**当前活动标签页**做结构探测，不新开标签页） |
| `auto-add` | `{ tabId?, url?, intervalMinutes?, forceKind?: 'page' }` | `{ ok, kind:'rows'\|'single', watch, preview:{count, rows:[{key,value}] (≤5)}, error?, diagnostics? }`（用探测结果直接创建「自动模式」监控项；`forceKind:'page'` 跳过识别，直接建「整页内容」监控） |

`CheckResult`：

```js
{
  id, name,
  changed: true,                 // 内容是否变化（不受 keyword 过滤影响）
  notified: true,                // 是否真的发出了提醒
  skipped: '',                   // 例如 'disabled' | 'selector-not-found' | 'empty' | 'not-due'
  error: '',                     // 抓取或投递失败的中文描述
  valuePreview: ''
}
```

> **`ok` 语义补充（实现已按此）**：`run-check` 的 `ok` 表示「本次检查是否所有项都没有 error」。
> 当部分监控项失败时返回 `{ ok:false, results:[...], error:'N 个监控项检查失败' }`，
> **`results` 仍然完整有效**。消费方必须先读 `results`，不要把 `ok:false` 当致命错误吞掉结果。
> `save-settings` 若 DSH 地址不在受信范围内，返回 `{ok:false, error}` 且不落盘。

## 5. 抓取与比较

- `normalizeValue(text)`：`\u00a0` → 空格；`\s+` → 单空格；去首尾空白。
  `valueKind==='html'` 时同样做一次空白归一化（保留标签）。
- `hashValue(value)`：`crypto.subtle.digest('SHA-256', TextEncoder.encode(value))` → 小写 hex。
- CSS：`doc.querySelector(selector)`；XPath：`doc.evaluate(selector, doc, null, FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`。
- 选择器报错（非法 CSS/XPath）与「没找到节点」必须区分：
  `{ ok:false, reason:'selector-not-found' }` vs `{ ok:false, reason:'selector-invalid' }`,
  中文文案分别「选择器没有匹配到元素」/「选择器语法有误」。
- `ignoreEmpty` 且提取值为空串 → 不更新基线、不提醒，返回 `skipped:'empty'`。

### 5.1 single 模式（默认，向后兼容）

- 无 `last`（首次）：写入基线；`notifyOnFirstRun` 为 true 时投递「监控启动」消息。
- 有 `last` 且 hash 相同 → 无变化。
- 有 `last` 且 hash 不同：
  1. 更新 `last`、`status.lastChangedAt`、`counters.changes`；
  2. 若 `keyword` 非空且新值不包含 keyword → `changed:true, notified:false`；
  3. 否则投递提醒（见第 7 节），结果写入 `runtime`。

### 5.2 rows 模式（列表逐行对比）

在离屏文档里做：

1. `doc.querySelectorAll(rowSelector)` 得到行；每行再 `querySelector(keySelector)` / `querySelector(statusSelector)`
   （相对行的 CSS，不支持 XPath）。
2. 行键 = `keyAttr` 有值时取该属性，否则取 `keySelector` 节点的 `textContent`，再 `normalizeValue`；
   键为空串的行直接丢弃（表头/占位行）。
3. 状态 = `statusAttr` 有值时取属性，否则取文本，再 `normalizeValue`。
4. 同一键重复出现时追加 `#2`、`#3` 保证唯一。
5. 结果 `rows = [{key, value}]`；`map = {key: value}`；
   `serialized = JSON.stringify(Object.keys(map).sort().map(k => [k, map[k]]))`（**排序后序列化**，保证顺序无关）。
6. `hash = SHA-256(serialized)`；`last = { hash, value: serialized, count, at }`。
7. 没有任何有效行 → 失败，按三级原因返回（便于直接定位）：
   - `rows-empty`：`doc.querySelectorAll(rowSelector)` 命中 0 个，附 `matched:0` 与 `totalTr`（整页 `<tr>` 数）；
   - `rows-key-empty`：命中行，但「行键选择器/属性」在每行都取不到内容，附 `matched` 与 `sample`（第 1 行各单元格文本）；
   - `rows-status-empty`：命中行，但「状态选择器」在每行都取不到内容，附 `matched`、`sample`、`statusSelector`。
   失败时不更新基线；错误文案由 background 拼成可执行的中文建议（`rowsFailureText`）。
8. 差异（`diffRows(oldMap, newMap)`）：
   - `changed`：键存在且值不同 → `{key, from, to}`
   - `added`：新键 → `{key, value}`（`rowsNotifyAdded` 为 false 时不提醒，但仍算 changed）
   - `removed`：旧键消失 → `{key, value}`（`rowsNotifyRemoved` 为 false 时默认不提醒）
9. 命中 `onlyStatuses`（逗号分隔，任一非空项完全等于 `to`/`value`）时才提醒；
   未命中则 `changed:true, notified:false`。
10. 首次（无 `last`）只建立基线；`notifyOnFirstRun` 时投递「列表监控启动」消息。

## 6. 调度

### 6.1 抓取策略（tab 模式，按优先级降级）

| 顺序 | strategy | 行为 | 会不会出现可见窗口 |
| --- | --- | --- | --- |
| 1 | `tab-reuse` | 扫描所有标签页，找到**用户自己打开的同一页面**（同 origin+path+query），直接读它的 DOM：不新建窗口、不导航、不抢焦点 | **不会（零窗口）** |
| 2 | `hidden-window` | 在最小化/屏幕外的隐藏窗口里，用常驻标签页导航后读取 | 可能有一个隐藏窗口 |
| 3 | `ephemeral-tab` | 兜底：临时开一个后台标签页，读完就关 | 会有标签页闪动 |
| 4 | `direct` | 非 tab 模式：直接 `fetch` 页面 HTML | 不会 |

- 采用 `tab-reuse` 但**内容对不上**（你停在别的筛选/未登录）时，自动用 `hidden-window` 重新导航再试一次。
- 实际使用的策略记录在 `watch.status.lastStrategy` 与 `runtime.lastStrategy`（取值同上表），便于排查「为什么还是有窗口」。

### 6.2 调度规则

- 单一 alarm：`name='sweep'`，`periodInMinutes = max(0.5, 所有启用 watch 的最小 intervalMinutes)`，
  每次 `sweep` 只处理 `now - status.lastCheckedAt >= intervalMinutes*60000` 的 watch。
- `onInstalled` / `onStartup` 都重建 alarm 并立刻跑一次 sweep。
- 单飞：`let sweeping = null;` 并发调用复用同一个 Promise。
- 抓取单次超时 20s（`AbortSignal.timeout(20_000)`）。
- 投递失败且错误码属于 `bot-not-connected` / `delivery-failed` / 网络错误时，
  写 `runtime.retry = { watchId, attempt, text, dueAt }` 并建一次性 alarm `retry-delivery`（60s 后），
  最多 3 次；成功或超限后清空。`runtime.retry` 非空时 UI 要显示「待重试」。

## 7. 投递

请求：

```
POST {dshBaseUrl}/api/dsh-im/delivery/messages
Content-Type: application/json
{ "botId": "...", "targetId": "...", "text": "...", "format": "plain" }
```

- 成功：HTTP 2xx 且 JSON `{ sent: true }` 才算成功。
- 失败：尽量从 `{ error: { code, message } }` 取 code；网络错误记为 `network-error`。
- 错误码中文映射（`ERROR_HINTS`，background 与 UI 共用一份文案）：

| code | 中文提示 |
| --- | --- |
| `bad-request` | 请求格式不对：检查 Bot ID / Target ID 是否为空或含空格 |
| `unknown-bot` | Bot ID 不属于当前 DSH，请重新从设置页复制 |
| `unknown-target` | 该机器人下没有这个 Target ID，请检查或新建目标 |
| `target-conflict` | Target ID 已存在 |
| `invalid-target` | 目标类型或平台 ID 不符合渠道规则 |
| `bot-not-connected` | 机器人当前离线，恢复连接后会自动重试 |
| `target-rejected` | 平台拒绝了该目标（权限或 ID 不对） |
| `delivery-failed` | 平台发送失败（微信常见 ret=-2 prepare failed：先给机器人发一条消息再重试） |
| `network-error` | 连不上 DSH（确认 DSH 正在运行且地址/端口正确） |
| `timeout` | 请求超时 |
| `cancelled` | 请求被取消 |

扩展侧额外补充的 code（DSH 不会返回）：

| code | 含义 |
| --- | --- |
| `missing-config` | Bot ID / Target ID 未配置 |
| `no-permission` | 缺少被监控站点的 host 权限 |
| `invalid-watch` | 监控项配置不完整 |
| `http-404` / `http-500` 等 | 非标准错误码的 HTTP 状态兜底 |

- 文本模板（总长 ≤ 1500 字，超出时截断 `newValue`）：

```
【内容变更】{name}
页面：{url}
时间：{YYYY-MM-DD HH:mm:ss}
变更前：{oldPreview}
变更后：{newPreview}
```

```
【监控启动】{name}
页面：{url}
基线已建立，当前内容：{preview}
```

```
【DSH 监控测试】主动投递已打通 ✅
时间：{YYYY-MM-DD HH:mm:ss}
```

- `oldPreview` 截 80 字，`newPreview` 按剩余预算截断（≥300 字）。
  空值显示 `(空)`。

## 8. 权限

- `host_permissions`: `http://127.0.0.1/*`, `http://localhost/*`（投递 DSH）。
- `optional_host_permissions`: `http://*/*`, `https://*/*`（监控目标站点，保存监控项时申请）。
- 保存 / 立即检查前，options.js 必须 `chrome.permissions.request({ origins:[originPattern(url)] })`，
  `originPattern` 规则：`new URL(url).origin + '/*'`。
- 权限不足时 background 返回 `{ ok:false, error:'缺少该站点的访问权限，请在设置页重新保存以授权' }`。

## 9. 界面约定

- 语言：简体中文；时间一律本地时间 `YYYY-MM-DD HH:mm:ss`。
- options 页分三块：**① DSH 投递设置**、**② 监控项列表 + 表单**、**③ 运行状态**。
- 必须存在的按钮（`id` 供自测脚本检查）：
  - `#save-settings`、`#test-delivery`
  - `#add-watch`、`#save-watch`、`#cancel-watch`、`#run-check-all`
  - 每条 watch 行内：`[data-action="edit"] / [data-action="delete"] / [data-action="check"]`，
    以及开关 `[data-action="toggle"]`
- 表单字段 `name`：`name,url,mode,extractMode,selectorType,selector,valueKind,attrName,rowSelector,keySelector,statusSelector,keyAttr,statusAttr,rowsNotifyAdded,rowsNotifyRemoved,onlyStatuses,waitForSelector,settleMs,intervalMinutes,keyword,ignoreEmpty,notifyOnFirstRun,enabled`。
- rows 模式相关 UI 必须包含：
  - `#detect-table`（自动探测表格结构）→ 调 `detect-table`，把候选填进表单并展示 `note`；
  - `#preview-watch`（预览提取结果）→ 调 `get-preview`，rows 模式以「键 → 状态」列表展示（最多 20 行）；
  - `[name="extractMode"]` 单选/下拉切换 single / rows，切换时显隐对应字段。
- rows 模式下隐藏 single 专属字段（selectorType/selector/valueKind/attrName/keyword），
  single 模式下隐藏 rows 专属字段（rowSelector/keySelector/statusSelector/keyAttr/statusAttr/rowsNotify*/onlyStatuses），
  `waitForSelector` 与 `settleMs` 仅 `mode==='tab'` 时展示。
- popup 显示：当前 DSH 连通状态、最近一次检查时间、本周变化次数、最近一条错误，以及「立即检查全部」「打开设置」。
- `get-preview` 已实现并接入表单（「预览提取结果」）。

### 9.1 「一键监控」交互契约（新增，必须实现）

**popup（主入口）**：

- 打开时先 `chrome.tabs.query({ active: true, lastFocusedWindow: true })` 取当前标签页，
  展示「页面标题 + 域名」；对 `chrome://`、`chrome-extension://`、`about:` 等非 http(s) 页面显示不可监控。
- 主按钮 `#monitor-this-page`「监控这个页面的列表」→ `sendMessage({type:'probe-active-tab'})`：
  - 成功：展示 `#probe-summary`「识别到 N 个任务（表头：…）」，列出 `#probe-rows` 前 3 条「键：状态」，
    并显示间隔选择 `#monitor-interval`（**默认 3**）与保存按钮 `#save-auto-watch`。
  - 失败：展示中文 `error`（如登录页/没有表格）+「打开设置手动配置」按钮。
- `#save-auto-watch` → `sendMessage({type:'auto-add', tabId, url, intervalMinutes})`：
  成功后再点「关闭」即可；失败展示 error。
- 保留原有：DSH 状态、最近检查、`#open-options`。

**options（新增区块 ①）**：

- 顶部新增「① 一键添加监控」卡片：`#auto-url`（页面 URL）、`#auto-interval`（默认 3）、
  `#auto-add-watch`「自动识别并添加」。点按钮 → 调 `auto-add({url, intervalMinutes})`；
  成功显示 `#auto-add-result`：「已添加，识别到 N 个任务」+ 前 3 条预览 + 「立即建立基线」按钮；
  失败显示中文 error 与「展开高级手动配置」提示。
- 原「新增监控项」表单整体放进 `<details id="advanced-form">`，summary 文案
  「高级：手动填写选择器（一般不需要）」，**默认折叠**；原有 id / name 全部保留在里面。
- settings 区增加开关 `name="silentTabs"`：「静默抓取：在隐藏窗口里抓，不显示标签页」（默认开）。
- 新增按钮 `#detect-current-tab`「用当前标签页识别」：`probe-active-tab` 成功后自动填进高级表单。

**页面权限**：manifest 已把 `http://*/*`、`https://*/*` 放进 `host_permissions`（安装时一次授权），
所以 UI **不再需要**在保存前调 `chrome.permissions.request`；保留 `chrome.permissions` 相关判断为兜底即可。

## 10. 投递文案（rows 模式追加）

```
【任务状态变化】{name}
页面：{url}
时间：{YYYY-MM-DD HH:mm:ss}
• {key}：{from} → {to}
• {key}：新增，状态 {value}
（共 {n} 项变化）
```

```
【列表监控启动】{name}
页面：{url}
已记录 {count} 个任务，当前状态：
• {key}：{value}            （最多 8 行）
```

- 单条消息 ≤ 1500 字；变化条目最多 12 条，超出用「…等 N 项变化」。
- `onlyStatuses` 过滤后若无条目，不投递（`notified:false`）。
