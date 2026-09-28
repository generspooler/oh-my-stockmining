// 阶段 4 · 市场总裁决（SYSTEM_DEFINITION §3.2 / §2.7）。
//
// v0.7.2 起改为**三段式**，而不是一次调用看完 50 只：
//
//   段 1 初排点名   全部候选档案，工具关 → 初排 + 点名要深挖哪几只、每只验证什么
//   段 2 深挖       只带点名那几只，工具开 → 逐只的验证结论
//   段 3 终排       段 1 初排 + 段 2 结论，工具关 → Top N + 完整逻辑
//
// 为什么分段（用户决策 2026-09-23）：
//   - **详细信息应该在深挖那一层做完，终排只做取舍。** 这是分工问题，不是上下文
//     窗口问题——窗口塞得下 5 万 token，但把最贵的那份 prompt 重复付费十几轮没有意义。
//   - **「谁值得深挖」由模型点名**，代码不做 P/V 档位配额（用户：「相信模型」）。
//     这也把粗筛那个一直空转的 checkNext 钩子真正接上了：粗筛写下「细筛时最该
//     验证的一件事」，段 1 复述它、段 2 真的去验。
//
// 容错取向：段 2 失败（渠道不支持工具、取数全失败等）**不中止**，
// 带着「深挖未完成」进段 3——没有深挖的榜单仍然是榜单，比没有榜单好。
import {
  complete, completeWithTools, extractJson, validateNumbers, whitelistOf, dumpRaw, tickText,
} from './llm.js';
import { renderProfile } from './deep.js';
import { buildTools, withTranscript } from './tools.js';
import { resolveAnchor, requiredMos } from './valuation.js';
import { runResearch, renderResearch, compactResearch } from './research.js';
import { SCREENING, NARRATIVE } from './config.js';

// 三段共用的判断标准。写一次，三个提示词引用，避免各写一遍后漂移。
// 股性与估值锚（v0.10.0，§2.3 步骤 3）。两张榜、所有裁决段共用这一份措辞。
// 机械层不再替模型判断「周期股 → PB」——那条规则实测把 64% 的 A股候选判成周期股。
export const ANCHOR_RULE = `关于股性与估值锚（**机械层没有替你判断股性，也没有替你选锚**）：
- 每只票的档案里并排列出了所有能算的估值锚（PE(TTM)、PE(静态)、PB、PS、PCF、归一化PE；
  A股另有接口给的一致预期 forward PE）。每个锚带「现值 / 自身 5 年分位 / P/V / 安全边际」，
  以及失真诊断——被剔除的亏损天数、分位期间与当期 ROE 的对比、归一化假设。诊断是事实，不是结论。
- 请你先判断**股性**：利润由什么驱动（商品价格周期、产品周期、稳定需求、成长扩张、困境反转……），
  会不会回到历史均值。再据此选一个**最能反映内在价值的锚**。
- 同一只票不同锚的结论可能南辕北辙（比如 PB 显著高估而 PE 显著低估）。这通常说明分位窗口里
  混进了一次性事件或结构变化——巨亏减值年份、ROE 前后判若两司、商业模式切换。
  若所有锚都被污染，anchor 填 none 并说明：系统会如实显示「机械口径均不可信」，
  不会挂一个误导性的数字。
- 你在结论里引用的安全边际必须与你选的锚一致；选 none 时不要拿任何一个锚的安全边际当结论。
- 「归一化PE」锚假设利润率回归 7 年中位数。若你判断利润率是永久性下移（结构性衰退）或
  永久性上移（商业模式已经变了），这个锚就失真，不要采信。`;

// 模型为每只进榜（自选榜还有落选）标的给出的股性与选锚。数字由代码按所选锚回填，模型只管选。
export const ANCHOR_FIELDS = `"stockType": "股性判断：利润由什么驱动、会不会均值回归，一句话",
      "anchor": "选用的估值锚：pe / pe_lar / pb / ps / pcf / pe_norm 之一，或 none（都不可信）",
      "anchorWhy": "为什么选它（或为什么都不可信），一句话",`;

