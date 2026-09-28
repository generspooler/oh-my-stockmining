#!/usr/bin/env node
// 联网研究员唯一的联网入口（v0.11.0，§3.4）。研究员会话里的 Bash 只放行这一个脚本：
//
//   node <本文件绝对路径> search "<关键词>" [条数]
//   node <本文件绝对路径> read "<完整 URL>"
//
// 为什么不直接放行 mcporter / curl：实测（2026-09-27 美股自选 9 只）
//   1. Exa 在并发下间歇失败——5 路并发 2 路报错（HTTP 405 / 「exa appears offline」），
//      三个子代理同时搜，其中一个第一次查询后就「断开」，交回的 3 只全是「未查到」；
//   2. 子代理会自己改写命令（加 `-m 30`、给 URL 加引号、`; echo ----` 串起来），
//      精确前缀规则于是把它们拒掉——安全边界生效了，但研究也白做了。
// 所以联网动作收口到这里：重试与退避、跨进程并发上限、URL 校验、长度截断都由代码保证，
// 研究员只需记住两种写法，放行规则也收得更窄。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_SEARCH_CHARS = 20000;
export const MAX_READ_CHARS = 30000;
// Exa 并发上限（跨进程：主会话与各子代理是同一个 claude 进程里的不同 Bash 调用，彼此独立）
const SLOTS = Number(process.env.MINE_RESEARCH_EXA_SLOTS || 2);
const SLOT_DIR = path.join(os.tmpdir(), 'my-stock-mining-exa-slots');
// 占位超过这个时长视为僵死（进程被杀没来得及释放）
const SLOT_STALE_MS = 90e3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跨进程信号量：mkdir 是原子的，占到哪个编号就是哪个槽位。 */
async function acquireSlot({ slots = SLOTS, dir = SLOT_DIR, waitMs = 120e3 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const p = path.join(dir, `slot-${i}`);
      try {
        fs.mkdirSync(p);
        return () => { try { fs.rmdirSync(p); } catch {} };
      } catch {
        try { if (Date.now() - fs.statSync(p).mtimeMs > SLOT_STALE_MS) fs.rmdirSync(p); } catch {}
      }
    }
    // 等不到槽位也不无限等：超时后直接去搜（宁可冒一次失败，也不让研究员卡死）
    if (Date.now() - t0 > waitMs) return () => {};
    await sleep(300 + Math.random() * 400);
  }
}

const defaultRun = (args) => new Promise((resolve) => {
  execFile('mcporter', args, { timeout: 60e3, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});

/** mcporter 的失败输出 → 一行原因（纯函数）。 */
export function failReason(r) {
  const s = `${r.stderr}\n${r.stdout}`;
  if (/appears offline|fetch failed/i.test(s)) return 'Exa 暂时连不上';
  const http = /HTTP (\d{3})/.exec(s);
  if (http) return `Exa 返回 HTTP ${http[1]}`;
  if (/timed? ?out|ETIMEDOUT/i.test(s)) return 'Exa 超时';
  return (s.trim().split('\n')[0] || `退出码 ${r.code}`).slice(0, 120);
}

/**
 * Exa 搜索，带重试与退避。run / wait 可注入（单测用）。
 * 成功的判据：退出码 0 且有正文。mcporter 失败时也可能把部分结果打到 stdout（实测 exit 1 + 半截结果），
 * 那种按失败处理并重试——半截结果会让研究员以为「就这些」。
 */
export async function search(query, n = 5, { run = defaultRun, wait = sleep, attempts = 4, slot = acquireSlot } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, text: '搜索词为空' };
  const num = Math.max(1, Math.min(10, Number(n) || 5));
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const release = await slot();
    let r;
    try { r = await run(['call', 'exa.web_search_exa', `query=${q}`, `numResults=${num}`]); } finally { release(); }
    if (r.code === 0 && r.stdout.trim()) {
      const t = r.stdout.trim();
      return { ok: true, attempts: i + 1, text: t.length > MAX_SEARCH_CHARS ? `${t.slice(0, MAX_SEARCH_CHARS)}\n…（已截断）` : t };
    }
    last = failReason(r);
    if (i < attempts - 1) await wait(1500 * 2 ** i + Math.random() * 1000);
  }
  return { ok: false, attempts, text: `搜索失败（已重试 ${attempts} 次）：${last}。换个关键词再试，或先查别的标的。` };
}

/** 读网页（Jina Reader）。只接受 http(s) 链接；截断到 MAX_READ_CHARS。 */
export async function read(url, { fetchImpl = fetch, attempts = 2, wait = sleep } = {}) {
  const u = String(url || '').trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(u)) return { ok: false, text: `不是合法的 http(s) 链接：${u.slice(0, 120)}` };
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`https://r.jina.ai/${u}`, { signal: AbortSignal.timeout(45e3) });
      const t = (await res.text()).trim();
      if (res.ok && t) return { ok: true, text: t.length > MAX_READ_CHARS ? `${t.slice(0, MAX_READ_CHARS)}\n…（已截断）` : t };
      last = `HTTP ${res.status}`;
    } catch (e) { last = e.name === 'TimeoutError' ? '超时' : e.message; }
    if (i < attempts - 1) await wait(2000);
  }
  return { ok: false, text: `读取失败：${last}（${u.slice(0, 120)}）。付费墙或反爬站点常读不到，换一个来源。` };
}

async function main(argv) {
  const [cmd, a, b] = argv;
  const r = cmd === 'search' ? await search(a, b)
    : cmd === 'read' ? await read(a)
      : { ok: false, text: '用法：search "<关键词>" [条数] ｜ read "<完整 URL>"' };
  process.stdout.write(`${r.text}\n`);
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
