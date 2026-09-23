// 财报与公告**正文**（v0.7.1 新增数据源）。
//
// 为什么需要它：细筛此前给模型的定性信息实质为零——茅台整份档案 1430 字符，
// 半年报就躺在公告列表里却只有标题；美股新闻实测抓 30 条滤 30 条 = 0 条。
// 模型被问「这个便宜是错杀还是陷阱」，手上却只有估值与财务比率。
// 本模块是补这个洞的唯一一步。
//
// 核心约束：**整篇不可能交给模型，必须分节抽取**。实测规模：
//   茅台 2026 半年报 = 44 页 × 5000 字 ≈ 22 万字
//   AAPL 2025 10-K   = 主文档 1.52MB HTML，去标签后 23.3 万字符
// 而单次工具返回上限是 NARRATIVE.tools.maxResultChars（6000）。
//
// 分节抽取是**启发式**的，两边都要对付同一个陷阱：目录里也有章节名。
//   A股：第 1 页（目录）同时出现「管理层讨论与分析」与第三/四/五节，
//        正文实际在第 2–4 页 → 跳过目录页命中。
//   美股：目录那一簇 Item 标记全挤在 500 字符内（19824/20154/20257/20328），
//        正文 `Item 7.` 在 121704 → 靠「簇」识别目录并排除。
// 抽取失败时返回明确的「无法定位」与已尝试的标记，**绝不返回猜的段落**——
// 返回错段落比返回空更糟（§6.5 的同一取向）。
import { fetchJson, fetchText, cached, SEC_UA } from '../util.js';
import { CACHE_TTL } from '../config.js';

