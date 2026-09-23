// 质量评分（SYSTEM_DEFINITION §3.2 第 2 层）。全部输入取自东财现成指标，此处只做合成。
//
// 分工：Piotroski F-Score 判「便宜是否伴随质量」，Altman Z'' 判破产风险，
// Beneish M-Score 判财务操纵。三者都是学术已验证的复合分，没有 API 直接提供，
// 但输入项（ROA/OCF/毛利率/负债率/流动比率/周转率）都是现成字段。
import { median, safeDiv } from '../util.js';

// v0.3 起这些不再是淘汰闸门，只用于**计算指标供模型参考**（见 SYSTEM_DEFINITION §1 设计取向）。
// 因此阈值内置于此，不再从 config 读取——config 里已无 layer2 段落。
// 保留 qualityGate* 是为了给模型一个「按传统价值投资标准，这只票哪里不达标」的摘要，
// 调用方不得据此淘汰标的。
const L2 = {
  fScoreMin: 6, zScoreMin: 1.8, interestCoverMin: 2.5,
  fcfToNetProfitMin: 0.6, ocfYears: 5,
  roicMin: 0.08, roicYearsMin: 3,
  goodwillToEquityMax: 0.30, dilutionMaxPerYear: 0.05,
  mScoreMax: -1.78, pledgeMax: 0.70,
  highQualityBypass: { roicMin: 0.15, roicYears: 5, fScoreMin: 5 },
};
const pctToRatio = (v) => (v == null ? null : v / 100);

/** 取某年的年报指标行。rows 为 mainIndicators 结果（最新在前）。 */
const annualsOf = (rows) => (rows || []).filter((r) => r.period?.endsWith('12-31'));

/**
 * Piotroski F-Score（9 分制）。
 * 盈利性 4 分 + 杠杆/流动性 3 分 + 经营效率 2 分。≥6 为及格线。
 * 缺失项不给分并计入 missing，missing 过多时返回 ok:false（覆盖率政策 §6.5）。
 */
export function fScore(rows) {
  const a = annualsOf(rows);
  if (a.length < 2) return { ok: false, reason: '年报不足 2 期，无法计算同比项' };
  const [t, p] = a;           // t=最新年, p=上一年
  const pts = [];
  const missing = [];
  const add = (name, cond) => {
    if (cond == null) { missing.push(name); pts.push({ name, score: 0, na: true }); }
    else pts.push({ name, score: cond ? 1 : 0 });
  };

  // 盈利性
  add('ROA>0', t.roa == null ? null : t.roa > 0);
  add('经营现金流>0', t.ocf == null ? (t.ocfPerShare == null ? null : t.ocfPerShare > 0) : t.ocf > 0);
  add('ROA同比改善', t.roa == null || p.roa == null ? null : t.roa > p.roa);
  // 应计质量：经营现金流 > 净利润
  const ocfT = t.ocf ?? (t.ocfPerShare != null && t.shares != null ? t.ocfPerShare * t.shares : null);
  add('现金流>净利润', ocfT == null || t.parentNetProfit == null ? null : ocfT > t.parentNetProfit);

  // 杠杆 / 流动性
  add('负债率下降', t.debtRatio == null || p.debtRatio == null ? null : t.debtRatio < p.debtRatio);
  add('流动比率上升', t.currentRatio == null || p.currentRatio == null ? null : t.currentRatio > p.currentRatio);
  // 未增发：股本未增加（回购导致减少视为通过）
  add('未增发股本', t.shares == null || p.shares == null ? null : t.shares <= p.shares * 1.001);

  // 经营效率
  add('毛利率上升', t.grossMargin == null || p.grossMargin == null ? null : t.grossMargin > p.grossMargin);
  add('资产周转上升', t.assetTurnover == null || p.assetTurnover == null ? null : t.assetTurnover > p.assetTurnover);

  const score = pts.reduce((s, x) => s + x.score, 0);
  return {
    ok: missing.length <= 3,
    score, max: 9, points: pts, missing,
    reason: missing.length > 3 ? `缺失 ${missing.length} 项：${missing.join('/')}` : null,
  };
}

/**
 * Altman Z''-Score（新兴市场 / 非制造业调整版）：
 *   Z'' = 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4
 * X1 营运资本/总资产, X2 留存收益/总资产, X3 EBIT/总资产, X4 股东权益/总负债。
 * 原版阈值 >2.6 安全 / <1.1 困境；本系统取 1.8 作为筛选线（灰区偏保守）。
 * 金融机构不适用（Altman 原文即排除金融业）。
 */
export function zScore(row, { retainedEarnings, ebit } = {}) {
  if (!row || row.totalAssets == null || row.totalAssets === 0) return { ok: false, reason: '总资产不可得' };
  const ta = row.totalAssets;
  // 营运资本：用流动比率与总资产反推不可靠，优先用显式流动资产/负债
  const wc = row.currentAssets != null && row.currentLiab != null ? row.currentAssets - row.currentLiab : null;
  const equity = row.equity;
  const totalLiab = equity != null ? ta - equity : null;

  const X1 = safeDiv(wc, ta);
  const X2 = safeDiv(retainedEarnings, ta);
  const X3 = safeDiv(ebit, ta);
  const X4 = safeDiv(equity, totalLiab);
  const parts = { X1, X2, X3, X4 };
  const missing = Object.entries(parts).filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length > 1) return { ok: false, reason: `缺 ${missing.join('/')}`, parts };
  const z = 6.56 * (X1 ?? 0) + 3.26 * (X2 ?? 0) + 6.72 * (X3 ?? 0) + 1.05 * (X4 ?? 0);
  return { ok: true, z, parts, missing };
}

