// 分批拓扑的回归测试。这里的不变式一旦破掉，名额会静默错配、
// 或同一只标的被重复计入两批——两种都不会报错，只会让结果悄悄失真。
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoBatches, bucketNames, isHighDividend, sectorBucket, DIVIDEND_BUCKET } from '../src/classify.js';
import { SCREENING } from '../src/config.js';

const cn = (code, industry, dividendYield, marketCap = 1e9) =>
  ({ code, name: code, industry, dividendYield, marketCap });

const MIN = 3;
const opts = { dividendYieldMin: MIN };

test('A股：股息率 ≥ 阈值的标的被抽进「中高股息」批', () => {
  const rows = [
    cn('601398', '银行', 3.94),   // 达标
    cn('600519', '白酒Ⅱ', 2.10),  // 不达标 → 消费
    cn('000651', '白色家电', 5.20), // 达标
    cn('603986', '半导体', 1.50),  // 不达标 → 科技
  ];
  const batches = groupIntoBatches(rows, 'cn', opts);
  const by = Object.fromEntries(batches.map((b) => [b.bucket, b.rows.map((r) => r.code)]));
  assert.deepEqual(by[DIVIDEND_BUCKET].sort(), ['000651', '601398']);
  assert.deepEqual(by['消费'], ['600519']);
  assert.deepEqual(by['科技'], ['603986']);
});

test('A股：股息批与行业批互斥，且一只都不丢', () => {
  const rows = [
    cn('601398', '银行', 3.94), cn('600519', '白酒Ⅱ', 2.10),
    cn('000651', '白色家电', 5.20), cn('002415', '安防设备', 1.50),
    cn('600900', '电力', 3.0), cn('601857', '油气开采Ⅱ', 7.7),
  ];
  const batches = groupIntoBatches(rows, 'cn', opts);
  const all = batches.flatMap((b) => b.rows.map((r) => r.code));
  assert.equal(all.length, rows.length, '总数守恒：分流不是过滤');
  assert.equal(new Set(all).size, rows.length, '无重复：同一只不得既在股息批又在行业批');
});

test('阈值是闭区间下界：恰好等于阈值算达标', () => {
  assert.equal(isHighDividend({ dividendYield: MIN }, MIN), true);
  assert.equal(isHighDividend({ dividendYield: MIN - 0.01 }, MIN), false);
});

test('股息率缺失(null)与不分红(0)都走行业批，不被丢弃', () => {
  const rows = [cn('A', '白酒Ⅱ', null), cn('B', '白酒Ⅱ', 0), cn('C', '白酒Ⅱ', NaN)];
  const batches = groupIntoBatches(rows, 'cn', opts);
  const by = Object.fromEntries(batches.map((b) => [b.bucket, b.rows.map((r) => r.code)]));
  assert.deepEqual(by[DIVIDEND_BUCKET], []);
  assert.deepEqual(by['消费'].sort(), ['A', 'B', 'C']);
});

test('美股不做股息分流：仍是 5 个行业批', () => {
  const rows = [
    { code: 'NVDA', industry: '信息技术', dividendYield: 0.24 },
    { code: 'XOM', industry: '能源', dividendYield: 3.5 },   // 高股息但不该被抽走
  ];
  const batches = groupIntoBatches(rows, 'us', opts);
  assert.equal(batches.length, 5);
  assert.equal(batches.some((b) => b.bucket === DIVIDEND_BUCKET), false);
  const by = Object.fromEntries(batches.map((b) => [b.bucket, b.rows.map((r) => r.code)]));
  assert.deepEqual(by['科技'], ['NVDA']);
  assert.deepEqual(by['制造与周期'], ['XOM']);
});

test('空批保留，便于与 batchPicks 配置对齐', () => {
  const batches = groupIntoBatches([], 'cn', opts);
  assert.equal(batches.length, 6);
  assert.deepEqual(batches.map((b) => b.bucket), bucketNames('cn'));
  assert.ok(batches.every((b) => Array.isArray(b.rows) && b.rows.length === 0));
});

test('sectorBucket 保持纯行业口径，不被股息维度污染', () => {
  // collect.js 用它写 row.sector，那是行业标签，不能变成「中高股息」
  assert.equal(sectorBucket('银行', 'cn'), '其他');
  assert.equal(sectorBucket('半导体', 'cn'), '科技');
  assert.equal(sectorBucket('信息技术', 'us'), '科技');
});

test('名额配置：两市场各 50（v0.6 市场榜独占 10 席后回到 5:1 密度），目标批恰为 50%', () => {
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const { cn: c, us: u } = SCREENING.batchPicks;
  assert.equal(sum(c), 50);
  assert.equal(sum(u), 50);
  assert.equal(c[DIVIDEND_BUCKET] / sum(c), 0.5, 'A股中高股息占 50%');
  assert.equal(u['科技'] / sum(u), 0.5, '美股科技占 50%');
  // 粗筛名额必须够市场榜挑：低于 5:1 就等于让裁决在过窄的候选里硬选
  assert.ok(sum(c) / SCREENING.topN >= 5, 'A股粗筛密度 ≥ 5:1');
  assert.ok(sum(u) / SCREENING.topN >= 5, '美股粗筛密度 ≥ 5:1');
});

test('自选榜名额与市场榜彻底独立（v0.6 分开挖掘，不再是 topN 的一半）', () => {
  // 破掉这条说明两张榜又被耦合回去了——那正是 v0.6 要拆掉的东西。
  // 两张榜各有自己的旋钮；v0.9.0 起默认值恰好相同（用户决策：都是 5~10 席）
  assert.ok(Object.hasOwn(SCREENING.watch, 'topN') && Object.hasOwn(SCREENING.watch, 'minN'));
  assert.equal(SCREENING.watch.topN, 10);
  assert.equal(SCREENING.watch.minN, 5);
});

test('榜单席位 5~10（v0.9.0 用户决策 2026-09-26）：下限不得高于上限', () => {
  assert.equal(SCREENING.topN, 10);
  assert.equal(SCREENING.minN, 5);
  assert.ok(SCREENING.minN <= SCREENING.topN);
  assert.ok(SCREENING.watch.minN <= SCREENING.watch.topN);
});

test('每个批次名都有对应名额，不会静默落到 defaultPicks', () => {
  for (const market of ['cn', 'us']) {
    for (const name of bucketNames(market)) {
      assert.ok(SCREENING.batchPicks[market][name] > 0, `${market} 缺少 ${name} 的名额配置`);
    }
    // 反向：配置里也不该有多余的批名
    for (const name of Object.keys(SCREENING.batchPicks[market])) {
      assert.ok(bucketNames(market).includes(name), `${market} 的 ${name} 不是有效批次名`);
    }
  }
});
