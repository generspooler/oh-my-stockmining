// 多区间回撤与区间收益（SYSTEM_DEFINITION §2.6）。
//
// 这里替换的旧实现（src/deep.js 的 drawdowns）有四个复合缺陷，全部静默：
//
//   1. 不复权。它复用了为「估值反算」刻意取的不复权月线。反算必须不复权
//      （复权价 × 股数 ≠ 当时市值，tencent.js 那个选择是对的），但收益率必须复权。
//      实测代价：NVDA 档案写「3年 −79% / 三年收益 −47%」，真实是 +364%——**符号相反**；
//      KLAC 3年 −91%（真实 −37%，三年收益真实 +252%）；DECK 3年 −93%（真实 −61%，
//      三年收益 −85% → 真实 −9%），而 DECK 正是以「流动性情绪杀」入榜 rank 7 的；
//      贵州茅台 5年 −32% → 真实 −5%，27 个百分点全是分红。
//      并非每只都被推翻：LULU（−81% → −80%）与 ZTS（−64% → −58%）几乎不动，是真跌。
//
//   2. 短序列静默降级。旧 win() 在 Math.max(0, …) 处 clamp，18 个点也能产出「5年回撤」。
//      池子下限是上市满 365 天，这类标的常规抵达此处。属 §6.5 禁止的「编造」。
//
//   3. dd 与 ret 窗口不一致。旧 dd(n) 取 n 个点（n−1 个区间）、ret(n) 取 n+1 个点，
//      导致同一行渲染的 dd52w 量 11 个月、ret52w 量 12 个月。
//
//   4. 按数组下标当月份。实测 DECK 某轮只返回 59 个点却横跨 2009–2026，
//      slice(-36) 得到的「近 3 年」实为十几年；同一只票 dd3y 在不同轮次可差 60 个百分点。
//
// 因此本模块：序列按日期取窗、复权口径显式回写、覆盖不足一律置空不降级。
import * as em from '../sources/em.js';
import * as tx from '../sources/tencent.js';
import { SCREENING } from '../config.js';

const D = SCREENING.drawdown;

/**
 * 日期回退 n 个月，返回 YYYY-MM-DD。
 * 目标月天数不足时夹到该月月末：2026-08-31 回退 6 个月应得 2026-02-28，
 * 直接 Date.UTC(y, m-6, 31) 会溢出成 2026-03-03，把一个月点错划进窗口。
 */
export function monthsBefore(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d)) return null;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() - n, day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/** 日K → 每月最后一个交易日。push2his 已直接支持月线，这里只为兜底路径保留。 */
export function toMonthEnd(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r?.date || !isFinite(r.close)) continue;
    const k = String(r.date).slice(0, 7);
    const prev = by.get(k);
    if (!prev || r.date > prev.date) by.set(k, r);
  }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 拆股伪影检测（纯函数）。相邻月收盘出现接近整数倍的跳空即判定该序列未复权。
 * 只用于兜底顺位 3：命中后把多区间指标置空，而不是输出一个错的数。
 */
export function detectSplit(rows) {
  for (let i = 1; i < (rows?.length || 0); i++) {
    const a = rows[i - 1].close, b = rows[i].close;
    if (!(a > 0) || !(b > 0)) continue;
    for (const k of D.splitRatios) {
      if (Math.abs(a / b - k) / k <= D.splitTolerance) return { split: true, at: rows[i].date, ratio: k };
    }
  }
  return { split: false };
}

/**
 * 取复权月末序列（§2.6 步骤 1 与步骤 5）。
 *
 * 主路 push2his klt=103 + fqt=2（后复权）；A股 兜底腾讯 qfq；
 * 再兜底不复权月线 + 拆股检测（命中则 usable:false，指标整体置空）。
 *
 * 返回 { rows, adjusted, source, splitSuspect, usable, reason }。
 * 口径随数据一起交给模型——模型看不到序列口径就无从怀疑喂给它的跌幅（§2.6 步骤 4）。
 */
