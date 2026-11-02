/**
 * 核心纯函数自测（零依赖，Node 22 直接跑：node tools/selftest.mjs）。
 *
 * 覆盖：归一化、指纹、选择器提取、消息文案长度约束、manifest 完整性。
 * 说明：Node 没有 DOMParser，所以 DOM 相关用最小的假 document 驱动，验证控制流与异常分支。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_MESSAGE_CHARS,
  buildBaselineMessage,
  buildChangeMessage,
  buildRowsBaselineMessage,
  buildRowsChangeMessage,
  buildTestMessage,
  clipMessage,
  diffRows,
  extractRows,
  extractValue,
  filterRowsDiff,
  formatTime,
  hashValue,
  normalizeValue,
  parseRows,
  previewOf,
  readValue,
  rowsPreview,
  selectNode,
  serializeRows,
} from '../src/extract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

function assertEq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
}

/** 构造一个假 document，覆盖 css / xpath / 缺失 / 语法错误四种情况。 */
function fakeDoc() {
  const node = {
    textContent: '  公告：\n\t系统维护 ',
    outerHTML: '<div id="notice">公告：系统维护</div>',
    getAttribute: (name) => (name === 'data-count' ? '42' : null),
  };
  return {
    querySelector(selector) {
      if (selector === '[') throw new SyntaxError('bad selector');
      if (selector === '.missing') return null;
      return node;
    },
    evaluate(expression) {
      if (expression === 'bad(') throw new Error('bad xpath');
      if (expression === '//div') return { singleNodeValue: node };
      return { singleNodeValue: null };
    },
  };
}

/**
 * 构造一个假 document，驱动 extractRows：
 * rows: [{ name, status, id }]，每行支持 td:nth-child(1) / td:nth-child(5) / [data-id]
 */
function fakeRowsDoc(rows) {
  const makeRow = (row) => {
    const cells = [
      { textContent: row.name },
      { textContent: '' },
      { textContent: '' },
      { textContent: '' },
      { textContent: row.status },
    ];
    return {
      textContent: `${row.name} ${row.status}`,
      children: cells,
      querySelector(selector) {
        if (selector === 'td:nth-child(1)') return { textContent: row.name, getAttribute: () => null };
        if (selector === 'td:nth-child(5)') return { textContent: row.status, getAttribute: () => null };
        if (selector === '[data-id]') return { textContent: row.id, getAttribute: () => row.id };
        return null;
      },
    };
  };

  return {
    querySelectorAll(selector) {
      if (selector === '[') throw new SyntaxError('bad selector');
      if (selector === 'tbody tr') return rows.map(makeRow);
      if (selector === 'tr') return rows.map(makeRow);
      return [];
    },
  };
}

console.log('extract.js 自测');
await test('normalizeValue 折叠各种空白与全角空格', () => {
  assertEq(normalizeValue('  A\u00a0\u00a0B\n\nC\tD  '), 'A B C D');
});

await test('normalizeValue 对 null / undefined 返回空串', () => {
  assertEq(normalizeValue(null), '');
  assertEq(normalizeValue(undefined), '');
});

await test('previewOf 超长截断且带省略号', () => {
  assertEq(previewOf('abc', 10), 'abc');
  assertEq(previewOf('a'.repeat(30), 10), `${'a'.repeat(9)}…`);
});

await test('clipMessage 永远不超过上限', () => {
  const clipped = clipMessage('x'.repeat(5000));
  assertEq(clipped.length, MAX_MESSAGE_CHARS);
});

await test('formatTime 输出 YYYY-MM-DD HH:mm:ss', () => {
  assert.match(formatTime(new Date(2026, 10, 1, 19, 3, 5)), /^2026-11-01 19:03:05$/u);
});

