// 轮次活动台账（SYSTEM_DEFINITION §5.1）。
//
// 进度条此前只有阶段名——「收集 / 粗筛 / 补数 / 裁决」在跑，但**具体在干什么看不到**：
// 一次市场挖掘里有 78 次 SEC frames 请求、45 只新闻检索、28 次模型取数、若干次降级，
// 界面上却从头到尾显示「阶段1 · 全市场信息收集」。用户提的正是这一点。
//
// 本模块把「阶段」细化成两样东西：
//   1. **此刻在做什么**（label + done/total）——顶在进度条下面，裁决静默十几分钟时也一直在动
//   2. **过程台账**（一次性事件 + 各阶段产出小结）——折叠面板与 CLI 逐行同步
//
// 它**只管记账，不碰传输**：快照由编排层附在 stage 事件上（marketRun.js / watchRun.js），
// CLI 与网页各自决定怎么渲染。计数也在这里算，前端只显示不推算——数字只有一个来源。
//
// **不落盘**（用户决策 2026-09-24）：活动流是过程的旁白，不是结论的一部分。
// 落盘会把快照撑大（数百条与结论无关的行），而回放要的是漏斗与榜单，不是中途进度。
//
// 两种计数方式，按单元有没有固有进度选：
//   - 有 done/total 的（新闻检索、深度补数、粗筛、SEC frames）：直接记进度值
//   - 没有的（拉清单、拉行情、模型三段）：按**去重后的单元标识**计数，同一单元反复刷新不重复计
// 两者都取 max 合并，因此计数**单调不减**——刷屏式的 tick 不会把数字刷小。

/**
 * 快照指纹（去重判据）。**必须包含 act.label**：模型活性刷新时计数与台账都不变，
 * 变的只有「已 42s」这个秒数——指纹漏掉它，界面就会在裁决那十几分钟里彻底不动，
 * 而那正是本轮要修的毛病。约 2s 一条，可接受。
 */
export const fingerprint = (snap) => [
  snap.act?.stage ?? '', snap.act?.label ?? '',
  snap.counters, snap.recent.at(-1)?.seq ?? 0,
].join('\u0000');

/** kind → 计数摘要里的短名。数组顺序即摘要里的显示顺序。 */
const COUNTER_NAMES = [
  ['collect', '源'], ['news', '新闻'], ['profile', '补数'], ['coarse', '粗筛'],
  ['model', '模型调用'], ['tool', '取数'], ['web', '联网'],
  ['fallback', '降级'], ['suspect', '存疑'], ['error', '错误'],
];

/** 台账上限。一轮跑久了事件会积累，它是旁白不是审计日志，丢最旧的即可。 */
const MAX_TIMELINE = 200;
/** 快照里回带的时间线条数。前端按 seq 去重追加，重复无所谓，但没必要每次全发。 */
const RECENT = 8;

/**
 * 模型层事件 → 台账的一笔（§5.1）。**不改变当前阶段**——降级是旁白，
 * 当前阶段仍由发事件的那一段自己报。'tick' 不走这里（它由调用方直接 set 当前单元）。
 */
export function noteEvent(act, e, stage) {
  if (!e || e.type === 'tick') return;
  if (e.type === 'tool') {
    act.note('tool', `取数 ${e.used ?? ''} ${e.name || ''}${e.input?.code ? ` ${e.input.code}` : ''}（${e.chars ?? 0} 字${e.truncated ? '，已截断' : ''}）`, { stage });
    return;
  }
  // 联网研究员（v0.11.0）：搜索 / 读网页 / 交回结论逐条记账；启动与收尾也记，
  // 「研究员跑了 20 分钟交回 3 只」与「研究员根本没起来」在台账里必须分得出来
  // 计数只数「搜索 + 读网页」这两种实际的联网动作；启动、交回、收尾只进台账不计数
  if (e.type === 'research') {
    act.note(['search', 'fetch'].includes(e.stage) ? 'web' : 'web-status', e.text || '联网研究', { stage });
    return;
  }
  if (e.type === 'fallback') {
    act.note('fallback', `降级：${e.scope || ''} ${e.from} → ${e.to}（${String(e.why || '').slice(0, 60)}）`, { stage });
    return;
  }
  if (e.type === 'tools-disabled') {
    act.note('error', `取数工具不可用（渠道不支持）：${String(e.reason || '').slice(0, 60)}`, { stage });
    return;
  }
  if (e.type === 'suspect') {
    act.note('suspect', `数字无法追溯：${(e.values || []).join('、')}`, { stage });
    return;
  }
  if (e.type === 'error') {
    act.note('error', `错误：${String(e.message || '').slice(0, 80)}`, { stage });
  }
}