export async function adjustedMonthly(row) {
  // ── 顺位 1 · push2his 月线后复权（两市场通用）──────────────
  if (row?.secid) {
    const bars = await em.kline(row.secid, { klt: 103, fqt: 2, beg: D.beg }).catch(() => []);
    const rows = (bars || []).filter((r) => r?.date && isFinite(r.close) && r.close > 0);
    if (rows.length > 1) {
      return { rows, adjusted: true, source: 'push2his 月线后复权', splitSuspect: false, usable: true };
    }
  }

  // ── 顺位 2 · 腾讯前复权月线（仅 A股返回 qfq 序列）──────────
  const qfq = await tx.monthlyAdjusted(row.code, row.market, row.mk).catch(() => null);
  if (qfq?.ok && qfq.rows.length > 1) {
    return { rows: qfq.rows, adjusted: true, source: '腾讯前复权月线', splitSuspect: false, usable: true };
  }

  // ── 顺位 3 · 不复权月线 + 拆股检测 ─────────────────────────
  const raw = await tx.monthly(row.code, row.market, row.mk).catch(() => []);
  const rows = (raw || []).filter((r) => r?.date && isFinite(r.close) && r.close > 0);
  if (rows.length < 2) {
    return { rows: [], adjusted: false, source: '不可得', splitSuspect: false, usable: false, reason: '历史价格序列不可得' };
  }
  const s = detectSplit(rows);
  return {
    rows, adjusted: false, source: '腾讯月线（未复权）', splitSuspect: s.split, usable: !s.split,
    reason: s.split
      ? `序列未复权且检测到 ${s.ratio}:1 拆股（${s.at}），跌幅不可得`
      : '序列未复权（未检测到拆股，分红仍会小幅夸大跌幅）',
  };
}

/**
 * 多区间回撤与区间收益（纯函数，可测）。
 *
 * series：[{date, close}] 旧→新。
 * 按**日期**回溯取窗；起点晚于窗口起点则该区间返回 null，不退化成短窗口再冠原标签。
 */
export function drawdowns(series, { windows = D.windows } = {}) {
  const s = (series || []).filter((r) => r?.date && isFinite(r.close) && r.close > 0);
  const out = {};
  for (const k of Object.keys(windows)) {
    out[k] = null;
    out[k.replace(/^dd/, 'ret')] = null;
  }
  if (s.length < 2) return { ...out, coverage: { months: s.length, from: null, to: null } };

  const last = s[s.length - 1];
  const first = s[0];
  const coverage = { months: s.length, from: first.date, to: last.date };

  for (const [key, n] of Object.entries(windows)) {
    const cut = monthsBefore(last.date, n);
    // 序列起点晚于窗口起点 → 历史不覆盖该区间，置空（§2.6 步骤 3）
    if (!cut || first.date > cut) continue;
    const win = s.filter((r) => r.date >= cut);
    if (win.length < D.minPointsPerWindow) continue;

    const hi = Math.max(...win.map((r) => r.close));
    if (hi > 0) out[key] = last.close / hi - 1;

    // 区间收益与回撤同窗口：起点取窗口起点之前（含）最近的一个点
    let base = null;
    for (const r of s) { if (r.date <= cut) base = r; else break; }
    if (base?.close > 0) out[key.replace(/^dd/, 'ret')] = last.close / base.close - 1;
  }
  return { ...out, coverage };
}

/** 渲染序列口径一行。不可用时说明原因，让模型知道空值是「取不到」而非「没跌」。 */
export function renderCoverage(pack, dd) {
  if (!pack || !pack.usable) {
    return `价格序列：不可用（${pack?.reason || '历史价格序列不可得'}）——本节多区间回撤与区间收益整体置空`;
  }
  const c = dd?.coverage || {};
  const adj = pack.adjusted ? '已复权' : '未复权';
  return `价格序列：${c.months ?? '—'} 个月点，${c.from || '—'} → ${c.to || '—'}（${adj}，来源 ${pack.source}）`
    + (pack.adjusted ? '' : `；⚠ ${pack.reason}`);
}
