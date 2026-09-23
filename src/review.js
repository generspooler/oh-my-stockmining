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
import { complete, completeWithTools, extractJson, validateNumbers, whitelistOf, dumpRaw } from './llm.js';
import { capTop } from './verdict.js';
import { renderProfile } from './deep.js';
import { buildTools, withTranscript } from './tools.js';
import { pool as runPool } from './util.js';
import { SCREENING, NARRATIVE } from './config.js';

/** 落选状态的标准取值。模型可自由发挥，不匹配的原样保留（与归因类别同一条处理取向）。 */
export const STANCES = ['估值已修复', '等待催化', '基本面待验证', '疑似价值陷阱', '数据不足'];

const REJECT_SCHEMA = `{
      "code": "代码",
      "stance": "估值已修复/等待催化/基本面待验证/疑似价值陷阱/数据不足",
      "why": "三句话：现在什么状态、为什么现在不该买、什么条件下重新考虑",
      "keyData": "支撑上述判断的关键数据，顿号分隔，如「P/V 1.02、安全边际 -2%、ROE 当期 9% vs 5年中位 18%、52周回撤 -8%」",
      "suggestRemove": false
    }`;

const COMMON = `判断标准与全市场挖掘完全一致——不因为是用户自选就放水，也不因为他长期跟踪
就假设他已经理解了风险。

每只都附有：机械层精算的估值区间与质量指标、多区间回撤、以及最近的新闻与公告。

选择标准，按重要性排序：
1. **这个便宜是错杀还是陷阱** —— 最重要。结构性衰退与商业模式证伪一律不选，
   无论多便宜
2. **安全边际** —— 现价相对中性估值的折价幅度
3. **生意质量** —— 长期资本回报水平、竞争地位、现金流质量
4. **价值实现路径** —— 有没有可见的催化剂。便宜且好可以便宜十年

关于估值区间的重要提醒：
三档区间由「归一化盈利 × 历史倍数分位」算出。**归一化盈利本身假设了利润率回归历史中位数。**
如果你判断某家公司的利润率是永久性下移（结构性衰退），那么这个估值区间整体失真，
请在结论中明确指出，不要采信。

关于新闻：检索基于公司名全文匹配，已滤除 ETF 播报与同名机构，但仍可能有无关条目。
「未检索到」不代表没有事件发生，只说明这个渠道没抓到。

自选池特有的两条：
- 池内标的可能**不在挖掘池范围内**（ST、流动性不足、美股金融地产等），这类行已标注。
  照常分析，但要说明估值口径适配有限。
- 判为「结构性衰退」或「商业模式证伪」的，把该条 rejected 的 suggestRemove 设为 true。
  这只是**建议**——系统不会替用户删票，删不删由他决定。

【关于数字与你自己的知识】分三层，别混：
1. **上面给定的数据**与**你用工具取回的数据**——同等可信，可直接引用。
2. **你自己的记忆与判断**——可以用，而且在两种情况下**应该**用：
   一是给定数据看起来不对时（口径可疑、数量级离谱、与你所知的事实冲突），
   二是需要行业常识才能解释数据时。但这类内容必须写进 externalNotes 字段，
   并说明你为什么这么认为。系统会把它标注为「外部知识，未经本系统验证」呈现给用户。
3. **不要**把记忆里的数字直接写进 thesis / keyData 等定量字段冒充实测值。
   定量结论只能用第 1 层的数字；第 2 层负责提出质疑与提供背景，不负责替换数据。

**发现给定数据有问题时请明说，不要将就着用。**`;