const CRITERIA = `选择标准，按重要性排序：
1. **这个便宜是错杀还是陷阱** —— 最重要。结构性衰退与商业模式证伪一律不选，
   无论多便宜
2. **安全边际** —— 按你选定的估值锚，现价相对其 5 年中位估值的折价幅度
3. **生意质量** —— 长期资本回报水平、竞争地位、现金流质量
4. **价值实现路径** —— 有没有可见的催化剂。便宜且好可以便宜十年

${ANCHOR_RULE}

关于新闻：检索基于公司名全文匹配，已滤除 ETF 播报与同名机构，但仍可能有无关条目。
「未检索到」不代表没有事件发生，只说明这个渠道没抓到。

不设行业分散限制。如果某个行业确实整体被错杀，名单集中在该行业是合理结果，
不要为了分散而换掉更好的标的。`;

// 联网研究（v0.11.0，§3.4）在分层数字规则里的位置：它是**网络来源**，介于工具取数与模型记忆之间。
// 用户定的分工是「数字靠结构化接口、事件靠联网」，所以事件可以引用、数字只作参考。
// 三张提示词（两张榜 + 单股归因）共用这一段，不各写一遍。
export const WEB_RULE = `关于「联网研究」一段（若有）：那是研究员上网查到的**网络来源**，未经本系统核实。
   - 其中的**事件与原因**（为什么跌、业绩指引、监管、诉讼、做空报告……）可以引用，引用时注明来源与日期；
   - 其中的**数字只作参考**：与档案或工具取回的数据冲突时，以后者为准，并指出冲突（写进 externalNotes）；
   - 研究员没交回结论的标的，不代表没有事件发生，只说明这一轮没查到。`;

// 分层数字规则（§2.7）。三段都要带——段 1/3 没有工具，但仍然要能质疑给定数据。
const NUMBER_RULE = `【关于数字与你自己的知识】分三层，别混：
1. **给定的数据**与**工具取回的数据**——同等可信，可直接引用。
2. **你自己的记忆与判断**——可以用，而且在给定数据看起来不对时（口径可疑、
   数量级离谱、与你所知的事实冲突）**应该**用。但必须写进 externalNotes 并说明依据，
   系统会标注为「外部知识，未经本系统验证」呈现给用户。
3. **不要**把记忆里的数字直接写进 thesis 等定量字段冒充实测值。

${WEB_RULE}

**发现给定数据有问题时请明说，不要将就着用。**`;

// 榜单席位规则（v0.9.0，用户决策 2026-09-26）。两张榜共用这一份措辞，
// 代码侧的同一条规则在 fitBoard()——提示词讲给模型听，fitBoard 兜底执行。
export const boardRule = (min, max, pool = '候选') => `榜单规则（席位由系统裁定，请照此给）：
- **达到买入标准的**（meetsBar: true）按吸引力排在最前面，最多 ${max} 只；
- 达标的不足 ${min} 只时，从其余${pool}里挑**最接近买入标准**的补足到 ${min} 只，
  这些补位的 meetsBar 设为 false，并在 belowBarReason 里写明它差在哪、什么条件下会达标。
  补位是榜单机制的要求，**不是你的推荐**——判断标准不因此放松，不要把补位的写成达标的。
  补位优先挑「好生意但还不够便宜」或「便宜但有待验证」的，疑似价值陷阱放到最后才用；
- 达标的已有 ${min} 只或以上时，不要再放任何不达标的。`;

const BOARD_FIELDS = `"meetsBar": true,
      "belowBarReason": "仅 meetsBar 为 false 时填写：差在哪、为什么现在不达标、什么条件下会达标",`;
export { BOARD_FIELDS };

// ── 段 1 · 初排与点名 ────────────────────────────────────────────

