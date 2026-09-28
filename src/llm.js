// 模型客户端（流式 + 协议探测 + 降级链）。凭据取自环境变量。
//
// 网关（ModelBest/东财 llm-center）上每个渠道**声明**它支持的协议，实测两类：
//   ANTHROPIC      → POST /v1/messages        （SSE: content_block_delta.{text,thinking}）
//   OPENAI_HTTP    → POST /v1/chat/completions（SSE: choices[0].delta.{content,reasoning_content}）
// 两者都声明（GLM 系）的走哪条都行；只声明 OPENAI_HTTP 的（GPT 系）走 /v1/messages
// 会被网关挡回 400「该模型未声明支持 Anthropic Messages 协议调用」。
//
// 本项目原本只会说 Anthropic，于是换 GPT 渠道后**每次调用都 400**：
// 界面上进度条照走、日志里却什么都看不见（错误只通过 SSE 回前端），
// 表现就是「没有触发模型调用」。现在两种协议都实现，并自动探测。
import fs from 'node:fs';
import path from 'node:path';
import { NARRATIVE } from './config.js';
import { ROOT } from './util.js';

const BASE = NARRATIVE.baseUrl.replace(/\/+$/, '');
const KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
export const MODELS = [NARRATIVE.model, ...NARRATIVE.fallbacks.filter((m) => m !== NARRATIVE.model)];
export const llmReady = () => Boolean(KEY);

