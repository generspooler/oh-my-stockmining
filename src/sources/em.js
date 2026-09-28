// 东方财富数据源：全市场列表 / 日K / A股逐日估值序列 / 三大报表（A股宽表、美股长表）。
// 注意：clist 的 f2(最新价) 在美股缩放不一致（NVDA ÷1000、BRK.A ÷100），一律不使用，
// 价格改由腾讯行情或估值序列/日K 提供。PE(f115)/PB(f23) 为 ×100，市值(f20)/成交额(f6) 为原值。
import { fetchJson, cached, pool } from '../util.js';
import { CACHE_TTL, LIMITS } from '../config.js';

const EM_HEADERS = { Referer: 'https://data.eastmoney.com/' };
const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const n = (v) => (v == null || v === '' || v === '-' ? null : isFinite(Number(v)) ? Number(v) : null);
const d10 = (s) => (s ? String(s).slice(0, 10) : null);

// push2 行情域名在部分网络下会被重置，按序故障转移。
const PUSH_HOSTS = ['push2.eastmoney.com', '82.push2.eastmoney.com', 'push2delay.eastmoney.com'];
async function push(path, host0) {
  let lastErr;
  const hosts = host0 ? [host0, ...PUSH_HOSTS] : PUSH_HOSTS;
  for (const host of hosts) {
    try {
      const d = await fetchJson(`https://${host}${path}`, {
        headers: { Referer: 'https://quote.eastmoney.com/' }, retries: 1, timeout: 15000,
      });
      if (d?.data) return d;
      lastErr = new Error(`空响应 · ${host}`);
    } catch (e) { lastErr = e; }
  }
  // 几个域名共用同一套解析与线路，一个不通往往个个不通（IPv6 断连那次就是）。
  // 报错时把「全部失败」说清楚，别让调用方以为只是最后那台挂了。
  throw Object.assign(
    new Error(`东财行情 ${hosts.length} 个域名均失败 · 最后一次：${lastErr?.message || '空响应'}`),
    { cause: lastErr },
  );
}

/** datacenter 分页拉取，自动翻页到 maxPages。 */
async function dcAll(params, { maxPages = 50, pageSize = 500 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await fetchJson(`${DC}?${qs({ ...params, pageNumber: page, pageSize })}`, { headers: EM_HEADERS })
      .catch(() => null);
    const rows = d?.result?.data || [];
    out.push(...rows);
    if (rows.length < pageSize || page >= (d?.result?.pages || 1)) break;
  }
  return out;
}

// 板块串：A股排除北交所时用前者，含北交所再并上后者
const CN_BOARDS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
const CN_BJ = 'm:0+t:81+s:2048';
const US_BOARDS = 'm:105,m:106,m:107';

export const cnSecid = (code) => (/^(6|9)/.test(code) ? `1.${code}` : `0.${code}`);
export const usSecid = (code, mk = 105) => `${mk}.${String(code).toUpperCase()}`;

/** 名称判定 ST / 退市 / PT（东财 clist 不直接给风险标记，按名称识别）。 */
export const isRiskName = (name = '') => /ST/.test(name) || /退$/.test(name) || /^PT/.test(name);

/**
 * 全市场列表。clist pageSize 硬上限 100，按需翻页（A股 ~56 页、美股 ~139 页）。
 * 返回字段已完成缩放还原：pe/pb 已 ÷100，marketCap/turnover 为原值。
 */