await test('hashValue 与已知 SHA-256 向量一致', async () => {
  assertEq(await hashValue('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

await test('hashValue 对空白差异敏感（归一化后才比较）', async () => {
  assert.notEqual(await hashValue('a b'), await hashValue('a  b'));
  assertEq(await hashValue(normalizeValue('a  b')), await hashValue('a b'));
});

await test('selectNode: CSS 命中 / 未命中 / 语法错误', () => {
  const doc = fakeDoc();
  assertEq(selectNode(doc, 'css', '#notice').ok, true);
  assertEq(selectNode(doc, 'css', '.missing'), { ok: false, reason: 'selector-not-found' });
  assertEq(selectNode(doc, 'css', '['), { ok: false, reason: 'selector-invalid' });
  assertEq(selectNode(doc, 'css', '   '), { ok: false, reason: 'selector-invalid' });
});

await test('selectNode: XPath 命中 / 未命中 / 语法错误', () => {
  const doc = fakeDoc();
  assertEq(selectNode(doc, 'xpath', '//div').ok, true);
  assertEq(selectNode(doc, 'xpath', '//span'), { ok: false, reason: 'selector-not-found' });
  assertEq(selectNode(doc, 'xpath', 'bad('), { ok: false, reason: 'selector-invalid' });
});

await test('readValue: text / html / attr', () => {
  const node = fakeDoc().querySelector('#notice');
  // textContent 里的换行/制表符归一化成单个空格
  assertEq(normalizeValue(readValue(node, { valueKind: 'text' })), '公告： 系统维护');
  assertEq(readValue(node, { valueKind: 'html' }), '<div id="notice">公告：系统维护</div>');
  assertEq(readValue(node, { valueKind: 'attr', attrName: 'data-count' }), '42');
  assertEq(readValue(node, { valueKind: 'attr', attrName: 'missing' }), '');
  assertEq(readValue(node, { valueKind: 'attr' }), '');
});

await test('extractValue 返回归一化后的值', () => {
  assertEq(extractValue(fakeDoc(), { selectorType: 'css', selector: '#notice' }), {
    ok: true,
    value: '公告： 系统维护',
  });
});

await test('buildChangeMessage 含名称/页面/前后值', () => {
  const watch = { name: '公告页', url: 'https://example.com/notice' };
  const text = buildChangeMessage(watch, '旧内容', '新内容', new Date(2026, 10, 1, 9, 0, 0).getTime());
  assert.match(text, /【内容变更】公告页/u);
  assert.match(text, /页面：https:\/\/example\.com\/notice/u);
  assert.match(text, /变更前：旧内容/u);
  assert.match(text, /变更后：新内容/u);
  assert.match(text, /2026-11-01 09:00:00/u);
});

await test('buildChangeMessage 超长新值不突破消息上限', () => {
  const watch = { name: 'x'.repeat(80), url: `https://example.com/${'y'.repeat(300)}` };
  const text = buildChangeMessage(watch, 'a'.repeat(5000), 'b'.repeat(20000));
  assert.ok(text.length <= MAX_MESSAGE_CHARS, `实际长度 ${text.length}`);
});

await test('空值显示为 (空)', () => {
  const text = buildChangeMessage({ name: 'n', url: 'https://e.com' }, '', 'new');
  assert.match(text, /变更前：\(空\)/u);
});

await test('buildBaselineMessage / buildTestMessage 长度受控', () => {
  const baseline = buildBaselineMessage({ name: 'n', url: 'https://e.com' }, 'v'.repeat(3000));
  assert.ok(baseline.length <= MAX_MESSAGE_CHARS);
  assert.match(baseline, /【监控启动】/u);
  assert.match(buildTestMessage(), /主动投递已打通/u);
});

console.log('\nrows 模式（任务列表逐行对比）');

await test('extractRows 提取「任务名 → 状态」', () => {
  const doc = fakeRowsDoc([
    { name: '训练任务A', status: '运行中', id: 'job-1' },
    { name: '训练任务B', status: '排队中', id: 'job-2' },
  ]);
  const result = extractRows(doc, { rowSelector: 'tbody tr', keySelector: 'td:nth-child(1)', statusSelector: 'td:nth-child(5)' });
  assertEq(result.ok, true);
  assertEq(result.count, 2);
  assertEq(result.statusMissing, 0);
  assertEq(result.rows, [
    { key: '训练任务A', value: '运行中' },
    { key: '训练任务B', value: '排队中' },
  ]);
});

await test('extractRows 支持从属性取值，重名键自动加后缀', () => {
  const doc = fakeRowsDoc([
    { name: '同名任务', status: '运行中', id: 'job-1' },
    { name: '同名任务', status: '已完成', id: 'job-2' },
  ]);
  const result = extractRows(doc, {
    rowSelector: 'tbody tr',
    keySelector: '[data-id]',
    keyAttr: 'data-id',
    statusSelector: 'td:nth-child(5)',
  });
  assertEq(result.rows, [
    { key: 'job-1', value: '运行中' },
    { key: 'job-2', value: '已完成' },
  ]);

  const dup = extractRows(doc, { rowSelector: 'tbody tr', keySelector: 'td:nth-child(1)', statusSelector: 'td:nth-child(5)' });
  assertEq(dup.rows.map((row) => row.key), ['同名任务', '同名任务#2']);
});

await test('extractRows 的失败原因区分清楚', () => {
  const empty = extractRows(fakeRowsDoc([]), { rowSelector: 'tbody tr', statusSelector: 'td:nth-child(5)' });
  assertEq(empty.ok, false);
  assertEq(empty.reason, 'rows-empty');
  assertEq(empty.matched, 0);
  assertEq(empty.totalTr, 0, '应带上整页 tr 数，便于判断选择器是否落到错误子树');

  assertEq(extractRows(fakeRowsDoc([]), { rowSelector: 'tbody tr' }), { ok: false, reason: 'selector-invalid' });
  assertEq(extractRows(fakeRowsDoc([]), { rowSelector: '[', statusSelector: 'td' }), {
    ok: false,
    reason: 'selector-invalid',
  });

  // 命中了行，但状态选择器取不到 → rows-status-empty，并带上首行单元格文本
  const rows = [
    { name: '训练任务A', status: '运行中' },
    { name: '训练任务B', status: '排队中' },
  ];
  const badStatus = extractRows(fakeRowsDoc(rows), {
    rowSelector: 'tbody tr',
    keySelector: 'td:nth-child(1)',
    statusSelector: 'td:nth-child(99)',
  });
  assertEq(badStatus.ok, false);
  assertEq(badStatus.reason, 'rows-status-empty');
  assertEq(badStatus.matched, 2);
  assert.ok(Array.isArray(badStatus.sample) && badStatus.sample.length > 0, '应带单元格样本');

  // 命中了行，但键选择器取不到 → rows-key-empty
  const badKey = extractRows(fakeRowsDoc(rows), {
    rowSelector: 'tbody tr',
    keySelector: 'td:nth-child(99)',
    statusSelector: 'td:nth-child(5)',
  });
  assertEq(badKey.ok, false);
  assertEq(badKey.reason, 'rows-key-empty');
  assertEq(badKey.matched, 2);
});

await test('serializeRows 与键顺序无关，parseRows 可还原', () => {
  const left = serializeRows({ b: '2', a: '1' });
  const right = serializeRows({ a: '1', b: '2' });
  assertEq(left, right);
  assertEq(parseRows(left), { a: '1', b: '2' });
  assertEq(parseRows('not json'), {});
});

await test('diffRows 区分 变化 / 新增 / 消失', () => {
  const diff = diffRows(
    { A: '运行中', B: '排队中', C: '已完成' },
    { A: '已完成', B: '排队中', D: '运行中' },
  );
  assertEq(diff.changed, [{ key: 'A', from: '运行中', to: '已完成' }]);
  assertEq(diff.added, [{ key: 'D', value: '运行中' }]);
  assertEq(diff.removed, [{ key: 'C', value: '已完成' }]);
});

await test('filterRowsDiff 按 onlyStatuses 过滤（支持中文逗号）', () => {
  const diff = diffRows({ A: '排队中' }, { A: '运行中' });
  assertEq(filterRowsDiff(diff, { onlyStatuses: '已完成,失败' }).changed, []);
  assertEq(filterRowsDiff(diff, { onlyStatuses: '运行中，已完成' }).changed.length, 1);
  assertEq(filterRowsDiff(diff, {}).changed.length, 1);
});

await test('buildRowsChangeMessage 逐条列出变化且不超长', () => {
  const diff = diffRows(
    { '训练任务A': '运行中', '训练任务B': '排队中' },
    { '训练任务A': '已完成', '训练任务B': '运行中', '训练任务C': '排队中' },
  );
  const text = buildRowsChangeMessage(
    { name: 'SenseCore 任务', url: 'https://console.sensecore.cn/acp/list' },
    { ...diff, added: diff.added, removed: [] },
    new Date(2026, 10, 1, 20, 0, 0).getTime(),
  );
  assert.match(text, /【任务状态变化】SenseCore 任务/u);
  assert.match(text, /• 训练任务A：运行中 → 已完成/u);
  assert.match(text, /• 训练任务C：新增，状态 排队中/u);
  assert.match(text, /共 3 项变化/u);
  assert.ok(text.length <= MAX_MESSAGE_CHARS);

  const many = buildRowsChangeMessage(
    { name: 'x'.repeat(40), url: `https://e.com/${'y'.repeat(200)}` },
    {
      changed: Array.from({ length: 40 }, (_, index) => ({
        key: `任务${index}`.repeat(6),
        from: '排队中',
        to: '已完成',
      })),
      added: [],
      removed: [],
    },
  );
  assert.ok(many.length <= MAX_MESSAGE_CHARS, `实际长度 ${many.length}`);
  assert.match(many, /…等 40 项变化/u);
});

await test('buildRowsBaselineMessage / rowsPreview', () => {
  const baseline = buildRowsBaselineMessage(
    { name: '任务列表', url: 'https://e.com/acp' },
    { A: '运行中', B: '排队中' },
  );
  assert.match(baseline, /【列表监控启动】任务列表/u);
  assert.match(baseline, /已记录 2 个任务/u);
  assert.match(baseline, /• A：运行中/u);
  assertEq(rowsPreview([{ key: 'A', value: '运行中' }, { key: 'B', value: '' }]), 'A=运行中；B=(空)');
});

console.log('\n工程完整性检查');

await test('manifest.json 合法且关键文件存在', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  assertEq(manifest.manifest_version, 3);
  assertEq(manifest.background.type, 'module');
  assert.ok(manifest.permissions.includes('offscreen'));
  const required = [
    'src/background.js',
    'src/extract.js',
    'src/offscreen.html',
    'src/offscreen.js',
    'src/popup.html',
    'src/options.html',
    'icons/icon16.png',
    'icons/icon128.png',
  ];
  for (const relative of required) {
    const content = await readFile(join(ROOT, relative));
    assert.ok(content.length > 0, `${relative} 为空`);
  }
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) process.exitCode = 1;
