// 归一化盈利（SYSTEM_DEFINITION §2.3 步骤 1）。
//
// 价值投资命门：周期底部 EPS 虚低甚至为负，用当期 EPS 算 PE 会把最佳买点标成「高估」、
// 把周期顶部（PE 最低时）标成「显著低估」。不做归一化，第 1 层粗筛就是反向指标。
//
// ⚠ 口径差异（实现中发现，与 §2.3 原文的补充说明）：
//   A股「营业利润」= 营业收入 − 成本费用 − **财务费用**（已扣利息），是利息「后」口径；
//   美股「营业利润」(Operating Income) 是利息「前」口径，利息属非经营项。
//   若两边都直接减归一化利息，A股会重复扣减一次。
//   故 A股先把利息支出加回还原成 EBIT，再统一走「EBIT − 归一化利息 → 征税」的流程，
//   保持「先归一化经营盈利能力，再施加资本结构」的原意。
import { median, safeDiv } from '../util.js';
import { SCREENING } from '../config.js';

const V = SCREENING.valuation;

/** 年报序列（A股取 12-31，美股取 annual），最多 N 年，最新在前。 */
export function annualRows(statements, market) {
  const rows = market === 'us' ? statements.annual || [] : (statements || []).filter((r) => r.period?.endsWith('12-31'));
  return rows.slice(0, V.normYears);
}

/** 把 A股营业利润还原为 EBIT（加回利息支出）；美股营业利润本身即 EBIT。 */
function ebitOf(row, market) {
  if (row.operateProfit == null) return null;
  if (market === 'us') return row.operateProfit;
  const interest = row.interestExpense ?? 0;
  return row.operateProfit + interest;
}

/**
 * TTM 营业收入。
 * A股为年内累计口径：TTM = 最新累计 + 上年年报 − 上年同期累计（最新为年报时直接取年报）。
 * 美股单季报直接求和最近 4 季。
 */
export function ttmRevenue(statements, market) {
  if (market === 'us') {
    const q = (statements.quarterly || []).filter((r) => r.revenue != null).slice(0, 4);
    return q.length === 4 ? q.reduce((s, r) => s + r.revenue, 0) : (statements.annual?.[0]?.revenue ?? null);
  }
  const rows = (statements || []).filter((r) => r.revenue != null);
  const latest = rows[0];
  if (!latest) return null;
  if (latest.period.endsWith('12-31')) return latest.revenue;
  const year = Number(latest.period.slice(0, 4));
  const mmdd = latest.period.slice(5);
  const lastFY = rows.find((r) => r.period === `${year - 1}-12-31`);
  const lastSame = rows.find((r) => r.period === `${year - 1}-${mmdd}`);
  if (lastFY == null || lastSame == null) return null;
  return latest.revenue + lastFY.revenue - lastSame.revenue;
}

/**
 * 归一化盈利。返回 null 表示年限不足（<5 年），调用方须标记并降置信度。
 * 金融股不走这里（§2.3 用归一化 ROE × 每股净资产）。
 */
export function normalizedEarnings(statements, market, { shares, isFinancial = false } = {}) {
  const rows = annualRows(statements, market);
  const flags = [];
  // 金融股的利息支出是核心经营成本，加回后 EBIT 会被严重虚增
  // （实测中信证券归一化利润率虚高到 67.6%，实际约 45%）。必须改走归一化 ROE 路径。
  if (isFinancial) {
    return { ok: false, reason: '金融股不适用 EBIT 归一化，改用归一化 ROE × 每股净资产', years: rows.length, flags };
  }
  if (rows.length < V.normYearsMin) {
    return { ok: false, reason: `年报仅 ${rows.length} 期，不足 ${V.normYearsMin} 年`, years: rows.length, flags };
  }

  // 归一化营业利润率（EBIT 口径）
  const margins = rows.map((r) => safeDiv(ebitOf(r, market), r.revenue)).filter((x) => x != null);
  const normMargin = median(margins);
  if (normMargin == null) return { ok: false, reason: '营业利润率不可得', years: rows.length, flags };

  const revTtm = ttmRevenue(statements, market);
  if (revTtm == null) return { ok: false, reason: 'TTM 营收不可得', years: rows.length, flags };

  const normEbit = normMargin * revTtm;

  // 归一化利息支出：取 7 年中位数；缺失则记 0 并标记（§2.3 用户修订）
  const interests = rows.map((r) => r.interestExpense).filter((x) => x != null && isFinite(x));
  let normInterest = median(interests);
  if (normInterest == null) { normInterest = 0; flags.push('利息支出缺失，按 0 计，置信度下调'); }

  const normPretax = normEbit - normInterest;

  // 实际税率中位数，截断到 [0, 40%] 以免个别年份的异常税率污染
  const taxRates = rows
    .map((r) => safeDiv(r.incomeTax, r.totalProfit))
    .filter((x) => x != null && x >= 0 && x <= 0.4);
  const taxRate = median(taxRates);
  if (taxRate == null) flags.push('实际税率不可得，按 25% 估算');
  const effTax = taxRate ?? 0.25;

  // 少数股东损益中位数（§2.3 用户修订：用中位数而非当期值）
  const minorities = rows.map((r) => r.minorityInterest).filter((x) => x != null && isFinite(x));
  const normMinority = median(minorities) ?? 0;

  const normNetProfit = normPretax * (1 - effTax) - normMinority;
  const normEps = safeDiv(normNetProfit, shares);

  return {
    ok: true,
    years: rows.length,
    normMargin, revTtm, normEbit, normInterest, normPretax,
    effTax, normMinority, normNetProfit, normEps,
    flags,
    // 回写驱动假设（§2.3 步骤 4 要求，否则结论不可证伪）
    assumptions: {
      口径: market === 'us' ? '营业利润即 EBIT' : '营业利润 + 利息支出 还原为 EBIT',
      归一化营业利润率: normMargin,
      样本年数: rows.length,
      TTM营收: revTtm,
      归一化利息支出: normInterest,
      实际税率: effTax,
      少数股东损益: normMinority,
    },
  };
}

