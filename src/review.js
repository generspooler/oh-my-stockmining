// 自选池裁决（SYSTEM_DEFINITION §3.3）。
//
// 与市场总裁决（src/verdict.js）是两张不同的榜，问题也不同：
//   市场榜问「全市场现在最值得买的是哪几只」——没选中的票用户本来也不认识，落选只需一句话。
//   自选榜问「我盯着的这些，现在各自该不该买」——**池内每一只都必须有结论**，
//   没进榜的要写清为什么现在不该买、什么条件下才重新考虑（用户决策 2026-09-23）。
//
// 因此本模块有一条市场裁决没有的铁律：top ∪ rejected 必须覆盖全池。
// 模型漏报的由代码补进落选区并显著标注——静默吞掉会让用户把「模型没提」
// 误读成「这只没问题」。
//
// 大池子必须分批（v0.6.1）。实测教训：43 只一次要模型写出 43 份结论
// （≈1.6 万 token 正文），glm-5.3-flash 思考 15 分钟后 stop_reason=end_turn、
// 正文 0 字——不是超预算，是单次输出量过大直接写不出来。改成
// 「批内先筛 → 终裁只处理入围的」后，每次调用的输出量都与市场裁决相当。
import { complete, completeWithTools, extractJson, validateNumbers, whitelistOf, dumpRaw, tickText } from './llm.js';
import {
  fitBoard, boardRule, BOARD_FIELDS, ANCHOR_FIELDS, CRITERIA, NUMBER_RULE, PITCH_RULE, withValuation, normalizeExternal,
} from './verdict.js';
import { runResearch, renderResearch, compactResearch } from './research.js';
import { resolveAnchor } from './valuation.js';
import { renderProfile } from './deep.js';
import { buildTools, withTranscript } from './tools.js';
import { pool as runPool } from './util.js';
import { SCREENING, NARRATIVE } from './config.js';

/** 落选状态的标准取值。模型可自由发挥，不匹配的原样保留（与归因类别同一条处理取向）。 */
export const STANCES = ['估值已修复', '等待催化', '基本面待验证', '疑似价值陷阱', '数据不足'];

const REJECT_SCHEMA = `{
      "code": "代码",
      ${ANCHOR_FIELDS}
      "stance": "估值已修复/等待催化/基本面待验证/疑似价值陷阱/数据不足",
      "why": "三句话：现在什么状态、为什么现在不该买、什么条件下重新考虑",
      "keyData": "支撑上述判断的关键数据，顿号分隔，如「P/V 1.02、安全边际 -2%、ROE 当期 9% vs 5年中位 18%、52周回撤 -8%」",
      "suggestRemove": false
    }`;

// 自选池特有的两条（市场榜没有）+ 与市场榜共用的选择标准与数字规则。
// v0.11.3 批 B：CRITERIA / NUMBER_RULE 改为从 verdict.js 引入，
// 此前这里有一份几乎逐字相同的复制品，两份措辞已经开始漂移。
const COMMON = `判断标准与全市场挖掘完全一致——不因为是用户自选就放水，也不因为他长期跟踪
就假设他已经理解了风险。

每只都附有：机械层算出的估值锚与质量指标（数字由代码计算，见每项旁边的口径说明）、
多区间回撤、以及最近的新闻与公告。

${CRITERIA}

自选池特有的两条：
- 池内标的可能**不在挖掘池范围内**（ST、流动性不足、美股金融地产等），这类行已标注。
  照常分析，但要说明估值口径适配有限。
- 判为「结构性衰退」或「商业模式证伪」的，把该条 rejected 的 suggestRemove 设为 true。
  这只是**建议**——系统不会替用户删票，删不删由他决定。

${NUMBER_RULE}`;

