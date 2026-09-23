// 阶段 4 · 总裁决（SYSTEM_DEFINITION §3 新架构）。
// 单次调用处理全部候选——排序是横截面判断，必须同时看到所有候选才排得出序。
import { complete, extractJson, validateNumbers } from './llm.js';
import { renderProfile } from './deep.js';
import { SCREENING, NARRATIVE } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.js';

const SYS = `你是深耕全球资本市场多年的资深价值投资分析师，遵循价值投资原则。

任务：从下面的候选中选出**最值得投资的 {{TOP_N}} 只**并排序（全候选横截面比较，两组混排）。

候选分两组：

- **自选组**：用户长期跟踪的名单，跳过了粗筛直接深看（行内标注「自选」）。
  对它们的裁决标准与市场候选**完全一致**——不因为是用户自选就放水，
  判为陷阱或估值已修复的照常落选。
- **市场组**：从全市场粗筛拼杀出来的候选（行内标注「市场」）。

两组各有一个席位上限（见提示词末尾），名额互不挪用——市场组好标的再多
也顶不掉自选组的席位，反之亦然。某组合格标的不足时如实少选，
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
  "rejected": [{ "code": "代码", "why": "落选原因，自选组标的尤其要说清" }],
  "note": "本轮整体判断"
}`;

/**
 * 分组配额（§3.2 自选池，用户决策 2026-09-22）。
 * 自选参与时市场组固定拿 topN − watchN：自选不足额（池子小或被判陷阱落选）
 * 总榜就如实缺额，**不用市场票补位**；自选为空时市场组回到 topN（现状行为）。
 */
export function quotas(topN, watchN, nWatch) {
  if (nWatch <= 0) return { watch: 0, market: topN };
  const w = Math.max(0, Math.min(watchN, topN));
  return { watch: w, market: topN - w };
}

/** 组别由代码按候选档案的 isWatch 判定，模型自报一律不采信（与数字同一条铁律）。 */
const groupOf = (isWatch) => (isWatch ? '自选' : '市场');

/**
 * 组内配额执行（纯函数，可测）。模型只负责排序与定性，
 * 「谁算自选、各组几席」由代码判定截断——延续「数字由代码算」的铁律。
 * 次序语义与旧实现一致：模型输出数组的顺序即其排序（rank 字段是冗余回显，
 * 可能缺失），超配的组按该次序保留前 quota 只，随后全局重新编号。
 */
export function capByGroup(top, watchMap, { topN, watchN }) {
  const nWatch = [...watchMap.values()].filter(Boolean).length;
  const q = quotas(topN, watchN, nWatch);
  const groups = { 自选: [], 市场: [] };
  (top || []).forEach((x, i) => {
    const g = groupOf(watchMap.get(String(x.code).toUpperCase()));
    groups[g].push({ i, x, g });
  });
  const kept = [...groups['自选'].slice(0, q.watch), ...groups['市场'].slice(0, q.market)];
  return kept
    .sort((a, b) => a.i - b.i)
    .map(({ x, g }, j) => ({ ...x, group: g, rank: j + 1 }));
}

/** 总裁决。单次调用，全部候选一起给（排序是横截面判断，必须同时看到所有候选）。 */
export async function finalVerdict(profiles, { topN = SCREENING.topN, onEvent } = {}) {
  if (!profiles.length) return { ok: false, reason: '无候选' };
  const block = profiles.map((p, i) => renderProfile(p, i)).join('\n\n');
  const nWatch = profiles.filter((p) => p.isWatch).length;
  const q = quotas(topN, SCREENING.watch.topN, nWatch);
  const quotaNote = nWatch > 0
    ? `\n\n席位配额：自选组最多 ${q.watch} 只，市场组最多 ${q.market} 只，名额互不挪用。自选组候选共 ${nWatch} 只，合格不足配额时如实缺额，不要用市场候选补位。`
    : `\n\n席位配额：本市场自选池为空，全部 ${q.market} 个名额归市场组。`;
  const prompt = `候选共 ${profiles.length} 只（自选 ${nWatch} + 市场 ${profiles.length - nWatch}），请选出最值得投资的 ${topN} 只并排序。\n\n${block}${quotaNote}`;
  const system = SYS.replace('{{TOP_N}}', String(topN));
  const watchMap = new Map(profiles.map((p) => [String(p.code).toUpperCase(), !!p.isWatch]));

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
        dumpRaw(r, new Error(json ? '模型输出 top 为空' : 'JSON 解析失败'));
        continue;
      }
      const known = new Map(profiles.map((p) => [String(p.code).toUpperCase(), p]));
      // 组别与配额由代码截断：模型自报的 group 只作参考，不采信
      json.top = capByGroup(
        json.top.filter((x) => known.has(String(x.code).toUpperCase())),
        watchMap, { topN, watchN: SCREENING.watch.topN },
      );
      if (!json.top.length) {
        dumpRaw(r, new Error('过滤后 top 为空（模型输出代码不在候选内）'));
        continue;
      }
      (json.rejected || []).forEach((x) => {
        const knownRow = known.get(String(x.code).toUpperCase());
        if (knownRow) x.group = groupOf(!!knownRow.isWatch);
      });
      // 数字校验只标注、不丢弃
      const text = json.top.map((x) => `${x.thesis} ${(x.killCriteria || []).join(' ')} ${(x.risks || []).join(' ')}`).join(' ');
      const v = validateNumbers(text, whitelistOf(prompt));
      if (!v.ok) onEvent?.({ type: 'suspect', values: v.violations.map((x) => x.value) });
      return { ok: true, model: r.model, ...json, suspectNumbers: v.violations, profiles: known,
        quotas: { watch: q.watch, market: q.market, watchCandidates: nWatch } };
    } catch (e) {
      onEvent?.({ type: 'error', message: e.message });
      dumpRaw(r, e);
      if (attempt === NARRATIVE.schemaRetries) return { ok: false, reason: e.message };
    }
  }
  return { ok: false, reason: 'JSON 解析连续失败' };
}

/**
 * 排障落盘：裁决不可用时把模型原始输出留一份到 .run/，
 * 否则「JSON 解析失败」无从分诊——是空串（token 预算）、半截（流中断）
 * 还是围栏外带废话（extractJson 没匹配上）。成功路径不写。
 */
function dumpRaw(r, err) {
  try {
    const dir = path.join(ROOT, '.run');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `verdict-fail-${Date.now()}.txt`),
      `error: ${err?.message}\nstop: ${r?.stopReason ?? '—'}\nmodel: ${r?.model ?? '—'}\ntext length: ${r?.text?.length ?? 0}\n---\n${r?.text || ''}`);
  } catch {}
}

/** 白名单 = 提示词里出现过的全部数字（模型只能用我们给它的数）。 */
function whitelistOf(prompt) {
  const wl = {};
  let i = 0;
  for (const m of String(prompt).matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (isFinite(v)) wl[`_p${i++}`] = v;
  }
  return wl;
}
