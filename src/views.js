// 多视角交叉校验（SYSTEM_DEFINITION §2.2）。
// 五个相互独立的视角各自独立表态，再交叉校验：≥3 个同向指向低估，才允许给「低估」及以上档位。
// 视角 3 与视角 1 冲突时以视角 3 为准（当期盈利失真是周期股最大的陷阱）。
import { percentileRankOf, median, safeDiv } from './util.js';
import { SCREENING } from './config.js';

// 无风险利率：A股取中国10年国债近似，美股取美债10Y近似。
// 暂用常数（未接入稳定的免密钥利率源），可由环境变量覆盖；报告中如实标注为估计值。
export const RISK_FREE = {
  cn: Number(process.env.MINE_RF_CN) || 0.018,
  us: Number(process.env.MINE_RF_US) || 0.042,
};

const V = (verdict, detail, value) => ({ verdict, detail, value });
const UNDER = 'undervalued', FAIR = 'fair', OVER = 'overvalued', NA = 'na';

/** 视角 1 · 自身历史：当前倍数在自身 5 年分位中的位置。 */
export function viewSelfHistory({ series, field, current }) {
  if (current == null || !series?.length) return V(NA, '序列或当期倍数不可得');
  const vals = series.map((r) => r[field]).filter((x) => x != null && x > 0);
  const rank = percentileRankOf(vals, current);
  if (rank == null) return V(NA, '分位不可得');
  const verdict = rank < 30 ? UNDER : rank > 70 ? OVER : FAIR;
  return V(verdict, `当前 ${field.toUpperCase()} ${current.toFixed(1)} 处自身 5 年第 ${rank.toFixed(0)} 分位`, rank);
}

/** 视角 2 · 同业横截面：当前倍数 vs 行业当期中位数。排除「整个行业都贵/都便宜」的错觉。 */
export function viewPeers({ current, peers, field = 'pe' }) {
  const vals = (peers || []).map((p) => p[field]).filter((x) => x != null && x > 0);
  if (current == null || vals.length < 5) return V(NA, `同业样本 ${vals.length} 只，不足 5 只`);
  const med = median(vals);
  const ratio = safeDiv(current, med);
  if (ratio == null) return V(NA, '行业中位数不可得');
  const verdict = ratio < 0.8 ? UNDER : ratio > 1.25 ? OVER : FAIR;
  return V(verdict, `${field.toUpperCase()} ${current.toFixed(1)} vs 行业中位 ${med.toFixed(1)}（${(ratio * 100).toFixed(0)}%）`, ratio);
}

/**
 * 视角 3 · 盈利质量：归一化盈利 vs 当期 TTM 盈利的偏离度。
 * 归一化显著高于当期 → 当期盈利处于低谷，当期 PE 虚高，是低估信号（周期股命门）。
 */
export function viewEarningsQuality({ normNetProfit, ttmNetProfit }) {
  if (normNetProfit == null || ttmNetProfit == null) return V(NA, '归一化或当期盈利不可得');
  if (ttmNetProfit <= 0) return V(UNDER, '当期盈利为负，归一化后转正 —— 当期盈利严重失真', null);
  const ratio = normNetProfit / ttmNetProfit;
  const verdict = ratio > 1.25 ? UNDER : ratio < 0.8 ? OVER : FAIR;
  const note = ratio > 1.25 ? '当期盈利低于常态水平，当期 PE 虚高'
    : ratio < 0.8 ? '当期盈利高于常态水平，当期 PE 虚低（周期顶部特征）' : '当期盈利接近常态';
  return V(verdict, `归一化/当期 = ${ratio.toFixed(2)} —— ${note}`, ratio);
}

/**
 * 视角 4 · 资产回报匹配：实际 PB vs 由 ROE 推得的合理 PB。
 * 识别「低 PB 但 ROE 也崩了」的假便宜 —— 低 PB 若由低 ROE 解释，就不是低估。
 */
export function viewRoePb({ pb, roe, market = 'cn' }) {
  if (pb == null || roe == null) return V(NA, 'PB 或 ROE 不可得');
  const r = RISK_FREE[market] + 0.06;          // 要求回报率 ≈ 无风险 + 6% 股权风险溢价
  const fairPb = roe / 100 / r;                 // 永续零增长近似：合理 PB ≈ ROE / r
  if (!isFinite(fairPb) || fairPb <= 0) return V(NA, 'ROE 为负，PB 锚失效');
  const ratio = pb / fairPb;
  const verdict = ratio < 0.75 ? UNDER : ratio > 1.3 ? OVER : FAIR;
  return V(verdict, `PB ${pb.toFixed(2)} vs ROE ${roe.toFixed(1)}% 推得合理 PB ${fairPb.toFixed(2)}`, ratio);
}

/** 视角 5 · 现金回报：FCF 收益率 / 股息率 vs 无风险利率。绝对收益底线。 */
export function viewCashYield({ fcf, marketCap, dividendYield, market = 'cn' }) {
  const rf = RISK_FREE[market];
  const fcfYield = safeDiv(fcf, marketCap);
  const best = fcfYield ?? (dividendYield != null ? dividendYield / 100 : null);
  if (best == null) return V(NA, 'FCF 与股息率均不可得');
  const spread = best - rf;
  const verdict = spread > 0.03 ? UNDER : spread < 0 ? OVER : FAIR;
  const label = fcfYield != null ? 'FCF 收益率' : '股息率';
  return V(verdict, `${label} ${(best * 100).toFixed(1)}% vs 无风险 ${(rf * 100).toFixed(1)}%（利差 ${(spread * 100).toFixed(1)}pct）`, spread);
}

/**
 * 交叉校验（§2.2）。返回 { views, agreeUndervalued, allowUndervalued, conflict }。
 * allowUndervalued=false 时，档位不得给到「低估」及以上。
 */
/**
 * 视角与三档区间结论的方向一致度。
 * 这是置信度真正该衡量的量：五个独立视角是否**印证**了区间给出的档位。
 * 只数「几个视角投了低估」是错的——会出现「4 个视角说便宜、区间说贵、置信度却给高分」
 * 的荒谬结果（实测格力电器 4/5 视角低估、区间高估、置信度 95）。
 */
export function agreementWithBand(views, tierIndex) {
  if (tierIndex == null) return { ratio: null, agree: 0, valid: 0 };
  const bandVerdict = tierIndex <= 2 ? UNDER : tierIndex >= 4 ? OVER : FAIR;
  const valid = Object.values(views).filter((v) => v.verdict !== NA);
  const agree = valid.filter((v) => v.verdict === bandVerdict).length;
  return { ratio: valid.length ? agree / valid.length : null, agree, valid: valid.length, bandVerdict };
}

export function crossCheck(views) {
  const entries = Object.entries(views);
  const valid = entries.filter(([, v]) => v.verdict !== NA);
  const agree = valid.filter(([, v]) => v.verdict === UNDER).length;
  // 视角 3（盈利质量）与视角 1（自身历史）冲突时以视角 3 为准
  const conflict = views.selfHistory?.verdict !== NA && views.earningsQuality?.verdict !== NA
    && views.selfHistory.verdict !== views.earningsQuality.verdict
    ? `自身历史(${views.selfHistory.verdict}) 与 盈利质量(${views.earningsQuality.verdict}) 冲突，以盈利质量为准`
    : null;
  return {
    views,
    validCount: valid.length,
    agreeUndervalued: agree,
    allowUndervalued: agree >= SCREENING.views.minAgreeForUndervalued,
    conflict,
    override: conflict ? views.earningsQuality.verdict : null,
  };
}

export { UNDER, FAIR, OVER, NA };
