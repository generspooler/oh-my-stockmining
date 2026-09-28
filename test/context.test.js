// 上下文预算（v0.10.0）的纯函数测试。
//
// 此前工具循环只有「单条结果 12000 字」一道闸：按条数防御，防不住总量——
// 工具循环每一轮都把整段对话重发，窗口是被累积撑满的。现在按总预算收口：
// 预算由用户定（至少 256k～500k token，默认取下沿），截断一律如实告知模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, fitToContext, inputTokensOf } from '../src/llm.js';

test('estimateTokens：中文按 1 字 1 token、其余按 3.5 字符 1 token（偏保守）', () => {
  assert.equal(estimateTokens('世纪华通'), 4);
  assert.equal(estimateTokens('abcdefg'), 2);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
});

test('inputTokensOf：Anthropic 的缓存命中要加回来；OpenAI 用 prompt_tokens', () => {
  assert.equal(inputTokensOf({ input_tokens: 100, cache_read_input_tokens: 900 }), 1000);
  assert.equal(inputTokensOf({ prompt_tokens: 321 }), 321);
  assert.equal(inputTokensOf(null), null);
});

test('fitToContext：空间充足时原样放行', () => {
  const r = fitToContext('短结果', { usedTokens: 1000, budget: 256000, reserve: 16000, maxChars: 60000 });
  assert.deepEqual(r, { content: '短结果', truncated: false, full: false });
});

test('fitToContext：超过单条上限先按字数截断，并告知原长度', () => {
  const r = fitToContext('x'.repeat(100), { usedTokens: 0, budget: 256000, reserve: 0, maxChars: 10 });
  assert.equal(r.truncated, true);
  assert.ok(r.content.startsWith('x'.repeat(10)));
  assert.match(r.content, /原 100 字/);
});

test('fitToContext：剩余空间不够整条时按比例截到剩余空间，如实写明「预算所限」', () => {
  const big = '中'.repeat(50000);
  const r = fitToContext(big, { usedTokens: 230000, budget: 256000, reserve: 16000, maxChars: 60000 });
  assert.equal(r.full, false);
  assert.equal(r.truncated, true);
  assert.match(r.content, /上下文预算所限截断/);
  assert.ok(estimateTokens(r.content) <= 10000, '截完不超过剩余的 1 万 token');
});

test('fitToContext：预算已满时不再回填数据，改为让模型收敛（调用方据此撤掉工具）', () => {
  const r = fitToContext('任何结果', { usedTokens: 239500, budget: 256000, reserve: 16000, maxChars: 60000 });
  assert.equal(r.full, true);
  assert.match(r.content, /上下文预算已满/);
  assert.doesNotMatch(r.content, /任何结果/);
});
