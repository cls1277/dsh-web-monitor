# Contributing

Thanks for taking a look! This project is a Chrome MV3 extension plus a few
zero-dependency Node scripts, so the loop is short.

## What you need

- Chrome 116+ (for `chrome.offscreen`)
- Node.js 20+ (tests use `structuredClone`, `fetch`, `crypto.subtle`)
- A running [DeepSeek Harness](https://github.com/) instance with the
  `@xmanrui/dsh-im` plugin connected to at least one messaging channel,
  if you want to test real delivery end to end

## Run the tests

```bash
node tools/selftest.mjs       # pure functions + repo sanity
node tools/integration.mjs    # background pipeline with mocked chrome.* APIs
npm test                      # both of the above
```

Optional browser checks (needs `puppeteer-core` and a local Chrome):

```bash
npm i -D puppeteer-core
node tools/browser-e2e.mjs
```

## Code map

| Path | Role |
| --- | --- |
| `src/background.js` | Service worker: scheduling, fetching, diffing, delivery, self-healing |
| `src/extract.js` | Pure helpers: normalize / hash / extract / diff / message templates |
| `src/detect.js` | Self-contained functions injected into pages to detect lists and main content |
| `src/offscreen.js` | Hidden document used for `DOMParser` |
| `src/options.*`, `src/popup.*` | UI, vanilla JS, no build step |

## Ground rules

- Keep `src/extract.js` and `src/detect.js` free of `chrome.*` APIs so they stay testable in Node.
- Functions passed to `chrome.scripting.executeScript({ func })` must be self-contained
  (no imports, no outer references) — Chrome serializes the function body.
- Any behavior change needs a test in `tools/selftest.mjs` or `tools/integration.mjs`.
- UI is Chinese-first and uses `createElement` / `textContent` only (no `innerHTML`).
- Keep the extension dependency-free: no bundler, no CDN, no external fonts.

## Pull requests

1. Run `npm test`.
2. Describe the scenario you tested in a real browser (page type, what changed).
3. If you touched selectors/detection, mention the DOM shape you tested against.