const SYS_SHORTLIST = `你是深耕全球资本市场多年的资深价值投资分析师，遵循价值投资原则。

下面是从全市场逐批粗筛拼杀出来的候选。这是**两段式裁决的第一段**：
你现在不写完整投资逻辑，只做两件事——**初步排序**，以及**点名哪几只值得深挖**。

${CRITERIA}

关于点名（这是本段最重要的产出）：
档案是机械层给的摘要，它答不了「这个便宜是错杀还是陷阱」——那需要行业格局、
经营解释、管理层自述，这些不在档案里。下一段会给你取数工具去补，
**但预算有限，所以要你先决定花在哪几只上**。

点名标准：**深挖能改变结论的才值得点**。
- 边界上的票优先：你觉得它可能进 Top，但证据不够硬
- 「便宜得可疑」的优先：数据看着好，但你怀疑有没写在档案里的问题
- 已经明显该选或明显不选的，不必点——深挖不会改变结论，浪费预算
- 每只都要写明**具体要验证什么**（不是「看看基本面」这种空话）。
  候选档案里的「待验证」是粗筛留下的线索，可以直接用

最多点 {{MAX_PICKS}} 只。宁可少点。

${NUMBER_RULE}

只输出 JSON：
{
  "ranked": [{ "code": "代码", "why": "一句话初判" }],
  "picks": [{ "code": "代码", "verify": "深挖时具体要验证的那件事" }],
  "externalNotes": [{ "code": "代码，整体判断可省略", "claim": "基于自身知识的判断或质疑", "why": "依据" }],
  "note": "本轮候选整体质量的一句话判断"
}`;

// ── 段 2 · 深挖 ─────────────────────────────────────────────────

const SYS_DEEP = `你是深耕全球资本市场多年的资深价值投资分析师。

这是两段式裁决的**第二段：深挖**。上一段你已经初排过全部候选，
并点名了下面这几只需要进一步核实。现在给你取数工具。

你的任务**不是**排序或写投资逻辑——那是下一段的事。这一段只要：
**把每只点名标的要验证的那件事查清楚，并如实说明查到了什么、以及它是否改变了判断。**

最有价值的工具是 get_filing：能取到年报/半年报（美股 10-K）里管理层自己写的
行业判断、经营解释与风险披露。判断「错杀还是陷阱」时它通常比任何财务比率都管用。

取数预算有限，**自己决定怎么分配**：
- 要验证的问题越关键、越可能翻盘的，多花
- 查两次就清楚的，不必查第五次
- 查不到就说查不到——「这个渠道取不到」是有用的结论，编一个不是
预算接近用尽时系统会如实告知你，届时请开始收敛。

${NUMBER_RULE}

只输出 JSON：
{
  "findings": [
    {
      "code": "代码",
      "verified": "要验证的那件事，查到了什么。没查到就写没查到",
      "impact": "强化看多 / 削弱看多 / 推翻看多 / 无实质影响",
      "detail": "具体依据，两到四句。引用你取到的原文要点"
    }
  ],
  "externalNotes": [{ "code": "代码", "claim": "基于自身知识的判断或质疑", "why": "依据" }],
  "note": "这一轮深挖的整体收获"
}`;

// ── 段 3 · 终排 ─────────────────────────────────────────────────

const SYS_FINAL = `你是深耕全球资本市场多年的资深价值投资分析师，遵循价值投资原则。

这是两段式裁决的**最后一段：终排**。你已经初排过全部候选，也拿到了对其中
几只的深挖结论。现在给出 **{{MIN_N}}~{{TOP_N}} 只**的榜单并排序。

**深挖结论优先于初排印象。** 如果深挖推翻了某只票的看多逻辑，就把它拿下来，
哪怕它初排靠前；如果深挖强化了某只，就往上提。深挖没覆盖到的标的，按初排判断。

{{BOARD_RULE}}

${CRITERIA}

硬约束：
- 每只必须给出**否决条件**：写明「若 X 发生则本结论作废」。无法证伪的看多理由不予采纳
- **这一段不要再取数**。该查的已经在深挖那一段查完了，现在只做取舍与表达

${NUMBER_RULE}

只输出 JSON：
{
  "top": [
    {
      "code": "代码", "rank": 1,
      ${BOARD_FIELDS}
      ${ANCHOR_FIELDS}
      "attribution": "周期性底部/一次性事件冲击/流动性情绪杀/治理折价",
      "thesis": "投资逻辑，三到四句",
      "killCriteria": ["若X发生则结论作废", "..."],
      "risks": ["关键风险 2-3 条"],
      "catalyst": "价值实现路径；无则写'无可见催化剂，需要耐心'",
      "valuationCaveat": "对所选锚仍有的保留（例如分位窗口偏短、口径适配有限），没有就留空"
    }
  ],
  "rejected": [{ "code": "代码", "why": "落选原因" }],
  "externalNotes": [{ "code": "代码，整体判断可省略", "claim": "基于自身知识的判断或质疑", "why": "依据" }],
  "note": "本轮整体判断"
}`;

