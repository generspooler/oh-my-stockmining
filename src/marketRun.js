// 市场挖掘流水线（SYSTEM_DEFINITION §3.2）：收集 → 粗筛 → 补数 → 裁决，四阶段。
//
// **唯一编排入口**，网页与 CLI 共用。此前在 mine.js 与 server.js 各写了一遍，
// 已导致过「网页跑的结果不落盘」这类偏差（§6.2 那条规则就是为此立的），
// 而且两份已经漂移出四处差异：
//   - finalVerdict 的 options：mine.js 传空 onEvent，server.js 压根不传
//     （于是工具事件与降级事件在网页端无处可去）
//   - coarseScreen 的 onEvent：只有 mine.js 记降级日志
//   - 零候选出口：一边 console.log 一边 ch.send('done')
//   - 落盘：两边都**无条件**写，与 watchRun 的 `if (verdict.ok)` 不一致
//
// 合并时的取舍：
//   - 落盘统一为**裁决成功才写**（对齐 src/watchRun.js）。这**改变了市场那条的
//     现有行为**——此前裁决失败也会落一份 top 为空的快照，污染历史与回放。
//   - onEvent / onProgress 一律往外报，由两个界面各自决定怎么渲染。
//   - CLI 专有的 `--no-llm` 批次预览留在 mine.js：那是展示功能，不是编排。
import { collect } from './collect.js';
import { coarseScreen } from './coarse.js';
import { deepen } from './deep.js';
import { finalVerdict } from './verdict.js';
import { llmReady } from './llm.js';
import { createActivity, noteEvent, fingerprint } from './progress.js';
import { saveMine, buildMinePayload } from './history.js';

// marketName 的唯一定义在 watchRun.js，这里只转出——本轮已清理过两个分叉的重复
// 实现（whitelistFromPrompt、normalizeExternal），不再制造第三个。
export { marketName } from './watchRun.js';

/** 四阶段的阶段名，前端进度条与 CLI 共用（自选池挖掘是三段：收集/补数/裁决）。 */
export const MARKET_PHASES = ['收集', '粗筛', '补数', '裁决'];

/**
 * 跑一轮市场挖掘。
 *
 * onStage(phase, text, done, total, snap)：phase 为 1..4，done/total 有则渲染进度。
 * snap 是**活动快照**（§5.1，见 progress.js）：{ act, counters, summaries, recent,
 * openCount, elapsedMs }。阶段事件因此同时是「此刻在干什么」与「已经干了些什么」
 * 两个通道——两者本是同一份台账，拆成两条通道只会漂移。
 * 快照按内容指纹去重（progress.fingerprint）：collect 的每个网络请求都会调一次
 * onProgress，一轮 SEC frames 就是 78 次，不去重等于把界面刷爆；
 * 但指纹必须含 act.label，否则模型活性刷新（只有秒数在变）会被误判成重复而丢掉。
 * onCollected({ meta })：阶段 1 完成，供网页先行渲染。
 * onCoarse(summary)：阶段 2 完成的批次概要。
 * onEvent(e)：模型层事件（降级 / 取数 / 存疑 / 错误），带 scope 区分三段裁决。
 * onVerdictProgress(p)：裁决内部的三段进度（初排 / 深挖 / 终排）。
 *
 * 两个界面共用这一个入口，活动的**呈现**各自决定：
 * 网页渲染成进度条 + 活动明细面板，CLI 打印成逐行日志。
 *
 * 返回 { market, meta, coarse, profiles, verdict, totalMs, file, modelCalls }。
 * 无候选时 verdict 为 null 且 noCandidates 为 true——由调用方决定怎么提示。
 * 活动台账**不落盘**（用户决策 2026-09-24）：它是过程的旁白，不是结论的一部分，
 * 落进快照只会把历史记录撑大而回放用不上。
 */
