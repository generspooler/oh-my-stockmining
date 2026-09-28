// 阶段 1 · 全市场信息收集（SYSTEM_DEFINITION §3 新架构）。
//
// 唯一职责是**尽可能全地收集信息**，不做任何质量判断、不做任何淘汰。
// 只保留「池子范围」这种事实性限定（ST/退市/流动性/上市未满一年/美股剔除金融地产）。
//
// 硬性约束：本阶段**零逐股请求**。所有字段都来自批量接口：
//   A股  clist 分页 + 腾讯批量行情 + MAINFINADATA 按报告期整市场查
//   美股 clist 分页 + 腾讯批量行情 + SEC frames（每次返回某概念某年的全市场值）
import * as em from './sources/em.js';
import * as sec from './sources/sec.js';
import * as tx from './sources/tencent.js';
import { fScore } from './metrics/scores.js';
import { US_EXCLUDED_SECTORS, sectorBucket } from './classify.js';
import { median, safeDiv, daysBetween, pool as runPool } from './util.js';
import { SCREENING, LIMITS } from './config.js';

const pctOf = (v) => (v == null ? null : v / 100);
const cagr = (newest, oldest, years) =>
  newest == null || oldest == null || oldest <= 0 || years <= 0 ? null : (newest / oldest) ** (1 / years) - 1;

/** 池子范围：事实性限定，不是质量判断。 */
export function inPool(s, market) {
  const cfg = SCREENING.pool[market];
  if (!s.marketCap || s.marketCap <= 0) return false;
  if (market === 'cn') {
    if (cfg.excludeST && em.isRiskName(s.name)) return false;
  } else {
    if (US_EXCLUDED_SECTORS.includes(s.industry)) return false;
    if (s.marketCap < cfg.minMarketCap) return false;
  }
  if (s.turnover != null && s.turnover < cfg.minTurnover60d) return false;
  if (s.listDate) {
    const d = `${s.listDate.slice(0, 4)}-${s.listDate.slice(4, 6)}-${s.listDate.slice(6, 8)}`;
    if (daysBetween(d, new Date()) < cfg.minListedDays) return false;
  }
  return true;
}

/** 由年报序列（最新在前）算出多年聚合指标。两市场共用。 */
function aggregates(annuals) {
  if (!annuals?.length) return {};
  const n = annuals.length;
  const t = annuals[0];
  const oldest = annuals[n - 1];
  const f = fScore(annuals);
  const roes = annuals.map((r) => r.roe).filter((x) => x != null);
  const margins = annuals.map((r) => r.grossMargin).filter((x) => x != null);
  let sumFcf = 0, sumNp = 0, nFcf = 0;
  for (const r of annuals) {
    if (r.fcff != null) { sumFcf += r.fcff; nFcf++; }
    if (r.parentNetProfit != null) sumNp += r.parentNetProfit;
  }
  return {
    years: n,
    fScore: f.ok ? f.score : null,
    fScoreMissing: f.ok ? f.missing.length : null,
    roeMedian5: median(roes),
    roeTrend: roes.length >= 3 ? (roes[0] ?? 0) - (roes[roes.length - 1] ?? 0) : null,
    grossMarginTrend: margins.length >= 3 ? (margins[0] ?? 0) - (margins[margins.length - 1] ?? 0) : null,
    revenueCagr: cagr(t.revenue, oldest.revenue, n - 1),
    profitCagr: cagr(t.parentNetProfit, oldest.parentNetProfit, n - 1),
    cumFcfToProfit: nFcf >= 2 && sumNp > 0 ? sumFcf / sumNp : null,
  };
}

/**
 * A股：MAINFINADATA 按报告期整市场查，6 期拼成每只的年报序列。
 *
 * perStock：自选池挖掘的路径。池子只有十来只时，为它们拉 6 次整市场分页
 * （每次约 28 页）纯属浪费——改成逐股查（每只 1 次请求，缓存 7 天），
 * 自选池挖掘的耗时因此与全市场脱钩。两条路共用 mapMain，行结构完全一致。
 *
 * 两个分支的进度**粒度不同**（逐股是「数据源 × 只数」，整市场是按期的固定几次），
 * 但 unit 都给 'collect'——摘要里的「源 N」在两个分支下都读得通，
 * 细粒度的那份留在 label 上（见 progress.js 关于「单元标识与显示文本分开」的说明）。
 */
