# DSH-IM 主动投递接入与排错（Chrome 扩展用）

> 本文面向**不了解 DSH**的读者：照着第 4 节就能在 DSH 设置里建好投递目标；第 3、9 节给出实测状态码与每种报错的修法。
>
> 权威来源：插件自带文档 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@xmanrui\dsh-im\PROACTIVE_DELIVERY.md`（下称「插件文档」）。
> 本文所有「实测」数据来自 2026-11-01 对本机 Host `http://127.0.0.1:52020` 的真实请求（Node v24.15.0，脚本 `tools/probe-delivery.mjs`，22 项探测全部 PASS）。
> 与权威文档不一致或文档未覆盖的地方已在第 10 节逐条列出。

---

## 1. 结论摘要

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 接口是否存在、路径是否固定 | ✅ 存在，`POST /api/dsh-im/delivery/messages` | 实测 GET 得到 405 + `allow: POST`；尾斜杠路径落到 Host 其它层返回 401，说明路由是**精确匹配** |
| 字段契约是否与文档一致 | ✅ 一致：`{botId,targetId,text,format?}`，严格校验、多余字段拒绝 | 实测 11 项字段校验全部符合预期 |
| 1 MiB 上限 | ✅ 一致，边界包含（恰好 1048576 字节放行，1048577 字节 413） | 实测 |
| 有没有 CORS | ❌ 没有任何 `Access-Control-*` 响应头，OPTIONS 预检直接 405 | 实测 3 个响应均无 ACAO |
| 有没有鉴权 | ❌ 投递路由无鉴权；但 Host 其它路由会返回 401 | 实测 |
| 当前这个 bot 是否已被 Host 注册 | ✅ 是（`wx_XXXX…XXXX`），可用投递服务解析 | 用真实 botId + 必然不存在的 targetId 探测，得到 404 `unknown-target` 而非 `unknown-bot` |
| **从微信「真的把消息发出去」是否已被证明** | ❌ **未被证明** | 该 bot 下**没有已保存的投递目标**：任何随机 `targetId` 都立刻 404 `unknown-target`，且 `~/.dsh/integrations/` 下找不到任何已保存目标的痕迹（无 `deliveryTargets` / `targetId` 记录），因此无法触达发送阶段，从未观测到 `200 {"sent":true}` |

**一句话**：接口、协议、错误码都已实测对齐；机器人侧在线可被投递服务识别；但**缺一个已保存的 `targetId`**，所以「主动投递到微信」这条链路目前只能验证到 `404 unknown-target`，端到端可用性需要先在设置里建目标后再复测（见第 11 节「未验证项」）。

---

## 2. 接口契约

### 2.1 地址与方法

```
POST {DSH_BASE}/api/dsh-im/delivery/messages
Content-Type: application/json          ← 必须；否则 415
```

- `DSH_BASE` 就是 DSH Host 的 Web 地址。插件文档里默认是 `http://127.0.0.1:3080`，**本机实际是 `http://127.0.0.1:52020`**（每次启动可能不同，以 Host 启动时显示的地址为准）。
- 接口复用 Host 已有 WebServer，不会另开端口。
- 路径必须**逐字一致**：`…/messages/`（多一个斜杠）会落到 Host 其它路由层，返回 `401 unauthorized`（纯文本），不是接口自己的 404。带查询串 `…/messages?x=1` 可以正常工作。

### 2.2 请求体

```json
{
  "botId": "wx_XXXXXXXXXXXXXXXXXXXXXXXX",
  "targetId": "release-alerts",
  "text": "构建已经完成。",
  "format": "plain"
}
```

| 字段 | 必填 | 规则（实测/源码一致） |
| --- | --- | --- |
| `botId` | ✅ | 1–128 字符，只允许 `[A-Za-z0-9_-]`；从 DSH 设置页「调用标识」复制，**不要按前缀猜渠道**（微信是 `wx_` 开头，飞书是 `bot_` 开头，见第 10 节） |
| `targetId` | ✅ | 1–128 字符，只允许 `[A-Za-z0-9._:@-]`；是**调用方自己起的别名**，不是平台用户 ID |
| `text` | ✅ | 字符串，`trim()` 后不能为空；不支持图片/文件/卡片 |
| `format` | ❌ | 只允许 `"plain"`（默认）或 `"markdown"`；其它值 400 |

**严格校验**：出现任何额外字段（如 `sessionId`、`chatRef`、`idempotencyKey`、平台原生路由字段）一律 400。JSON 总体积上限 **1 MiB**（`1048576` 字节，包含字段名和引号）。

### 2.3 响应头（实测）

```
cache-control: no-store
content-type: application/json; charset=utf-8
content-length: <按 body 计算>
allow: POST                    ← 仅 405 时出现
Vary: Accept-Encoding
```

