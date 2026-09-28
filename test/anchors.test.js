// 估值锚（v0.10.0）的纯函数测试。
//
// 这一版删掉了「周期股 → PB」的机械路由：机械层不判股性、不选锚，把能算的锚并排给模型，
// 模型只负责「选哪个」，数字一律由代码按所选锚回填。这里守住三件事：
//   1. 锚的数字是接口原值的换算（P/V = 现值 ÷ 5 年中位），不自己重算每股口径；
//   2. 失真的证据（被剔除的亏损点）如实计数，交给模型判断；
//   3. 模型选的锚无论写成什么样，回填都不瞎编：选不存在的、选不可算的都显式标出。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  multipleAnchor, normalizedPeAnchor, anchorsFor, resolveAnchor, compactAnchors,
  multiplePercentiles, splitEvents, sharesToCurrentBasis,
} from '../src/valuation.js';
import { fundamentalHistory } from '../src/metrics/normalize.js';

// 日频 1250 点、新→旧。PE 在 10~30 间均匀分布，其中最老的 250 点为负（亏损期）
const series = (n = 1250, f = (i) => ({ pe: 10 + (i % 21), pb: 2 })) =>
  Array.from({ length: n }, (_, i) => ({ date: `d${i}`, close: 10, ...f(i) }));

test('multipleAnchor：P/V = 现值 ÷ 5 年中位，对应价格是同一组数字的换算', () => {
  const rows = series();
  const a = multipleAnchor({ key: 'pe', label: 'PE(TTM)', field: 'pe' }, { rows, current: 10, price: 20, from: '接口' });
  assert.equal(a.ok, true);
  assert.equal(a.p50, 20);
  assert.equal(a.pv, 0.5);
  assert.equal(a.tier.name, '显著低估');
  assert.equal(a.prices.p50, 40, '现价 20 × 中位 20 ÷ 现值 10');
  assert.ok(a.rank < 10, '现值 10 处在分布底部');
  assert.equal(a.excluded, 0);
});

test('multipleAnchor：亏损期被剔除的点如实计数——这是「锚失真没有」的直接证据', () => {
  const rows = series(1250, (i) => ({ pe: i >= 1000 ? -5 : 10 + (i % 21) }));
  const a = multipleAnchor({ key: 'pe', label: 'PE(TTM)', field: 'pe' }, { rows, current: 12, price: 12 });
  assert.equal(a.window, 1250);
  assert.equal(a.excluded, 250);
});

test('multipleAnchor：当前值缺失或 ≤0 时不给数，并写明原因', () => {
  const rows = series();
  const def = { key: 'pe', label: 'PE(TTM)', field: 'pe' };
  assert.deepEqual(
    [multipleAnchor(def, { rows, current: null }).ok, multipleAnchor(def, { rows, current: -3 }).ok],
    [false, false],
  );
  assert.match(multipleAnchor(def, { rows, current: -3 }).reason, /≤ 0/);
});

test('normalizedPeAnchor：现价 ÷ 归一化EPS，对照 PE(TTM) 的 5 年分位；EPS ≤0 不给数', () => {
  const rows = series();
  const a = normalizedPeAnchor({ rows, norm: { ok: true, normEps: 1, normMargin: 0.2 }, price: 10 });
  assert.equal(a.key, 'pe_norm');
  assert.equal(a.current, 10);
  assert.equal(a.pv, 0.5);
  assert.equal(a.normEps, 1);
  assert.equal(normalizedPeAnchor({ rows, norm: { ok: true, normEps: -0.2 }, price: 10 }).ok, false);
  assert.equal(normalizedPeAnchor({ rows, norm: { ok: false, reason: '年报不足' }, price: 10 }).reason, '年报不足');
});

test('anchorsFor：美股 PE/PB 的当前值优先用接口值，历史仍是反算；只给反算序列有的三个倍数', () => {
  const rows = series(120, (i) => ({ pe: 10 + (i % 21), pb: 2 + (i % 3), ps: 1 + (i % 4) }));
  const out = anchorsFor({
    row: { price: 100, pe: 15, pb: 3 }, series: { rows, freq: 'monthly' },
    norm: { ok: false, reason: '—' }, market: 'us',
  });
  assert.deepEqual(out.map((a) => a.key), ['pe', 'pb', 'ps', 'pe_norm']);
  const pe = out.find((a) => a.key === 'pe');
  assert.equal(pe.current, 15);
  assert.match(pe.from, /接口现值/);
  assert.equal(out.find((a) => a.key === 'ps').from, '反算');
});

test('anchorsFor：A股全部取接口逐日序列的最新点，不可算的锚保留并写明原因', () => {
  const rows = series(1250, (i) => ({ pe: 10 + (i % 21), peLar: null, pb: 2 + (i % 3), ps: 3, pcf: 8 }));
  const out = anchorsFor({ row: { price: 10 }, series: { rows, freq: 'daily' }, norm: { ok: false, reason: '金融股' }, market: 'cn' });
  assert.deepEqual(out.map((a) => a.key), ['pe', 'pe_lar', 'pb', 'ps', 'pcf', 'pe_norm']);
  assert.equal(out.find((a) => a.key === 'pe_lar').ok, false);
  assert.equal(out.find((a) => a.key === 'pe').from, '接口');
});

// ── resolveAnchor：模型只选锚，数字由代码回填 ─────────────────────

const anchors = anchorsFor({
  row: { price: 10 }, market: 'cn', norm: { ok: false, reason: '—' },
  series: { rows: series(1250, (i) => ({ pe: 10 + (i % 21), pb: 2 })), freq: 'daily' },
});

