// 总裁决分组配额（capByGroup / quotas）的纯函数测试。
// 配额语义（用户决策 2026-09-22）：自选参与时市场组固定拿 topN − watchN，
// 自选不足额总榜如实缺额，**不用市场票补位**；自选为空时市场组回到 topN。
// 这里破掉的话，要么自选票被市场票挤掉，要么市场票替自选补位——都与决策相悖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { quotas, capByGroup } from '../src/verdict.js';

const mapOf = (codes) => new Map(codes.map(([c, w]) => [c.toUpperCase(), w]));

test('quotas：自选参与时市场组固定 topN − watchN，不随自选数量补位', () => {
  assert.deepEqual(quotas(10, 5, 0), { watch: 0, market: 10 }, '自选为空 → 市场回到 topN');
  assert.deepEqual(quotas(10, 5, 5), { watch: 5, market: 5 });
  // 池子只有 2 只：市场仍是 5（不是 8）——缺额不补位
  assert.deepEqual(quotas(10, 5, 2), { watch: 5, market: 5 });
});

test('quotas：watchN 超过 topN 时截到 topN，市场组不出现负数', () => {
  assert.deepEqual(quotas(10, 12, 5), { watch: 10, market: 0 });
  assert.deepEqual(quotas(4, 5, 1), { watch: 4, market: 0 });
});

test('capByGroup：模型自报 group 被代码纠正（按候选档案的 isWatch 归组）', () => {
  const watch = mapOf([['W1', true], ['W2', true], ['M1', false], ['M2', false]]);
  // 模型把 W1 报成「市场」——代码按档案纠正回自选组
  const top = [
    { code: 'W1', rank: 1, group: '市场' },
    { code: 'M1', rank: 2 },
    { code: 'W2', rank: 3, group: '自选' },
    { code: 'M2', rank: 4, group: '自选' },
  ];
  const out = capByGroup(top, watch, { topN: 10, watchN: 2 });
  const w = out.filter((x) => x.code.startsWith('W'));
  assert.equal(w.length, 2, '两个 watch 候选都归自选组');
  assert.ok(out.find((x) => x.code === 'W1').group === '自选', '自报错误被纠正');
  assert.ok(out.find((x) => x.code === 'M2').group === '市场', '自报错误被纠正');
});

test('capByGroup：超配截断 + 按模型原始次序全局重新编号', () => {
  // 10 只候选：4 自选 + 6 市场；配额 watch 5 / market 5（topN=10）
  const watch = mapOf([['W1', true], ['W2', true], ['W3', true], ['W4', true],
    ['M1', false], ['M2', false], ['M3', false], ['M4', false], ['M5', false], ['M6', false]]);
  const top = [
    { code: 'W1', rank: 1 }, { code: 'W2', rank: 2 }, { code: 'M1', rank: 3 },
    { code: 'W3', rank: 4 }, { code: 'M2', rank: 5 }, { code: 'M3', rank: 6 },
    { code: 'M4', rank: 7 }, { code: 'M5', rank: 8 }, { code: 'M6', rank: 9 }, { code: 'W4', rank: 10 },
  ];
  const out = capByGroup(top, watch, { topN: 10, watchN: 5 });
  // 自选 4 只全保留（≤5）；市场只留前 5（M1–M5），M6 被截掉；输出保持模型原始次序（两组混排）
  assert.deepEqual(out.map((x) => x.code), ['W1', 'W2', 'M1', 'W3', 'M2', 'M3', 'M4', 'M5', 'W4']);
  assert.deepEqual(out.map((x) => x.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9], '重新连续编号');
});

test('capByGroup：自选为空时回到现状（市场独占 topN）', () => {
  const watch = mapOf([['M1', false], ['M2', false]]);
  const top = [{ code: 'M1', rank: 1 }, { code: 'M2', rank: 2 }];
  const out = capByGroup(top, watch, { topN: 10, watchN: 5 });
  assert.deepEqual(out.map((x) => x.code), ['M1', 'M2']);
  assert.ok(out.every((x) => x.group === '市场'));
});

test('capByGroup：rank 缺失按模型输出次序兜底（数组顺序即次序）', () => {
  const watch = mapOf([['W1', true], ['W2', true], ['M1', false], ['M2', false]]);
  const top = [{ code: 'W1' }, { code: 'M1' }, { code: 'W2' }, { code: 'M2' }];
  const out = capByGroup(top, watch, { topN: 10, watchN: 2 });
  assert.deepEqual(out.map((x) => x.code), ['W1', 'M1', 'W2', 'M2']);
});

test('capByGroup：未知代码（模型幻觉）已在调用方过滤，这里只测纯配额行为', () => {
  const watch = mapOf([['W1', true], ['M1', false]]);
  const out = capByGroup([{ code: 'W1', rank: 1 }], watch, { topN: 10, watchN: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].group, '自选');
});
