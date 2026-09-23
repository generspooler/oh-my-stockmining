// 阶段 2 · 粗筛（SYSTEM_DEFINITION §3 新架构）。
// A股 6 批（中高股息横切 + 5 行业大类）、美股 5 批（纯行业），每批一次模型调用，
// 模型在批内横向比较挑出「像被错杀的好公司」。
// 机械层在这里**不做任何质量判断**，只负责把信息渲染成模型好读的表。
import { complete, extractJson, llmReady } from './llm.js';
import { groupIntoBatches, DIVIDEND_BUCKET } from './classify.js';
import { SCREENING, NARRATIVE } from './config.js';

const SYS = `你是深耕全球资本市场多年的资深价值投资分析师。

任务：从下面这批同类行业的股票中，挑出**可能被市场错杀的优质企业**。

你在找的是这样的标的：
- 生意本身是好生意，但被短期问题打压——一次性事件、周期底部、情绪杀、强制卖出
- 关键是区分「便宜」和「该便宜」。纯粹便宜的烂公司是价值陷阱，不要

判断时请重点看：
- **跌幅与基本面的背离**：股价跌了很多，但营收、利润率、现金流没有同步崩坏
- **估值相对同业的位置**：同一张表里就是它的同业，直接横向比
- **资产负债表能否扛过调整期**：负债率、利息保障、现金流
- **盈利的质量与持续性**：ROE 的水平与稳定性（注意看 ROE 当期 vs 5年中位数的差距）

数据说明：
- 所有数字由代码从交易所与财报接口计算得出，可以直接引用
- 跌幅只有三个尺度：60日、年初至今、距52周高点。**全都不超过 12 个月**。
  更早开始下跌的公司（危机已持续一年以上）这几栏看不出来，
  这类要靠「估值已经很低但基本面尚可」来识别，请特别留意
- F-Score 是财务改善程度（9分制），不是绝对质量。处在一次性冲击中的好公司
  F-Score 天然偏低，**不要因为 F-Score 低就排除**
- 「—」表示该字段取不到，不代表数值差。表末会列出已知的字段缺口

只输出 JSON：
{
  "picks": [
    {
      "code": "代码",
      "name": "名称",
      "why": "为什么值得深看，两句话",
      "guess": "初步归因猜测：周期性底部/一次性事件冲击/流动性情绪杀/治理折价/其他",
      "checkNext": "细筛时最该验证的一件事"
    }
  ],
  "note": "本批整体的一句话观察"
}`;

// 中高股息批专用。这批是按股息率横切出来的，与行业批的判断范式不同：
// 主要风险不是「便宜但该便宜」，而是「股息率高是因为股价崩了 / 派息不可持续」。
// 实测 A股 股息率降序榜首长这样：荣晟环保 15.0% / 达仁堂 14.0% / 南山铝业 13.8% /
// 汇洁股份 11.0%——这不是一份价值股名单，所以防陷阱的话必须写在提示词里。
const SYS_DIVIDEND = `你是深耕全球资本市场多年的资深价值投资分析师。

任务：从下面这批**中高股息**标的中，挑出**股息可持续、且当前价格提供足够安全边际**的优质企业。

**关于股息率，先记住这一条：股息率的分母是已经跌下来的股价。**
股价腰斩会让股息率自动翻倍。所以高股息率**本身不是买入理由**，它既可能是
「好公司被错杀，派息不变而价格下跌」，也可能是「基本面崩坏前的最后一次高派息」。
你的核心工作就是区分这两者。

判断时请重点看：
- **派息的可持续性**：累计 FCF/净利润能否覆盖分红？负债率是否在上升？
  利息保障倍数是否充足？靠借钱或变卖资产维持的分红必然中断
- **盈利的稳定性**：ROE 当期 vs 5年中位数。当期显著高于中位数，说明现在是景气高点，
  按高点利润派出的股息不可外推
- **是不是一次性特别分红**：股息率为 TTM 静态口径，大额特别分红会把它一次性抬高，
  次年即回落。营收/利润规模与分红体量明显不匹配的要警惕
- **生意本身是否在衰退**：高股息常见于低增长成熟行业，这没问题；
  但「高派息 + 营收持续萎缩」是在清算式地把公司分掉，不是价值
- **估值是否真的便宜**：高股息不等于低估值。PE/PB 仍要看

**本批按股息率横切，跨行业混编，同业可比性弱于其他批。**
表格已按行业聚合排序，请**只在行业相同或相邻的行之间做横向比较**，
不要拿银行的负债率去比化工，也不要拿公用事业的增速去比消费。

数据说明与其他批一致：
- 所有数字由代码从交易所与财报接口计算得出，可以直接引用
- 跌幅只有 60日、年初至今、距52周高点三个尺度，**全都不超过 12 个月**。
  更早开始下跌的公司这几栏看不出来，要靠「估值已经很低但基本面尚可」识别
- F-Score 是财务改善程度（9分制），不是绝对质量。处在一次性冲击中的好公司
  F-Score 天然偏低，**不要因为 F-Score 低就排除**
- 「—」表示该字段取不到，不代表数值差。表末会列出已知的字段缺口

只输出 JSON：
{
  "picks": [
    {
      "code": "代码",
      "name": "名称",
      "why": "为什么值得深看，两句话。必须说明你凭什么认为这个股息是可持续的",
      "guess": "初步归因猜测：周期性底部/一次性事件冲击/流动性情绪杀/治理折价/其他",
      "checkNext": "细筛时最该验证的一件事"
    }
  ],
  "note": "本批整体的一句话观察"
}`;