没有 `access-control-allow-origin`、没有 `access-control-allow-methods`、没有 `access-control-allow-headers`。

### 2.4 成功响应

```json
{ "sent": true }
```

> ⚠️ **这是插件文档给出的成功形态，本次**未实测到**（当前没有已保存目标，无法进入发送阶段）。另外 `{sent:true}` 只表示平台发送接口已接受请求或 SDK 成功返回，**不代表已送达、更不代表已读**。

### 2.5 失败响应（实测原文）

统一包络：

```json
{"error":{"code":"unknown-bot","message":"unknown-bot","details":{}}}
```

- `code` 是**程序应当 switch 的字段**；`message` 只是可读文本，且有两套取值：传输层错误（JSON 解析/体积）`message` 与 `code` 相同，字段校验错误 `message` 固定为 `Invalid delivery request.`。
- `details` 目前恒为 `{}`。

实测的完整原始交互两例：

```http
GET /api/dsh-im/delivery/messages HTTP/1.1          →  405 Method Not Allowed
allow: POST
{"error":{"code":"method-not-allowed","message":"method-not-allowed","details":{}}}

POST /api/dsh-im/delivery/messages HTTP/1.1         →  404 Not Found
Content-Type: application/json
{"botId":"probe_bot","targetId":"probe_target","text":"probe"}
{"error":{"code":"unknown-bot","message":"unknown-bot","details":{}}}
```

---

## 3. 实测状态码矩阵（2026-11-01，Host 127.0.0.1:52020）

| # | 场景 | HTTP | `error.code` | 备注（实测） |
| --- | --- | --- | --- | --- |
| 01 | GET 同路径 | 405 | `method-not-allowed` | 响应带 `allow: POST` |
| 02 | OPTIONS 预检（模拟浏览器 CORS） | 405 | `method-not-allowed` | 无 CORS 层，不是 204 |
| 03 | 合法结构 + 不存在的 botId | 404 | `unknown-bot` | 假 `botId=probe_bot` |
| 04 | 合法结构 + `format:"markdown"` | 404 | `unknown-bot` | 说明 `format` 已通过校验 |
| 05 | 空 body | 400 | `bad-request` | `message` 也是 `bad-request`（JSON 解析失败） |
| 06 | 非法 JSON `{bad` | 400 | `bad-request` | 同上 |
| 07 | `{}` 缺全部字段 | 400 | `bad-request` | `message: Invalid delivery request.` |
| 08 | 缺 `text` | 400 | `bad-request` | 同上 |
| 09 | `text:"   "` 全空白 | 400 | `bad-request` | 同上 |
| 10 | `text:123` 非字符串 | 400 | `bad-request` | 同上 |
| 11 | 多余字段 `extra:1` | 400 | `bad-request` | 严格字段白名单 |
| 12 | `format:"html"` | 400 | `bad-request` | 同上 |
| 13 | `botId:"bot.bad"` 含点 | 400 | `bad-request` | botId 不允许 `.` |
| 14 | `targetId:""` 空 | 400 | `bad-request` | 同上 |
| 15 | `Content-Type: text/plain` | 415 | `unsupported-media-type` | 请求体未解析 |
| 16 | 完全不带 `Content-Type` | 415 | `unsupported-media-type` | 同上 |
| 17 | `Content-Type: application/json; charset=utf-8` | 404 | `unknown-bot` | 带参数仍被接受（按分号前 MIME 判定） |
| 18 | `text` 200 KiB（body≈200 KB） | 404 | `unknown-bot` | 体积上限未拦截，进入业务层 |
| 19 | body **恰好 1 048 576 字节** | 404 | `unknown-bot` | 边界包含，放行 |
| 20 | body **1 048 577 字节** | 413 | `payload-too-large` | 超过 1 MiB，HTTP 层直接拒绝 |
| 21 | 路径带尾斜杠 `…/messages/` | 401 | —（纯文本 `unauthorized`） | 路由未命中，Host 兜底鉴权 |
| 22 | 路径带查询串 `…/messages?probe=1` | 404 | `unknown-bot` | 查询串不影响匹配 |

补充实测（脚本之外手工确认）：

| 场景 | HTTP | `code` | 结论 |
| --- | --- | --- | --- |
| GET + `Content-Type: text/plain` | 405 | `method-not-allowed` | **方法判定先于 Content-Type** |
| >1 MiB body + `text/plain` | 415 | `unsupported-media-type` | **Content-Type 判定先于体积判定** |
| body 为 `null` / `[]` | 400 | `bad-request` | 必须是 JSON 对象 |
| `targetId:"has space"` | 400 | `bad-request` | 空格不允许 |
| `targetId:"a.b:c@d_e-f"` | 404 | `unknown-bot` | `. : @ _ -` 都合法 |
| 真实 botId + 随机不存在的 targetId | 404 | `unknown-target` | **证明该 botId 已被当前 Host 注册**（详见第 11 节） |