test('resolveAnchor：按 key 或标签都认，数字取自锚本身', () => {
  const v = resolveAnchor('pe', anchors);
  assert.equal(v.key, 'pe');
  assert.equal(v.label, 'PE(TTM)');
  assert.equal(v.mos, 1 - v.pv);
  assert.deepEqual(resolveAnchor('PE(TTM)', anchors).key, 'pe');
  assert.deepEqual(resolveAnchor(' PB ', anchors).key, 'pb');
});

test('resolveAnchor：none / 都不可信 → key:none（渲染层据此不显示数字）', () => {
  for (const x of ['none', 'NONE', '都不可信', '无']) assert.deepEqual(resolveAnchor(x, anchors), { key: 'none' });
});

test('resolveAnchor：选了档案里没有的、或不可算的锚，显式标 invalid，不瞎编数字', () => {
  const a = resolveAnchor('ev_ebitda', anchors);
  assert.equal(a.invalid, true);
  assert.equal(a.pv, undefined);
  const b = resolveAnchor('pe_norm', anchors);
  assert.equal(b.invalid, true, '归一化不可用时 pe_norm 不可选');
});

test('resolveAnchor：没选（旧提示词 / 旧快照 / 代码补位）返回 null', () => {
  assert.equal(resolveAnchor(undefined, anchors), null);
  assert.equal(resolveAnchor('', anchors), null);
  assert.equal(resolveAnchor('pe', undefined).invalid, true);
});

test('compactAnchors：落盘形态不带分位窗口原始数据，不可算的保留原因', () => {
  const c = compactAnchors(anchors);
  assert.equal(c.length, anchors.length);
  // v0.11.3 起留下 P25/P75、有效点数、剔除数与样本不足标记：事后复核「这个锚当时可不可信」只能靠它们
  assert.deepEqual(Object.keys(c[0]).sort(),
    ['current', 'excluded', 'from', 'insufficient', 'key', 'label', 'n', 'ok', 'p25', 'p50', 'p75', 'pv', 'rank', 'tier'].sort());
  assert.ok(c.find((x) => !x.ok).reason);
});

// ── 股性证据：只陈列、不判定 ─────────────────────────────────────

test('fundamentalHistory：逐年利润率 / 营收同比 / ROE，新→旧，最老一年没有同比', () => {
  const st = [
    { period: '2025-12-31', revenue: 200, operateProfit: 40, interestExpense: 0, parentNetProfit: 30, parentEquity: 150 },
    { period: '2024-12-31', revenue: 100, operateProfit: -50, interestExpense: 0, parentNetProfit: -60, parentEquity: 120 },
    { period: '2025-06-30', revenue: 90, operateProfit: 10 },   // 半年报不进年报序列
  ];
  const h = fundamentalHistory(st, 'cn');
  assert.deepEqual(h.years, ['2025', '2024']);
  assert.deepEqual(h.margin, [0.2, -0.5]);
  assert.deepEqual(h.revYoy, [1, null]);
  assert.deepEqual(h.roe, [0.2, -0.5]);
  assert.equal(fundamentalHistory([], 'cn'), null);
});

// ── 美股反算口径（v0.11.3）────────────────────────────────────
// 这一组钉住三处曾静默出错、且会翻转安全边际的口径：拆股基数、股数时效、有效样本。

test('splitEvents：只有「后复权 ÷ 不复权」的跳变才算拆股，价格自身的跳变不算', () => {
  const raw = Array.from({ length: 30 }, (_, i) => ({
    date: `${2021 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-28`, close: 100,
  }));
  const adj = raw.map((r, i) => ({ ...r, close: i >= 14 ? 150 : 100 }));
  const ev = splitEvents(adj, raw);
  assert.equal(ev.length, 1);
  assert.ok(Math.abs(ev[0].ratio - 1.5) < 1e-9);
  assert.equal(ev[0].ym, raw[14].date.slice(0, 7));
  // 单月真实大涨 8 倍：两条序列同涨，比值不动 —— v0.12 曾把它读成 8:1 拆股
  const up = raw.map((r, i) => ({ ...r, close: i >= 14 ? 800 : 100 }));
  assert.equal(splitEvents(up, up).length, 0, '价格自身的跳变不是拆股');
});

test('sharesToCurrentBasis：未重述的股数折到现基数，已重述的原样使用', () => {
  const events = [{ ym: '2024-06', ratio: 10 }];
  const raw = sharesToCurrentBasis([{ period: '2023-01-31', shares: 24.9 }], events, 249);
  assert.equal(raw[0].restated, false);
  assert.ok(Math.abs(raw[0].sharesNow - 249) < 1, `实得 ${raw[0].sharesNow}`);
  const re = sharesToCurrentBasis([{ period: '2023-01-31', shares: 249.4 }], events, 249);
  assert.equal(re[0].restated, true);
  assert.ok(Math.abs(re[0].sharesNow - 249.4) < 1, `实得 ${re[0].sharesNow}`);
});

test('multiplePercentiles：60 个月里只有 1 个有效点，判样本不足而不是「5 年分位」', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    date: `${2021 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-28`,
    pe: i === 0 ? 40 : null,
  }));
  const p = multiplePercentiles(rows, 'pe', 'monthly');
  assert.equal(p.ok, true);
  assert.equal(p.n, 1);
  assert.equal(p.insufficient, true, '有效点只有 1 个');
});