const SYS = `你是深耕全球资本市场多年的资深价值投资分析师，遵循价值投资原则。

下面是**用户长期跟踪的自选池**——他自己点名要盯的标的，不是从全市场筛出来的候选。
它们没有经过任何粗筛：入池只代表用户的意图，不代表已经通过质量或估值检验。

任务：对下列每一只给出「当下该不该买」的判断。

1. 选出现在**最值得买入的至多 {{TOP_N}} 只**并排序，逐只给完整分析。
   宁缺毋滥——合格的不足 {{TOP_N}} 只就如实少给，一只都不合格就给空数组，
   绝不为了凑满而把估值已修复或基本面已证伪的标的放进来。
2. **没进榜的每一只都必须出现在 rejected 里，一只都不能漏。**
   用户要知道自己池子里每只票此刻的状态，「没提到」对他等于信息丢失。
   每条 rejected 的 why 恰好写三句连贯的话，依次讲清：现在处于什么状态、
   为什么现在不该买、什么条件出现才值得重新考虑。**不要写①②③之类的序号**，
   直接写成三句话。keyData 另列支撑该判断的关键数据。

${COMMON}

硬约束：进榜的每只必须给出**否决条件**：写明「若 X 发生则本结论作废」。
无法证伪的看多理由不予采纳。

只输出 JSON：
{
  "top": [
    {
      "code": "代码", "rank": 1,
      "attribution": "周期性底部/一次性事件冲击/流动性情绪杀/治理折价",
      "thesis": "投资逻辑，三到四句",
      "killCriteria": ["若X发生则结论作废", "..."],
      "risks": ["关键风险 2-3 条"],
      "catalyst": "价值实现路径；无则写'无可见催化剂，需要耐心'",
      "valuationCaveat": "若认为估值区间因归一化假设而失真，在此说明；否则留空"
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

最有价值的是 get_filing：它能取到年报/半年报（美股 10-K）里管理层自己写的
行业判断、经营解释与风险披露。判断「错杀还是陷阱」时它通常比任何财务比率都管用。

取数预算有限，**自己决定花在哪里**：
- 对你认为可能被错杀、值得买入的标的多取，把结论做实；
- 对明显已修复或明显是陷阱的，不必浪费；
- 拿不准的优先取——预算就是为了消除这种拿不准。
预算接近用尽时系统会如实告知你，届时请开始收敛。`;

