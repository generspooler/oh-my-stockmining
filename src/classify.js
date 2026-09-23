// 行业分类、估值路由、粗筛分批（SYSTEM_DEFINITION §2.3 / §3）。
// A股行业来自东财 f100（约 90 个细分行业），美股 f100 直接是 GICS 11 个一级行业。

/** 金融：利息支出是核心经营成本而非融资成本，归一化 EBIT 口径对其完全失效，必须走 ROE 路径。 */
const CN_FINANCIAL = /^(银行|证券|保险|多元金融|信托|租赁)/;
const US_FINANCIAL = /^(金融|房地产)$/;

/** 美股池排除的 GICS 一级行业（REIT 与金融需 FFO / P-TBV 专用口径，本版不适配）。 */
export const US_EXCLUDED_SECTORS = ['金融', '房地产'];

export function isFinancial(industry = '', market = 'cn') {
  if (!industry) return false;
  return market === 'us' ? US_FINANCIAL.test(industry) : CN_FINANCIAL.test(industry);
}

/** 主倍数路由（§2.3 步骤 3）。 */
export function multipleRoute({ industry, market, cyclical, normEps }) {
  if (isFinancial(industry, market)) {
    return { kind: 'financial', primary: 'pb', check: 'dividend', reason: '金融股：PB 分位为主' };
  }
  if (normEps == null || normEps <= 0) {
    return { kind: 'loss', primary: 'ps', check: 'pb', reason: '归一化 EPS ≤ 0：PS 分位为主，仅给保守档并降置信度' };
  }
  if (cyclical) {
    return { kind: 'cyclical', primary: 'pb', check: 'ps', reason: '周期股：底部 PE 失真，改用 PB 分位' };
  }
  return { kind: 'general', primary: 'pe', check: 'pb', reason: '一般工商企业：归一化 PE 分位为主' };
}

export const industryKey = (u) => u.industry || '未分类';

// ── 粗筛分批：按行业大类分 5 组 ───────────────────────────────
// 分批而非均分，是为了让模型在同业内横向比较（价值投资的基本功）。
// 批次大小不均衡可接受——同业可比性比批次均衡重要。
// 规则按东财实际行业名（f100）标定，非凭空猜测——
// 初版漏掉了「炼化及贸易」「油气开采Ⅱ」「电池」「乘用车」「航海装备Ⅱ」等，
// 导致「其他」堆积 1328 只。下面的关键词已逐个对照全量行业清单修正。
const CN_BUCKETS = [
  ['消费', /食品|饮料|白酒|啤酒|乳品|调味|家电|厨卫|纺织|服装|饰品|家居|商贸|零售|连锁|超市|百货|贸易|旅游|酒店|餐饮|教育|体育|社会服务|个护|化妆品|珠宝|农|林|牧|渔|养殖|种植|饲料|造纸|包装/],
  ['医药', /医药|制药|生物|医疗|器械|中药|原料药|疫苗|诊断|动物保健/],
  ['科技', /电子|半导体|集成电路|元件|光学|面板|消费电子|计算机|软件|IT|互联网|通信|通讯|传媒|游戏|广告|出版|影视|院线|电视|广播|数字媒体|人工智能|云/],
  ['制造与周期', /机械|设备|装备|电力设备|电机|电池|新能源|光伏|风电|储能|汽车|乘用车|商用车|摩托车|零部件|化工|化学|炼化|塑料|橡胶|钢|冶|焦炭|有色|金属|采掘|煤炭|石油|油气|石化|建材|水泥|玻璃|建筑|建设|房屋建设|装修|工程|国防|军工|兵装|船舶|航空|航天|航海|轨交/],
];
const US_BUCKETS = [
  ['消费', /^(日常消费品|非日常生活消费品)$/],
  ['医药', /^医疗保健$/],
  ['科技', /^(信息技术|通讯服务)$/],
  ['制造与周期', /^(工业|原材料|能源)$/],
];

/** 返回该标的所属的行业大类名。未命中归入「其他」。 */
export function sectorBucket(industry = '', market = 'cn') {
  const buckets = market === 'us' ? US_BUCKETS : CN_BUCKETS;
  for (const [name, re] of buckets) if (re.test(industry)) return name;
  return '其他';
}

export const BUCKET_NAMES = ['消费', '医药', '科技', '制造与周期', '其他'];

/** 横切全行业的股息批名。只用于 A股。 */
export const DIVIDEND_BUCKET = '中高股息';

/** 该市场的批次名清单，顺序固定（A股股息批排最前，名额最大）。 */
export const bucketNames = (market) =>
  market === 'cn' ? [DIVIDEND_BUCKET, ...BUCKET_NAMES] : [...BUCKET_NAMES];

/**
 * 是否够格进「中高股息」批。
 * null（取不到）与 0（不分红）都判否——但两者都照常进行业批，不会被丢掉。
 */
export const isHighDividend = (r, minYield) =>
  r?.dividendYield != null && isFinite(r.dividendYield) && r.dividendYield >= minYield;

/**
 * 分批。返回 [{ bucket, rows }]，顺序固定，空批保留（便于对齐配置）。
 *
 * A股是**两段式**：先按股息率横切出「中高股息」批，剩余的才按行业分。
 * 两者互斥——同一只不会既在股息批又在行业批，否则名额重复消耗、
 * 裁决层还会看到同一只的两份入选理由。
 *
 * 分流而不是过滤：没达标的标的一只都不少，只是走行业批那条路。
 * 美股不分流（金融地产这两个高股息主力已在池子层排除，横切剩不下多少）。
 */
export function groupIntoBatches(rows, market, { dividendYieldMin = Infinity } = {}) {
  const names = bucketNames(market);
  const map = new Map(names.map((n) => [n, []]));
  const carve = market === 'cn' && isFinite(dividendYieldMin);
  for (const r of rows) {
    if (carve && isHighDividend(r, dividendYieldMin)) map.get(DIVIDEND_BUCKET).push(r);
    else map.get(sectorBucket(r.industry, market)).push(r);
  }
  return names.map((bucket) => ({ bucket, rows: map.get(bucket) }));
}