// f3 今日涨跌幅、f24 60日涨跌幅(≈13周)、f25 年初至今 —— 粗筛的跌幅信号，全部 ×100。
// f37 ROE、f38 总股本：美股 clist 提供（A股走 MAINFINADATA）。
// f133 股息率(TTM)：两市场都有值，且**是原值百分数不是 ×100**
//   （实测 工商银行 f133=3.94 即 3.94%，同一行 f23=73 → PB 0.73、f115=774 → PE 7.74）。
//   随 clist 分页一起返回，零额外请求，不破坏本阶段「零逐股请求」的硬约束。
const UNIVERSE_FIELDS = 'f12,f13,f14,f6,f9,f20,f21,f23,f26,f100,f115,f3,f24,f25,f37,f38,f133';
// 缓存键必须跟着字段列表走：fs 不含 fields，只改 UNIVERSE_FIELDS 不改键的话，
// 6 小时内会持续读到按旧字段解析的结果，新字段静默全为 null。
// 与 MAINFINADATA 的 MAP_VERSION 同理（那次踩坑见下方注释）。
const UNIVERSE_VERSION = 'v2-f133';

export async function universe(market, { includeBeijing = false } = {}) {
  const fs = market === 'us' ? US_BOARDS : includeBeijing ? `${CN_BOARDS},${CN_BJ}` : CN_BOARDS;
  return cached(`universe:${UNIVERSE_VERSION}:${market}:${fs}`, CACHE_TTL.universe, async () => {
    const first = await push(`/api/qt/clist/get?${qs({
      pn: 1, pz: 100, po: 1, np: 1, fid: 'f20', fs,
      fields: UNIVERSE_FIELDS,
    })}`);
    const total = first?.data?.total || 0;
    const pages = Math.ceil(total / 100);
    const page = (pn) => push(`/api/qt/clist/get?${qs({
      pn, pz: 100, po: 1, np: 1, fid: 'f20', fs,
      fields: UNIVERSE_FIELDS,
    })}`).then((d) => d?.data?.diff || []);
    // 单页失败此前静默当空页：几页被断连就得到一份**残缺**清单，而且不是空数组，
    // cached() 会当成正常结果写盘 6 小时——下游表现为自选票莫名「未在全市场列表中找到」、
    // 粗筛少一批票也没人知道。现在失败页串行再试一轮，仍失败就整体报错并说明第几页：
    // 与 cached()「失败结果不写盘」同一原则，残缺清单比没有清单更害人。
    const pns = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2);
    const rest = await pool(pns, LIMITS.emConcurrency, page);   // pool 把失败项记为 null，空页是 []
    let lastErr = null;
    for (const pn of pns) {
      if (rest[pn - 2] != null) continue;
      try { rest[pn - 2] = await page(pn); } catch (e) { lastErr = e; }
    }
    const failed = pns.filter((pn) => rest[pn - 2] == null);
    if (failed.length) {
      throw new Error(`全市场列表拉取不完整：${failed.length}/${pages} 页失败`
        + `（第 ${failed.slice(0, 5).join('、')}${failed.length > 5 ? '…' : ''} 页）`
        + (lastErr ? ` · ${lastErr.message}` : ''));
    }
    const rows = [first?.data?.diff || [], ...rest].flat();
    const seen = new Set();
    return rows.filter((r) => r?.f12 && !seen.has(r.f12) && seen.add(r.f12)).map((r) => ({
      code: r.f12,
      name: r.f14,
      mk: n(r.f13),
      market,
      marketCap: n(r.f20),
      floatCap: n(r.f21),
      turnover: n(r.f6),                                  // 当日成交额
      pe: n(r.f115) != null ? n(r.f115) / 100 : null,     // PE(TTM)
      peDyn: n(r.f9) != null ? n(r.f9) / 100 : null,
      pb: n(r.f23) != null ? n(r.f23) / 100 : null,
      industry: r.f100 || null,                           // 美股=GICS一级；A股=东财行业
      listDate: r.f26 ? String(r.f26) : null,             // 19910703
      chgToday: n(r.f3) != null ? n(r.f3) / 100 : null,
      chg60d: n(r.f24) != null ? n(r.f24) / 100 : null,   // ≈13 周
      chgYtd: n(r.f25) != null ? n(r.f25) / 100 : null,
      roe: n(r.f37),                                      // 美股有值；A股此字段为空
      shares: n(r.f38),
      // 百分数原值（3.94 = 3.94%）。0 与 null 含义不同：0 = 不分红，null = 取不到
      dividendYield: n(r.f133),
      secid: market === 'us' ? usSecid(r.f12, n(r.f13) || 105) : cnSecid(r.f12),
    }));
  });
}

