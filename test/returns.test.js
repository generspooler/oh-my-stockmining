// 多区间回撤的纯函数测试（SYSTEM_DEFINITION §2.6）。
//
// 旧实现的四个缺陷此前没有任何测试保护，其中三个（短序列静默降级、
// dd/ret 窗口不一致、按数组下标当月份）都是纯函数层面就能钉死的。
// 复权口径那一条属数据源选择，由 test 覆盖不到，靠 §2.6 的规范与 em.kline 的注释约束。
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawdowns, monthsBefore, toMonthEnd, detectSplit } from '../src/metrics/returns.js';

/** 生成连续月末序列：从 end 往前 n 个月，收盘由 priceOf(索引) 给出（索引 0 = 最早）。 */
const series = (n, endYear, endMonth, priceOf = () => 100) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(endYear, endMonth - 1 - (n - 1 - i), 28));
    out.push({ date: d.toISOString().slice(0, 10), close: priceOf(i) });
  }
  return out;
};

test('monthsBefore：目标月天数不足时夹到月末，不溢出到下个月', () => {
  assert.equal(monthsBefore('2026-08-31', 6), '2026-02-28');
  assert.equal(monthsBefore('2026-03-31', 1), '2026-02-28');
  assert.equal(monthsBefore('2026-09-22', 12), '2025-09-22');
  assert.equal(monthsBefore('2026-09-22', 60), '2021-09-22');
  assert.equal(monthsBefore('不是日期', 12), null);
});

test('drawdowns：空序列与单点序列全部置空，不抛', () => {
  for (const s of [[], null, [{ date: '2026-09-28', close: 100 }]]) {
    const r = drawdowns(s);
    for (const k of ['dd13w', 'dd26w', 'dd52w', 'dd3y', 'dd5y', 'ret52w', 'ret3y', 'ret5y']) {
      assert.equal(r[k], null, `${k} 应为 null`);
    }
  }
});

test('drawdowns：历史不足的区间置空，不退化成短窗口再冠原标签', () => {
  // 18 个月历史：52周 覆盖得到，3年/5年 覆盖不到
  const r = drawdowns(series(18, 2026, 9, (i) => 100 + i));
  assert.ok(r.dd52w !== null, '52周 应算得出');
  assert.ok(r.ret52w !== null, '52周收益 应算得出');
  assert.equal(r.dd3y, null, '3年 历史不覆盖，必须为 null（旧实现会拿 18 个月冒充）');
  assert.equal(r.dd5y, null, '5年 历史不覆盖，必须为 null');
  assert.equal(r.ret3y, null);
  assert.equal(r.ret5y, null);
  assert.equal(r.coverage.months, 18);
});

test('drawdowns：回撤与区间收益同窗口（旧实现 dd 量 11 个月、ret 量 12 个月）', () => {
  // 25 个月，只有「12 个月前」那一点是 200，其余 100，末点 100。
  // 同窗口下：dd52w 必须看到那个 200（= 100/200-1 = -50%），
  // 且 ret52w 的基准点正是它（= 100/200-1 = -50%）。两者必须相等。
  const n = 25;
  const s = series(n, 2026, 9, (i) => (i === n - 1 - 12 ? 200 : 100));
  const r = drawdowns(s);
  assert.equal(r.dd52w.toFixed(6), (-0.5).toFixed(6));
  assert.equal(r.ret52w.toFixed(6), (-0.5).toFixed(6));
  assert.equal(r.dd52w, r.ret52w, 'dd 与 ret 必须取同一个窗口起点');
});

test('drawdowns：窗口按日期取，稀疏序列不按数组下标', () => {
  // 40 个点但横跨 20 年（每半年一个点）——旧实现 slice(-36) 会把「近 3 年」
  // 算成近 18 年。按日期取窗时，3 年窗口内只有 7 个点。
  const s = [];
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2006, 8 + i * 6, 28));
    s.push({ date: d.toISOString().slice(0, 10), close: i === 0 ? 1000 : 100 });
  }
  const r = drawdowns(s);
  // 最早那个 1000 落在 20 年前，绝不能进 3 年窗口
  assert.equal(r.dd3y, 0, '3 年窗口内全是 100，末点也是 100 → 回撤 0');
  assert.ok(r.coverage.months === 40);
});

test('drawdowns：窗口内点数不足（minPointsPerWindow）时置空', () => {
  // 三个点横跨 8 年：5 年窗口内有 2 个点可算，13 周窗口内只有末点一个 → 置空
  const s = [
    { date: '2018-01-28', close: 100 },
    { date: '2023-01-28', close: 150 },
    { date: '2026-09-28', close: 80 },
  ];
  const r = drawdowns(s);
  assert.equal(r.dd13w, null, '3 个月窗口内只有 1 个点，不足以算回撤');
  assert.ok(r.dd5y !== null, '5 年窗口有 2 个点，可以算');
  assert.equal(r.dd5y.toFixed(4), (80 / 150 - 1).toFixed(4));
});

test('detectSplit：命中实测拆股（含拆股当月的真实价格漂移）', () => {
  // KLAC 6:1，比值 6.37——月内另跌 6%。容差 6% 会漏掉它，这是定容差时的实测依据。
  const klac = detectSplit([
    { date: '2026-05-28', close: 1921.71 },
    { date: '2026-06-28', close: 301.71 },
    { date: '2026-07-28', close: 280 },
  ]);
  assert.equal(klac.split, true);
  assert.equal(klac.ratio, 6);
  assert.equal(klac.at, '2026-06-28');

  // NVDA 10:1，比值 8.87——月内另跌 11%，漂移比直觉大得多
  assert.equal(detectSplit([
    { date: '2024-05-31', close: 1096.33 },
    { date: '2024-06-28', close: 123.54 },
  ]).split, true);
});

test('detectSplit：刻意过度包含——正常波动不报，深跌保守判为拆股', () => {
  // 单月 -30%（比值 1.43）：离任何整数倍都远，不报
  assert.equal(detectSplit([
    { date: '2026-05-28', close: 100 },
    { date: '2026-06-28', close: 70 },
  ]).split, false);

  // 单月 -50%（比值 2.00）：与 2:1 拆股在价格上本质不可分，保守判为拆股。
  // 后果是该区间置空而非输出错的数，方向符合 §6.5「宁缺毋滥」。
  // 这里把行为显式钉住，避免以后被误当成 bug「修掉」。
  const crash = detectSplit([
    { date: '2026-05-28', close: 100 },
    { date: '2026-06-28', close: 50 },
  ]);
  assert.equal(crash.split, true);
  assert.equal(crash.ratio, 2);
});

test('toMonthEnd：每月只留最后一个交易日', () => {
  const out = toMonthEnd([
    { date: '2026-08-03', close: 1 },
    { date: '2026-08-31', close: 2 },
    { date: '2026-09-01', close: 3 },
    { date: '2026-09-22', close: 4 },
  ]);
  assert.deepEqual(out.map((x) => [x.date, x.close]), [['2026-08-31', 2], ['2026-09-22', 4]]);
});
