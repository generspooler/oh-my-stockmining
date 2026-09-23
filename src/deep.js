// 阶段 3 · 深度补数（SYSTEM_DEFINITION §3 新架构）。
// 仅对粗筛入围的 ≤47 只执行。此阶段仍**不做任何淘汰**，只把信息补厚。
import * as val from './valuation.js';
import * as tx from './sources/tencent.js';
import { normalizedEarnings, normalizedRoe, isCyclical, ttmRevenue } from './metrics/normalize.js';
import { multipleRoute, isFinancial } from './classify.js';
import * as em from './sources/em.js';
import { fetchNews, renderNews } from './news.js';
import { safeDiv, pool } from './util.js';
import { LIMITS } from './config.js';

/** 多区间回撤：细筛阶段已有月线，任意区间都能现算，无需额外请求。 */
export function drawdowns(monthly) {
  if (!monthly?.length) return {};
  const last = monthly[monthly.length - 1];
  const win = (n) => monthly.slice(Math.max(0, monthly.length - n));
  const dd = (n) => {
    const w = win(n);
    if (w.length < 2) return null;
    const hi = Math.max(...w.map((x) => x.close));
    return hi ? last.close / hi - 1 : null;
  };
  const ret = (n) => {
    const w = win(n + 1);
    return w.length >= 2 && w[0].close ? last.close / w[0].close - 1 : null;
  };
  return {
    dd13w: dd(3), dd26w: dd(6), dd52w: dd(12), dd3y: dd(36), dd5y: dd(60),
    ret13w: ret(3), ret26w: ret(6), ret52w: ret(12), ret3y: ret(36), ret5y: ret(60),
    monthsAvailable: monthly.length,
  };
}

/** 单只深度档案：估值三档 + 归一化 + 多区间回撤 + 新闻。 */
export async function profileOne(row, newsPack) {
  const market = row.market;
  const fin = isFinancial(row.industry, market);
  const [series, statements, monthly] = await Promise.all([
    val.multipleSeries(row).catch(() => ({ rows: [], source: '不可得' })),
    (market === 'cn' ? em.statementsCN(row.code) : em.statementsUS(row.code, em.usSuffix(row.mk))).catch(() => null),
    tx.monthly(row.code, market, row.mk).catch(() => []),
  ]);

  const shares = row.shares ?? series.shares ?? null;
  const norm = statements ? normalizedEarnings(statements, market, { shares, isFinancial: fin }) : { ok: false, reason: '报表不可得' };
  const cyc = statements ? isCyclical(statements, market) : { cyclical: false, ambiguous: false, reason: '报表不可得' };
  const route = multipleRoute({ industry: row.industry, market, cyclical: cyc.cyclical, normEps: norm.normEps });
  const revTtm = statements ? ttmRevenue(statements, market) : null;

  const perShareOf = (p) => p === 'pe' ? norm.normEps : p === 'pb' ? row.bps : p === 'ps' ? safeDiv(revTtm, shares) : null;
  const pcts = val.multiplePercentiles(series.rows, route.primary, series.freq);
  const band = val.bands({ route, perShare: perShareOf(route.primary), pcts, price: row.price });

  // 周期/成长界限模糊时两条口径都算，取舍交给模型
  let altRoute = null, altBand = null;
  if (cyc.ambiguous) {
    const alt = route.primary === 'pb' ? 'pe' : 'pb';
    altRoute = { primary: alt, reason: `备选口径：${alt.toUpperCase()} 分位（若判定为成长而非周期）` };
    altBand = val.bands({ route: altRoute, perShare: perShareOf(alt),
      pcts: val.multiplePercentiles(series.rows, alt, series.freq), price: row.price });
  }

  return {
    ...row,
    drawdowns: drawdowns(monthly),
    normalization: norm, cyclical: cyc, route, percentiles: pcts, band,
    altRoute, altBand, routeAmbiguous: !!cyc.ambiguous,
    seriesSource: series.source, seriesPoints: series.rows?.length || 0,
    news: newsPack || null,
  };
}

