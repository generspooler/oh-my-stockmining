// 估值层（SYSTEM_DEFINITION §2.3 / §2.4）：分位 → 估值锚 / 三档区间 → 档位 → 安全边际 → 置信度。
// 这是 §2.3 的唯一实现处，代码必须严格照此，其他模块不得自行折算估值。
import { percentile, percentileRankOf, median, safeDiv, daysBetween } from './util.js';
import { SCREENING } from './config.js';
import * as em from './sources/em.js';
import * as tx from './sources/tencent.js';

const V = SCREENING.valuation;
const C = SCREENING.confidence;

/**
 * 倍数分位序列。
 * A股：东财 RPT_VALUEANALYSIS_DET 直接给逐日 PE/PB/PS，取用即可。
 * 美股：东财无对应表，必须反算（§4.2 缺口 #1）。
 */
export async function multipleSeries(stock) {
  if (stock.market === 'cn') {
    const s = await em.valuationSeriesCN(stock.code);
    return {
      source: '东财估值序列', freq: 'daily',
      shares: s[0]?.shares ?? null,
      rows: s.map((r) => ({
        date: r.date, close: r.close,
        pe: r.pe, peLar: r.peLar, pb: r.pb, ps: r.ps, pcf: r.pcf, pcfLar: r.pcfLar, peg: r.peg,
      })),
    };
  }
  return reverseUsSeries(stock);
}

/**
 * 拆股事件（纯函数，可测）。adj = 后复权月线、raw = 不复权月线，均 [{date, close}]，任意次序。
 *
 * 同一个月「后复权 ÷ 不复权」之比只随两件事变：分红（每年几个百分点）与拆股（整数倍）。
 * 相邻两月之比跳到 ≥ 1.45 或 ≤ 0.69 即判为该月发生拆股（合股），跳幅就是比例。
 * 这**不是**从价格跳变猜拆股——两条序列是同一组成交价，比值里没有涨跌，只有复权因子
 * （v0.12 的教训：NVDA 一个月真实涨 8.87 倍的行情被当成过 8:1 拆股）。
 * 返回 [{ ym: 'YYYY-MM', ratio }]，旧→新；ratio > 1 为拆股，< 1 为合股。
 */
export function splitEvents(adj, raw) {
  const ym = (d) => String(d).slice(0, 7);
  const A = new Map((adj || []).map((r) => [ym(r.date), r.close]));
  const g = (raw || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => ({ ym: ym(r.date), g: A.get(ym(r.date)) / r.close }))
    .filter((x) => isFinite(x.g) && x.g > 0);
  const out = [];
  for (let i = 1; i < g.length; i++) {
    const r = g[i].g / g[i - 1].g;
    if (r >= V.splitJumpUp || r <= V.splitJumpDown) out.push({ ym: g[i].ym, ratio: r });
  }
  return out;
}

/** 某月之后（不含该月）发生的拆股累计比例：该月 1 股 = 现在多少股。 */
const splitAfter = (events, ym) => events.filter((e) => e.ym > ym).reduce((p, e) => p * e.ratio, 1);

/**
 * 报表股数折到**现在的股数基数**（纯函数，可测）。
 *
 * 东财美股年报股数常按后来的拆股回溯重述，单季报却多是原始申报值，同一份报表里两种基数并存
 * （实测 NVDA：FY2024 年报 249.4 亿股 = 拆股后口径；2023-04 单季报 24.9 亿 = 拆股前口径）。
 * 每期股数只有两类可能：原样申报（还要乘上此后全部拆股）或已重述到此后某次拆股之后。
 * 拆股比例 ≥ 1.5，真实股数几年里的变化远小于它，所以取「折算后最接近参照」的那个解释。
 * ref：现基数下的参照股数（最近一期股数，拿不准时用市值 ÷ 现价裁决）。
 * 返回 [{ ...snap, sharesNow, restated }]。
 */
