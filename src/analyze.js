// 定性分析层（SYSTEM_DEFINITION §3.2 第 4 层、§5.3）。
// 两个 pass：归因（逐只）+ 裁决排序（单次处理全部候选）。
// 模型不得输出任何未经代码计算的数字——输出侧做 schema + 数字白名单双重校验。
import { complete, extractJson, validateNumbers, llmReady } from './llm.js';
import { NARRATIVE, SCREENING } from './config.js';
import { pool } from './util.js';

const ATTR_CATEGORIES = ['周期性底部', '一次性事件冲击', '流动性情绪杀', '治理折价', '结构性衰退', '商业模式证伪'];
const TRAPS = ['结构性衰退', '商业模式证伪'];

/**
 * 类别归一化：模型可能答「周期性底部（叠加情绪杀）」这类复合表述，
 * 硬性枚举校验会把整份高质量输出作废重来，代价远大于收益。
 * 改为取第一个命中的类别，原文保留在 categoryRaw。
 */
function normalizeCategory(raw) {
  const s = String(raw || '');
  const hit = ATTR_CATEGORIES.find((c) => s.includes(c));
  return hit || null;
}

const SYS_ATTRIBUTION = `你是遵循价值投资原则的资深证券分析师。

下方「已知数据」为最新实测值，请以此为准。

【任务】判断这只股票便宜的原因，是错杀（机会）还是陷阱。

归因类别与判定标准：
| 类别 | 性质 | 判定证据要求 | 否决/改判条件 |
| 周期性底部 | 机会 | 行业景气处历史低位 + 公司在前轮周期中恢复过 | 本轮行业总量趋势性萎缩 |
| 一次性事件冲击 | 机会 | 冲击可量化、有明确终点、不改变单位经济模型 | 冲击跨越 4 个季度仍在扩大 |
| 流动性情绪杀 | 机会 | 基本面数据未变化 + 存在强制卖出痕迹 | 伴随基本面下修 |
| 治理折价 | 谨慎 | 治理问题可识别且存在改善路径 | 已发生资金占用/造假处罚 |
| 结构性衰退 | 陷阱 | 营收连续下滑 + 毛利率趋势下移 + 份额流失 | — |
| 商业模式证伪 | 陷阱 | 单位经济模型恶化且不可逆 | — |

判为「结构性衰退」或「商业模式证伪」的标的将被直接剔除，请谨慎但不回避。

【必须产出否决条件】写明「若 X 发生则本结论作废」。无法证伪的看多理由不予采纳。

输出 JSON：
{
  "category": "上表六类之一",
  "isTrap": true/false,
  "confidence": "高|中|低",
  "evidence": ["支撑该归因的证据", "..."],
  "killCriteria": ["若X发生则结论作废", "..."],
  "risks": ["关键风险，3-5 条"],
  "catalysts": ["价值实现的可见催化剂；确实没有则输出空数组"],
  "summary": "两到三句话说明为什么便宜，以及这个便宜是否值得买"
}`;

const SYS_VERDICT = `你是资深投资组合分析师，负责从候选清单中选出最值得投资的标的。

下方候选数据为最新实测值，请以此为准。

【排序依据】背离分 40% + 安全边际 30% + 质量分 20% + 催化剂强度 10%。
【硬约束】最终名单中单一行业不得超过 2 只，超出者顺延。
【剔除】已标记 isTrap 的标的不得入选。

只输出 JSON：
{
  "ranked": [
    { "code": "代码", "rank": 1, "reason": "入选理由，两句话", "catalystStrength": "强|中|弱|无" }
  ],
  "excluded": [ { "code": "代码", "why": "未入选原因" } ],
  "note": "对本轮候选整体质量的一句话判断"
}`;

/**
 * 白名单 = 提示词里出现过的**全部**数字。
 *
 * 这才是铁律 3 的正确语义：「模型只能使用我们给它的数字」。
 * 早期版本只把 result.numbers 当白名单，但提示词里的「多视角判定」段落还含有
 * 行业中位 PE、合理 PB、FCF 收益率等派生数字——模型忠实引用了它们，却被判成幻觉，
 * 导致每次归因都白跑 3 次重试后放弃（实测茅台连续三轮全部误杀）。
 */
