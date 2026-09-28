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
 * 股性证据（v0.10.0，§2.3 步骤 3）：逐年的营业利润率 / 营收同比 / ROE，**只陈列、不判定**。
 *
 * 此前这里是 isCyclical()：利润率变异系数 > 0.5 或营收同比曾超 ±25% 即判周期股、
 * 主倍数切成 PB。实测 A股 55 只非金融候选被判周期 35 只（64%）——迈瑞医疗、金山办公、
 * 豪迈科技都因「某一年营收涨超 25%」入选；世纪华通因 2022 年一笔商誉减值（营业利润率
 * −54%）把变异系数拉到 3.44。35 只里 25 只换口径后档位不同，8 只相差 ≥2 档。
 * 调阈值救不回来（「去掉最差一年」能纠正世纪华通，却会放掉真周期股盐湖股份），
 * 因为股性本是商业判断：利润由什么驱动、会不会均值回归。所以机械层只给事实，判断交给模型。
 */
export function fundamentalHistory(statements, market) {
  const rows = annualRows(statements, market);
  if (!rows.length) return null;
  const pct = (v) => (v == null || !isFinite(v) ? null : v);
  return {
    years: rows.map((r) => String(r.period || '').slice(0, 4)),
    margin: rows.map((r) => pct(safeDiv(ebitOf(r, market), r.revenue))),
    revYoy: rows.map((r, i) => (i + 1 < rows.length
      ? pct(safeDiv((r.revenue ?? NaN) - (rows[i + 1].revenue ?? NaN), Math.abs(rows[i + 1].revenue ?? NaN)))
      : null)),
    roe: rows.map((r) => pct(safeDiv(r.parentNetProfit ?? r.netProfit, r.parentEquity ?? r.equity))),
  };
}

/**
 * 最近单季趋势（v0.11.0，美股）：年报之后发生的事，此前模型一个季度都看不到——
 * 东财单季报早已取回（statementsUS().quarterly），档案却只渲染年报，工具也只给年报。
 * 实测 APP：最近一份 10-K 是 2026-02，而 2026Q2 已披露（营收同比 +52%），模型却说
 * 「要等下一份季报」。只陈列事实：营收、营业利润率、归母净利及其同比。
 *
 * 同比按「约一年前的那一季」配对（±20 天），不按月日字符串：美股财年季末常是
 * 某周六（2026-06-27 vs 2025-06-28），字符串相等会让一半公司配不上。
 * A股单季报是累计口径（另有 get_main_indicators），此处只处理美股，A股返回 null。
 */
export function quarterlyHistory(statements, market, { n = 8 } = {}) {
  if (market !== 'us') return null;
  const q = (statements?.quarterly || [])
    .filter((r) => r?.period && (r.revenue != null || r.netProfit != null || r.parentNetProfit != null))
    .slice()
    .sort((a, b) => (a.period < b.period ? 1 : -1));
  if (!q.length) return null;
  const day = (p) => Date.parse(`${String(p).slice(0, 10)}T00:00:00Z`) / 86400e3;
  const yearAgo = (r) => q.find((x) => Math.abs(day(r.period) - day(x.period) - 365) <= 20) || null;
  const yoy = (a, b) => (a == null || b == null || !isFinite(a) || !isFinite(b) || b === 0 ? null : (a - b) / Math.abs(b));
  const np = (r) => r?.parentNetProfit ?? r?.netProfit ?? null;
  const rows = q.slice(0, n).map((r) => {
    const prev = yearAgo(r);
    return {
      period: String(r.period).slice(0, 10),
      currency: r.currency || null,
      revenue: r.revenue ?? null,
      revYoy: yoy(r.revenue, prev?.revenue),
      opMargin: safeDiv(r.operateProfit ?? null, r.revenue ?? null),
      netProfit: np(r),
      npYoy: yoy(np(r), np(prev)),
      eps: r.eps ?? null,
      epsDiluted: r.epsDiluted ?? null,
      // 非经营损益 = 税前利润 − 营业利润（利息、投资收益、其他收支）。v0.11.3：此前档案看不到，
      // 而它能占到税前利润的一大块（实测 2026Q2 GOOGL 71%、AMZN 66%、NVDA 11%）——
      // PE(TTM) 因此被非经营收益压低，模型却只看到「利润增长很快」
      nonOpShare: r.totalProfit != null && r.operateProfit != null && r.totalProfit > 0
        ? (r.totalProfit - r.operateProfit) / r.totalProfit : null,
    };
  });
  return { asOf: rows[0].period, rows };
}

export { ebitOf };