const SYS = `你是深耕全球资本市场多年的资深价值投资分析师，遵循价值投资原则。

下面是**用户长期跟踪的自选池**——他自己点名要盯的标的，不是从全市场筛出来的候选。
它们没有经过任何粗筛：入池只代表用户的意图，不代表已经通过质量或估值检验。

任务：对下列每一只给出「当下该不该买」的判断。

1. 给出 **{{MIN_N}}~{{TOP_N}} 只**的榜单并排序，逐只给完整分析。

{{BOARD_RULE}}

2. **没进榜的每一只都必须出现在 rejected 里，一只都不能漏。**
   用户要知道自己池子里每只票此刻的状态，「没提到」对他等于信息丢失。
   每条 rejected 的 why 恰好写三句连贯的话，依次讲清：现在处于什么状态、
   为什么现在不该买、**什么条件出现才值得重新考虑**。**不要写①②③之类的序号**，
   直接写成三句话。keyData 另列支撑该判断的关键数据。
   第三句的条件必须是**能从外面观察到**的经营或价格事件（「毛利率连续两季回升」
   「回购公告落地」「价格回到 XX 以下」），不要写「等数据源补齐」「待系统修好」这类
   用户无法据此行动的话——那是系统的问题，不是这只票的状态。
   rejected 按**离买入标准由近到远**排序（最接近达标的排最前）。

${COMMON}

硬约束：进榜的每只必须给出**否决条件**：写明「若 X 发生则本结论作废」。
无法证伪的看多理由不予采纳。

${PITCH_RULE}

只输出 JSON：
{
  "top": [
    {
      "code": "代码", "rank": 1,
      ${BOARD_FIELDS}
      ${ANCHOR_FIELDS}
      "stance": "仅 meetsBar 为 false 时填写：估值已修复/等待催化/基本面待验证/疑似价值陷阱/数据不足",
      "attribution": "周期性底部/一次性事件冲击/流动性情绪杀/治理折价/盈利跑赢股价/结构性衰退/商业模式证伪/暂不归类",
      "pitch": "开篇：三问各成一段（为什么值得拥有/为什么是现在/一句话最大前提），≤500字，写给投资人",
      "thesis": "核实与细节：支撑开篇的验证过程——口径调整、关键经营数据、归因推理",
      "killCriteria": ["若X发生则结论作废", "..."],
      "risks": ["关键风险 2-3 条"],
      "catalyst": "价值实现路径；无则写'无可见催化剂，需要耐心'",
      "valuationCaveat": "对所选锚仍有的保留（例如分位窗口偏短、口径适配有限），没有就留空"
    }
  ],
  "rejected": [${REJECT_SCHEMA}],
  "externalNotes": [
    { "code": "涉及的代码，整体性判断可省略", "claim": "你基于自身知识提出的判断或质疑", "why": "依据" }
  ],
  "note": "整个池子的组合视角判断：行业是否过度集中、整体处在什么位置"
}`;

// 工具可用时追加的指引。不可用时（渠道不支持）这段不出现，避免让模型去调不存在的东西。
const TOOL_GUIDE = `【你可以主动取数】
档案是机械层给的**摘要**，它答不了「这个便宜是错杀还是陷阱」——那需要行业格局、
经营解释、管理层自述，这些不在档案里。所以给了你工具，不要只对着摘要下结论。

最有价值的是 get_filing：能取到年报/半年报里管理层自己写的行业判断、经营解释与风险披露。
判断「错杀还是陷阱」时它通常比任何财务比率都管用。
美股年报常已是半年多前的事：想知道最近一个季度管理层怎么说，用 form=10-Q 取最新季报。

取数预算有限，**自己决定花在哪里**。判断的标准是「这份材料能不能推翻我现在的判断」：
- 准备判**达标（值得买）**的标的必须取数，而且要去找**反证**——能推翻看多逻辑的那份材料
  （最新季报里管理层怎么解释最近的经营变化、风险章节说了什么、现金流与利润是否背离）。
  只看档案就下买入结论，等于拿一份可能过期的摘要下注；
- 明显已修复或明显是陷阱的，不必浪费预算；
- 拿不准的优先取——预算就是为了消除这种拿不准。
预算接近用尽时系统会如实告知你，届时请开始收敛。
（批内初筛不开工具，这是设计：分流用档案足够，深度留给终裁。）`;