**校验顺序（实测）**：`方法(405) → Content-Type(415) → 体积(413)/JSON 解析(400) → 字段白名单与取值(400) → botId 解析(404 unknown-bot) → 目标查找(404 unknown-target) → 发送(503/422/502/200)`。

---

## 4. 在 DSH Web 设置里创建投递目标（照做即可）

> 投递只认「机器人 + 已保存目标」这一对稳定组合，不需要 `sessionId`、聊天引用或临时 Webhook。`botId` 和 `targetId` 是应用唯一需要保存的东西。

1. 打开 DSH Web（本机当前是 `http://127.0.0.1:52020`），点左下/左侧「**设置**」。
2. 进入「**IM机器人**」，找到要发消息的机器人（微信机器人显示为已接入的那一个）。
3. 点该机器人卡片右上角的「**齿轮**」图标，进入机器人设置页。
4. 找到「**调用标识**」区块，复制其中的「**Bot ID**」。
   - 微信渠道实测形态是 `wx_` + 24 位十六进制，例如 `wx_XXXX…XXXX`。
   - **不要**用机器人名称、平台 App ID、账号 ID（`…@im.bot`）或卡片里的脱敏 ID 代替。
5. 点「**新建目标**」。默认展示「**从已聊过的会话选择**」下拉框：
   - 候选来自该机器人**已经持久化**的会话映射，不是平台通讯录；
   - 先在下拉框里选那个微信用户/会话。若为空：先让该微信用户给机器人发一条消息，再点「**刷新**」；仍为空才用「**手动填写（高级）**」。
6. 确认/修改「**Target ID**」：
   - 默认是 `tgt_` + 16 位十六进制（如 `tgt_7f3a91c8d2e64b10`），可改成有意义的别名，如 `release-alerts`；
   - 规则：1–128 字符，只允许字母、数字、`.`、`_`、`:`、`@`、`-`；
   - **保存后不可修改**。所以建议一开始就起一个稳定别名，写进扩展配置。
7. 确认「**目标类型**」与平台原生 ID。微信只有一种目标类型 `user`，需要「微信用户 ID（`toUserId`）」，形如 `o9c…@im.wechat`（从下拉框选中时会自动填入）：
   - 手动填写时，平台 ID 不能为空、不能带首尾空格；一个目标只接受该渠道/类型要求的字段，多填会被拒绝。
8. 点「**测试**」。目标微信收到 `DSH-IM 主动投递测试成功。` 后，再点「**保存目标**」。
   - 「测试」按钮要求机器人**在线**且该类型所需平台 ID 已填全；
   - 测试成功只代表平台接口接受发送，不代表已读；测试使用表单当前值，**不会**先保存目标。
9. 在两个已保存目标行上点「**复制调用参数**」，得到：

   ```json
   { "botId": "wx_XXXXXXXXXXXXXXXXXXXXXXXX", "targetId": "release-alerts" }
   ```

10. 把这两个值填进 Chrome 扩展的「设置」页（对应 `docs/architecture.md` 里的 `settings.botId` / `settings.targetId`），并把 `settings.dshBaseUrl` 填成 Host 地址（不带结尾斜杠）。

> 管理 RPC 还支持 `target.create` / `target.update` / `target.delete` / `target.test`，但**普通外部应用（含 Chrome 扩展）走 HTTP 即可**，HTTP 只负责发送，不能创建目标。

---

## 5. 微信渠道的硬性限制（决定扩展怎么设计）

1. **只能发给和该机器人真的聊过的微信用户**。iLink 服务端要求存在会话关系；给陌生人主动发消息会失败（`target-rejected` 422 / 平台 `ret=-2 prepare failed`）。
2. **主动发送依赖 Host 缓存的「最近一次对应用户的 `context_token`」**。该上下文只保存在 Host 的账号状态里（实测可在 `~/.dsh/integrations/dsh-weixin/accounts/<botId>/state.json` 的 `contextTokens.users.<openid>.{token,seq,messageTimeMs,receivedAt}` 看到），不下发给调用方，也不写进投递目标。
   - **Host 重启**：从账号状态恢复，通常无需重新发消息（插件文档口径；任务简报里「重启必须重发」更保守——实际上如果重启后首次投递失败，仍按第 3 点处理即可）。
   - **升级插件后首次使用**：需要该用户先给机器人发一条消息来建立缓存。
   - **重新绑定机器人 / 更换登录凭据**：上下文被清理，**必须**让用户先给机器人发一条消息。