const BATCH_SYS = `你是深耕全球资本市场多年的资深价值投资分析师，遵循价值投资原则。

下面是**用户自选池中的一批**（按行业聚拢，便于批内横向比较）。它们是用户点名跟踪的标的，
没有经过任何粗筛：入池只代表用户的意图，不代表已经通过质量或估值检验。

这是两段式裁决的第一段。你的任务不是写完整投资逻辑，而是**分流**：

1. picks：挑出这一批里**最多 {{MAX}} 只**值得进入终裁的。宁缺毋滥——
   这一批没有值得买的就给空数组，绝不为了凑数把估值已修复或基本面已证伪的放进来。
   picks 只写一句话说明为什么值得进终裁，**完整逻辑留给终裁，这里不要展开**。
2. rejected：**这一批里其余每一只都必须出现，一只都不能漏。**
   用户要知道自己池子里每只票此刻的状态，「没提到」对他等于信息丢失。
   why 恰好三句连贯的话，依次讲清：现在处于什么状态、为什么现在不该买、
   什么条件出现才值得重新考虑。**不要写①②③之类的序号**。keyData 另列关键数据。

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

/**
 * 裁决结果归一化（纯函数，可测）。三件事：
 *   1. top 截到 topN 并重新编号（席位由代码裁定，不采信模型自报的 rank）；
 *   2. rejected 去掉幻觉代码、去重、剔除已进榜的；
 *   3. 兜底补漏（`completeCoverage`）。
 */
export function normalizeReview(json, profiles, { topN = SCREENING.watch.topN } = {}) {
  const known = new Map(profiles.map((p) => [key(p.code), p]));
  const top = capTop((json?.top || []).filter((x) => known.has(key(x?.code))), topN);
  const inTop = new Set(top.map((x) => key(x.code)));
  const rejected = completeCoverage(top, normalizeRejected(json?.rejected, known, inTop), profiles);
  return { top, rejected, externalNotes: normalizeExternal(json?.externalNotes, known) };
}

/**
 * 外部知识条目规整（分层数字规则的 L3）。
 * 允许 code 为空——「整个行业的库存周期还没见底」这类判断不属于某一只票。
 * 带 code 的则必须在池内，否则是幻觉代码。
 */
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

/** 模型活性回传：思考中/正在写 + 已多少字 + 已多久。没有它，长调用与死机无从分辨。 */
const tickOf = (onEvent, scope) => (t) => onEvent?.({ type: 'tick', scope, ...t });

/**
 * 单次裁决（池子不大，或分批后的终裁）。
 * **top 为空是合法结论**（此刻一只都不值得买），不当作解析失败去重试——
 * 只要落选区把每只都讲清楚，就是一份完整结果。
 */
async function reviewOnce(profiles, { topN, onEvent, preScreened = null, tools = null } = {}) {
  const block = profiles.map((p, i) => renderProfile(p, i)).join('\n\n');
  const n = Math.min(topN, profiles.length);
  const lead = preScreened
    ? `以下 ${profiles.length} 只是从用户自选池（共 ${preScreened.pool} 只）分 ${preScreened.batches} 批初筛后入围终裁的标的。`
      + `未入围的已在初筛阶段逐只给过落选理由，这里不必再提。`
    : `用户自选池共 ${profiles.length} 只。`;
  const prompt = `${lead}请选出现在最值得买入的至多 ${n} 只并排序，`
    + `其余每一只都要在 rejected 里给出三句话的理由与关键数据（一只都不能漏）。\n\n${block}`;
  const system = SYS.replace(/\{\{TOP_N\}\}/g, String(n)) + (tools ? `\n\n${TOOL_GUIDE}` : '');

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
          maxTokens: NARRATIVE.maxTokens,
          onFallback: (f, t, why) => onEvent?.({ type: 'fallback', from: f, to: t, why }),
          onTick: tickOf(onEvent, '终裁'),
          onToolEvent: (e) => onEvent?.({ ...e, scope: '终裁' }),
        })
        : await complete({
          system, messages: [{ role: 'user', content: prompt }],
          maxTokens: NARRATIVE.maxTokens,
          onFallback: (f, t, why) => onEvent?.({ type: 'fallback', from: f, to: t, why }),
          onTick: tickOf(onEvent, '终裁'),
        });
      const json = extractJson(r.text);
      if (!json || (!json.top?.length && !json.rejected?.length)) {
        dumpRaw('review', r, new Error(json ? '模型输出 top 与 rejected 均为空' : 'JSON 解析失败'));
        continue;
      }
      const { top, rejected, externalNotes } = normalizeReview(json, profiles, { topN: n });
      if (!top.length && rejected.every((x) => x.unanswered)) {
        dumpRaw('review', r, new Error('模型输出的代码全部不在自选池内'));
        continue;
      }
      // 分层数字：L1 提示词 + L2 工具返回同为白名单；L3（externalNotes）不参与校验，
      // 它本来就是「模型自己的知识」，拿实测白名单去校验它等于不许它质疑数据。
      const text = [
        ...top.map((x) => `${x.thesis} ${(x.killCriteria || []).join(' ')} ${(x.risks || []).join(' ')}`),
        ...rejected.map((x) => `${x.why} ${x.keyData || ''}`),
      ].join(' ');
      const v = validateNumbers(text, whitelistOf(prompt + (tr ? '\n' + tr.text() : '')));
      if (!v.ok) onEvent?.({ type: 'suspect', values: v.violations.map((x) => x.value) });
      return {
        ok: true, model: r.model, top, rejected, externalNotes,
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
async function reviewBatch(profiles, { maxPicks, onEvent, label } = {}) {
  const block = profiles.map((p, i) => renderProfile(p, i)).join('\n\n');
  const prompt = `这一批共 ${profiles.length} 只（已按行业聚拢）。请挑出最多 ${maxPicks} 只值得进入终裁的，`
    + `其余每一只都要在 rejected 里给出三句话的理由与关键数据（一只都不能漏）。\n\n${block}`;
  const system = BATCH_SYS.replace(/\{\{MAX\}\}/g, String(maxPicks));

  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    let r = null;
    try {
      r = await complete({
        system, messages: [{ role: 'user', content: prompt }],
        maxTokens: NARRATIVE.maxTokens,
        onFallback: (f, t, why) => onEvent?.({ type: 'fallback', batch: label, from: f, to: t, why }),
        onTick: tickOf(onEvent, label),
      });
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
 * 自选池裁决。池子小就一次调用；超过 `NARRATIVE.watchBatchSize` 走两段式：
 * 批内初筛（并行）→ 终裁只处理入围的。
 *
 * 两段式的语义代价：「谁进 Top 8」先在批内比较、再做总排序，不再是全池严格同框
 * ——与市场挖掘的粗筛→裁决同一个路子（用户决策 2026-09-23）。
 * 换来的是每次调用的输出量恒定：单次写 43 份结论实测直接写不出来。
 */
export async function watchReview(profiles, { topN = SCREENING.watch.topN, onEvent, onProgress, rows = null } = {}) {
  if (!profiles.length) return { ok: false, reason: '自选池内没有可裁决的标的' };
  const known = new Map(profiles.map((p) => [key(p.code), p]));
  const base = { scope: 'watch', pool: profiles.length, topN, profiles: known };

  // 终裁的取数工具。批内初筛**不开工具**（用户决策）——它只做分流，
  // 输出量要可控；深度留给终裁。byCode 用 profiles，保证模型只能对池内标的取数。
  const b = NARRATIVE.tools.budgets.watch;
  const kit = buildTools({ rows: rows || profiles, byCode: known });
  const tools = { defs: kit.defs, handle: kit.handle, soft: b.soft, hard: b.hard };

  // ── 小池子：一次调用，全池同框比较 ────────────────────────────
  if (profiles.length <= NARRATIVE.watchBatchSize) {
    onProgress?.({ phase: 'final', done: 0, total: 1 });
    const r = await reviewOnce(profiles, { topN, onEvent, tools });
    onProgress?.({ phase: 'final', done: 1, total: 1 });
    if (!r.ok) return { ...base, ok: false, reason: r.reason, calls: 1 };
    return { ...base, ...r, batches: 1, calls: 1, unanswered: r.rejected.filter((x) => x.unanswered).length };
  }

  // ── 大池子：批内初筛（并行）→ 终裁 ───────────────────────────
  const batches = splitForReview(profiles, NARRATIVE.watchBatchSize);
  const maxPicks = Math.max(3, Math.ceil((topN * 1.5) / batches.length));
  let done = 0;
  onProgress?.({ phase: 'batch', done: 0, total: batches.length });
  // runPool 把抛出的异常吞成 null（见 util.js），这里按「整批失败」处理：
  // 该批的票会在最后的全池兜底里被标成「模型未给结论」，不会凭空消失
  const results = await runPool(batches, NARRATIVE.concurrency, async (rows, i) => {
    const r = await reviewBatch(rows, { maxPicks, onEvent, label: `第${i + 1}批` });
    onProgress?.({ phase: 'batch', done: ++done, total: batches.length });
    return r;
  }).then((rs) => rs.map((r, i) => r || { ok: false, label: `第${i + 1}批`, reason: '批次异常终止' }));

  const picked = new Set();
  for (const r of results) if (r.ok) for (const c of r.picks) if (known.has(key(c))) picked.add(key(c));
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

  // 一只都没入围：合法结论（池内此刻没有值得买的），无需终裁
  if (!shortlist.length) {
    const rejected = completeCoverage([], batchRejected, profiles);
    return {
      ...base, ok: true, model: results.find((r) => r.model)?.model || null,
      top: [], rejected,
      note: batchFailed.length ? null : '各批初筛后无一只进入终裁：池内当前没有达到买入标准的标的。',
      suspectNumbers: suspect, batches: batches.length, calls: batches.length,
      batchFailed, unanswered: rejected.filter((x) => x.unanswered).length,
    };
  }

  onProgress?.({ phase: 'final', done: 0, total: 1, shortlist: shortlist.length });
  const final = await reviewOnce(shortlist, {
    topN, onEvent, tools, preScreened: { pool: profiles.length, batches: batches.length },
  });
  onProgress?.({ phase: 'final', done: 1, total: 1 });
  if (!final.ok) return { ...base, ok: false, reason: final.reason, calls: batches.length + 1, batchFailed };

  // 终裁的落选 + 各批的落选，再对全池兜底
  const rejected = completeCoverage(final.top, [...final.rejected, ...batchRejected], profiles);
  return {
    ...base, ok: true, model: final.model,
    top: final.top, rejected, note: final.note,
    suspectNumbers: [...(final.suspectNumbers || []), ...suspect],
    batches: batches.length, calls: batches.length + 1, shortlist: shortlist.length,
    batchFailed, unanswered: rejected.filter((x) => x.unanswered).length,
  };
}