/**
 * K线。klt: 101=日 / 103=月。fqt: 0=不复权 / 1=前复权 / 2=后复权。
 *
 * 复权口径的选择见 SYSTEM_DEFINITION §2.6 步骤 1，三条都是实测结论：
 *   - 估值反算必须 fqt=0——复权价 × 股数 不等于当时市值；
 *   - 收益率/回撤必须复权，否则拆股与分红被读成下跌（NVDA 三年 −47% vs 真实 +364%）；
 *   - 且必须用**后复权 fqt=2，不能用前复权 fqt=1**。前复权从最新价往前扣现金分红，
 *     长窗口叠加拆股会扣穿零：实测 NVDA 日K 222 个非正收盘、茅台 369 个、KLAC 9 个，
 *     后复权在同样样本上非正点为 0。回撤只取比值，后复权不影响结果且数值稳定。
 *
 * 缓存键带 v2 与 klt：键结构变过就必须换键，否则旧条目会在整个 TTL 内冒充新口径
 * （本文件 UNIVERSE_VERSION / MAP_VERSION 两处都是为同一个教训留下的）。
 * 返回 [{date, close, turnover}]，旧→新。
 */
export async function kline(secid, { klt = 101, fqt = 1, beg = '20180101', end = '20500101' } = {}) {
  return cached(`kline:v2:${secid}:${klt}:${fqt}:${beg}`, CACHE_TTL.kline, async () => {
    const d = await push(`/api/qt/stock/kline/get?${qs({
      secid, klt, fqt, beg, end, fields1: 'f1,f2,f3', fields2: 'f51,f53,f57',
    })}`, 'push2his.eastmoney.com').catch(() => null);
    return (d?.data?.klines || []).map((line) => {
      const [date, close, turnover] = line.split(',');
      return { date, close: n(close), turnover: n(turnover) };
    });
  });
}

/** A股逐日估值序列（PE_TTM / PB_MRQ / PS_TTM / PCF）。茅台约 2100 条。 */
export async function valuationSeriesCN(code) {
  // v2：多取静态 PE / 静态 PCF / PEG（同一张表本来就返回，此前没映射）。
  // 缓存键必须跟着映射走，否则旧缓存里没有新字段、要等 TTL 过期才出现。
  return cached(`valseries:v2:${code}`, CACHE_TTL.valuation, async () => {
    const rows = await dcAll({
      reportName: 'RPT_VALUEANALYSIS_DET', columns: 'ALL',
      sortTypes: -1, sortColumns: 'TRADE_DATE', filter: `(SECURITY_CODE="${code}")`,
    }, { maxPages: 12, pageSize: 1000 });
    return rows.map((r) => ({
      date: d10(r.TRADE_DATE),
      close: n(r.CLOSE_PRICE),
      pe: n(r.PE_TTM), peLar: n(r.PE_LAR), pb: n(r.PB_MRQ), ps: n(r.PS_TTM),
      pcf: n(r.PCF_OCF_TTM), pcfLar: n(r.PCF_OCF_LAR), peg: n(r.PEG_CAR),
      marketCap: n(r.TOTAL_MARKET_CAP), shares: n(r.TOTAL_SHARES),
      board: r.BOARD_NAME || null,
    })).filter((x) => x.date);
  });
}

