// 定性分析层（单股路径，SYSTEM_DEFINITION §3.4、§5.3）。
//
// v0.7.1：只剩归因这一个 pass。原先的 verdictPass / runAttributions 已删除——
// 零调用的死代码，且 verdictPass 引用了不存在的 SCREENING.layer4model.topN（调用即抛），
// 其提示词还带着已被 §3.2 废止的「单一行业不得超过 2 只」。
// 市场裁决在 src/verdict.js，自选裁决在 src/review.js。
//
// 数字规则改为**分层**（§5.3）：给定数据与工具返回同权可引用，
// 模型自身知识只能进 externalNotes 并标注「未经本系统验证」。
import { complete, completeWithTools, extractJson, validateNumbers, whitelistOf, llmReady } from './llm.js';
import { buildTools, withTranscript } from './tools.js';
import { renderValuation } from './deep.js';
import { ANCHOR_RULE, ANCHOR_FIELDS, WEB_RULE } from './verdict.js';
import { runResearch, renderResearch, compactResearch } from './research.js';
import { resolveAnchor } from './valuation.js';
import { NARRATIVE } from './config.js';

const ATTR_CATEGORIES = ['周期性底部', '一次性事件冲击', '流动性情绪杀', '治理折价', '盈利跑赢股价', '结构性衰退', '商业模式证伪', '其他'];
const TRAPS = ['结构性衰退', '商业模式证伪'];
// 「其他」是合法出口：不是每只便宜票都能归到上面几类，硬套比留空更误导（v0.11.3 批 C2）

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

下方「已知数据」由机械层计算，每项都带口径与来源；它**不是**不容置疑的权威——
不同表的最新期可能不同（利润是最新季、资产负债可能是年报），发现口径可疑、数量级离谱、
与你所知的事实冲突时请直接指出（见下方数字规则）。

【任务】判断这只股票便宜的原因，是错杀（机会）还是陷阱。

归因类别与判定标准：
| 类别 | 性质 | 判定证据要求 | 否决/改判条件 |
| 周期性底部 | 机会 | 行业景气处历史低位 + 公司在前轮周期中恢复过 | 本轮行业总量趋势性萎缩 |
| 一次性事件冲击 | 机会 | 冲击可量化、有明确终点、不改变单位经济模型 | 冲击跨越 4 个季度仍在扩大 |
| 流动性情绪杀 | 机会 | 基本面数据未变化 + 存在强制卖出痕迹 | 伴随基本面下修 |
| 盈利跑赢股价 | 机会 | 估值倍数下降主要来自盈利增长快于股价，而不是股价深跌 | 盈利增速回落至股价之下 |
| 治理折价 | 谨慎 | 治理问题可识别且存在改善路径 | 已发生资金占用/造假处罚 |
| 结构性衰退 | 陷阱 | 营收连续下滑 + 毛利率趋势下移 + 份额流失 | — |
| 商业模式证伪 | 陷阱 | 单位经济模型恶化且不可逆 | — |

判为「结构性衰退」或「商业模式证伪」的标的将被直接剔除，请谨慎但不回避。

${ANCHOR_RULE}

【下行情景】若你判断当前利润率处在不可持续的高位（周期高点），请用归一化锚写出下行情景，
并说明收入、利润率、倍数三者同时回落时大概是什么量级——只说「极端情形下下行有限」
而不给依据，不予采纳。

【必须产出否决条件】写明「若 X 发生则本结论作废」。无法证伪的看多理由不予采纳。

【关于数字与你自己的知识】分三层，别混：
1. **上面给定的数据**与**你用工具取回的数据**——同等可信，可直接引用。
2. **你自己的记忆与判断**——可以用，而且在给定数据看起来不对时（口径可疑、
   数量级离谱、与你所知的事实冲突）**应该**用。但必须写进 externalNotes，并说明依据。
   系统会把它标注为「外部知识，未经本系统验证」呈现给用户。
3. **不要**把记忆里的数字直接写进 summary / evidence 冒充实测值。

${WEB_RULE}

**发现给定数据有问题时请明说，不要将就着用。**

输出 JSON：
{
  ${ANCHOR_FIELDS}
  "category": "上表类别之一；都不贴合或证据不足时写「其他」",
  "isTrap": true/false,
  "confidence": "高|中|低",
  "evidence": ["支撑该归因的证据", "..."],
  "killCriteria": ["若X发生则结论作废", "..."],
  "risks": ["关键风险，3-5 条"],
  "catalysts": ["价值实现的可见催化剂；确实没有则输出空数组"],
  "externalNotes": [{ "claim": "基于自身知识的判断或对给定数据的质疑", "why": "依据" }],
  "summary": "两到三句话说明为什么便宜，以及这个便宜是否值得买"
}`;

const TOOL_GUIDE = `【你可以主动取数】
上面的已知数据是机械层算出来的**摘要**，它答不了「这个便宜是错杀还是陷阱」——
那需要行业格局、经营解释、管理层自述。所以给了你工具。

最有价值的是 get_filing：能取到年报/半年报（美股 10-K）里管理层自己写的
行业判断、经营解释与风险披露。判断错杀与陷阱时它通常比任何财务比率都管用。

