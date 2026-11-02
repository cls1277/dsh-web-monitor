/**
 * 离屏文档：唯一职责是用 DOMParser 把 HTML 解析成 DOM，
 * 再调用 extract.js 的纯函数取出被监控的内容。
 *
 * 为什么需要它：MV3 Service Worker 里没有 DOMParser / document，
 * 而网页抓取又必须解析 HTML，所以用 chrome.offscreen 开一个 DOM_PARSER 文档。
 *
 * 两种提取模式：
 *  - single：一个选择器 → 一段文本/HTML/属性
 *  - rows  ：行选择器 + 行内「键/状态」选择器 → [{key, value}]
 */
import { extractRows, extractValue } from './extract.js';
import { detectMainContent, detectTables } from './detect.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return undefined;

  // 结构探测（自动模式自愈 / 一键监控校验用）：在已抓到的 HTML 上找表格
  if (message.type === 'offscreen/detect') {
    try {
      const doc = new DOMParser().parseFromString(String(message.html ?? ''), 'text/html');
      sendResponse(detectTables(doc));
    } catch (error) {
      sendResponse({ loginRequired: false, stats: null, candidates: [], error: String(error?.message ?? error) });
    }
    return undefined;
  }

  // 通用兜底：找页面「主要内容」区域
  if (message.type === 'offscreen/detect-main') {
    try {
      const doc = new DOMParser().parseFromString(String(message.html ?? ''), 'text/html');
      sendResponse(detectMainContent(doc));
    } catch (error) {
      sendResponse({ ok: false, reason: 'parse-error', message: String(error?.message ?? error) });
    }
    return undefined;
  }

  if (message.type !== 'offscreen/parse') return undefined;

  const extraction = message.extraction ?? {};

  try {
    const doc = new DOMParser().parseFromString(String(message.html ?? ''), 'text/html');
    const result = extraction.extractMode === 'rows'
      ? extractRows(doc, extraction)
      : extractValue(doc, extraction);
    sendResponse(result);
  } catch (error) {
    sendResponse({
      ok: false,
      reason: 'parse-error',
      message: String(error?.message ?? error),
    });
  }
  // 同步 sendResponse 已完成，无需保持通道
  return undefined;
});

// 让 Service Worker 知道离屏文档已就绪（仅用于日志排查，失败不影响主流程）
chrome.runtime.sendMessage({ type: 'offscreen/ready' }).catch(() => {});
