// 细筛的取数工具集（SYSTEM_DEFINITION §3.4）。
//
// 为什么存在：细筛此前只能在机械层给定的档案里排序——问它「这个便宜是错杀还是陷阱」，
// 手上却只有估值与财务比率，行业格局、竞争动态、管理层表述一个字都没有。
// 本模块给模型**主动取数**的能力，工具由 completeWithTools() 驱动。
//
// 两条贯穿全模块的铁律：
//   1. **必须摘要化**。maxResultChars 是最后一道闸，但每个工具自己就要控制体积——
//      茅台半年报 22 万字、AAPL 10-K 去标签 23 万字，整给等于自杀
//      （实测教训：77k token 输入曾只剩 164 token 给正文、模型吐出 0 字）。
//   2. **取不到就如实说取不到**，绝不返回猜的值（§6.5）。工具返回的每一句
//      「不可得」都带原因，让模型能区分「数据源没有」与「公司没披露」。
import * as em from './sources/em.js';
import * as sec from './sources/sec.js';
import { filingSectionCN, filingSectionUS } from './sources/filings.js';
import { adjustedMonthly } from './metrics/returns.js';
import { percentile } from './util.js';

const f = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d));
const yi = (v) => (v == null || !isFinite(v) ? '—' : (v / 1e8).toFixed(1) + '亿');

// ── 工具定义（两种协议共用，llm.js 负责翻译成各自的信封）────────────

export const TOOL_DEFS = [
  {
    name: 'get_filing',
    description: '取该公司最近年报/半年报（美股 10-K）的指定章节正文。'
      + '这是唯一能拿到管理层自述的行业判断、经营解释与风险披露的工具——'
      + '档案里的财务数字回答不了「这个便宜是错杀还是陷阱」，这里的正文可以。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '标的代码，须是候选清单里出现过的代码' },
        section: {
          type: 'string', enum: ['mdna', 'risk', 'business'],
          description: 'mdna=管理层讨论与分析（首选）；risk=风险因素；business=业务描述（仅美股）',
        },
      },
      required: ['code', 'section'],
    },
  },
  {
    name: 'get_statements',
    description: '取最近 8 期三大报表的关键行（营收/毛利/营业利润/净利/经营现金流/资本开支/'
      + '总资产/净资产/有息负债/现金/存货/应收）。用于验证趋势与现金流质量。',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  },
  {
    name: 'get_main_indicators',
    description: '取最近 6 期的完整主要财务指标（约 45 项，含 ROIC/利息保障/周转天数/'
      + '实际税率/非经常性损益占比，银行券商保险另有不良率、拨备覆盖率、净息差等专有指标）。'
      + '**仅 A股可用**，美股无此数据源。',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  },
  {
    name: 'get_concept_series',
    description: '取美股某个财务概念的完整历史序列（含首次披露日）。'
      + '**美股专用**，用于在档案的估值区间不可得时自己重建盈利趋势。'
      + '概念名：revenue / netIncome / equity / assets / ocf / capex / grossProfit / operatingIncome。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        concept: { type: 'string', description: '如 revenue、netIncome、ocf' },
      },
      required: ['code', 'concept'],
    },
  },
  {
    name: 'get_valuation_summary',
    description: '取该股历史倍数分位的**时间分布**：逐年的倍数区间。'
      + '用于判断档案里的三档区间是否被某一段泡沫期抬高——'
      + '例如分位 P75 若全部来自某两年的高景气，「乐观值」就不是可外推的锚。',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  },
  {
    name: 'get_peers',
    description: '取同行业标的的横截面对比（市值/PE/PB/ROE/毛利率/负债率/跌幅）。'
      + '数据来自本轮全市场收集，零额外请求。用于判断「便宜」是个股问题还是全行业问题。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '以该标的所属行业取同业' },
        limit: { type: 'number', description: '返回条数，默认 15' },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_price_series',
    description: '取复权月线序列（最近 60 个月的收盘）。用于看下跌的**形态与起点**——'
      + '档案里只有几个区间数字，看不出是一次性跳水还是慢刀子。',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  },
];

// ── 各工具实现 ───────────────────────────────────────────────────

