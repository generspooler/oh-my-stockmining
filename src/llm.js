// Anthropic Messages API 兼容客户端（流式 + 降级链）。凭据取自环境变量。
// harness 运行时用 claude；模型链 glm-5.3-flash → deepseek-V4.1-flash（§6.2）。
import { NARRATIVE } from './config.js';

const BASE = NARRATIVE.baseUrl.replace(/\/+$/, '');
const KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
export const MODELS = [NARRATIVE.model, ...NARRATIVE.fallbacks.filter((m) => m !== NARRATIVE.model)];
export const llmReady = () => Boolean(KEY);

const headers = () => ({
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
  'x-api-key': KEY,
  authorization: `Bearer ${KEY}`,
});

/**
 * 流式生成。
 * 无数据看门狗衡量的是「连接是否活着」而非「正文是否已开始」——
 * 带 thinking 的模型会先发 thinking_delta，按正文首 token 计时会误杀健康生成。
 */
export async function* stream({ system, messages, model, maxTokens = NARRATIVE.maxTokens, temperature, onEnd }) {
  if (!KEY) throw new Error('缺少 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，无法调用模型');
  const body = { model, system, messages, max_tokens: maxTokens, stream: true };
  if (temperature != null) body.temperature = temperature;
  const abort = new AbortController();
  let watchdog;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () => abort.abort(new Error(`无数据超时（${Math.round(NARRATIVE.firstTokenTimeoutMs / 1000)}s）`)),
      NARRATIVE.firstTokenTimeoutMs,
    );
  };
  arm();
  let drained = false;
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body), signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`模型调用失败 HTTP ${res.status}: ${detail.slice(0, 300)}`);
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
        if (evt.type === 'content_block_delta') { anyDelta = true; if (evt.delta?.text) yield evt.delta.text; }
        if (evt.type === 'message_delta' && evt.delta?.stop_reason) { stopReason = evt.delta.stop_reason; usage = evt.usage || usage; }
        if (evt.type === 'error') throw new Error(evt.error?.message || '模型返回错误');
      }
    }
    drained = true;
    onEnd?.({ stopReason, usage, anyDelta });
  } finally {
    clearTimeout(watchdog);
    if (!drained) abort.abort();
  }
}

/**
 * 带降级链的一次性生成。零产出即失败才换模型；已开始产出再失败的不换。
 * 返回 { text, model, stopReason, fallbacks[] }。
 */
export async function complete({ system, messages, maxTokens, temperature, onFallback }) {
  let lastErr;
  const fallbacks = [];
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    let text = '', produced = false, end = {};
    try {
      for await (const t of stream({
        system, messages, model, maxTokens, temperature,
        onEnd: (e) => { end = e; if (e.anyDelta) produced = true; },
      })) { produced = true; text += t; }
      // 思考型模型的 reasoning token 与正文共用 max_tokens：思考过长会把配额吃光，
      // 表现为 stop_reason=max_tokens 且正文为空。这种情况必须报错而不是返回空串，
      // 否则上层只看到「JSON 解析失败」，查不到真因。
      if (!text.trim() && end.stopReason === 'max_tokens') {
        throw new Error(`思考耗尽 token 预算（output ${end.usage?.output_tokens ?? '?'}，其中 reasoning ${end.usage?.billing_usage?.openai_usage?.completion_tokens_details?.reasoning_tokens ?? '?'}），正文为空。请提高 maxTokens`);
      }
      return { text, model, ...end, fallbacks };
    } catch (e) {
      lastErr = e;
      if (produced || i === MODELS.length - 1) throw e;
      fallbacks.push({ from: model, to: MODELS[i + 1], reason: e.message });
      onFallback?.(model, MODELS[i + 1], e.message);
    }
  }
  throw lastErr;
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
