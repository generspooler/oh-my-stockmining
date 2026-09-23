// 阶段 4 · 市场挖掘总裁决（SYSTEM_DEFINITION §3.2）。
// 单次调用处理全部候选——排序是横截面判断，必须同时看到所有候选才排得出序。
//
// v0.6：自选池已独立成自己的流水线与榜单（src/review.js），这里回归**纯市场**：
// 不再有自选组/市场组之分，10 个席位全归粗筛拼杀出来的候选。
import { complete, extractJson, validateNumbers, whitelistOf, dumpRaw } from './llm.js';
import { renderProfile } from './deep.js';
import { SCREENING, NARRATIVE } from './config.js';

const SYS = `你是深耕全球资本市场多年的资深价值投资分析师，遵循价值投资原则。

任务：从下面的候选中选出**最值得投资的 {{TOP_N}} 只**并排序（全候选横截面比较）。

候选是从全市场逐批粗筛拼杀出来的。合格标的不足 {{TOP_N}} 只时如实少选，
宁缺毋滥，不为凑数硬选。

每只候选都附有：机械层精算的估值区间与质量指标、多区间回撤、以及最近的新闻与公告。

选择标准，按重要性排序：
1. **这个便宜是错杀还是陷阱** —— 最重要。结构性衰退与商业模式证伪一律不选，
   无论多便宜
2. **安全边际** —— 现价相对中性估值的折价幅度
3. **生意质量** —— 长期资本回报水平、竞争地位、现金流质量
4. **价值实现路径** —— 有没有可见的催化剂。便宜且好可以便宜十年

关于估值区间的重要提醒：
三档区间由「归一化盈利 × 历史倍数分位」算出。**归一化盈利本身假设了利润率回归历史中位数。**
如果你判断某家公司的利润率是永久性下移（结构性衰退），那么这个估值区间整体失真，
请在 valuationCaveat 中明确指出，不要采信。

关于新闻：检索基于公司名全文匹配，已滤除 ETF 播报与同名机构，但仍可能有无关条目。
「未检索到」不代表没有事件发生，只说明这个渠道没抓到。

硬约束：
- 每只必须给出**否决条件**：写明「若 X 发生则本结论作废」。无法证伪的看多理由不予采纳

不设行业分散限制。如果某个行业确实整体被错杀，名单集中在该行业是合理结果，
不要为了分散而换掉更好的标的。

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
  "rejected": [{ "code": "代码", "why": "落选原因" }],
  "note": "本轮整体判断"
}`;

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
      const k = String(x?.code || '').toUpperCase();
      if (!k || seen.has(k)) return false;      // 同一只被模型写两遍不得占两席
      seen.add(k);
      return true;
    })
    .slice(0, topN)
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

/** 市场总裁决。单次调用，全部候选一起给（排序是横截面判断，必须同时看到所有候选）。 */
export async function finalVerdict(profiles, { topN = SCREENING.topN, onEvent } = {}) {
  if (!profiles.length) return { ok: false, reason: '无候选' };
  const block = profiles.map((p, i) => renderProfile(p, i)).join('\n\n');
  const prompt = `候选共 ${profiles.length} 只，请选出最值得投资的 ${topN} 只并排序。\n\n${block}`;
  const system = SYS.replace(/\{\{TOP_N\}\}/g, String(topN));

  for (let attempt = 0; attempt <= NARRATIVE.schemaRetries; attempt++) {
    let r = null;
    try {
      r = await complete({
        system, messages: [{ role: 'user', content: prompt }],
        maxTokens: NARRATIVE.maxTokens,
        onFallback: (f, t, why) => onEvent?.({ type: 'fallback', from: f, to: t, why }),
      });
      const json = extractJson(r.text);
      if (!json?.top?.length) {
        dumpRaw('verdict', r, new Error(json ? '模型输出 top 为空' : 'JSON 解析失败'));
        continue;
      }
      const known = new Map(profiles.map((p) => [String(p.code).toUpperCase(), p]));
      json.top = capTop(json.top.filter((x) => known.has(String(x.code).toUpperCase())), topN);
      if (!json.top.length) {
        dumpRaw('verdict', r, new Error('过滤后 top 为空（模型输出代码不在候选内）'));
        continue;
      }
      // 数字校验只标注、不丢弃
      const text = json.top.map((x) => `${x.thesis} ${(x.killCriteria || []).join(' ')} ${(x.risks || []).join(' ')}`).join(' ');
      const v = validateNumbers(text, whitelistOf(prompt));
      if (!v.ok) onEvent?.({ type: 'suspect', values: v.violations.map((x) => x.value) });
      return { ok: true, model: r.model, ...json, suspectNumbers: v.violations, profiles: known };
    } catch (e) {
      onEvent?.({ type: 'error', message: e.message });
      dumpRaw('verdict', r, e);
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, reason: e.message };
    }
  }
  return { ok: false, reason: 'JSON 解析连续失败' };
}
