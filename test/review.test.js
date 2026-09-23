// 自选池裁决归一化（normalizeReview）的回归测试。
//
// 这里的铁律只有一条，但它是整个自选榜的意义所在：
// **池内每一只票，跑完一轮都必须能在结果里找到自己**（top 或 rejected）。
// 破掉不会报错——用户只会看到自己加的票凭空消失，还以为是「没问题」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReview, completeCoverage, splitForReview, normalizeExternal } from '../src/review.js';

const profiles = (...codes) => codes.map((c) => ({ code: c, name: c, isWatch: true }));
const codesOf = (arr) => arr.map((x) => String(x.code).toUpperCase());

test('池内每只都有归属：模型漏报的被补进落选区并标 unanswered', () => {
  const p = profiles('AAA', 'BBB', 'CCC', 'DDD');
  // 模型只提了两只，CCC / DDD 整个没出现
  const out = normalizeReview({ top: [{ code: 'AAA' }], rejected: [{ code: 'BBB', why: '估值已修复' }] }, p, { topN: 8 });
  const covered = new Set([...codesOf(out.top), ...codesOf(out.rejected)]);
  assert.deepEqual([...covered].sort(), ['AAA', 'BBB', 'CCC', 'DDD']);
  const un = out.rejected.filter((x) => x.unanswered);
  assert.deepEqual(codesOf(un), ['CCC', 'DDD']);
  assert.ok(un[0].why.includes('没有对这只给出结论'), '补进来的要写明是「没被回答」而不是「没问题」');
});

test('top 截到 topN，被挤出的票不会消失（落到落选区并标 unanswered）', () => {
  const p = profiles('A', 'B', 'C');
  const out = normalizeReview({ top: [{ code: 'A' }, { code: 'B' }, { code: 'C' }], rejected: [] }, p, { topN: 2 });
  assert.deepEqual(codesOf(out.top), ['A', 'B']);
  assert.deepEqual(codesOf(out.rejected), ['C']);
});

test('幻觉代码被丢弃，不污染两个区', () => {
  const p = profiles('AAA');
  const out = normalizeReview({
    top: [{ code: 'ZZZ' }],
    rejected: [{ code: 'YYY', why: '不存在的票' }, { code: 'AAA', why: '真的' }],
  }, p, { topN: 8 });
  assert.deepEqual(out.top, []);
  assert.deepEqual(codesOf(out.rejected), ['AAA']);
});

test('同一只既进 top 又被写进 rejected 时，以 top 为准（不重复出现）', () => {
  const p = profiles('AAA', 'BBB');
  const out = normalizeReview({
    top: [{ code: 'AAA' }],
    rejected: [{ code: 'AAA', why: '模型自相矛盾' }, { code: 'BBB', why: '正常落选' }],
  }, p, { topN: 8 });
  assert.deepEqual(codesOf(out.top), ['AAA']);
  assert.deepEqual(codesOf(out.rejected), ['BBB']);
});

test('落选条目重复出现只留一条', () => {
  const p = profiles('AAA');
  const out = normalizeReview({ top: [], rejected: [{ code: 'AAA', why: '一' }, { code: 'aaa', why: '二' }] }, p, { topN: 8 });
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].why, '一');
});

test('top 为空是合法结论：全池落选，一只都不丢', () => {
  const p = profiles('A', 'B');
  const out = normalizeReview({
    top: [],
    rejected: [{ code: 'A', why: '贵', stance: '估值已修复' }, { code: 'B', why: '衰退', stance: '疑似价值陷阱', suggestRemove: true }],
  }, p, { topN: 8 });
  assert.deepEqual(out.top, []);
  assert.deepEqual(codesOf(out.rejected), ['A', 'B']);
  assert.equal(out.rejected[1].suggestRemove, true, '建议移出的标记要透传到渲染层');
});

test('非标准 stance 原样保留并打标，不丢结论（与归因类别同一取向）', () => {
  const p = profiles('A');
  const out = normalizeReview({ top: [], rejected: [{ code: 'A', why: 'x', stance: '需要再观察' }] }, p, { topN: 8 });
  assert.equal(out.rejected[0].stance, '需要再观察');
  assert.equal(out.rejected[0].stanceUnmatched, true);
});

test('缺 stance 的落选条目落到「未归类」，不变成 undefined 渲染成空白', () => {
  const p = profiles('A');
  const out = normalizeReview({ top: [], rejected: [{ code: 'A', why: 'x' }] }, p, { topN: 8 });
  assert.equal(out.rejected[0].stance, '未归类');
  assert.equal(out.rejected[0].suggestRemove, false);
});

test('模型整份输出为空时，全池落到 unanswered——绝不静默返回空结果', () => {
  const p = profiles('A', 'B', 'C');
  const out = normalizeReview({}, p, { topN: 8 });
  assert.equal(out.top.length, 0);
  assert.equal(out.rejected.length, 3);
  assert.ok(out.rejected.every((x) => x.unanswered));
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