/**
 * Beneish M-Score（8 变量）。> -1.78 提示财务操纵可能。
 * 数据不全时返回 ok:false —— 按覆盖率政策降权而非猜测填充。
 */
export function mScore(rows) {
  const a = annualsOf(rows);
  if (a.length < 2) return { ok: false, reason: '年报不足 2 期' };
  const [t, p] = a;
  const need = (x) => (x == null || !isFinite(x) ? null : x);

  // DSRI 应收账款指数
  const dsri = safeDiv(safeDiv(need(t.arDays), need(p.arDays)), 1);
  // GMI 毛利率指数（上年毛利率 / 本年毛利率）
  const gmi = safeDiv(need(p.grossMargin), need(t.grossMargin));
  // SGI 营收增长指数
  const sgi = t.revenueYoY == null ? null : 1 + t.revenueYoY / 100;
  // LVGI 杠杆指数
  const lvgi = safeDiv(need(t.debtRatio), need(p.debtRatio));
  // TATA 总应计/总资产
  const ocfT = t.ocf ?? (t.ocfPerShare != null && t.shares != null ? t.ocfPerShare * t.shares : null);
  const tata = t.parentNetProfit != null && ocfT != null && t.totalAssets
    ? (t.parentNetProfit - ocfT) / t.totalAssets : null;

  const vals = { dsri, gmi, sgi, lvgi, tata };
  const missing = Object.entries(vals).filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length > 1) return { ok: false, reason: `缺 ${missing.join('/')}`, vals };
  // 简化式：省略 AQI / DEPI / SGAI（东财无对应现成字段），系数按原式保留
  const m = -4.84 + 0.92 * (dsri ?? 1) + 0.528 * (gmi ?? 1) + 0.892 * (sgi ?? 1)
    - 0.327 * (lvgi ?? 1) + 4.679 * (tata ?? 0);
  return { ok: true, m, vals, missing, simplified: true };
}

/** 近 N 年 ROIC 达标年数。 */
export function roicYears(rows, minRoic = L2.roicMin, years = 5) {
  const a = annualsOf(rows).slice(0, years);
  const vals = a.map((r) => pctToRatio(r.roic)).filter((x) => x != null);
  if (!vals.length) return { ok: false, reason: 'ROIC 不可得' };
  return { ok: true, hit: vals.filter((v) => v >= minRoic).length, total: vals.length, values: vals };
}

/** 近 N 年累计 FCF / 累计净利润，以及经营现金流累计是否为正。 */
export function cashQuality(rows, years = L2.ocfYears) {
  const a = annualsOf(rows).slice(0, years);
  if (a.length < 3) return { ok: false, reason: '年报不足 3 期' };
  let sumOcf = 0, sumNp = 0, sumFcf = 0, nOcf = 0, nFcf = 0;
  for (const r of a) {
    const ocf = r.ocf ?? (r.ocfPerShare != null && r.shares != null ? r.ocfPerShare * r.shares : null);
    if (ocf != null) { sumOcf += ocf; nOcf++; }
    if (r.parentNetProfit != null) sumNp += r.parentNetProfit;
    if (r.fcff != null) { sumFcf += r.fcff; nFcf++; }
  }
  if (!nOcf) return { ok: false, reason: '经营现金流不可得' };
  // FCF 不可得时退回 OCF 口径，但门槛提高（OCF 恒大于 FCF，不提高会放松闸门）
  const useFcf = nFcf >= Math.max(2, a.length - 1);
  const ratio = safeDiv(useFcf ? sumFcf : sumOcf, sumNp);
  return {
    ok: true, sumOcf, sumNp, sumFcf: useFcf ? sumFcf : null, ratio, years: a.length,
    basis: useFcf ? 'FCF' : 'OCF',
    threshold: useFcf ? L2.fcfToNetProfitMin : 0.8,
    ocfPositive: sumOcf > 0,
  };
}

/** 近 3 年股本年化稀释率（负值=回购，视为通过）。 */
export function dilution(rows, years = 3) {
  const a = annualsOf(rows).slice(0, years + 1);
  if (a.length < 2) return { ok: false, reason: '年报不足 2 期' };
  const newest = a[0]?.shares, oldest = a[a.length - 1]?.shares;
  if (!newest || !oldest) return { ok: false, reason: '股本不可得' };
  const yrs = a.length - 1;
  return { ok: true, rate: (newest / oldest) ** (1 / yrs) - 1, years: yrs };
}

/**
 * 非金融质量闸门总判定。返回 { pass, fScore, failures[] }。
 * 任一硬门槛不过即 pass=false，failures 记录淘汰原因（供审计日志）。
 */
