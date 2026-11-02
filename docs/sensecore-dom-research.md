# SenseCore 控制台「任务列表」网页结构调研（扩展 rows 模式用）

> 调研目标：`https://console.sensecore.cn/cn-sh-01/acp/list?workspace=...` 的「状态」列。
> 方法：**只做静态分析**——用 Node `fetch` 匿名下载该站的公开前端 bundle（HTML 外壳 / JS / CSS），按块搜索关键字。**没有登录、没有提交任何凭据、没有调用任何需要鉴权的接口。**
> 时间：2026-11-01。若站点重新发布（bundle 文件名里的 hash 变了），本文结论需要按第 12 节重新核对。

## 0. 复制即用配置（先看这一节）

在扩展「新建监控」里选 **列表模式（rows）+ 标签页模式（tab）**，把下面这组值填进去：

```json
{
  "name": "ACP 任务状态",
  "url": "https://console.sensecore.cn/cn-sh-01/acp/list?workspace=<你的 workspace rid>",
  "mode": "tab",
  "extractMode": "rows",
  "rowSelector": ".acp-list tr.sensed-table-row[data-row-key]",
  "keySelector": "",
  "keyAttr": "data-row-key",
  "statusSelector": "td:nth-child(10) .status-tag-label",
  "statusAttr": "",
  "rowsNotifyAdded": true,
  "rowsNotifyRemoved": false,
  "onlyStatuses": "排队中,运行中,成功,失败,已停止,限额中",
  "waitForSelector": ".acp-list tr.sensed-table-row",
  "settleMs": 2500,
  "intervalMinutes": 5,
  "notifyOnFirstRun": false
}
```

**可信度（务必先看）**：行选择器 `tr.sensed-table-row[data-row-key]` 是**高**置信（由组件库代码直接决定）；
`td:nth-child(10) .status-tag-label` 是**中高**置信（列顺序可从列定义数出来，但依赖「批量选择列存在」这一前提）；
状态文案取 `.status-tag-label` 也是中高。**因为不登录看不到真实 DOM，建议先按第 8 节在浏览器里跑一段控制台脚本确认**，再打开监控。
如果列数对不上，用第 7 节的备选方案 B（不依赖列序）。

---

## 1. 实际下载与分析的资源（全部为公开静态文件，匿名可下载）

| # | URL | 大小（字节） | 说明 |
| --- | --- | --- | --- |
| 1 | `https://console.sensecore.cn/cn-sh-01/acp/list?workspace=default` | 1 363 | HTML 外壳（`<div id="root-master">`），只有 CSS/JS 引用 |
| 2 | `/umi.31807360.js` | 2 308 287 | 主应用（fe-core-region，qiankun 主应用） |
| 3 | `/preload_helper.21b4d82a.js` | 2 004 | 主应用路由 chunk 预加载表 |
| 4 | `/umi.70881c42.css` | 13 080 | 主应用样式 |
| 5 | `/p__sub-apps__index.88086bb1.async.js` | 71 344 | 主应用各区域子应用注册/环境变量 |
| 6 | `https://console.sensecore.cn/micro/cn-sh-01/main/` | 1 508 | **区域子应用**（core-cn-sh-01-app）HTML 外壳 |
| 7 | `/micro/cn-sh-01/main/umi.98310cc9.js` | 2 419 568 | 区域子应用 JS |
| 8 | `/micro/cn-sh-01/main/preload_helper.b5a32b68.js` | 6 360 | 区域子应用路由表（可见 `/acp/*` 等） |
| 9 | `/micro/cn-sh-01/main/p__sub-apps__acp.e239e110.async.js` | 1 300 | 挂载 ACP 子应用（`core-acpv2-app`） |
| 10 | `https://console.sensecore.cn/micro/cn-sh-01/acp/` | 1 170 | **ACP 子应用**（core-acpv2-app）HTML 外壳，`<div id="root">` |
| 11 | `/micro/cn-sh-01/acp/umi.75ff49d8.js` | 2 052 850 | ACP 子应用 JS（含中英文案） |
| 12 | `/micro/cn-sh-01/acp/preload_helper.c4c3489c.js` | 2 414 | ACP 路由表：`/list`、`/list/detail`、`/list/create`、`/terminal`、`/quick-start` |
| 13 | `/micro/cn-sh-01/acp/umi.37bedf31.css` | 5 346 | ACP 子应用样式 |
| 14 | `/micro/cn-sh-01/acp/p__list__index.52ed084e.async.js` | 44 723 | **任务列表页代码（列定义、状态渲染、表格配置都在这里）** |
| 15 | `/micro/cn-sh-01/acp/p__list__index.cfa3b210.chunk.css` | 10 219 | 列表页样式（`.acp-list`、`.status-tag`、`.acp-list-time`） |
| 16 | `/micro/cn-sh-01/acp/269.d6aef238.async.js` | 11 804 | **状态枚举 Map + 状态标签组件** |
| 17 | `/micro/cn-sh-01/acp/160.34968416.async.js` | 171 297 | 表格组件库（rc-table 改名，`sensed-table` 前缀实现） |
| 18 | `/micro/cn-sh-01/acp/160.416823bb.chunk.css` | 23 417 | 表格/组件库样式 |
| 19 | `/micro/cn-sh-01/acp/935.ecbfa5f5.chunk.css` | 657 893 | 全量组件库样式（含 `.sensed-table-row` 等） |
| 20 | `/micro/cn-sh-01/acp/962.96db873e.chunk.css` | 688 356 | 全量组件库样式（含 `.sensed-table-selection-column`） |
| 21 | `/micro/cn-sh-01/acp/771.28b5e15c.async.js` | 149 309 | 服务层：训练任务列表/操作用到的 HTTP 路径 |
| 22 | `/micro/cn-sh-01/acp/229.708faa98.async.js` | 8 529 | 列表页外壳组件 `page-container`（`.acp-list` 就挂在这里） |
| 23 | `https://console.sensecore.cn/globalEnvVariables.js` | 70 121 | 公开环境变量（各机房 API 域名） |

