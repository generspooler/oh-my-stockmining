// 自选池裁决归一化（normalizeReview）的回归测试。
//
// 这里的铁律只有一条，但它是整个自选榜的意义所在：
// **池内每一只票，跑完一轮都必须能在结果里找到自己**（top 或 rejected）。
// 破掉不会报错——用户只会看到自己加的票凭空消失，还以为是「没问题」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReview, completeCoverage, splitForReview, normalizeExternal, promoteForFloor,
} from '../src/review.js';

const profiles = (...codes) => codes.map((c) => ({ code: c, name: c, isWatch: true }));
const codesOf = (arr) => arr.map((x) => String(x.code).toUpperCase());

test('池内每只都有归属：模型漏报的被补进落选区并标 unanswered', () => {
  const p = profiles('AAA', 'BBB', 'CCC', 'DDD');
  // 模型只提了两只，CCC / DDD 整个没出现
  const out = normalizeReview({ top: [{ code: 'AAA' }], rejected: [{ code: 'BBB', why: '估值已修复' }] }, p, { topN: 8, minN: 0 });
  const covered = new Set([...codesOf(out.top), ...codesOf(out.rejected)]);
  assert.deepEqual([...covered].sort(), ['AAA', 'BBB', 'CCC', 'DDD']);
  const un = out.rejected.filter((x) => x.unanswered);
  assert.deepEqual(codesOf(un), ['CCC', 'DDD']);
  assert.ok(un[0].why.includes('没有对这只给出结论'), '补进来的要写明是「没被回答」而不是「没问题」');
});

test('top 截到 topN，被挤出的票带原因落进落选区（它有结论，不能标成「模型未给结论」）', () => {
  const p = profiles('A', 'B', 'C');
  const out = normalizeReview({
    top: [{ code: 'A' }, { code: 'B' }, { code: 'C', thesis: '第三只也达标。后面不重要。' }], rejected: [],
  }, p, { topN: 2, minN: 0 });
  assert.deepEqual(codesOf(out.top), ['A', 'B']);
  assert.deepEqual(codesOf(out.rejected), ['C']);
  assert.equal(out.rejected[0].unanswered, undefined);
  assert.equal(out.rejected[0].stance, '达标但超出席位');
  assert.ok(out.rejected[0].why.includes('第三只也达标。'), '带上模型给它的第一句逻辑');
});

test('幻觉代码被丢弃，不污染两个区', () => {
  const p = profiles('AAA');
  const out = normalizeReview({
    top: [{ code: 'ZZZ' }],
    rejected: [{ code: 'YYY', why: '不存在的票' }, { code: 'AAA', why: '真的' }],
  }, p, { topN: 8, minN: 0 });
  assert.deepEqual(out.top, []);
  assert.deepEqual(codesOf(out.rejected), ['AAA']);
});

test('同一只既进 top 又被写进 rejected 时，以 top 为准（不重复出现）', () => {
  const p = profiles('AAA', 'BBB');
  const out = normalizeReview({
    top: [{ code: 'AAA' }],
    rejected: [{ code: 'AAA', why: '模型自相矛盾' }, { code: 'BBB', why: '正常落选' }],
  }, p, { topN: 8, minN: 0 });
  assert.deepEqual(codesOf(out.top), ['AAA']);
  assert.deepEqual(codesOf(out.rejected), ['BBB']);
});

test('落选条目重复出现只留一条', () => {
  const p = profiles('AAA');
  const out = normalizeReview({ top: [], rejected: [{ code: 'AAA', why: '一' }, { code: 'aaa', why: '二' }] }, p, { topN: 8, minN: 0 });
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].why, '一');
});

test('下限关掉（minN=0）时 top 为空仍是合法结论：全池落选，一只都不丢', () => {
  const p = profiles('A', 'B');
  const out = normalizeReview({
    top: [],
    rejected: [{ code: 'A', why: '贵', stance: '估值已修复' }, { code: 'B', why: '衰退', stance: '疑似价值陷阱', suggestRemove: true }],
  }, p, { topN: 8, minN: 0 });
  assert.deepEqual(out.top, []);
  assert.deepEqual(codesOf(out.rejected), ['A', 'B']);
  assert.equal(out.rejected[1].suggestRemove, true, '建议移出的标记要透传到渲染层');
});

test('非标准 stance 原样保留并打标，不丢结论（与归因类别同一取向）', () => {
  const p = profiles('A');
  const out = normalizeReview({ top: [], rejected: [{ code: 'A', why: 'x', stance: '需要再观察' }] }, p, { topN: 8, minN: 0 });
  assert.equal(out.rejected[0].stance, '需要再观察');
  assert.equal(out.rejected[0].stanceUnmatched, true);
});