const key = (c) => String(c || '').toUpperCase();

/**
 * 席位截断（纯函数，可测）。模型只负责排序与定性，「几席、谁在榜」由代码裁定
 * ——延续「数字由代码算」的铁律。
 * 次序语义：模型输出数组的顺序即其排序（rank 字段是冗余回显，可能缺失），
 * 因此按数组次序保留前 topN 只并重新连续编号；已在调用方过滤掉的未知代码不参与。
 */
export function capTop(top, topN) {
  const seen = new Set();
  return (top || [])
    .filter((x) => {
      const k = key(x?.code);
      if (!k || seen.has(k)) return false;      // 同一只被模型写两遍不得占两席
      seen.add(k);
      return true;
    })
    .slice(0, topN)
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

/**
 * 模型是否把这只标为「未达标」。只有**明确的否**才算补位，其余（缺字段、写「不达标」「N」
 * 这类没列进来的写法）一律按达标处理——v0.11.3 的取舍：宁可让一只其实不达标的票留在榜上
 * 并被渲染层照常展示，也不要让代码在模型没犯错时把它踢出榜单（席位由模型排序，代码不替它排序）。
 * 旧提示词与旧快照没有这个字段，整个字段缺失时必然落在这一侧。
 */
const BELOW_BAR = /^(false|no|n|0|否|不|不是|未达标|不达标|没达标)$/i;
export const isBelowBar = (x) => {
  const v = x?.meetsBar;
  if (v === false) return true;
  if (typeof v === 'string') return BELOW_BAR.test(v.trim());
  return false;
};

/**
 * 榜单席位裁定（纯函数，可测）：min ~ max 席，两条铁律由代码保证而非寄望于模型：
 *   1. **达标的在前、补位的在后**。补位排在达标票前面没有意义；
 *   2. **补位只用来凑到 min，不能凑到 max**。达标已够 min 时，不达标的一只都不留。
 * 模型给的不足 min 时，按 fill 的次序（调用方给「离达标由近到远」）由代码补位，
 * 并标 filledBy:'code'——这类条目没有完整逻辑，渲染层必须看得出来。
 *
 * top：已过滤掉未知代码的模型输出。fill：[{ code, ...字段 }]，有序。
 * 返回 { top, dropped }：dropped 是被截掉的条目（带 droppedWhy: 'overMax' | 'notNeeded'），
 * 调用方决定它们的去处——自选榜必须把它们放进落选区，否则会凭空消失。
 */
export function fitBoard(top, { min = 0, max, fill = [] } = {}) {
  const list = capTop(top, Infinity);
  const qualified = list.filter((x) => !isBelowBar(x));
  const below = list.filter(isBelowBar);
  const keepQ = qualified.slice(0, max);
  const need = Math.max(0, Math.min(min, max) - keepQ.length);
  const keepB = below.slice(0, need);
  const dropped = [
    ...qualified.slice(max).map((x) => ({ ...x, droppedWhy: 'overMax' })),
    ...below.slice(need).map((x) => ({ ...x, droppedWhy: 'notNeeded' })),
  ];
  const board = [
    ...keepQ.map((x) => ({ ...x, meetsBar: true })),
    ...keepB.map((x) => ({ ...x, meetsBar: false })),
  ];
  const inBoard = new Set(board.map((x) => key(x.code)));
  for (const f of fill || []) {
    if (board.length >= Math.min(min, max)) break;
    const k = key(f?.code);
    if (!k || inBoard.has(k)) continue;
    inBoard.add(k);
    board.push({ ...f, meetsBar: false, filledBy: 'code' });
  }
  return { top: board.map((x, i) => ({ ...x, rank: i + 1 })), dropped };
}

/** externalNotes 规整（纯函数）。无 code 的整体性判断保留；带 code 的必须在候选内。 */
export function normalizeExternal(list, known) {
  const out = [];
  for (const x of list || []) {
    const claim = String(x?.claim || '').trim();
    if (!claim) continue;
    const k = key(x?.code);
    if (k && !known.has(k)) continue;
    out.push({ code: k ? known.get(k).code : null, claim, why: String(x?.why || '').trim() || null });
  }
  return out;
}

/**
 * 按模型选的锚回填估值（纯函数）。board 是 fitBoard 的返回或任意 { top } 形状；
 * known 是 代码 → 档案。没有 anchors 的档案（旧数据、单测桩）返回 valuation:null，不抛。
 */
export function withValuation(board, known) {
  const fill = (x) => {
    const p = known.get(key(x.code));
    const valuation = resolveAnchor(x.anchor, p?.anchors);
    // 「低于参考门槛」只标注（v0.11.3）：模型判了达标、但按 F-Score 分档的要求安全边际
    // 还差一截时，把这个差额摆到界面上，由人判断——代码不改判（用户取向：减少机械规则）。
    // 反之不标：高于门槛不代表这只票就好，门槛只是一个参照。
    let belowRequiredMos = null;
    const req = requiredMos(p?.fScore);
    if (valuation?.mos != null && req != null && valuation.mos < req - SCREENING.valuation.lowMosSlack) {
      belowRequiredMos = { actual: Number(valuation.mos.toFixed(4)), required: req, fScore: p?.fScore ?? null };
    }
    return { ...x, valuation, belowRequiredMos };
  };
  return { ...board, top: (board.top || []).map(fill) };
}

/** 点名清单规整（纯函数）：去幻觉代码、去重、截到上限。 */
export function normalizePicks(list, known, maxPicks) {
  const seen = new Set();
  const out = [];
  for (const x of list || []) {
    const k = key(x?.code);
    if (!k || !known.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ code: known.get(k).code, verify: String(x?.verify || '').trim() || null });
    if (out.length >= maxPicks) break;
  }
  return out;
}