const headers = (extra = {}) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${KEY}`,
  ...extra,
});

/**
 * 内部消息格式 → OpenAI 形态。
 *
 * 内部统一用 Anthropic 的 content blocks（工具往返里它表达力最强），
 * 在这里翻译成 OpenAI 的 tool_calls / role:'tool'。两种协议的工具信封差别就在这：
 *   Anthropic：assistant 的 content 里放 tool_use 块，结果放 user 的 tool_result 块
 *   OpenAI：  assistant 顶层放 tool_calls 数组，结果是独立的 role:'tool' 消息
 * 纯文本消息不受影响，原样透传——现有五处无工具调用点因此完全不变。
 */
export function toOpenaiMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (typeof m.content === 'string' || m.content == null) { out.push(m); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [m.content];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
      const calls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function',
        function: { name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    // user 侧：tool_result 块要拆成独立的 role:'tool' 消息，其余文本块合并
    const results = blocks.filter((b) => b?.type === 'tool_result');
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
    for (const r of results) {
      out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: String(r.content ?? '') });
    }
    if (text) out.push({ role: m.role || 'user', content: text });
  }
  return out;
}

/**
 * 协议构造器。每种协议只负责「怎么发、怎么认、怎么读」，看门狗 / 超时 / 降级
 * 全部由下面的 stream() 统一持有——协议之间唯一的差别就是 wire format。
 */
const PROTOCOLS = {
  anthropic: {
    name: 'anthropic',
    path: '/v1/messages',
    headers: () => headers({ 'anthropic-version': '2023-06-01', 'x-api-key': KEY }),
    body: ({ system, messages, model, maxTokens, temperature, tools }) => {
      const b = { model, system, messages, max_tokens: maxTokens, stream: true };
      if (temperature != null) b.temperature = temperature;
      // 内部消息格式就是 Anthropic 的 content blocks，这里原样透传。
      // ⚠ 本路径**未经真实渠道验证**：当前网关的渠道只声明 OPENAI_HTTP/OPENAI_RESPONSE，
      //   无法测。按 §6.2「两种协议都得实现」写出，跑通与否待有 Anthropic 渠道时再验。
      if (tools?.length) {
        b.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
      }
      return b;
    },
    // 网关把协议不支持也报成 invalid_request_error，与真正的参数错误同码。
    // 只认这一句特定的抱怨，不靠 400 泛判——否则参数写错会被误当成协议问题。
    unsupported: (msg) => /未声明支持|not declared to support|does not support.*Messages/i.test(msg),
    // 事件 → 归一化的 { think?, text?, stopReason?, usage?, tools? }
    // tools 是**分片**：[{ index, id?, name?, partial? }]，跨事件拼装由 stream() 负责
    // （parse 是无状态纯函数，拼不了）。
    parse: (evt) => {
      // 工具块的开始：带 id 与 name，此前完全没有处理，于是工具调用整个丢失
      if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        return { tools: [{ index: evt.index, id: evt.content_block.id, name: evt.content_block.name }] };
      }
      if (evt.type === 'content_block_delta') {
        const think = evt.delta?.thinking ?? evt.delta?.reasoning_content;
        if (evt.delta?.text) return { text: evt.delta.text };
        // 此前这里被当成「只证明连接活着，无内容」丢掉——它正是工具参数的 JSON 分片
        if (evt.delta?.type === 'input_json_delta') {
          return { tools: [{ index: evt.index, partial: evt.delta.partial_json || '' }] };
        }
        if (typeof think === 'string') return { think };
        return null;
      }
      if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
        return { stopReason: evt.delta.stop_reason, usage: evt.usage };
      }
      // 输入 token 数只在 message_start 里给。此前没读，于是无从核对「实际用了多少上下文」
      if (evt.type === 'message_start' && evt.message?.usage) return { usage: evt.message.usage, meta: true };
      if (evt.type === 'error') throw new Error(evt.error?.message || '模型返回错误');
      return null;
    },
  },

  openai: {
    name: 'openai',
    path: '/v1/chat/completions',
    headers: () => headers(),
    body: ({ system, messages, model, maxTokens, temperature, tools }) => {
      const b = {
        model,
        // system 在 Anthropic 里是顶层字段、在 OpenAI 里是首条消息。
        // 本项目四种提示词全部带 system，漏了它模型就看不到输出格式约束。
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...toOpenaiMessages(messages)],
        // GPT-5 系（gpt-5.6-*）只认 max_completion_tokens，旧模型只认 max_tokens。
        // 本网关对**未知参数静默忽略**（实测 max_tokens=99999999 与 totally_unknown_param
        // 都返回 200），发错参数名不会报错、只会让预算悄悄变成默认值——
        // 所以两个都发：认哪个的模型用哪个，不认识的那个被忽略，等于免疫两类命名。
        // include_usage：不带它，流式最后一块没有 usage，失败时无从分辨
        // 「思考吃光预算」与「思考完不写正文」——这正是本项目排障最需要的两个数。
        max_tokens: maxTokens,
        max_completion_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (temperature != null) b.temperature = temperature;
      // 不传 tool_choice：取数与否交给模型自己判断（用户决策「相信模型」）。
      // 探针实测本渠道在省略 tool_choice 时就会主动发起调用，无需强制。
      if (tools?.length) {
        b.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));
      }
      return b;
    },
    unsupported: () => false,   // OpenAI 端点没有「协议不匹配」这一说
    parse: (evt) => {
      if (evt.type === 'error' || evt.error) throw new Error(evt.error?.message || '模型返回错误');
      // 网关对不存在/不可路由的模型回 HTTP 500 `{error:{message:"模型不存在", code:"102503"}}`
      // 这种非标准错误体不在这里抛——让 HTTP 层统一处理，避免错误信息被吞成 undefined
      const ch = evt.choices?.[0];
      const d = ch?.delta || {};
      const think = d.reasoning_content ?? d.reasoning;
      // 累积式返回，**不再提前 return**。原来 `if (d.content) return {text}` 会把
      // 同一 chunk 里的 tool_calls 一起丢掉——两者同时出现是合法的。
      const out = {};
      if (typeof d.content === 'string' && d.content) out.text = d.content;
      else if (typeof think === 'string' && think) out.think = think;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
        out.tools = d.tool_calls.map((tc) => ({
          index: tc.index ?? 0, id: tc.id || undefined,
          name: tc.function?.name || undefined, partial: tc.function?.arguments || undefined,
        }));
      }
      // usage 只在最后一块出现，且此时 choices 为空数组
      if (ch?.finish_reason) out.stopReason = ch.finish_reason;
      if (evt.usage) out.usage = evt.usage;
      return Object.keys(out).length ? out : null;
    },
  },
};

/** HTTP 错误体 → 可读信息。两种协议的错误信封不同，且 OpenAI 侧还见过裸 `{error:{...}}`。 */
function httpError(protocol, status, raw) {
  let detail = raw.slice(0, 300);
  try {
    const j = JSON.parse(raw);
    detail = j.error?.message || j.message || detail;
  } catch {}
  const e = new Error(`模型调用失败 HTTP ${status}: ${detail}`);
  e.status = status;
  if (status === 401 || status === 403) e.hint = '凭据被拒，检查 ANTHROPIC_AUTH_TOKEN 是否有效 / 该渠道是否已授权';
  if (status === 404 && protocol === 'openai') e.hint = '该渠道未声明 OPENAI_HTTP';
  return e;
}

/**
 * 探测某模型该走哪条协议，并缓存。
 * auto 时优先 OpenAI——网关对「不支持 Anthropic」的拒绝是明确文本，
 * 而对「模型不存在」的报错两种协议都回，分不出偏好，于是从更通用的那条试起。
 * 只缓存成功结果；两条都过不去就抛结论，让降级链去换模型。
 *
 * 关键陷阱：网关**把错误也包成 HTTP 200 + SSE `error` 事件**返回
 * （实测「模型不存在」在两条协议上都是 200，错误藏在流里）。
 * 所以不能只看 res.ok——必须读到第一个有效事件才算这条协议可用。
 */
const protoCache = new Map();
const PROBE_TIMEOUT_MS = 30e3;

async function probeProtocol(name, model) {
  const protocol = PROTOCOLS[name];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`协议探测超时（${PROBE_TIMEOUT_MS / 1000}s）`)), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${protocol.path}`, {
      method: 'POST',
      headers: protocol.headers(),
      // 探测要尽可能便宜：1 token 即可判定「这个协议能不能用」
      body: JSON.stringify(protocol.body({ system: '', messages: [{ role: 'user', content: 'hi' }], model, maxTokens: 1 })),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, err: httpError(name, res.status, await res.text().catch(() => '')) };
    if (!res.body) return { ok: true };
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === 'error' || evt.error) {
          const msg = evt.error?.message || (typeof evt.error === 'string' ? evt.error : '') || '模型返回错误';
          return { ok: false, err: new Error(`模型调用失败: ${msg}`) };
        }
        return { ok: true };   // 第一个有效事件即证明这条协议可用
      }
    }
    // 流读完一个有效事件都没有：空响应，同样是不可用
    return { ok: false, err: new Error('模型返回空流（无任何事件）') };
  } catch (e) {
    return { ok: false, err: e };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveProtocol(model) {
  const pinned = NARRATIVE.protocol;
  if (PROTOCOLS[pinned]) return { protocol: PROTOCOLS[pinned], fallbackError: null };
  if (protoCache.has(model)) return { protocol: PROTOCOLS[protoCache.get(model)], fallbackError: null };

  const order = ['openai', 'anthropic'];
  let lastErr = null;
  for (const name of order) {
    const r = await probeProtocol(name, model);
    if (r.ok) {
      protoCache.set(model, name);
      return { protocol: PROTOCOLS[name], fallbackError: null };
    }
    const err = r.err;
    if (err.status) err.hint = err.hint || statusHint(err.status);
    lastErr = err;
  }
  // 两条协议都过不去：给出结论与下一步，而不是让调用方对着一句
  // 「该模型未声明支持 Anthropic」猜半天（这正是本次踩的坑）。
  const e = new Error(`${model} 两条协议都调不通：${lastErr?.message || '未知原因'}`
    + `（已试 ${PROTOCOLS.openai.path} 与 ${PROTOCOLS.anthropic.path}）`
    + `${lastErr?.hint ? `。${lastErr.hint}` : ''}`
    + `。用 /v1/models 确认该渠道声明的协议，必要时 MINE_PROTOCOL=anthropic|openai 钉死`);
  e.cause = lastErr;
  e.status = lastErr?.status;
  return { protocol: PROTOCOLS[order[0]], fallbackError: e };
}

function statusHint(status) {
  if (status === 401 || status === 403) return '凭据无效或未授权该渠道';
  if (status === 429) return '限流，稍后重试或降低 MINE_LLM_CONCURRENCY';
  if (status >= 500) return '网关侧错误；若为「模型不存在」说明渠道 ID 有问题（见 /v1/models）';
  return null;
}

const procLog = new Set();
function logProtocol(model, name) {
  const k = `${model}→${name}`;
  if (procLog.has(k)) return;
  procLog.add(k);
  console.log(`[llm] ${model} 走 ${PROTOCOLS[name].path}（${name} 协议）`);
}

/**
 * 流式生成。一次调用、一种协议。
 *
 * 无数据看门狗衡量的是「连接是否活着」而非「正文是否已开始」——
 * 带 thinking 的模型会先发 thinking_delta，按正文首 token 计时会误杀健康生成。
 *
 * 但「连接活着」也可能永远不结束：思考型模型持续吐 thinking 分块会把看门狗
 * 无限重置。因此另设**单次调用总时长上限**，卡住时响亮失败而不是静默耗着。
 *
 * onTick：节流的活性回传 { phase: 'thinking'|'writing', chars, elapsedMs }。
 * 没有它，一次 15 分钟的正常思考与真死机在上层看来完全一样（实测踩过）。
 */
/**
 * token 估算（纯函数）。中日韩字符按 1 字 1 token、其余按 3.5 字符 1 token——
 * 对中文偏保守（真实约 0.6~1），宁可早收口也不撞窗口。真实用量见每次调用的 [llm] 日志行。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 3.5);
}

/** 两套协议的输入 token 字段名不同；Anthropic 的缓存命中另计，要加回来才是真实占用。 */
export function inputTokensOf(u) {
  if (!u) return null;
  if (u.input_tokens != null) return u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return u.prompt_tokens ?? null;
}
const outputTokensOf = (u) => (u ? u.output_tokens ?? u.completion_tokens ?? null : null);

/**
 * 工具结果按上下文预算收口（纯函数，可测）。v0.10.0 起取代「单条结果 12000 字」一刀切：
 * 真正要防的是**总量**——工具循环每一轮都把整段对话重发一遍，窗口是被累积撑满的。
 *   usedTokens  本轮之前已占用的输入（上一轮真实 input_tokens 优先，否则估算）
 * 返回 { content, truncated, full }。full=true 表示预算已满：调用方不再执行取数、撤掉工具逼出结论。
 * 截断一律**如实告知**模型，不静默——「不让取了」与「取不到」结论不同。
 */
export function fitToContext(content, {
  usedTokens, budget = NARRATIVE.context.inputTokens, reserve = NARRATIVE.context.reserveTokens,
  maxChars = NARRATIVE.tools.maxResultChars,
} = {}) {
  const room = budget - reserve - (usedTokens || 0);
  if (room < 2000) {
    return {
      content: `上下文预算已满（已用约 ${usedTokens} / ${budget} token）。请基于已有信息直接给出结论，不要再调用工具。`,
      truncated: true, full: true,
    };
  }
  let out = String(content ?? '');
  let truncated = false;
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n…（单条结果上限 ${maxChars} 字，原 ${content.length} 字，已截断）`;
    truncated = true;
  }
  const need = estimateTokens(out);
  if (need > room) {
    const keep = Math.max(0, Math.floor(out.length * (room / need)) - 200);
    out = `${out.slice(0, keep)}\n…（上下文预算所限截断：剩余约 ${room} token，原 ${String(content).length} 字）`;
    truncated = true;
  }
  return { content: out, truncated, full: false };
}

export async function* stream({ system, messages, model, maxTokens = NARRATIVE.maxTokens, temperature, tools, onEnd, onTick }) {
  if (!KEY) throw new Error('缺少 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，无法调用模型');
  // 输入预算前置检查（v0.10.0）：超了就在本地响亮失败，而不是发出去等网关回一个 400，
  // 或者更糟——被渠道静默截断。估算偏保守（中文按 1 字 1 token）。
  const estIn = estimateTokens(`${system || ''}\n${JSON.stringify(messages || [])}`);
  if (estIn > NARRATIVE.context.inputTokens) {
    const e = new Error(`输入约 ${estIn} token，超出上下文预算 ${NARRATIVE.context.inputTokens}`
      + '（NARRATIVE.context.inputTokens / MINE_CONTEXT_TOKENS）。请分批，或在确认渠道窗口足够后调高预算');
    e.status = 413;
    throw e;
  }
  const { protocol, fallbackError } = await resolveProtocol(model);
  logProtocol(model, protocol.name);
  if (fallbackError) throw fallbackError;   // 探测已失败：别用确定不可用的协议再拖一次超时

  const abort = new AbortController();
  const t0 = Date.now();
  let watchdog;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () => abort.abort(new Error(`无数据超时（${Math.round(NARRATIVE.firstTokenTimeoutMs / 1000)}s）`)),
      NARRATIVE.firstTokenTimeoutMs,
    );
  };
  arm();
  const hardStop = setTimeout(
    () => abort.abort(new Error(`单次调用超过 ${Math.round(NARRATIVE.callTimeoutMs / 60000)} 分钟上限`)),
    NARRATIVE.callTimeoutMs,
  );
  let drained = false;
  let textChars = 0, thinkChars = 0, lastTick = 0;
  // 工具分片累积。protocol.parse 是无状态纯函数，跨事件拼 JSON 没有落脚处，
  // 只能由这里持有。键是协议给的 index（并行多个工具调用时靠它区分）。
  const toolAcc = new Map();
  const tick = () => {
    if (!onTick) return;
    const now = Date.now();
    if (now - lastTick < 2000) return;
    lastTick = now;
    // phase 原本只由 textChars 推导，工具轮里会永远报「思考中」——
    // 一次正常的取数与真死机在界面上又变得无从分辨，所以补 'tool' 这一相。
    const phase = textChars ? 'writing' : toolAcc.size ? 'tool' : 'thinking';
    onTick({ phase, chars: textChars || thinkChars, elapsedMs: now - t0, model, toolCalls: toolAcc.size });
  };
  try {
    const res = await fetch(`${BASE}${protocol.path}`, {
      method: 'POST',
      headers: protocol.headers(),
      body: JSON.stringify(protocol.body({ system, messages, model, maxTokens, temperature, tools })),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      throw httpError(protocol.name, res.status, await res.text().catch(() => ''));
    }
    const decoder = new TextDecoder();
    let buf = '', stopReason = null, usage = null, anyDelta = false;
    for await (const chunk of res.body) {
      arm();
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        const norm = protocol.parse(evt);
        if (!norm) continue;
        // 纯元信息事件（只带 usage）不算产出，否则会把 anyDelta 误置真
        if (norm.meta) { usage = { ...(usage || {}), ...norm.usage }; continue; }
        anyDelta = true;
        if (norm.text) { textChars += norm.text.length; yield norm.text; }
        else if (typeof norm.think === 'string') thinkChars += norm.think.length;
        for (const frag of norm.tools || []) {
          const k = frag.index ?? 0;
          if (!toolAcc.has(k)) toolAcc.set(k, { id: null, name: '', args: '' });
          const b = toolAcc.get(k);
          if (frag.id) b.id = frag.id;
          if (frag.name) b.name += frag.name;      // OpenAI 会把函数名也分片
          if (frag.partial) b.args += frag.partial;
        }
        if (norm.stopReason) stopReason = norm.stopReason;
        if (norm.usage) usage = { ...(usage || {}), ...norm.usage };
        tick();
      }
    }
    drained = true;
    // 参数 JSON 解析失败不在这里抛：上层要能把「模型把参数写坏了」当成一次可回报给
    // 模型的工具错误，而不是整轮失败。故保留 argsRaw 与 argsError 交给上层判断。
    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, b]) => {
        let input = {}, argsError = null;
        if (b.args) { try { input = JSON.parse(b.args); } catch (e) { argsError = e.message; } }
        return { index, id: b.id, name: b.name, input, argsRaw: b.args, argsError };
      });
    // 每次调用留一行真实用量：上下文预算是按估算设的，只有这行能校准估算
    const inTok = inputTokensOf(usage);
    console.log(`[llm] ${model} 输入 ${inTok ?? '?'} token（估算 ${estIn}）· 输出 ${outputTokensOf(usage) ?? '?'} token`
      + ` · ${stopReason ?? '?'} · ${Math.round((Date.now() - t0) / 1000)}s`);
    onEnd?.({
      protocol: protocol.name, stopReason, usage, anyDelta, textChars, thinkChars,
      toolCalls, elapsedMs: Date.now() - t0, inputTokens: inTok, estInputTokens: estIn,
    });
  } finally {
    clearTimeout(watchdog);
    clearTimeout(hardStop);
    if (!drained) abort.abort();
  }
}

/**
 * 模型活性回传：思考中/正在写/正在取数 + 已多少字 + 已多久。没有它，长调用与死机无从分辨。
 *
 * 两条信息要分开（§5.1）：`key` 是**单元标识**（哪一段：初排/深挖/终排），
 * `text` 是可以随时刷新的显示文本（秒数每秒在变）。活动台账按 key 去重计数，
 * 若把秒数并进 key，一次 15 分钟的思考会被数成几百个「单元」。
 */
const tickOf = (onEvent, scope, key) => (t) => onEvent?.({
  type: 'tick', scope, key: key || scope, ...t,
  text: tickText(scope, t),
});

/** tick → 人话。前端与 CLI 都直接显示它，两边不再各写一套映射。 */
export function tickText(scope, t = {}) {
  const s = Math.round((t.elapsedMs || 0) / 1000);
  const where = `${scope || '模型'} · `;
  if (t.phase === 'writing') return `${where}正在写结论（已 ${t.chars ?? 0} 字 / ${s}s）`;
  if (t.phase === 'tool') return `${where}正在准备取数（${t.toolCalls ?? 1} 个调用，已 ${s}s）`;
  return `${where}模型思考中（已 ${s}s）`;
}

/**
 * 空正文的诊断信息。区分两种成因：预算被思考吃光（max_tokens）
 * 与「思考完却一个字没写」（end_turn）——后者是单次要求的输出量过大所致，
 * 提高 maxTokens 没用，得减小单次输出规模。
 * 两套协议的 usage 字段名不同（output_tokens vs completion_tokens），都要认。
 */
function emptyTextError(end) {
  const u = end.usage || {};
  const out = u.output_tokens ?? u.completion_tokens;
  const reasoning = u.billing_usage?.openai_usage?.completion_tokens_details?.reasoning_tokens
    ?? u.completion_tokens_details?.reasoning_tokens;
  const detail = `stop_reason=${end.stopReason ?? '?'}（${end.protocol ?? '?'} 协议），output ${out ?? '?'} token`
    + `${reasoning != null ? `（其中 reasoning ${reasoning}）` : ''}，思考 ${end.thinkChars ?? 0} 字，`
    + `耗时 ${Math.round((end.elapsedMs ?? 0) / 1000)}s`;
  // OpenAI 的 finish_reason=length 与 Anthropic 的 max_tokens 同义
  const truncated = end.stopReason === 'max_tokens' || end.stopReason === 'length';
  return new Error(truncated
    ? `思考耗尽 token 预算（${detail}），正文为空。请提高 maxTokens 或减小单次输出量`
    : `模型只输出了思考、正文为空（${detail}）。多为单次要求的输出量过大所致，应分批`);
}

/**
 * 带降级链的一次性生成。零产出即失败才换模型；已开始产出再失败的不换。
 * 返回 { text, model, stopReason, fallbacks[] }。
 *
 * 第 4 个参数 scope：只用于**报活性**（§5.1），不参与任何逻辑。
 * 它必须能从调用方一路传到这里，否则「模型在哪一段、跑到第几分钟」在界面上
 * 只剩一个全局的秒表——实测排障时正是缺这一条，长调用与死机分不出来。
 */
export async function complete({ system, messages, maxTokens, temperature, onFallback, onTick }, scope = '模型') {
  let lastErr;
  const fallbacks = [];
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    let text = '', end = {};
    try {
      for await (const t of stream({
        system, messages, model, maxTokens, temperature, onTick: onTick || tickOf(null, scope, scope),
        onEnd: (e) => { end = e; },
      })) text += t;
      // 空正文**一律报错**，不分 stop_reason。
      // 曾经只拦 max_tokens：结果 end_turn + 正文 0 字（模型思考 15 分钟后一个字没写）
      // 被当成正常返回，上层只看到「JSON 解析失败」，真因被掩盖、还白等一轮重试。
      if (!text.trim()) throw emptyTextError(end);
      return { text, model, ...end, fallbacks };
    } catch (e) {
      lastErr = e;
      // 多模型链上「协议探测失败」是**模型特有的**，不该缓存到别的模型头上；
      // 单模型链则缓存无害（下次仍会重新探测，代价只是 1 个 1-token 请求）。
      // 凭据问题与超预算都是全链共因，换模型没意义
      if (e.status === 401 || e.status === 403 || e.status === 413) throw e;
      // 「已产出」只认**正文**。曾经用 anyDelta 判定，而思考分块也会把它置真，
      // 于是「思考完却不写正文」被误认为「已经开始产出」，降级链形同虚设。
      const produced = text.length > 0;
      if (produced || i === MODELS.length - 1) throw e;
      fallbacks.push({ from: model, to: MODELS[i + 1], reason: e.message });
      onFallback?.(model, MODELS[i + 1], e.message);
    }
  }
  throw lastErr;
}

/**
 * 「这次失败是因为渠道不吃 tools」还是别的原因。
 * 只认明确指向工具参数的抱怨，不靠 400 泛判——与 anthropic.unsupported 同一取向：
 * 参数写错也会 400，泛判会把它误当成渠道能力问题，然后静默降级、掩盖真因。
 */
function toolsRejected(e) {
  const m = String(e?.message || '');
  if (/tool_choice|tool_calls|tools?\[|function_call|input_schema/i.test(m)) return true;
  return (e?.status === 400 || e?.status === 422) && /\btools?\b|\bfunction\b|工具/i.test(m);
}

/** 一轮：跑完一次 stream，把正文与工具调用一起带回。空正文在这里**不**判失败。 */
async function oneRound({ system, messages, model, maxTokens, temperature, tools, onTick }) {
  let text = '', end = {};
  for await (const t of stream({
    system, messages, model, maxTokens, temperature, tools, onTick,
    onEnd: (e) => { end = e; },
  })) text += t;
  return { text, end, toolCalls: end.toolCalls || [] };
}

/**
 * 带工具循环的生成（SYSTEM_DEFINITION §6.2）。与 complete() 并存——
 * 现有五处无工具的调用点走 complete()，行为完全不变。
 *
 * 与 complete() 的三个关键差异，每一个都是实测逼出来的：
 *
 *   1. **空正文不再一律判失败**。带 tools 的首轮实测就是「正文 0 字 + stop=tool_calls」
 *      （见 .run/probe-tools.mjs）。complete() 会把它判成 emptyTextError，
 *      再由 `produced = text.length > 0` 烧掉整条降级链——工具调用一发出就被当故障。
 *   2. **模型选定后粘住**。首轮用降级链挑出一个能干活的模型，后续轮次只用它。
 *      中途换模型会让已执行的工具副作用重放，且对话历史对新模型未必合法。
 *   3. **另设总时长闸**。callTimeoutMs 是 per-stream 的，多轮会拿到 N × 20 分钟。
 *
 * onToolCall(name, input, meta) → 字符串（或可 JSON 序列化的值）。抛错也没关系：
 * 错误会被包成工具结果回给模型，让它自己决定换个取法还是放弃——
 * 一个工具取不到不该让整轮裁决失败。
 *
 * 返回 { text, model, rounds, toolLog[], toolsDisabled?, toolsDisabledReason?, ...end, fallbacks }。
 */
export async function completeWithTools({
  system, messages, tools, onToolCall, maxTokens, temperature,
  maxRounds = NARRATIVE.tools.maxRounds,
  softToolCalls = NARRATIVE.tools.softToolCalls,
  maxToolCalls = NARRATIVE.tools.maxToolCalls,
  loopTimeoutMs = NARRATIVE.tools.loopTimeoutMs,
  maxResultChars = NARRATIVE.tools.maxResultChars,
  onFallback, onTick, onToolEvent, scope = '模型',
}) {
  const t0 = Date.now();
  const fallbacks = [];
  const toolLog = [];
  const convo = [...(messages || [])];
  const left = () => loopTimeoutMs - (Date.now() - t0);
  const tick = onTick || tickOf(null, scope, scope);   // 与 complete() 同理：活性必须有默认出口
  let used = 0;   // 已执行的工具调用数（主闸）
  let ctxFull = false;   // 上下文预算已满（v0.10.0）：与次数/轮数/时长闸同级

  // ── 首轮：用降级链挑出一个能干活的模型 ────────────────────────
  let model = null, first = null, rejected = 0, lastErr = null;
  for (let i = 0; i < MODELS.length; i++) {
    try {
      first = await oneRound({ system, messages: convo, model: MODELS[i], maxTokens, temperature, tools, onTick: tick });
      // 有正文**或**有工具调用都算产出——后者是工具循环的正常首轮形态
      if (!first.text.trim() && !first.toolCalls.length) throw emptyTextError(first.end);
      model = MODELS[i];
      break;
    } catch (e) {
      lastErr = e;
      if (e.status === 401 || e.status === 403 || e.status === 413) throw e;
      if (toolsRejected(e)) rejected++;
      if (i === MODELS.length - 1) break;
      fallbacks.push({ from: MODELS[i], to: MODELS[i + 1], reason: e.message });
      onFallback?.(MODELS[i], MODELS[i + 1], e.message);
    }
  }

  // 全链都因为「不吃 tools」而失败 → 退回无工具单次调用，如实播报。
  // 不让整轮裁决因为渠道能力缺失而失败：没有工具的结论仍然是个结论。
  if (!model && rejected > 0) {
    onToolEvent?.({ type: 'tools-disabled', reason: lastErr?.message });
    const plain = await complete({ system, messages: convo, maxTokens, temperature, onFallback, onTick }, scope);
    // toolCalls 统一为**数字**（已执行的取数次数）。complete() 的返回里
    // 透传了 stream() 的 toolCalls 数组，这里必须盖掉，否则同一字段两种类型
    return { ...plain, rounds: 1, toolCalls: 0, toolLog: [], toolsDisabled: true, toolsDisabledReason: lastErr?.message };
  }
  if (!model) throw lastErr;

  // ── 后续轮次：执行工具 → 回填 → 再问 ─────────────────────────
  let round = first;
  for (let n = 1; n <= maxRounds; n++) {
    if (!round.toolCalls.length) {
      return { text: round.text, model, ...round.end, rounds: n, toolCalls: used, toolLog, fallbacks };
    }

    // 把这一轮的 assistant turn 原样记进对话（含 tool_use 块）
    const blocks = [];
    if (round.text.trim()) blocks.push({ type: 'text', text: round.text });
    for (const c of round.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    convo.push({ role: 'assistant', content: blocks });

    // 上下文占用：上一轮的真实输入 token 优先（渠道回了 usage 时），否则整段估算；
    // 再加上刚记进去的 assistant turn。之后每回填一条工具结果就累加一次
    let ctx = (round.end?.inputTokens ?? estimateTokens(`${system || ''}\n${JSON.stringify(convo.slice(0, -1))}`))
      + estimateTokens(JSON.stringify(blocks));

    // 执行工具。预算/超时耗尽时**如实告知模型**，不静默截断——
    // 静默截断会让模型以为「取不到数据」，而真相是「不让它取了」，两者结论不同。
    const results = [];
    for (const c of round.toolCalls) {
      // 硬闸：越过即不再执行任何取数
      const hard = used >= maxToolCalls ? `取数次数已达硬上限（${maxToolCalls} 次）`
        : n >= maxRounds ? `取数轮次已达上限（${maxRounds} 轮）`
          : left() <= 0 ? '取数时间预算已用尽'
            : ctxFull ? `上下文预算已满（约 ${ctx} / ${NARRATIVE.context.inputTokens} token）` : null;
      // 软闸：仍然执行，但在结果里附告知，让模型自己决定要不要继续
      const soft = !hard && used >= softToolCalls
        ? `\n\n[预算提示] 软预算已用尽（已取数 ${used + 1} 次，软上限 ${softToolCalls}、硬上限 ${maxToolCalls}）。`
          + '若你判断某只标的的结论会因缺某份数据而出错，可以继续取；否则请开始收敛并给出结论。'
        : '';
      let content;
      if (hard) {
        content = `${hard}。请基于已有信息直接给出结论，不要再调用工具。`;
      } else if (c.argsError) {
        content = `工具参数不是合法 JSON（${c.argsError}）。原文：${String(c.argsRaw).slice(0, 200)}`;
      } else {
        used++;
        try {
          const r = await onToolCall?.(c.name, c.input, { round: n, id: c.id, used });
          content = typeof r === 'string' ? r : JSON.stringify(r ?? null);
        } catch (e) {
          content = `工具执行失败：${e.message}`;
        }
      }
      // 按上下文剩余空间收口（取代此前固定的「单条 12000 字」）
      const fit = fitToContext(content, { usedTokens: ctx, maxChars: maxResultChars });
      content = fit.content;
      const truncated = fit.truncated;
      if (fit.full) ctxFull = true;
      if (soft) content += soft;
      ctx += estimateTokens(content);
      toolLog.push({
        round: n, name: c.name, input: c.input, chars: content.length,
        truncated, exhausted: !!hard, softWarned: !!soft,
      });
      onToolEvent?.({ type: 'tool', round: n, name: c.name, input: c.input, chars: content.length, truncated, used });
      results.push({ type: 'tool_result', tool_use_id: c.id, content });
    }
    convo.push({ role: 'user', content: results });

    // 预算耗尽后最后一问：撤掉 tools，逼出正文结论（上下文满了同理）
    const done = n >= maxRounds || left() <= 0 || used >= maxToolCalls || ctxFull;
    try {
      round = await oneRound({
        system, messages: convo, model, maxTokens, temperature,
        tools: done ? undefined : tools, onTick: tick,
      });
    } catch (e) {
      // 已经取过数了，这里失败不换模型（副作用会重放、历史对新模型未必合法），
      // 但要把已做的工作带出去，便于诊断
      e.toolLog = toolLog;
      e.rounds = n;
      throw e;
    }
    if (done) {
      if (!round.text.trim()) throw emptyTextError(round.end);
      return { text: round.text, model, ...round.end, rounds: n + 1, toolCalls: used, toolLog, fallbacks, budgetExhausted: true };
    }
  }
  // maxRounds <= 0 的退化情形
  return { text: round.text, model, ...round.end, rounds: 1, toolCalls: used, toolLog, fallbacks };
}

/** 从模型输出里抽出第一个 JSON 对象（容忍 ```json 围栏与前后废话）。 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * 数字白名单校验（铁律 3 的执行机制，§5.3）。
 * 扫描模型输出中的所有数值，凡不在注入数据集内的一律判为幻觉。
 *
 * 必须做上下文感知：「第 25 分位」「P50」「52 周」「近 3 年」里的数字是**标签**不是数据，
 * 纯数值匹配会把它们全判成幻觉，导致每次归因都白跑 3 次重试（实测耗时从 40s 升到 120s+）。
 */
const LABEL_AFTER = /^\s*(分位|周|年|季|月|日|条|只|家|个|次|天|名|位|档|层|轮|pct|%\s*分位)/;
const LABEL_BEFORE = /[P第Qq]\s*$|[A-Za-z]$/;

export function validateNumbers(text, whitelist, { tolerance = 0.02 } = {}) {
  const allowed = Object.values(whitelist || {}).filter((v) => v != null && isFinite(v)).map(Number);
  const violations = [];
  const seen = new Set();
  const src = String(text || '');
  for (const m of src.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const raw = m[0];
    const v = Number(raw);
    if (!isFinite(v)) continue;
    const before = src.slice(Math.max(0, m.index - 2), m.index);
    const after = src.slice(m.index + raw.length, m.index + raw.length + 5);
    if (LABEL_BEFORE.test(before)) continue;            // P25 / 第25 / Q3
    if (LABEL_AFTER.test(after)) continue;              // 25分位 / 52周 / 3年 / 5条
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (Number.isInteger(v) && Math.abs(v) <= 12) continue;        // 序号 / 条数 / 月份
    if (Number.isInteger(v) && v >= 1900 && v <= 2100) continue;   // 年份
    // 比较取绝对值：中文用「折价 / 低于 / 下滑」承载符号，
    // 注入值 相对保守档偏离 = -0.1243 与文本「折价 12.4%」说的是同一件事，
    // 带符号比较会把它误判为幻觉（实测茅台一次运行里 12.4 被误标）。
    const hit = allowed.some((a) => {
      const A = Math.abs(a), V = Math.abs(v);
      for (const cand of [A, A * 100, A / 100, A * 1e4, A / 1e4, A * 1e8, A / 1e8]) {
        if (cand === 0) { if (V === 0) return true; continue; }
        if (Math.abs(V - cand) / cand <= tolerance) return true;
      }
      return false;
    });
    if (!hit) violations.push({ value: v, context: src.slice(Math.max(0, m.index - 8), m.index + raw.length + 8) });
  }
  return { ok: violations.length === 0, violations };
}

/** 白名单 = 提示词里出现过的全部数字（模型只能用我们给它的数）。 */
export function whitelistOf(prompt) {
  const wl = {};
  let i = 0;
  for (const m of String(prompt).matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (isFinite(v)) wl[`_p${i++}`] = v;
  }
  return wl;
}

/**
 * 排障落盘：裁决不可用时把模型原始输出留一份到 .run/，
 * 否则「JSON 解析失败」无从分诊——是空串（token 预算）、半截（流中断）
 * 还是围栏外带废话（extractJson 没匹配上）。成功路径不写。
 * tag 区分是哪一张榜失败的（verdict = 市场裁决，review = 自选池裁决）。
 */
export function dumpRaw(tag, r, err) {
  try {
    const dir = path.join(ROOT, '.run');
    fs.mkdirSync(dir, { recursive: true });
    // usage / 思考字数 / 耗时都要留：只有 stop_reason 判不出「思考吃光预算」
    // 与「思考完不写正文」这两种完全不同的失败
    const head = [
      `error: ${err?.message}`,
      `protocol: ${r?.protocol ?? '—'}`,
      `stop: ${r?.stopReason ?? '—'}`,
      `model: ${r?.model ?? '—'}`,
      `text length: ${r?.text?.length ?? 0}`,
      `thinking chars: ${r?.thinkChars ?? '—'}`,
      `elapsed: ${r?.elapsedMs != null ? Math.round(r.elapsedMs / 1000) + 's' : '—'}`,
      `usage: ${r?.usage ? JSON.stringify(r.usage) : '—'}`,
    ].join('\n');
    fs.writeFileSync(path.join(dir, `${tag}-fail-${Date.now()}.txt`), `${head}\n---\n${r?.text || ''}`);
  } catch {}
}