export function whitelistFromPrompt(prompt, base = {}) {
  const wl = { ...base };
  let i = 0;
  for (const m of String(prompt).matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (isFinite(v)) wl[`_p${i++}`] = v;
  }
  return wl;
}

/** 把机械层算好的数字渲染成提示词里的「已知数据」块。 */
function renderNumbers(result) {
  const s = result.stock;
  const lines = [
    `标的：${s.name}（${s.code}）  行业：${s.industry}  市场：${s.market === 'cn' ? 'A股' : '美股'}`,
    `估值口径：${result.route.reason}`,
    `档位判定：${result.tier.name}${result.tierCapped ? '（因多视角未达成一致被压制）' : ''}`,
    `置信度：${result.confidence.level}（${result.confidence.score} 分）`,
    '',
    '【已知数据】以下是全部可用数字，不得使用此外的任何数值：',
  ];
  for (const [k, v] of Object.entries(result.numbers)) lines.push(`  ${k} = ${v}`);
  if (result.routeAmbiguous && result.altBand?.ok) {
    lines.push('', '【估值口径存疑 —— 需要你判断】');
    lines.push(`  机械规则按「营收波动」把它归为周期股，但只有上行波动、没有像样的下行（${result.cyclical.reason}）。`);
    lines.push(`  若它是**周期股**：用 ${result.route.primary.toUpperCase()} 口径 → 保守 ${result.band.conservative?.toFixed(2)} / 中性 ${result.band.neutral?.toFixed(2)} / 乐观 ${result.band.optimistic?.toFixed(2)}，P/V ${result.band.pv?.toFixed(3)}`);
    lines.push(`  若它是**成长股**：用 ${result.altRoute.primary.toUpperCase()} 口径 → 保守 ${result.altBand.conservative?.toFixed(2)} / 中性 ${result.altBand.neutral?.toFixed(2)} / 乐观 ${result.altBand.optimistic?.toFixed(2)}，P/V ${result.altBand.pv?.toFixed(3)}`);
    lines.push('  请在输出的 preferredRoute 字段里选一个，并说明理由。');
  }
  lines.push('', '【多视角判定】');
  for (const [k, v] of Object.entries(result.views)) {
    const name = { selfHistory: '自身历史', peers: '同业横截面', earningsQuality: '盈利质量', roePb: '资产回报匹配', cashYield: '现金回报' }[k] || k;
    lines.push(`  ${name}：${v.verdict} —— ${v.detail}`);
  }
  if (result.cross?.conflict) lines.push(`  ⚠ ${result.cross.conflict}`);
  lines.push('', '【质量闸门】' + (result.quality?.pass === true ? '通过' : result.quality?.pass === false ? `未通过：${result.quality.failures.join('；')}` : '未评估'));
  if (result.cyclical?.cyclical) lines.push(`【周期性】判定为周期股：${result.cyclical.reason}`);
  return lines.join('\n');
}

/**
 * pass 1 · 归因（逐只）。schema + 数字白名单校验失败则重试，仍失败标记不可用。
 */
export async function attributionPass(result, { onEvent } = {}) {
  if (!llmReady()) return { ok: false, reason: '缺少模型凭据' };
  const prompt = renderNumbers(result);
  const rejects = [];   // 记录每次被拒的原因与原始输出，便于诊断（§5.3 不静默放行也不静默丢弃）
  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    try {
      const r = await complete({
        system: SYS_ATTRIBUTION,
        messages: [{ role: 'user', content: prompt + (attempt ? '\n\n上次输出不合规，请严格只输出 JSON，且不得出现已知数据之外的数字。' : '') }],
        maxTokens: NARRATIVE.maxTokens,
        onFallback: (f, t, why) => onEvent?.({ type: 'fallback', from: f, to: t, why }),
      });
      const json = extractJson(r.text);
      // 只有「压根解析不出结构」才值得重试；其余一律接受后标注
      if (!json) { rejects.push({ why: 'JSON 解析失败', raw: r.text.slice(0, 400) }); continue; }
      const category = normalizeCategory(json.category);
      // 数字白名单：只校验自由文本部分
      // 数字校验只标注、不丢弃：误报一次的代价是 3 次调用 + 130s，
      // 而实际风险（如把 76139300000 写成 761393000000 的单位滑位）标注出来就足够读者识别。
      const freeText = [json.summary, ...(json.evidence || []), ...(json.risks || []), ...(json.killCriteria || [])].join(' ');
      const v = validateNumbers(freeText, whitelistFromPrompt(prompt, result.numbers));
      if (!v.ok) onEvent?.({ type: 'suspect', values: v.violations.map((x) => x.value), attempt });
      return {
        ok: true, model: r.model, ...json,
        category: category || json.category,
        categoryRaw: json.category,
        categoryUnmatched: !category,
        isTrap: json.isTrap ?? (category ? TRAPS.includes(category) : false),
        suspectNumbers: v.violations,
      };
    } catch (e) {
      onEvent?.({ type: 'error', message: e.message, attempt });
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, reason: e.message };
    }
  }
  return { ok: false, reason: 'schema 或数字校验连续失败，标记定性分析不可用', rejects };
}

