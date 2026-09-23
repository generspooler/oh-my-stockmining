// SEC EDGAR：补东财缺失的美股现金流。
// 东财 RPT_USF10_FN_CASHFLOW 实测为空，OCF / 资本开支只能从这里取。
//
// 关键手法：frames API 一次返回「某概念 + 某年」的全市场数据（CY2024 的 OCF 有 6182 家），
// 全市场筛选只需几次请求，而不是每家公司一次。个股精查再用 companyconcept。
import { fetchJson, cached, SEC_UA } from '../util.js';
import { CACHE_TTL } from '../config.js';

const H = { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' };

// 同一语义可能挂在不同 XBRL 标签下，按序回退。
// 美股没有东财 MAINFINADATA 那样的现成指标表，全部基本面都要从这里批量取。
const TAGS = {
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  assets: ['Assets'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  liabilities: ['Liabilities'],
  currentAssets: ['AssetsCurrent'],
  currentLiab: ['LiabilitiesCurrent'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  inventory: ['InventoryNet'],
  receivables: ['AccountsReceivableNetCurrent', 'AccountsReceivableNet'],
};

/** 批量基本面需要的概念清单。13 概念 × 6 年 ≈ 78 次 frames 调用覆盖全美股，缓存 30 天。 */
export const BULK_CONCEPTS = ['revenue', 'netIncome', 'assets', 'equity', 'liabilities',
  'currentAssets', 'currentLiab', 'grossProfit', 'operatingIncome', 'inventory', 'receivables', 'ocf', 'capex'];

// 资产负债表科目是**时点**数据，frames 的周期格式为 CY2025Q4I（I=instantaneous）；
// 利润表与现金流是**区间**数据，用 CY2025。混用会全部取空——
// 实测直接用 CY2025 查 Assets/StockholdersEquity 返回 0 家公司。
const INSTANT = new Set(['assets', 'equity', 'liabilities', 'currentAssets', 'currentLiab', 'inventory', 'receivables']);
const periodOf = (concept, year) => (INSTANT.has(concept) ? `CY${year}Q4I` : `CY${year}`);

/** ticker → CIK 映射（SEC 官方表，约 1 万条）。 */
export async function cikMap() {
  return cached('sec:cikmap', 7 * 24 * 3600e3, async () => {
    const t = await fetchJson('https://www.sec.gov/files/company_tickers.json', { headers: H });
    const m = {};
    for (const v of Object.values(t || {})) {
      if (v?.ticker) m[String(v.ticker).toUpperCase()] = String(v.cik_str).padStart(10, '0');
    }
    return m;
  });
}

/**
 * frames：某概念某年的全市场值，返回 Map(cik -> {val, end, accn})。
 * period 形如 'CY2024'。单个标签取不到就回退到下一个。
 */
export async function frame(concept, period) {
  const tags = TAGS[concept] || [concept];
  return cached(`sec:frame:v2:${concept}:${period}`, 30 * 24 * 3600e3, async () => {
    // 必须**跨标签合并**，不能取第一个非空的：frames 是全市场级返回，
    // 「Revenues」对多数公司有数据就会被当成命中，而实际用
    // 「RevenueFromContractWithCustomerExcludingAssessedTax」的公司（如 AAPL）永远取不到。
    // 按 TAGS 顺序优先，后面的标签只填补空缺。
    const out = {};
    const used = [];
    for (const tag of tags) {
      const d = await fetchJson(
        `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/${period}.json`, { headers: H, retries: 2 },
      ).catch(() => null);
      if (!d?.data?.length) continue;
      used.push(tag);
      for (const r of d.data) {
        const k = String(r.cik);
        if (!out[k]) out[k] = { val: r.val, end: r.end, accn: r.accn, tag };
        else if (out[k].tag === tag && r.end > out[k].end) out[k] = { val: r.val, end: r.end, accn: r.accn, tag };
      }
    }
    return Object.keys(out).length ? { tags: used, byCik: out } : null;
  });
}

/**
 * 批量取美股某年的 OCF / 资本开支，按 ticker 返回。
 * years 给多个则逐年合并，用于「近 5 年累计 FCF/净利润」这类闸门。
 */
export async function bulkCashflow(tickers, years) {
  const map = await cikMap();
  const frames = {};
  for (const y of years) {
    frames[y] = {
      ocf: await frame('ocf', `CY${y}`),
      capex: await frame('capex', `CY${y}`),
    };
  }
  const out = new Map();
  for (const t of tickers) {
    const cik = map[String(t).toUpperCase()];
    if (!cik) { out.set(t, null); continue; }
    const key = String(Number(cik)); // frames 里 cik 是数字，无前导零
    const rows = [];
    for (const y of years) {
      const o = frames[y].ocf?.byCik?.[key];
      const c = frames[y].capex?.byCik?.[key];
      if (o || c) rows.push({ year: y, ocf: o?.val ?? null, capex: c?.val ?? null, end: o?.end || c?.end || null });
    }
    out.set(t, rows.length ? rows : null);
  }
  return out;
}

/**
 * 批量基本面：对 tickers 返回逐年的多概念值。
 * 用 frames API——每次调用返回「某概念 + 某年」的全市场值（6000+ 家），
 * 因此总请求数只与「概念数 × 年数」有关，与股票数无关。
 * 返回 Map(ticker -> { [year]: { revenue, netIncome, ... } })。
 */
export async function bulkFundamentals(tickers, years, { concepts = BULK_CONCEPTS, onProgress } = {}) {
  const map = await cikMap();
  const frames = {};
  let done = 0;
  for (const y of years) {
    frames[y] = {};
    for (const c of concepts) {
      frames[y][c] = await frame(c, periodOf(c, y));
      onProgress?.(++done, years.length * concepts.length);
    }
  }
  const out = new Map();
  for (const t of tickers) {
    const cik = map[String(t).toUpperCase()];
    if (!cik) { out.set(t, null); continue; }
    const key = String(Number(cik));   // frames 里 cik 无前导零
    const byYear = {};
    let any = false;
    for (const y of years) {
      const row = {};
      for (const c of concepts) {
        const v = frames[y][c]?.byCik?.[key];
        if (v) { row[c] = v.val; row._end = v.end; any = true; }
      }
      if (Object.keys(row).length) byYear[y] = row;
    }
    out.set(t, any ? byYear : null);
  }
  return out;
}

/**
 * 单只精查：某概念的完整历史（含 filed 披露日，供 PIT 用）。
 * 注意 SEC 的 fy/fp 指「申报所属期」，同一份 10-K 会把去年同期也标成同一 fy/fp，
 * 因此必须按 end 日期去重，不能按 fy/fp。
 */
export async function conceptSeries(ticker, concept) {
  const map = await cikMap();
  const cik = map[String(ticker).toUpperCase()];
  if (!cik) return null;
  const tags = TAGS[concept] || [concept];
  return cached(`sec:concept:${ticker}:${concept}`, CACHE_TTL.statement, async () => {
    for (const tag of tags) {
      const d = await fetchJson(
        `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`, { headers: H, retries: 2 },
      ).catch(() => null);
      const units = d?.units?.USD;
      if (!units?.length) continue;
      const byEnd = new Map();
      for (const r of units) {
        if (!r.end || r.val == null) continue;
        const durDays = r.start ? (new Date(r.end) - new Date(r.start)) / 86400e3 : null;
        const prev = byEnd.get(r.end);
        // 同一期间多次申报，保留最早 filed（首次披露即为 PIT 可用时点）
        if (!prev || r.filed < prev.filed) {
          byEnd.set(r.end, { end: r.end, start: r.start || null, val: r.val, filed: r.filed, form: r.form, days: durDays });
        }
      }
      return { tag, rows: [...byEnd.values()].sort((a, b) => (a.end < b.end ? 1 : -1)) };
    }
    return null;
  });
}

/** 年度口径序列（duration ≈ 365 天），用于归一化与质量闸门。 */
export async function annualSeries(ticker, concept) {
  const s = await conceptSeries(ticker, concept);
  if (!s) return null;
  return { tag: s.tag, rows: s.rows.filter((r) => r.days != null && r.days > 300 && r.days < 400) };
}
