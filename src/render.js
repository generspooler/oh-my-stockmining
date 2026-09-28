// 终端渲染：单股判定报告（§2.5 参考输出格式）。
import { num, pct, money } from './util.js';

const C = { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', rd: '\x1b[31m', c: '\x1b[36m' };
const line = (n = 62) => '─'.repeat(n);
const tierColor = (i) => (i == null ? C.dim : i <= 1 ? C.g : i <= 2 ? C.c : i <= 3 ? C.r : C.rd);
const VIEW_NAME = { selfHistory: '自身历史', peers: '同业横截面', earningsQuality: '盈利质量', roePb: '资产回报匹配', cashYield: '现金回报' };
const VERDICT = { undervalued: `${C.g}低估${C.r}`, fair: `${C.dim}合理${C.r}`, overvalued: `${C.rd}高估${C.r}`, na: `${C.dim}不可得${C.r}` };

export function renderSingle(r, attribution) {
  const s = r.stock, cur = s.market === 'cn' ? 'CNY' : 'USD';
  const unit = s.market === 'cn' ? '元' : '$';
  const out = [];
  out.push(`${C.b}标的：${s.name} (${s.code})${C.r}  ${C.dim}${s.industry} · ${s.market === 'cn' ? 'A股' : '美股'}${C.r}`);
  out.push(`当前价：${unit}${num(r.price)}   市值：${money(s.marketCap, cur)}`);
  out.push(C.dim + line() + C.r);

  if (r.band.ok) {
    out.push(`估值区间   保守 ${unit}${num(r.band.conservative, 0)} │ 中性 ${unit}${num(r.band.neutral, 0)} │ 乐观 ${unit}${num(r.band.optimistic, 0)}`);
    out.push(`${C.dim}           口径：${r.route.reason}${C.r}`);
    out.push(`${C.dim}           分位 P25/P50/P75 = ${num(r.percentiles.p25, 1)}/${num(r.percentiles.p50, 1)}/${num(r.percentiles.p75, 1)} ｜ 序列 ${num(r.percentiles.years, 1)} 年 ${r.percentiles.n} 点${C.r}`);
    out.push(`价格位置   相对保守档 ${pct(r.band.vsConservative * 100)}  ｜  区间内 ${num(r.band.posInBand * 100, 0)}% 位置`);
    const tc = tierColor(r.tier.index);
    out.push(`综合判定   ${tc}● ${r.tier.name}${C.r}  (P/V ${num(r.band.pv, 3)} ｜ 置信度 ${r.confidence.level} ${r.confidence.score})`);
    if (r.tierCapped) out.push(`${C.y}           ⚠ 档位被压制：多视角未达成一致（仅 ${r.cross.agreeUndervalued}/5 指向低估）${C.r}`);
  } else {
    out.push(`${C.y}估值区间   不可得：${r.band.reason}${C.r}`);
  }
  out.push(C.dim + line() + C.r);

  out.push(`${C.b}多视角交叉校验${C.r}  ${C.dim}(印证区间结论 ${r.bandAgreement.agree}/${r.bandAgreement.valid})${C.r}`);
  for (const [k, v] of Object.entries(r.views)) {
    out.push(`  ${VIEW_NAME[k].padEnd(6, '　')} ${VERDICT[v.verdict]}  ${C.dim}${v.detail}${C.r}`);
  }
  if (r.cross.conflict) out.push(`  ${C.y}⚠ ${r.cross.conflict}${C.r}`);

  out.push('');
  const q = r.quality;
  out.push(`${C.b}质量闸门${C.r}   ${q.pass === true ? C.g + '✓ 通过' + C.r : q.pass === false ? C.rd + '✗ 未通过' + C.r : C.dim + '未评估' + C.r}` +
    (r.fScore != null ? `   ${C.dim}F-Score ${r.fScore}/9${q.highQuality ? '（高质量旁路）' : ''}${C.r}` : ''));
  (q.failures || []).forEach((f) => out.push(`  ${C.rd}-${C.r} ${f}`));
  if (r.mos.actual != null) {
    out.push(`安全边际   实际 ${num(r.mos.actual * 100, 0)}%  要求 ${num(r.mos.required * 100, 0)}%  ${r.mos.pass ? C.g + '✓' + C.r : C.rd + '✗' + C.r}`);
  }

  if (attribution?.ok) {
    out.push('');
    out.push(C.dim + line() + C.r);
    const trap = attribution.isTrap;
    out.push(`${C.b}下跌归因${C.r}   ${trap ? C.rd : C.g}${attribution.category}${C.r} ${trap ? C.rd + '（价值陷阱）' + C.r : ''}`);
    out.push(`${attribution.summary}`);
    if (attribution.evidence?.length) {
      out.push(`${C.dim}证据：${C.r}`);
      attribution.evidence.forEach((e) => out.push(`  · ${e}`));
    }
    if (attribution.killCriteria?.length) {
      out.push(`${C.y}否决条件（满足即结论作废）：${C.r}`);
      attribution.killCriteria.forEach((e) => out.push(`  · ${e}`));
    }
    if (attribution.risks?.length) {
      out.push(`${C.dim}关键风险：${C.r}`);
      attribution.risks.forEach((e, i) => out.push(`  ${'①②③④⑤⑥'[i] || '·'} ${e}`));
    }
    out.push(`${C.dim}催化剂：${(attribution.catalysts || []).join('；') || '无可见催化剂 —— 需要耐心，价值实现路径不明'}${C.r}`);
    if (attribution.categoryUnmatched) out.push(`${C.y}⚠ 归因类别「${attribution.categoryRaw}」不在标准六类内，已原样保留${C.r}`);
    // 分层数字 L3：模型自身知识。必须与实测结论显著分开——它没经过本系统验证。
    if (attribution.externalNotes?.length) {
      out.push(`\n${C.y}模型的外部知识判断（未经本系统验证，请自行核实）：${C.r}`);
      for (const x of attribution.externalNotes) {
        out.push(`  · ${x.claim}`);
        if (x.why) out.push(`    ${C.dim}依据：${x.why}${C.r}`);
      }
    }
    // 联网研究（v0.11.0）：网络来源，与实测结论分开呈现
    const web = attribution.research;
    if (web?.findings?.length) {
      const f = web.findings[0];
      out.push(`\n${C.y}联网研究（网络来源，未经本系统核实${f.confidence ? `，研究员自评可信度 ${f.confidence}` : ''}）：${C.r}`);
      if (f.summary) out.push(`  ${f.summary}`);
      for (const e of f.events) out.push(`  ${C.dim}· ${e.date || '日期不明'} ${e.source || ''}｜${e.claim || e.title || ''}  ${e.url}${C.r}`);
      for (const c of f.conflicts) out.push(`  ${C.y}⚠ 与给定数据冲突：${c.claim}${C.r}`);
    } else if (web && !web.skipped) {
      out.push(`${C.y}⚠ 联网研究未完成：${web.reason}${C.r}`);
    }
    if (attribution.toolsDisabled) out.push(`${C.y}⚠ 取数工具不可用（渠道不支持），本次仅基于机械层档案${C.r}`);
    if (attribution.suspectNumbers?.length) {
      out.push(`${C.y}⚠ 以下数字无法追溯到输入数据，请自行核实：${attribution.suspectNumbers.map((x) => x.value).join('、')}${C.r}`);
    }
    if (attribution.toolLog?.length) {
      const by = {};
      for (const x of attribution.toolLog) by[x.name] = (by[x.name] || 0) + 1;
      out.push(`${C.dim}主动取数 ${attribution.toolLog.length} 次：${Object.entries(by).map(([k, n]) => `${k}×${n}`).join('　')}${C.r}`);
    }
  } else if (attribution) {
    out.push(`\n${C.y}定性分析不可用：${attribution.reason}${C.r}`);
  }

  out.push(C.dim + line() + C.r);
  const pen = r.confidence.penalties;
  if (pen.length) { out.push(`${C.dim}置信度扣分项：${C.r}`); pen.forEach((p) => out.push(`  ${C.dim}· ${p}${C.r}`)); }
  out.push(`${C.dim}数据来源：${r.series.source}（${r.series.points} 点）｜ 字段覆盖 ${num(r.coverage.ratio * 100, 0)}%${r.coverage.missing.length ? ' ｜ 缺失: ' + r.coverage.missing.join(',') : ''}${C.r}`);
  if (attribution?.model) out.push(`${C.dim}定性结论由 ${attribution.model} 生成，仅供研究参考，不构成投资建议${C.r}`);
  return out.join('\n');
}

/** 挖掘结果的漏斗收敛表。 */
export function renderFunnel(funnel, audit) {
  const out = [`${C.b}漏斗收敛${C.r}`];
  funnel.forEach((f, i) => {
    const prev = i ? funnel[i - 1].n : null;
    const drop = prev ? ` ${C.dim}(-${prev - f.n})${C.r}` : '';
    out.push(`  ${f.stage.padEnd(14, '　')} ${String(f.n).padStart(6)}${drop}`);
  });
  return out.join('\n');
}