export function sharesToCurrentBasis(snaps, events, ref) {
  if (!events?.length || !(ref > 0)) return (snaps || []).map((s) => ({ ...s, sharesNow: s.shares, restated: false }));
  return (snaps || []).map((s) => {
    const later = events.filter((e) => e.ym > String(s.period).slice(0, 7));
    // 候选「已被计入的拆股」：没重述、重述到第 1 次之后、……、重述到最近一次之后
    const applied = [1];
    for (const e of later) applied.push(applied[applied.length - 1] * e.ratio);
    const total = applied[applied.length - 1];
    let best = null;
    for (const a of applied) {
      const now = s.shares * (total / a);
      const err = Math.abs(Math.log(now / ref));
      if (!best || err < best.err) best = { now, err, a };
    }
    return { ...s, sharesNow: best.now, restated: best.a !== 1 };
  });
}

/** 一只票现基数的参照股数：最近一期股数的两种解释里，离「市值 ÷ 现价」更近的那个。 */
function referenceShares(latest, events, capShares) {
  if (!latest) return null;
  const after = splitAfter(events, String(latest.period).slice(0, 7));
  const cands = [latest.shares * after, latest.shares];
  if (!(capShares > 0) || after === 1) return cands[0];
  return cands.reduce((b, c) => (Math.abs(Math.log(c / capShares)) < Math.abs(Math.log(b / capShares)) ? c : b));
}

/**
 * 美股估值序列反算：历史月收盘 × 当月股数 ÷ 当期可得的 TTM 盈利 / 净资产 / 营收。
 * 关键是 PIT——每个月只能用「该月之前已披露」的财报，否则有前视偏差。
 * 价格必须取不复权（复权价乘股数不等于当时市值）；股数与价格必须是**同一基数**（v0.11.3）。
 *
 * v0.11.3 修掉的三处口径错误（全部静默，实测会翻转安全边际）：
 *   1. 拆股：重述后的股数 × 拆股前的价格 → NVDA 2023-04 PE 算成 1592 倍；AVGO PS 锚安全边际 +19% 实为约 −32%。
 *   2. 股数不设时效：GOOGL 年报股数最新一期是 FY2012（6.65 亿股，现约 122 亿），PE 中位算成 1.4 倍。
 *      现在年报 + 单季报股数合用，超过 `V.staleSnapshotDays` 的快照不用。
 *   3. PB 历史只用年报净资产、现值却是接口最新季：净资产增长快的公司 PB 系统性显得便宜 15%~50%。
 *      现在净资产用季度资产负债表（取不到才退回年报，并让现值同口径反算）。
 * 另：报表币种不是美元（ADR / 外国发行人）时不反算——汇率与 ADR 换股比例未核实，
 * TSM 的 PE 历史因此曾被算成真实值的六分之一。
 */
