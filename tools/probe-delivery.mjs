#!/usr/bin/env node
// DSH-IM 主动投递 HTTP 接口探测脚本（零依赖，仅用 node: 内置能力）
//
// 用途：在不向任何真实微信/IM 目标发送消息的前提下，验证
//   POST {base}/api/dsh-im/delivery/messages
// 的 HTTP 协议行为、字段校验、1 MiB 体积上限、CORS 头、以及 botId 是否已被当前 Host 注册。
//
// 用法：
//   node tools/probe-delivery.mjs
//   node tools/probe-delivery.mjs --base http://127.0.0.1:52020
//   node tools/probe-delivery.mjs --base http://127.0.0.1:52020 --bot-id wx_xxxxxxxxxxxxxxxxxxxxxxxx
//   node tools/probe-delivery.mjs --bot-id wx_xxxx --target-id release-alerts   # 会真实发送一条消息
//
// 参数：
//   --base <url>       Host 地址，默认 http://127.0.0.1:52020（尾斜杠会被去掉）
//   --bot-id <id>      真实 botId（从 DSH 设置页「调用标识」复制）。给了它但没给 --target-id 时，
//                       脚本只做「botId 是否已注册」的只读判别（用一个一定不存在的 targetId 探测），
//                       绝不会触达任何平台发送接口。
//   --target-id <id>   真实 targetId。与 --bot-id 同时给出时，脚本会真实发送一条标记清楚的探测消息。
//   --timeout <ms>     单请求超时，默认 10000
//   --json             以 JSON 打印每个探测结果（便于 CI 消费）
//   --help             打印帮助
//
// 退出码：0 = 全部符合预期；1 = 存在与契约不符的探测项；2 = 连不上 Host/参数错误。
// 安全：本脚本默认只用「明显不存在」的假 ID（probe_bot / probe_target），
//       假 ID 在任何实现下都只会得到 404，不会产生真实消息。

const DEFAULT_BASE = 'http://127.0.0.1:52020';
const PATH = '/api/dsh-im/delivery/messages';
const LIMIT = 1024 * 1024; // Host 端 1 MiB JSON 上限

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, botId: null, targetId: null, timeout: 10000, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`${a} 需要一个值`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--base': out.base = next(); break;
      case '--bot-id': out.botId = next(); break;
      case '--target-id': out.targetId = next(); break;
      case '--timeout': {
        const raw = next();
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) fail('--timeout 必须是正数毫秒');
        out.timeout = n;
        break;
      }
      case '--json': out.json = true; break;
      case '--help': case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        fail(`未知参数 ${a}（用 --help 查看用法）`);
    }
  }
  if (out.base.endsWith('/')) out.base = out.base.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(out.base)) fail('--base 必须以 http:// 或 https:// 开头');
  if (out.targetId && !out.botId) fail('--target-id 必须与 --bot-id 一起给出');
  return out;
}

const HELP = `DSH-IM 主动投递接口探测（只读，零依赖）

node tools/probe-delivery.mjs [--base http://127.0.0.1:52020]
                              [--bot-id <真实botId> [--target-id <真实targetId>]]
                              [--timeout 10000] [--json]

说明：
  * 默认只发探测请求，使用明显不存在的假 ID，绝不会发送真实消息。
  * 只给 --bot-id 时：用一个一定不存在的 targetId 判别该 botId 是否已被当前 Host 注册，仍然不会发送消息。
  * 同时给 --bot-id 与 --target-id 时：会真实发送一条探测消息到该目标（这一步可能到达微信）。
`;