export function qualityGateGeneral(rows, extra = {}) {
  const f = fScore(rows);
  const z = zScore(annualsOf(rows)[0], extra);
  const m = mScore(rows);
  const rc = roicYears(rows);
  const cq = cashQuality(rows);
  const dl = dilution(rows);
  const t = annualsOf(rows)[0] || {};
  const failures = [];

  // 高质量旁路：ROIC 长期优异且现金流品质达标的公司，F-Score 放宽一分
  const bp = L2.highQualityBypass;
  const roicVals = rc.ok ? rc.values.slice(0, bp.roicYears) : [];
  const highQuality = roicVals.length >= 3 && roicVals.every((v) => v >= bp.roicMin) && cq.ok && cq.ocfPositive;
  const fMin = highQuality ? bp.fScoreMin : L2.fScoreMin;

  if (!f.ok) failures.push(`F-Score 不可得（${f.reason}）`);
  else if (f.score < fMin) failures.push(`F-Score ${f.score} < ${fMin}${highQuality ? '（已适用高质量旁路）' : ''}`);

  if (z.ok && z.z < L2.zScoreMin) failures.push(`Z''-Score ${z.z.toFixed(2)} < ${L2.zScoreMin}`);

  const netCash = extra.netCash === true;
  if (!netCash && t.interestCoverage != null && t.interestCoverage < L2.interestCoverMin)
    failures.push(`利息保障 ${t.interestCoverage.toFixed(1)}x < ${L2.interestCoverMin}x`);

  if (cq.ok) {
    if (!cq.ocfPositive) failures.push(`近 ${cq.years} 年经营现金流累计为负`);
    if (cq.ratio != null && cq.ratio < cq.threshold)
      failures.push(`${cq.basis}/净利润 ${cq.ratio.toFixed(2)} < ${cq.threshold}`);
  } else failures.push(`现金流品质不可得（${cq.reason}）`);

  if (rc.ok && rc.hit < L2.roicYearsMin) failures.push(`ROIC 达标 ${rc.hit}/${rc.total} 年 < ${L2.roicYearsMin}`);

  if (extra.goodwillRatio != null && extra.goodwillRatio > L2.goodwillToEquityMax)
    failures.push(`商誉/净资产 ${(extra.goodwillRatio * 100).toFixed(0)}% > ${L2.goodwillToEquityMax * 100}%`);

  if (dl.ok && dl.rate > L2.dilutionMaxPerYear)
    failures.push(`股本年化稀释 ${(dl.rate * 100).toFixed(1)}% > ${L2.dilutionMaxPerYear * 100}%`);

  if (m.ok && m.m > L2.mScoreMax) failures.push(`M-Score ${m.m.toFixed(2)} > ${L2.mScoreMax}（财务操纵嫌疑）`);

  if (extra.opinionAbnormal) failures.push('审计意见非标');
  if (extra.pledgeRatio != null && extra.pledgeRatio > L2.pledgeMax)
    failures.push(`大股东质押率 ${(extra.pledgeRatio * 100).toFixed(0)}% > ${L2.pledgeMax * 100}%`);

  return { pass: failures.length === 0, failures, highQuality, fThreshold: fMin,
    fScore: f, zScore: z, mScore: m, roic: rc, cash: cq, dilution: dl };
}

/**
 * 金融专用闸门（仅 A 股）。
 * F-Score 的杠杆/流动性分项与 Altman Z 对金融机构无意义（Altman 原文即排除金融业），
 * 券商 ROIC 实测为 null。改用监管指标。
 */
export function qualityGateFinancial(rows, orgType) {
  const a = annualsOf(rows);
  if (a.length < 3) return { pass: false, failures: ['年报不足 3 期'], kind: orgType };
  const t = a[0];
  const roeMed = median(a.slice(0, 5).map((r) => r.roe));
  const failures = [];

  if (roeMed == null) failures.push('ROE 不可得');
  else if (orgType === '证券' ? roeMed < 5 : roeMed < 8)
    failures.push(`近 5 年 ROE 中位数 ${roeMed.toFixed(1)}% < ${orgType === '证券' ? 5 : 8}%`);

  if (orgType === '银行') {
    if (t.bank?.npl != null && t.bank.npl > 2) failures.push(`不良率 ${t.bank.npl}% > 2%`);
    if (t.bank?.car != null && t.bank.car < 11.5) failures.push(`资本充足率 ${t.bank.car}% < 11.5%`);
    if (t.bank?.provision != null && t.bank.provision < 150) failures.push(`拨备覆盖率 ${t.bank.provision}% < 150%`);
    if (t.bank?.coreCar != null && t.bank.coreCar < 8) failures.push(`核心一级资本充足率 ${t.bank.coreCar}% < 8%`);
  }
  if (orgType === '保险' && t.insurer?.solvency != null && t.insurer.solvency < 150)
    failures.push(`综合偿付能力 ${t.insurer.solvency}% < 150%`);

  return { pass: failures.length === 0, failures, kind: orgType, roeMedian: roeMed, fScoreEquiv: failures.length === 0 ? 7 : 5 };
}