/** 三大报表关键行 → 窄表。8 期足够看趋势，再多就是体积负担。 */
async function statementsText(row) {
  const cn = row.market === 'cn';
  const st = cn
    ? await em.statementsCN(row.code).catch(() => null)
    : await em.statementsUS(row.code, em.usSuffix(row.mk)).catch(() => null);
  const rows = (cn ? st : st?.annual) || [];
  if (!rows.length) return `报表不可得（${cn ? '东财 A股 三大报表' : '东财美股年报'}返回为空）`;
  const use = rows.slice(0, 8);
  const L = [`${row.name}（${row.code}）报表关键行，共 ${use.length} 期，新→旧`];
  if (cn) L.push('⚠ A股 季度数据是**累计**口径：03-31/06-30/09-30 为年初至今，不是单季');
  const cols = cn
    ? [['营收', 'revenue'], ['营业利润', 'operateProfit'], ['归母净利', 'parentNetProfit'],
      ['经营现金流', 'ocf'], ['资本开支', 'capex'], ['总资产', 'totalAssets'], ['净资产', 'parentEquity'],
      ['短借', 'shortLoan'], ['长借', 'longLoan'], ['货币资金', 'cash'], ['存货', 'inventory'], ['应收', 'ar']]
    : [['营收', 'revenue'], ['毛利', 'grossProfit'], ['营业利润', 'operateProfit'], ['归母净利', 'parentNetProfit'],
      ['总资产', 'totalAssets'], ['净资产', 'parentEquity'], ['短借', 'shortLoan'], ['长借', 'longLoan'],
      ['货币资金', 'cash'], ['存货', 'inventory'], ['应收', 'ar']];
  L.push(['科目'.padEnd(12), ...use.map((r) => String(r.period).padStart(12))].join(''));
  for (const [label, key] of cols) {
    L.push([label.padEnd(12), ...use.map((r) => yi(r[key]).padStart(12))].join(''));
  }
  return L.join('\n');
}

/** A股 主要财务指标，最近 6 期。含银行/券商/保险专有块。 */
async function mainIndicatorsText(row) {
  if (row.market !== 'cn') return '该工具仅 A股 可用：美股没有对应数据源（东财 MAINFINADATA 是 A股 专有）。美股请用 get_concept_series。';
  const rows = await em.mainIndicators(row.code).catch(() => []);
  if (!rows.length) return '主要财务指标不可得（MAINFINADATA 返回为空）';
  const use = rows.slice(0, 6);
  const L = [`${row.name}（${row.code}）主要财务指标，共 ${use.length} 期，新→旧`];
  const fields = [
    ['ROE(加权%)', 'roe'], ['扣非ROE%', 'roeDeduct'], ['ROIC%', 'roic'], ['ROA%', 'roa'],
    ['毛利率%', 'grossMargin'], ['净利率%', 'netMargin'], ['实际税率%', 'taxRate'],
    ['负债率%', 'debtRatio'], ['利息保障(x)', 'interestCoverage'], ['流动比率', 'currentRatio'],
    ['应收天数', 'arDays'], ['存货天数', 'invDays'], ['营业周期', 'operateCycle'],
    ['营收同比%', 'revenueYoY'], ['净利同比%', 'profitYoY'],
    ['非经常占比%', 'nonRecurringRatio'], ['经现/营收%', 'ocfToRevenue'], ['每股经现', 'ocfPerShare'],
  ];
  L.push(['指标'.padEnd(14), ...use.map((r) => String(r.period).padStart(12))].join(''));
  for (const [label, key] of fields) {
    if (use.every((r) => r[key] == null)) continue;
    L.push([label.padEnd(14), ...use.map((r) => f(r[key], 2).padStart(12))].join(''));
  }
  // 金融业专有块：通用报表取不到，这是 MAINFINADATA 的主要价值之一
  const fin = [['不良率%', 'nonperLoan'], ['资本充足率%', 'capitalAdequacy'],
    ['净息差%', 'netInterestMargin'], ['拨备覆盖率%', 'provisionCoverage'], ['偿付能力%', 'solvency']];
  const finRows = fin.filter(([, k]) => use.some((r) => r.bank?.[k] != null || r.insurer?.[k] != null || r[k] != null));
  if (finRows.length) {
    L.push('— 金融业专有 —');
    for (const [label, k] of finRows) {
      L.push([label.padEnd(14), ...use.map((r) => f(r.bank?.[k] ?? r.insurer?.[k] ?? r[k], 2).padStart(12))].join(''));
    }
  }
  return L.join('\n');
}

/** 美股单概念历史序列。只给年度口径，按期末新→旧。 */
async function conceptText(row, concept) {
  if (row.market !== 'us') return '该工具仅美股可用（SEC XBRL）。A股 请用 get_main_indicators 或 get_statements。';
  const s = await sec.conceptSeries(row.code, String(concept || '').trim()).catch(() => null);
  if (!s?.rows?.length) {
    return `概念「${concept}」不可得：SEC XBRL 里该公司没有对应标签，或概念名不在支持列表内`
      + `（支持：${sec.BULK_CONCEPTS.join(' / ')}）`;
  }
  const annual = s.rows.filter((r) => r.days != null && r.days > 300 && r.days < 400).slice(0, 10);
  const use = annual.length ? annual : s.rows.slice(0, 12);
  const L = [`${row.name}（${row.code}）概念 ${concept}｜XBRL 标签 ${s.tag}｜${annual.length ? '年度口径' : '全部口径（年度不足）'}`];
  for (const r of use) {
    L.push(`  ${r.end}　${yi(r.val).padStart(12)}　首次披露 ${r.filed}　${r.form || ''}${r.days ? `　区间 ${Math.round(r.days)}天` : ''}`);
  }
  return L.join('\n');
}