/**
 * A股一致预期（v0.10.0）。两张表：
 *   RPT_HSF10_RES_ORGPREDICT —— 逐机构预测，另有一行 ORG_NAME_ABBR=「近六月平均」，
 *     直接给出各年 EPS 与对应 PE（即 forward PE，接口算好的，不自己重算）；
 *   RPT_WEB_RESPREDICT —— 评级家数汇总（买入/增持/中性/减持/卖出）。
 * 无覆盖的标的返回 { ok:false }，不猜。逐机构行只用来给出分歧区间（最低/最高 EPS）。
 */
export async function forecastCN(code) {
  return cached(`forecast:${code}`, CACHE_TTL.misc, async () => {
    const [orgs, sum] = await Promise.all([
      dcAll({
        reportName: 'RPT_HSF10_RES_ORGPREDICT', columns: 'ALL',
        sortTypes: -1, sortColumns: 'PUBLISH_DATE', filter: `(SECURITY_CODE="${code}")`,
      }, { maxPages: 2, pageSize: 100 }),
      dcAll({
        reportName: 'RPT_WEB_RESPREDICT', columns: 'ALL', filter: `(SECURITY_CODE="${code}")`,
      }, { maxPages: 1, pageSize: 5 }),
    ]);
    const avg = orgs.find((r) => r.ORG_NAME_ABBR === '近六月平均');
    if (!avg) return { ok: false, reason: '无机构一致预期（近六月无覆盖）' };
    const years = [1, 2, 3, 4].map((i) => ({
      year: n(avg[`YEAR${i}`]), mark: avg[`YEAR_MARK${i}`] || null,   // A=实际 E=预测
      eps: n(avg[`EPS${i}`]), pe: n(avg[`PE${i}`]),
    })).filter((y) => y.year != null && y.eps != null);
    // 分歧：近 6 个月逐机构对第一个预测年的 EPS
    const firstE = years.find((y) => y.mark === 'E');
    const since = Date.now() - 183 * 864e5;
    const peers = orgs.filter((r) => r.ORG_NAME_ABBR !== '近六月平均'
      && Date.parse(String(r.PUBLISH_DATE).slice(0, 10)) >= since);
    const epsOf = (r) => {
      for (const i of [1, 2, 3, 4]) if (n(r[`YEAR${i}`]) === firstE?.year) return n(r[`EPS${i}`]);
      return null;
    };
    const es = firstE ? peers.map(epsOf).filter((x) => x != null) : [];
    const s0 = sum[0] || {};
    return {
      ok: true, asOf: d10(avg.PUBLISH_DATE), years,
      spread: es.length ? { year: firstE.year, min: Math.min(...es), max: Math.max(...es), n: es.length } : null,
      ratings: {
        orgs: n(s0.RATING_ORG_NUM), buy: n(s0.RATING_BUY_NUM), add: n(s0.RATING_ADD_NUM),
        neutral: n(s0.RATING_NEUTRAL_NUM), reduce: n(s0.RATING_REDUCE_NUM), sell: n(s0.RATING_SALE_NUM),
      },
    };
  });
}

// ── A股三大报表（宽表，一行一期）─────────────────────────────────
const CN_REPORTS = {
  income: 'RPT_F10_FINANCE_GINCOME',
  balance: 'RPT_F10_FINANCE_GBALANCE',
  cashflow: 'RPT_F10_FINANCE_GCASHFLOW',
};

async function cnStatement(kind, secucode, periods) {
  return cached(`cnstmt:${kind}:${secucode}:${periods}`, CACHE_TTL.statement, () =>
    dcAll({
      reportName: CN_REPORTS[kind], columns: 'ALL',
      sortTypes: -1, sortColumns: 'REPORT_DATE', filter: `(SECUCODE="${secucode}")`,
    }, { maxPages: Math.ceil(periods / 100) || 1, pageSize: 100 }));
}

const cnSecucode = (code) => `${code}.${/^(6|9)/.test(code) ? 'SH' : /^(8|4)/.test(code) ? 'BJ' : 'SZ'}`;