/**
 * 模型活性回传。key 是**单元标识**（哪一段：初排/深挖/终排），text 是可随时刷新的
 * 显示文本（秒数每秒在变）——台账按 key 去重，把秒数并进 key 会数出几百个「单元」。
 * 文案映射只有 llm.tickText() 一处实现（§5.1），这里不再自己拼一遍。
 */
const tickOf = (onEvent, scope, key) => (t) => onEvent?.({
  type: 'tick', scope, key: key || scope, ...t, text: tickText(scope, t),
});

/**
 * 段 1 · 初排与点名。无工具。
 */
async function shortlistPass(profiles, { topN, minN, maxPicks, onEvent }) {
  const block = profiles.map((p, i) => renderProfile(p, i)).join('\n\n');
  const prompt = `候选共 ${profiles.length} 只。请给出初排，并点名最多 ${maxPicks} 只需要深挖的标的`
    + `（终选 ${Math.min(minN, profiles.length)}~${topN} 只：达标的最多 ${topN} 只，不足时用最接近达标的补位）。\n\n${block}`;
  const system = SYS_SHORTLIST.replace(/\{\{MAX_PICKS\}\}/g, String(maxPicks));
  const known = new Map(profiles.map((p) => [key(p.code), p]));

  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    let r = null;
    try {
      r = await complete({
        system, messages: [{ role: 'user', content: prompt }],
        maxTokens: NARRATIVE.maxTokens,
        onFallback: (f, t, why) => onEvent?.({ type: 'fallback', scope: '初排', from: f, to: t, why }),
        onTick: tickOf(onEvent, '初排'),
      }, '初排');
      const json = extractJson(r.text);
      // ranked 或 picks 有一个就算可用：点名为空是合法结论（没有值得深挖的）
      if (!json || (!json.ranked?.length && !json.picks?.length)) {
        dumpRaw('shortlist', r, new Error(json ? '模型输出 ranked 与 picks 均为空' : 'JSON 解析失败'));
        continue;
      }
      return {
        ok: true, model: r.model, prompt,
        ranked: (json.ranked || []).filter((x) => known.has(key(x?.code))),
        picks: normalizePicks(json.picks, known, maxPicks),
        externalNotes: normalizeExternal(json.externalNotes, known),
        note: json.note || null,
      };
    } catch (e) {
      onEvent?.({ type: 'error', scope: '初排', message: e.message });
      dumpRaw('shortlist', r, e);
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, reason: e.message };
    }
  }
  return { ok: false, reason: '初排 JSON 解析连续失败' };
}