const f1 = (v, d = 1) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d));
const pc = (v, d = 0) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
const cap = (v) => (v == null ? '—' : v >= 1e12 ? (v / 1e12).toFixed(1) + 'T' : v >= 1e8 ? (v / 1e8).toFixed(0) + '亿' : (v / 1e6).toFixed(0) + 'M');

/** 渲染成模型好读的定宽表。一行一只，字段顺序按判断重要性排列。 */
export function renderBatch(rows, market) {
  const head = market === 'cn'
    ? '代码      名称           市值    现价   距52周高  60日   年初至今   PE     PB   股息率   ROE  ROE5年中位  ROIC  毛利率  负债率  利息保障  F  营收CAGR  FCF/净利'
    : '代码      名称           市值    现价   距52周高  60日   年初至今   PE     PB   股息率   ROE  ROE5年中位  毛利率  负债率  F  营收CAGR  FCF/净利';
  const lines = [head, '─'.repeat(head.length)];
  for (const r of rows) {
    const base = [
      String(r.code).padEnd(9),
      String(r.name || '').slice(0, 12).padEnd(13),
      cap(r.marketCap).padStart(7),
      f1(r.price, 2).padStart(8),
      pc(r.drawdown52).padStart(8),
      (r.chg60d == null ? '—' : f1(r.chg60d) + '%').padStart(7),
      (r.chgYtd == null ? '—' : f1(r.chgYtd) + '%').padStart(8),
      f1(r.pe).padStart(7), f1(r.pb, 2).padStart(6),
      // f133 已是百分数原值，不再 ×100
      (r.dividendYield == null ? '—' : f1(r.dividendYield, 2) + '%').padStart(8),
      f1(r.roe).padStart(6), f1(r.roeMedian5).padStart(10),
    ];
    const cn = [f1(r.roic).padStart(6), f1(r.grossMargin).padStart(7), f1(r.debtRatio).padStart(7),
      f1(r.interestCoverage).padStart(8)];
    const tail = [String(r.fScore ?? '—').padStart(3),
      (r.revenueCagr == null ? '—' : pc(r.revenueCagr)).padStart(9),
      f1(r.cumFcfToProfit, 2).padStart(9)];
    lines.push([...base, ...(market === 'cn' ? cn : [f1(r.grossMargin).padStart(7), f1(r.debtRatio).padStart(7)]), ...tail].join(''));
  }
  return lines.join('\n');
}

/**
 * 单批粗筛。返回 { ok, picks[], note, model, truncated }。
 * 行数超上限时按「跌幅 + 低估值」预排序截断——这是容量限制而非质量判断，会如实告知模型。
 */
