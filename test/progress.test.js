// 活动台账（src/progress.js，§5.1）的纯函数测试。
//
// 这块的规则很容易在改动中悄悄坏掉，而坏掉的表现是「进度数字乱跳」——
// 界面上看着还在动，其实是错的。三条必须钉住：
//   1. 单调不减（并行刷新、tick 刷屏都不能让计数变小）
//   2. 按 key 去重（秒数在变的 label 不得被当成新单元重复计数）
//   3. 计数与显示文本分开（改文案不改数字）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivity, noteEvent, fingerprint } from '../src/progress.js';

/** 固定时钟，让 elapsedMs / t 可断言。 */
const clockOf = (start = 1000) => {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
};

test('set：同一 key 反复刷新不重复计数，label 可以变', () => {
  const act = createActivity();
  act.set({ stage: '收集', kind: 'collect', key: 'universe', label: '拉取全市场列表' });
  act.set({ stage: '收集', kind: 'collect', key: 'universe', label: '拉取全市场列表' });
  act.set({ stage: '收集', kind: 'collect', key: 'quotes', label: '批量行情与 52 周高低（1528 只）' });
  assert.equal(act.counters(), '源 2');
});

test('set：label 带秒数（每个 tick 都不同）不得被当成新单元', () => {
  const act = createActivity();
  // 同一段的活性刷新：label 每次都不同，key 相同
  for (let i = 0; i < 50; i++) {
    act.set({ stage: '裁决', kind: 'model', key: 'tick:初排', label: `初排 · 模型思考中（已 ${i}s）` });
  }
  assert.equal(act.counters(), '模型调用 1');
});

test('计数单调不减：后报的小值不覆盖先前的大值', () => {
  const act = createActivity();
  act.set({ kind: 'profile', key: 'a', done: 10, total: 45, label: '深度补数' });
  // 并行度大于 1 时进度值会出现回跳（另一个 worker 报了个小的）
  act.set({ kind: 'profile', key: 'b', done: 3, total: 45, label: '深度补数' });
  assert.equal(act.counters(), '补数 10');
});

test('bump：显式计数（取数这类没有固有进度的）', () => {
  const act = createActivity();
  act.bump('tool');
  act.bump('tool');
  act.note('fallback', '降级：初排 A → B');
  assert.equal(act.counters(), '取数 2 · 降级 1');
});

test('note：写台账但不改变当前阶段', () => {
  const act = createActivity();
  act.set({ stage: '补数', kind: 'profile', key: 'p1', label: '深度补数 1/45' });
  act.note('fallback', '降级：A → B', { stage: '补数' });
  assert.equal(act.snapshot().act.label, '深度补数 1/45');
});

test('close：产出小结记到该阶段上（进度条上已完成的阶段显示它）', () => {
  const act = createActivity();
  act.set({ stage: '收集', kind: 'collect', key: 'universe', label: '拉取全市场列表' });
  act.close('collect', '收集完成：全市场 13825 → 池子 1528 只');
  const s = act.snapshot();
  assert.equal(s.summaries['收集'], '收集完成：全市场 13825 → 池子 1528 只');
  assert.equal(s.act, null, 'close 之后没有进行中的单元');
});

// 市场裁决的三段（初排/深挖/终排）同属 kind='model'，第一段 close 后 open 里
// 就没有它了。不显式给 stage，后两段的小结会记到 stage=null 上，进度条上「裁决」
// 就永远只显示初排那一行——实测踩过。
test('close：同 kind 多段结束时显式指定 stage（裁决三段的收尾）', () => {
  const act = createActivity();
  act.set({ stage: '裁决', kind: 'model', key: 'verdict', label: '总裁决' });
  act.close('model', '初排完成：点名 14 只待深挖', '裁决');
  act.close('model', '深挖完成（14 只）', '裁决');
  const s = act.snapshot();
  assert.equal(s.summaries['裁决'], '深挖完成（14 只）', '小结要持续更新，不是停在第一段');
  assert.ok(act.timeline().includes('初排完成：点名 14 只待深挖'), '每段都留在台账里');
});

test('snapshot：只回带最近 N 条台账，seq 单调递增（前端据此去重追加）', () => {
  const act = createActivity();
  for (let i = 0; i < 20; i++) act.note('tool', `取数 ${i}`);
  const { recent } = act.snapshot();
  assert.ok(recent.length <= 8);
  const seqs = recent.map((x) => x.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seq 必须递增');
  assert.ok(seqs.at(-1) === 20, '最后一条是刚写的');
});

test('snapshot：openCount 反映并行度，elapsedMs 来自时钟', () => {
  const now = clockOf();
  const act = createActivity({ now });
  act.set({ kind: 'collect', key: 'a', label: 'A' });
  act.set({ kind: 'profile', key: 'b', label: 'B' });
  now.advance(1500);
  assert.equal(act.snapshot().openCount, 2);
  assert.equal(act.snapshot().elapsedMs, 1500);
});

test('noteEvent：模型层事件 → 台账的一笔（降级/取数/存疑/错误/工具不可用）', () => {
  const act = createActivity();
  noteEvent(act, { type: 'fallback', scope: '深挖', from: 'A', to: 'B', why: '空正文' }, '深挖');
  noteEvent(act, { type: 'tool', used: 3, name: 'get_filing', input: { code: 'ADBE' }, chars: 12000 }, '深挖');
  noteEvent(act, { type: 'suspect', values: ['12345'] }, '终排');
  noteEvent(act, { type: 'error', message: 'HTTP 500' }, '初排');
  noteEvent(act, { type: 'tools-disabled', reason: '渠道不支持' }, '深挖');
  assert.equal(act.counters(), '取数 1 · 降级 1 · 存疑 1 · 错误 2');
  assert.ok(act.timeline().some((l) => l.includes('get_filing ADBE')));
});

test('noteEvent：tick 不进台账（它由调用方直接 set 当前单元）', () => {
  const act = createActivity();
  noteEvent(act, { type: 'tick', scope: '初排', text: '初排 · 模型思考中（已 3s）' }, '初排');
  assert.equal(act.counters(), '');
  assert.deepEqual(act.timeline(), []);
});

test('台账有上限，不会无限增长（长跑一轮的记忆占用可控）', () => {
  const act = createActivity();
  for (let i = 0; i < 500; i++) act.note('error', `错误 ${i}`);
  assert.ok(act.timeline().length <= 200);
  assert.ok(act.timeline().at(-1).includes('错误 499'), '保留最近的');
});

// 指纹决定「这条 stage 事件要不要发」。漏了 act.label，模型活性刷新（只有秒数在变）
// 就会被判成重复而丢掉——裁决那十几分钟界面完全不动，正是本轮要修的毛病。
test('fingerprint：秒数变化（act.label 变）必须算作新内容', () => {
  const act = createActivity();
  act.set({ stage: '裁决', kind: 'model', key: 'tick:初排', label: '初排 · 模型思考中（已 3s）' });
  const a = fingerprint(act.snapshot());
  act.set({ stage: '裁决', kind: 'model', key: 'tick:初排', label: '初排 · 模型思考中（已 5s）' });
  assert.notEqual(fingerprint(act.snapshot()), a);
});

test('fingerprint：完全重复的广播被判重（78 次 SEC frames 不该变成 78 条消息）', () => {
  const act = createActivity();
  act.set({ stage: '收集', kind: 'collect', key: 'sec:1', label: 'SEC frames 1/78' });
  const a = fingerprint(act.snapshot());
  act.set({ stage: '收集', kind: 'collect', key: 'sec:1', label: 'SEC frames 1/78' });
  assert.equal(fingerprint(act.snapshot()), a);
});