这是**单只标的的深度分析**，预算相对宽松——该取的数据不要省。
预算接近用尽时系统会如实告知你。`;

/** 把机械层算好的数字渲染成提示词里的「已知数据」块。 */
function renderNumbers(result) {
  const s = result.stock;
  const lines = [
    `标的：${s.name}（${s.code}）  行业：${s.industry}  市场：${s.market === 'cn' ? 'A股' : '美股'}`,
    `估值口径：${result.route.reason}——这只是下方估值锚之一，不代表股性判断`,
    `档位判定（按机械默认口径）：${result.tier.name}${result.tierCapped ? '（因多视角未达成一致被压制）' : ''}`,
    `置信度：${result.confidence.level}（${result.confidence.score} 分）`,
    '',
    // 措辞随分层规则一起改：旧文案「不得使用此外的任何数值」与
    // 「发现数据有问题请明说」自相矛盾，模型会不敢质疑。
    '【已知数据】机械层实测值。定量结论请用这些数字（或你用工具取回的数字）：',
  ];
  for (const [k, v] of Object.entries(result.numbers)) lines.push(`  ${k} = ${v}`);
  // v0.10.0：此前这里只在「口径存疑」时给两条口径，并要求一个没人读的 preferredRoute 字段。
  // 现在全部锚无条件并排给出，模型用 anchor 字段选，结果由 resolveAnchor 回填成数字
  if (result.valuationView) {
    lines.push('', '【股性与估值锚 —— 需要你判断】');
    for (const l of renderValuation(result.valuationView)) lines.push(`  ${l}`);
  }
  lines.push('', '【多视角判定】');
  for (const [k, v] of Object.entries(result.views)) {
    const name = { selfHistory: '自身历史', peers: '同业横截面', earningsQuality: '盈利质量', roePb: '资产回报匹配', cashYield: '现金回报' }[k] || k;
    lines.push(`  ${name}：${v.verdict} —— ${v.detail}`);
  }
  if (result.cross?.conflict) lines.push(`  ⚠ ${result.cross.conflict}`);
  lines.push('', '【质量闸门】' + (result.quality?.pass === true ? '通过' : result.quality?.pass === false ? `未通过：${result.quality.failures.join('；')}` : '未评估'));
  return lines.join('\n');
}

/**
 * pass 1 · 归因（逐只）。schema + 数字白名单校验失败则重试，仍失败标记不可用。
 */
export async function attributionPass(result, { onEvent, useTools = true, research = true } = {}) {
  if (!llmReady()) return { ok: false, reason: '缺少模型凭据' };
  // 联网研究（v0.11.0）：单股是用户点名深挖一只，同样由一个研究员会话先查「年报之后发生了什么」。
  // 失败不中止——没有联网结论的归因仍然是归因，提示词里会如实写明缺这一块
  const s = result.stock || {};
  const web = research && s.code
    ? await runResearch([{
      code: s.code, name: s.name, market: s.market, industry: s.industry,
      price: result.price ?? s.price, quarters: result.valuationView?.quarters || null,
    }], { onEvent })
    : null;
  const prompt = renderNumbers(result) + (web ? `\n\n${renderResearch(web, [s])}` : '');
  const rejects = [];   // 记录每次被拒的原因与原始输出，便于诊断（§5.3 不静默放行也不静默丢弃）
  // 单股的取数工具。byCode 只放这一只——模型不能把分析扩散到没收集过的标的。
  const row = { ...(result.stock || {}), price: result.price ?? result.stock?.price };
  const kit = useTools && row.code ? buildTools({ rows: [row] }) : null;
  const b = NARRATIVE.tools.budgets.single;
  const system = SYS_ATTRIBUTION + (kit ? `\n\n${TOOL_GUIDE}` : '');
  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    try {
      const tr = kit ? withTranscript(kit.handle) : null;
      const msgs = [{ role: 'user', content: prompt + (attempt ? '\n\n上次输出不合规，请严格只输出 JSON。' : '') }];
      const r = kit
        ? await completeWithTools({
          system, messages: msgs, tools: kit.defs, onToolCall: tr.handle,
          softToolCalls: b.soft, maxToolCalls: b.hard,
          maxTokens: NARRATIVE.maxTokens,
          onFallback: (f, t, why) => onEvent?.({ type: 'fallback', from: f, to: t, why }),
          onToolEvent: (e) => onEvent?.(e),
        })
        : await complete({
          system, messages: msgs,
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
      // 分层数字：L1 提示词 + L2 工具返回同为白名单；L3（externalNotes）不参与校验
      const freeText = [json.summary, json.anchorWhy, ...(json.evidence || []), ...(json.risks || []), ...(json.killCriteria || [])].join(' ');
      const v = validateNumbers(freeText, whitelistOf(prompt + (tr ? '\n' + tr.text() : '')));
      if (!v.ok) onEvent?.({ type: 'suspect', values: v.violations.map((x) => x.value), attempt });
      return {
        ok: true, model: r.model, ...json,
        category: category || json.category,
        categoryRaw: json.category,
        // 模型只选锚，数字由代码按所选锚回填
        valuation: resolveAnchor(json.anchor, result.anchors),
        categoryUnmatched: !category,
        isTrap: json.isTrap ?? (category ? TRAPS.includes(category) : false),
        externalNotes: (json.externalNotes || [])
          .filter((x) => String(x?.claim || '').trim())
          .map((x) => ({ claim: String(x.claim).trim(), why: String(x.why || '').trim() || null })),
        suspectNumbers: v.violations,
        toolLog: r.toolLog || [], toolCalls: r.toolCalls || 0,
        toolsDisabled: r.toolsDisabled || undefined,
        research: compactResearch(web),
      };
    } catch (e) {
      onEvent?.({ type: 'error', message: e.message, attempt });
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, reason: e.message, research: compactResearch(web) };
    }
  }
  return { ok: false, reason: 'schema 或数字校验连续失败，标记定性分析不可用', rejects, research: compactResearch(web) };
}

export { renderNumbers };