async function collectCN(pool, onProgress, { perStock = false } = {}) {
  const periods = em.recentAnnualPeriods(6);
  const byCode = new Map();
  if (perStock) {
    let done = 0;
    await runPool(pool, LIMITS.emConcurrency, async (s) => {
      const rows = await em.mainIndicators(s.code).catch(() => []);
      // 逐股接口返回季报+年报混排，这里只取年报期，与整市场路径口径一致
      byCode.set(s.code, rows.filter((r) => String(r.period || '').endsWith('-12-31')).slice(0, periods.length));
      done += 1;
      onProgress?.(`财务指标 ${done}/${pool.length} 只`, { unit: 'collect', key: `main:${s.code}` });
    });
  } else {
    for (let i = 0; i < periods.length; i++) {
      const rows = await em.marketIndicators(periods[i]);
      for (const r of rows) {
        if (!byCode.has(r.code)) byCode.set(r.code, []);
        byCode.get(r.code).push(r);
      }
      onProgress?.(`财务指标 报告期 ${periods[i]}（${i + 1}/${periods.length}）`, { unit: 'collect', key: `main:${periods[i]}` });
    }
  }
  return pool.map((s) => {
    const annuals = (byCode.get(s.code) || []).sort((a, b) => (a.period < b.period ? 1 : -1));
    const t = annuals[0] || {};
    return {
      ...s,
      roe: t.roe, roic: t.roic, grossMargin: t.grossMargin, netMargin: t.netMargin,
      debtRatio: t.debtRatio, interestCoverage: t.interestCoverage,
      revenueYoY: t.revenueYoY, profitYoY: t.profitYoY,
      revenue: t.revenue, netProfit: t.parentNetProfit, ocf: t.ocf, fcf: t.fcff,
      bps: t.bps, shares: t.shares, arDays: t.arDays,
      orgType: t.orgType, latestPeriod: t.period, noticeDate: t.noticeDate,
      bank: t.bank, insurer: t.insurer,
      ...aggregates(annuals),
    };
  });
}

/** 美股：SEC frames 批量取基本面（请求数只与概念×年数有关，与股票数无关）。 */
async function collectUS(pool, onProgress) {
  const years = em.recentAnnualPeriods(6).map((p) => Number(p.slice(0, 4)));
  // 计数按**请求**记，不按 (年, 概念) 坐标：bulkFundamentals 的 done 就是请求序号，
  // 6 年 × 13 概念 = 78 次，逐个都是独立请求，因此 d 本身就是合适的单元标识。
  // 实测一轮美股 `源 82`（78 次 SEC frames + 全市场列表 + 批量行情 + 基本面 + 起跑）。
  const fund = await sec.bulkFundamentals(pool.map((s) => s.code), years, {
    onProgress: (d, tot) => onProgress?.(`SEC frames ${d}/${tot}`, { unit: 'collect', key: `sec:${d}` }),
  });
  return pool.map((s) => {
    const byYear = fund.get(s.code);
    // 转成与 A 股同构的年报序列，供 fScore() 等共用逻辑消费
    const annuals = !byYear ? [] : Object.keys(byYear).sort().reverse().map((y) => {
      const r = byYear[y];
      const liab = r.liabilities ?? (r.assets != null && r.equity != null ? r.assets - r.equity : null);
      return {
        period: `${y}-12-31`,
        revenue: r.revenue, parentNetProfit: r.netIncome,
        totalAssets: r.assets, equity: r.equity,
        currentAssets: r.currentAssets, currentLiab: r.currentLiab,
        ocf: r.ocf,
        fcff: r.ocf != null && r.capex != null ? r.ocf - r.capex : null,
        roe: r.netIncome != null && r.equity ? (r.netIncome / r.equity) * 100 : null,
        roa: r.netIncome != null && r.assets ? (r.netIncome / r.assets) * 100 : null,
        grossMargin: r.grossProfit != null && r.revenue ? (r.grossProfit / r.revenue) * 100 : null,
        netMargin: r.netIncome != null && r.revenue ? (r.netIncome / r.revenue) * 100 : null,
        debtRatio: liab != null && r.assets ? (liab / r.assets) * 100 : null,
        currentRatio: safeDiv(r.currentAssets, r.currentLiab),
        assetTurnover: safeDiv(r.revenue, r.assets),
        shares: r.shares ?? null,
        inventory: r.inventory, ar: r.receivables,
      };
    });
    const t = annuals[0] || {};
    const agg = aggregates(annuals);
    const prev = annuals[1] || {};
    return {
      ...s,
      roe: t.roe ?? s.roe,        // clist f37 作兜底
      roic: null,                  // 美股无现成 ROIC，留空胜过编造
      grossMargin: t.grossMargin, netMargin: t.netMargin,
      debtRatio: t.debtRatio, interestCoverage: null,
      revenueYoY: prev.revenue && t.revenue ? ((t.revenue / prev.revenue - 1) * 100) : null,
      profitYoY: prev.parentNetProfit && t.parentNetProfit ? ((t.parentNetProfit / prev.parentNetProfit - 1) * 100) : null,
      revenue: t.revenue, netProfit: t.parentNetProfit, ocf: t.ocf, fcf: t.fcff,
      bps: t.equity && s.shares ? t.equity / s.shares : null,
      latestPeriod: t.period,
      ...agg,
    };
  });
}