/**
 * A股财报，按报告期合并三表并归一化字段名。
 * A股为累计口径：12-31 是全年，03-31/06-30/09-30 是年内累计。
 */
export async function statementsCN(code, periods = 44) {
  const su = cnSecucode(code);
  const [inc, bal, cf] = await Promise.all([
    cnStatement('income', su, periods), cnStatement('balance', su, periods), cnStatement('cashflow', su, periods),
  ]);
  const byPeriod = new Map();
  const put = (rows, fn) => {
    for (const r of rows || []) {
      const p = d10(r.REPORT_DATE);
      if (!p) continue;
      if (!byPeriod.has(p)) byPeriod.set(p, { period: p, noticeDate: d10(r.NOTICE_DATE) });
      Object.assign(byPeriod.get(p), fn(r));
      // 披露日取三表中最晚的，PIT 以最晚可得为准
      const nd = d10(r.NOTICE_DATE), cur = byPeriod.get(p).noticeDate;
      if (nd && (!cur || nd > cur)) byPeriod.get(p).noticeDate = nd;
    }
  };
  put(inc, (r) => ({
    revenue: n(r.TOTAL_OPERATE_INCOME) ?? n(r.OPERATE_INCOME),
    operateCost: n(r.OPERATE_COST),
    operateProfit: n(r.OPERATE_PROFIT),
    totalProfit: n(r.TOTAL_PROFIT),
    incomeTax: n(r.INCOME_TAX),
    netProfit: n(r.NETPROFIT),
    parentNetProfit: n(r.PARENT_NETPROFIT),
    minorityInterest: n(r.MINORITY_INTEREST),
    deductNetProfit: n(r.DEDUCT_PARENT_NETPROFIT),
    interestExpense: n(r.FE_INTEREST_EXPENSE) ?? n(r.INTEREST_EXPENSE),
    financeExpense: n(r.FINANCE_EXPENSE),
    rd: n(r.RESEARCH_EXPENSE) ?? n(r.ME_RESEARCH_EXPENSE),
    saleExpense: n(r.SALE_EXPENSE),
    manageExpense: n(r.MANAGE_EXPENSE),
    eps: n(r.BASIC_EPS),
    opinionType: r.OPINION_TYPE || null,
    reportType: r.REPORT_TYPE || null,
  }));
  put(bal, (r) => ({
    totalAssets: n(r.TOTAL_ASSETS),
    currentAssets: n(r.TOTAL_CURRENT_ASSETS),
    currentLiab: n(r.TOTAL_CURRENT_LIAB),
    totalLiab: n(r.TOTAL_LIABILITIES),
    equity: n(r.TOTAL_EQUITY),
    parentEquity: n(r.TOTAL_PARENT_EQUITY),
    minorityEquity: n(r.MINORITY_EQUITY),
    goodwill: n(r.GOODWILL),
    inventory: n(r.INVENTORY),
    ar: n(r.NOTE_ACCOUNTS_RECE) ?? n(r.ACCOUNTS_RECE),
    contractLiab: n(r.CONTRACT_LIAB) ?? n(r.ADVANCE_RECEIVABLES),
    shares: n(r.SHARE_CAPITAL),
    shortLoan: n(r.SHORT_LOAN),
    longLoan: n(r.LONG_LOAN),
    cash: n(r.MONETARYFUNDS),
    fixedAsset: n(r.FIXED_ASSET),
    intangible: n(r.INTANGIBLE_ASSET),
    treasuryShares: n(r.TREASURY_SHARES),
    listingState: r.LISTING_STATE || null,
  }));
  put(cf, (r) => ({
    ocf: n(r.NETCASH_OPERATE),
    capex: n(r.CONSTRUCT_LONG_ASSET),
    depreciation: n(r.FA_IR_DEPR),
    amortize: n(r.IA_AMORTIZE),
    icf: n(r.NETCASH_INVEST),
    fcf_financing: n(r.NETCASH_FINANCE),
    dividendPaid: n(r.ASSIGN_DIVIDEND_PORFIT),
  }));
  return [...byPeriod.values()].sort((a, b) => (a.period < b.period ? 1 : -1));
}