const BATCH_SYS = `你是深耕全球资本市场多年的资深价值投资分析师，遵循价值投资原则。

下面是**用户自选池中的一批**（按行业聚拢，便于批内横向比较）。它们是用户点名跟踪的标的，
没有经过任何粗筛：入池只代表用户的意图，不代表已经通过质量或估值检验。

这是两段式裁决的第一段（批内初筛）。你的任务不是写完整投资逻辑，而是**分流**：

1. picks：挑出这一批里**最多 {{MAX}} 只**值得进入终裁的。宁缺毋滥——
   这一批没有值得买的就给空数组，绝不为了凑数把估值已修复或基本面已证伪的放进来。
   picks 只写一句话说明为什么值得进终裁，**完整逻辑留给终裁，这里不要展开**。
   两类都值得送进终裁（v0.11.3）：**看着可能达标**的，以及**便宜但你还拿不准**的
   （后者请在 why 里写明拿不准的是什么——终裁会取数去查）。已经判为陷阱的不送。
2. rejected：**这一批里其余每一只都必须出现，一只都不能漏。**
   用户要知道自己池子里每只票此刻的状态，「没提到」对他等于信息丢失。
   why 恰好三句连贯的话，依次讲清：现在处于什么状态、为什么现在不该买、
   什么条件出现才值得重新考虑（必须是能从外面观察到的经营或价格事件，
   不要写「等数据源补齐」这类用户无法据此行动的话）。**不要写①②③之类的序号**。keyData 另列关键数据。
   rejected 按**离买入标准由近到远**排序（最接近达标的排最前）：终榜至少要有
   {{MIN_N}} 只，各批入围不够时，系统按这个次序把人补进终裁。

${COMMON}

只输出 JSON：
{
  "picks": [{ "code": "代码", "why": "一句话：为什么值得进终裁" }],
  "rejected": [${REJECT_SCHEMA}],
  "note": "这一批的整体观察"
}`;

const key = (c) => String(c || '').toUpperCase();

/**
 * 分批切分（纯函数，可测）。按行业聚拢后切成**数量均衡**的几批：
 * 同业相邻让批内横向比较有意义；均衡是为了避免出现「14 只 + 1 只」这种
 * 为一只票单独花一次调用的切法。
 */
export function splitForReview(profiles, size = NARRATIVE.watchBatchSize) {
  const rows = profiles || [];
  if (rows.length <= size) return rows.length ? [rows] : [];
  const ordered = [...rows].sort((a, b) =>
    String(a.sector || a.industry || '').localeCompare(String(b.sector || b.industry || '')));
  const n = Math.ceil(ordered.length / size);
  const per = Math.ceil(ordered.length / n);
  const out = [];
  for (let i = 0; i < ordered.length; i += per) out.push(ordered.slice(i, i + per));
  return out;
}