其余按路由预加载的 chunk（`197`、`215`、`249`、`600`、`623`、`658`、`739`、`804`、`966`、`layouts`）也一并下载检索，未发现与任务列表/状态相关的定义。

---

## 2. 页面是三层微前端，不是一层 SPA

未登录时拿到的 HTML 只是最外层；实际页面由 **三层 UMI 应用**用 qiankun 套出来：

```
console.sensecore.cn/cn-sh-01/acp/list?workspace=...
└─ 主应用 fe-core-region            (/umi.31807360.js, 容器 #root-master)
   └─ 区域子应用 core-cn-sh-01-app  (base /cn-sh-01, 入口 /micro/cn-sh-01/main/, 容器 #root)
      └─ ACP 子应用 core-acpv2-app  (base /cn-sh-01/acp, 入口 /micro/cn-sh-01/acp/, 容器 #root)
         └─ 路由 /list → p__list__index（任务列表页）
```

证据（摘录）：

- 主应用：`[{name:"core-".concat(region,"-app"), entry:"/micro/".concat(region,"/main/"), region}]` — 见 `/umi.31807360.js` 的 module `81039`。
- 区域子应用里注册了 ACP 子应用：`{name:"core-acpv2-app", entry:"/micro".concat(regionPath,"/acp/")}`（见 `/micro/cn-sh-01/main/umi.98310cc9.js` 的 production apps 列表），页面用 `<MicroApp name="core-acpv2-app" base={regionPath + "/acp"} />` 挂载（见 `/p__sub-apps__acp.e239e110.async.js`）。
- ACP 路由表（`preload_helper.c4c3489c.js` 的 `"r"` 字段）：`"/list"`、`"/list/detail"`、`"/list/create"`、`"/terminal"`、`"/quick-start"`。用户给的 URL `/cn-sh-01/acp/list` 正对应 `/list`。

> **注意**：三层容器里出现了 **两个 `id="root"`**（区域子应用和 ACP 子应用）。扩展里**不要**用 `#root` 定位，用 class 定位。

---

## 3. 表格实现：SenseD 设计系统的 Table（antd/rc-table 的改名分叉）

结论：**不是 arco、不是 semi、也不是手写 `<table>`**，而是商汤自研设计系统 SenseD 的 Table 组件（基于 `rc-table`，API 与 antd v5 的 Table 一致），所有 class 前缀从 `ant-` 换成了 `sensed-`。

证据：

- 表格组件代码里存在 rc-table 内部标识：`"rc-table-internal-hook"`（`160.34968416.async.js`，module `72175`）。
- 表格 API 与 antd 一致：`columns` / `dataSource` / `rowKey` / `rowSelection` / `pagination` / `scroll` / `components` / `emptyText`。
- 渲染出的 class 全部是 `sensed-table-*`（CSS 里存在对应规则，不只是字符串）：
  `.sensed-table-row:hover>td{…}`、`.sensed-table-selection-column{width:46px;min-width:46px}`、`.sensed-table-tbody>…`、`.sensed-table-thead>…`。

列表页里表格的实际 props（`p__list__index.52ed084e.async.js`，任务列表页组件）：