// ── 美股报表（长表：一行一科目，需透视）──────────────────────────
// 美股科目代码（实测自 RPT_USF10_FN_*）。注意利润表与资产负债表的代码空间重叠
// （004011999 在利润表是「税前利润」、在资产负债表是「总负债」），必须分表字典，不可合并。
const US_ITEM = {
  '004001999': 'revenue', '004003999': 'operateCost', '004005999': 'grossProfit',
  '004007999': 'operateExpense', '004007001': 'rd', '004007002': 'saleExpense',
  '004009999': 'operateProfit', '004011999': 'totalProfit',
  '004013001': 'incomeTax', '004013999': 'netProfit',
  '004015999': 'parentNetProfit', '004015096': 'parentNetProfit',
  '004017003': 'eps', '004017007': 'sharesBasic', '004017008': 'sharesDiluted',
};
const US_BAL_ITEM = {
  '004005999': 'totalAssets', '004011999': 'totalLiab',
  '004017999': 'equity', '004013999': 'parentEquity',
  '004001999': 'currentAssets', '004007999': 'currentLiab',
  '004003999': 'noncurrentAssets', '004009999': 'noncurrentLiab',
  '004001008': 'inventory', '004001004': 'ar', '004001001': 'cash',
  '004003004': 'goodwill', '004003003': 'intangible', '004003001': 'fixedAsset',
  '004007007': 'shortLoan', '004009005': 'longLoan', '004007008': 'longLoanCurrent',
  '004007010': 'contractLiab', '004013001': 'commonStock',
};

async function usReport(reportName, code, reportType) {
  return cached(`usstmt:${reportName}:${code}:${reportType}`, CACHE_TTL.statement, () =>
    dcAll({
      reportName, columns: 'ALL', sortTypes: -1, sortColumns: 'REPORT_DATE',
      filter: `(SECUCODE="${code}")(REPORT_TYPE="${reportType}")`,
    }, { maxPages: 8, pageSize: 500 }));
}

/** 把长表按报告期透视成宽表。 */
function pivotUs(rows, dict) {
  const byPeriod = new Map();
  for (const r of rows || []) {
    const p = d10(r.REPORT_DATE);
    const key = dict[r.STD_ITEM_CODE];
    if (!p || !key) continue;
    if (!byPeriod.has(p)) byPeriod.set(p, { period: p, currency: r.CURRENCY_ABBR || 'USD' });
    const v = n(r.AMOUNT);
    if (v != null && byPeriod.get(p)[key] == null) byPeriod.get(p)[key] = v;
  }
  return byPeriod;
}

/** 美股财报。annual=年报（归一化用），quarterly=单季报（TTM 用）。 */
export async function statementsUS(code, suffix = 'O') {
  const su = `${String(code).toUpperCase()}.${suffix}`;
  const [incA, incQ, balA] = await Promise.all([
    usReport('RPT_USF10_FN_INCOME', su, '年报'),
    usReport('RPT_USF10_FN_INCOME', su, '单季报'),
    usReport('RPT_USF10_FN_BALANCE', su, '年报'),
  ]);
  const merge = (incMap, balMap) => {
    for (const [p, v] of balMap) {
      if (incMap.has(p)) Object.assign(incMap.get(p), v);
      else incMap.set(p, v);
    }
    return [...incMap.values()].sort((a, b) => (a.period < b.period ? 1 : -1));
  };
  return {
    annual: merge(pivotUs(incA, US_ITEM), pivotUs(balA, US_BAL_ITEM)),
    quarterly: [...pivotUs(incQ, US_ITEM).values()].sort((a, b) => (a.period < b.period ? 1 : -1)),
  };
}

