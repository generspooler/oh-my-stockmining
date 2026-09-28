// 市场总裁决的席位截断（capTop）纯函数测试。
// v0.6 起市场榜是纯市场榜：自选池走自己的流水线（test/review.test.js），
// 这里只保证「席位由代码裁定、次序按模型输出、编号连续」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { capTop, normalizePicks, normalizeExternal, fitBoard, isBelowBar } from '../src/verdict.js';

test('capTop：截到 topN 并按模型输出次序重新连续编号', () => {
  const top = [{ code: 'A' }, { code: 'B' }, { code: 'C' }, { code: 'D' }];
  const out = capTop(top, 3);
  assert.deepEqual(out.map((x) => x.code), ['A', 'B', 'C']);
  assert.deepEqual(out.map((x) => x.rank), [1, 2, 3]);
});

test('capTop：模型自报的 rank 不采信，以数组次序为准', () => {
  // 模型把次序写乱了：数组顺序才是它真正的排序，rank 只是冗余回显
  const out = capTop([{ code: 'A', rank: 7 }, { code: 'B', rank: 3 }], 10);
  assert.deepEqual(out.map((x) => [x.code, x.rank]), [['A', 1], ['B', 2]]);
});

test('capTop：同一只被写两遍不得占两席', () => {
  const out = capTop([{ code: 'A' }, { code: 'a' }, { code: 'B' }], 10);
  assert.deepEqual(out.map((x) => x.code), ['A', 'B']);
});

test('capTop：候选不足 topN 时如实少给，不补位', () => {
  assert.equal(capTop([{ code: 'A' }], 10).length, 1);
  assert.deepEqual(capTop([], 10), []);
  assert.deepEqual(capTop(null, 10), []);
});

test('capTop：无代码的条目丢弃（模型偶发吐出空壳对象）', () => {
  const out = capTop([{ code: 'A' }, { thesis: '没写代码' }, { code: 'B' }], 10);
  assert.deepEqual(out.map((x) => x.code), ['A', 'B']);
});

// ── 榜单席位裁定 fitBoard（v0.9.0：5~10 席，补位标注）────────────────

const codes = (arr) => arr.map((x) => x.code);

test('fitBoard：达标够数时只留达标的，最多 max 只，被截的记 overMax', () => {
  const top = Array.from({ length: 12 }, (_, i) => ({ code: `Q${i}` }));
  const { top: out, dropped } = fitBoard(top, { min: 5, max: 10 });
  assert.equal(out.length, 10);
  assert.ok(out.every((x) => x.meetsBar === true));
  assert.deepEqual(dropped.map((x) => [x.code, x.droppedWhy]), [['Q10', 'overMax'], ['Q11', 'overMax']]);
});

test('fitBoard：补位只凑到 min，不凑到 max；多出来的记 notNeeded', () => {
  const top = [
    { code: 'A' }, { code: 'B' },
    { code: 'X', meetsBar: false }, { code: 'Y', meetsBar: false },
    { code: 'Z', meetsBar: false }, { code: 'W', meetsBar: false },
  ];
  const { top: out, dropped } = fitBoard(top, { min: 5, max: 10 });
  assert.deepEqual(codes(out), ['A', 'B', 'X', 'Y', 'Z']);
  assert.deepEqual(dropped.map((x) => [x.code, x.droppedWhy]), [['W', 'notNeeded']]);
});

test('fitBoard：模型给的不足 min 时按 fill 次序补，跳过已在榜的与重复的', () => {
  const { top: out } = fitBoard([{ code: 'A' }, { code: 'B' }], {
    min: 5, max: 10,
    fill: [{ code: 'a' }, { code: 'C', belowBarReason: '差在估值' }, { code: 'C' }, { code: 'D' }, { code: 'E' }, { code: 'F' }],
  });
  assert.deepEqual(codes(out), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(out.map((x) => x.rank), [1, 2, 3, 4, 5]);
  assert.equal(out[2].filledBy, 'code');
  assert.equal(out[2].belowBarReason, '差在估值');
  assert.equal(out[0].filledBy, undefined);
});

test('fitBoard：fill 也不够时如实少给——代码不凭空造票', () => {
  const { top: out } = fitBoard([{ code: 'A' }], { min: 5, max: 10, fill: [{ code: 'B' }] });
  assert.deepEqual(codes(out), ['A', 'B']);
  assert.deepEqual(fitBoard([], { min: 5, max: 10 }).top, []);
});

test('fitBoard：min 为 0 时退回旧语义（宁缺毋滥，不补位）', () => {
  const { top: out, dropped } = fitBoard([{ code: 'A' }, { code: 'X', meetsBar: false }], { min: 0, max: 10, fill: [{ code: 'B' }] });
  assert.deepEqual(codes(out), ['A']);
  assert.deepEqual(codes(dropped), ['X']);
});

test('isBelowBar：模型偶发把布尔写成字符串；缺字段视为达标（旧快照与旧提示词）', () => {
  assert.equal(isBelowBar({ meetsBar: false }), true);
  assert.equal(isBelowBar({ meetsBar: 'false' }), true);
  assert.equal(isBelowBar({ meetsBar: '否' }), true);
  assert.equal(isBelowBar({ meetsBar: true }), false);
  assert.equal(isBelowBar({}), false);
  assert.equal(isBelowBar(null), false);
});

// ── 三段式裁决的纯函数（v0.7.2）──────────────────────────────────

test('normalizePicks：去幻觉代码、去重、按上限截断，并回写池内的原始代码写法', () => {
  const known = new Map([['AAA', { code: 'AAA' }], ['BBB', { code: 'BBB' }], ['CCC', { code: 'CCC' }]]);
  const out = normalizePicks([
    { code: 'aaa', verify: '验证渠道库存' },
    { code: 'ZZZ', verify: '幻觉代码' },
    { code: 'AAA', verify: '重复' },
    { code: 'BBB' },
    { code: 'CCC', verify: '第三只' },
  ], known, 2);
  assert.deepEqual(out, [
    { code: 'AAA', verify: '验证渠道库存' },
    { code: 'BBB', verify: null },
  ]);
});

test('normalizePicks：空点名是合法结论（没有深挖能改变结论的票）', () => {
  assert.deepEqual(normalizePicks([], new Map(), 5), []);
  assert.deepEqual(normalizePicks(null, new Map(), 5), []);
});

test('normalizeExternal：L3 条目——无 code 的整体判断保留，幻觉代码丢弃', () => {
  const known = new Map([['AAA', { code: 'AAA' }]]);
  assert.deepEqual(
    normalizeExternal([{ claim: '全行业库存周期未见底', why: '渠道调研' }], known),
    [{ code: null, claim: '全行业库存周期未见底', why: '渠道调研' }],
  );
  assert.deepEqual(normalizeExternal([{ code: 'ZZZ', claim: '幻觉' }], known), []);
  assert.deepEqual(normalizeExternal([{ code: 'aaa', claim: '真实' }], known),
    [{ code: 'AAA', claim: '真实', why: null }]);
});