/** 段 2 · 深挖。开工具。失败不中止整轮——返回 ok:false 由调用方带着「深挖未完成」继续。 */
async function deepDivePass(picked, picks, { onEvent, rows, budget }) {
  const known = new Map(picked.map((p) => [key(p.code), p]));
  const block = picked.map((p, i) => {
    const v = picks.find((x) => key(x.code) === key(p.code));
    return `${renderProfile(p, i)}\n**本只要验证的**：${v?.verify || '（上一段未写明，请自行判断最该验证什么）'}`;
  }).join('\n\n');
  const prompt = `以下 ${picked.length} 只是你上一段点名要深挖的标的。请逐只把要验证的那件事查清楚。\n\n${block}`;

  const kit = buildTools({ rows: rows || picked, byCode: known });
  const tr = withTranscript(kit.handle);
  try {
    const r = await completeWithTools({
      system: SYS_DEEP, messages: [{ role: 'user', content: prompt }],
      tools: kit.defs, onToolCall: tr.handle,
      softToolCalls: budget.soft, maxToolCalls: budget.hard,
      maxTokens: NARRATIVE.maxTokens, scope: '深挖',
      onFallback: (f, t, why) => onEvent?.({ type: 'fallback', scope: '深挖', from: f, to: t, why }),
      onTick: tickOf(onEvent, '深挖'),
      onToolEvent: (e) => onEvent?.({ ...e, scope: '深挖' }),
    });
    const json = extractJson(r.text);
    if (!json?.findings?.length) {
      dumpRaw('deepdive', r, new Error(json ? '模型输出 findings 为空' : 'JSON 解析失败'));
      return {
        ok: false, reason: json ? '深挖未产出 findings' : '深挖输出解析失败',
        transcript: tr.text(), toolLog: r.toolLog || [], toolCalls: r.toolCalls || 0,
      };
    }
    return {
      ok: true, model: r.model,
      findings: json.findings.filter((x) => known.has(key(x?.code))),
      externalNotes: normalizeExternal(json.externalNotes, known),
      note: json.note || null,
      transcript: tr.text(),
      toolLog: r.toolLog || [], toolCalls: r.toolCalls || 0,
      toolsDisabled: r.toolsDisabled || undefined, budgetExhausted: r.budgetExhausted || undefined,
    };
  } catch (e) {
    onEvent?.({ type: 'error', scope: '深挖', message: e.message });
    return { ok: false, reason: e.message, transcript: tr.text(), toolLog: e.toolLog || [], toolCalls: 0 };
  }
}