/** 美股代码在东财的后缀（O=NASDAQ, N=NYSE, A=AMEX），由 clist 的 f13 推出。 */
export const usSuffix = (mk) => ({ 105: 'O', 106: 'N', 107: 'A' }[mk] || 'O');

export { push, dcAll, qs, n as toNum, d10 };

// ── 主要财务指标（RPT_F10_FINANCE_MAINFINADATA）───────────────────
// 161 字段，ROIC / 利息保障倍数 / ROE / ROA / 毛利率 / 资产负债率 / 流动比率 /
// 每股经营现金流 / FCFF / 实际税率 / 周转天数 全部现成，且统一覆盖 通用/银行/证券/保险
// （GBALANCE 只覆盖「通用」，取不到银行与券商）。支持按报告期整市场查询：
// 全市场一期 13935 条 / 28 页，比逐股拉三大报表省两个数量级的请求。
// 字段映射版本：映射规则一改就要让旧缓存失效，否则会读到按旧规则解析的结果
// （拨备覆盖率字段修正时踩过：缓存里仍是拨贷比 2.79%）。
const MAP_VERSION = 'v2';

const MAIN_COLS = [
  'SECUCODE', 'SECURITY_CODE', 'SECURITY_NAME_ABBR', 'ORG_TYPE', 'REPORT_DATE', 'NOTICE_DATE', 'REPORT_TYPE',
  'EPSJB', 'EPSKCJB', 'BPS', 'MGJYXJJE', 'TOTALOPERATEREVE', 'PARENTNETPROFIT', 'KCFJCXSYJLR',
  'TOTALOPERATEREVETZ', 'PARENTNETPROFITTZ', 'ROEJQ', 'ROEKCJQ', 'ZZCJLL', 'XSJLL', 'XSMLL',
  'TAXRATE', 'LD', 'SD', 'CASH_RATIO', 'ZCFZL', 'QYCS', 'TOAZZL', 'ZZCZZTS', 'YSZKZZTS', 'CHZZTS',
  'OPERATE_CYCLE', 'INTEREST_COVERAGE_RATIO', 'ROIC', 'FCFF_BACK', 'FCFF_FORWARD',
  'TOTAL_SHARE', 'TOTAL_EQUITY_PK', 'TOTAL_ASSETS_PK', 'NETCASH_OPERATE_PK', 'OPERATE_PROFIT_PK',
  'NCO_NETPROFIT', 'INTEREST_DEBT_RATIO', 'PER_EBIT', 'JYXJLYYSR',
  // 银行 / 券商 / 保险专用
  'NONPERLOAN', 'NEWCAPITALADER', 'HXYJBCZL', 'NET_INTEREST_MARGIN', 'BLDKBBL', 'LOAN_PROVISION_RATIO',
  'JZC', 'SOLVENCY_AR', 'RISK_COVERAGE',
].join(',');