3. **出现 `ret=-2 prepare failed`（表现为 HTTP 502 `delivery-failed`）时**：让目标用户先给机器人发一条消息，然后再重试。**不要**用定时心跳反复重试——插件文档明确说明反复发心跳不会续期，只会放大失败。
4. **长文本按 1,800 字符分段**，每段占**一次**平台发送额度；分段不解除额度限制。中途被拒或结果不确定时停止并报错，不重发已接受的段。
   - 实测：接口层只卡 1 MiB body，`text` 200 KiB 都能通过 HTTP 放进业务层；但那会变成约 112 段微信消息。**扩展侧务必自己截断**，建议单条 ≤ 1800 字符，并在文本里保留差异摘要而不是整页 HTML。
5. 微信主动投递**只发非空文字**：没有图片、文件、卡片、富文本；`format:"markdown"` 在微信侧按完整文本处理（保留代码和链接目标，不渲染成卡片）。
6. 插件**不保存主动投递历史**，不生成 `deliveryHandle`/`idempotencyKey`，**不自动重试**。调用方超时后重试可能产生重复消息 → 扩展要自己做「同一变化只发一次」的去重（哈希 + 发送结果记录）。
7. 机器人离线时仍可编辑目标，但**不能测试、不能主动发送**（返回 503 `bot-not-connected`）。

---

## 6. Chrome 扩展接入要点

### 6.1 manifest 权限

`background.js`（Service Worker）里 `fetch('http://127.0.0.1:52020/...')` 需要 `host_permissions` 覆盖该地址，例如：

```json
{
  "host_permissions": ["http://127.0.0.1/*", "http://localhost/*"]
}
```

有 `host_permissions` 时，扩展后台的 fetch **不受 CORS 约束**（实测接口也确实不返回任何 CORS 头）。但 `options.html` / `popup.html`（扩展页面）发同样的请求时按普通网页 CORS 规则处理，**会被拦截**——所以投递只放在 background 做，页面通过 `chrome.runtime.sendMessage` 通知后台。扩展页面里不要直接调这个接口。

### 6.2 最小请求代码