/**
 * 全市场收集。返回 { rows, meta }。
 * rows 每行含：行情与跌幅、当期基本面、多年聚合（F-Score/ROE中位/CAGR/累计FCF）。
 *
 * onlyCodes：**自选池挖掘**专用（§3.3）。给定时池子就是点名的这几只，
 * 不跑 inPool 闸门——用户点名要看的票不因 ST/流动性/行业排除而消失；
 * 落在排除项内的打 outOfPool，渲染与提示词都要显著标注口径适配有限（§2.1）。
 * 不给时是市场挖掘：池子 = inPool 全市场，**不注入任何自选票**
 * （v0.6 两条流水线彻底分开，自选票只作为普通市场票参与粗筛竞争）。
 *
 * onProgress(text, detail)：detail 供活动台账记账（§5.1）。
 * unit 是计数类别，key 是单元标识——**两者都必须给**，台账靠 key 去重才不会
 * 把并行刷新的同一批请求重复计数。省略 detail 的老调用点行为不变（只是不计入台账）。
 */
export async function collect(market, { onProgress, onlyCodes = null } = {}) {
  const t0 = Date.now();
  const only = onlyCodes ? new Set(onlyCodes.map((c) => String(c).toUpperCase())) : null;
  const isOnly = (s) => !!only?.has(String(s.code || '').toUpperCase());
  onProgress?.('拉取全市场列表', { unit: 'collect', key: 'universe' });
  const universe = await em.universe(market);
  const pool = only ? universe.filter(isOnly) : universe.filter((s) => inPool(s, market));

  onProgress?.(`批量行情与 52 周高低（${pool.length} 只）`, { unit: 'collect', key: 'quotes' });
  const quotes = await tx.batchQuotes(pool.map((s) => s.code), market);

  onProgress?.(only ? '财务指标（逐股）' : market === 'cn' ? '财务指标（整市场按期）' : 'SEC frames 批量基本面',
    { unit: 'collect', key: 'fundamentals' });
  const base = pool.map((s) => {
    const q = quotes.get(s.code) || {};
    return {
      code: s.code, name: s.name, market, mk: s.mk, secid: s.secid,
      industry: s.industry, sector: sectorBucket(s.industry, market),
      marketCap: s.marketCap, turnover: s.turnover,
      price: q.price ?? null, pe: s.pe, pb: s.pb,
      chgToday: s.chgToday, chg60d: s.chg60d, chgYtd: s.chgYtd,
      week52High: q.week52High ?? null, week52Low: q.week52Low ?? null,
      drawdown52: q.drawdown52 ?? null, offLow52: q.offLow52 ?? null,
      roe: s.roe ?? null,
      dividendYield: s.dividendYield ?? null,   // 百分数原值；A股据此分流出「中高股息」批
      // undefined 键在 JSON 序列化时自然消失：市场候选不带这两个字段，快照保持干净
      isWatch: only ? true : undefined,
      // 自选票若不满足池子限定（ST/流动性/美股金融等），渲染时须显著标注口径适配有限（§2.1）
      outOfPool: (only && !inPool(s, market)) || undefined,
    };
  });

  const rows = market === 'cn'
    ? await collectCN(base, onProgress, { perStock: !!only })
    : await collectUS(base, onProgress);
  // 字段可得性说明：随数据一起交给模型，让它知道空值是「数据源没有」
  // 而不是「公司没披露」——两者含义完全不同，会影响判断。
  const caveats = market === 'us' ? [
    'ROIC 与利息保障倍数：美股无现成指标源（东财 MAINFINADATA 是 A 股专有），整列为空，不代表公司资本回报差',
    '毛利率覆盖约 44%：UNH、PFE 等公司不单独披露 GrossProfit 标签，为空不代表毛利率低',
    '部分公司 SEC XBRL 标签缺失导致基本面为空（覆盖约 86%），为空只说明取不到',
    '股息率为 TTM 静态口径，分母是当前股价：股价大跌会让股息率被动抬高，高股息率本身不构成买入理由',
  ] : [
    '累计 FCF/净利润覆盖约 77%：部分公司 FCFF 字段缺失',
    '股息率为 TTM 静态口径，分母是当前股价：股价大跌会让股息率被动抬高，高股息率本身不构成买入理由',
  ];
  return {
    rows,
    meta: {
      market, universe: universe.length, pool: pool.length, scope: only ? 'watch' : 'market',
      // 自选池挖掘：codes 是在 universe 里找到并已收集的自选代码（未找到的由调用方报出）
      watch: only ? { requested: only.size, codes: pool.map((s) => s.code) } : undefined,
      quoted: quotes.size, elapsedMs: Date.now() - t0,
      collectedAt: new Date().toISOString(),
      caveats,
      fieldCoverage: Object.fromEntries(
        ['price', 'drawdown52', 'pe', 'pb', 'roe', 'roic', 'grossMargin', 'debtRatio',
         'interestCoverage', 'fScore', 'roeMedian5', 'revenueCagr', 'cumFcfToProfit', 'dividendYield']
          .map((f) => [f, Number((rows.filter((r) => r[f] != null).length / (rows.length || 1)).toFixed(2))]),
      ),
    },
  };
}
