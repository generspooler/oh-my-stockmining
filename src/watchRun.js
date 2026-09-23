// 自选池挖掘流水线（SYSTEM_DEFINITION §3.3）：收集 → 深度补数 → 裁决，三阶段。
//
// 与市场挖掘（四阶段）彻底分开，两条流水线互不干扰（用户决策 2026-09-23）：
// 自选池不粗筛——十来只点名的票不必跟全市场抢入场券，跳过阶段 2 省掉 5~6 次模型调用，
// 整轮只有裁决 1 次调用，耗时从十几分钟降到分钟级。
//
// server 与 CLI 共用这一份编排。市场那条流水线在两处各写了一遍，
// 已经导致过「网页跑的结果不落盘」这类偏差，自选这条不重蹈。
import { collect } from './collect.js';
import { deepen } from './deep.js';
import { watchReview } from './review.js';
import { llmReady } from './llm.js';
import { watchlistFor } from './watchlist.js';
import { saveMine, buildMinePayload } from './history.js';

export const marketName = (m) => (m === 'cn' ? 'A股' : '美股');

/** 三阶段的阶段名，前端进度条与 CLI 共用（市场挖掘是四段：收集/粗筛/补数/裁决）。 */
export const WATCH_PHASES = ['收集', '补数', '裁决'];

/**
 * 跑一轮自选池挖掘。
 * onStage(phase, text, done, total)：phase 为 1..3，done/total 有则渲染进度。
 * onCollected({ meta, watch })：阶段 1 完成时的并入情况，供网页先行渲染。
 * 返回 { market, meta, profiles, verdict, watch, totalMs, file }。
 */
export async function runWatchMine(market, { onStage, onCollected, onEvent } = {}) {
  const t0 = Date.now();
  const stage = (phase, text, done, total) => onStage?.(phase, text, done, total);
  const items = watchlistFor(market);
  if (!items.length) {
    throw new Error(`${marketName(market)}自选池为空：先在自选池里加入标的，再来挖掘`);
  }

  // ── 阶段 1 · 自选池信息收集（只收池内这几只，不碰全市场基本面）──────
  stage(1, '自选池信息收集');
  const { rows, meta } = await collect(market, {
    onlyCodes: items.map((x) => x.code),
    onProgress: (t) => stage(1, t),
  });
  const joined = new Set(rows.map((r) => String(r.code).toUpperCase()));
  const missing = items
    .filter((x) => !joined.has(String(x.code).toUpperCase()))
    .map((x) => `${x.name}(${x.code})`);
  const watch = { pool: items.length, joined: rows.length, missing, failed: [] };
  onCollected?.({ meta, watch });

  if (!rows.length) {
    throw new Error(`自选池内 ${items.length} 只标的在全市场列表中一只都没找到：${missing.join('、')}`);
  }
  if (!llmReady()) {
    throw new Error('未检测到模型凭据：机械层已完成收集，模型推理不可用。请 export ANTHROPIC_AUTH_TOKEN 后重启服务。');
  }

  // ── 阶段 2 · 深度补数（池内全员，无淘汰）──────────────────────────
  const profiles = await deepen(rows.map((r) => ({ row: r, why: null, guess: null, checkNext: null })), {
    onProgress: (t) => {
      const m = String(t).match(/(\d+)\/(\d+)/);
      stage(2, String(t).replace(/\s*\d+\/\d+$/, ''), m ? Number(m[1]) : undefined, m ? Number(m[2]) : undefined);
    },
  });
  const ok = new Set(profiles.map((p) => String(p.code).toUpperCase()));
  watch.failed = rows.filter((r) => !ok.has(String(r.code).toUpperCase())).map((r) => `${r.name}(${r.code})`);

  // ── 阶段 3 · 自选池裁决（小池子 1 次调用；大池子批内初筛 + 终裁）────
  // 进度与模型活性都要往外报：一次裁决可能沉默十几分钟，
  // 没有信号时「正常思考」与「已经死了」在界面上完全一样（实测踩过）。
  stage(3, '自选池裁决');
  const verdict = await watchReview(profiles, {
    rows,
    onEvent: (e) => {
      if (e.type === 'tool') {
        stage(3, `终裁 · 取数 ${e.used} 次（${e.name}${e.input?.code ? ' ' + e.input.code : ''}，${e.chars} 字）`);
        onEvent?.(e);
        return;
      }
      if (e.type === 'tick') {
        const s = Math.round((e.elapsedMs || 0) / 1000);
        stage(3, e.phase === 'writing'
          ? `${e.scope || '裁决'} · 正在写结论（已 ${e.chars} 字 / ${s}s）`
          : e.phase === 'tool'
            ? `${e.scope || '裁决'} · 正在决定取哪些数（已 ${s}s）`
            : `${e.scope || '裁决'} · 模型思考中（已 ${s}s）`);
        return;
      }
      onEvent?.(e);
    },
    onProgress: (p) => {
      if (p.phase === 'batch') stage(3, `批内初筛`, p.done, p.total);
      else stage(3, p.shortlist ? `终裁（入围 ${p.shortlist} 只）` : '自选池裁决');
    },
  });

  // 落盘：一次挖掘的结果不该刷新即丢（与市场挖掘共用 history.js）。
  // 裁决失败的不落盘——一份 top/rejected 全空的快照只会污染历史。
  let file = null;
  if (verdict.ok) {
    try {
      file = saveMine(buildMinePayload({
        scope: 'watch', market, meta, coarse: null, profiles, verdict, watch,
        totalMs: Date.now() - t0, modelCalls: verdict.calls ?? 1,
      }));
    } catch {}
  }

  return { market, meta, profiles, verdict, watch, totalMs: Date.now() - t0, file };
}