```js
async function deliver(botId, targetId, text, dshBaseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000); // 微信分段发送可能较慢
  try {
    const res = await fetch(`${dshBaseUrl}/api/dsh-im/delivery/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // 必填，否则 415
      body: JSON.stringify({ botId, targetId, text }),  // 不要加多余字段，否则 400
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.sent === true) return { ok: true };
    return {
      ok: false,
      status: res.status,
      code: body?.error?.code ?? 'invalid-response',
      message: body?.error?.message ?? '',
      retryable: res.status === 503, // 只有机器人离线时适合“稍后重试”
    };
  } catch (err) {
    // 超时/网络中断：结果不确定，消息可能已发出 → 不要盲目重试
    return { ok: false, status: 0, code: err?.name === 'AbortError' ? 'timeout' : 'network-error', uncertain: true };
  } finally {
    clearTimeout(timer);
  }
}
```

### 6.3 扩展侧必须自己做的事

- **截断**：微信单条约 1,800 字符上限最稳；先做“变化摘要”（新增标题/关键行），再截断，尾部加「…（已截断）」。
- **去重**：一次内容变化只投递一次；记录 `hash + sentAt + 失败原因` 到 `chrome.storage.local`，失败重试用指数退避，且超时/结果不确定时不重发。
- **不心跳**：不要用高频定时任务试探接口，`ret=-2` 靠用户发消息解决。
- **配置可改**：`dshBaseUrl` 必须用户可配置，因为端口每次启动可能不同；`botId`/`targetId` 来自「复制调用参数」，不要硬编码。

---

## 7. 安全说明

- **投递接口没有鉴权**：任何能访问该地址的本机/局域网进程都可以借这个接口给已配置目标发消息。所以**不要把 Host 端口映射到公网**；需要跨机调用时只在可信局域网 + 防火墙/反向代理后面用。
- **没有 CORS 保护**（也无 CORS 支持）：浏览器同源策略帮不上忙，普通网页反而因为 CORS 被拦；真正的边界是“谁能连上这个端口”。
- **Host 其它路由不是公开的**：实测访问错误路径或站点根路径会得到 `401 unauthorized`。如果你看到 401，99% 是**路径写错/端口对不上**，不是接口需要鉴权。
- **端口会变**：插件文档示例是 `3080`，本机实测是 `52020`。扩展里必须以 Host 启动时显示的地址为准，并提供设置项。
- `botId` 是公开标识，不是凭据，但它能定位“哪个机器人”；`targetId` 决定“发给谁”。两者一并泄露等于泄露了投递能力（虽然仍需要能访问本机端口）。日志里不要打印完整 `targetId` 之外的敏感信息，也不要记录微信用户 ID / token。

---

## 8. 微信渠道手动填写字段（多渠道速查）

优先「从已聊会话选择」。只有目标不在候选里时才手动填平台原生 ID。

| 渠道 | 目标类型（`kind`） | 需要填写 | 说明 |
| --- | --- | --- | --- |
| 微信 | `user` | `toUserId` | 微信用户 ID，形如 `o…@im.wechat` |
| 飞书 | `user` / `group` | `openId` / `chatId` | `ou_…` / `oc_…` |
| 钉钉 | `user` / `group` | `userId` / `openConversationId` | 主动投递不用临时 `sessionWebhook` |
| 企业微信 | `user` / `group` | `chatId` | 私聊填用户 ID，群聊填群 `chatid` |
| 企业微信应用 | `user` / `group` | `chatId` | 同上 |
| QQ | `user` / `group` | `userOpenId` / `groupOpenId` | 平台 `*_openid` |
| Slack | `conversation` / `thread` | `channelId` (+`threadTs`) | Thread 需要两个字段 |
| Telegram | `chat` / `topic` | `chatId` (+`messageThreadId`) | 十进制字符串；Topic ID 正整数 |
| Discord | `channel` | `channelId` | 私信/频道/Thread 都用可发消息的 Channel ID |
| WhatsApp | `user` / `group` | `jid` | `…@s.whatsapp.net` / `…@g.us` |
| Matrix / iMessage / 邮箱 | 见插件文档 | 见插件文档 | 插件已扩展支持 |

完整九渠道字段以插件文档「九渠道手动填写字段」为准；本机当前只接入了微信。

---

## 9. 错误码全表与修法

### 9.1 HTTP 接口能返回的错误码（按 HTTP 状态排）

| HTTP | `error.code` | 含义 | 处理建议 |
| --- | --- | --- | --- |
| 200 | —（`{"sent":true}`） | 平台接口已接受发送 | 只代表“已提交”，不代表送达/已读；不要把“用户已读”写进 UI |
| 400 | `bad-request` | JSON 非法 / body 为空 / 字段名缺失 / 多余字段 / `text` 为空白或非字符串 / `format` 非 plain\|markdown / ID 格式非法 | 检查字段名与类型，删掉多余字段；`text` 先 `trim()` 判空；`format` 只用 `plain`/`markdown` |
| 405 | `method-not-allowed` | 用了 GET/PUT/DELETE/OPTIONS 等 | 只能 `POST`；响应带 `allow: POST` |
| 413 | `payload-too-large` | JSON body > 1 MiB（含正好 1 MiB 时放行，实测 1 048 577 字节即 413） | 缩短 `text`（扩展侧按 1800 字符/条截断即可，远低于上限）；不要靠压缩或分多字段塞 |
| 415 | `unsupported-media-type` | 缺失或非 `application/json` 的 `Content-Type` | 显式设置 `Content-Type: application/json`；`application/json; charset=utf-8` 也可以 |
| 404 | `unknown-bot` | `botId` 不属于当前 Host | 重新从设置页复制 Bot ID；确认连的是同一个 Host（多 profile/多实例会各有各的 bot）；重启/重装后重新复制 |
| 404 | `unknown-target` | 该机器人下不存在这个 `targetId` | 到设置页目标列表核对；目标被删、复制错、或用了别的机器人的 targetId。HTTP 没有列目标的接口，只能看设置页 |
| 408 | `cancelled` | 调用被取消（客户端断开/超时） | 不要自动重发；结果不确定，先核对平台侧 |
| 422 | `target-rejected` | 平台明确拒绝目标或缺发送权限 | 微信：确认该用户与该机器人聊过；`ret=-2 prepare failed` → 让用户先发消息再试；检查平台权限/额度 |
| 502 | `delivery-failed` | 网络、平台或无法安全细分的失败 | 看 Host 日志与账号「最近消息错误」；不要盲目重试（可能已发出） |
| 503 | `bot-not-connected` | 机器人离线 | 到设置页看连接状态、重新登录/扫码；恢复后由业务决定是否重试（注意防重复） |
| 401 | —（纯文本 `unauthorized`） | **Host 其它路由**的兜底，不是投递接口的错误 | 说明 URL 路径拼错（如尾斜杠）或端口/base 写错；按 `…/api/dsh-im/delivery/messages` 逐字核对 |
| 连接失败 | `ECONNREFUSED` 等 | Host 没运行 / 端口不对 | 启动 DSH 桌面端；用启动时显示的地址；排查防火墙/代理 |

### 9.2 只在管理 RPC / 同 Host Service 出现的错误码

HTTP 发送路径**不会**返回下面这些（因为 HTTP 只能发送、不能建目标）：

| `error.code` | 出现场景 | 修法 |
| --- | --- | --- |
| `target-conflict`（409） | `target.create` 时 `targetId` 已存在 | 换别名，或先删除旧目标 |
| `invalid-target`（422） | `target.create`/`update` 时类型或平台 ID 不符合渠道规则 | 重选类型、核对原生 ID，去掉多余字段 |
| `session-sync-unavailable` | 私聊双向同步：目标不是当前 Host 的可确认私聊 / 尚无 Session / 渠道用远程 Harness | 从已聊私聊建目标并建立 Session |
| `account-unverified` / `account-changed` / `target-changed` / `capability-unavailable` / `stale-route` / `reply-result-unknown` / `history-*` | 条件投递（`sendChecked`）与独占收件契约，仅飞书/Lark | 见插件文档「Companion Plugin 的条件主动发送」 |

> 也就是说：**扩展正常只需要处理 400 / 404 / 405 / 408 / 413 / 415 / 422 / 502 / 503 / 200**，其余错误码不会出现在 HTTP 发送路径上。唯一例外：如果磁盘上已保存的目标配置损坏，发送阶段的适配器校验也可能抛出 `invalid-target`（422），此时只能在设置页编辑/重建该目标。

---

## 10. 与插件权威文档的对照：对齐点与差异

### 10.1 完全对齐

- 路径、方法、字段、`format` 取值、严格字段校验、1 MiB 上限、无鉴权、无 CORS、`{sent:true}` 语义、错误码 → HTTP 状态映射（400/404/409/422/503/502/408）全部一致。
- `bad-request` 400、`unknown-bot` 404、`unknown-target` 404、`target-rejected` 422、`bot-not-connected` 503、`delivery-failed` 502 均与文档表一致。

### 10.2 文档未写明、本次实测补充

| 现象 | 实测细节 | 对扩展的影响 |
| --- | --- | --- |
| 校验顺序 | `方法 → Content-Type → 体积 → 字段 → bot → target` | 别用 415 反推字段问题；先用同一份 body 排查 CT |
| 405 带 `allow: POST` | 实测响应头存在 | 排错时可据此确认路由命中 |
| 错误路径返回 **401 纯文本** | 尾斜杠/错路径 → `401 unauthorized`；查询串不影响匹配 | 401 不代表“接口要鉴权” |
| `bad-request` 的 `message` 有两种 | 传输层为 `bad-request`，字段校验为 `Invalid delivery request.` | **只依据 `code` 分支**，不要匹配 message |
| 1 MiB 边界 | 恰好 1 048 576 字节放行，+1 字节 413 | 边界包含，无需预留 1 字节 |
| OPTIONS | 405，无 CORS 预检 | 扩展后台 fetch 不要带自定义头触发预检（带上也只会 405，但后台不受影响） |
| `>1 MiB + text/plain` | 先 415，不是 413 | 同上 |

### 10.3 与「任务简报」假设的差异（重要）

- 简报假设「投递要用 `bot_` 形式的公开 ID」。**不对**：`bot_<24 hex>` 是**飞书**渠道的 botId 形态；**微信**渠道的公开 botId 是 `wx_<24 hex>`（实测 `wx_XXXX…XXXX` 被 Host 识别并返回 `unknown-target` 而非 `unknown-bot`）。
- 插件文档本身也是这个口径：*「不要根据前缀推断渠道」*。**结论：`botId` 必须以设置页「复制调用参数」为准，任何渠道都不能靠前缀猜。**
- 简报说「重启/重新绑定后需用户再发一条」。插件文档更精确：`context_token` 存在 Host 账号状态里、**重启后恢复**；**升级后**需要一次用户消息建立缓存；**重新绑定并更换登录凭据后**清理上下文。实测账号 `state.json` 里确实持久化了 `contextTokens…`，支持「重启可恢复」的说法。稳妥做法：凡是首次投递失败并出现 `ret=-2`，都让用户发一条消息再试（两种口径最终都落到这一条）。

---

## 11. 复现方式与本次真实输出

### 11.1 运行探测脚本

```bash
# 仓库根目录，零依赖，不需要 npm install
node tools/probe-delivery.mjs
node tools/probe-delivery.mjs --base http://127.0.0.1:52020
node tools/probe-delivery.mjs --base http://127.0.0.1:52020 --bot-id <真实botId>                # 只读判别 bot 是否已注册
node tools/probe-delivery.mjs --base http://127.0.0.1:52020 --bot-id <真实botId> --target-id <真实targetId>  # 会真实发送一条
node tools/probe-delivery.mjs --json            # 供 CI 消费
```

退出码：`0` 全部符合契约 / `1` 有 UNEXPECTED / `2` 连不上 Host 或参数错误。
**默认只用假 ID（`probe_bot`/`probe_target`），不会给任何真实目标发消息。**

### 11.2 本次运行输出（节选，去掉颜色码）

```text
── 环境 ────────────────────────────────────────────────
  base      = http://127.0.0.1:52020
  endpoint  = http://127.0.0.1:52020/api/dsh-im/delivery/messages
  node      = v24.15.0
  真实 ID   = 未提供 → 只做只读探测，绝不发送真实消息