async function reverseUsSeries(stock) {
  const suffix = em.usSuffix(stock.mk);
  const secid = stock.secid || em.usSecid(stock.code, stock.mk);
  const [bars, st, adj] = await Promise.all([
    tx.monthly(stock.code, 'us', stock.mk),   // 月频足够算分位，且不依赖已挂掉的东财 push2
    em.statementsUS(stock.code, suffix),
    // 与 returns.adjustedMonthly 同一个请求（同一缓存键），只用来定位拆股
    em.kline(secid, { klt: 103, fqt: 2, beg: SCREENING.drawdown.beg }).catch(() => []),
  ]);
  if (!bars?.length) return { source: '反算失败：历史价格不可得', rows: [] };

  const currency = st.quarterly?.[0]?.currency || st.annual?.[0]?.currency || 'USD';
  if (currency !== 'USD') {
    return {
      source: `反算不可用：报表币种 ${currency}`, rows: [], unavailable: true,
      reason: `报表币种为 ${currency}（多为 ADR / 外国发行人），与美元股价不能直接相除；汇率与 ADR 换股比例未核实，不出历史分位`,
    };
  }

  // 单季报累加成 TTM，并记录该期的可用日（美股财报无 NOTICE_DATE，按期末 +45 天估计披露）。
  // 四个季度必须连续（首尾期末相距约 9 个月）：有断档时拼出来的不是 TTM
  const q = (st.quarterly || []).filter((r) => r.revenue != null || r.netProfit != null).slice().reverse(); // 旧→新
  const ttm = [];
  for (let i = 3; i < q.length; i++) {
    const win = q.slice(i - 3, i + 1);
    const span = daysBetween(win[0].period, win[3].period);
    if (!(span >= 240 && span <= 310)) continue;
    const sum = (k) => (win.every((r) => r[k] != null) ? win.reduce((s, r) => s + r[k], 0) : null);
    ttm.push({
      period: q[i].period,
      availableFrom: shiftDays(q[i].period, 45),
      netProfit: sum('parentNetProfit') ?? sum('netProfit'),
      revenue: sum('revenue'),
    });
  }

  // 净资产：优先季度资产负债表（v0.11.3），取不到退回年报
  const balances = (st.balances || []).filter((r) => r.equity != null || r.parentEquity != null);
  const equityQuarterly = balances.some((r) => r.reportType && r.reportType !== '年报');
  const eqSrc = equityQuarterly ? balances : (st.annual || []).filter((r) => r.equity != null);
  const equitySnaps = eqSrc.slice().sort((a, b) => (a.period < b.period ? -1 : 1))
    .map((r) => ({
      period: r.period, equity: r.parentEquity ?? r.equity,
      availableFrom: shiftDays(r.period, r.reportType && r.reportType !== '年报' ? 45 : 75),
    }));

  // 股数：年报 + 单季报合用，折到现基数
  const rawShares = [
    ...(st.annual || []).map((r) => ({ period: r.period, lag: 75, shares: r.sharesDiluted ?? r.sharesBasic })),
    ...(st.quarterly || []).map((r) => ({ period: r.period, lag: 45, shares: r.sharesDiluted ?? r.sharesBasic })),
  ].filter((s) => s.shares > 0).sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.lag - b.lag));
  const byPeriod = new Map();
  for (const s of rawShares) if (!byPeriod.has(s.period)) byPeriod.set(s.period, s);   // 同一期末优先单季报
  const shareRaw = [...byPeriod.values()];
  const events = splitEvents(adj, bars);
  const capShares = stock.marketCap > 0 && stock.price > 0 ? stock.marketCap / stock.price : null;
  const ref = referenceShares(shareRaw[shareRaw.length - 1], events, capShares);
  const shareSnaps = sharesToCurrentBasis(shareRaw, events, ref)
    .map((s) => ({ ...s, availableFrom: shiftDays(s.period, s.lag) }));

  const pickAsOf = (snaps, date) => {
    let v = null;
    for (const s of snaps) { if (s.availableFrom <= date) v = s; else break; }
    // 过期的快照不用：宁可这个月没有点，也不拿十年前的股数去乘今天的股价
    return v && daysBetween(v.period, date) <= V.staleSnapshotDays ? v : null;
  };

  const rows = [];
  for (const b of bars) {
    const sh = pickAsOf(shareSnaps, b.date);
    if (!sh || !b.close) continue;
    // 当月价格是当月基数：现基数股数 ÷ 此后的拆股比例 = 当月基数股数
    const cap = b.close * (sh.sharesNow / splitAfter(events, String(b.date).slice(0, 7)));
    const e = pickAsOf(ttm, b.date)?.netProfit;
    const eq = pickAsOf(equitySnaps, b.date)?.equity;
    const rev = pickAsOf(ttm, b.date)?.revenue;
    rows.push({
      date: b.date, close: b.close,
      pe: e && e > 0 ? cap / e : null,
      pb: eq && eq > 0 ? cap / eq : null,
      ps: rev && rev > 0 ? cap / rev : null,
    });
  }
  // 统一为「新→旧」：A股估值序列是 desc，两边必须一致，
  // 否则 rows[0] 在美股会取到十年前那个点，分位窗口也会截到最老的一段。
  rows.reverse();
  const restated = shareSnaps.filter((s) => s.restated).length;
  const notes = [
    events.length
      ? `拆股 ${events.map((e) => `${e.ym} ${e.ratio >= 1 ? `${fmtRatio(e.ratio)}:1` : `1:${fmtRatio(1 / e.ratio)}`}`).join('、')}，股数已折到同一基数`
        + (restated ? `（其中 ${restated} 期报表股数是按后来拆股重述过的）` : '')
      : (adj?.length ? null : '复权序列不可得，未能核对拆股口径'),
    equityQuarterly ? null : 'PB 历史只有年报净资产（季度资产负债表不可得），现值按同口径反算',
  ].filter(Boolean);
  const latestEq = equitySnaps[equitySnaps.length - 1] || null;
  return {
    source: '腾讯月线 × 东财报表反算（PIT）', rows, reversed: true, freq: 'monthly',
    shares: ref ?? null, splits: events, notes, equityQuarterly,
    latestEquity: latestEq ? { period: latestEq.period, equity: latestEq.equity } : null,
  };
}