/** 落选条目规整：去幻觉代码、去重、补缺省字段。单次与分批两条路共用。 */
function normalizeRejected(list, known, exclude = new Set(), seen = new Set()) {
  const out = [];
  for (const x of list || []) {
    const k = key(x?.code);
    if (!known.has(k) || exclude.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({
      code: known.get(k).code,
      stockType: x.stockType || null, anchor: x.anchor ?? null, anchorWhy: x.anchorWhy || null,
      valuation: resolveAnchor(x.anchor, known.get(k).anchors),
      stance: x.stance || '未归类',
      stanceUnmatched: x.stance && !STANCES.includes(x.stance) ? true : undefined,
      why: x.why || '',
      keyData: x.keyData || null,
      suggestRemove: !!x.suggestRemove,
    });
  }
  return out;
}

/**
 * 全池覆盖兜底（纯函数）：既不在 top 也不在 rejected 的票补进落选区并标 unanswered。
 * 这是自选榜的铁律——用户加进池子的票，跑完一轮必须能在结果里找到它。
 * 批次整批失败时，那一批的票也在这里被兜住（显式标出，而不是凭空消失）。
 */
export function completeCoverage(top, rejected, profiles) {
  const seen = new Set();
  const kept = [];
  for (const x of rejected || []) {
    const k = key(x?.code);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    kept.push(x);
  }
  const covered = new Set([...(top || []).map((x) => key(x.code)), ...seen]);
  const missing = (profiles || [])
    .filter((p) => !covered.has(key(p.code)))
    .map((p) => ({
      code: p.code, stance: '模型未给结论',
      why: '本轮模型没有对这只给出结论——它既没进榜，也没被判落选，状态未知（多半是输出被截断）。'
        + '这不是「没问题」，只是没被回答。建议重跑一次自选池挖掘，或对它单独做一次单股分析。',
      keyData: null, suggestRemove: false, unanswered: true,
    }));
  return [...kept, ...missing];
}

const firstSentence = (s) => String(s || '').split(/(?<=[。！？])/)[0] || '';

/**
 * 被席位裁定截掉的条目 → 落选条目。它们模型**给过结论**，
 * 不能落进兜底变成「模型未给结论」（那条文案说的是「多半是输出被截断」，是错的）。
 */
function droppedToRejected(x, topN, anchors) {
  const val = {
    stockType: x.stockType || null, anchor: x.anchor ?? null, anchorWhy: x.anchorWhy || null,
    valuation: resolveAnchor(x.anchor, anchors),
  };
  if (x.droppedWhy === 'overMax') {
    return {
      ...val, code: x.code, stance: '达标但超出席位',
      why: `模型判为达标，但达标标的超过 ${topN} 席上限，按模型排序被截去。${firstSentence(x.pitch || x.thesis)}`,
      keyData: null, suggestRemove: false,
    };
  }
  return {
    ...val, code: x.code, stance: x.stance || '未归类',
    why: x.belowBarReason || x.pitch || x.thesis || '模型判为未达标；达标标的已满足榜单下限，无需补位。',
    keyData: x.keyData || null, suggestRemove: !!x.suggestRemove,
  };
}

/**
 * 裁决结果归一化（纯函数，可测）。四件事：
 *   1. 席位裁定（`fitBoard`）：min~max 席，达标在前、补位在后，重新编号
 *      （席位由代码裁定，不采信模型自报的 rank）；
 *   2. 模型给的不足下限时，按落选区次序（提示词要求「离达标由近到远」）由代码补位；
 *   3. rejected 去掉幻觉代码、去重、剔除已进榜的；被截掉的带原因放回落选区；
 *   4. 兜底补漏（`completeCoverage`）。
 */
export function normalizeReview(json, profiles, {
  topN = SCREENING.watch.topN, minN = SCREENING.watch.minN,
} = {}) {
  const known = new Map(profiles.map((p) => [key(p.code), p]));
  const raw = (json?.top || []).filter((x) => known.has(key(x?.code)));
  const rej = normalizeRejected(json?.rejected, known, new Set(raw.map((x) => key(x.code))));
  const fill = rej.map((x) => ({
    code: x.code, stance: x.stance, belowBarReason: x.why,
    keyData: x.keyData, suggestRemove: x.suggestRemove,
    stockType: x.stockType, anchor: x.anchor, anchorWhy: x.anchorWhy,
  }));
  // 模型只选锚，数字由代码按所选锚从档案里回填（resolveAnchor）
  const { top, dropped } = withValuation(fitBoard(raw, { min: Math.min(minN, profiles.length), max: topN, fill }), known);
  const inTop = new Set(top.map((x) => key(x.code)));
  const rejected = completeCoverage(top, [
    ...rej.filter((x) => !inTop.has(key(x.code))),
    ...dropped.map((x) => droppedToRejected({ ...x, code: known.get(key(x.code)).code }, topN, known.get(key(x.code)).anchors)),
  ], profiles);
  return { top, rejected, externalNotes: normalizeExternal(json?.externalNotes, known) };
}

/**
 * 分批路径的下限补足（纯函数，可测）：各批入围合计不足 need 只时，
 * 从各批落选区**轮流**取人补进终裁——每批取它排在最前（最接近达标）的，
 * 避免补位全落在同一批、同一个行业。疑似陷阱与建议移出的排到最后才用。
 * 返回要补进终裁的代码（原始写法），不含已入围的。
 */
export function promoteForFloor(batchRejected, picked, need) {
  if (need <= 0) return [];
  const trap = (x) => x.suggestRemove || /陷阱|证伪|衰退/.test(x.stance || '');
  const queues = (batchRejected || []).map((list) => (list || []).filter((x) => x?.code && !picked.has(key(x.code))));
  const out = [];
  const seen = new Set();
  for (const pass of [(x) => !trap(x), trap]) {
    const qs = queues.map((q) => q.filter(pass));
    for (let i = 0; out.length < need && qs.some((q) => i < q.length); i++) {
      for (const q of qs) {
        const x = q[i];
        if (!x || seen.has(key(x.code))) continue;
        seen.add(key(x.code));
        out.push(x.code);
        if (out.length >= need) break;
      }
    }
  }
  return out;
}

// 外部知识条目规整（分层数字规则 L3）的唯一实现在 verdict.js，两张榜共用。
// 这里只转出去——本轮刚删掉过一个分叉的重复实现（whitelistFromPrompt），不再制造第二个。
export { normalizeExternal };

/**
 * 模型活性回传：思考中/正在写 + 已多少字 + 已多久。没有它，长调用与死机无从分辨。
 * key 单独给（§5.1）：批内初筛是并行多批，每批一个单元；只有 scope 的话
 * 台账会把所有批次数成一个「终裁」，批次并行度就看不出来了。
 */
const tickOf = (onEvent, scope, key) => (t) => onEvent?.({
  type: 'tick', scope, key: key || scope, ...t, text: tickText(scope, t),
});

/**
 * 单次裁决（池子不大，或分批后的终裁）。
 * 榜单 minN~topN 席（v0.9.0）：达标不足下限时由「最接近达标」的补位并逐只标注。
 * 下限按池子大小截断——池子只有 3 只时下限就是 3。
 */
async function reviewOnce(profiles, { topN, minN, onEvent, preScreened = null, tools = null, web = null } = {}) {
  const block = profiles.map((p, i) => renderProfile(p, i)).join('\n\n');
  const n = Math.min(topN, profiles.length);
  const min = Math.min(minN, n);
  const promoted = preScreened?.promoted || [];
  const nameOf = (c) => profiles.find((p) => key(p.code) === key(c))?.name || c;
  const lead = preScreened
    ? `以下 ${profiles.length} 只是从用户自选池（共 ${preScreened.pool} 只）分 ${preScreened.batches} 批初筛后入围终裁的标的。`
      + `未入围的已在初筛阶段逐只给过落选理由，这里不必再提。`
      + (promoted.length
        ? `其中 ${promoted.map((c) => `${nameOf(c)}（${c}）`).join('、')} 在初筛被判落选，`
          + `因为各批入围合计不足榜单下限 ${min} 只而补进终裁——请重新评估，仍不达标就作为补位标 meetsBar=false。`
        : '')
    : `用户自选池共 ${profiles.length} 只。`;
  const prompt = `${lead}请给出 ${min}~${n} 只的榜单并排序（达标的最多 ${n} 只；不足 ${min} 只时用最接近达标的补位并标 meetsBar=false），`
    + `其余每一只都要在 rejected 里给出三句话的理由与关键数据（一只都不能漏）。\n\n`
    + (web ? `${renderResearch(web, profiles)}\n\n` : '')
    + block;
  const system = SYS
    .replace(/\{\{BOARD_RULE\}\}/g, boardRule(min, n, '池内标的'))
    .replace(/\{\{MIN_N\}\}/g, String(min))
    .replace(/\{\{TOP_N\}\}/g, String(n)) + (tools ? `\n\n${TOOL_GUIDE}` : '');

  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    let r = null;
    try {
      // 工具可用时走工具循环；不可用（或渠道不支持）时退回单次调用，行为与 v0.6 一致
      const tr = tools ? withTranscript(tools.handle) : null;
      r = tools
        ? await completeWithTools({
          system, messages: [{ role: 'user', content: prompt }],
          tools: tools.defs, onToolCall: tr.handle,
          softToolCalls: tools.soft, maxToolCalls: tools.hard,
          maxTokens: NARRATIVE.maxTokens, scope: '终裁',
          onFallback: (f, t, why) => onEvent?.({ type: 'fallback', from: f, to: t, why }),
          onTick: tickOf(onEvent, '终裁'),
          onToolEvent: (e) => onEvent?.({ ...e, scope: '终裁' }),
        })
        : await complete({
          system, messages: [{ role: 'user', content: prompt }],
          maxTokens: NARRATIVE.maxTokens,
          onFallback: (f, t, why) => onEvent?.({ type: 'fallback', from: f, to: t, why }),
          onTick: tickOf(onEvent, '终裁'),
        }, '终裁');
      const json = extractJson(r.text);
      if (!json || (!json.top?.length && !json.rejected?.length)) {
        dumpRaw('review', r, new Error(json ? '模型输出 top 与 rejected 均为空' : 'JSON 解析失败'));
        continue;
      }
      const { top, rejected, externalNotes } = normalizeReview(json, profiles, { topN: n, minN: min });
      // 终裁自己给的落选理由（含对数据/研究段的质疑）：大池子路径此前把这一整块丢在这里，
      // 于是「模型质疑过」与「模型没质疑」在结果里长得一样（v0.11.3）
      const droppedNotes = rejected
        .filter((x) => x.why && !x.unanswered)
        .map((x) => ({ code: x.code, claim: x.why, why: '终裁落选理由' }));
      if (!top.length && rejected.every((x) => x.unanswered)) {
        dumpRaw('review', r, new Error('模型输出的代码全部不在自选池内'));
        continue;
      }
      // 分层数字：L1 提示词 + L2 工具返回同为白名单；L3（externalNotes）不参与校验，
      // 它本来就是「模型自己的知识」，拿实测白名单去校验它等于不许它质疑数据。
      const text = [
        ...top.map((x) => `${x.pitch || ''} ${x.thesis || ''} ${x.belowBarReason || ''} ${x.anchorWhy || ''} ${x.keyData || ''} ${(x.killCriteria || []).join(' ')} ${(x.risks || []).join(' ')}`),
        ...rejected.map((x) => `${x.why} ${x.keyData || ''}`),
      ].join(' ');
      const v = validateNumbers(text, whitelistOf(prompt + (tr ? '\n' + tr.text() : '')));
      if (!v.ok) onEvent?.({ type: 'suspect', values: v.violations.map((x) => x.value) });
      return {
        ok: true, model: r.model, top, rejected, externalNotes, droppedNotes,
        note: json.note || null, suspectNumbers: v.violations,
        toolLog: r.toolLog || [], toolCalls: r.toolCalls || 0,
        toolsDisabled: r.toolsDisabled || undefined, budgetExhausted: r.budgetExhausted || undefined,
      };
    } catch (e) {
      onEvent?.({ type: 'error', message: e.message });
      dumpRaw('review', r, e);
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, reason: e.message };
    }
  }
  return { ok: false, reason: 'JSON 解析连续失败' };
}