/** 归一化 ROE（金融股用）：近 7 年 ROE 中位数。 */
export function normalizedRoe(statements, market) {
  const rows = annualRows(statements, market);
  if (rows.length < V.normYearsMin) return { ok: false, years: rows.length };
  const roes = rows.map((r) => safeDiv(r.parentNetProfit ?? r.netProfit, r.parentEquity ?? r.equity)).filter((x) => x != null);
  const v = median(roes);
  return v == null ? { ok: false, years: rows.length } : { ok: true, normRoe: v, years: rows.length };
}

/**
 * 周期股判定（§2.3 步骤 3）：近 7 年营业利润率变异系数 > 0.5，或营收同比曾超 ±25%。
 * 周期股主倍数切换为 PB —— 因为周期底部 PE 完全失真。
 */
export function isCyclical(statements, market) {
  const rows = annualRows(statements, market);
  if (rows.length < 3) return { cyclical: false, reason: '样本不足' };
  const margins = rows.map((r) => safeDiv(ebitOf(r, market), r.revenue)).filter((x) => x != null);
  const { cv } = { cv: (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length;
    if (m <= 0) return null;
    const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
    return sd / m; } };
  const marginCv = margins.length >= 3 ? cv(margins) : null;
  // 营收同比波动
  // 上行与下行波动分开统计：真周期是「大涨也大跌」，单边高增长不是周期。
  const revs = rows.map((r) => r.revenue).filter((x) => x != null);
  let maxUp = 0, maxDown = 0;
  for (let i = 0; i < revs.length - 1; i++) {
    const yoy = safeDiv(revs[i] - revs[i + 1], Math.abs(revs[i + 1]));
    if (yoy == null) continue;
    if (yoy > 0) maxUp = Math.max(maxUp, yoy); else maxDown = Math.max(maxDown, -yoy);
  }
  const maxSwing = Math.max(maxUp, maxDown);
  const byCv = marginCv != null && marginCv > V.cyclicalCV;
  const bySwing = maxSwing > V.cyclicalRevSwing;
  // 只有上行波动大、没有像样的下行 —— 更像高增长而非周期。
  // 机械层不裁决这类案例，交给模型（§2.3 步骤 3 补充）。
  const ambiguous = bySwing && !byCv && maxDown < 0.15;
  return {
    cyclical: byCv || bySwing,
    ambiguous,
    marginCv, maxRevSwing: maxSwing, maxUpSwing: maxUp, maxDownSwing: maxDown,
    reason: byCv ? `利润率变异系数 ${marginCv.toFixed(2)} > ${V.cyclicalCV}`
      : ambiguous ? `营收曾涨 ${(maxUp * 100).toFixed(0)}% 但最大跌幅仅 ${(maxDown * 100).toFixed(0)}% —— 像高增长而非周期，口径待模型裁决`
      : bySwing ? `营收同比最大波动 ${(maxSwing * 100).toFixed(0)}% > ${V.cyclicalRevSwing * 100}%` : '稳定',
  };
}

export { ebitOf };