function truncate(text, max = 240) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}… (共 ${s.length} 字符)`;
}

function headerObject(headers) {
  const obj = {};
  for (const [k, v] of headers.entries()) obj[k.toLowerCase()] = v;
  return obj;
}

async function request(base, { method, path = PATH, headers = {}, body, timeout }) {
  const url = `${base}${path}`;
  const init = { method, headers, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) init.body = body;
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || err?.name || String(err);
    const e = new Error(`请求 ${method} ${url} 失败：${cause}`);
    e.connectionError = true;
    e.url = url;
    throw e;
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return {
    status: res.status,
    headers: headerObject(res.headers),
    text,
    json,
    bodyBytes: Buffer.byteLength(text),
  };
}

function errorCode(res) {
  return res.json?.error?.code ?? null;
}

function errorMessage(res) {
  return res.json?.error?.message ?? null;
}

function makeCases(base, opts) {
  const jsonHeaders = { 'content-type': 'application/json' };
  const fakeBot = 'probe_bot';
  const fakeTarget = 'probe_target';
  const send = (body, { headers = jsonHeaders } = {}) =>
    request(base, { method: 'POST', headers, body, timeout: opts.timeout });

  /** 每个探测项：name/why + expect（判定函数）+ run（返回 Response） */
  return [
    {
      id: 'get-method',
      name: 'GET 同路径',
      why: 'HTTP 分发层：只接受 POST，非 POST 应被 405 拒绝',
      expect: (r) => r.status === 405 && errorCode(r) === 'method-not-allowed',
      expected: '405 method-not-allowed',
      run: () => request(base, { method: 'GET', timeout: opts.timeout }),
    },
    {
      id: 'options-preflight',
      name: 'OPTIONS 预检（模拟浏览器 CORS preflight）',
      why: '检查是否提供 CORS 预检支持；返回 405 说明没有 CORS 层',
      expect: (r) => r.status === 405 && errorCode(r) === 'method-not-allowed',
      expected: '405 method-not-allowed（无 CORS 预检）',
      run: () => request(base, {
        method: 'OPTIONS',
        headers: {
          origin: 'chrome-extension://probe',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
        timeout: opts.timeout,
      }),
    },
    {
      id: 'valid-shape-unknown-bot',
      name: '合法结构 + 不存在的 botId',
      why: '字段全部合法后进入业务层；不存在的 botId 应为 404 unknown-bot',
      expect: (r) => r.status === 404 && errorCode(r) === 'unknown-bot',
      expected: '404 unknown-bot',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'probe' })),
    },
    {
      id: 'format-markdown',
      name: '合法结构 + format=markdown',
      why: 'format 被接受，随后仍因 bot 不存在而 404',
      expect: (r) => r.status === 404 && errorCode(r) === 'unknown-bot',
      expected: '404 unknown-bot',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'probe', format: 'markdown' })),
    },
    {
      id: 'empty-body',
      name: '空 body',
      why: 'JSON 解析失败应 400 bad-request',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request' && errorMessage(r) === 'bad-request',
      expected: '400 bad-request（message=bad-request）',
      run: () => send(''),
    },
    {
      id: 'invalid-json',
      name: '非法 JSON（{bad）',
      why: 'JSON 解析失败应 400 bad-request',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request',
      expected: '400 bad-request',
      run: () => send('{bad'),
    },
    {
      id: 'empty-object',
      name: '缺全部字段（{}）',
      why: '结构校验在业务层之前完成，应 400 bad-request',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request' && errorMessage(r) === 'Invalid delivery request.',
      expected: '400 bad-request（message=Invalid delivery request.）',
      run: () => send('{}'),
    },
    {
      id: 'missing-text',
      name: '缺 text',
      why: 'text 必填，应 400',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request',
      expected: '400 bad-request',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget })),
    },
    {
      id: 'blank-text',
      name: 'text 全空白（"   "）',
      why: '只发送非空文字；trim 后为空应 400',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request',
      expected: '400 bad-request',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: '   ' })),
    },
    {
      id: 'text-not-string',
      name: 'text 不是字符串（123）',
      why: '类型校验，应 400',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request',
      expected: '400 bad-request',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 123 })),
    },
    {
      id: 'extra-field',
      name: '多余字段（extra:1）',
      why: '接口严格校验字段，附加字段应 400',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request',
      expected: '400 bad-request',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'probe', extra: 1 })),
    },
    {
      id: 'bad-format',
      name: '非法 format（html）',
      why: 'format 只接受 plain/markdown，应 400',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request',
      expected: '400 bad-request',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'probe', format: 'html' })),
    },
    {
      id: 'bad-bot-id-chars',
      name: 'botId 含非法字符（bot.bad）',
      why: 'botId 只允许 [A-Za-z0-9_-]{1,128}，应 400',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request',
      expected: '400 bad-request',
      run: () => send(JSON.stringify({ botId: 'bot.bad', targetId: fakeTarget, text: 'probe' })),
    },
    {
      id: 'empty-target-id',
      name: '空 targetId',
      why: 'targetId 长度 1–128，应 400',
      expect: (r) => r.status === 400 && errorCode(r) === 'bad-request',
      expected: '400 bad-request',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: '', text: 'probe' })),
    },
    {
      id: 'content-type-text-plain',
      name: 'Content-Type: text/plain',
      why: '只接受 application/json，应 415 unsupported-media-type',
      expect: (r) => r.status === 415 && errorCode(r) === 'unsupported-media-type',
      expected: '415 unsupported-media-type',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'probe' }), { headers: { 'content-type': 'text/plain' } }),
    },
    {
      id: 'content-type-missing',
      name: '完全不带 Content-Type',
      why: '同上，应 415（用 Uint8Array 发送以避开 fetch 自动补 text/plain）',
      expect: (r) => r.status === 415 && errorCode(r) === 'unsupported-media-type',
      expected: '415 unsupported-media-type',
      run: () => send(new TextEncoder().encode(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'probe' })), { headers: {} }),
    },
    {
      id: 'content-type-with-charset',
      name: 'Content-Type: application/json; charset=utf-8',
      why: '带参数仍应被接受（按分号前 MIME 判定）',
      expect: (r) => r.status === 404 && errorCode(r) === 'unknown-bot',
      expected: '404 unknown-bot（说明 MIME 判定通过）',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'probe' }), { headers: { 'content-type': 'application/json; charset=utf-8' } }),
    },
    {
      id: 'text-200kb',
      name: 'text=200 KiB（总 body <1 MiB）',
      why: '体积上限只卡 body 总字节；200 KiB 应放行到业务层（随后 404 unknown-bot）',
      expect: (r) => r.status === 404 && errorCode(r) === 'unknown-bot',
      expected: '404 unknown-bot（未被体积上限拦截）',
      run: () => send(JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'x'.repeat(200 * 1024) })),
    },
    {
      id: 'body-exactly-1mib',
      name: `body 恰好 ${LIMIT} 字节`,
      why: '边界包含：等于上限应放行',
      expect: (r) => r.status === 404 && errorCode(r) === 'unknown-bot',
      expected: '404 unknown-bot（边界放行）',
      run: () => send(padBodyTo(LIMIT)),
    },
    {
      id: 'body-1mib-plus-1',
      name: `body ${LIMIT + 1} 字节`,
      why: '超过 1 MiB 应在 HTTP 层直接 413，不进入业务层',
      expect: (r) => r.status === 413 && errorCode(r) === 'payload-too-large',
      expected: '413 payload-too-large',
      run: () => send(padBodyTo(LIMIT + 1)),
    },
    {
      id: 'path-trailing-slash',
      name: '路径带尾斜杠（…/messages/）',
      why: '路由按精确路径注册；尾斜杠不匹配时应落到 Host 其他层（实测 401），说明路径必须逐字一致',
      expect: (r) => r.status === 401,
      expected: '401 unauthorized（Host 兜底，而非接口自身的 404）',
      run: () => request(base, { method: 'POST', path: `${PATH}/`, headers: jsonHeaders, body: JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'probe' }), timeout: opts.timeout }),
    },
    {
      id: 'path-with-query',
      name: '路径带查询串（…/messages?probe=1）',
      why: '查询串不影响路由匹配',
      expect: (r) => r.status === 404 && errorCode(r) === 'unknown-bot',
      expected: '404 unknown-bot',
      run: () => request(base, { method: 'POST', path: `${PATH}?probe=1`, headers: jsonHeaders, body: JSON.stringify({ botId: fakeBot, targetId: fakeTarget, text: 'probe' }), timeout: opts.timeout }),
    },
  ];
}

function padBodyTo(totalBytes) {
  // 构造一个「合法字段 + 填充 text」且总字节数恰好为 totalBytes 的 body
  const skeleton = JSON.stringify({ botId: 'probe_bot', targetId: 'probe_target', text: '' });
  const padding = totalBytes - Buffer.byteLength(skeleton);
  if (padding < 0) throw new Error('目标字节数小于骨架长度');
  const body = JSON.stringify({ botId: 'probe_bot', targetId: 'probe_target', text: 'x'.repeat(padding) });
  if (Buffer.byteLength(body) !== totalBytes) throw new Error(`构造 body 长度不符：${Buffer.byteLength(body)} != ${totalBytes}`);
  return body;
}

function randomMissingTargetId() {
  return `probe_missing_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