/** 批内初筛：只分流（谁进终裁）+ 给落选者完整理由。不写投资逻辑，输出量因此可控。 */
async function reviewBatch(profiles, { maxPicks, minN, onEvent, label } = {}) {
  const block = profiles.map((p, i) => renderProfile(p, i)).join('\n\n');
  const prompt = `这一批共 ${profiles.length} 只（已按行业聚拢）。请挑出最多 ${maxPicks} 只值得进入终裁的，`
    + `其余每一只都要在 rejected 里给出三句话的理由与关键数据（一只都不能漏）。\n\n${block}`;
  const system = BATCH_SYS.replace(/\{\{MAX\}\}/g, String(maxPicks)).replace(/\{\{MIN_N\}\}/g, String(minN));

  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    let r = null;
    try {
      r = await complete({
        system, messages: [{ role: 'user', content: prompt }],
        maxTokens: NARRATIVE.maxTokens,
        onFallback: (f, t, why) => onEvent?.({ type: 'fallback', batch: label, from: f, to: t, why }),
        onTick: tickOf(onEvent, label, `batch:${label}`),
      }, label);
      const json = extractJson(r.text);
      if (!json || (!json.picks?.length && !json.rejected?.length)) {
        dumpRaw('review-batch', r, new Error(json ? '模型输出 picks 与 rejected 均为空' : 'JSON 解析失败'));
        continue;
      }
      const v = validateNumbers(
        (json.rejected || []).map((x) => `${x.why || ''} ${x.keyData || ''}`).join(' '),
        whitelistOf(prompt),
      );
      return {
        ok: true, model: r.model, label,
        picks: (json.picks || []).map((x) => x?.code).filter(Boolean),
        rejected: json.rejected || [], note: json.note || null,
        suspectNumbers: v.violations,
      };
    } catch (e) {
      onEvent?.({ type: 'error', batch: label, message: e.message });
      dumpRaw('review-batch', r, e);
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, label, reason: e.message };
    }
  }
  return { ok: false, label, reason: 'JSON 解析连续失败' };
}