── 协议与字段探测（22 项） ─────────────────────────────

[01] GET 同路径
     期望：405 method-not-allowed
     实测：HTTP 405 method-not-allowed
     body：{"error":{"code":"method-not-allowed","message":"method-not-allowed","details":{}}}
     allow：POST
     结果：PASS

[03] 合法结构 + 不存在的 botId
     实测：HTTP 404 unknown-bot
     结果：PASS

[07] 缺全部字段（{}）
     实测：HTTP 400 bad-request（Invalid delivery request.）
     结果：PASS

[18] text=200 KiB（总 body <1 MiB）
     实测：HTTP 404 unknown-bot
     结果：PASS

[19] body 恰好 1048576 字节
     实测：HTTP 404 unknown-bot（边界放行）
     结果：PASS

[20] body 1048577 字节
     实测：HTTP 413 payload-too-large
     结果：PASS

[21] 路径带尾斜杠（…/messages/）
     实测：HTTP 401
     body：unauthorized
     结果：PASS

── CORS 实测 ───────────────────────────────────────────
  GET 同路径：access-control-allow-origin = （不存在）
  OPTIONS 预检（模拟浏览器 CORS preflight）：access-control-allow-origin = （不存在）
  合法结构 + 不存在的 botId：access-control-allow-origin = （不存在）
  ! 结论：接口不返回任何 CORS 响应头 → 普通网页 fetch 会被浏览器 CORS 拦截。
  !       Chrome 扩展 background service worker 在 host_permissions 覆盖该地址时不受 CORS 约束。