async function probeKnownBot(base, opts, log) {
  const targetId = randomMissingTargetId();
  log.section('真实 botId 只读判别（--bot-id，不发送任何消息）');
  log.info(`botId     = ${opts.botId}`);
  log.info(`targetId  = ${targetId}（随机生成，必然不存在，因此只会在查找目标阶段返回 404）`);
  const res = await request(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botId: opts.botId, targetId, text: 'probe' }),
    timeout: opts.timeout,
  });
  const code = errorCode(res);
  log.info(`响应       = HTTP ${res.status} ${truncate(res.text)}`);
  if (code === 'unknown-bot') {
    log.warn('结论：该 botId 当前未被运行中的 Host 注册（可能未接入、或 Host 重启后未加载该机器人）。');
  } else if (code === 'unknown-target') {
    log.ok('结论：该 botId 已被当前 Host 注册并可被投递服务解析；只是该随机 targetId 未配置。');
    log.ok('      说明「机器人侧」是通的，端到端能否送达取决于是否存在已保存目标（targetId）。');
  } else if (code === 'bot-not-connected') {
    log.warn('结论：botId 存在但机器人当前离线（503 bot-not-connected），恢复连接后才能测试/投递。');
  } else {
    log.warn(`结论：未预期的响应（code=${code ?? '无'}），请结合 Host 日志排查。`);
  }
  return res;
}