/**
 * 自选池裁决。池子小就一次调用；超过 `NARRATIVE.watchBatchSize` 走两段式（批内初筛 → 终裁）：
 * 批内初筛（并行）→ 终裁只处理入围的。
 *
 * 分批的语义代价：「谁进榜」先在批内比较、再做总排序，不再是全池严格同框
 * ——与市场挖掘的粗筛→裁决同一个路子（用户决策 2026-09-23）。
 * 换来的是每次调用的输出量恒定：单次写 43 份结论实测直接写不出来。
 */
export async function watchReview(profiles, {
  topN = SCREENING.watch.topN, minN = SCREENING.watch.minN, onEvent, onProgress, rows = null,
} = {}) {
  if (!profiles.length) return { ok: false, reason: '自选池内没有可裁决的标的' };
  const known = new Map(profiles.map((p) => [key(p.code), p]));
  // minN 回写的是**生效值**（池子不足下限时被截断），渲染层据此说「至少几只」
  const base = { scope: 'watch', pool: profiles.length, topN, minN: Math.min(minN, profiles.length), profiles: known };

  // 终裁的取数工具。批内初筛**不开工具**（用户决策）——它只做分流，
  // 输出量要可控；深度留给终裁。byCode 用 profiles，保证模型只能对池内标的取数。
  const b = NARRATIVE.tools.budgets.watch;
  const kit = buildTools({ rows: rows || profiles, byCode: known });
  const tools = { defs: kit.defs, handle: kit.handle, soft: b.soft, hard: b.hard };

  // ── 小池子：一次调用，全池同框比较 ────────────────────────────
  if (profiles.length <= NARRATIVE.watchBatchSize) {
    // 联网研究（v0.11.0）：小池子全员都进终裁，也就全员都研究。串在终裁之前——
    // 终裁要拿着研究结论下判断，所以这一段的耗时会直接加到总耗时上（上限 20 分钟）
    onProgress?.({ phase: 'research', done: 0, total: profiles.length });
    // 小池子没有初筛，研究员拿不到「最该验证什么」；用池内各只的粗筛线索代替（v0.11.3）
    const verifySmall = new Map(profiles
      .filter((p) => p.checkNext)
      .map((p) => [key(p.code), p.checkNext]));
    const web = await runResearch(profiles, { onEvent, verify: verifySmall });
    onProgress?.({ phase: 'final', done: 0, total: 1 });
    const r = await reviewOnce(profiles, { topN, minN, onEvent, tools, web });
    onProgress?.({ phase: 'final', done: 1, total: 1 });
    if (!r.ok) return { ...base, ok: false, reason: r.reason, calls: 1, research: compactResearch(web) };
    return {
      ...base, ...r, batches: 1, calls: 1, unanswered: r.rejected.filter((x) => x.unanswered).length,
      research: compactResearch(web),
    };
  }

  // ── 大池子：批内初筛（并行）→ 终裁 ───────────────────────────
  const batches = splitForReview(profiles, NARRATIVE.watchBatchSize);
  const maxPicks = Math.max(3, Math.ceil((topN * 1.5) / batches.length));
  let done = 0;
  onProgress?.({ phase: 'batch', done: 0, total: batches.length });
  // runPool 把抛出的异常吞成 null（见 util.js），这里按「整批失败」处理：
  // 该批的票会在最后的全池兜底里被标成「模型未给结论」，不会凭空消失
  const results = await runPool(batches, NARRATIVE.concurrency, async (rows, i) => {
    const r = await reviewBatch(rows, { maxPicks, minN, onEvent, label: `第${i + 1}批` });
    onProgress?.({ phase: 'batch', done: ++done, total: batches.length });
    return r;
  }).then((rs) => rs.map((r, i) => r || { ok: false, label: `第${i + 1}批`, reason: '批次异常终止' }));

  const picked = new Set();
  for (const r of results) if (r.ok) for (const c of r.picks) if (known.has(key(c))) picked.add(key(c));
  // 下限补足（v0.9.0）：各批入围合计不足榜单下限时，终裁手里根本没有 5 只可排，
  // 所以要在进终裁之前从各批落选区轮流补人，而不是让终裁去补它看不见的票。
  const promoted = promoteForFloor(
    results.filter((r) => r.ok).map((r) => normalizeRejected(r.rejected, known, picked)),
    picked, Math.min(minN, profiles.length) - picked.size,
  );
  for (const c of promoted) picked.add(key(c));
  const seen = new Set();
  let batchRejected = [];
  let suspect = [];
  const batchFailed = [];
  for (const r of results) {
    if (!r.ok) { batchFailed.push(`${r.label}：${r.reason}`); continue; }
    batchRejected = batchRejected.concat(normalizeRejected(r.rejected, known, picked, seen));
    suspect = suspect.concat(r.suspectNumbers || []);
  }
  const shortlist = profiles.filter((p) => picked.has(key(p.code)));

  // 一只都没入围：只在下限为 0（环境变量关掉）或各批全部失败时才会走到这里
  if (!shortlist.length) {
    const rejected = completeCoverage([], batchRejected, profiles);
    return {
      ...base, ok: true, model: results.find((r) => r.model)?.model || null,
      top: [], rejected,
      note: batchFailed.length ? null : '各批初筛后无一只进入终裁：池内当前没有达到买入标准的标的。',
      suspectNumbers: suspect, batches: batches.length, calls: batches.length,
      batchFailed, unanswered: rejected.filter((x) => x.unanswered).length, externalNotes: [],
    };
  }

  // 联网研究只覆盖入围终裁的这几只——批内初筛不联网（用户决策 2026-09-27），
  // 与「批内初筛不开取数工具」同一条边界
  onProgress?.({ phase: 'research', done: 0, total: shortlist.length });
  // 研究员也要拿到「这批票各自最该验证什么」（v0.11.3 批 B）：初筛的 picks 没写这件事，
  // 就退回该条落选理由里那句「为什么现在不该买」——研究员至少知道系统在犹豫什么
  const verifyMap = new Map();
  for (const r of results) {
    if (!r.ok) continue;
    for (const x of normalizeRejected(r.rejected, known)) {
      if (!verifyMap.has(key(x.code)) && x.why) verifyMap.set(key(x.code), x.why);
    }
  }
  const web = await runResearch(shortlist, { onEvent, verify: verifyMap });
  onProgress?.({ phase: 'final', done: 0, total: 1, shortlist: shortlist.length });
  const final = await reviewOnce(shortlist, {
    topN, minN, onEvent, tools, web, preScreened: { pool: profiles.length, batches: batches.length, promoted },
  });
  onProgress?.({ phase: 'final', done: 1, total: 1 });
  if (!final.ok) {
    return { ...base, ok: false, reason: final.reason, calls: batches.length + 1, batchFailed, research: compactResearch(web) };
  }

  // 终裁的落选 + 各批的落选，再对全池兜底
  const rejected = completeCoverage(final.top, [...final.rejected, ...batchRejected], profiles);
  // externalNotes 是模型「基于自身知识的质疑」的唯一合法出口（分层数字规则的 L3），
  // 大池子此前整个丢掉，实测 44 只那轮 externalNotes 为空数组（v0.11.3）。
  // 终裁自己也常常把质疑写进落选理由——同一个出口，一并带上
  const externalNotes = [...(final.externalNotes || []), ...(final.droppedNotes || [])]
    .filter((x, i, arr) => arr.findIndex((y) => `${y.code || ''}::${y.claim}` === `${x.code || ''}::${x.claim}`) === i);
  return {
    ...base, ok: true, model: final.model,
    top: final.top, rejected, note: final.note, externalNotes,
    suspectNumbers: [...(final.suspectNumbers || []), ...suspect],
    batches: batches.length, calls: batches.length + 1, shortlist: shortlist.length,
    promoted: promoted.length ? promoted : undefined,
    // 取数与三段式那条同理：必须带出去，否则分不出「终裁自己查了 19 次」与
    // 「一次都没查」（顶层 toolCalls 为 undefined 时的差异，实测被显示成 0）
    toolCalls: final.toolCalls || 0, toolLog: final.toolLog || [],
    toolsDisabled: final.toolsDisabled, budgetExhausted: final.budgetExhausted,
    batchFailed, unanswered: rejected.filter((x) => x.unanswered).length,
    research: compactResearch(web),
  };
}
