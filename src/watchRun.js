// 自选池挖掘流水线（SYSTEM_DEFINITION §3.3）：收集 → 深度补数 → 裁决，三阶段。
//
// 与市场挖掘（四阶段）彻底分开，两条流水线互不干扰（用户决策 2026-09-23）：
// 自选池不粗筛——十来只点名的票不必跟全市场抢入场券，跳过阶段 2 省掉 5~6 次模型调用，
// 整轮只有裁决 1 次模型调用（v0.7.1 起另有按需取数的工具往返，数量由模型自己决定），
// 耗时从十几分钟降到分钟级。
//
// server 与 CLI 共用这一份编排。市场那条流水线在两处各写了一遍，
// 已经导致过「网页跑的结果不落盘」这类偏差，自选这条不重蹈。
import { collect } from './collect.js';
import { deepen } from './deep.js';
import { watchReview } from './review.js';
import { llmReady } from './llm.js';
import { watchlistFor } from './watchlist.js';
import { createActivity, noteEvent, fingerprint } from './progress.js';
import { saveMine, buildMinePayload } from './history.js';

export const marketName = (m) => (m === 'cn' ? 'A股' : '美股');

/** 三阶段的阶段名，前端进度条与 CLI 共用（市场挖掘是四段：收集/粗筛/补数/裁决）。 */
export const WATCH_PHASES = ['收集', '补数', '裁决'];

/**
 * 跑一轮自选池挖掘。
 * onStage(phase, text, done, total, snap)：phase 为 1..3，done/total 有则渲染进度；
 *   snap 是活动快照（§5.1，见 progress.js）——「此刻在干什么」与「已经干了什么」
 *   本是同一份台账，拆成两条通道只会漂移。按内容指纹去重（progress.fingerprint）。
 * onCollected({ meta, watch })：阶段 1 完成时的并入情况，供网页先行渲染。
 * 活动台账不落盘（用户决策 2026-09-24）：过程的旁白不是结论的一部分。
 * 返回 { market, meta, profiles, verdict, watch, totalMs, file }。
 */