const fmtRatio = (r) => (Math.abs(r - Math.round(r)) < 0.05 ? String(Math.round(r)) : r.toFixed(2));

const shiftDays = (period, n) => {
  const d = new Date(period);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * 分位倍数。窗口取近 windowDays 个交易日；剔除负值与 >99 分位的极端点。
 * 序列不足 minWindowDays → 标记 insufficient，调用方强制降置信度。
 */
/** 分位窗口：近 windowDays 个交易日（月频按 12/250 换算）。 */
function windowOf(rows, freq) {
  const windowN = freq === 'monthly' ? Math.round((V.windowDays / 250) * 12) : V.windowDays;
  return (rows || []).slice(0, windowN);
}

export function multiplePercentiles(rows, field, freq = 'daily') {
  // 窗口与年数都必须按频率换算：月频 120 点是 10 年，按日频公式会算成 0.5 年
  const perYear = freq === 'monthly' ? 12 : 250;
  const minN = freq === 'monthly' ? Math.round((V.minWindowDays / 250) * 12) : V.minWindowDays;
  const win = windowOf(rows, freq);
  const valid = win.filter((r) => r[field] != null && isFinite(r[field]) && r[field] > 0);
  let vals = valid.map((r) => r[field]);
  if (!vals.length) return { ok: false, reason: `${field} 序列为空` };
  // 被剔除的点（缺失或 ≤0，即亏损期 / 净资产为负）要如实计数：它是「这个锚失真没有」的直接证据
  const excluded = win.length - vals.length;
  const cap = percentile(vals, V.outlierPct);
  vals = vals.filter((x) => x <= cap);
  // 年数按**有效点**的真实日期跨度算（v0.11.3）：窗口 60 个月、有效点只有 9 个时，它不是 5 年分位
  const dated = valid.filter((r) => r.date);
  const years = dated.length >= 2
    ? (Math.abs(daysBetween(dated[dated.length - 1].date, dated[0].date)) + 365 / perYear) / 365.25
    : valid.length / perYear;
  return {
    ok: true,
    p25: percentile(vals, 25), p50: percentile(vals, 50), p75: percentile(vals, 75),
    n: vals.length, years, window: win.length, excluded,
    // 有效点数不足 3 年的量（月频 36、日频 750），或有效点真实跨度不足 3 年
    insufficient: vals.length < minN || years < V.minValidYears,
    field,
  };
}

/**
 * 三档区间（§2.3 步骤 4）。
 * 每股口径 × 对应分位倍数。必须回写驱动假设，否则结论不可证伪。
 */
export function bands({ route, perShare, pcts, price }) {
  if (!pcts?.ok || perShare == null || perShare <= 0) {
    return { ok: false, reason: pcts?.reason || '每股口径不可用' };
  }
  const conservative = perShare * pcts.p25;
  const neutral = perShare * pcts.p50;
  const optimistic = perShare * pcts.p75;
  const pv = safeDiv(price, neutral);
  return {
    ok: true,
    conservative, neutral, optimistic, pv,
    tier: tierOf(pv),
    // 现价相对保守档的偏离；以及在 [保守,乐观] 区间内的位置
    vsConservative: safeDiv(price - conservative, conservative),
    posInBand: safeDiv(price - conservative, optimistic - conservative),
    dispersion: safeDiv(optimistic, conservative),
    assumptions: {
      主倍数: route.primary, 口径说明: route.reason,
      每股口径值: perShare,
      分位倍数: { P25: pcts.p25, P50: pcts.p50, P75: pcts.p75 },
      序列长度年: Number(pcts.years?.toFixed(1)), 样本点: pcts.n,
      序列不足: !!pcts.insufficient,
    },
  };
}

/** 档位判定（§2.3 步骤 5）：按 P/V 比值。 */
export function tierOf(pv) {
  if (pv == null || !isFinite(pv)) return { index: null, name: '不可判定' };
  const i = SCREENING.tiers.findIndex((t) => pv <= t.max);
  const idx = i < 0 ? SCREENING.tiers.length - 1 : i;
  return { index: idx, name: SCREENING.tiers[idx].name };
}

// ── 估值锚（v0.10.0，§2.3 步骤 3）───────────────────────────────
// 机械层**不判股性、不选锚**：把能算的锚全部并排给模型，各带失真诊断（事实，不是判定），
// 由模型判断股性后选一个，或判定都不可信。此前的「周期股 → PB」路由已删除。
//
// 倍数优先用**接口原值**（用户决策 2026-09-26：能从接口拿到的不自己重算）：
//   A股：当前值与 5 年历史都来自东财 RPT_VALUEANALYSIS_DET（逐日）；
//   美股：当前 PE(TTM)/PB 来自东财行情列表；历史分位接口没有，只能反算（腾讯月线 × SEC 报表）。
// 唯一必须自己算的是「归一化 PE」：它是一个分析假设（利润率回归 7 年中位），不是接口字段。

export const ANCHOR_DEFS = [
  { key: 'pe', label: 'PE(TTM)', field: 'pe' },
  { key: 'pe_lar', label: 'PE(静态)', field: 'peLar' },
  { key: 'pb', label: 'PB', field: 'pb' },
  { key: 'ps', label: 'PS(TTM)', field: 'ps' },
  { key: 'pcf', label: 'PCF(经营现金流TTM)', field: 'pcf' },
];
/** 美股反算序列只有这三个字段 */
const US_KEYS = new Set(['pe', 'pb', 'ps']);

/**
 * 单个倍数锚：现值在自身 5 年历史里的位置。P/V = 现值 ÷ 5 年中位（与「每股口径 × 中位倍数」
 * 的旧算法数学上等价，但每股口径不必自己重算）。prices 只是同一组接口数字的换算。
 */
export function multipleAnchor(def, { rows, freq = 'daily', current, price, from }) {
  const base = { key: def.key, label: def.label, from };
  if (current == null || !isFinite(current)) return { ...base, ok: false, reason: '无当前值' };
  if (current <= 0) return { ...base, ok: false, current, reason: '当前值 ≤ 0（亏损或净资产为负），该倍数无意义' };
  const pc = multiplePercentiles(rows, def.field, freq);
  if (!pc.ok) return { ...base, ok: false, current, reason: pc.reason };
  const win = windowOf(rows, freq).map((r) => r[def.field]).filter((x) => x != null && isFinite(x) && x > 0);
  const pv = current / pc.p50;
  return {
    ...base, ok: true, current,
    p25: pc.p25, p50: pc.p50, p75: pc.p75,
    years: pc.years, n: pc.n, window: pc.window, excluded: pc.excluded, insufficient: pc.insufficient,
    rank: percentileRankOf(win, current),
    pv, tier: tierOf(pv),
    prices: price ? { p25: (price * pc.p25) / current, p50: (price * pc.p50) / current, p75: (price * pc.p75) / current } : null,
  };
}

/** 归一化 PE 锚（系统推算）：现价 ÷ 归一化 EPS，与 PE(TTM) 的 5 年分位对照。 */
export function normalizedPeAnchor({ rows, freq = 'daily', norm, price, from }) {
  const base = { key: 'pe_norm', label: '归一化PE', from };
  if (!norm?.ok) return { ...base, ok: false, reason: norm?.reason || '归一化不可用' };
  if (!(norm.normEps > 0)) return { ...base, ok: false, reason: '归一化 EPS ≤ 0' };
  if (!(price > 0)) return { ...base, ok: false, reason: '现价不可得' };
  const a = multipleAnchor({ key: 'pe_norm', label: '归一化PE', field: 'pe' }, {
    rows, freq, current: price / norm.normEps, price, from,
  });
  return { ...a, normEps: norm.normEps, normMargin: norm.normMargin };
}

/**
 * 一只票的全部估值锚。series 是 multipleSeries() 的返回（A股接口逐日 / 美股反算月频）。
 * 返回数组，顺序固定；不可算的锚也保留（ok:false + reason），让模型知道「为什么没有它」。
 */
export function anchorsFor({ row, series, norm, market }) {
  const rows = series?.rows || [];
  const freq = series?.freq || 'daily';
  const latest = rows[0] || {};
  const price = row?.price ?? latest.close ?? null;
  const out = [];
  // 反算被判为不可做（报表非美元等）：每个锚都如实写原因，不留一个「序列为空」让模型猜
  if (series?.unavailable) {
    for (const def of ANCHOR_DEFS) {
      if (market === 'us' && !US_KEYS.has(def.key)) continue;
      out.push({ key: def.key, label: def.label, from: '反算', ok: false, reason: series.reason });
    }
    out.push({ key: 'pe_norm', label: '归一化PE', from: '系统推算 · 反算历史', ok: false, reason: series.reason });
    return out;
  }
  for (const def of ANCHOR_DEFS) {
    if (market === 'us' && !US_KEYS.has(def.key)) continue;
    let current = latest[def.field] ?? null;
    let from = market === 'cn' ? '接口' : '反算';
    // 美股 PE(TTM)/PB 的**当前值**东财行情列表直接给，优先用接口值；历史仍是反算。
    // 例外（v0.11.3）：PB 历史只有年报净资产时，接口现值（最新季净资产）与历史不同口径，
    // 改用同一份净资产反算现值——同口径的旧数，比不同口径的新数更能比
    const pbAnnualOnly = market === 'us' && def.key === 'pb' && series?.equityQuarterly === false;
    if (pbAnnualOnly && series.latestEquity?.equity > 0 && series.shares > 0 && price > 0) {
      current = (price * series.shares) / series.latestEquity.equity;
      from = `反算（年报净资产 ${series.latestEquity.period}，与历史同口径）`;
    } else if (market === 'us' && (def.key === 'pe' || def.key === 'pb') && row?.[def.key] != null) {
      current = row[def.key];
      from = '接口现值 · 反算历史';
    }
    if (market === 'cn' && current == null && (def.key === 'pe' || def.key === 'pb')) current = row?.[def.key] ?? null;
    out.push(multipleAnchor(def, { rows, freq, current, price, from }));
  }
  out.push(normalizedPeAnchor({ rows, freq, norm, price, from: market === 'cn' ? '系统推算 · 接口历史' : '系统推算 · 反算历史' }));
  return out;
}

/**
 * 把模型选的锚解析成可展示的估值（纯函数，可测）。数字一律取自机械层算好的锚，
 * 模型只负责「选哪个」——延续「数字由代码算」的铁律。
 *   null        → 模型没选（旧提示词 / 旧快照 / 代码补位条目）
 *   {key:'none'} → 模型判定各锚都不可信：渲染层不显示安全边际数字
 *   {invalid}   → 模型选了档案里没有、或不可算的锚
 */
export function resolveAnchor(choice, anchors) {
  if (choice == null || String(choice).trim() === '') return null;
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s()（）]/g, '');
  const k = norm(choice);
  if (/^(none|无|都不可信|不可信|均不可信|n\/a)$/.test(k)) return { key: 'none' };
  const hit = (anchors || []).find((a) => a.key === k || norm(a.label) === k);
  if (!hit) return { key: String(choice).trim(), invalid: true, reason: '档案里没有这个锚' };
  if (!hit.ok) return { key: hit.key, label: hit.label, invalid: true, reason: hit.reason };
  return {
    key: hit.key, label: hit.label, from: hit.from,
    current: hit.current, p50: hit.p50, pv: hit.pv, mos: actualMos(hit.pv), tier: hit.tier.name,
  };
}