export function createActivity({ now = Date.now } = {}) {
  const t0 = now();
  const open = new Map();       // kind → 进行中的单元 { stage, label, done, total, at }
  const seen = new Map();       // kind → Set(单元标识)
  const tally = new Map();      // kind → 已完成量（单调不减）
  const summaries = new Map();  // stage → 该阶段的一行产出小结
  const timeline = [];
  let seq = 0;
  let lastKey = null;           // 最近一次 set 的 kind，即「此刻」所指

  const record = (stage, kind, text) => {
    seq += 1;
    // ms 是**相对本轮起跑**的偏移：界面上的每条台账因此自带时间轴，
    // 不必去跟客户端时钟对齐（两者本来就不同步）。
    timeline.push({ seq, stage: stage ?? null, kind, text, ms: now() - t0 });
    if (timeline.length > MAX_TIMELINE) timeline.splice(0, timeline.length - MAX_TIMELINE);
  };

  /** 计数取 max 合并：进度值、去重单元数、显式 bump 三者谁大用谁。 */
  const raise = (kind, n) => {
    const v = Math.max(tally.get(kind) || 0, n || 0);
    tally.set(kind, v);
    return v;
  };

  return {
    /**
     * 更新「此刻在做什么」。同一 kind 反复调用只覆盖当前单元，不重复计数。
     * key 是**单元的标识**（如 'shortlist' / 批次名），label 是可以随时刷新的显示文本
     * （如「模型思考中（已 42s）」）——两者必须分开，否则刷新的秒数会被当成新单元重复计数。
     */
    set({ stage = null, kind, key = null, label, done = null, total = null } = {}) {
      if (!kind) return;
      const id = String(key ?? label ?? kind);
      if (!seen.has(kind)) seen.set(kind, new Set());
      seen.get(kind).add(id);
      raise(kind, Math.max(done ?? 0, seen.get(kind).size));
      open.set(kind, { stage, label, done, total, at: now() });
      lastKey = kind;
    },

    /** 纯计数（取数次数这类没有固有进度的）。 */
    bump(kind, n = 1) {
      raise(kind, (tally.get(kind) || 0) + n);
    },

    /**
     * 一次性事件：降级 / 存疑 / 错误 / 工具不可用。
     * 计数 + 写台账，不做别的——它**不该**改变当前阶段，只是记一笔。
     */
    note(kind, text, { stage = null } = {}) {
      this.bump(kind);
      record(stage, kind, text);
    },

    /**
     * 一个单元结束。text 为可选的一行产出小结：写入台账，并记为**该阶段的摘要**
     * （进度条上已完成的阶段显示它，一行就是漏斗的一节）。
     *
     * stage 可以显式给：同一 kind 在一个阶段里可能**多段**结束（市场裁决的
     * 初排/深挖/终排都是 'model'），第一段 close 后 open 里就没有它了，
     * 只靠当前单元会让后面几段的小结记到 stage=null 上。
     */
    close(kind, text = null, stage = null) {
      const e = open.get(kind);
      open.delete(kind);
      if (lastKey === kind) lastKey = [...open.keys()].pop() || null;
      if (!text) return;
      const st = stage ?? e?.stage ?? null;
      if (st) summaries.set(st, text);
      record(st, kind, text);
    },

    /** 计数摘要，如「源 6 · 新闻 45 · 补数 45 · 模型调用 3 · 取数 28」。 */
    counters() {
      return COUNTER_NAMES
        .filter(([k]) => (tally.get(k) || 0) > 0)
        .map(([k, name]) => `${name} ${tally.get(k)}`)
        .join(' · ');
    },

    /** 给传输用的一次性快照。前端不做推算，只显示这里给出的东西。 */
    snapshot() {
      const cur = lastKey ? open.get(lastKey) : null;
      return {
        act: cur ? { stage: cur.stage, label: cur.label, done: cur.done, total: cur.total } : null,
        // 并行度：模型三段是串行的，但阶段 1 的多路拉取与粗筛的多批是并行的
        openCount: open.size,
        counters: this.counters(),
        elapsedMs: now() - t0,
        summaries: Object.fromEntries(summaries),
        recent: timeline.slice(-RECENT),
      };
    },

    /** 完整台账（CLI 打印与测试用；不落盘）。 */
    timeline: () => timeline.map((e) => e.text),
  };
}