/**
 * 历史倍数分位的**时间分布**。
 * 档案里已经给了 P25/P50/P75，这里要回答档案答不了的问题：
 * 那个 P75 是均匀分布出来的，还是全来自某两年的泡沫？
 * 实测例：茅台「乐观 ¥2604」隐含 38 倍 PE，而 38 倍只出现在 2021 年白酒泡沫期。
 */
async function valuationSummaryText(row) {
  if (row.market !== 'cn') {
    return '该工具仅 A股 可用（东财逐日估值序列是 A股 专有）。美股的倍数序列由系统反算，逐年分布不可得。';
  }
  const s = await em.valuationSeriesCN(row.code).catch(() => []);
  if (!s?.length) return '估值序列不可得（RPT_VALUEANALYSIS_DET 返回为空）';
  const byYear = new Map();
  for (const r of s) {
    const y = String(r.date || '').slice(0, 4);
    if (!y) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  const L = [`${row.name}（${row.code}）历史倍数的逐年分布（共 ${s.length} 个交易日点）`,
    '年份    PE  P25/P50/P75        PB  P25/P50/P75'];
  for (const y of [...byYear.keys()].sort().reverse().slice(0, 11)) {
    const g = byYear.get(y);
    const pe = g.map((x) => x.pe).filter((v) => v != null && v > 0);
    const pb = g.map((x) => x.pb).filter((v) => v != null && v > 0);
    const q = (a) => (a.length ? `${f(percentile(a, 25), 1)}/${f(percentile(a, 50), 1)}/${f(percentile(a, 75), 1)}` : '—');
    L.push(`${y}    ${q(pe).padEnd(20)} ${q(pb)}`);
  }
  L.push('注：档案里的三档区间用的是整个窗口的 P25/P50/P75。若某一档只由上表中个别年份贡献，该档不可外推。');
  return L.join('\n');
}

/**
 * 同业横截面。
 *
 * 首选本轮收集结果（零请求、字段最全）。但**自选池流水线只收池内那十几只**
 * （collect 的 onlyCodes），同业几乎必然为空——那条流水线的整个设计前提就是不碰全市场。
 * 因此回落到 em.universe()：单次请求、缓存 6 小时，不破坏该前提，
 * 代价是只有行情与 ROE，没有毛利率/负债率/回撤。字段来源如实标注。
 */
async function peersText(row, ctx, limit = 15) {
  const ind = row.industry;
  const n = Math.min(Number(limit) || 15, 30);
  const same = (all) => (all || []).filter((r) => r.industry === ind && String(r.code) !== String(row.code));

  let pool = same(ctx.rows);
  let source = '本轮收集';
  let full = true;
  if (pool.length < 2) {
    const uni = await em.universe(row.market).catch(() => []);
    const alt = same(uni);
    if (alt.length >= pool.length) { pool = alt; source = '全市场列表（缓存）'; full = false; }
  }
  if (!pool.length) return `行业「${ind}」找不到其他标的（可能是该行业分类下只有它一只）`;

  const peers = pool.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, n);
  const L = [`行业「${ind}」同业横截面（按市值降序，共 ${peers.length} 只；来源：${source}）`];
  if (!full) L.push('⚠ 本轮未收集全行业基本面，毛利率/负债率/回撤不可得（显示为 —），不代表这些公司数值差');
  L.push('代码      名称          市值     PE     PB   ROE%  毛利%  负债%  距52周高');
  const line = (r, mark) => [
    String(r.code).padEnd(9), String(r.name || '').slice(0, 12).padEnd(13),
    yi(r.marketCap).padStart(8), f(r.pe, 1).padStart(7), f(r.pb, 2).padStart(7),
    f(r.roe, 1).padStart(6), f(r.grossMargin, 1).padStart(7), f(r.debtRatio, 1).padStart(7),
    (r.drawdown52 == null ? '—' : (r.drawdown52 * 100).toFixed(0) + '%').padStart(9), mark || '',
  ].join('');
  L.push(line(row, '  ← 本标的'));
  for (const p of peers) L.push(line(p));
  return L.join('\n');
}

/**
 * 复权月线，最近 60 个月。看下跌的形态与起点。
 *
 * **必须以现价重新锚定**。后复权序列只适合算比值，直接展示会害人：
 * 茅台后复权 2021-10 是 9661.08，模型会读成「当时股价 9661 元」（实际约 1800）。
 * 重锚后末点等于真实现价，整条路径读起来就是「剔除除权影响后的价格轨迹」。
 */
