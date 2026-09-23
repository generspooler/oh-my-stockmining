// 工具循环的连通性与往返测试（SYSTEM_DEFINITION §6.2：每条协议路径都要有一项测试）。
//
// **默认跳过**：这组测试会真的调用模型、真的花钱、单次几十秒。
// 手动跑：`MINE_LLM_IT=1 node --test test/llm-tools.test.js`
//
// 纯函数部分（消息翻译）不花钱，无条件跑——它是两种协议工具信封的唯一接缝，
// 也是「现有五处无工具调用点行为不变」这条保证的落点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { toOpenaiMessages, completeWithTools, llmReady } from '../src/llm.js';

const IT = process.env.MINE_LLM_IT === '1' && llmReady();
const itOpts = { skip: IT ? false : '需要 MINE_LLM_IT=1 与模型凭据（会真实调用模型）' };

// ── 纯函数：消息格式翻译 ────────────────────────────────────────

test('toOpenaiMessages：纯文本消息原样透传（现有无工具调用点必须零变化）', () => {
  const msgs = [{ role: 'user', content: '你好' }];
  assert.deepEqual(toOpenaiMessages(msgs), msgs);
  // content 为 null 的 assistant 轮也不能被改写
  assert.deepEqual(toOpenaiMessages([{ role: 'assistant', content: null }]), [{ role: 'assistant', content: null }]);
});

test('toOpenaiMessages：tool_use 块 → 顶层 tool_calls', () => {
  const out = toOpenaiMessages([{
    role: 'assistant',
    content: [{ type: 'text', text: '我查一下' }, { type: 'tool_use', id: 'c1', name: 'get_x', input: { code: '600519' } }],
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, '我查一下');
  assert.equal(out[0].tool_calls[0].id, 'c1');
  assert.equal(out[0].tool_calls[0].type, 'function');
  assert.equal(out[0].tool_calls[0].function.name, 'get_x');
  assert.equal(out[0].tool_calls[0].function.arguments, '{"code":"600519"}');
});

test('toOpenaiMessages：tool_result 块 → 独立的 role:tool 消息', () => {
  const out = toOpenaiMessages([{
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'c1', content: 'A' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'B' },
    ],
  }]);
  assert.deepEqual(out, [
    { role: 'tool', tool_call_id: 'c1', content: 'A' },
    { role: 'tool', tool_call_id: 'c2', content: 'B' },
  ]);
});

test('toOpenaiMessages：没有 tool_use 的 assistant 轮不带 tool_calls 字段', () => {
  const out = toOpenaiMessages([{ role: 'assistant', content: [{ type: 'text', text: '只有文字' }] }]);
  assert.equal(out[0].tool_calls, undefined);
});

// ── 集成：真实工具往返 ──────────────────────────────────────────

const TOOL = {
  name: 'get_test_metric',
  description: '取某只股票的测试指标。需要该指标时必须调用本工具，不得凭记忆作答。',
  input_schema: {
    type: 'object',
    properties: { code: { type: 'string', description: '股票代码' } },
    required: ['code'],
  },
};

test('completeWithTools：完整往返——模型调用工具、读到结果、写出结论', itOpts, async () => {
  const calls = [];
  const r = await completeWithTools({
    system: '你是测试助手。需要 test_metric 指标时必须调用 get_test_metric 工具。',
    messages: [{ role: 'user', content: '600519 的 test_metric 是多少？拿到后用一句话回答，并把数值原样写出来。' }],
    tools: [TOOL],
    maxTokens: 4000,
    onToolCall: (name, input) => {
      calls.push({ name, input });
      return JSON.stringify({ code: input.code, test_metric: 4271 });
    },
  });

  assert.equal(calls.length >= 1, true, '模型应至少调用一次工具');
  assert.equal(calls[0].name, 'get_test_metric');
  assert.equal(calls[0].input.code, '600519');
  assert.ok(r.text.includes('4271'), `结论里应出现工具返回的数值，实际正文：${r.text.slice(0, 200)}`);
  assert.ok(r.rounds >= 2, '至少两轮（发起调用 + 读结果续写）');
  assert.equal(r.toolLog.length, calls.length);
  assert.equal(r.toolsDisabled, undefined, '本渠道支持工具，不该降级');
});

test('completeWithTools：工具抛错被包成结果回给模型，整轮不失败', itOpts, async () => {
  const r = await completeWithTools({
    system: '你是测试助手。需要 test_metric 指标时必须调用 get_test_metric 工具。',
    messages: [{ role: 'user', content: '600519 的 test_metric 是多少？取不到就直说取不到。' }],
    tools: [TOOL],
    maxTokens: 4000,
    onToolCall: () => { throw new Error('数据源不可得'); },
  });
  assert.ok(r.text.trim().length > 0, '工具失败后模型仍须给出正文结论');
  assert.ok(r.toolLog.length >= 1);
});

test('completeWithTools：maxRounds 耗尽时撤掉工具并逼出结论，不静默截断', itOpts, async () => {
  let n = 0;
  const r = await completeWithTools({
    system: '你是测试助手。需要 test_metric 指标时必须调用 get_test_metric 工具。',
    messages: [{ role: 'user', content: '把 600519、000651、601318 的 test_metric 都查出来，逐一列出。' }],
    tools: [TOOL],
    maxTokens: 4000,
    maxRounds: 1,
    onToolCall: (name, input) => { n++; return JSON.stringify({ code: input.code, test_metric: 100 + n }); },
  });
  assert.ok(r.text.trim().length > 0, '预算耗尽后仍须拿到正文');
  assert.equal(r.budgetExhausted, true, '应显式标记预算耗尽，而不是看起来像正常结束');
  assert.ok(r.toolLog.some((x) => x.exhausted), '耗尽那次应在 toolLog 里留痕');
});