── 真实发送 ────────────────────────────────────────────
  ! SKIP：未提供 --bot-id，因此不进行真实发送。

── 汇总 ────────────────────────────────────────────────
  探测项 22 个，PASS 22 个，UNEXPECTED 0 个
  ✓ 全部探测项与 @xmanrui/dsh-im 的 HTTP 契约一致。
```

真实 botId 只读判别（`--bot-id wx_XXXX…XXXX`，**未发送任何消息**）：

```text
── 真实 botId 只读判别（--bot-id，不发送任何消息） ─────────────
  botId     = wx_XXXXXXXXXXXXXXXXXXXXXXXX
  targetId  = probe_missing_mvxq2dmk_93cf310c（随机生成，必然不存在，因此只会在查找目标阶段返回 404）
  响应       = HTTP 404 {"error":{"code":"unknown-target","message":"unknown-target","details":{}}}
  ✓ 结论：该 botId 已被当前 Host 注册并可被投递服务解析；只是该随机 targetId 未配置。
  ✓       说明「机器人侧」是通的，端到端能否送达取决于是否存在已保存目标（targetId）。

── 真实发送 ────────────────────────────────────────────
  ! SKIP：未提供 --target-id，因此不进行真实发送。
    原因：真实发送需要 DSH 设置页里「复制调用参数」得到的 botId + targetId 组合；
    本脚本不会猜测 targetId，也不会创建投递目标。
```

连接失败时的表现（`--base http://127.0.0.1:59999`，退出码 2）：

```text
  ✗ GET 同路径：连不上 Host。请求 GET http://127.0.0.1:59999/api/dsh-im/delivery/messages 失败：ECONNREFUSED
  ✗ 请确认 DSH 桌面端正在运行，且 --base 与 Host 启动时显示的地址一致（端口会变）。
  ✗ 无法连接 Host，未完成任何协议探测。
  排查顺序：① DSH 桌面端是否在运行；② --base 是否是 Host 启动时显示的真实地址（端口会变）；
            ③ 本机防火墙/代理是否拦了 127.0.0.1；④ 是否把 http:// 写成了 https://。
```

### 11.3 「从微信主动投递当前是否真的可用」的判断依据

| 已证实 | 依据 |
| --- | --- |
| Host 在跑、接口已注册、路由精确 | GET → 405 + `allow: POST`；22 项探测全 PASS |
| 微信机器人已接入且被 Host 的投递服务识别 | 用真实 `botId` + 随机不存在 `targetId` → **404 `unknown-target`**（若是未接入会得到 `unknown-bot`） |
| 协议/校验/错误码与插件文档一致 | 第 3、10 节实测 |
| 该用户与机器人有近期会话（上下文可能可恢复） | 账号 `state.json` 里有 `contextTokens.users.<openid>`（`seq`、`messageTimeMs`、`receivedAt`）与 `recentOutboundMessages`，说明近期双向消息存在（**内容此处已脱敏**） |