```js
(0, k.jsx)(v.Z, {
  components: { header: { cell: Ee.Rn } },        // 自定义表头单元格（列宽可拖拽）
  loading: Re,
  rowSelection: { ...Xe },                        // 批量选择列 → 会多出 1 个 td/th
  scroll: { scrollToFirstRowOnChange: true, y: "calc(100vh - 318px)" },
  rowKey: "name",                                 // ★ 行主键 = 任务 name
  columns: ht,                                    // ★ 列定义（见第 5 节）
  dataSource: Pe ? Pe.training_jobs : [],
  pagination: {
    position: ["topCenter"],
    current: U.page_token, pageSize: U.page_size,
    total: Pe && Pe.total_size,
    showSizeChanger: true, showQuickJumper: true,
    pageSizeOptions: ["10","20","50","100","200"],
  },
})
```

由此可确定：

| 特性 | 结论 | 依据 |
| --- | --- | --- |
| 虚拟滚动 | **未启用**（无 `virtual` 属性；列表页 chunk 里 `virtual` 出现 0 次） | 行是真实 DOM，可用选择器抓 |
| 固定表头 | 是（`scroll.y` 生效）→ 结构上拆成 `.sensed-table-header` 与 `.sensed-table-body` 两个 `<table>` | antd 固定表头行为 |
| 行选择列 | **有**（`rowSelection` 传入）→ 每行比列定义多 1 个单元格 | `rowSelection` 对象非空 |
| 分页位置 | **顶部居中**，默认每页 10 条，可选 10/20/50/100/200 | 上面的 `pagination` |
| 列宽 | 用户可拖拽调整（`react-resizable`），不改 DOM 单元格数量 | `getResizedColumns()` + `.react-resizable-handle___Kq13k` 样式 |
| 行状态 class | **没有**（未传 `rowClassName`，不能靠 CSS class 区分状态，只能读文本） | 表格 props 列表 |
| 空态 | `tr.sensed-table-placeholder`（没有 `-row` class） | rc-table 行为 |

---

## 4. 状态列：枚举、文案、DOM

### 4.1 状态枚举（内部 code → 中文/英文文案 → 颜色类型）

状态 Map 在 `269.d6aef238.async.js` 的 module `69814`，**顺序即筛选下拉框顺序**：

```js
new Map([
  ["WAIT_QUOTA", {type:"processing"}],
  ["WAITING",    {type:"disabled"}],
  ["INIT",       {type:"info"}],
  ["QUEUEING",   {type:"processing"}],
  ["CREATING",   {type:"processing", loading:true}],
  ["RUNNING",    {type:"info"}],
  ["SUSPENDING", {type:"processing", loading:true}],
  ["SUSPENDED",  {type:"disabled"}],
  ["RESTARTING", {type:"info"}],
  ["SUCCEEDED",  {type:"success"}],
  ["FAILED",     {type:"error"}],
  ["DELETING",   {type:"disabled"}],
  ["STARTING",   {type:"processing"}],
  ["RECOVERING", {type:"info"}],
])
```

完整对照表（文案来自 `umi.75ff49d8.js` 的语言包：`status.<code 小写>`）：

| # | 内部 code | 中文文案（zh-CN） | 英文文案（en-US） | 颜色类型 | 颜色 |
| --- | --- | --- | --- | --- | --- |
| 1 | `WAIT_QUOTA` | 限额中 | Waiting Quota | processing | rgb(0,106,230) |
| 2 | `WAITING` | 等待中 | Pending | disabled | rgb(143,154,175) |
| 3 | `INIT` | 初始化 | Init | info | rgb(14,156,255) |
| 4 | `QUEUEING` | 排队中 | Queueing | processing | rgb(0,106,230) |
| 5 | `CREATING` | 创建中 | Creating | processing（带 loading 图标） | rgb(0,106,230) |
| 6 | `RUNNING` | 运行中 | Running | info | rgb(14,156,255) |
| 7 | `SUSPENDING` | 停止中 | Suspending | processing（带 loading 图标） | rgb(0,106,230) |
| 8 | `SUSPENDED` | 已停止 | Suspended | disabled | rgb(143,154,175) |
| 9 | `RESTARTING` | 重启中 | Restarting | info | rgb(14,156,255) |
| 10 | `SUCCEEDED` | **成功** | Succeeded | success | rgb(18,185,41) |
| 11 | `FAILED` | 失败 | Failed | error | rgb(205,20,11) |
| 12 | `DELETING` | 删除中 | Deleting | disabled | rgb(143,154,175) |
| 13 | `STARTING` | 启动中 | Starting | processing | rgb(0,106,230) |
| 14 | `RECOVERING` | 恢复中 | Recovering | info | rgb(14,156,255) |