/**
 * 落盘 / 推给前端的精简形态：不带分位窗口原始数据。
 * v0.11.3 起留下 P25/P75、有效点数、剔除数、样本不足——事后复核「这个锚当时可不可信」只能靠它们。
 */
export const compactAnchors = (anchors) => (anchors || []).map((a) => (a.ok
  ? {
    key: a.key, label: a.label, ok: true, from: a.from, current: a.current,
    p25: a.p25, p50: a.p50, p75: a.p75, rank: a.rank, pv: a.pv, tier: a.tier?.name,
    n: a.n, excluded: a.excluded || undefined, insufficient: a.insufficient || undefined,
  }
  : { key: a.key, label: a.label, ok: false, reason: a.reason }));

// v0.3 起安全边际不再是淘汰闸门，只作为「按传统标准需要多深折价」的参考值展示给模型。
// 标定说明：格雷厄姆的 30% 对标的是保守估算的内在价值；本系统的中性值是
// 「该股自身 5 年倍数中位数」，锚里已含市场定价，不是保守估计。
// 两者概念不同，相对分位框架下 20–30% 才是对应量级。
const MOS_BY_FSCORE = { 9: 0.20, 8: 0.20, 7: 0.25, 6: 0.30 };

/** 参考安全边际：按 F-Score 分档，质量越低要求折价越深。仅供展示，不做淘汰。 */
export function requiredMos(fScore) {
  if (fScore == null) return MOS_BY_FSCORE[6];
  return MOS_BY_FSCORE[Math.min(9, Math.max(6, Math.round(fScore)))] ?? MOS_BY_FSCORE[6];
}

