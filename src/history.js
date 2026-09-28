// 历史记录存储层：全市场挖掘与单股分析统一落盘、分组、标记保留、次日清理。
// CLI 与 server 共用——此前 mine.js 内联落盘、server 压根不写，导致网页跑的结果全丢。
//
// 保留策略（用户决策）：
//   同日多次运行**全部保留**，用户手动标记保留哪一条；次日清理未标记的。
//   未标记时默认保留当天最后一次。清理只针对**过去的日期**，当天永不动——
//   用户随时可以改主意。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.js';
import { compactAnchors } from './valuation.js';

export const SNAP_DIR = path.join(ROOT, 'snapshots');
const INDEX = path.join(SNAP_DIR, '_index.json');

const today = () => new Date().toISOString().slice(0, 10);
const ensure = () => fs.mkdirSync(SNAP_DIR, { recursive: true });
const stamp = () => new Date().toTimeString().slice(0, 8).replace(/:/g, '');

/** 代码里可能有 . / 等字符（BRK.A、06862.HK），落盘前清洗成安全文件名。 */
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return { items: [] }; }
}

function writeIndex(items) {
  ensure();
  const seen = new Set();
  const merged = items
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .filter((x) => x.file && !seen.has(x.file) && seen.add(x.file));
  try { fs.writeFileSync(INDEX, JSON.stringify({ items: merged }, null, 1)); } catch {}
  return merged;
}

function upsert(entry) {
  const items = readIndex().items.filter((x) => x.file !== entry.file);
  items.push(entry);
  return writeIndex(items);
}

// ── 落盘 payload 组装 ─────────────────────────────────
// mine.js 与 server.js 此前各写一份完全相同的组装逻辑，抽到这里只写一次。

/**
 * 组装一次挖掘的完整记录。
 * 关键：粗筛的 picks 必须保留模型的推理（why / guess / checkNext），
 * 此前只存了代码数组，等于把「模型是怎么从 4413 只收敛过来的」整段丢掉。
 * scope：'market'（全市场四阶段）或 'watch'（自选池三阶段）。两种榜各自成组、
 * 互不覆盖——同一天两条流水线都跑过，历史里要能各留各的。
 * watch：自选池当轮状态（规模/并入/未找到/补数失败），供前端与复盘（§7）用。
 */
export function buildMinePayload({ market, scope = 'market', meta, coarse, profiles, verdict, totalMs, modelCalls, watch }) {
  return {
    market, scope, at: new Date().toISOString(), totalMs, modelCalls, meta,
    // 粗筛调用数单独落盘。此前前端用 modelCalls-1 反推，而 v0.7.2 起裁决是
    // 三段而非 1 段，反推会算错——把分子直接存下来，不让读者做减法。
    coarseCalls: coarse?.calls ?? null,
    watch: watch || null,
    coarse: (coarse?.results || []).map((r) => ({
      bucket: r.bucket, label: r.label || r.bucket, scanned: r.scanned ?? null,
      note: r.note || null, model: r.model || null, ok: r.ok !== false, reason: r.reason || null,
      picks: (r.picks || []).map((p) => ({
        code: p.row?.code || p.code, name: p.row?.name || p.name || null,
        why: p.why || null, guess: p.guess || null, checkNext: p.checkNext || null,
      })),
    })),
    top: verdict?.top || [], rejected: verdict?.rejected || [],
    // 本轮的榜单下限（v0.9.0）。补位条目的「为什么进榜」要能说出「至少几只」，
    // 而下限可被环境变量改、会被池子大小截断，回放时不能拿当前配置去猜
    minN: verdict?.minN ?? null,
    note: verdict?.note || null, model: verdict?.model || null,
    // 分层数字规则的 L3：模型基于自身知识的判断与质疑（§5.3）
    externalNotes: verdict?.externalNotes || [],
    // 取数留痕。**只存元信息，不存返回正文**——正文会把快照撑到不可用
    // （本文件对 seriesRows 也是这么处理的）。
    toolLog: verdict?.toolLog || [],
    toolCalls: verdict?.toolCalls ?? 0,
    toolsDisabled: verdict?.toolsDisabled || undefined,
    // 本轮状态（v0.11.3）。此前这些只活在内存里：回放出来的榜单看不出
    // 「模型有数字存疑」「预算用尽」「有几批整批失败」「有几只根本没被回答」——
    // 而这几件事恰恰决定该不该信这张榜。
    suspectNumbers: verdict?.suspectNumbers?.length ? verdict.suspectNumbers : undefined,
    budgetExhausted: verdict?.budgetExhausted || undefined,
    batchFailed: verdict?.batchFailed?.length ? verdict.batchFailed : undefined,
    unanswered: verdict?.unanswered || undefined,
    promoted: verdict?.promoted?.length ? verdict.promoted : undefined,
    shortlist: verdict?.shortlist ?? undefined,
    // 市场裁决的三段式概要（初排点名几只 / 深挖是否完成）。复盘时要能看出
    // 某一轮的榜单到底有没有深挖支撑——深挖失败是允许的，但不能看不出来。
    phases: verdict?.phases || undefined,
    // 联网研究（v0.11.0）：逐只结论与计数。结论本身是短文本（概要、驱动、带链接的事件），
    // 网页正文一个字都不进快照——与 toolLog 同一原则
    research: verdict?.research || undefined,
    candidates: (profiles || []).map((p) => ({
      code: p.code, name: p.name, industry: p.industry, price: p.price,
      // v0.10.0 起没有「主口径」：全部锚都存，模型选了哪个在 top/rejected 的 valuation 里。
      // pv/tier 只在旧快照里有（按周期规则选的单一口径），回放时继续认
      anchors: p.anchors ? compactAnchors(p.anchors) : undefined,
      // 反算口径说明（v0.11.3）：拆股是否折算过、PB 是否只有年报净资产。它决定这组分位可不可信
      seriesNotes: p.seriesNotes || undefined,
      seriesSource: p.seriesSource || undefined,
      pv: p.band?.pv ?? null, tier: p.band?.tier?.name ?? null, fScore: p.fScore,
      drawdowns: p.drawdowns,
      // 回撤口径（§2.6）。旧快照没有这个字段 → 回放时按「旧口径（未复权）」提示，
      // 否则历史与新数据会静默混口径。
      priceSeries: p.priceSeries || null,
      isWatch: !!p.isWatch || null,
      outOfPool: !!p.outOfPool || null,   // 回看时仍要能看到「不在挖掘池内」的口径提醒
      coarseGuess: p.coarseGuess || null,
      coarseWhy: p.coarseWhy || null,        // 此前丢失
      checkNext: p.checkNext || null,        // 此前丢失
    })),
  };
}