test('缺 stance 的落选条目落到「未归类」，不变成 undefined 渲染成空白', () => {
  const p = profiles('A');
  const out = normalizeReview({ top: [], rejected: [{ code: 'A', why: 'x' }] }, p, { topN: 8, minN: 0 });
  assert.equal(out.rejected[0].stance, '未归类');
  assert.equal(out.rejected[0].suggestRemove, false);
});

test('模型整份输出为空时，全池落到 unanswered——绝不静默返回空结果', () => {
  const p = profiles('A', 'B', 'C');
  const out = normalizeReview({}, p, { topN: 8, minN: 0 });
  assert.equal(out.top.length, 0);
  assert.equal(out.rejected.length, 3);
  assert.ok(out.rejected.every((x) => x.unanswered));
});

// ── 榜单 5~10 席（v0.9.0，用户决策 2026-09-26）──────────────────
// 达标的最多 10 只；不足 5 只时用「最接近达标」的补位，补位逐只标 meetsBar=false。

test('榜单下限：模型只给 3 只达标时，按落选区次序由代码补到 5 只并标注', () => {
  const p = profiles('A', 'B', 'C', 'D', 'E', 'F', 'G');
  const out = normalizeReview({
    top: [{ code: 'A' }, { code: 'B' }, { code: 'C' }],
    rejected: [
      { code: 'D', why: '最接近：好生意但不够便宜', stance: '估值已修复', keyData: 'P/V 0.94' },
      { code: 'E', why: '其次：便宜但待验证', stance: '基本面待验证' },
      { code: 'F', why: '较远' }, { code: 'G', why: '最远' },
    ],
  }, p, { topN: 10, minN: 5 });
  assert.deepEqual(codesOf(out.top), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(out.top.map((x) => x.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(out.top.map((x) => x.meetsBar), [true, true, true, false, false]);
  const d = out.top[3];
  assert.equal(d.filledBy, 'code', '代码补的要看得出来：它没有完整投资逻辑');
  assert.equal(d.belowBarReason, '最接近：好生意但不够便宜', '差在哪 = 模型给它的落选理由');
  assert.equal(d.keyData, 'P/V 0.94');
  assert.deepEqual(codesOf(out.rejected), ['F', 'G'], '补进榜的从落选区移走，不重复出现');
});

test('榜单下限：模型自己标了补位（meetsBar=false）时照单全收，不再由代码补', () => {
  const p = profiles('A', 'B', 'C', 'D', 'E', 'F');
  const out = normalizeReview({
    top: [
      { code: 'A' }, { code: 'B' }, { code: 'C' },
      { code: 'D', meetsBar: false, belowBarReason: '差在估值' },
      { code: 'E', meetsBar: 'false', belowBarReason: '差在催化' },
    ],
    rejected: [{ code: 'F', why: '贵' }],
  }, p, { topN: 10, minN: 5 });
  assert.deepEqual(codesOf(out.top), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(out.top.map((x) => x.meetsBar), [true, true, true, false, false]);
  assert.ok(out.top.every((x) => x.filledBy === undefined), '模型自己补的不是代码补位');
  assert.deepEqual(codesOf(out.rejected), ['F']);
});

test('榜单下限：补位的一律排在达标的后面，即便模型把它排在前面', () => {
  const p = profiles('A', 'B', 'C', 'D', 'E');
  const out = normalizeReview({
    top: [{ code: 'A', meetsBar: false }, { code: 'B' }, { code: 'C' }, { code: 'D' }, { code: 'E' }],
    rejected: [],
  }, p, { topN: 10, minN: 5 });
  assert.deepEqual(codesOf(out.top), ['B', 'C', 'D', 'E', 'A']);
  assert.equal(out.top[4].meetsBar, false);
});

test('榜单下限：达标已够 5 只时，不达标的一只都不留，带理由放回落选区', () => {
  const p = profiles('A', 'B', 'C', 'D', 'E', 'F', 'G');
  const out = normalizeReview({
    top: [
      { code: 'A' }, { code: 'B' }, { code: 'C' }, { code: 'D' }, { code: 'E' }, { code: 'F' },
      { code: 'G', meetsBar: false, belowBarReason: '差在估值', stance: '估值已修复' },
    ],
    rejected: [],
  }, p, { topN: 10, minN: 5 });
  assert.deepEqual(codesOf(out.top), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.ok(out.top.every((x) => x.meetsBar === true));
  assert.deepEqual(codesOf(out.rejected), ['G']);
  assert.equal(out.rejected[0].why, '差在估值');
  assert.equal(out.rejected[0].stance, '估值已修复');
  assert.equal(out.rejected[0].unanswered, undefined, '它有结论，不能落成「模型未给结论」');
});

test('榜单下限：池子不足 5 只时下限降为池子大小，全员进榜', () => {
  const p = profiles('A', 'B', 'C');
  const out = normalizeReview({ top: [{ code: 'A' }], rejected: [{ code: 'B', why: 'b' }, { code: 'C', why: 'c' }] }, p, { topN: 10, minN: 5 });
  assert.deepEqual(codesOf(out.top), ['A', 'B', 'C']);
  assert.deepEqual(out.rejected, []);
});

test('榜单下限：模型整份输出为空时，没有可补的来源，全池落到 unanswered', () => {
  const p = profiles('A', 'B');
  const out = normalizeReview({}, p, { topN: 10, minN: 5 });
  assert.deepEqual(out.top, [], '代码只从模型给过结论的票里补，绝不凭空推一只进榜');
  assert.ok(out.rejected.every((x) => x.unanswered));
});

test('promoteForFloor：各批轮流补人，每批先取排最前（最接近达标）的', () => {
  const b1 = [{ code: 'A1' }, { code: 'A2' }, { code: 'A3' }];
  const b2 = [{ code: 'B1' }, { code: 'B2' }];
  assert.deepEqual(promoteForFloor([b1, b2], new Set(), 3), ['A1', 'B1', 'A2']);
});

test('promoteForFloor：疑似陷阱与建议移出的排到最后才用；已入围的跳过；不需要时不补', () => {
  const b1 = [{ code: 'T', stance: '疑似价值陷阱' }, { code: 'A' }];
  const b2 = [{ code: 'R', suggestRemove: true }, { code: 'P' }, { code: 'B' }];
  assert.deepEqual(promoteForFloor([b1, b2], new Set(['P']), 3), ['A', 'B', 'T']);
  assert.deepEqual(promoteForFloor([b1, b2], new Set(), 0), []);
  assert.deepEqual(promoteForFloor([b1, b2], new Set(), -2), []);
  assert.deepEqual(promoteForFloor([], new Set(), 3), []);
});

// ── 分批裁决（v0.6.1）────────────────────────────────────────────
// 43 只一次写 43 份结论，实测模型思考 15 分钟后正文为空。分批后每次输出量恒定。

test('splitForReview：不超阈值就不分批', () => {
  assert.equal(splitForReview(profiles('A', 'B'), 15).length, 1);
  assert.deepEqual(splitForReview([], 15), []);
});

test('splitForReview：切成数量均衡的批，不出现「14 只 + 1 只」', () => {
  const rows = Array.from({ length: 16 }, (_, i) => ({ code: 'C' + i, sector: '科技' }));
  const b = splitForReview(rows, 15);
  assert.equal(b.length, 2);
  assert.deepEqual(b.map((x) => x.length), [8, 8], '均衡切分，不为 1 只票单独花一次调用');
});

test('splitForReview：43 只按 15 切成 3 批且一只不丢', () => {
  const rows = Array.from({ length: 43 }, (_, i) => ({ code: 'C' + i, sector: i < 28 ? '科技' : '医药' }));
  const b = splitForReview(rows, 15);
  assert.deepEqual(b.map((x) => x.length), [15, 15, 13]);
  assert.equal(b.flat().length, 43);
  assert.equal(new Set(b.flat().map((x) => x.code)).size, 43, '无重复');
});

test('splitForReview：同行业聚在一起（批内横向比较才有意义）', () => {
  const rows = [
    { code: 'A', sector: '科技' }, { code: 'B', sector: '医药' },
    { code: 'C', sector: '科技' }, { code: 'D', sector: '医药' },
  ];
  const b = splitForReview(rows, 2);
  assert.ok(b.every((batch) => new Set(batch.map((x) => x.sector)).size === 1), '每批同行业');
});

test('completeCoverage：整批失败时那一批的票被兜住，不凭空消失', () => {
  const all = profiles('A', 'B', 'C', 'D');
  // 只有第一批返回了结论，第二批整批失败
  const merged = completeCoverage([{ code: 'A' }], [{ code: 'B', why: '落选' }], all);
  assert.deepEqual(codesOf(merged), ['B', 'C', 'D']);
  assert.deepEqual(merged.filter((x) => x.unanswered).map((x) => x.code), ['C', 'D']);
});

test('completeCoverage：合并两段来源时按代码去重（终裁 + 各批落选）', () => {
  const all = profiles('A', 'B');
  const merged = completeCoverage([], [{ code: 'A', why: '终裁给的' }, { code: 'a', why: '批里给的' }], all);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].why, '终裁给的', '先到的那条留下');
  assert.equal(merged[1].unanswered, true, 'B 没人给结论 → 兜底');
});

// ── 分层数字规则 L3：externalNotes 归一化 ──────────────────────────

test('normalizeExternal：无 code 的整体性判断保留（不属于某一只票）', () => {
  const known = new Map([['AAA', { code: 'AAA' }]]);
  const out = normalizeExternal([{ claim: '整个行业的库存周期还没见底', why: '渠道调研' }], known);
  assert.deepEqual(out, [{ code: null, claim: '整个行业的库存周期还没见底', why: '渠道调研' }]);
});

test('normalizeExternal：带 code 的必须在池内，幻觉代码丢弃', () => {
  const known = new Map([['AAA', { code: 'AAA' }]]);
  const out = normalizeExternal([
    { code: 'aaa', claim: '真实条目' },
    { code: 'ZZZ', claim: '幻觉代码' },
  ], known);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'AAA', '代码归一化回池内的原始写法');
  assert.equal(out[0].why, null, '缺 why 落到 null，不变成 undefined 渲染成空白');
});

test('normalizeExternal：空 claim 丢弃，空输入不抛', () => {
  const known = new Map([['AAA', { code: 'AAA' }]]);
  assert.deepEqual(normalizeExternal([{ claim: '   ' }, { why: '只有依据没有主张' }], known), []);
  assert.deepEqual(normalizeExternal(null, known), []);
  assert.deepEqual(normalizeExternal(undefined, known), []);
});

// ── 股性与选锚（v0.10.0）：模型只选锚，数字由代码回填 ─────────────────

const withAnchors = (code, pv) => ({
  code, name: code, isWatch: true,
  anchors: [
    { key: 'pe', label: 'PE(TTM)', ok: true, pv, p50: 20, current: 20 * pv, tier: { name: '合理' } },
    { key: 'pb', label: 'PB', ok: true, pv: 2, p50: 1, current: 2, tier: { name: '显著高估' } },
  ],
});

test('选锚：进榜与落选的都按模型选的锚回填估值，选 none 的不给数字', () => {
  const p = [withAnchors('A', 0.5), withAnchors('B', 0.9), withAnchors('C', 0.9)];
  const out = normalizeReview({
    top: [{ code: 'A', anchor: 'pe', stockType: '稳定型', anchorWhy: 'ROE 稳定' }],
    rejected: [{ code: 'B', why: '贵', anchor: 'none' }, { code: 'C', why: '贵', anchor: 'PB' }],
  }, p, { topN: 10, minN: 0 });
  assert.equal(out.top[0].valuation.key, 'pe');
  assert.equal(out.top[0].valuation.mos, 0.5);
  assert.equal(out.top[0].stockType, '稳定型');
  const byCode = Object.fromEntries(out.rejected.map((x) => [x.code, x]));
  assert.deepEqual(byCode.B.valuation, { key: 'none' });
  assert.equal(byCode.C.valuation.key, 'pb');
  assert.equal(byCode.C.valuation.mos, -1);
});

test('选锚：代码补位的条目沿用模型在落选区给它选的锚', () => {
  const p = [withAnchors('A', 0.5), withAnchors('B', 0.9)];
  const out = normalizeReview({
    top: [{ code: 'A', anchor: 'pe' }],
    rejected: [{ code: 'B', why: '差一点', anchor: 'pe', anchorWhy: '盈利稳定' }],
  }, p, { topN: 10, minN: 2 });
  assert.equal(out.top[1].filledBy, 'code');
  assert.equal(out.top[1].valuation.key, 'pe');
  assert.equal(out.top[1].anchorWhy, '盈利稳定');
});

test('选锚：档案没有锚（旧数据 / 单测桩）时 valuation 为 null，不抛', () => {
  const out = normalizeReview({ top: [{ code: 'A', anchor: 'pe' }], rejected: [] }, profiles('A'), { topN: 10, minN: 0 });
  assert.equal(out.top[0].valuation.invalid, true);
  const out2 = normalizeReview({ top: [{ code: 'A' }], rejected: [] }, profiles('A'), { topN: 10, minN: 0 });
  assert.equal(out2.top[0].valuation, null);
});
