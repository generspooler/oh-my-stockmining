// 功能一 · 单股低估判定（SYSTEM_DEFINITION §2）的机械部分。
// 产出供 llm 层与 report 层消费的结构化结果。所有数字在此算定，模型不得再算（铁律 3）。
import * as em from './sources/em.js';
import * as val from './valuation.js';
import * as views from './views.js';
import { normalizedEarnings, normalizedRoe, isCyclical, ttmRevenue } from './metrics/normalize.js';
import { qualityGateGeneral, qualityGateFinancial } from './metrics/scores.js';
import { isFinancial, multipleRoute } from './classify.js';
import { median, safeDiv } from './util.js';
import { SCREENING } from './config.js';

/** 按代码或名称解析标的。优先精确代码匹配，其次名称包含。 */
export async function resolve(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const all = await allStocks();
  const upper = q.toUpperCase();
  return all.find((x) => x.code.toUpperCase() === upper)
    || all.find((x) => x.name === q)
    || all.find((x) => x.name?.includes(q))
    || all.find((x) => x.code.toUpperCase().startsWith(upper))
    || null;
}

// ── 联想搜索（suggest）─────────────────────────────────────
// 模块级可变缓存：首次加载两个 universe JSON（合计 ~5.7MB）需 40-50ms，
// 之后逐键触发的 suggest 从内存读取即可（<1ms）。TTL 与 universe 缓存一致。
let _stockIndex = null;

async function allStocks() {
  if (_stockIndex) return _stockIndex;
  const [cn, us] = await Promise.all([em.universe('cn'), em.universe('us')]);
  _stockIndex = [...cn, ...us];
  return _stockIndex;
}

/** 触发索引预热，供服务器启动时调用。 */
export async function warmIndex() {
  const t0 = Date.now();
  await allStocks();
  console.log(`[suggest] 索引预热完成：${_stockIndex.length} 只标的，${Date.now() - t0}ms`);
}

/** 代码归一化：BRK.B / BRK-B → BRK_B，小写 → 大写。 */
function normalizeCode(q) {
  return q.replace(/[\.\-\/]/g, '_').toUpperCase();
}

/** 纯 ASCII 字母检测（用于拼音补位判断）。 */
const IS_PURE_ASCII = /^[a-zA-Z]+$/;

/**
 * 联想候选。返回排序后的 [{code, name, market, industry, marketCap, isFund}]。
 * 本地宇宙为主；仅当本地零命中且输入是纯字母时，代理东财 suggest 拿拼音结果，与本地取交集。
 * isFund = 无行业 + 无市值 → 前端展示「ETF·无基本面数据」标签。
 */
