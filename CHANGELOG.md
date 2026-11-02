# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [SemVer](https://semver.org/).

## [1.2.0] — 2026-11-02

### Added

- **Zero-window capture**: if the watched page is already open in Chrome, the extension reads that
  tab directly — no new window, no navigation, no focus stealing. Strategy waterfall:
  `tab-reuse → hidden-window → ephemeral-tab → direct`.
- **Generic content monitoring**: one-click detection now falls back from "list" to "main content",
  and a final "monitor the whole page" action makes any page monitorable.
- **Diagnostics on failure**: probe/auto-add failures return `diagnostics` (tables, rows, HTML length)
  with a "copy diagnostics" button in the popup.
- `forceKind: 'page'` option for `auto-add` (whole-page watch without detection).
- `status.lastStrategy` / `runtime.lastStrategy` record which fetch strategy was used.

### Changed

- Hidden window is now created off-screen (popup type) first, then minimized, for less visual noise.
- Auto-added watches self-heal in single mode too (re-detect main content when the selector breaks).

### Tests

- Added: zero-window adoption, hidden-window reuse, generic fallback, `forceKind:'page'`, single-mode healing.

## [1.1.0] — 2026-11-02

### Added

- **One-click monitoring** in the popup: detect the page structure, preview, save.
- **Hidden window** capture: one persistent minimized window with a resident tab per watch
  (replaces the "new tab on every check" behaviour).
- **Auto-healing** (`autoDetect`): re-detect and rewrite selectors when a page changes structure.
- `silentTabs` setting, page-permission simplification (install-time `http(s)://*/*`).
- "Advanced: manual selectors" form is collapsed by default.

### Tests

- Added: probe/auto-add flow, silent tab reuse, auto-heal rewrite.

## [1.0.0] — 2026-11-01

### Added

- Chrome MV3 extension with `single` (one value) and `rows` (list, row by row) extraction.
- CSS / XPath selectors, text / HTML / attribute value kinds.
- `direct` (fetch) and `tab` (rendered DOM) fetch modes.
- SHA-256 fingerprinting after whitespace normalization.
- DSH-IM proactive delivery to WeChat/Feishu/WeCom/DingTalk/QQ/Slack/Telegram/Discord/WhatsApp.
- Delivery retries (60 s × 3), local notification fallback, run-time status panel.
- Node test suites (`selftest`, `integration`) and real-Chrome suite (`browser-e2e`).