export async function screenBatch(bucket, rows, market, { caveats = [], onEvent, maxPicks: capOverride, label } = {}) {
  if (!llmReady()) return { ok: false, reason: '缺少模型凭据', bucket };
  if (!rows.length) return { ok: true, bucket, picks: [], note: '本批无标的' };

  const maxPicks = capOverride ?? SCREENING.batchPicks[market]?.[bucket] ?? SCREENING.defaultPicks;
  const isDiv = bucket === DIVIDEND_BUCKET;
  const use = rows, truncated = 0;
  const table = renderBatch(use, market);
  const notes = [
    isDiv
      ? `批次：${label || bucket}（股息率 ≥ ${SCREENING.dividendYieldMin}% 横切全行业）｜本批 ${use.length} 只｜已按行业聚合排序`
      : `行业大类：${label || bucket}｜本批 ${use.length} 只`,
    `市场：${market === 'cn' ? 'A股' : '美股'}`,
    caveats.length ? `\n已知字段缺口：\n${caveats.map((c) => '- ' + c).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `${notes}\n\n${table}\n\n从本批中挑出最多 ${maxPicks} 只。宁可少挑，不要为凑数而挑。`;

  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    try {
      const r = await complete({
        system: isDiv ? SYS_DIVIDEND : SYS, messages: [{ role: 'user', content: prompt }],
        maxTokens: NARRATIVE.maxTokens,
        onFallback: (f, t, why) => onEvent?.({ type: 'fallback', bucket, from: f, to: t, why }),
      });
      const json = extractJson(r.text);
      if (!json?.picks) continue;
      const known = new Map(use.map((x) => [String(x.code).toUpperCase(), x]));
      const picks = json.picks
        .filter((p) => known.has(String(p.code).toUpperCase()))
        .slice(0, maxPicks)
        .map((p) => ({ ...p, row: known.get(String(p.code).toUpperCase()) }));
      return { ok: true, bucket, picks, note: json.note, model: r.model, truncated, scanned: use.length };
    } catch (e) {
      onEvent?.({ type: 'error', bucket, message: e.message });
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, bucket, reason: e.message };
    }
  }
  return { ok: false, bucket, reason: 'JSON 解析连续失败' };
}

/** 批内排序：股息批按「行业聚合 + 行业内市值降序」，保住跨行业混编下的横向可比性；
 *  行业批本就同业，按市值降序即可。 */
const orderRows = (bucket, rows) => {
  const byCap = (x, y) => (y.marketCap || 0) - (x.marketCap || 0);
  if (bucket !== DIVIDEND_BUCKET) return [...rows].sort(byCap);
  return [...rows].sort((x, y) => {
    const a = x.industry || '未分类', b = y.industry || '未分类';
    return a === b ? byCap(x, y) : (a < b ? -1 : 1);
  });
};

/**
 * 粗筛。A股 6 批（中高股息 + 5 行业大类）、美股 5 批；
 * 超过单批行数上限的批**再切分成多次调用**，
 * 而不是截断丢弃标的——被丢掉的可能正是要找的错杀标的。
 * 切分后每片的入选上限按片数均摊（至少 3），合计不超过该批的上限。
 */
export async function coarseScreen(rows, market, { caveats = [], onEvent, onProgress } = {}) {
  const buckets = groupIntoBatches(rows, market, { dividendYieldMin: SCREENING.dividendYieldMin });
  const limit = SCREENING.maxRowsPerBatch;

  // 切片：按批内既定顺序均分，让每片内部可比
  const slices = [];
  for (const b of buckets) {
    if (!b.rows.length) { slices.push({ ...b, part: 1, parts: 1 }); continue; }
    const n = Math.ceil(b.rows.length / limit);
    const sorted = orderRows(b.bucket, b.rows);
    const per = Math.ceil(sorted.length / n);
    for (let i = 0; i < n; i++) {
      slices.push({ bucket: b.bucket, rows: sorted.slice(i * per, (i + 1) * per), part: i + 1, parts: n });
    }
  }

  const results = [];
  let done = 0;
  await Promise.all(slices.map(async (s) => {
    const cap = Math.max(3, Math.ceil((SCREENING.batchPicks[market]?.[s.bucket] ?? SCREENING.defaultPicks) / s.parts));
    const label = s.parts > 1 ? `${s.bucket} ${s.part}/${s.parts}` : s.bucket;
    const r = await screenBatch(s.bucket, s.rows, market, { caveats, onEvent, maxPicks: cap, label });
    results.push({ ...r, label, part: s.part, parts: s.parts });
    onProgress?.(++done, slices.length, label);
  }));
  results.sort((a, b) => (a.label < b.label ? -1 : 1));
  const picks = results.flatMap((r) => r.picks || []);
  return { results, picks, calls: slices.length };
}