/** 段 3 · 终排。无工具（该查的已在段 2 查完）。 */
async function finalPass(profiles, { topN, minN, onEvent, shortlist, deep, web = null }) {
  const block = profiles.map((p, i) => renderProfile(p, i)).join('\n\n');
  const known = new Map(profiles.map((p) => [key(p.code), p]));
  const nameOf = (c) => known.get(key(c))?.name || c;

  const rankedBlock = shortlist.ranked.length
    ? `你上一段的初排：\n${shortlist.ranked.map((x, i) => `  ${i + 1}. ${nameOf(x.code)}（${x.code}）— ${x.why || ''}`).join('\n')}`
    : '（上一段没有给出可用的初排）';

  const deepBlock = deep?.ok && deep.findings.length
    ? `深挖结论（共 ${deep.findings.length} 只）：\n${deep.findings.map((f) => [
      `  · ${nameOf(f.code)}（${f.code}）｜${f.impact || '影响未说明'}`,
      `    验证：${f.verified || '—'}`,
      `    依据：${f.detail || '—'}`,
    ].join('\n')).join('\n')}`
    : `⚠ 深挖阶段未完成（${deep?.reason || '未执行'}），本轮没有额外核实信息。`
      + `请仅依据档案与初排作判断，并在 note 里说明结论缺少深挖支撑。`;

  const min = Math.min(minN, profiles.length);
  const prompt = `候选共 ${profiles.length} 只，请给出 ${min}~${topN} 只的榜单并排序`
    + `（达标的最多 ${topN} 只；不足 ${min} 只时用最接近达标的补位并标 meetsBar=false）。\n\n`
    + `${rankedBlock}\n\n${deepBlock}\n\n`
    + (web ? `${renderResearch(web, profiles)}\n\n` : '')
    + `以下是全部候选的完整档案：\n\n${block}`;
  const system = SYS_FINAL
    .replace(/\{\{BOARD_RULE\}\}/g, boardRule(min, topN))
    .replace(/\{\{MIN_N\}\}/g, String(min))
    .replace(/\{\{TOP_N\}\}/g, String(topN));

  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    let r = null;
    try {
      r = await complete({
        system, messages: [{ role: 'user', content: prompt }],
        maxTokens: NARRATIVE.maxTokens,
        onFallback: (f, t, why) => onEvent?.({ type: 'fallback', scope: '终排', from: f, to: t, why }),
        onTick: tickOf(onEvent, '终排'),
      }, '终排');
      const json = extractJson(r.text);
      if (!json?.top?.length) {
        dumpRaw('verdict', r, new Error(json ? '模型输出 top 为空' : 'JSON 解析失败'));
        continue;
      }
      const raw = json.top.filter((x) => known.has(key(x?.code)));
      if (!raw.length) {
        dumpRaw('verdict', r, new Error('过滤后 top 为空（模型输出代码不在候选内）'));
        continue;
      }
      const rejected = (json.rejected || []).filter((x) => known.has(key(x?.code)));
      // 模型给的不足下限时由代码补位：按模型自己的初排次序，跳过被深挖推翻看多的
      // （它们是「查过了、不行」，不是「最接近达标」）。补位理由优先用终排的落选原因。
      const overturned = new Set((deep?.findings || [])
        .filter((f) => /推翻/.test(f.impact || '')).map((f) => key(f.code)));
      const rejWhy = new Map(rejected.map((x) => [key(x.code), x.why]));
      const fill = shortlist.ranked
        .filter((x) => !overturned.has(key(x.code)))
        .map((x) => ({
          code: known.get(key(x.code)).code,
          belowBarReason: rejWhy.get(key(x.code)) || (x.why ? `初排判断：${x.why}` : null),
        }));
      // 模型只选锚，数字由代码按所选锚从档案里回填（resolveAnchor）
      const { top } = withValuation(fitBoard(raw, { min, max: topN, fill }), known);
      // 分层数字：L1 三段的提示词 + L2 段 2 的工具返回；L3（externalNotes）不参与校验
      const text = top.map((x) => `${x.thesis || ''} ${x.belowBarReason || ''} ${x.anchorWhy || ''} ${(x.killCriteria || []).join(' ')} ${(x.risks || []).join(' ')}`).join(' ');
      const wl = whitelistOf(`${shortlist.prompt}\n${prompt}\n${deep?.transcript || ''}`);
      const v = validateNumbers(text, wl);
      if (!v.ok) onEvent?.({ type: 'suspect', scope: '终排', values: v.violations.map((x) => x.value) });
      return {
        ok: true, model: r.model, top,
        rejected: rejected.filter((x) => !top.some((t) => key(t.code) === key(x.code))),
        externalNotes: normalizeExternal(json.externalNotes, known),
        note: json.note || null, suspectNumbers: v.violations,
      };
    } catch (e) {
      onEvent?.({ type: 'error', scope: '终排', message: e.message });
      dumpRaw('verdict', r, e);
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, reason: e.message };
    }
  }
  return { ok: false, reason: '终排 JSON 解析连续失败' };
}

/**
 * 市场总裁决。三段式（§3.2 阶段 4）。
 *
 * rows：本轮全市场收集结果，供 get_peers 做同业横截面（零额外请求）。
 * 返回 { ok, top, rejected, externalNotes, note, calls, toolCalls, toolLog, phases }。
 * `calls` 是**模型调用数**（不含工具轮），phases 记录三段各自的结果概要。
 */
