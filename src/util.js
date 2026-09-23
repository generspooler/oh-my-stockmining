// 通用工具：磁盘缓存、带重试的 fetch、并发池、统计函数、格式化。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const SEC_UA = process.env.SEC_USER_AGENT || 'my-stock-mining/0.2 (research; set SEC_USER_AGENT to override)';

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
      lastErr = e;
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