export async function runMarketMine(market, {
  onStage, onCollected, onCoarse, onProfiles, onEvent, onVerdictProgress,
} = {}) {
  const t0 = Date.now();
  const act = createActivity();
  let lastSnap = '';
  const emit = (phase, text, done, total) => {
    const snap = act.snapshot();
    const fp = `${phase}|${text}|${done ?? ''}|${total ?? ''}|${fingerprint(snap)}`;
    if (fp === lastSnap) return;         // 内容没变就不占一条通道
    lastSnap = fp;
    onStage?.(phase, text, done, total, snap);
  };

  // ── 「此刻在干什么」的唯一写入口 ─────────────────────────────
  // 谁在报什么，就记成台账的一条 + 广播一次阶段事件。台账只增不改，
  // 因此**广播的顺序永远不会回头**——旧实现里「粗筛的某个请求报了一次进度，
  // 把已经跑完的收集阶段又推回进度条上」这类回跳，在结构上就不可能出现。
  const phaseName = (p) => MARKET_PHASES[p - 1] || '裁决';
  const last = { phase: 1, text: '', done: null, total: null };
  /** 重播当前状态。台账新记了一笔就重播一次（见 emit 的注释）。 */
  const refresh = () => emit(last.phase, last.text, last.done, last.total);
  /**
   * 一个单元结束：记下它的产出小结，并让「此刻在干什么」显示这条小结。
   * ——重播的是**小结**而不是结束前那一刻的进度文案：后者会在日志里表现为
   * 「已经进入下一阶段了，进度行却退回上一阶段的中间态」（实测踩过）。
   */
  const finish = (kind, summary, phase = last.phase) => {
    act.close(kind, summary, phaseName(phase));
    if (last.phase === phase) Object.assign(last, { text: summary, done: null, total: null });
    refresh();
  };
  /** 更新「此刻在干什么」；只改文案、不动当前阶段（模型活性走这条）。 */
  const label = (text, { unit = null, key = null } = {}) => {
    if (unit) act.set({ stage: phaseName(last.phase), kind: unit, key: key || text, label: text });
    last.text = text;
    emit(last.phase, text, last.done, last.total);
  };
  /** 进入一个阶段（或报它的进度）。progress 只有在这里才动。 */
  const say = (phase, text, { unit = null, key = null, done = null, total = null } = {}) => {
    if (unit) act.set({ stage: phaseName(phase), kind: unit, key: key || text, label: text, done, total });
    Object.assign(last, { phase, text, done: done ?? null, total: total ?? null });
    emit(phase, text, last.done, last.total);
  };

  // ── 阶段 1 · 全市场信息收集（无淘汰）────────────────────────
  // v0.6：纯市场。自选池是另一条流水线（src/watchRun.js），这里不注入自选票、
  // 不设分组配额；自选票若本身在池内，作为普通市场候选参与粗筛竞争。
  say(1, '全市场信息收集', { unit: 'collect', key: 'start' });
  const { rows, meta } = await collect(market, {
    onProgress: (t, d) => say(1, t, d || {}),
  });
  finish('collect', `收集完成：全市场 ${meta.universe} → 池子 ${meta.pool} 只，耗时 ${(meta.elapsedMs / 1000).toFixed(0)}s`);
  onCollected?.({ meta });

  if (!llmReady()) {
    throw new Error('未检测到模型凭据：机械层已完成收集，模型推理不可用。请 export ANTHROPIC_AUTH_TOKEN 后重启服务。');
  }

  // ── 阶段 2 · 粗筛（A股 6 批 / 美股 5 批，超行数上限的批再切片）──
  say(2, '粗筛');
  const coarse = await coarseScreen(rows, market, {
    caveats: meta.caveats,
    onProgress: (d, t, b) => say(2, `粗筛（${b}）`, { unit: 'coarse', key: `coarse:${b}`, done: d, total: t }),
    onEvent: (e) => { noteEvent(act, e, '粗筛'); refresh(); onEvent?.({ ...e, scope: '粗筛' }); },
  });
  finish('coarse', `粗筛完成：${coarse.calls} 批 → 入围 ${coarse.picks.length} 只`
    + (coarse.results.filter((r) => r.ok === false).length
      ? `（${coarse.results.filter((r) => r.ok === false).length} 批失败）` : ''));
  onCoarse?.({
    calls: coarse.calls,
    picks: coarse.picks.length,
    batches: coarse.results.map((r) => ({
      label: r.label || r.bucket, scanned: r.scanned || 0,
      picked: (r.picks || []).length, note: r.note, ok: r.ok, reason: r.reason,
    })),
  });
  if (!coarse.picks.length) {
    return { market, meta, coarse, profiles: [], verdict: null, noCandidates: true, totalMs: Date.now() - t0, file: null, modelCalls: coarse.calls };
  }

  // ── 阶段 3 · 深度补数（粗筛入围，无淘汰）────────────────────
  say(3, '深度补数');
  const profiles = await deepen(coarse.picks, {
    onProgress: (t, d) => say(3, t, d || {}),
  });
  finish('profile', `补数完成：${profiles.length}/${coarse.picks.length} 只`
    + `（估值区间 / 多区间回撤 / 新闻公告）`);
  onProfiles?.({ count: profiles.length, requested: coarse.picks.length });

  // ── 阶段 4 · 总裁决（三段式：初排点名 → 深挖 → 终排）────────
  // 进度与模型活性都要往外报：一次裁决可能沉默十几分钟，
  // 没有信号时「正常思考」与「已经死了」在界面上完全一样（实测踩过）。
  // 三段各有自己的 key，深挖那段的取数逐个记进台账——「28 次取数花了 12 分钟」
  // 与「模型卡住了 12 分钟」是两件不同的事，界面上必须分得出来（§5.1）。
  // 「此刻在干什么」置为裁决段；真正的进度由下面的 onProgress 不断刷新。
  // 不把这个阶段的上限报成 3 段——裁决的粒度是「第几段 + 取了多少次数」，
  // 而不是「3 段里的第几段」（那会在深挖那段一直停在 2/3，看着像卡住）。
  say(4, '总裁决', { unit: 'model', key: 'verdict' });
  const verdict = await finalVerdict(profiles, {
    rows,                       // 供 get_peers 做同业横截面，零额外请求
    onEvent: (e) => {
      // 三段共用一条通道，scope 由 verdict.js 标注（初排/深挖/终排）
      if (e.type === 'tick') label(e.text, { unit: 'model', key: `tick:${e.key || e.scope}` });
      else if (e.type === 'research') {
        // 联网研究与深挖并行：两者都在动，「此刻」显示最近发生的那一个
        if (e.stage === 'end') act.close('web');
        else label(`${e.text}（已交回 ${e.done}/${e.total}）`, { unit: 'web', key: 'research' });
        noteEvent(act, e, '联网'); refresh(); onEvent?.(e);
      } else { noteEvent(act, e, e.scope || '裁决'); refresh(); onEvent?.(e); }
    },
    onProgress: (p) => {
      const nm = { shortlist: '初排点名', deep: '深挖', final: '终排' }[p.phase] || '总裁决';
      if (p.phase === 'shortlist' && p.done === 1) {
        act.close('model', `初排完成：点名 ${p.picks ?? 0} 只待深挖`, '裁决');
      } else if (p.phase === 'deep' && p.done === 2) {
        act.close('model', p.skipped ? '初排未点名，深挖跳过' : `深挖${p.ok ? '完成' : '未完成'}（${p.picks ?? 0} 只）`, '裁决');
      }
      // 三段是串行的，这里不做 done/total 显示：深挖那段可能十几分钟，
      // 一个停在 2/3 的进度条比没有更糟（看着像卡死）。改用「段名 + 取数次数」。
      label(p.picks != null ? `${nm}（${p.picks} 只）` : nm);
      refresh();          // 三段的收尾刚记进台账，立刻广播出去
      onVerdictProgress?.(p);
    },
  });
  if (verdict?.ok) {
    const below = verdict.top.filter((x) => x.meetsBar === false).length;
    finish('model', `裁决完成：Top ${verdict.top.length} 只${below ? `（其中机制补位 ${below} 只）` : ''}`
      + `（取数 ${verdict.toolCalls || 0} 次${verdict.toolsDisabled ? '，本轮工具不可用' : ''}`
      + `${verdict.research ? `，联网研究交回 ${verdict.research.findings.length}/${verdict.research.requested} 只` : ''}）`);
  }

  const modelCalls = coarse.calls + (verdict?.calls ?? 1);

  // 落盘：裁决失败的不落盘——一份 top 全空的快照只会污染历史与回放。
  // （对齐 src/watchRun.js；此前市场这条两个入口都是无条件写）
  let file = null;
  if (verdict?.ok) {
    try {
      file = saveMine(buildMinePayload({
        scope: 'market', market, meta, coarse, profiles, verdict,
        totalMs: Date.now() - t0, modelCalls,
      }));
    } catch {}
  }

  return { market, meta, coarse, profiles, verdict, totalMs: Date.now() - t0, file, modelCalls };
}