async function probeRealSend(base, opts, log) {
  log.section('真实发送（--bot-id 与 --target-id 均已提供）');
  const text = `[DSH-IM 探测] 主动投递接口连通性测试 ${new Date().toISOString()}，请忽略。`;
  log.warn(`即将向目标发送一条真实消息：botId=${opts.botId} targetId=${opts.targetId}`);
  log.info(`text      = ${text}`);
  const res = await request(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botId: opts.botId, targetId: opts.targetId, text }),
    timeout: opts.timeout,
  });
  if (res.status === 200 && res.json?.sent === true) {
    log.ok(`发送成功：HTTP 200 ${truncate(res.text)}（{sent:true} 只代表平台接受请求，不代表已读）`);
    return true;
  }
  log.err(`发送失败：HTTP ${res.status} ${truncate(res.text)}`);
  return false;
}

function makeLogger(json) {
  const rows = [];
  const api = {
    section(title) { if (!json) console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`); },
    info(msg) { if (!json) console.log(`  ${msg}`); },
    ok(msg) { if (!json) console.log(`  \x1b[32m✓\x1b[0m ${msg}`); },
    warn(msg) { if (!json) console.log(`  \x1b[33m!\x1b[0m ${msg}`); },
    err(msg) { if (!json) console.log(`  \x1b[31m✗\x1b[0m ${msg}`); },
    record(row) { rows.push(row); },
    rows,
  };
  return api;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = makeLogger(opts.json);
  const endpoint = `${opts.base}${PATH}`;

  log.section('环境');
  log.info(`base      = ${opts.base}`);
  log.info(`endpoint  = ${endpoint}`);
  log.info(`node      = ${process.version}`);
  log.info(`time      = ${new Date().toISOString()}`);
  log.info(opts.botId
    ? `真实 ID   = botId=${opts.botId}${opts.targetId ? ` targetId=${opts.targetId}（将真实发送）` : '（仅只读判别，不发送）'}`
    : '真实 ID   = 未提供 → 只做只读探测，绝不发送真实消息');

  const cases = makeCases(opts.base, opts);
  const results = [];
  let connectionFailed = false;

  log.section(`协议与字段探测（${cases.length} 项）`);
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    let res;
    try {
      res = await c.run();
    } catch (err) {
      if (err.connectionError) {
        connectionFailed = true;
        log.err(`${c.name}：连不上 Host。${err.message}`);
        log.err('请确认 DSH 桌面端正在运行，且 --base 与 Host 启动时显示的地址一致（端口会变）。');
        break;
      }
      throw err;
    }
    const pass = c.expect(res);
    const corsHeader = res.headers['access-control-allow-origin'];
    const row = {
      id: c.id,
      name: c.name,
      expected: c.expected,
      status: res.status,
      code: errorCode(res),
      message: errorMessage(res),
      pass,
      bodyBytes: res.bodyBytes,
      allow: res.headers.allow ?? null,
      acao: corsHeader ?? null,
      body: truncate(res.text, 200),
    };
    results.push(row);
    log.record(row);
    const label = `[${String(i + 1).padStart(2, '0')}] ${c.name}`;
    if (opts.json) continue;
    console.log(`\n${label}`);
    console.log(`     期望：${c.expected}`);
    console.log(`     实测：HTTP ${res.status}${row.code ? ` ${row.code}` : ''}${row.message && row.message !== row.code ? `（${row.message}）` : ''}`);
    console.log(`     依据：${c.why}`);
    console.log(`     body：${row.body}`);
    if (row.allow) console.log(`     allow：${row.allow}`);
    console.log(`     结果：${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mUNEXPECTED\x1b[0m'}`);
  }

  if (connectionFailed) {
    log.section('汇总');
    log.err('无法连接 Host，未完成任何协议探测。');
    log.err('排查顺序：① DSH 桌面端是否在运行；② --base 是否是 Host 启动时显示的真实地址（端口会变）；');
    log.err('          ③ 本机防火墙/代理是否拦了 127.0.0.1；④ 是否把 http:// 写成了 https://。');
    process.exit(2);
  }

  {
    log.section('CORS 实测');
    const corsRows = results.filter((r) => r.id === 'get-method' || r.id === 'options-preflight' || r.id === 'valid-shape-unknown-bot');
    for (const r of corsRows) {
      log.info(`${r.name}：access-control-allow-origin = ${r.acao === null ? '（不存在）' : r.acao}`);
    }
    const anyCors = results.some((r) => r.acao !== null);
    if (!anyCors) {
      log.warn('结论：接口不返回任何 CORS 响应头 → 普通网页（http/https 源）的 fetch 会被浏览器 CORS 拦截。');
      log.warn('      Chrome 扩展的 background service worker 在 manifest host_permissions 覆盖该地址时不受 CORS 约束，');
      log.warn('      所以扩展可以直连；但 options/popup 等页面若跨源请求，同样受 CORS 限制。');
    }

    if (opts.botId) {
      try {
        await probeKnownBot(opts.base, opts, log);
        if (opts.targetId) {
          const ok = await probeRealSend(opts.base, opts, log);
          if (!ok) process.exitCode = 1;
        } else {
          log.section('真实发送');
          log.warn('SKIP：未提供 --target-id，因此不进行真实发送。');
          log.warn('      原因：真实发送需要 DSH 设置页里「复制调用参数」得到的 botId + targetId 组合；');
          log.warn('      本脚本不会猜测 targetId，也不会创建投递目标。');
        }
      } catch (err) {
        if (err.connectionError) fail(err.message);
        throw err;
      }
    } else {
      log.section('真实发送');
      log.warn('SKIP：未提供 --bot-id，因此不进行真实发送。');
      log.warn('      原因：没有真实 botId 时，任何请求只会得到 404，无法验证端到端投递；');
      log.warn('      本脚本不会猜测或伪造 botId/targetId，也不会创建投递目标。');
      log.warn('      如需判别某个 botId 是否已注册：node tools/probe-delivery.mjs --bot-id <真实 botId>');
    }
  }

  const expectedCount = results.length;
  const passCount = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);

  log.section('汇总');
  log.info(`探测项 ${expectedCount} 个，PASS ${passCount} 个，UNEXPECTED ${failed.length} 个`);
  if (failed.length) {
    for (const r of failed) log.err(`${r.name}：期望 ${r.expected}，实测 HTTP ${r.status} ${r.code ?? ''}`);
    log.err('存在与插件文档/源码契约不一致的探测项，请先排查 Host 版本或端口是否对得上。');
    process.exitCode = 1;
  } else {
    log.ok('全部探测项与 @xmanrui/dsh-im 的 HTTP 契约一致。');
  }

  if (opts.json) {
    console.log(JSON.stringify({
      base: opts.base,
      endpoint,
      node: process.version,
      time: new Date().toISOString(),
      connectionFailed,
      passCount,
      failCount: failed.length,
      results,
    }, null, 2));
  }
}

main().catch((err) => {
  console.error(`未处理的错误：${err?.stack ?? err}`);
  process.exit(1);
});