**重要纠正**：页面上**没有「已完成」「已取消」这两个状态文案**。成功对应 `SUCCEEDED` → 显示 **「成功」**；停止对应 `SUSPENDED` → 显示 **「已停止」**。所以 `onlyStatuses` 不要写「已完成/已取消」，否则永远不命中。
另外语言包里还有 `status.all = 所有运行状态`（筛选下拉的「全部」选项）和 `status.created = 创建中`（枚举里没有 `CREATED`，属于冗余文案）。
若状态 code 不在枚举里，单元格渲染成 `--`（没有 `.status-tag-label`）。

### 4.2 状态列渲染代码（`p__list__index.52ed084e.async.js`）

```js
{
  dataIndex: "state",
  width: 100,
  title: a.formatMessage({ id: "jobs.status" }),      // 中文 "状态" / 英文 "Status"
  filters: Array.from(re.Jb, ([code]) => ({            // re.Jb = 上面的 14 项 Map
    text: a.formatMessage({ id: "status." + code.toLowerCase() }), value: code,
  })),
  filterMultiple: false,
  render: function (state, row) {
    const meta = re.Jb.get(state);                      // module 69814
    if (!meta) return "--";
    return (
      <>
        <ne.Z type={meta.type} loading={meta.loading} tip="">   {/* ne.Z = module 93122 状态标签 */}
          {a.formatMessage({ id: "status." + state.toLowerCase() })}
        </ne.Z>
        {/* 可选：耗时，class = "acp-list-time"，如 "2d3h4min" / "<1min" */}
      </>
    );
  },
}
```

状态标签组件（`269.d6aef238.async.js`，module `93122`）渲染出的 class 是**写死字符串**（不是 CSS Modules 哈希）：

```js
// module 93122
<div style={{ width: "fit-content" }}>
  <StatusTag className="status" type={type} icon={loading ? <Spin/> : <span className="dot"/>}>
    {label}
  </StatusTag>
</div>
// StatusTag:
<div className="status-tag status" style={{ color: rgba(color), background: rgba(color, .1) }}>
  <span className="dot" style={...} />            // 或 loading 的 span.iconfont.icon-loading
  <span className="status-tag-label">{label}</span>
</div>
```

所以状态单元格（**推断**，非登录目视）形如：

```html
<td class="sensed-table-cell">
  <div style="width: fit-content;">
    <div class="status-tag status" style="color: rgb(14,156,255); background: rgba(14,156,255,0.1);">
      <span class="dot" style="background: rgb(14,156,255); box-shadow: ..."></span>
      <span class="status-tag-label">运行中</span>
    </div>
  </div>
  <div class="acp-list-time">1d2h3min</div>   <!-- 可选；也可能没有 -->
</td>
```

要点：

- **只取 `.status-tag-label` 的文本**。整个 `td` 的 `textContent` 会变成「运行中1d2h3min」，直接拿 td 文本会污染状态值。
- `.status-tag`、`.status-tag-label`、`.dot` 都是列表页 CSS chunk 里的**普通 class**（`.status-tag{display:inline-flex;…}`、`.status-tag-label{…}`），不是 `xxx___hash` 这种 CSS Modules 名，跨构建稳定。
- 状态标签**没有** `title` 属性或 `data-*` 属性可用来取 code（`tip:""` 导致无 tooltip），因此**只能靠文本**识别状态；扩展必须同时兼容中英文两套文案（见第 9 节）。

### 4.3 同页还有「另一张表」不要混淆

列表页里还内嵌了「Pod 事件」弹窗表格（`pod-event-table___dloUK` 等 CSS Modules 类名），它的表头是 `Type / Reason / Age / Source / Message`，状态样式用的是 `status-tag`（在 Message 列里）且枚举是 `Running/Terminating/Succeeded/Failed/Deleted/Unknown`。
它默认不渲染（只有点「事件」才出现），且是弹窗（rc-dialog 默认 portal 到 `body`），用 `.acp-list` 作用域可以把它的行排除掉。

---

## 5. 列定义与列顺序（含「状态」是第几列）

任务列表页的列数组 `mt`（`p__list__index.52ed084e.async.js`）按代码顺序如下：