| 未证实 | 原因 |
| --- | --- |
| `200 {"sent":true}` 成功路径 | 该 bot 下**没有已保存的投递目标**：随机 `targetId` 一律 `404 unknown-target`；且 `~/.dsh/integrations/` 下没有任何目标记录（无 `deliveryTargets` / `targetId` 持久化），所以永远走到 404，无法进入发送阶段 |
| 微信真正把消息投到手机 | 同上，未触达平台；也**没有发送任何真实消息**（本次全程只读探测） |
| `context_token` 当前是否仍被平台接受 | 需要真实发送一次才能知道；若届时出现 `ret=-2 prepare failed`，按第 5 节让用户先给机器人发一条消息再试 |

**要完成端到端验证**，请按第 4 节建好目标，然后：

```bash
node tools/probe-delivery.mjs --base http://127.0.0.1:52020 \
  --bot-id "<设置页复制的 Bot ID>" --target-id "<设置页复制的 Target ID>"
```

脚本会真实发送一条内容明确的探测消息（`[DSH-IM 探测] … 请忽略。`），并打印 `HTTP 200 {"sent":true}` 或具体错误码。**这一步会到达微信，属于有意为之的验证，请确认后再执行。**

---

## 12. 排错速查（三个最常见故障）

### 故障 A：`unknown-bot`（404）

判断：`botId` 不在当前 Host 的注册表里。
排查路径：
1. 打开设置 → IM机器人 → 对应机器人 → 齿轮 → 「调用标识」，重新复制 Bot ID；
2. 确认连的是**同一个 Host**：DSH 可能同时跑多个 profile / 多个实例，端口不同 → 各自 botId 不同；
3. 机器人被移除后重装/重连，`botId` 可能变化，目标也会被清理，需要重新复制并重建目标；
4. 用脚本判定：`node tools/probe-delivery.mjs --bot-id <botId>` → 若仍 `unknown-bot`，就是 ID 或 Host 不对；若变成 `unknown-target`，ID 是对的，问题在目标。

### 故障 B：`unknown-target`（404）

判断：`botId` 对，但该机器人下没有这个 `targetId`。
排查路径：
1. 设置页目标列表里逐字核对 `targetId`（保存后不可改名，改名只能新建目标）；
2. 目标是否被删除、或建在了**另一个机器人**下面（`targetId` 只在同一机器人下唯一）；
3. `targetId` 是否被复制成了显示名称或平台原生 ID（如 `o…@im.wechat`）——它应该是 `tgt_xxx` / `release-alerts` 这类别名；
4. HTTP 没有「列目标」接口，只能看设置页；拿到正确值后重新填扩展配置。

### 故障 C：`bot-not-connected`（503）+ 微信 `target-rejected`（422）

判断：机器人离线（503）或平台拒绝该目标（422）。微信侧的 422 通常伴随 `ret=-2 prepare failed`。
排查路径：
1. 设置页看机器人连接状态；离线就重新登录/扫码，等状态在线；
2. 微信 422 / `ret=-2`：**让目标用户先给机器人发一条消息**（重建 `context_token`），再重试；不要用心跳反复刷；
3. 确认该微信用户确实与机器人聊过（候选下拉里出现过）；给没聊过的人主动发必然被拒；
4. 检查是否超过平台发送额度（长文本 1800 字符一段，每段都算一次）；
5. `delivery-failed`（502）出现时不要盲目重试——可能已经发出；先看 DSH 账号的「最近消息错误」和 Host 日志，再决定是否人工重发。

---

## 13. 未验证项与限制（诚实声明）

1. **从未触发真实发送**：没有已保存目标，`200 {"sent":true}` 未实测；第 2.4 节的成功响应来自插件文档。
2. 微信平台侧的送达/额度/`ret=-2` 行为**未实测**（需要真实目标且会打扰用户），本文只引用插件文档结论。
3. 只验证了微信渠道；飞书/钉钉/企微/QQ/Slack/Telegram/Discord/WhatsApp 未接入，未验证。
4. 管理 RPC（`target.*`、`message.send`）与同 Host `ctx.dshIm.send()` 路径未验证，本文只覆盖 HTTP。
5. CORS 结论针对「无响应头」这一实测事实；扩展后台不受 CORS 限制这一点基于 Chrome 扩展 `host_permissions` 机制，未在真实扩展里跑通端到端（扩展尚在开发中）。
6. Host 端口会变，本文出现的 `52020` 只是本次运行的地址。
