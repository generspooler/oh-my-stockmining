// 通用工具：磁盘缓存、带重试的 fetch、并发池、统计函数、格式化。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const SEC_UA = process.env.SEC_USER_AGENT || 'my-stock-mining/0.2 (research; set SEC_USER_AGENT to override)';

// ── DNS 解析顺序：默认 IPv4 优先（2026-09-28 实测定案）──────────────────
// 东财 push2 / datacenter、腾讯 qt.gtimg、SEC 全部同时有 A 与 AAAA 记录，macOS 默认把 IPv6
// 地址排在前面。实测北京移动线路上，push2 三个域名的 IPv6 都能建连、能完成 TLS，普通路径
// 还会正常回 404，唯独 `/api/qt/...` 请求一到就被服务端关闭连接（IPv6 前端的应用层拒绝，不是
// 线路不通）。TCP 已经连上，Node 的 Happy Eyeballs 不会再回退到 IPv4，undici 只抛一句裸的
// `fetch failed`（cause=UND_ERR_SOCKET），「拉取全市场列表」2 秒内整轮报错。
// 定位手法：同一 URL `curl -4` 200、`curl -6` 空响应。所有数据源 IPv4 均可达，进程级改成
// IPv4 优先没有代价；按域名白名单则每加一个源都要记得补。纯 IPv6 环境用
// MINE_DNS_ORDER=ipv6first|verbatim 覆盖。必须在任何 fetch 之前生效，故放在本模块顶层。
const DNS_ORDERS = ['ipv4first', 'ipv6first', 'verbatim'];
const dnsOrder = process.env.MINE_DNS_ORDER || 'ipv4first';
if (DNS_ORDERS.includes(dnsOrder)) dns.setDefaultResultOrder(dnsOrder);
else console.warn(`[net] MINE_DNS_ORDER=${dnsOrder} 不在 ${DNS_ORDERS.join('|')} 之内，沿用系统默认解析顺序`);

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hash = (obj) => crypto.createHash('sha256').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex').slice(0, 16);

/** 读磁盘缓存；未命中或过期则跑 producer 并写回。ttlMs<=0 表示不缓存。 */
export async function cached(key, ttlMs, producer) {
  const file = path.join(CACHE_DIR, `${sha(key)}.json`);
  if (ttlMs > 0) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - raw.t < ttlMs) return raw.v;
    } catch {}
  }
  const v = await producer();
  // 失败结果（null / 空数组）不写盘，否则一次网络抖动会毒化缓存整个 TTL
  const worthCaching = v != null && !(Array.isArray(v) && v.length === 0);
  if (ttlMs > 0 && worthCaching) {
    try { fs.writeFileSync(file, JSON.stringify({ t: Date.now(), k: key, v })); } catch {}
  }
  return v;
}

/**
 * 把 undici 的裸 `fetch failed` / 超时 AbortError 翻成能定位的话。
 * 原样抛出去，界面上只剩「fetch failed」，主机是谁、是断连还是超时全看不见
 * （2026-09-28 IPv6 断连那次就是这样多查了一圈）。HTTP 层错误本来就带 URL 与 status，
 * 原样保留——调用方还靠 e.status / e.fatal 判断 404 要不要重试。
 */
function describeNetErr(e, url, timeout) {
  if (e == null || e.status != null) return e;
  let host = url;
  try { host = new URL(url).host; } catch {}
  const code = e.cause?.code || e.code;
  if (e.name === 'AbortError') {
    // DOMException 的 message 是只读访问器，就地改会在严格模式下抛错，换成普通 Error
    return Object.assign(new Error(`请求超时 ${timeout}ms · ${host}`), { cause: e, code: 'ETIMEDOUT' });
  }
  if (code && !String(e.message).includes(code)) {
    return Object.assign(new Error(`${e.message}（${code}）· ${host}`), { cause: e.cause || e, code });
  }
  return e;
}

/** 带超时 + 指数退避重试的 fetch，返回文本。 */
export async function fetchText(url, opts = {}) {
  const { headers = {}, timeout = 20000, retries = 3, method = 'GET', body } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        method, body, signal: ac.signal,
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { status: res.status, fatal: res.status === 404 });
      return await res.text();
    } catch (e) {
      lastErr = describeNetErr(e, url, timeout);
      if (e.fatal || attempt === retries) break;
      await sleep(400 * 2 ** attempt + Math.random() * 250);
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const txt = await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  try { return JSON.parse(txt); }
  catch { throw new Error(`非 JSON 响应: ${url} :: ${txt.slice(0, 120)}`); }
}

/** 限并发地映射；单项失败记为 null，不影响整体。onProgress 用于长任务播报。 */
export async function pool(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let cursor = 0, done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
      if (onProgress) onProgress(++done, items.length);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── 统计函数（metrics / valuation 层共用）──────────────────────────
const nums = (a) => a.filter((x) => x != null && isFinite(x));

export function median(arr) {
  const a = nums(arr).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function mean(arr) {
  const a = nums(arr);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

export function stddev(arr) {
  const a = nums(arr);
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** 变异系数：用于周期股判定。均值为 0 或负时无意义，返回 null。 */
export function cv(arr) {
  const m = mean(arr), sd = stddev(arr);
  if (m == null || sd == null || m <= 0) return null;
  return sd / m;
}

/** 线性插值分位数。p 为 0–100。 */
export function percentile(arr, p) {
  const a = nums(arr).sort((x, y) => x - y);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const idx = (p / 100) * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/** 某个值在数组中的百分位位置（0–100）。 */
export function percentileRankOf(arr, v) {
  const a = nums(arr);
  if (!a.length || v == null || !isFinite(v)) return null;
  return (a.filter((x) => x <= v).length / a.length) * 100;
}

/** z-score；样本标准差为 0 时返回 0（全体相同，无区分度）。 */
export function zscore(v, arr) {
  if (v == null || !isFinite(v)) return null;
  const m = mean(arr), sd = stddev(arr);
  if (m == null || sd == null || sd === 0) return 0;
  return (v - m) / sd;
}

/** 把任意分值线性压缩到 0–100，超界截断。 */
export const clamp100 = (v, lo, hi) =>
  v == null || !isFinite(v) ? null : Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));

export const safeDiv = (a, b) => (a == null || b == null || !isFinite(a) || !isFinite(b) || b === 0 ? null : a / b);

// ── 日期 ────────────────────────────────────────────────────────
export const ymd = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400e3);

// ── 格式化 ──────────────────────────────────────────────────────
export const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function money(v, cur = 'CNY') {
  if (v == null || !isFinite(v)) return '—';
  const neg = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (cur === 'CNY') {
    if (a >= 1e8) return `${neg}${(a / 1e8).toFixed(2)}亿`;
    if (a >= 1e4) return `${neg}${(a / 1e4).toFixed(2)}万`;
    return `${neg}${a.toFixed(2)}`;
  }
  if (a >= 1e12) return `${neg}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${neg}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${neg}$${(a / 1e6).toFixed(2)}M`;
  return `${neg}$${a.toFixed(2)}`;
}

export const pct = (v, digits = 1) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(digits)}%`);
export const num = (v, digits = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(digits));