async function priceSeriesText(row) {
  const pack = await adjustedMonthly(row).catch(() => null);
  if (!pack?.usable) return `价格序列不可用（${pack?.reason || '取不到'}）`;
  const use = pack.rows.slice(-60);
  if (!use.length) return '价格序列为空';
  const lastAdj = use[use.length - 1].close;
  const anchor = row.price != null && isFinite(row.price) && lastAdj > 0 ? row.price / lastAdj : 1;
  const cur = row.market === 'cn' ? '¥' : '$';
  const L = [
    `${row.name}（${row.code}）月线收盘，最近 ${use.length} 个月（${pack.source}，已按现价重新锚定）`,
    `口径：已剔除拆股与分红的影响，末点 = 现价 ${cur}${f(row.price)}。`
    + '这不是当时的实际成交价，而是可直接相互比较的价格轨迹。',
  ];
  for (let i = 0; i < use.length; i += 6) {
    L.push('  ' + use.slice(i, i + 6).map((r) => `${r.date.slice(0, 7)} ${f(r.close * anchor, 2)}`).join('　'));
  }
  return L.join('\n');
}

/** 财报/公告章节正文。两个市场分别走各自的抽取路径。 */
async function filingText(row, section) {
  const kind = ['mdna', 'risk', 'business'].includes(section) ? section : 'mdna';
  const r = row.market === 'cn'
    ? await filingSectionCN(row.code, { kind: kind === 'business' ? 'mdna' : kind })
    : await filingSectionUS(row.code, { kind });
  if (!r.ok) {
    return `${kind} 章节不可得：${r.reason}`
      + (r.available ? `\n可选公告：${r.available.join('；')}` : '')
      + '\n（这只说明本渠道抽不到该章节，不代表公司没有披露）';
  }
  return `${row.name}（${row.code}）｜${r.doc}｜${r.label}｜原文 ${r.chars || r.text.length} 字符`
    + (r.endUnbounded ? '\n⚠ 未找到章节结束标记，以下内容可能混入后续章节' : '')
    + (r.fallback ? '\n⚠ 这不是章节抽取结果：该报告没有使用标准章节标题，'
      + '以下是报告正文开头几页，请自行判断其中有多少与你要问的问题相关' : '')
    + `\n\n${r.text}`;
}

/**
 * 构造本轮可用的工具集。
 * ctx：{ rows, byCode }——rows 供 get_peers 做同业横截面，byCode 解析代码。
 * 返回 { defs, handle }，handle 交给 completeWithTools 的 onToolCall。
 */
export function buildTools(ctx = {}) {
  const byCode = ctx.byCode instanceof Map
    ? ctx.byCode
    : new Map((ctx.rows || []).map((r) => [String(r.code).toUpperCase(), r]));

  const resolve = (code) => byCode.get(String(code || '').trim().toUpperCase()) || null;

  async function handle(name, input = {}) {
    const row = resolve(input.code);
    if (!row) {
      return `代码「${input.code}」不在本轮候选清单内，无法取数。`
        + '只能对清单里出现过的代码取数——避免把分析扩散到没有经过收集的标的。';
    }
    switch (name) {
      case 'get_filing': return filingText(row, input.section);
      case 'get_statements': return statementsText(row);
      case 'get_main_indicators': return mainIndicatorsText(row);
      case 'get_concept_series': return conceptText(row, input.concept);
      case 'get_valuation_summary': return valuationSummaryText(row);
      case 'get_peers': return peersText(row, ctx, input.limit);
      case 'get_price_series': return priceSeriesText(row);
      default: return `未知工具 ${name}`;
    }
  }

  return { defs: TOOL_DEFS, handle };
}

/**
 * 包装 handle，累积工具返回文本——供**分层数字规则**的 L2 层用（§5.3）。
 *
 * L2 = 工具返回的数字，与 L1（提示词里给定的数字）同权，可自由引用。
 * 不累积的话，模型引用刚取回来的数据会被 validateNumbers 判成「无法追溯」，
 * 等于一边给它取数能力、一边把取回的数字标成可疑。
 *
 * 只在内存里留文本用于构造白名单，**不写进 toolLog、不落盘**——
 * 快照会膨胀到不可用（仓库对 seriesRows 也是这么处理的）。
 */
export function withTranscript(handle) {
  const parts = [];
  return {
    handle: async (name, input, meta) => {
      const r = await handle(name, input, meta);
      parts.push(typeof r === 'string' ? r : JSON.stringify(r ?? ''));
      return r;
    },
    text: () => parts.join('\n'),
  };
}
