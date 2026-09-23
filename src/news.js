// 阶段 3 · 新闻与公告检索。
//
// 原计划用 agent-reach，实测不可行：当前仅 youtube/bilibili/rss/web 四个渠道可用，
// 财经最相关的 xueqiu 与 exa_search 均未配置；其子命令只有 setup/doctor/configure/
// skill/format/transcribe，不提供程序化搜索入口；web 后端 Jina Reader 实测 15s 超时。
//
// 改用东财两个免配置且可追溯的接口。关键实测结论：**必须用中文名检索**——
// 「UNH」仅 3 条噪音，「联合健康」195 条、「海底捞」565 条且高度相关。
// 东财 universe 对美股本就提供中文名，两市场通用。
import { fetchText, fetchJson, cached, pool } from './util.js';
import { CACHE_TTL, LIMITS } from './config.js';

const UA_H = { Referer: 'https://so.eastmoney.com/' };
const d10 = (s) => (s ? String(s).slice(0, 10) : null);
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();

/** 东财资讯搜索。返回带日期、标题、摘要的文章列表。 */
export async function searchNews(keyword, { size = 12 } = {}) {
  if (!keyword) return [];
  const param = encodeURIComponent(JSON.stringify({
    uid: '', keyword, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: size } },
  }));
  return cached(`news:${keyword}:${size}`, CACHE_TTL.misc, async () => {
    const txt = await fetchText(
      `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${param}`,
      { headers: UA_H, retries: 2, timeout: 15000 },
    ).catch(() => '');
    const m = String(txt).match(/^cb\((.*)\);?\s*$/s);
    if (!m) return [];
    let d; try { d = JSON.parse(m[1]); } catch { return []; }
    return (d?.result?.cmsArticleWebOld || []).map((x) => ({
      date: d10(x.date), title: strip(x.title), summary: strip(x.content).slice(0, 180),
      source: x.mediaName || null, url: x.url || null,
    })).filter((x) => x.title);
  });
}

/** A股个股公告（标题级，不拉全文——粗读足够，全文留给单股分析）。 */
export async function announcements(code, { size = 10 } = {}) {
  return cached(`ann:${code}:${size}`, CACHE_TTL.misc, async () => {
    const d = await fetchJson(
      `https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=${size}&page_index=1&ann_type=A&client_source=web&stock_list=${code}&f_node=0&s_node=0`,
      { headers: { Referer: 'https://data.eastmoney.com/' }, retries: 2 },
    ).catch(() => null);
    return (d?.data?.list || []).map((x) => ({
      date: d10(x.notice_date), title: strip(x.title).replace(/^[^:：]{1,14}[:：]/, ''),
    })).filter((x) => x.title);
  });
}

// 噪音过滤：东财资讯检索按全文匹配，实测噪音率极高——
//   「贵州茅台」12 条全是 ETF 持仓播报，无一条关于公司本身；
//   「联合健康」4 条里 3 条是「复星联合健康」（另一家公司）。
// 直接喂给模型会污染归因，因此做两道机械过滤。
const ETF_NOISE = /ETF|指数|成分股|权重股|基金|净流入|份额|板块异动|涨停板|龙虎榜|两市|大盘|北向资金|机构调研汇总/;

/** 标题里公司名被更长的机构名包住（复星联合健康 ⊃ 联合健康），说明说的是别人。 */
function isOtherEntity(title, kw) {
  const i = title.indexOf(kw);
  if (i < 0) return false;
  const before = title.slice(Math.max(0, i - 3), i);
  return /[一-龥]{2,}$/.test(before) && !/[，。、：；（(「《·\s]$/.test(before);
}

/** 相关性过滤：公司名要出现在标题里，且排除 ETF 播报与同名机构。 */
function relevant(items, kw) {
  const kept = items.filter((x) => {
    const t = x.title || '';
    if (!t.includes(kw)) return false;          // 只在正文提及的，多半是顺带点名
    if (ETF_NOISE.test(t)) return false;
    if (isOtherEntity(t, kw)) return false;
    return true;
  });
  return { kept, dropped: items.length - kept.length };
}

/**
 * 单只标的的新闻包。用中文名检索资讯 + A股补公告。
 * 过滤后仍可能有噪音，最终甄别交给模型。
 */
export async function newsFor(stock) {
  const kw = stock.name && /[一-龥]/.test(stock.name) ? stock.name : stock.code;
  const [raw, ann] = await Promise.all([
    searchNews(kw, { size: 30 }).catch(() => []),   // 多拉一些，过滤后才够用
    stock.market === 'cn' ? announcements(stock.code).catch(() => []) : Promise.resolve([]),
  ]);
  const { kept, dropped } = relevant(raw, kw);
  return { keyword: kw, news: kept, announcements: ann, fetched: raw.length, filtered: dropped };
}

/** 批量检索，受并发限制。 */
export async function fetchNews(stocks, { onProgress } = {}) {
  const out = new Map();
  await pool(stocks, Math.min(LIMITS.emConcurrency, 4), async (s) => {
    out.set(s.code, await newsFor(s).catch(() => ({ keyword: s.name, news: [], announcements: [] })));
  }, onProgress);
  return out;
}

/** 渲染成提示词片段。无内容时明确说明，避免模型把「没搜到」当成「没事发生」。 */
export function renderNews(pack) {
  if (!pack) return '  （未检索）';
  const lines = [];
  if (pack.news?.length) {
    lines.push(`  资讯（检索词「${pack.keyword}」，已滤除 ${pack.filtered ?? 0} 条 ETF 播报与同名机构噪音）：`);
    pack.news.slice(0, 8).forEach((x) => lines.push(`    ${x.date || '—'} ${x.title}${x.summary ? '｜' + x.summary.slice(0, 80) : ''}`));
  }
  if (pack.announcements?.length) {
    lines.push('  公告：');
    pack.announcements.slice(0, 6).forEach((x) => lines.push(`    ${x.date || '—'} ${x.title}`));
  }
  if (lines.length) return lines.join('\n');
  const why = pack.fetched ? `检索到 ${pack.fetched} 条但全部为无关噪音` : '未检索到';
  return `  （${why}，不代表没有事件发生）`;
}