| 列序（0 基，含选择列） | 列序（列定义，1 基） | 表头文案（zh / en） | 取值 | 备注 |
| --- | --- | --- | --- | --- |
| 0 | — | （复选框列，无文案） | — | `rowSelection` 生成，`th.sensed-table-selection-column` |
| 1 | 1 | 显示名称/名称 · Display name/Name | `display_name` + `name` | `width:170`, `fixed:true` |
| 2 | 2 | 关联集群 · Cluster | `aec2_name` / `resource_pool` | `width:220` |
| 3 | 3 | 框架 · Framework | `framework` | `width:140` |
| 4 | 4 | 任务规格 · Resource | `roles[0].resource_spec` | `width:170` |
| 5 | 5 | 副本数 · Total replicas | `roles[0].total_replicas` | `width:100` |
| 6 | 6 | 创建时间 · Created time | `create_time` | `width:120` |
| 7 | 7 | 提交者 · Creator | `ownership.user_name` | `width:100` |
| 8 | 8 | 优先级 · Priority | `priority` | `width:100` |
| **9** | **9** | **状态 · Status** | **`state`** | **`width:100`，带筛选，渲染状态标签** |
| 10 | 10 | 操作 · Actions | — | `width:180`, `fixed:"right"`，按钮「复制/日志/事件/监控/停止/启动」 |

**结论：在 DOM 里「状态」是每行的第 10 个 `td`（`td:nth-child(10)`）**，因为前面多一个批量选择列。若某天版本去掉了批量选择，状态会变成第 9 个 td —— 这也是下面同时给「不依赖列序」备选方案的原因。

> 表头 `th` 同样多一个选择列表头；表头单元格由自定义组件 `Ee.Rn` 渲染（列宽拖拽把手），但**不影响 td 数量**。

---

## 6. 列表数据接口与分页参数（仅记录，未调用）

服务层代码（`771.28b5e15c.async.js`，module `59155`/`38809`）：

```js
// 前缀常量（module 59155）：
t = window.AEC2                 // 由 /globalEnvVariables.js 按机房注入
p = "/compute/acp/data/v2"

// 列表请求（module 38809 的 g()）：
request(`${t}${p}${filter.workspace}/trainingJobs${userOwn === "All" ? "" : "Own"}`, {
  method: "GET",
  params: { ...过滤字段, ...pageParams },   // 见下
  skipCoreErrorHandler: true,
})
```

- **方法与路径**：`GET {AEC2}/compute/acp/data/v2/{workspace_rid}/trainingJobs`；当页面「我的任务」筛选生效时路径后缀为 `…/trainingJobsOwn`。
- `AEC2` 是公开环境变量里的域名，例如 `console.sensecore.cn`（cn）→ `https://aec2.cn-sh-01.sensecoreapi.cn`（同一文件的其它机房会另有域名）。
- **query 参数**：
  - `page_token`（默认 `1`）、`page_size`（默认 `10`，可选 10/20/50/100/200）—— 见列表页初始状态 `{page_token:1,page_size:10,…}`
  - `state`（状态筛选，值就是上面 14 个大写 code，如 `RUNNING`）、`priority`（`HIGHEST/HIGH/NORMAL`）、`aec2_name`
  - `filter`：时间/UID 等条件的表达式串，如 `created_at >= '…' AND created_at < '…'`、`uid='…'`（由页面上的时间范围/搜索框生成）
- **响应字段**（列表页直接使用）：`training_jobs[]`（每项含 `name`、`display_name`、`state`、`create_time`、`ownership.user_name`、`scheduling.priority`、`resource_pool`、`roles[].resource_spec` 等）与 `total_size`。
- 该接口需要登录态（本文**没有**调用它，只从代码里读出路径）。

> 页面上的筛选/分页会改变可见行集合：筛选条件会被写进页面查询参数（由代码里的 `searchParams` 更新逻辑推断，未逐一验证 query 名），翻页只换当前页 DOM。扩展按当前可见 DOM 取行，所以**翻页/换筛选会被误判成「旧行消失 + 新行出现」**（见第 9 节）。

---

## 7. 选择器建议

### 7.1 主方案（推荐）

| 字段 | 值 | 可信度 | 依据 |
| --- | --- | --- | --- |
| `rowSelector` | `.acp-list tr.sensed-table-row[data-row-key]` | **高** | 表格库把 `tr` class 拼成 `<prefix>-row`、并渲染 `data-row-key`（`160.34968416.async.js`：`createElement("tr",{...'data-row-key':key, className: cx(rowClassName, prefixCls+'-row', prefixCls+'-row-level-'+level)})`）；`.acp-list` 是列表页容器 div 的 class（`229.708faa98.async.js` module `90229`：`<div className={cx(props.className,"page-container",…)}>`） |
| `keySelector` + `keyAttr` | `""` + `data-row-key`（空选择器 = 取行节点自身属性） | **高** | 页面传 `rowKey:"name"`，因此该属性值就是任务 `name`（同一 workspace 内唯一） |
| `statusSelector` | `td:nth-child(10) .status-tag-label` | **中高** | 列定义共 10 列 + 1 个选择列 → 状态是第 10 个 td；标签 class 在状态组件里写死 |
| `statusAttr` | 空 | — | 状态标签无 `title`/`data-*`，只能取文本 |
| `waitForSelector` | `.acp-list tr.sensed-table-row` | 高 | 同上 |
| `mode` | `tab` | 高 | 页面必须登录、且是 qiankun 三层 SPA，`direct` 模式取不到内容 |

