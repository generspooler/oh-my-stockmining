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
  // v0.6：名额合计 30 → 50（回到 v0.4 标定）。自选池挖掘独立成流水线后，
  // 市场榜的 10 席全归市场候选，30 进 10 的筛选密度只有 3:1，裁决无从挑拣；
  // 50 进 10（5:1）是本系统一直在跑的标定。代价是阶段 3 补数从 30 只回到 50 只。
  // 批内配比自始至终不变，目标批恒占 50%：
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
    cn: { 中高股息: 25, 消费: 7, '制造与周期': 7, 其他: 5, 医药: 3, 科技: 3 },  // 合计 50
    us: { 科技: 25, 消费: 7, 医药: 7, '制造与周期': 7, 其他: 4 },               // 合计 50
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
  // 耗时 181s、入选质量良好，因此无需切分——保持「A股 6 批 / 美股 5 批」。
  // 之前 1200 行失败是 token 预算（32000）被 reasoning 吃光所致，不是行数本身的问题。
  // 真正超限时才切片，切片会增加调用次数并如实播报。
  maxRowsPerBatch: envNum('MINE_MAX_ROWS_PER_BATCH', 2500),

  // ── 阶段 4 · 总裁决（三段式，§3.2 阶段 4）────────────────────
  // 榜单席位 = minN ~ topN（v0.9.0 用户决策 2026-09-26：至少 5、最多 10）。
  // 达标的按排序占席，最多 topN；达标不足 minN 时由「最接近达标」的补足到 minN，
  // 补位的逐只标注「未达标 · 机制补位」及差在哪——补位是机制要求，不是推荐。
  // 此前是「宁缺毋滥、如实少选」，实测 9 只自选池只给出 3 只，用户要的是可比较的最小名单。
  topN: envNum('MINE_TOP_N', 10),
  minN: envNum('MINE_MIN_N', 5),
  // 段 4a 点名上限 = topN + 这个余量。深挖要解决的是「谁进 Top N」的边界问题，
  // 给出比名额略多的余量即可。
  //
  // **这个数直接决定深挖预算**：预算 = NARRATIVE.tools.budgets.marketPerPick × 点名数。
  // 默认 10 + 4 = 14 只 × 每只 3 次 = 软上限 42 次取数，而单次返回上限 12000 字符
  // ——深挖那一段的对话最多能累积到几十万字符，且每轮都要重发。
  // 嫌贵就调小这个余量或 marketPerPick（两者都可用环境变量覆盖）。
  deepPickMargin: envNum('MINE_DEEP_PICK_MARGIN', 4),

  // ── 自选池挖掘（SYSTEM_DEFINITION §3.3）───────────────────────
  // v0.6 用户决策 2026-09-23：自选池与市场挖掘**彻底分开**，两条流水线、
  // 两个按钮、两张榜。自选票不再直通市场粗筛、不再占市场 Top 席位，
  // 分组配额（quotas/capByGroup）随之退役。
  //
  // 这里的 topN / minN 是**自选池自己那张榜**的席位，与市场榜的 SCREENING.topN 无关：
  // 榜内给完整分析，其余逐只给落选理由（三句话 + 关键数据），一只都不省略。
  // v0.9.0（用户决策 2026-09-26）：8 席上限、可为空 → 5~10 席，规则与市场榜一致。
  // 池子小于 minN 时下限自动降为池子大小（没有票可补）。
  watch: {
    topN: envNum('MINE_WATCH_TOP_N', 10),
    minN: envNum('MINE_WATCH_MIN_N', 5),
    // 池子超过此数在网页提示（逐股补数，耗时随池子线性增加）。不硬拦。
    sizeHint: envNum('MINE_WATCH_SIZE_HINT', 10),
  },

  // ── 多区间回撤口径（§2.6）────────────────────────────────────
  // 回撤与区间收益是「跌幅与基本面背离」这条判断标准的唯一数值输入，
  // 错了排序就错了。此前无定义，实现里四个缺陷（不复权 / 短序列静默降级 /
  // dd 与 ret 窗口不一致 / 按数组下标当月份）因而无人可依据。
  drawdown: {
    // 区间以**月**为单位。13周=3月、26周=6月、52周=12月、3年=36月、5年=60月。
    // 「n 个月 = n 个区间」，回撤与收益同窗口——此前 dd(12) 量 11 个月、ret(12) 量 12 个月。
    windows: { dd13w: 3, dd26w: 6, dd52w: 12, dd3y: 36, dd5y: 60 },
    // 序列起点固定，不随当天滚动——滚动的 beg 会让缓存键每天失效一次。
    // 20150101 给出约 141 个月点，足够 60 月窗口且留足余量。
    beg: '20150101',
    // 窗口内至少要有几个点才算数。只有起点合格但中间大面积缺失时，
    // 最高价会被少数点决定，回撤失真——这与「点数不足就置空」是同一条取向。
    minPointsPerWindow: 2,
    // 兜底顺位 3 的拆股检测：相邻月收盘比值接近整数倍即判为拆股伪影。
    //
    // 容差 15% **刻意偏向过度包含**，因为两类错误的代价极不对称：
    // 该检测只在「不复权兜底」这条已经降级的路径上跑，误报的后果是该区间置空（安全），
    // 漏报的后果是把一个错的跌幅喂给模型（正是本次要修的 bug）。
    //
    // 取值依据是实测的拆股当月真实漂移，比直觉大得多：
    //   KLAC 6:1 → 比值 6.37（月内另跌 6%）｜NVDA 10:1 → 8.87（月内另跌 11%）
    // 容差 6% 会把这两个都漏掉，因此必须放宽到 15%。
    // 已知代价：单月跌幅落在约 −33%~−55% 的标的会被保守判为拆股、该区间置空。
    // 在不复权兜底路径上这是可接受的——模型仍拿到估值与财务，且会被告知跌幅为何缺失。
    splitRatios: [2, 3, 4, 5, 6, 7, 8, 10, 15, 20],
    splitTolerance: 0.15,
  },

  // ── 估值口径（§2.3）──────────────────────────────────────────
  valuation: {
    normYears: 7,              // 归一化窗口：覆盖一轮完整周期
    normYearsMin: 5,           // 不足 5 年不做归一化，标记并降置信度
    windowDays: 1250,          // 分位窗口 ≈ 5 年交易日
    minWindowDays: 750,        // < 3 年 → 标记「序列不足」并强制降置信度
    percentiles: [25, 50, 75], // 保守 / 中性 / 乐观
    outlierPct: 99,            // 剔除 > 99 分位的极端点
    // 美股反算（v0.11.3）。拆股识别看「后复权 ÷ 不复权」的月间跳幅：分红每月最多几个百分点，
    // 最小的常见拆股是 3:2（1.5 倍），阈值取在两者之间
    splitJumpUp: 1.45,
    splitJumpDown: 0.69,
    // 股数 / 净资产快照超过这个天数不再使用（约 15 个月 = 一份年报 + 一个季度的余量）。
    // 实测 GOOGL 年报股数停在 FY2012、NEE 停在 FY2016，旧实现一直沿用
    staleSnapshotDays: 456,
    // 有效样本下限（v0.11.3）：按**有效点数**与**真实跨度**判定，不按窗口长度。
    // 此前 60 个月里只有 1 个有效 PE 也算「5 年分位」（MRVL 实盘 9/60）
    minValidYears: 3,
    // v0.10.0 删除周期股判定（cyclicalCV 0.5 / cyclicalRevSwing 0.25）。
    // 实测 A股 55 只非金融候选被判周期 35 只（64%），迈瑞、金山办公都在内；
    // 其中 25 只换口径后档位不同。股性是商业判断，交给模型（§2.3 步骤 3）。
    // 模型判「达标」时，所选锚的安全边际低于这个参考门槛就**标注**出来（v0.11.3）。
    // 门槛本身来自 valuation.requiredMos（按 F-Score 分档 20%/25%/30%，与单股共用）。
    // ⚠ 只标注、不改判：席位由模型排序、代码不替它排序（用户取向「减少机械规则」）
    lowMosSlack: 0.05,
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
  //
  // 模型名可以是**渠道 ID**（东财/ModelBest 网关注册的 id，如 GPT_bhlzrh）或裸模型名。
  // 风险不对称：裸名同样能调通（网关按模型名路由到某个渠道，实测 gpt-5.6-sol 可用），
  // 但渠道 ID 唯一确定一条渠道，模型名可能对应多个渠道、路由到哪个不由我们决定。
  // 因此默认写渠道 ID——自主可控优先于可读。
  model: envStr('MINE_MODEL', 'claude-opus-5-5'),
  // 降级链：主模型失败（空正文 / HTTP 错误 / 未声明协议）时依次换。
  // 必须写 []（而不是注释掉整行）——llm.js 顶层就解引用这个字段，
  // 缺字段会让 import 期直接崩在 `.filter`，报错还完全看不出是配置问题。
  fallbacks: envStr('MINE_FALLBACK_MODELS', '').split(',').map((s) => s.trim()).filter(Boolean),
  // 协议探测开关（§6.2）。网关每个渠道声明了它支持的协议：
  //   Anthropic 派 → /v1/messages
  //   OpenAI 派   → /v1/chat/completions
  // 本项目原本只会说 Anthropic，于是「支持 OPENAI_HTTP 的渠道」例如 GPT 系
  // 一律 400「该模型未声明支持 Anthropic Messages」，看起来像调用没触发，实为静默失败。
  // 现在两种协议都实现，默认探测；怀疑探测误判时用 MINE_PROTOCOL=anthropic|openai 钉死。
  protocol: envStr('MINE_PROTOCOL', 'auto'),
  // 参考项目 my-stock-track 用 32000，这里对齐。
  // 思考型模型的 reasoning 与正文共用 max_tokens。输入越大思考越久：
  // 实测 1765 行的粗筛表让 reasoning 吃掉 31836/32000，正文一个字都吐不出来。
  maxTokens: envNum('MINE_MAX_TOKENS', 100000),
  // 单次调用的最低预算：低于此思考就可能吃光配额
  minTokens: 12000,
  firstTokenTimeoutMs: envNum('MINE_FIRST_TOKEN_TIMEOUT_MS', 240000),
  // 单次调用总时长上限。看门狗只管「连接是否活着」，思考型模型持续吐 thinking
  // 会把它无限重置——实测一次自选裁决思考 15 分钟后正文为空。卡住要响亮失败。
  callTimeoutMs: envNum('MINE_CALL_TIMEOUT_MS', 20 * 60e3),
  // 自选池裁决单次最多处理多少只，超过即分批（v0.6.1）。
  // 思考 15 分钟后 stop_reason=end_turn、正文 0 字。15 只的输出量与市场裁决相当，
  // 是已知能稳定跑通的规模。
  watchBatchSize: envNum('MINE_WATCH_BATCH_SIZE', 15),
  // 两个 pass（§3.2 第 4 层）：归因逐只跑，裁决排序一次性处理全部候选。
  // 排序是横截面判断——要从 N 只里挑 8 只并满足行业集中度约束，模型必须同时看到全部候选，
  // 逐只调用根本排不出序。故裁决为单次调用而非 ×N。
  passes: ['attribution', 'verdict'],
  // 只有「压根解析不出 JSON」才重试；类别不匹配与数字存疑都改为接受后标注，
  // 不再因校验失败丢弃整份输出（调用数从 ~93 降到 31）。
  schemaRetries: 1,
  concurrency: envNum('MINE_LLM_CONCURRENCY', 3),

  // ── 上下文预算（v0.10.0，用户决策 2026-09-26）───────────────
  // 模型窗口 1M，但渠道侧的 system prompt / MCP / skills 要占一块，
  // 用户定的可用量是「至少 256k～500k」。取下沿 256k 作默认，按需用环境变量调到 500k。
  // 这是**单次调用的输入上限**（含工具循环累积的全部对话），不含输出（maxTokens 另计）。
  // 它替代了此前「单条工具返回 12000 字」这种按条数防御的写法：真正要防的是总量。
  context: {
    inputTokens: envNum('MINE_CONTEXT_TOKENS', 256000),
    // 工具循环里给最后一问（撤掉工具逼出结论）留的余量
    reserveTokens: envNum('MINE_CONTEXT_RESERVE', 16000),
  },

  // ── 工具循环（细筛取数能力）────────────────────────────────
  // 探针实测（.run/probe-tools.mjs）：本渠道 OpenAI 协议支持完整工具往返
  // （轮1 stop=tool_calls、轮2 回填 role:'tool' 后正常续写）；
  // Anthropic 协议在本渠道不可用——它只声明 OPENAI_HTTP/OPENAI_RESPONSE。
  tools: {
    // ── 预算：**总调用数为主闸、轮数为辅闸**（用户决策 2026-09-23）────
    // 只封轮数是不够的：一轮可以并行发多个调用，12 轮能变成 70+ 次取数。
    //
    // 软/硬两级。到软上限时**不掐断**，而是把「软预算已用尽，若你判断某只票的
    // 结论会因缺这份数据而错可继续，最多再 N 次」作为工具结果回给模型；
    // 越过硬上限才撤掉 tools 逼出结论。这落实「相信模型」——
    // 分配权在模型，代码只守边界，且边界是如实告知的而非静默的。
    softToolCalls: envNum('MINE_TOOL_SOFT_CALLS', 18),
    maxToolCalls: envNum('MINE_TOOL_MAX_CALLS', 26),
    maxRounds: envNum('MINE_TOOL_MAX_ROUNDS', 14),
    // 工具循环的**总**时长上限。NARRATIVE.callTimeoutMs 是 per-stream 的，
    // 多轮循环会拿到 N × 20 分钟，等于没有上限，必须另设一个总闸。
    loopTimeoutMs: envNum('MINE_TOOL_LOOP_TIMEOUT_MS', 30 * 60e3),
    // 单次工具返回的字符上限。v0.10.0：12000 → 60000。
    // 实测 MD&A 普遍 1.8~4.4 万字符（AAPL 1.8 万 / NVDA 3.4 万 / UNH 3.6 万 / LULU 4.4 万），
    // 12000 只够看「概述 + 经营结果」；60000 能拿到整章。总量不再靠这里防——
    // 由 NARRATIVE.context 的输入预算在工具循环里按剩余空间收口（llm.js fitToContext）。
    // 「77k token 输入只剩 164 token 给正文」那次教训是 maxTokens 被思考吃光，不是窗口不够。
    maxResultChars: envNum('MINE_TOOL_MAX_RESULT_CHARS', 60000),
    // 按入口分别设预算。单股是用户主动点名深挖一只，可以大方给；
    // 市场深挖那一段要摊给好几只，因此按「点名只数」动态放大而不是固定值。
    budgets: {
      watch: { soft: envNum('MINE_TOOL_WATCH_SOFT', 18), hard: envNum('MINE_TOOL_WATCH_HARD', 26) },
      single: { soft: envNum('MINE_TOOL_SINGLE_SOFT', 8), hard: envNum('MINE_TOOL_SINGLE_HARD', 12) },
      // 市场深挖：每只点名标的的取数配额，乘以点名数即为本段预算
      marketPerPick: envNum('MINE_TOOL_MARKET_PER_PICK', 3),
    },
  },

  // ── 联网研究员（v0.11.0，用户决策 2026-09-27）──────────────────
  // 结构化接口回答不了「年报之后发生了什么、为什么跌」：美股自选 44 只里 19 只有效新闻为 0，
  // 8-K 一条没有。所以由一个 Claude Code 无头会话（claude -p）替入围票上网查事件。
  // 分工：**数字只认结构化接口，联网只补事件与原因**。
  // 每轮只起**一个**会话覆盖全部入围票（用户：「每只起一个没有必要」），会话内允许开子代理并行。
  // 批内初筛与粗筛不联网（与工具作用域一致）。
  research: {
    // MINE_RESEARCH=0 关闭（离线跑、或 claude 命令不可用时）
    enabled: envStr('MINE_RESEARCH', '1') !== '0',
    bin: envStr('MINE_CLAUDE_BIN', 'claude'),
    // 用户指定 claude-opus-5-5。**必须显式传**：环境变量 ANTHROPIC_MODEL 可能指向别的模型
    //（实测为 deepseek），不传 --model 研究员会悄悄跟着它走
    model: envStr('MINE_RESEARCH_MODEL', 'claude-opus-5-5'),
    // 用户定的上限 20 分钟。到点即终止，已经交出的逐只结论照用
    timeoutMs: envNum('MINE_RESEARCH_TIMEOUT_MS', 20 * 60e3),
    // 单只结论里事件条数上限（防一只票刷屏；按重要性取前 N 条）
    maxEvents: envNum('MINE_RESEARCH_MAX_EVENTS', 8),
    // 允许研究员激活 agent-reach skill（用户决策 2026-09-27）。MINE_RESEARCH_AGENT_REACH=0 关闭；
    // 来源目录默认 ~/.claude/skills/agent-reach，可用 MINE_AGENT_REACH_DIR 指定。
    // 它路由表里的命令只放行白名单里的只读写法（research-guard.js），不是整个 skill 的全部能力
    agentReach: envStr('MINE_RESEARCH_AGENT_REACH', '1') !== '0',
    agentReachDir: envStr('MINE_AGENT_REACH_DIR', ''),
  },
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