// ── 保存 ──────────────────────────────────────────────

/**
 * 保存一次挖掘（市场或自选池）。文件名带时间戳，同日多次并存，由用户标记保留哪条。
 * 自选榜与市场榜分属不同 group：次日清理按组去重，混在一起会让当天的自选记录
 * 被市场记录顶掉（或反过来）。
 */
export function saveMine(payload) {
  ensure();
  const date = today();
  const scope = payload.scope === 'watch' ? 'watch' : 'market';
  const group = `mine-${scope === 'watch' ? 'watch-' : ''}${payload.market}-${date}`;
  const file = `${group}-${stamp()}.json`;
  const body = { kind: 'mine', date, group, ...payload };
  fs.writeFileSync(path.join(SNAP_DIR, file), JSON.stringify(body, null, 1));
  upsert({
    file, kind: 'mine', date, group, keep: false,
    at: body.at || new Date().toISOString(),
    market: payload.market, scope,
    rejected: payload.rejected?.length || 0,
    top: payload.top?.length || 0,
    belowBar: (payload.top || []).filter((x) => x.meetsBar === false).length,
    candidates: payload.candidates?.length || 0,
    totalMs: payload.totalMs ?? null,
    modelCalls: payload.modelCalls ?? null,
    model: payload.model || null,
  });
  return file;
}

/**
 * 保存一次单股分析。
 * 必须剥掉 seriesRows：逐日估值序列 2111 行占 179KB，落盘与前端都用不到，
 * 剥掉后整条记录约 5KB。
 */
export function saveStock({ result, attribution }) {
  ensure();
  const date = today();
  const s = result?.stock || {};
  const group = `stock-${safe(s.code)}-${date}`;
  const file = `${group}-${stamp()}.json`;
  const { seriesRows, ...slim } = result || {};
  const body = {
    kind: 'stock', date, group, at: new Date().toISOString(),
    code: s.code, name: s.name, market: s.market, industry: s.industry,
    result: slim, attribution: attribution || null,
  };
  fs.writeFileSync(path.join(SNAP_DIR, file), JSON.stringify(body, null, 1));
  upsert({
    file, kind: 'stock', date, group, keep: false, at: body.at,
    code: s.code, name: s.name, market: s.market, industry: s.industry,
    price: result?.price ?? null,
    tier: result?.tier?.name || null,
    // 模型选了锚就用它的安全边际；否则退回机械默认口径（v0.10.0）
    mos: attribution?.valuation?.mos ?? result?.mos?.actual ?? null,
    attribution: attribution?.ok ? attribution.category : null,
    isTrap: attribution?.ok ? !!attribution.isTrap : null,
    hasLlm: !!attribution?.ok,
  });
  return file;
}