/** 实际安全边际 = 1 − P/V。 */
export const actualMos = (pv) => (pv == null ? null : 1 - pv);

/**
 * 置信度（§2.4）：四因子加权，可计算而非模型主观给出。
 * viewAgreement 传入「视角与区间方向一致的比例」(0–1)，不是「投低估的票数」——
 * 后者会让视角与区间矛盾的标的反而拿高分。
 */
export function confidence({ seriesYears, coverage, viewAgreement, dispersion, penalties = [] }) {
  const w = C.weights;
  const sLen = seriesYears == null ? 0 : Math.max(0, Math.min(1, seriesYears / 5)) * 100;
  const cov = coverage == null ? 0 : Math.max(0, Math.min(1, coverage)) * 100;
  const agree = viewAgreement == null ? 0 : Math.max(0, Math.min(1, viewAgreement)) * 100;
  let disp = 100;
  if (dispersion != null && isFinite(dispersion)) {
    if (dispersion <= C.dispersionGood) disp = 100;
    else if (dispersion >= C.dispersionBad * 1.6) disp = 0;
    else disp = Math.max(0, 100 - ((dispersion - C.dispersionGood) / (C.dispersionBad * 1.6 - C.dispersionGood)) * 100);
  }
  let score = sLen * w.seriesLength + cov * w.coverage + agree * w.viewAgreement + disp * w.dispersion;
  // 每条惩罚降一档（约 15 分）
  score = Math.max(0, score - penalties.length * 15);
  const level = C.levels.find((l) => score >= l.min)?.name || '低';
  return { score: Math.round(score), level, parts: { 序列长度: Math.round(sLen), 字段覆盖: Math.round(cov), 视角一致: Math.round(agree), 区间离散: Math.round(disp) }, penalties };
}