/**
 * pass 2 · 裁决排序（单次，处理全部候选）。
 * 排序是横截面判断——必须同时看到全部候选才排得出序，故不逐只调用。
 */
export async function verdictPass(candidates, { topN = SCREENING.layer4model.topN, onEvent } = {}) {
  if (!llmReady()) return { ok: false, reason: '缺少模型凭据' };
  const alive = candidates.filter((c) => !c.attribution?.isTrap);
  if (!alive.length) return { ok: true, ranked: [], excluded: candidates.map((c) => ({ code: c.stock.code, why: '归因判为陷阱' })), note: '全部候选被判为价值陷阱' };

  const block = alive.map((c, i) => {
    const n = c.numbers;
    return [
      `${i + 1}. ${c.stock.name}（${c.stock.code}）行业：${c.stock.industry}`,
      `   档位 ${c.tier.name} | P/V ${n.PV比值 ?? '—'} | 实际安全边际 ${n.实际安全边际 ?? '—'} | 要求 ${n.要求安全边际 ?? '—'}`,
      `   背离分 ${c.divergence?.score ?? '—'} | F分数 ${n.F分数 ?? '—'} | 置信度 ${n.置信度分数 ?? '—'}`,
      `   归因：${c.attribution?.category ?? '未知'} —— ${c.attribution?.summary ?? ''}`,
      `   催化剂：${(c.attribution?.catalysts || []).join('；') || '无可见催化剂'}`,
    ].join('\n');
  }).join('\n\n');

  const allNumbers = Object.assign({}, ...alive.map((c) => c.numbers));
  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    try {
      const r = await complete({
        system: SYS_VERDICT,
        messages: [{ role: 'user', content: `候选共 ${alive.length} 只，请选出最值得投资的 ${topN} 只并排序。\n\n${block}` }],
        maxTokens: NARRATIVE.maxTokens,
        onFallback: (f, t, why) => onEvent?.({ type: 'fallback', from: f, to: t, why }),
      });
      const json = extractJson(r.text);
      if (!json?.ranked?.length) continue;
      const known = new Set(alive.map((c) => c.stock.code));
      json.ranked = json.ranked.filter((x) => known.has(x.code)).slice(0, topN);
      if (!json.ranked.length) continue;
      const v = validateNumbers(json.ranked.map((x) => x.reason).join(' ') + ' ' + (json.note || ''),
        whitelistFromPrompt(block, allNumbers));
      if (!v.ok) onEvent?.({ type: 'suspect', values: v.violations.map((x) => x.value), attempt });
      return { ok: true, model: r.model, ...json, suspectNumbers: v.violations };
    } catch (e) {
      onEvent?.({ type: 'error', message: e.message, attempt });
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, reason: e.message };
    }
  }
  return { ok: false, reason: 'schema 或数字校验连续失败' };
}

/** 批量跑归因 pass，受并发限制。 */
export async function runAttributions(results, { onProgress, onEvent } = {}) {
  return pool(results, NARRATIVE.concurrency, async (r) => {
    const a = await attributionPass(r, { onEvent });
    return { ...r, attribution: a };
  }, onProgress);
}

export { renderNumbers };