/** 批量深度补数。 */
export async function deepen(picks, { onProgress } = {}) {
  const rows = picks.map((p) => ({ ...p.row, coarseWhy: p.why, coarseGuess: p.guess, checkNext: p.checkNext }));
  const newsMap = await fetchNews(rows, { onProgress: (d, t) => onProgress?.(`新闻 ${d}/${t}`) });
  let done = 0;
  const out = await pool(rows, LIMITS.emConcurrency, async (r) => {
    const p = await profileOne(r, newsMap.get(r.code)).catch(() => null);
    onProgress?.(`深度补数 ${++done}/${rows.length}`);
    return p;
  });
  return out.filter(Boolean);
}

const f = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d));
const pc = (v, d = 0) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);

/** 渲染成总裁决的输入片段。 */
export function renderProfile(p, i) {
  const cur = p.market === 'cn' ? '¥' : '$';
  const L = [];
  const group = p.isWatch ? '自选' : '市场';
  L.push(`### ${i + 1}. ${p.name}（${p.code}）｜${p.industry}｜${p.market === 'cn' ? 'A股' : '美股'}｜${group}`);
  L.push(p.isWatch
    ? '粗筛理由：用户自选标的——跳过粗筛直接深看。粗筛不对其裁汰，但裁决标准与市场候选完全一致'
    : `粗筛理由：${p.coarseWhy || '—'}｜初步猜测：${p.coarseGuess || '—'}｜待验证：${p.checkNext || '—'}`);
  if (p.outOfPool) L.push('⚠ 该标的不在挖掘池内（池排除项），估值方法适配度有限');
  L.push(`现价 ${cur}${f(p.price)}　市值 ${p.marketCap ? (p.marketCap / 1e8).toFixed(0) + (p.market === 'cn' ? '亿' : '亿美元') : '—'}　PE ${f(p.pe, 1)}　PB ${f(p.pb)}`);

  const d = p.drawdowns || {};
  L.push(`回撤：13周 ${pc(d.dd13w)}　26周 ${pc(d.dd26w)}　52周 ${pc(d.dd52w)}　3年 ${pc(d.dd3y)}　5年 ${pc(d.dd5y)}`);
  L.push(`区间收益：52周 ${pc(d.ret52w)}　3年 ${pc(d.ret3y)}　5年 ${pc(d.ret5y)}`);

  L.push(`基本面：ROE ${f(p.roe, 1)}%（5年中位 ${f(p.roeMedian5, 1)}%）　毛利率 ${f(p.grossMargin, 1)}%　负债率 ${f(p.debtRatio, 1)}%　F-Score ${p.fScore ?? '—'}`);
  L.push(`　　　　营收CAGR ${pc(p.revenueCagr)}　累计FCF/净利 ${f(p.cumFcfToProfit)}　ROIC ${f(p.roic, 1)}%　利息保障 ${f(p.interestCoverage, 1)}x`);

  if (p.band?.ok) {
    L.push(`估值区间（${p.route.reason}）：保守 ${cur}${f(p.band.conservative, 0)}｜中性 ${cur}${f(p.band.neutral, 0)}｜乐观 ${cur}${f(p.band.optimistic, 0)}`);
    L.push(`　　P/V ${f(p.band.pv, 3)} → ${p.band.tier.name}　安全边际 ${pc(1 - p.band.pv)}　分位 P25/P50/P75 = ${f(p.percentiles.p25, 1)}/${f(p.percentiles.p50, 1)}/${f(p.percentiles.p75, 1)}（${f(p.percentiles.years, 1)}年）`);
  } else {
    L.push(`估值区间：不可得（${p.band?.reason || '—'}）`);
  }
  if (p.normalization?.ok) {
    L.push(`归一化：营业利润率 ${pc(p.normalization.normMargin, 1)}（7年中位）→ 归一化EPS ${f(p.normalization.normEps)}　当前实际EPS 约 ${f(safeDiv(p.netProfit, p.shares))}`);
  } else {
    L.push(`归一化：不可用（${p.normalization?.reason || '—'}）`);
  }
  if (p.routeAmbiguous && p.altBand?.ok) {
    L.push(`⚠ 估值口径存疑（${p.cyclical.reason}）：若按${p.altRoute.primary.toUpperCase()}口径 → 中性 ${cur}${f(p.altBand.neutral, 0)}，P/V ${f(p.altBand.pv, 3)}`);
  }
  L.push('新闻与公告：');
  L.push(renderNews(p.news));
  return L.join('\n');
}