export async function suggest(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return [];

  const all = await allStocks();
  const upper = q.toUpperCase();
  const normalQ = normalizeCode(q);

  // ── 第一轮：本地宇宙打分 ──────────────────────────────
  const scored = all.map((r) => {
    const code = (r.code || '').toUpperCase();
    const name = r.name || '';
    let s = null;

    if (code === upper || code === normalQ) s = 1000;
    else if (name === q) s = 900;
    else if (code.startsWith(normalQ)) s = 700;
    else if (name.startsWith(q)) s = 600;
    else if (code.includes(normalQ)) s = 400;
    else if (name.includes(q)) s = 300; // 中文名包含

    // 完全不匹配
    if (s === null) return null;

    // 经营主体优先：ETF/杠杆品无行业、无市值，实测为可靠信号
    const isFund = !r.industry && !(r.marketCap > 0);
    if (isFund) s -= 250;

    // 大盘股微调：log10(marketCap)×6，上限 60
    if (r.marketCap > 0) s += Math.min(Math.log10(r.marketCap) * 6, 60);

    return { ...r, score: s, isFund };
  });

  let hits = scored
    .filter((r) => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // ── 第二轮：拼音 / 英文名补位（仅纯字母输入且无精确代码匹配）──
  const hasExactCode = hits.some((r) => r.score >= 700);
  if (!hasExactCode && IS_PURE_ASCII.test(q)) {
    try {
      const { cached, fetchJson } = await import('./util.js');
      const data = await cached(`suggest:${q}`, 6 * 3600e3, () =>
        fetchJson(
          `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=12`,
          { headers: { Referer: 'https://www.eastmoney.com/' } },
        ).catch(() => null));
      const rows = data?.QuotationCodeTable?.Data || [];
      // 用 code 去本地宇宙取交集，查不到的直接丢弃（港股/指数/板块不出现在下拉）
      const localMap = new Map(all.map((r) => [r.code.toUpperCase(), r]));
      const emHits = rows
        .filter((r) => ['AStock', 'UsStock', 'HKStock'].includes(r.Classify))
        .map((r) => localMap.get(r.Code.toUpperCase()))
        .filter(Boolean)
        .map((r) => ({ ...r, score: 500, isFund: !r.industry && !(r.marketCap > 0) }));
      // 合并：本地结果优先，EM 结果按 code 去重后追加
      const seen = new Set(hits.map((r) => r.code));
      for (const r of emHits) { if (!seen.has(r.code)) { hits.push(r); seen.add(r.code); } }
      hits = hits.slice(0, limit);
    } catch {}
  }

  // 返回精简字段，避免传输全量
  return hits.map(({ code, name, market, industry, marketCap, isFund }) => ({
    code, name, market, industry, marketCap: marketCap || 0, isFund: !!isFund,
  }));
}

/** 关键字段覆盖率（§6.5）。 */
function coverageOf(fields) {
  const keys = Object.keys(fields);
  const have = keys.filter((k) => fields[k] != null && fields[k] !== '');
  return { ratio: keys.length ? have.length / keys.length : 0, missing: keys.filter((k) => !have.includes(k)) };
}

/**
 * 单股机械判定。
 * 返回的 numbers 字段即注入模型提示词的数字白名单来源。
 */
export async function analyzeOne(stock) {
  const market = stock.market;
  const fin = isFinancial(stock.industry, market);
  const orgTypeGuess = /银行/.test(stock.industry || '') ? '银行'
    : /证券/.test(stock.industry || '') ? '证券' : /保险/.test(stock.industry || '') ? '保险' : null;

  // ── 数据 ────────────────────────────────────────────────
  const [series, indicators, statements] = await Promise.all([
    val.multipleSeries(stock),
    market === 'cn' ? em.mainIndicators(stock.code) : Promise.resolve([]),
    market === 'cn' ? em.statementsCN(stock.code) : em.statementsUS(stock.code, em.usSuffix(stock.mk)),
  ]);
  const latestSeries = series.rows?.[0] || {};
  const price = latestSeries.close ?? null;
  const annuals = (indicators || []).filter((r) => r.period?.endsWith('12-31'));
  const latestInd = annuals[0] || {};
  // 美股 mainIndicators 不适用，股数取自反算序列（年报摊薄股数）或报表本身
  const shares = latestSeries.shares ?? latestInd.shares ?? series.shares
    ?? statements?.annual?.[0]?.sharesDiluted ?? statements?.annual?.[0]?.sharesBasic ?? null;

  // ── 归一化与路由 ────────────────────────────────────────
  const cyc = isCyclical(market === 'cn' ? statements : statements, market);
  const norm = normalizedEarnings(statements, market, { shares, isFinancial: fin });
  const nroe = fin ? normalizedRoe(statements, market) : { ok: false };
  const route = multipleRoute({ industry: stock.industry, market, cyclical: cyc.cyclical, normEps: norm.normEps });

  // 每股口径：PE 路由用归一化 EPS；PB 路由用每股净资产；PS 路由用每股营收
  const bps = latestInd.bps ?? safeDiv(statements?.annual?.[0]?.equity ?? null, shares);
  const revTtm = ttmRevenue(statements, market);
  const perShare = route.primary === 'pe' ? norm.normEps
    : route.primary === 'pb' ? bps
    : route.primary === 'ps' ? safeDiv(revTtm, shares)
    : null;

  // ── 分位与三档 ──────────────────────────────────────────
  const perShareOf = (primary) => primary === 'pe' ? norm.normEps
    : primary === 'pb' ? bps
    : primary === 'ps' ? safeDiv(revTtm, shares) : null;

  const pcts = val.multiplePercentiles(series.rows, route.primary, series.freq);
  const band = val.bands({ route, perShare, pcts, price });

  // 周期 / 高增长界限模糊时，机械层不裁决：把另一条口径也算出来，由模型在归因 pass 里选。
  let altRoute = null, altBand = null, altPcts = null;
  if (cyc.ambiguous) {
    const altPrimary = route.primary === 'pb' ? 'pe' : 'pb';
    altRoute = { primary: altPrimary, check: route.primary, reason: `备选口径：${altPrimary.toUpperCase()} 分位（若判定为成长而非周期）` };
    altPcts = val.multiplePercentiles(series.rows, altPrimary, series.freq);
    altBand = val.bands({ route: altRoute, perShare: perShareOf(altPrimary), pcts: altPcts, price });
  }

  // ── 质量闸门 ────────────────────────────────────────────
  const goodwillRatio = safeDiv(statements?.[0]?.goodwill ?? null, statements?.[0]?.equity ?? null);
  const gate = market === 'cn'
    ? (fin && orgTypeGuess ? qualityGateFinancial(indicators, orgTypeGuess)
      : qualityGateGeneral(indicators, { goodwillRatio }))
    : { pass: null, failures: [], note: '美股质量闸门在漏斗层用 SEC 现金流补齐，单股判定仅作参考' };
  const fScore = gate.fScore?.score ?? gate.fScoreEquiv ?? null;

  // ── 五视角 ──────────────────────────────────────────────
  const peers = await peerGroup(stock);
  const ttmNetProfit = market === 'cn'
    ? ttmFromCumulative(indicators)
    : (statements.quarterly || []).slice(0, 4).reduce((s, r) => s + (r.parentNetProfit ?? r.netProfit ?? 0), 0) || null;
  const vw = {
    selfHistory: views.viewSelfHistory({ series: series.rows, field: route.primary, current: latestSeries[route.primary] ?? stock[route.primary] }),
    peers: views.viewPeers({ current: stock[route.primary] ?? latestSeries[route.primary], peers, field: route.primary }),
    earningsQuality: views.viewEarningsQuality({ normNetProfit: norm.normNetProfit, ttmNetProfit }),
    roePb: views.viewRoePb({ pb: stock.pb ?? latestSeries.pb, roe: latestInd.roe, market }),
    // dividendYield 来自 em.universe 的 clist f133（百分数原值），viewCashYield 内部会 ÷100。
    // 此前一直没传，导致 FCF 取不到时该视角直接判「不可得」——白白丢掉一条独立信息。
    cashYield: views.viewCashYield({ fcf: latestInd.fcff, marketCap: stock.marketCap, dividendYield: stock.dividendYield, market }),
  };
  const cross = views.crossCheck(vw);

  // ── 档位裁决：≥3 视角同向才允许「低估」及以上（§2.2）────
  let tier = band.ok ? band.tier : { index: null, name: '不可判定' };
  const tierCapped = band.ok && tier.index <= 1 && !cross.allowUndervalued;
  if (tierCapped) tier = { index: 2, name: '合理偏低', capped: true };

  // ── 置信度 ──────────────────────────────────────────────
  const cov = coverageOf({
    revenue: latestInd.revenue ?? statements?.[0]?.revenue, operateProfit: latestInd.operateProfit,
    netProfit: latestInd.parentNetProfit, ocf: latestInd.ocf ?? latestInd.ocfPerShare,
    totalAssets: latestInd.totalAssets, equity: latestInd.equity ?? bps,
    shares, price, industry: stock.industry,
  });
  const penalties = [];
  if (pcts.ok && pcts.insufficient) penalties.push('估值序列不足 3 年');
  if (!norm.ok && !fin) penalties.push(`归一化不可用：${norm.reason}`);
  if (norm.flags?.length) penalties.push(...norm.flags);
  if (series.reversed) penalties.push('美股估值序列为反算值');
  if (cov.ratio < SCREENING.coverage.minNonCritical) penalties.push(`关键字段覆盖率 ${(cov.ratio * 100).toFixed(0)}%`);
  const bandAgree = views.agreementWithBand(vw, band.ok ? band.tier.index : null);
  // 视角与区间严重背离（一致度 < 40%）本身就是「结论不可靠」的信号
  if (bandAgree.ratio != null && bandAgree.ratio < 0.4) {
    penalties.push(`视角与估值区间背离（仅 ${bandAgree.agree}/${bandAgree.valid} 个视角印证区间结论）`);
  }
  if (cross.conflict) penalties.push(cross.conflict);
  const conf = val.confidence({
    seriesYears: pcts.ok ? pcts.years : 0, coverage: cov.ratio,
    viewAgreement: bandAgree.ratio, dispersion: band.dispersion, penalties,
  });

  const requiredMos = val.requiredMos(fScore);
  const mos = val.actualMos(band.pv);
  const altMos = altBand?.ok ? val.actualMos(altBand.pv) : null;

  return {
    stock, price, market, isFinancial: fin, orgType: orgTypeGuess,
    cyclical: cyc, route, normalization: norm, normalizedRoe: nroe,
    series: { source: series.source, points: series.rows?.length || 0, reversed: !!series.reversed },
    seriesRows: series.rows,   // 供背离分复用，避免再拉一次价格
    percentiles: pcts, band, tier, tierCapped,
    routeAmbiguous: !!cyc.ambiguous, altRoute, altBand, altPercentiles: altPcts,
    quality: gate, fScore,
    views: vw, cross, bandAgreement: bandAgree,
    confidence: conf, coverage: cov,
    // 口径存疑时任一口径达标即放行，真正的取舍交给模型（不在机械层替它做商业判断）
    mos: {
      required: requiredMos, actual: mos, alt: altMos,
      pass: (mos != null && mos >= requiredMos) || (altMos != null && altMos >= requiredMos),
      passedBy: mos != null && mos >= requiredMos ? route.primary : altMos != null && altMos >= requiredMos ? altRoute?.primary : null,
    },
    // 注入模型的数字白名单（铁律 3）：模型输出的任何数字都必须来自这里
    numbers: buildNumbers({ stock, price, band, pcts, norm, latestInd, conf, mos, requiredMos, fScore, ttmNetProfit, revTtm }),
  };
}

/** A股累计口径折算 TTM 归母净利。 */
function ttmFromCumulative(indicators) {
  const rows = (indicators || []).filter((r) => r.parentNetProfit != null);
  const latest = rows[0];
  if (!latest) return null;
  if (latest.period.endsWith('12-31')) return latest.parentNetProfit;
  const y = Number(latest.period.slice(0, 4)), mmdd = latest.period.slice(5);
  const lastFY = rows.find((r) => r.period === `${y - 1}-12-31`);
  const lastSame = rows.find((r) => r.period === `${y - 1}-${mmdd}`);
  if (!lastFY || !lastSame) return null;
  return latest.parentNetProfit + lastFY.parentNetProfit - lastSame.parentNetProfit;
}

/** 同业样本：同一行业、同一市场，按市值取最接近的若干只。 */
async function peerGroup(stock, size = 30) {
  const u = await em.universe(stock.market);
  const same = u.filter((x) => x.industry === stock.industry && x.code !== stock.code && x.pe != null);
  return same
    .sort((a, b) => Math.abs(Math.log((a.marketCap || 1) / (stock.marketCap || 1))) - Math.abs(Math.log((b.marketCap || 1) / (stock.marketCap || 1))))
    .slice(0, size);
}

/** 数字白名单：扁平的「名称 → 数值」表，供提示词注入与输出校验。 */
function buildNumbers({ stock, price, band, pcts, norm, latestInd, conf, mos, requiredMos, fScore, ttmNetProfit, revTtm }) {
  const n = {};
  const put = (k, v) => { if (v != null && isFinite(v)) n[k] = Number(Number(v).toPrecision(6)); };
  put('现价', price); put('总市值', stock.marketCap); put('当前PE', stock.pe); put('当前PB', stock.pb);
  if (band.ok) {
    put('保守值', band.conservative); put('中性值', band.neutral); put('乐观值', band.optimistic);
    put('PV比值', band.pv); put('相对保守档偏离', band.vsConservative); put('区间离散度', band.dispersion);
  }
  if (pcts.ok) { put('分位P25', pcts.p25); put('分位P50', pcts.p50); put('分位P75', pcts.p75); put('序列年数', pcts.years); }
  if (norm.ok) {
    put('归一化营业利润率', norm.normMargin); put('归一化EPS', norm.normEps);
    put('归一化净利润', norm.normNetProfit); put('TTM营收', norm.revTtm); put('实际税率', norm.effTax);
  }
  put('TTM归母净利', ttmNetProfit); put('营业收入TTM', revTtm);
  put('ROE', latestInd.roe); put('ROIC', latestInd.roic); put('毛利率', latestInd.grossMargin);
  put('资产负债率', latestInd.debtRatio); put('利息保障倍数', latestInd.interestCoverage);
  put('每股净资产', latestInd.bps); put('自由现金流', latestInd.fcff);
  put('F分数', fScore); put('要求安全边际', requiredMos); put('实际安全边际', mos);
  put('置信度分数', conf.score);
  return n;
}