`keyAttr` 的用法对得上扩展实现（`src/extract.js` 的 `readCell`：`selector` 为空时对行节点取 `attr`），所以 `keySelector:""` + `keyAttr:"data-row-key"` 正好等于「用行主键当键」。

### 7.2 备选方案

**B（不依赖列序，列数变了也不受影响）**：`statusSelector: ".status-tag-label"`。
可信度中高：主列表每行只有一个 `.status-tag-label`（只出现在状态列）；但风险是同页若出现第 2 个状态标签（比如以后加了「就绪副本」列）会取错。

**C（列序兜底，取整个状态列的文本）**：`statusSelector: "td:nth-child(10)"`。
可信度中：会连耗时文本一起拿到（「运行中1d2h3min」），除非扩展支持去尾，否则不建议。

**D（最保守，忽略列结构，整行文本当键）**：`rowSelector: "tr[data-row-key]"`、`keySelector: ""`、`keyAttr: "data-row-key"`、`statusSelector: ".status-tag-label"`。
**E（键的兜底）**：若扩展界面不允许 `keySelector` 留空，可写 `keySelector: "td:nth-child(2)"`（该列是「显示名称/名称」，文本含两段，仍能稳定区分行）；或保持 `keySelector:""` + `keyAttr:"data-row-key"`。
不加 `.acp-list` 作用域时，若用户打开了「事件」弹窗，弹窗表格的行也会被匹配（弹窗 portal 到 body，`tr[data-row-key]` 会命中），可能多出几行假变化。

### 7.3 需要避开的写法

- ❌ `#root`：三层微前端里有 **两个** `id="root"`。
- ❌ `.ant-table-*`：该站表格前缀是 `sensed-table`，不是 `ant-table`。
- ❌ `xxx___hash` 形式的 CSS Modules 类（如 `edit-modal___MF8TQ`、`pod-event-table___dloUK`）：每次构建 hash 会变。
- ❌ 用 `td` 文本直接当状态：单元格里还会拼耗时。
- ❌ 靠 class 判断状态：行上没有状态相关 class。
- ❌ `thead` 里的行：固定表头下有独立的 header 表，表头 `tr` 没有 `sensed-table-row`/`data-row-key`（已被主方案排除）。
- ❌ tbody 顶部的量测行：固定列场景下 rc-table 可能渲染 `<tr class="sensed-table-measure-row" aria-hidden="true">`，它没有 `data-row-key`、也没有 `-row` class（已被主方案排除）；占位空态行是 `tr.sensed-table-placeholder`，同样被排除。

---

## 8. 上线前自检（在已登录的任务列表页 DevTools Console 里跑）

不确定就先跑这段，把输出贴回来即可验证/修正本文结论：

```js
(() => {
  const rows = [...document.querySelectorAll('.acp-list tr.sensed-table-row[data-row-key]')];
  console.log('表格容器 .acp-list:', !!document.querySelector('.acp-list'));
  console.log('行数:', rows.length);
  const headers = [...document.querySelectorAll('.acp-list thead tr th')]
    .map(th => th.textContent.replace(/\s+/g, ' ').trim());
  console.log('表头:', headers, 'th数:', headers.length);
  console.log(rows.slice(0, 5).map(tr => ({
    key: tr.getAttribute('data-row-key'),
    cells: tr.children.length,
    statusByIndex: tr.querySelector('td:nth-child(10) .status-tag-label')?.textContent.trim() ?? null,
    statusAny: tr.querySelector('.status-tag-label')?.textContent.trim() ?? null,
    statusCellText: tr.children[9]?.textContent.replace(/\s+/g, ' ').trim() ?? null,
  })));
  console.log('返回选择器结果数:',
    document.querySelectorAll('.acp-list tr.sensed-table-row[data-row-key] td:nth-child(10) .status-tag-label').length);
})();
```

判定标准：

- `表格容器 .acp-list: true`；`行数 > 0`；
- `th数` = 11（含选择列表头）；如果有 12/10，说明列有变动 → 用备选方案 B；
- `statusByIndex` 与 `statusAny` 都等于页面看到的「运行中/排队中/…」，且 `cells` = 11；
- `返回选择器结果数` = `行数`（每行一个状态标签）。

如果 `statusByIndex` 为 `null` 但 `statusAny` 有值，说明列序变了（选择列可能被去掉）→ 改用 `.status-tag-label`。

---