export async function runWatchMine(market, { onStage, onCollected, onEvent } = {}) {
  const t0 = Date.now();
  const act = createActivity();
  let lastSnap = '';
  const emit = (phase, text, done, total) => {
    const snap = act.snapshot();
    const fp = `${phase}|${text}|${done ?? ''}|${total ?? ''}|${fingerprint(snap)}`;
    if (fp === lastSnap) return;      // 内容没变就不占一条通道（collect 的每次请求都会报）
    lastSnap = fp;
    onStage?.(phase, text, done, total, snap);
  };
  const phaseName = (p) => WATCH_PHASES[p - 1] || '裁决';
  const last = { phase: 1, text: '', done: null, total: null };
  /** 重播当前状态。台账新记一笔就重播一次，理由同 marketRun。 */
  const refresh = () => emit(last.phase, last.text, last.done, last.total);
  /** 一个单元结束：记下小结，并让「此刻在干什么」显示它（理由同 marketRun）。 */
  const finish = (kind, summary, phase = last.phase) => {
    act.close(kind, summary, phaseName(phase));
    if (last.phase === phase) Object.assign(last, { text: summary, done: null, total: null });
    refresh();
  };
  /** 更新「此刻在干什么」；只改文案、不动当前阶段。 */
  const label = (text, { unit = null, key = null } = {}) => {
    if (unit) act.set({ stage: phaseName(last.phase), kind: unit, key: key || text, label: text });
    last.text = text;
    emit(last.phase, text, last.done, last.total);
  };
  const say = (phase, text, { unit = null, key = null, done = null, total = null } = {}) => {
    if (unit) act.set({ stage: phaseName(phase), kind: unit, key: key || text, label: text, done, total });
    Object.assign(last, { phase, text, done: done ?? null, total: total ?? null });
    emit(phase, text, last.done, last.total);
  };
  const items = watchlistFor(market);
  if (!items.length) {
    throw new Error(`${marketName(market)}自选池为空：先在自选池里加入标的，再来挖掘`);
  }

  // ── 阶段 1 · 自选池信息收集（只收池内这几只，不碰全市场基本面）──────
  say(1, '自选池信息收集', { unit: 'collect', key: 'start' });
  const { rows, meta } = await collect(market, {
    onlyCodes: items.map((x) => x.code),
    onProgress: (t, d) => say(1, t, d || {}),
  });
  const joined = new Set(rows.map((r) => String(r.code).toUpperCase()));
  const missing = items
    .filter((x) => !joined.has(String(x.code).toUpperCase()))
    .map((x) => `${x.name}(${x.code})`);
  const watch = { pool: items.length, joined: rows.length, missing, failed: [] };
  finish('collect', `收集完成：池内 ${items.length} 只 → 并入 ${rows.length} 只`
    + (missing.length ? `（未找到 ${missing.length} 只）` : ''));
  onCollected?.({ meta, watch });

  if (!rows.length) {
    throw new Error(`自选池内 ${items.length} 只标的在全市场列表中一只都没找到：${missing.join('、')}`);
  }
  if (!llmReady()) {
    throw new Error('未检测到模型凭据：机械层已完成收集，模型推理不可用。请 export ANTHROPIC_AUTH_TOKEN 后重启服务。');
  }

  // ── 阶段 2 · 深度补数（池内全员，无淘汰）──────────────────────────
  say(2, '深度补数');
  const profiles = await deepen(rows.map((r) => ({ row: r, why: null, guess: null, checkNext: null })), {
    onProgress: (t, d) => say(2, t, d || {}),
  });
  const ok = new Set(profiles.map((p) => String(p.code).toUpperCase()));
  watch.failed = rows.filter((r) => !ok.has(String(r.code).toUpperCase())).map((r) => `${r.name}(${r.code})`);
  finish('profile', `补数完成：${profiles.length}/${rows.length} 只`);

  // ── 阶段 3 · 自选池裁决（小池子 1 次调用；大池子批内初筛 + 终裁）────
  // 进度与模型活性都要往外报：一次裁决可能沉默十几分钟，
  // 没有信号时「正常思考」与「已经死了」在界面上完全一样（实测踩过）。
  // 「此刻在干什么」置为裁决段；进度由下面的 onProgress 刷新（大池子才有批内初筛）
  say(3, '自选池裁决', { unit: 'model', key: 'verdict' });
  const verdict = await watchReview(profiles, {
    rows,
    onEvent: (e) => {
      // tick 的文案映射只有 llm.tickText() 一处实现，这里不再自己拼一遍
      if (e.type === 'tick') {
        label(e.text, { unit: 'model', key: `tick:${e.key || e.scope}` });
        return;
      }
      // 联网研究（v0.11.0）：「此刻在干什么」显示研究员的最近一个动作，收尾时让位给裁决
      if (e.type === 'research') {
        if (e.stage === 'end') act.close('web');
        else label(`${e.text}（已交回 ${e.done}/${e.total}）`, { unit: 'web', key: 'research' });
      }
      noteEvent(act, e, e.type === 'research' ? '联网' : (e.scope || '裁决'));   // 降级 / 取数 / 联网 / 存疑 / 错误都要留痕
      refresh();
      onEvent?.(e);
    },
    onProgress: (p) => {
      if (p.phase === 'batch') {
        say(3, `批内初筛 ${p.done}/${p.total}`, { unit: 'coarse', key: 'batch', done: p.done, total: p.total });
        if (p.done === p.total) finish('coarse', `批内初筛完成：${p.total} 批`);
      } else if (p.phase === 'research') {
        label(`联网研究（${p.total} 只）`, { unit: 'web', key: 'research' });
      } else {
        label(p.shortlist ? `终裁（入围 ${p.shortlist} 只）` : '自选池裁决',
          { unit: 'model', key: 'verdict' });
        refresh();
      }
    },
  });
  if (verdict?.ok) {
    const below = verdict.top.filter((x) => x.meetsBar === false).length;
    finish('model', `裁决完成：榜单 ${verdict.top.length} / 池内 ${verdict.pool} 只${below ? `（其中机制补位 ${below} 只）` : ''}`
      + `（模型调用 ${verdict.calls ?? 1} 次，取数 ${verdict.toolCalls || 0} 次`
      + `${verdict.research ? `，联网研究交回 ${verdict.research.findings.length}/${verdict.research.requested} 只` : ''}）`);
  }

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