const EM_H = { Referer: 'https://data.eastmoney.com/' };
const SEC_H = { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' };
const d10 = (s) => (s ? String(s).slice(0, 10) : null);
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();

// 单个文档的字节上限。AAPL 10-K 主文档 1.52MB，留足余量；
// 超限直接放弃并说明，不把几十 MB 拖进内存再慢慢失败。
const MAX_DOC_BYTES = 12 * 1024 * 1024;

// ── A股 · 公告列表（带 art_code 与栏目分类）──────────────────────

/**
 * A股公告列表。与 news.js 的 `announcements()` 不同：那个只取日期与标题，
 * 把 `art_code`（正文句柄）与 `columns[].column_name`（东财侧的现成分类，
 * 如「半年度报告全文」「年度报告」「业绩预告」）都丢掉了。这里全都保留。
 */
export async function annListCN(code, { size = 50 } = {}) {
  return cached(`annlist:v1:${code}:${size}`, CACHE_TTL.misc, async () => {
    const d = await fetchJson(
      `https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=${size}&page_index=1`
      + `&ann_type=A&client_source=web&stock_list=${code}&f_node=0&s_node=0`,
      { headers: EM_H, retries: 2 },
    ).catch(() => null);
    return (d?.data?.list || []).map((x) => ({
      artCode: x.art_code,
      date: d10(x.notice_date),
      title: strip(x.title).replace(/^[^:：]{1,14}[:：]/, ''),
      column: (x.columns || []).map((c) => c.column_name).filter(Boolean).join('/') || null,
    })).filter((x) => x.artCode && x.title);
  });
}

/**
 * 取某份公告的第 n 页正文。
 * 响应里的 `page_size` 其实是**总页数**（茅台半年报 = 44），不是每页条数；
 * 每页固定约 5000 字。`notice_content` 已是纯文本，常见情形无需解析 PDF
 * （PDF 在 `attach_url`，仅当正文为空时才有意义）。
 */
async function annPageCN(artCode, page) {
  return cached(`annpage:v1:${artCode}:${page}`, CACHE_TTL.statement, async () => {
    const d = await fetchJson(
      `https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=${artCode}`
      + `&client_source=web&page_index=${page}`,
      { headers: EM_H, retries: 2 },
    ).catch(() => null);
    if (!d?.data) return null;
    return {
      text: String(d.data.notice_content || ''),
      totalPages: Number(d.data.page_size) || 1,
      title: d.data.notice_title || null,
      attach: d.data.attach_url || null,
    };
  });
}

// A股 报告里章节标题的写法不统一，逐个尝试。
// 「管理层讨论与分析」是主板的标准写法，「经营情况的讨论与分析」是其正文小节标题，
// 创业板/科创板另有「管理层讨论与分析」的变体，一并列上。
// 标题写法**不统一，且差异很大**。实测：贵州茅台用「管理层讨论与分析」，
// 而中国平安（A+H 双重上市）整份中期报告里压根没有这个标题，用的是「经营情况」与
// 「风险管理」。所以这里列尽常见变体，并在全都落空时走 fallback（见下）。
const CN_SECTIONS = {
  mdna: {
    label: '管理层讨论与分析',
    start: [/管理层讨论[与及]分析/, /经营情况的讨论与分析/, /董事会报告/, /业务回顾/, /经营情况回顾/, /经营情况/],
    end: [/^\s*第[四五六]节/m, /第[四五六]节\s*(公司治理|重要事项|股份变动|环境与社会)/, /合并资产负债表/],
  },
  risk: {
    label: '风险因素',
    start: [/可能面对的风险/, /风险因素/, /面临的风险和应对措施/, /风险管理/, /主要风险/],
    end: [/^\s*第[四五六]节/m, /合并资产负债表/],
  },
};

/**
 * A股 分节抽取。按需翻页，命中章节后继续翻到章节结束即停——
 * 茅台半年报 MD&A 在第 2–4 页，不必为它拉满 44 页。
 *
 * 目录陷阱：第 1 页（目录）也含章节名。判据是「同一页里出现 ≥3 个不同章节标记」
 * ——目录会把所有节名列在一起，正文页不会。
 */
export async function filingSectionCN(code, { kind = 'mdna', maxPages = 12, prefer = null } = {}) {
  const spec = CN_SECTIONS[kind] || CN_SECTIONS.mdna;
  const list = await annListCN(code).catch(() => []);
  if (!list.length) return { ok: false, reason: '公告列表不可得' };

  // 优先取年报/半年报全文；prefer 可指定关键词（如「年度报告」）
  const pick = list.find((x) => (prefer ? new RegExp(prefer).test(x.title) || new RegExp(prefer).test(x.column || '') : false))
    || list.find((x) => /年度报告全文|半年度报告全文/.test(x.column || ''))
    || list.find((x) => /(^|[^季])(年度报告|半年度报告)$/.test(x.title))
    || null;
  if (!pick) {
    return {
      ok: false, reason: '最近 50 条公告里没有年报/半年报全文',
      available: list.slice(0, 12).map((x) => `${x.date} ${x.title}`),
    };
  }

  const isToc = (t) => [/第一节/, /第二节/, /第三节/, /第四节/, /第五节/, /第六节/]
    .filter((re) => re.test(t)).length >= 3;

  let buf = '', started = false, total = null, scanned = 0;
  for (let p = 1; p <= maxPages; p++) {
    const page = await annPageCN(pick.artCode, p);
    if (!page) break;
    total = page.totalPages;
    scanned = p;
    const t = page.text;
    if (!started) {
      if (isToc(t)) continue;                                   // 目录页，跳过
      const hit = spec.start.map((re) => t.search(re)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (hit == null) { if (total && p >= total) break; continue; }
      started = true;
      buf = t.slice(hit);
    } else {
      buf += t;
    }
    // 章节结束标记
    const endAt = spec.end.map((re) => buf.search(re)).filter((i) => i > 200).sort((a, b) => a - b)[0];
    if (endAt != null) { buf = buf.slice(0, endAt); break; }
    if (total && p >= total) break;
  }

  // 定位失败时的降级：返回报告**正文开头**（跳过封面与目录页）。
  // A股 半年报/年报的正文开头通常就是公司与经营概况，对判断「错杀还是陷阱」仍有用。
  // 这**不违背「绝不返回猜的段落」**——那条针对的是「把错章节冒充对章节」；
  // 这里返回的内容被明确标注成「不是章节抽取结果」，由模型自己判断可用性。
  if (!started) {
    const pages = [];
    for (let p = 1; p <= Math.min(6, total || 6); p++) {
      const page = await annPageCN(pick.artCode, p);
      if (!page?.text) continue;
      if (isToc(page.text)) continue;
      pages.push(page.text);
      if (pages.length >= 3) break;
    }
    if (!pages.length) {
      return {
        ok: false, kind, label: spec.label,
        reason: `在《${pick.title}》前 ${scanned} 页里未定位到「${spec.label}」章节，且正文也取不到`,
        doc: pick.title, date: pick.date, totalPages: total,
      };
    }
    return {
      ok: true, kind, label: `${spec.label}（未定位到该章节，降级为报告正文开头）`,
      fallback: true,
      doc: pick.title, date: pick.date, totalPages: total, pagesScanned: scanned,
      text: pages.join('').replace(/\s+/g, ' ').trim(),
    };
  }
  return {
    ok: true, kind, label: spec.label, doc: pick.title, date: pick.date,
    text: buf.replace(/\s+/g, ' ').trim(), totalPages: total, pagesScanned: scanned,
  };
}

// ── 美股 · SEC 申报文件 ─────────────────────────────────────────

/**
 * ticker → CIK。sec.js 的 cikMap 是同一份表，这里复用它的缓存键。
 * 代码写法要归一：SEC 用连字符（`BRK-B`），东财与自选池用点（`BRK.B`），
 * 不归一会让伯克希尔这类双层股票直接取不到 CIK。
 */
async function cik(ticker) {
  const m = await cached('sec:cikmap', 7 * 24 * 3600e3, async () => {
    const d = await fetchJson('https://www.sec.gov/files/company_tickers.json', { headers: SEC_H, retries: 2 });
    const out = {};
    for (const k of Object.keys(d || {})) {
      const r = d[k];
      if (r?.ticker) out[String(r.ticker).toUpperCase()] = String(r.cik_str).padStart(10, '0');
    }
    return out;
  }).catch(() => null);
  if (!m) return null;
  const t = String(ticker).toUpperCase();
  return m[t] || m[t.replace(/[._]/g, '-')] || m[t.replace(/[-_]/g, '.')] || null;
}

/**
 * 最近一份指定表单的索引。
 * `filings.recent` 是并行数组（form / filingDate / accessionNumber / primaryDocument 等），
 * 只覆盖最近约 1000 份；更早的在 `filings.files[]` 分片里，本模块不追（细筛只关心最近的）。
 */
export async function usFilingIndex(ticker, { form = '10-K' } = {}) {
  const id = await cik(ticker);
  if (!id) return { ok: false, reason: `SEC 没有 ${ticker} 的 CIK 映射` };
  const sub = await cached(`sec:sub:v1:${id}`, CACHE_TTL.statement,
    () => fetchJson(`https://data.sec.gov/submissions/CIK${id}.json`, { headers: SEC_H, retries: 2 })).catch(() => null);
  const f = sub?.filings?.recent;
  if (!f?.form?.length) return { ok: false, reason: 'SEC submissions 不可得' };
  const i = f.form.findIndex((x) => x === form);
  if (i < 0) {
    return { ok: false, reason: `最近申报里没有 ${form}`, forms: [...new Set(f.form)].slice(0, 12) };
  }
  const acc = String(f.accessionNumber[i]).replace(/-/g, '');
  return {
    ok: true, form, filingDate: f.filingDate[i], reportDate: f.reportDate?.[i] || null,
    accession: f.accessionNumber[i],
    url: `https://www.sec.gov/Archives/edgar/data/${Number(id)}/${acc}/${f.primaryDocument[i]}`,
  };
}

/** 主文档 → 纯文本。内联 XBRL 的 HTML 很大（AAPL 1.52MB），去标签后才好定位章节。 */
async function usFilingText(url) {
  // v2：行内标签改为删成空串（见下方注释）。解析规则一改就必须换键——
  // 否则旧条目会在整个 TTL 内冒充新口径（本仓库在字段映射上踩过两次）。
  return cached(`sec:doc:v2:${url}`, CACHE_TTL.statement, async () => {
    const html = await fetchText(url, { headers: SEC_H, retries: 1, timeout: 60000 });
    if (html.length > MAX_DOC_BYTES) return { ok: false, reason: `主文档过大（${(html.length / 1e6).toFixed(1)}MB）` };
    const text = html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      // 行内标签必须删成**空串**，不能换成空格：内联 XBRL 常把首字母单独包一层
      // （`<span>R</span>isk`），换成空格会切断单词 → ORCL 的真标题变成
      // 「Item 1A. R isk Factors」，章节名正则直接匹配不上、整节抽取失败。
      .replace(/<\/?(span|b|i|u|em|strong|font|a|sub|sup|small|mark)\b[^>]*>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: true, text };
  });
}

// 每个 Item 的**章节名**。这是区分「真标题」与「交叉引用」的关键判据：
// 真标题后面紧跟章节名（`Item 7. Management s Discussion and Analysis…`），
// 交叉引用后面跟的是 `of this Form 10-K under the heading…`。
// 结束标记同样要求是真标题——否则 MD&A 会被一句「Item 8 of this Form 10-K」提前截断。
// 正则必须**吃掉完整标题**，不能只匹配前缀：xref 判据要紧贴标题末尾，
// 而 CI 的交叉引用是「Item 7 <完整标题> of this Form 10-K」——
// 前缀匹配会让切片落在标题中间（"and Analysis of…"），连接词就贴不上了。
// 故可选尾部一律写成贪婪可选组。
const US_TITLES = {
  1: /^\s*business\b/i,
  '1A': /^\s*risk\s+factors/i,
  '1B': /^\s*unresolved\s+staff\s+comments/i,
  '1C': /^\s*cybersecurity/i,
  2: /^\s*propert(y|ies)/i,
  3: /^\s*legal\s+proceedings/i,
  4: /^\s*mine\s+safety\s+disclosures/i,
  5: /^\s*market\s+for\s+registrant\s*.{0,3}s?[^.]{0,120}/i,
  6: /^\s*(\[?\s*reserved\s*\]?|selected\s+financial\s+data)/i,
  7: /^\s*management\s*.{0,3}s?\s+discussion\s+and\s+analysis(\s+of\s+financial\s+condition(\s+and\s+results\s+of\s+operations)?)?/i,
  '7A': /^\s*quantitative\s+and\s+qualitative\s+disclosures(\s+about\s+market\s+risk)?/i,
  8: /^\s*financial\s+statements\s+and\s+supplementary\s+data/i,
  9: /^\s*changes\s+in\s+and\s+disagreements\s+with\s+accountants[^.]{0,90}/i,
  '9A': /^\s*controls\s+and\s+procedures/i,
};

const US_ITEMS = {
  business: { item: '1', label: 'Item 1 Business', next: ['1A'] },
  risk: { item: '1A', label: 'Item 1A Risk Factors', next: ['1B', '1C', '2'] },
  mdna: { item: '7', label: "Item 7 Management's Discussion and Analysis", next: ['7A', '8'] },
  marketRisk: { item: '7A', label: 'Item 7A Quantitative and Qualitative Disclosures', next: ['8'] },
};

// 交叉引用的连接词。**必须在章节名之后**判断，不能只看编号紧后的那几十字符：
// 实测 CI 的 `Item 7 Management's Discussion and Analysis of Financial Condition and
// Results of Operations of this Form 10-K, and as described…` 把完整章节名也写全了，
// ORCL 是 `Item 1A Risk Factors included elsewhere in this Annual Report.`
// 反过来，真章节的正文开头**也会**提到别的章节（AAPL 真 MD&A 开头就有
// 「…included in Part II, Item 8 of this Form 10-K」），所以判据必须紧贴标题末尾，
// 只看紧随其后的连接词，否则会把真标题误杀。
// `of our` / `within this` 是 KLAC 与 ORCL 实测用的说法，漏了它们就会把
// 「Item 7 <完整标题> in this Annual Report on Form 10-K」当成真标题。
const XREF_AFTER_TITLE = /^[\s,.:；;)]*(of\s+(th(is|e)|our)\b|in\s+th(is|e)\b|within\s+th(is|e)\b|included\s+(elsewhere|in)\b|as\s+(set\s+forth|described|discussed)\b|in\s+Part\s+[IV]+\b|see\s+\b|refer\s+to\b|under\s+the\s+heading\b|above\b|below\b)/i;
// 未找到结束标记时的封顶。切到文末会产出几十万字符（ORCL 实测 36 万），
// 既浪费缓存又让 chars 这个数字失去意义。
const UNBOUNDED_CAP = 60000;
// 合理性上限。真实章节再长也到不了这个量级：实测正常区间是
// MD&A 1.8~4.4 万（AAPL/UNH/NVDA/LULU）、Risk Factors 6.7 万（AAPL/UNH）。
// 抽出 25 万字符必然是起点选错、一路吃到了财务报表。
// 这种情况返回「无法定位」而不是那一大坨——返回错段落比返回空更糟。
const SANE_MAX = 150000;
const itemRe = (n) => new RegExp(`Item\\s+${String(n).replace('.', '\\.')}[\\.\\s:—-]`, 'gi');

/**
 * 美股章节抽取（纯函数，可测）。三重判据，缺一个都会抽错：
 *
 *   1. **排除交叉引用**：标记后紧跟 `of this Form` / `of the Company's` 的不是标题。
 *      实测教训：只按「跨度最长」选，AAPL 的 MD&A 会被抽成
 *      `Item 7 of the Company s Annual Report on Form 10-K for the fiscal year ended…`。
 *   2. **章节名必须匹配**：真标题后面紧跟章节名。
 *   3. **排除目录簇**：目录里的条目**也带章节名**（目录的 `Item 7.` 后面同样跟
 *      `Management s Discussion and Analysis`），所以判据 2 分不开目录与正文，
 *      必须靠「多个不同 Item 标记挤在一小段里」这个目录独有的形态。
 *
 * 三条都过之后，AAPL 的 Item 7 候选只剩 117716 这一个真起点，
 * 结束标记落在 Item 7A 的真标题 135697，得到约 1.8 万字符的 MD&A。
 */
export function extractItemUS(text, kind = 'mdna') {
  const spec = US_ITEMS[kind];
  if (!spec) return { ok: false, reason: `未知章节 ${kind}` };
  const src = String(text || '');
  const all = Object.keys(US_TITLES);

  const marks = [];
  for (const n of all) {
    for (const m of src.matchAll(itemRe(n))) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
      const tm = US_TITLES[n].exec(after);
      marks.push({
        n, at: m.index,
        titled: !!tm,
        // 章节名之后紧跟连接词 → 这是交叉引用，不是标题
        xref: tm ? XREF_AFTER_TITLE.test(after.slice(tm[0].length)) : false,
      });
    }
  }
  marks.sort((a, b) => a.at - b.at);
  if (!marks.length) return { ok: false, reason: '全文未见任何 Item 标记（可能不是标准 10-K/10-Q 排版）' };

  // 目录簇：以每个标记为起点向后 TOC_WIN 字符，含 ≥4 个不同编号即判为目录段。
  //
  // 窗口宽度是实测调出来的，取 3000 会把**正文**也判成目录：AAPL 的
  // Item 4「Not applicable」与 Item 6「[Reserved]」都极短，正文里 Item 5/6/7/8
  // 的真标题挤在 2946 字符内（115006→117952），于是 MD&A 的真起点 117716 被排除，
  // Risk 的结束标记 Item 1B/1C（106266/106307）也被排除、抽到文末 18 万字符。
  // 真目录密度高一个量级——AAPL 目录 6 个条目只占 341 字符（19347→19688）。
  // 1500 把两者分得很开：目录 341 ✓ 命中，正文簇 2946 ✗ 不命中。
  const TOC_WIN = 1500;
  const tocRanges = [];
  for (let i = 0; i < marks.length; i++) {
    const win = marks.filter((x) => x.at >= marks[i].at && x.at < marks[i].at + TOC_WIN);
    if (new Set(win.map((x) => x.n)).size >= 4) tocRanges.push([marks[i].at, win[win.length - 1].at + 200]);
  }
  const inToc = (at) => tocRanges.some(([a, b]) => at >= a && at <= b);
  const isHeading = (x) => x.titled && !x.xref && !inToc(x.at);

  const cands = marks.filter((x) => String(x.n).toUpperCase() === spec.item.toUpperCase() && isHeading(x));
  if (!cands.length) {
    const seen = marks.filter((x) => String(x.n).toUpperCase() === spec.item.toUpperCase());
    return {
      ok: false,
      reason: `未定位到 ${spec.label} 的正文标题（该编号出现 ${seen.length} 次：`
        + `${seen.filter((x) => x.xref).length} 次是交叉引用、`
        + `${seen.filter((x) => inToc(x.at)).length} 次在目录、`
        + `${seen.filter((x) => !x.titled).length} 次后面没有章节名）`,
      tocRanges: tocRanges.length, totalMarks: marks.length,
    };
  }

  // 正文标题正常只剩一个。万一多个（少见的重复排版）：
  // **先看有没有结束标记**，有结束标记的才是真章节；都没有时再比长度。
  // 不能只按「跨度最长」——无界候选切到封顶值会稳赢真候选。
  let best = null;
  const all2 = [];
  for (const c of cands) {
    const ends = marks
      .filter((x) => x.at > c.at + 50 && spec.next.some((nn) => nn.toUpperCase() === String(x.n).toUpperCase()) && isHeading(x))
      .map((x) => x.at);
    const bounded = ends.length > 0;
    const end = bounded ? Math.min(...ends) : Math.min(src.length, c.at + UNBOUNDED_CAP);
    all2.push({ start: c.at, end, len: end - c.at, bounded });
  }
  // 选段规则，三条都是实测逼出来的：
  //   1. **有界优先**——找到真结束标记的才是真章节；
  //   2. 有界之中先滤掉长度不合理的（< MIN_PLAUSIBLE）：只按「靠后」选，
  //      BRK.B 会挑到一个 1414 字符的片段，MD&A 不可能这么短；
  //   3. 剩下的取**靠后**那个——正文总在目录与前文交叉引用之后，
  //      「靠后」比「最长」是更好的先验（最长会偏向一路吃到财务报表的错起点）。
  const MIN_PLAUSIBLE = 3000;
  const bounded = all2.filter((x) => x.bounded);
  const plausible = bounded.filter((x) => x.len >= MIN_PLAUSIBLE);
  const pickLast = (xs) => xs.reduce((m, x) => (!m || x.start > m.start ? x : m), null);
  best = pickLast(plausible)
    || bounded.reduce((m, x) => (!m || x.len > m.len ? x : m), null)
    || pickLast(all2);
  if (best.len < 400) {
    return { ok: false, reason: `定位到 ${spec.label} 但正文仅 ${best.len} 字符，判为残留而非正文` };
  }
  if (best.len > SANE_MAX) {
    return {
      ok: false,
      reason: `定位到 ${spec.label} 但抽出 ${best.len} 字符，远超该章节的合理量级`
        + `（正常 2~7 万），判为起点选错、一路吃到了后续章节，不返回内容`,
    };
  }
  return {
    ok: true, kind, label: spec.label, chars: best.len,
    // 找不到结束标记时如实标注：返回的内容可能混入后续章节，且已在 UNBOUNDED_CAP 处截断
    endUnbounded: best.bounded ? undefined : true,
    text: src.slice(best.start, best.end).trim(),
  };
}

/** 美股分节正文。form 默认 10-K，可传 10-Q。 */
export async function filingSectionUS(ticker, { kind = 'mdna', form = '10-K' } = {}) {
  const idx = await usFilingIndex(ticker, { form });
  if (!idx.ok) return idx;
  const doc = await usFilingText(idx.url).catch((e) => ({ ok: false, reason: e.message }));
  if (!doc.ok) return { ok: false, reason: doc.reason, doc: idx.form, date: idx.filingDate };
  const sec = extractItemUS(doc.text, kind);
  return { ...sec, doc: `${idx.form} (${idx.filingDate})`, date: idx.filingDate, url: idx.url };
}
