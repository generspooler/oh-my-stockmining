// 腾讯金融行情（qt.gtimg.cn / web.ifzq.gtimg.cn）。
// 作用：提供历史价格序列，替代东财 push2 系列日K。
//
// 为什么不用东财日K：
//   1) push2/push2his 域名在部分网络下被整体重置（实测四个域名全部不可用），
//      而它们互为「故障转移」，等于没有转移；
//   2) A股根本不需要——RPT_VALUEANALYSIS_DET 每条记录自带 CLOSE_PRICE；
//   3) 美股反算分位只需要一个分布，月频（10 年 120 点）足够算 P25/P50/P75，日频是浪费。
import { cached, fetchJson, hash, UA } from '../util.js';
import { CACHE_TTL } from '../config.js';

const H = { 'User-Agent': UA, Referer: 'https://gu.qq.com/' };

/** 美股在腾讯需要交易所后缀：东财 f13 105=NASDAQ / 106=NYSE / 107=AMEX。 */
export const txUsCode = (code, mk = 105) =>
  `us${String(code).toUpperCase()}.${({ 105: 'OQ', 106: 'N', 107: 'A' })[mk] || 'OQ'}`;

export const txCnCode = (code) => (/^(6|9)/.test(code) ? 'sh' : 'sz') + code;

/**
 * 月线序列，最多 120 个月（10 年），不复权。
 * 不复权是刻意的：反算市值需要「当时真实成交价 × 当时股数」，复权价乘股数不等于当时市值。
 * 返回 [{date, close}]，旧→新。
 */
export async function monthly(code, market, mk) {
  const tx = market === 'us' ? txUsCode(code, mk) : txCnCode(code);
  return cached(`tx-month:${tx}`, CACHE_TTL.kline, async () => {
    const d = await fetchJson(
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(`${tx},month,,,120,`)}`,
      { headers: H, retries: 2, timeout: 12000 },
    ).catch(() => null);
    const box = d?.data?.[tx] || d?.data?.[Object.keys(d?.data || {})[0]] || {};
    const key = Object.keys(box).find((k) => Array.isArray(box[k]) && box[k].length > 1);
    const rows = box[key] || [];
    // 每行 [日期, 开, 收, 高, 低, 量]
    return rows.map((r) => ({ date: r[0], close: Number(r[2]) })).filter((x) => x.date && isFinite(x.close));
  });
}

/**
 * 前复权月线（SYSTEM_DEFINITION §2.6 步骤 5 顺位 2）。**仅 A股可用。**
 *
 * 实测：`param` 第 6 段传 qfq 时，A股 响应键从 `month` 变成 `qfqmonth`
 * 且数值确实变了（茅台 60 月前 1830 → 1607.059，差额是累计分红）；
 * 但**美股该参数被静默忽略**——键仍是 `month`、三种取值返回分毫不差的数据。
 *
 * 所以这里必须校验键名真的是 qfq 开头：拿到不复权数据却以为已复权，
 * 正是本次要修的那类静默错误。校验失败返回 ok:false，由调用方降级。
 */
export async function monthlyAdjusted(code, market, mk) {
  const tx = market === 'us' ? txUsCode(code, mk) : txCnCode(code);
  return cached(`tx-month-qfq:${tx}`, CACHE_TTL.kline, async () => {
    const d = await fetchJson(
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(`${tx},month,,,120,qfq`)}`,
      { headers: H, retries: 2, timeout: 12000 },
    ).catch(() => null);
    const box = d?.data?.[tx] || {};
    const key = Object.keys(box).find((k) => /^qfq/.test(k) && Array.isArray(box[k]) && box[k].length > 1);
    if (!key) return { ok: false, reason: '该市场不提供前复权月线（响应未返回 qfq 序列）', rows: [] };
    const rows = box[key].map((r) => ({ date: r[0], close: Number(r[2]) }))
      .filter((x) => x.date && isFinite(x.close) && x.close > 0);
    return { ok: rows.length > 1, reason: rows.length > 1 ? null : '前复权序列点数不足', rows };
  });
}

/** 12 个月价格涨跌幅。序列不足则返回 null。 */
export function yearReturn(series) {
  if (!series?.length) return null;
  const last = series[series.length - 1];
  const idx = series.length - 13;
  const base = idx >= 0 ? series[idx] : series[0];
  if (!base?.close || !last?.close) return null;
  return { change: last.close / base.close - 1, from: base.date, to: last.date, months: series.length - 1 - series.indexOf(base) };
}

// ── 批量行情快照（52周高低）─────────────────────────────────
// 全市场粗筛需要「距 52 周高点回撤」，这是唯一能批量拿到的多月尺度跌幅信号。
// 实测 200 只/请求可用；响应为 GBK 编码、~ 分隔文本，A股与美股字段位不同。
const GBK = new TextDecoder('gbk');

async function fetchGbk(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: H });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return GBK.decode(Buffer.from(await res.arrayBuffer()));
  } finally { clearTimeout(timer); }
}

const numOf = (v) => (v !== '' && v != null && isFinite(Number(v)) ? Number(v) : null);

/**
 * 批量快照。返回 Map(code -> { price, week52High, week52Low, drawdown52 })。
 * drawdown52 为距 52 周高点的回撤（负数表示低于高点）。
 */
export async function batchQuotes(codes, market, mkOf = () => 105) {
  const out = new Map();
  const CHUNK = 200;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const slice = codes.slice(i, i + CHUNK);
    const keys = slice.map((c) => (market === 'us' ? `us${String(c).toUpperCase()}` : txCnCode(c)));
    // 缓存键用哈希——整串代码拼进键里会让日志与错误信息被刷屏
    const txt = await cached(`tx-batch:${market}:${hash(keys.join(','))}`, CACHE_TTL.quote,
      () => fetchGbk(`https://qt.gtimg.cn/q=${keys.join(',')}`).catch(() => '')).catch(() => '');
    const byKey = new Map();
    for (const m of String(txt).matchAll(/v_([^=]+)="([^"]*)"/g)) {
      if (m[2]) byKey.set(m[1], m[2].split('~'));
    }
    slice.forEach((code, j) => {
      const f = byKey.get(keys[j]);
      if (!f) return;
      const price = numOf(f[3]);
      const hi = numOf(f[market === 'us' ? 48 : 67]);
      const lo = numOf(f[market === 'us' ? 49 : 68]);
      if (price == null) return;
      out.set(code, {
        price, week52High: hi, week52Low: lo,
        drawdown52: hi ? price / hi - 1 : null,
        offLow52: lo ? price / lo - 1 : null,
      });
    });
  }
  return out;
}