## 9. 监控时的注意事项（会直接影响误报率）

1. **必须用 `mode: "tab"`**：页面要登录，且 qiankun 子应用需要真实执行 JS；`direct` 模式只能拿到外壳 HTML，会 `rows-empty`。
2. **`settleMs` 建议 ≥ 2000ms**：三层微前端 + 表格异步加载，首次渲染较慢；再用 `waitForSelector: ".acp-list tr.sensed-table-row"` 兜底（最多等 25s）。
3. **分页是最大误报源**：默认每页 10 条，`rows` 模式按「当前 DOM 的行集合」比对，翻页/换筛选会导致旧页所有行「消失」、新页所有行「新增」。
   - 建议用户把每页条数调到 **200**（页面支持），并**停留在第 1 页**、不要改筛选；
   - `rowsNotifyRemoved` 保持默认 `false`（扩展默认就关），可避免「消失行」通知刷屏；
   - 如需关注某几种状态，用 `onlyStatuses` 限制。
4. **`onlyStatuses` 要写页面真实文案**：中文界面用 `排队中,运行中,成功,失败,已停止,限额中` 这类；**英文界面**（`umi_locale=en-US`）要写 `Queueing,Running,Succeeded,Failed,Suspended,Waiting Quota`。写「已完成/已取消」不会命中（页面没有这两个词）。
5. **语言会影响状态文本**：状态标签走 i18n（`localStorage.umi_locale`，默认 zh-CN）。若要同时兼容，最稳妥是让用户固定用中文界面，或扩展侧把中英文文案都当作合法值（例如 `onlyStatuses` 里中英都列上）。
6. **任务名很长 / 有重复**：键取 `data-row-key`（= 作业 name，唯一）；若为空会退化为整行文本（会很长且含耗时），不建议。
7. **选中行会改变第 1 列表头文案**（「已选 N 项」），但不改列数；批量勾选不会影响状态列。
8. **别用状态的「颜色」做判断**：颜色是内联 style 的 `rgba(...)`，不同状态可能共用同色（`processing` 和 `info` 都是蓝色系），且主题切换会变。

---

## 10. 「无法确认」的部分（诚实声明）

以下内容**没有**经过登录后的真实 DOM 验证，属于静态推断：

1. **未登录，无法目视确认渲染结果**。所有 DOM class 结论来自「组件源码里的 className 拼接 + CSS 里存在同名规则 + rc-table 行为」，属于高可信推断，但不是实测 DOM。
2. **状态单元格内层结构**（`td > div > div.status-tag > span.dot + span.status-tag-label`）是按组件实现推断的；实际还会多一层 tooltip 相关节点吗、`dot` 是否存在都与版本有关（Tooltip 通常不额外包裹 DOM）。**但 `.status-tag-label` 这个 class 与文本一定在状态单元格内**。
3. **「状态」是第 10 个 td** 依赖「批量选择列存在」。选择列由 `rowSelection` 传入决定；如果产品在某个版本去掉了批量操作，会变成第 9 个 td。
4. **表头是否被自定义组件包裹**（列宽拖拽把手、排序/筛选按钮）未目视；这不影响 td 数量，但若扩展想用「表头文本定位列」需要再确认。
5. **分页/筛选是否写进 URL**（如 `state=RUNNING`）是从代码里的 `searchParams` 更新逻辑推断的，未逐一验证 query 名。
6. **状态筛选下拉的选项顺序** = 枚举 Map 顺序（本文表格顺序），未目视。
7. **行是否会因权限/开关而不渲染**：列表页有 `vt` 条件（当 URL 带 `aec2_name` 筛选但集群列表未加载时表格不渲染）。正常访问不受影响。
8. **未来版本风险**：若产品改为虚拟滚动（antd `virtual`），tbody 会变成虚拟容器（`sensed-table-tbody-virtual`），`tr.sensed-table-row` 选择器会失效（表现为 `rows-empty`）；若列顺序调整，`td:nth-child(10)` 会失效。

### 需要用户提供的 DOM 片段（若要 100% 确认）

请在**已登录、任务列表已加载**的页面上，DevTools → Elements 里取以下内容（任务名/用户 ID 可脱敏）：

1. 任意一行 `<tr>` 的完整 `outerHTML`（最好选一个「运行中」和一个「失败」的行，各一份）；
2. 状态单元格 `<td>` 的 `outerHTML`（含 `.status-tag` 那段）；
3. 表头一行 `<thead><tr>…</tr></thead>` 的 `outerHTML`（或所有 `th` 的文本数组 + 数量）；
4. 页面容器 `document.querySelector('.acp-list')?.outerHTML.slice(0, 2000)`（确认 `.acp-list` 是否真的在 DOM 上）；
5. 浏览器语言设置 / 页面右上角语言（中文还是英文界面）；
6. 该页默认每页条数、是否停在第 1 页。

