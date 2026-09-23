// suggest() 联想候选排序 + 拼音补位的回归测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggest } from '../src/single.js';

test('空输入返回空数组', async () => {
  assert.deepEqual(await suggest(''), []);
  assert.deepEqual(await suggest(null), []);
});

test('精确代码命中排第一：GOOGL → 谷歌-A', async () => {
  const items = await suggest('GOOGL');
  assert.ok(items.length > 0, '至少命中一条');
  assert.equal(items[0].code, 'GOOGL');
  assert.equal(items[0].name, '谷歌-A');
});

test('中文名前缀匹配：茅台 → 贵州茅台第一', async () => {
  const items = await suggest('茅台');
  assert.ok(items.length > 0);
  assert.equal(items[0].code, '600519');
  assert.equal(items[0].name, '贵州茅台');
});

test('谷歌 → 操作主体排在 ETF 前面，且 isFund 标记正确', async () => {
  const items = await suggest('谷歌');
  assert.ok(items.length >= 2, '至少命中两个候选');
  // 操作主体（有 industry）排在前
  const codes = items.map((r) => r.code);
  const googlIdx = codes.indexOf('GOOGL');
  const googIdx = codes.indexOf('GOOG');
  assert.ok(googlIdx >= 0 && googIdx >= 0, 'GOOGL 和 GOOG 都在候选中');
  // GOOGL 排在第一个 ETF 前面
  const firstFund = items.findIndex((r) => r.isFund);
  if (firstFund > 0) {
    assert.ok(googlIdx < firstFund, '谷歌-A 排在首个 ETF 前面');
  }
  // GOOGL 的 isFund 为 false
  const googl = items.find((r) => r.code === 'GOOGL');
  assert.equal(googl.isFund, false, 'GOOGL 不应标记为 fund');
  // 某个 ETF 的 isFund 为 true
  const funds = items.filter((r) => r.isFund);
  assert.ok(funds.length > 0, '至少有一个 ETF 被标记为 isFund');
});

test('BRK.B 代码归一化：输入 BRK.B 能命中 BRK_A 或 BRK_B', async () => {
  const items = await suggest('BRK.B');
  const codes = items.map((r) => r.code);
  assert.ok(
    codes.includes('BRK_B') || codes.includes('BRK_A'),
    `应命中 BRK_A 或 BRK_B，实际: ${codes.join(', ')}`,
  );
});

test('返回数量受 limit 限制', async () => {
  const items = await suggest('中国', 5);
  assert.ok(items.length <= 5, `应 ≤5 条，实际 ${items.length} 条`);
});

test('英文名匹配：apple → 苹果 (via pinyin fallback)', async () => {
  const items = await suggest('apple');
  const codes = items.map((r) => r.code);
  assert.ok(codes.includes('AAPL'), `应包含 AAPL，实际: ${codes.join(', ')}`);
});

test('返回字段包含 code/name/market/isFund', async () => {
  const items = await suggest('茅台');
  assert.ok(items.length > 0);
  const r = items[0];
  assert.equal(typeof r.code, 'string');
  assert.equal(typeof r.name, 'string');
  assert.ok(['cn', 'us'].includes(r.market));
  assert.equal(typeof r.isFund, 'boolean');
});