const mapMain = (r) => ({
  code: r.SECURITY_CODE || String(r.SECUCODE || '').split('.')[0],
  secucode: r.SECUCODE,
  name: r.SECURITY_NAME_ABBR,
  orgType: r.ORG_TYPE,
  period: d10(r.REPORT_DATE),
  noticeDate: d10(r.NOTICE_DATE),          // PIT：财报实际披露日
  reportType: r.REPORT_TYPE,
  eps: n(r.EPSJB), epsDeduct: n(r.EPSKCJB), bps: n(r.BPS), ocfPerShare: n(r.MGJYXJJE),
  revenue: n(r.TOTALOPERATEREVE), parentNetProfit: n(r.PARENTNETPROFIT), deductNetProfit: n(r.KCFJCXSYJLR),
  revenueYoY: n(r.TOTALOPERATEREVETZ), profitYoY: n(r.PARENTNETPROFITTZ),
  roe: n(r.ROEJQ), roeDeduct: n(r.ROEKCJQ), roa: n(r.ZZCJLL),
  netMargin: n(r.XSJLL), grossMargin: n(r.XSMLL), taxRate: n(r.TAXRATE),
  currentRatio: n(r.LD), quickRatio: n(r.SD), cashRatio: n(r.CASH_RATIO),
  debtRatio: n(r.ZCFZL), equityMultiplier: n(r.QYCS),
  assetTurnover: n(r.TOAZZL), assetTurnoverDays: n(r.ZZCZZTS),
  arDays: n(r.YSZKZZTS), invDays: n(r.CHZZTS), operateCycle: n(r.OPERATE_CYCLE),
  interestCoverage: n(r.INTEREST_COVERAGE_RATIO),
  roic: n(r.ROIC),
  fcff: n(r.FCFF_BACK) ?? n(r.FCFF_FORWARD),
  shares: n(r.TOTAL_SHARE),
  equity: n(r.TOTAL_EQUITY_PK), totalAssets: n(r.TOTAL_ASSETS_PK),
  ocf: n(r.NETCASH_OPERATE_PK), operateProfit: n(r.OPERATE_PROFIT_PK),
  nonRecurringRatio: n(r.NCO_NETPROFIT), interestDebtRatio: n(r.INTEREST_DEBT_RATIO),
  perEbit: n(r.PER_EBIT), ocfToRevenue: n(r.JYXJLYYSR),
  // BLDKBBL 才是拨备覆盖率（工行实测 217.58%）；LOAN_PROVISION_RATIO 是拨贷比（2.8%），两者不可混用
  bank: {
    npl: n(r.NONPERLOAN), car: n(r.NEWCAPITALADER), coreCar: n(r.HXYJBCZL),
    nim: n(r.NET_INTEREST_MARGIN), provision: n(r.BLDKBBL), loanProvisionRatio: n(r.LOAN_PROVISION_RATIO),
  },
  broker: { netAssets: n(r.JZC) },
  insurer: { solvency: n(r.SOLVENCY_AR) },
});

/** 单只的主要财务指标历史（最新在前）。 */
export async function mainIndicators(code, periods = 44) {
  const su = cnSecucode(code);
  return cached(`main:${MAP_VERSION}:${su}:${periods}`, CACHE_TTL.statement, async () => {
    const rows = await dcAll({
      reportName: 'RPT_F10_FINANCE_MAINFINADATA', columns: MAIN_COLS,
      sortTypes: -1, sortColumns: 'REPORT_DATE', filter: `(SECUCODE="${su}")`,
    }, { maxPages: 2, pageSize: 100 });
    return rows.map(mapMain).filter((r) => r.period);
  });
}

/**
 * 全市场某报告期的主要财务指标。整市场一期约 28 页。
 * 第 2 层质量闸门用它做批量筛选，避免逐股拉三大报表。
 */
export async function marketIndicators(reportDate) {
  return cached(`mainmkt:${MAP_VERSION}:${reportDate}`, CACHE_TTL.statement, async () => {
    const rows = await dcAll({
      reportName: 'RPT_F10_FINANCE_MAINFINADATA', columns: MAIN_COLS,
      sortTypes: -1, sortColumns: 'SECUCODE', filter: `(REPORT_DATE='${reportDate}')`,
    }, { maxPages: 40, pageSize: 500 });
    const out = new Map();
    for (const r of rows.map(mapMain)) if (r.code) out.set(r.code, r);
    return [...out.values()];
  });
}

/** 最近 N 个年报报告期（用于归一化与 F-Score 的同比项）。 */
export function recentAnnualPeriods(n = 7, asOf = new Date()) {
  const y = asOf.getFullYear();
  // 年报通常次年 4 月底前披露完毕；4 月之前用上上年作为最新完整年报
  const latest = asOf.getMonth() >= 4 ? y - 1 : y - 2;
  return Array.from({ length: n }, (_, i) => `${latest - i}-12-31`);
}