拿到 1–4 后，选择器就能从「中高可信」升级为「实测确认」；如果和本文不一致，只需按第 8 节脚本的输出调整 `rowSelector` / `statusSelector` 两个值即可。

---

## 11. 关键证据附录（供复核）

1. **状态枚举 + 标签组件**：`/micro/cn-sh-01/acp/269.d6aef238.async.js` → module `69814`（`Jb` = 状态 Map）、module `93122`（状态标签 `status-tag status` / `status-tag-label`）。
2. **列表页列定义/状态渲染/表格 props**：`/micro/cn-sh-01/acp/p__list__index.52ed084e.async.js` → `mt=[…]` 列数组、`ht=getResizedColumns(mt)`、`rowKey:"name"`、`scroll.y`、`pagination`、`rowSelection`。
3. **表格库**：`/micro/cn-sh-01/acp/160.34968416.async.js` → module `72175`（rc-table 分叉，`"rc-table-internal-hook"`；`data-row-key`、`<prefix>-row`、`<prefix>-cell` 拼接）。
4. **表格样式**：`935.ecbfa5f5.chunk.css`（`.sensed-table-row:hover>td`、`.sensed-table-tbody>…`）、`962.96db873e.chunk.css`（`.sensed-table-selection-column{width:46px}`）。
5. **状态标签样式**：`p__list__index.cfa3b210.chunk.css` → `.status-tag{display:inline-flex;height:22px;border-radius:4px;padding:0 8px;font-size:12px}`、`.status-tag-label{…}`、`.status-tag .dot{width:6px;height:6px;border-radius:100%}`、`.acp-list-time{font-size:12px;line-height:20px;color:#566a7f}`。
6. **页面容器**：`/micro/cn-sh-01/acp/229.708faa98.async.js` → module `90229`：`<div className={cx(props.className,"page-container",…)}>`；列表页传 `className:"acp-list"`。
7. **接口路径**：`/micro/cn-sh-01/acp/771.28b5e15c.async.js` → module `59155`（`vU=window.AEC2`、`wN="/compute/acp/data/v2"`）、module `38809`（`…/trainingJobs[Own]` GET，`page_token/page_size`）。
8. **i18n 文案**：`/micro/cn-sh-01/acp/umi.75ff49d8.js`（zh/en 两套 `status.*`、`jobs.*` 文案；`localStorage.umi_locale` 决定语言）。
9. **三层微前端入口**：`/umi.31807360.js` module `81039`（区域 app entry）、`p__sub-apps__index.88086bb1.async.js`（区域配置）、`p__sub-apps__acp.e239e110.async.js`（ACP 子应用挂载）、`/micro/cn-sh-01/acp/preload_helper.c4c3489c.js`（`/list` 路由 → `p__list__index`）。
10. **公开环境变量**：`/globalEnvVariables.js`（`'console.sensecore.cn'` → `AEC2: 'https://aec2.cn-sh-01.sensecoreapi.cn'` 等，仅公开 API 域名）。

---

## 12. 站点更新后如何重新核对（可复现步骤）

1. `fetch`（Node，别用 curl，本机 schannel 有 TLS 问题）`https://console.sensecore.cn/cn-sh-01/acp/list?workspace=default`，从 HTML 里取 `/umi.<hash>.js` 与 `/preload_helper.<hash>.js`；
2. 取主应用 `preload_helper`，找到 `/cn-sh-01/*` 路由 → `/micro/cn-sh-01/main/`；再取区域子应用 `preload_helper`（`/acp/*` 对应 chunk `p__sub-apps__acp.*.async.js`），从该 chunk 里读 `core-acpv2-app` 的 `entry:"/micro".concat(region,"/acp/")`；
3. 下载 `/micro/cn-sh-01/acp/` 外壳 → 取 `umi.<hash>.js` 与 `preload_helper.<hash>.js`；
4. 在 ACP 的 `preload_helper` 里找 `"/list"` 路由对应的 chunk 文件名（形如 `p__list__index.<hash>.async.js`）并下载；
5. 在该 chunk 里搜 `dataIndex:"state"` / `jobs.status` / `rowKey:"name"`，确认列定义与状态列位置；搜 `rowSelection` 确认选择列；
6. 在 `umi.<hash>.js` 里搜 `status.running` / `排队中` 确认文案；在状态 chunk 里搜 `WAIT_QUOTA` 确认枚举；
7. 用 `grep 'sensed-table'` 确认表格前缀；用 `data-row-key` 确认行属性。
