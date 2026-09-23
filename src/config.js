// 配置唯一入口。SYSTEM_DEFINITION.md §2–§3 的所有阈值都必须落在这里，不得散落在代码中。
// 每个阈值后附「依据」——为什么是这个数，而不只是定了什么。环境变量可覆盖。

const envNum = (k, d) => (process.env[k] != null && isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
const envStr = (k, d) => process.env[k] || d;
const envBool = (k, d) => (process.env[k] == null ? d : /^(1|true|yes|on)$/i.test(process.env[k]));

/** 漏斗与估值参数（§2–§3） */
export const SCREENING = {
  // ── 第 0 层 · 池子定义（§3.2）───────────────────────────────────
  pool: {
    cn: {
      excludeBeijing: envBool('MINE_CN_EXCLUDE_BJ', true),   // 北交所日均成交常在百万级，无建仓可行性
      excludeST: true,                                       // ST/*ST/退市风险：质量闸门本就会全部淘汰，提前剔除省算力
      minTurnover60d: envNum('MINE_CN_MIN_TURNOVER', 2e7),   // 2000 万元/日：低于此无法在不冲击价格下建仓
      minListedDays: 365,                                    // 次新股无历史估值分位，分位法失效
    },
    us: {
      exchanges: ['105', '106', '107'],                      // 东财 m: NASDAQ / NYSE / AMEX，排除 OTC
      minMarketCap: envNum('MINE_US_MIN_MCAP', 2e9),         // $20 亿：小于此流动性与信息披露质量都不足
      minTurnover60d: envNum('MINE_US_MIN_TURNOVER', 1e7),   // $1000 万/日
      // GICS 一级行业（东财 f100 直接给出）。金融与房地产需 FFO / P-TBV 专用口径，本版不适配
      excludeSectors: ['金融', '房地产'],
      minListedDays: 365,
    },
  },

  // ── 阶段 2 · 粗筛分批（新架构）────────────────────────────────
  // 模型在批内横向比较。各批入选上限**按市场分别设定**。
  //
  // v0.5：名额合计 50 → 30——自选组占 Top 一半后市场组只需 5 席，
  // 30 进 5 的筛选密度（6:1）已足够，多出的名额只增加阶段 3 补数量与耗时。
  // 批内配比不变，全部按 0.6 系数等比缩减：
  //
  // A股：6 批 = 中高股息（横切全行业）+ 5 个行业批。
  // 中高股息仍独占 50% 名额——A股传统深度价值集中在能持续派现的资产上。
  // 该批与行业批**互斥**：达标标的先被抽走，剩余的才按行业分。
  // 必然副作用：银行/高速/公用/交运多数 ≥ 阈值，会被整体抽进高股息批，
  // 原「其他」批基本被抽空——这正是「50% 给中高股息」想要的效果。
  // 保留已验证的判断：A股科技由 AI/半导体叙事驱动、估值普遍不低，不是价值投资的猎场
  // （实测总裁决把兆易/顺络/水晶/扬杰等全部排除）；消费与制造周期才是猎场。
  //
  // 美股：科技仍独占 50%。美股科技既有成长也有被错杀的成熟标的，异质性远高于 A 股。
  // 美股不做股息分流——GICS 金融与房地产（高股息主力）已在池子层排除，剩余标的
  // 股息率普遍偏低，横切出来的批规模不足以支撑横向比较。
  batchPicks: {
    cn: { 中高股息: 15, 消费: 4, '制造与周期': 4, 其他: 3, 医药: 2, 科技: 2 },  // 合计 30
    us: { 科技: 15, 消费: 4, 医药: 4, '制造与周期': 4, 其他: 3 },               // 合计 30
  },
  defaultPicks: 5,

  // ── 中高股息分流阈值（A股）────────────────────────────────────
  // 3.0%：10 年期国债当前约 1.7–1.8%，3% 提供 1.2pct 以上的确定性利差。
  // 实测 A股 股息率分布（东财 clist f133，全市场 5560 只降序抽样）：
  //   ≥3.1% → 约 500 只(前 9%) ｜ ≥2.2% → 约 800 只 ｜ ≥1.7% → 约 1100 只
  //   后 48% 的股票股息率 ≤ 0.35%（近一半 A股 基本不分红）
  // 取 3% 落在约 500 只，规模足够批内横向比较，又不至于被 2.x% 的平庸品种稀释。
  //
  // **这是分流阈值，不是池子闸门**。股息率是风格判断不是事实性限定，
  // 放进 inPool() 会系统性剔除「因一次性冲击而停发股息」的公司——
  // 那恰恰是粗筛提示词列在第一位的猎物类型。低股息标的照常进行业批。
  dividendYieldMin: envNum('MINE_CN_DIV_YIELD_MIN', 3.0),
  // 单批行数过多时按「跌幅 + 估值」预排序截断，避免超出上下文。
  // 这是**容量限制**不是质量判断——被截断的标的会记录数量并如实告知模型。
  // 单批行数上限。实测 1765 只（77k token 输入）在 maxTokens=64000 下可一次跑通，
  // 耗时 181s、入选质量良好，因此无需切分——保持「A股 6 批 / 美股 5 批 + 1 次裁决」。
  // 之前 1200 行失败是 token 预算（32000）被 reasoning 吃光所致，不是行数本身的问题。
  // 真正超限时才切片，切片会增加调用次数并如实播报。
  maxRowsPerBatch: envNum('MINE_MAX_ROWS_PER_BATCH', 2500),

  // ── 阶段 4 · 总裁决 ─────────────────────────────────────────
  topN: envNum('MINE_TOP_N', 10),

  // ── 自选池（SYSTEM_DEFINITION §3.2 自选池）────────────────────
  // 用户手动维护的长期跟踪名单，挖掘时跳过粗筛直通深度补数。
  // topN 是自选组席位上限：默认 Top 的一半，跟 MINE_TOP_N 联动
  // （MINE_TOP_N=8 时自选 4、市场 4）。软配额——自选组不足额时总榜
  // 如实缺额，不用市场票补位（用户决策 2026-09-22）；自选为空时
  // 市场组回到 topN（现状行为）。
  watch: {
    topN: envNum('MINE_WATCH_TOP_N', Math.floor(envNum('MINE_TOP_N', 10) / 2)),
    // 池子超过此数在网页提示（阶段3逐股补数，耗时随池子线性增加）。不硬拦。
    sizeHint: envNum('MINE_WATCH_SIZE_HINT', 10),
  },

  // ── 估值口径（§2.3）──────────────────────────────────────────
  valuation: {
    normYears: 7,              // 归一化窗口：覆盖一轮完整周期
    normYearsMin: 5,           // 不足 5 年不做归一化，标记并降置信度
    windowDays: 1250,          // 分位窗口 ≈ 5 年交易日
    minWindowDays: 750,        // < 3 年 → 标记「序列不足」并强制降置信度
    percentiles: [25, 50, 75], // 保守 / 中性 / 乐观
    outlierPct: 99,            // 剔除 > 99 分位的极端点
    // 周期股判定：满足任一即判为周期股，主倍数切换为 PB
    cyclicalCV: 0.5,           // 近 7 年营业利润率变异系数
    cyclicalRevSwing: 0.25,    // 或营收同比曾超 ±25%
  },

  // 档位阈值：P/V 比值（P=现价，V=中性值）。索引 0 最便宜
  tiers: [
    { name: '显著低估', max: 0.55 },
    { name: '低估', max: 0.70 },
    { name: '合理偏低', max: 0.85 },
    { name: '合理', max: 1.15 },
    { name: '合理偏高', max: 1.30 },
    { name: '高估', max: 1.50 },
    { name: '显著高估', max: Infinity },
  ],

  // 置信度四因子权重（§2.4）
  confidence: {
    weights: { seriesLength: 0.30, coverage: 0.25, viewAgreement: 0.25, dispersion: 0.20 },
    levels: [
      { name: '高', min: 85 }, { name: '中高', min: 70 }, { name: '中', min: 55 },
      { name: '中低', min: 40 }, { name: '低', min: 0 },
    ],
    dispersionGood: 2.0,   // 乐观/保守 ≤2.0 倍满分
    dispersionBad: 2.5,    // >2.5 倍显著扣分
  },

  // 多视角交叉校验（§2.2）
  views: {
    minAgreeForUndervalued: 3,   // 5 个视角中 ≥3 个同向才允许给「低估」及以上
  },

  // 数据覆盖率政策（§6.5）
  coverage: {
    criticalFields: ['revenue', 'operateProfit', 'netProfit', 'ocf', 'totalAssets', 'equity', 'shares', 'price', 'industry'],
    minNonCritical: 0.60,   // 非关键字段覆盖率 <60% → 强制降置信度一档
  },
};

/** 定性分析（LLM）配置 */
export const NARRATIVE = {
  baseUrl: envStr('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
  // harness 运行时用 claude（Anthropic Messages API 兼容）
  model: envStr('MINE_MODEL', 'glm-5.3-flash'),
  fallbacks: envStr('MINE_FALLBACK_MODELS', 'deepseek-V4.1-flash').split(',').map((s) => s.trim()).filter(Boolean),
  // glm-5.3-flash 是思考型模型，reasoning token 计入 max_tokens。
  // 实测归因提示词（system 850 + user 1001 字符）下 reasoning 就吃掉 3979 token，
  // 给 4000 会导致 text_tokens=0、stop_reason=max_tokens、正文为空。
  // 参考项目 my-stock-track 用 32000，这里对齐。
  // 思考型模型的 reasoning 与正文共用 max_tokens。输入越大思考越久：
  // 实测 1765 行的粗筛表让 reasoning 吃掉 31836/32000，正文一个字都吐不出来。
  maxTokens: envNum('MINE_MAX_TOKENS', 64000),
  // 单次调用的最低预算：低于此思考就可能吃光配额
  minTokens: 12000,
  // 无数据看门狗：参考项目实测 GLM 经代理可 ~150s 才吐首 token，给足余量避免误杀
  firstTokenTimeoutMs: envNum('MINE_FIRST_TOKEN_TIMEOUT_MS', 240000),
  // 两个 pass（§3.2 第 4 层）：归因逐只跑，裁决排序一次性处理全部候选。
  // 排序是横截面判断——要从 N 只里挑 8 只并满足行业集中度约束，模型必须同时看到全部候选，
  // 逐只调用根本排不出序。故裁决为单次调用而非 ×N。
  passes: ['attribution', 'verdict'],
  // 只有「压根解析不出 JSON」才重试；类别不匹配与数字存疑都改为接受后标注，
  // 不再因校验失败丢弃整份输出（调用数从 ~93 降到 31）。
  schemaRetries: 1,
  concurrency: envNum('MINE_LLM_CONCURRENCY', 3),
};

/** 缓存 TTL 分级（§6.3） */
export const CACHE_TTL = {
  quote: 15 * 60e3,        // 行情 15 分钟
  universe: 6 * 3600e3,    // 全市场列表 6 小时
  statement: 7 * 24 * 3600e3,  // 报表 7 天
  valuation: 24 * 3600e3,  // 估值序列 1 天
  kline: 12 * 3600e3,
  classify: 30 * 24 * 3600e3,  // 静态分类 30 天
  misc: 24 * 3600e3,       // 质押/增减持/解禁等
};

/** 并发与限流（§6.3） */
export const LIMITS = {
  emConcurrency: envNum('MINE_EM_CONCURRENCY', 6),
  secConcurrency: envNum('MINE_SEC_CONCURRENCY', 4),
  targetRuntimeMs: 15 * 60e3,   // 单次全市场挖掘目标耗时 < 15 分钟
};

export const PORT = envNum('PORT', 8788);
export const SHUTDOWN_GRACE_MS = envNum('SHUTDOWN_GRACE_MS', 180000);