export async function finalVerdict(profiles, {
  topN = SCREENING.topN, minN = SCREENING.minN, onEvent, onProgress, rows = null,
} = {}) {
  if (!profiles.length) return { ok: false, reason: '无候选' };
  const known = new Map(profiles.map((p) => [key(p.code), p]));
  // 点名上限：终选名额 + 余量（阈值在 config，§6.2 要求不得散落代码）。
  // 深挖要解决的是「谁进 Top N」的边界问题，给出比名额略多的余量即可；
  // 给太多等于把预算摊薄到无用，而且预算是按点名数线性放大的。
  const maxPicks = Math.min(profiles.length, topN + SCREENING.deepPickMargin);

  // ── 段 1 ────────────────────────────────────────────────────
  onProgress?.({ phase: 'shortlist', done: 0, total: 3 });
  const shortlist = await shortlistPass(profiles, { topN, minN, maxPicks, onEvent });
  if (!shortlist.ok) return { ok: false, reason: `初排失败：${shortlist.reason}`, calls: 1 };
  onProgress?.({ phase: 'shortlist', done: 1, total: 3, picks: shortlist.picks.length });

  // ── 段 2 ────────────────────────────────────────────────────
  // 点名为空是合法结论（没有深挖能改变结论的票），直接进终排。
  let deep = null;
  let web = null;
  let calls = 1;
  if (shortlist.picks.length) {
    const picked = shortlist.picks.map((x) => known.get(key(x.code))).filter(Boolean);
    const perPick = NARRATIVE.tools.budgets.marketPerPick;
    const budget = { soft: perPick * picked.length, hard: Math.ceil(perPick * picked.length * 1.4) };
    onProgress?.({ phase: 'deep', done: 1, total: 3, picks: picked.length });
    // 联网研究（v0.11.0）与段 2 **并行**：研究的就是段 1 点名的这几只，「要验证什么」原样交给研究员。
    // 两者互不依赖，并行不增加总耗时；研究失败不影响深挖，反之亦然
    const verify = new Map(shortlist.picks.map((x) => [key(x.code), x.verify]));
    [deep, web] = await Promise.all([
      deepDivePass(picked, shortlist.picks, { onEvent, rows, budget }),
      runResearch(picked, { verify, onEvent }),
    ]);
    calls++;
    onProgress?.({ phase: 'deep', done: 2, total: 3, picks: picked.length, ok: deep.ok });
  } else {
    deep = { ok: false, reason: '初排未点名任何标的（判断无需深挖即可定论）', toolLog: [], toolCalls: 0 };
    onProgress?.({ phase: 'deep', done: 2, total: 3, picks: 0, skipped: true });
  }

  // ── 段 3 ────────────────────────────────────────────────────
  onProgress?.({ phase: 'final', done: 2, total: 3 });
  const final = await finalPass(profiles, { topN, minN, onEvent, shortlist, deep, web });
  calls++;
  onProgress?.({ phase: 'final', done: 3, total: 3 });
  if (!final.ok) return { ok: false, reason: `终排失败：${final.reason}`, calls };

  // 三段的 externalNotes 合并去重（同一条判断可能在初排与终排各说一次）
  const seen = new Set();
  const externalNotes = [...shortlist.externalNotes, ...(deep.externalNotes || []), ...final.externalNotes]
    .filter((x) => {
      const k = `${x.code || ''}::${x.claim}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  return {
    ok: true, model: final.model,
    top: final.top, rejected: final.rejected, note: final.note,
    // 同一份榜单在实时与回放里必须带着同一批状态字段（v0.11.3）
    unanswered: final.rejected.filter((x) => x.unanswered).length,
    topN, minN: Math.min(minN, profiles.length),
    externalNotes, suspectNumbers: final.suspectNumbers,
    calls, toolCalls: deep.toolCalls || 0, toolLog: deep.toolLog || [],
    toolsDisabled: deep.toolsDisabled || undefined,
    budgetExhausted: deep.budgetExhausted || undefined,
    phases: {
      shortlist: { ranked: shortlist.ranked.length, picks: shortlist.picks.length, note: shortlist.note },
      deep: { ok: deep.ok, reason: deep.ok ? null : deep.reason, findings: deep.findings?.length || 0, note: deep.note || null },
    },
    // 联网研究的结论（网络来源）。卡片按代码取；未执行（初排没点名）时为 null
    research: compactResearch(web),
    profiles: known,
  };
}
