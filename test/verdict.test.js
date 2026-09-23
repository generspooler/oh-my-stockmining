// 市场总裁决的席位截断（capTop）纯函数测试。
// v0.6 起市场榜是纯市场榜：自选池走自己的流水线（test/review.test.js），
// 这里只保证「席位由代码裁定、次序按模型输出、编号连续」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { capTop } from '../src/verdict.js';

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
