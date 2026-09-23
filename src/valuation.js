// 估值层（SYSTEM_DEFINITION §2.3 / §2.4）：分位 → 三档区间 → 档位 → 安全边际 → 置信度。
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
      rows: s.map((r) => ({ date: r.date, pe: r.pe, pb: r.pb, ps: r.ps, close: r.close })),
    };
  }
  return reverseUsSeries(stock);
}

/**
 * 美股估值序列反算：历史日收盘 × 股数 ÷ 当期可得的 TTM 盈利 / 净资产 / 营收。
 * 关键是 PIT——每个交易日只能用「该日之前已披露」的财报，否则有前视偏差。
 * 日K 必须取不复权（fqt=0），复权价乘股数不等于当时市值。
 */
async function reverseUsSeries(stock) {
  const suffix = em.usSuffix(stock.mk);
  const [bars, st] = await Promise.all([
    tx.monthly(stock.code, 'us', stock.mk),   // 月频足够算分位，且不依赖已挂掉的东财 push2
    em.statementsUS(stock.code, suffix),
  ]);
  if (!bars?.length) return { source: '反算失败：历史价格不可得', rows: [] };

  // 单季报累加成 TTM，并记录该期的可用日（美股财报无 NOTICE_DATE，按期末 +45 天估计披露）
  const q = (st.quarterly || []).filter((r) => r.revenue != null || r.netProfit != null).slice().reverse(); // 旧→新
  const ttm = [];
  for (let i = 3; i < q.length; i++) {
    const win = q.slice(i - 3, i + 1);
    const sum = (k) => (win.every((r) => r[k] != null) ? win.reduce((s, r) => s + r[k], 0) : null);
    ttm.push({
      period: q[i].period,
      availableFrom: shiftDays(q[i].period, 45),
      netProfit: sum('parentNetProfit') ?? sum('netProfit'),
      revenue: sum('revenue'),
    });
  }
  // 年报给净资产与股数
  const ann = (st.annual || []).slice().sort((a, b) => (a.period < b.period ? -1 : 1));
  const equitySnaps = ann.filter((r) => r.equity != null)
    .map((r) => ({ availableFrom: shiftDays(r.period, 75), equity: r.parentEquity ?? r.equity }));
  const shareSnaps = ann.filter((r) => r.sharesDiluted != null || r.sharesBasic != null)
    .map((r) => ({ availableFrom: shiftDays(r.period, 75), shares: r.sharesDiluted ?? r.sharesBasic }));

  const pickAsOf = (snaps, date, key) => {
    let v = null;
    for (const s of snaps) { if (s.availableFrom <= date) v = s[key]; else break; }
    return v;
  };

  const rows = [];
  for (const b of bars) {
    const shares = pickAsOf(shareSnaps, b.date, 'shares');
    if (!shares || !b.close) continue;
    const cap = b.close * shares;
    const e = pickAsOf(ttm, b.date, 'netProfit');
    const eq = pickAsOf(equitySnaps, b.date, 'equity');
    const rev = pickAsOf(ttm, b.date, 'revenue');
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
  return { source: '腾讯月线 × 东财报表反算（PIT）', rows, reversed: true, freq: 'monthly',
    shares: shareSnaps.length ? shareSnaps[shareSnaps.length - 1].shares : null };
}

const shiftDays = (period, n) => {
  const d = new Date(period);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * 分位倍数。窗口取近 windowDays 个交易日；剔除负值与 >99 分位的极端点。
 * 序列不足 minWindowDays → 标记 insufficient，调用方强制降置信度。
 */
export function multiplePercentiles(rows, field, freq = 'daily') {
  // 窗口与年数都必须按频率换算：月频 120 点是 10 年，按日频公式会算成 0.5 年
  const perYear = freq === 'monthly' ? 12 : 250;
  const windowN = freq === 'monthly' ? Math.round((V.windowDays / 250) * 12) : V.windowDays;
  const minN = freq === 'monthly' ? Math.round((V.minWindowDays / 250) * 12) : V.minWindowDays;
  const win = (rows || []).slice(0, windowN);
  let vals = win.map((r) => r[field]).filter((x) => x != null && isFinite(x) && x > 0);
  if (!vals.length) return { ok: false, reason: `${field} 序列为空` };
  const cap = percentile(vals, V.outlierPct);
  vals = vals.filter((x) => x <= cap);
  const years = win.length / perYear;
  return {
    ok: true,
    p25: percentile(vals, 25), p50: percentile(vals, 50), p75: percentile(vals, 75),
    n: vals.length, years,
    insufficient: win.length < minN,
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