// ── 标记与清理 ────────────────────────────────────────

/** 标记保留某条；同 group 内其余取消标记（单选语义）。 */
export function markKeep(name) {
  const items = readIndex().items;
  const target = items.find((x) => x.file === name);
  if (!target) throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND' });
  for (const x of items) {
    if (x.group === target.group) x.keep = x.file === name;
  }
  return writeIndex(items);
}

/**
 * 清理过去日期的重复记录。
 * 只处理 date < 今天的 group——当天的永远不动，用户随时可改主意。
 * 有标记则留标记那条；全组无标记则留 at 最大的一条（当天最后一次）。
 */
export function pruneOldGroups() {
  const items = readIndex().items;
  const t = today();
  const byGroup = new Map();
  for (const x of items) {
    if (!x.group || !x.date || x.date >= t) continue;   // 当天、无分组（早期记录）都不动
    if (!byGroup.has(x.group)) byGroup.set(x.group, []);
    byGroup.get(x.group).push(x);
  }
  const doomed = new Set();
  for (const [, group] of byGroup) {
    if (group.length < 2) continue;
    const kept = group.find((x) => x.keep)
      || group.slice().sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    for (const x of group) if (x.file !== kept.file) doomed.add(x.file);
  }
  if (!doomed.size) return items;
  for (const f of doomed) {
    try { fs.unlinkSync(path.join(SNAP_DIR, f)); } catch {}
  }
  return writeIndex(items.filter((x) => !doomed.has(x.file)));
}

// ── 读取 ──────────────────────────────────────────────

/**
 * Timeline 列表。入口处顺带做次日清理——这是唯一必然被调用的位置
 * （网页加载、每次任务完成都会拉列表）。
 * 索引缺失时扫描目录补齐（兼容早期 CLI 直接写盘的旧文件）。
 */
export function listHistory({ limit = 200 } = {}) {
  ensure();
  let files = [];
  try { files = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.json') && f !== '_index.json'); } catch {}

  const idx = readIndex().items;
  const known = new Set(idx.map((x) => x.file));
  const extras = [];
  for (const f of files) {
    if (known.has(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8'));
      const date = d.date || (d.at || '').slice(0, 10);
      // 旧快照（cn-2026-09-14-<ts>.json）无 group：归入以文件名为键的独立组，
      // 组内只有它自己，因此永远不会被清理掉。
      const group = d.group || f.replace(/\.json$/, '');
      if (d.kind === 'stock' || f.startsWith('stock-')) {
        extras.push({ file: f, kind: 'stock', date, group, keep: false, at: d.at,
          code: d.code, name: d.name, market: d.market, industry: d.industry,
          price: d.result?.price ?? null, tier: d.result?.tier?.name || null,
          mos: d.attribution?.valuation?.mos ?? d.result?.mos?.actual ?? null,
          attribution: d.attribution?.category || null, hasLlm: !!d.attribution?.ok });
      } else {
        extras.push({ file: f, kind: 'mine', date, group, keep: false, at: d.at,
          market: d.market, scope: d.scope === 'watch' ? 'watch' : 'market',
          top: d.top?.length || 0, candidates: d.candidates?.length || 0,
          belowBar: (d.top || []).filter((x) => x.meetsBar === false).length,
          rejected: d.rejected?.length || 0,
          totalMs: d.totalMs ?? null, modelCalls: d.modelCalls ?? null, model: d.model || null });
      }
    } catch {}
  }
  if (extras.length) writeIndex([...idx, ...extras]);
  else {
    const alive = idx.filter((x) => files.includes(x.file));
    if (alive.length !== idx.length) writeIndex(alive);
  }

  const after = pruneOldGroups();
  // groupCount 供前端决定是否显示星标——只有同组多于一条才需要用户选。
  // 早期记录没有 group 字段：必须以文件名兜底，否则它们会共用 undefined 这个键
  // 被算成同一组（实测 5 条互不相干的旧记录被显示为「group内 5 条」）。
  const gid = (x) => x.group || x.file;
  const counts = {};
  for (const x of after) counts[gid(x)] = (counts[gid(x)] || 0) + 1;
  return after.slice(0, limit).map((x) => ({
    ...x, keep: !!x.keep, group: gid(x), groupCount: counts[gid(x)] || 1,
  }));
}

/** 读取单条记录。路径穿越防护在此集中处理，调用方无需重复。 */
export function readHistory(name) {
  const file = path.join(SNAP_DIR, String(name || ''));
  if (!file.startsWith(SNAP_DIR + path.sep) || !String(name).endsWith('.json')) {
    throw Object.assign(new Error('非法的记录名'), { code: 'BAD_NAME' });
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
