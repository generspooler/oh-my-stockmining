// 阶段 3 · 深度补数（SYSTEM_DEFINITION §3 新架构）。
// 仅对粗筛入围的 ≤47 只执行。此阶段仍**不做任何淘汰**，只把信息补厚。
import * as val from './valuation.js';
import { requiredMos } from './valuation.js';
import { adjustedMonthly, drawdowns, renderCoverage } from './metrics/returns.js';
import { normalizedEarnings, fundamentalHistory, quarterlyHistory } from './metrics/normalize.js';
import { isFinancial } from './classify.js';
import * as em from './sources/em.js';
import { fetchNews, renderNews } from './news.js';
import { safeDiv, pool, median } from './util.js';
import { LIMITS } from './config.js';

/**
 * 单只深度档案：全部估值锚 + 一致预期 + 股性证据 + 归一化 + 多区间回撤 + 新闻。
 *
 * v0.10.0：**不判股性、不选锚**。此前这里按「周期股 → PB」只算一条口径的三档区间，
 * 模型看到的主估值区间是机械规则替它选好的（A股候选 64% 被判周期，其中七成换口径档位即变）。
 * 现在所有能算的锚并排给出，股性与选锚交给裁决层（verdict.js / review.js）。
 */
export async function profileOne(row, newsPack) {
  const market = row.market;
  const fin = isFinancial(row.industry, market);
  // 回撤走复权序列（§2.6），估值反算继续走不复权序列（val.multipleSeries 内部自取）。
  // 同一个序列不得同时服务两种用途——这正是旧实现把拆股读成暴跌的根因。
  const [series, statements, pricePack, forecast] = await Promise.all([
    val.multipleSeries(row).catch(() => ({ rows: [], source: '不可得' })),
    (market === 'cn' ? em.statementsCN(row.code) : em.statementsUS(row.code, em.usSuffix(row.mk))).catch(() => null),
    adjustedMonthly(row).catch(() => ({ rows: [], adjusted: false, source: '不可得', usable: false, reason: '历史价格序列不可得' })),
    // 一致预期目前只有 A股有接口（东财）；美股东财数据中心无对应表，如实标注不可得
    market === 'cn'
      ? em.forecastCN(row.code).catch((e) => ({ ok: false, reason: `一致预期取数失败：${e.message}` }))
      : Promise.resolve({ ok: false, reason: '美股一致预期：当前数据源无此接口' }),
  ]);

  const shares = row.shares ?? series.shares ?? null;
  const norm = statements ? normalizedEarnings(statements, market, { shares, isFinancial: fin }) : { ok: false, reason: '报表不可得' };

  const dd = drawdowns(pricePack.usable ? pricePack.rows : []);
  // 行情接口的日频「距 52 周最高价」（v0.11.3）：补月末采样看不见的月中高点。
  // 它是未复权价，一年内拆过股会深出几十个百分点——比月线口径还深 40 个百分点以上就不采用
  const d52 = row.drawdown52;
  const daily52 = d52 == null ? null
    : (dd.dd52w == null || d52 >= dd.dd52w - 0.4) ? { value: d52 } : { value: null, rejected: d52 };
  return {
    ...row,
    // 序列不可用（取不到 / 未复权且检测到拆股）时整体置空，不输出错的数
    drawdowns: dd,
    drawdown52Daily: daily52,
    priceSeries: {
      adjusted: !!pricePack.adjusted, source: pricePack.source,
      splitSuspect: !!pricePack.splitSuspect, usable: !!pricePack.usable,
      reason: pricePack.reason || null,
    },
    normalization: norm,
    anchors: val.anchorsFor({ row, series, norm, market }),
    forecast,
    fundamentals: statements ? fundamentalHistory(statements, market) : null,
    // 美股最近单季（v0.11.0）：年报之后的经营变化只能从这里看到
    quarters: statements ? quarterlyHistory(statements, market) : null,
    seriesSource: series.source, seriesPoints: series.rows?.length || 0,
    seriesAsOf: series.rows?.[0]?.date || null,
    // 反算口径说明（v0.11.3）：拆股已折算、PB 只有年报净资产等。它决定模型该不该信这组分位
    seriesNotes: series.notes?.length ? series.notes : null,
    news: newsPack || null,
  };
}

/**
 * 批量深度补数。
 * onProgress(text, detail)：detail 供活动台账记账（§5.1）。新闻检索先跑完再逐只补数，
 * 两者用**不同的 unit**（news / profile），否则台账里的计数会互相覆盖。
 */
export async function deepen(picks, { onProgress } = {}) {
  const rows = picks.map((p) => ({ ...p.row, coarseWhy: p.why, coarseGuess: p.guess, checkNext: p.checkNext }));
  const newsMap = await fetchNews(rows, {
    onProgress: (d, t, s) => onProgress?.(`新闻检索 ${d}/${t}　${s?.name || ''}`.trim(),
      { unit: 'news', key: `news:${s?.code ?? d}`, done: d, total: t }),
  });
  let done = 0;
  const out = await pool(rows, LIMITS.emConcurrency, async (r) => {
    const p = await profileOne(r, newsMap.get(r.code)).catch(() => null);
    done += 1;
    onProgress?.(`深度补数 ${done}/${rows.length}　${r.name || r.code}`,
      { unit: 'profile', key: `profile:${r.code}`, done, total: rows.length });
    return p;
  });
  return out.filter(Boolean);
}

const f = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d));
const pc = (v, d = 0) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);

const sgn = (v, d = 0) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);

/**
 * 估值段落（v0.10.0）：股性证据 + 全部估值锚 + 一致预期。深度档案与单股归因共用这一份，
 * 不让两处各写一遍后漂移。每个锚旁的「诊断」都是事实（被剔除的亏损天数、ROE 前后对比、
 * 归一化与当期 EPS 之比），不是判定——判定是模型的事。
 */
export function renderValuation(p) {
  const cur = p.market === 'cn' ? '¥' : '$';
  const L = [];
  const h = p.fundamentals;
  if (h?.years?.length) {
    const row = (arr) => arr.map((v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`)).join(' / ');
    L.push(`股性证据（年报，${h.years[0]}→${h.years[h.years.length - 1]}，新→旧；机械层不判股性，由你判断）：`);
    L.push(`　　营业利润率 ${row(h.margin)}`);
    L.push(`　　营收同比　 ${row(h.revYoy)}`);
    L.push(`　　ROE　　　　${row(h.roe)}`);
  }
  // 美股最近单季（v0.11.0）。年报可能已是半年多前的事，这是「年报之后发生了什么」
  // 在结构化数据里唯一的来源——此前档案不给，模型只能说「等下一份季报」
  const q = p.quarters;
  if (q?.rows?.length) {
    const unit = q.rows[0].currency ? `亿${q.rows[0].currency}` : '亿';
    L.push(`最近单季（接口，新→旧，单位 ${unit}；年报之后的经营变化看这里）：`);
    for (const r of q.rows) {
      L.push(`　　${r.period}　营收 ${f(r.revenue == null ? null : r.revenue / 1e8, 1)}（同比 ${sgn(r.revYoy)}）`
        + `　营业利润率 ${pc(r.opMargin)}　归母净利 ${f(r.netProfit == null ? null : r.netProfit / 1e8, 1)}（同比 ${sgn(r.npYoy)}）`
        + `　EPS 基本 ${f(r.eps)} / 稀释 ${f(r.epsDiluted)}`
        + (r.nonOpShare != null ? `　非经营损益占税前 ${sgn(r.nonOpShare)}` : ''));
    }
    L.push('　　（非经营损益 = 税前利润 − 营业利润：利息、投资收益、其他收支；占比高时 PE(TTM) 会被它压低）');
  }
  const anchors = p.anchors || [];
  if (anchors.length) {
    L.push(`估值锚（全部并排，机械层不选锚；P/V = 现值 ÷ 5年中位，安全边际 = 1 − P/V${p.seriesAsOf ? `；现值截至 ${p.seriesAsOf}` : ''}）：`);
    if (p.seriesNotes) L.push(`　　历史序列口径：${p.seriesNotes.join('；')}`);
    for (const a of anchors) {
      if (!a.ok) { L.push(`　　${a.label.padEnd(8)} 不可用（${a.reason}）`); continue; }
      L.push(`　　${a.label.padEnd(8)} 现值 ${f(a.current, 2)}｜5年 P25/P50/P75 ${f(a.p25, 2)}/${f(a.p50, 2)}/${f(a.p75, 2)}`
        + `（现值处 ${f(a.rank, 0)}% 分位）｜P/V ${f(a.pv, 3)} → 安全边际 ${sgn(1 - a.pv)}`
        + `｜5年分位对应价格 ${cur}${f(a.prices?.p25, 2)}/${f(a.prices?.p50, 2)}/${f(a.prices?.p75, 2)}［${a.from}］`);
      const diag = [];
      if (a.excluded) diag.push(`5年窗口 ${a.window} 个点里 ${a.excluded} 个为负或缺失（亏损期），未计入分位`);
      if (a.insufficient) diag.push(`有效点仅 ${a.n} 个、跨度 ${f(a.years, 1)} 年，不足 3 年——分位不可靠`);
      // ROE 前后对比：两条路径都从同一份年报序列算，年份与 5 年分位窗口对齐
      // （此前挖掘与单股各用各的「5年中位」，同一只票一边 3.6% 一边 2.2%）
      if (a.key === 'pb' && h?.roe?.length) {
        const r5 = h.roe.slice(0, 5);
        const med = median(r5);
        if (med != null) {
          diag.push(`分位期间年报 ROE 中位 ${pc(med, 1)}（${h.years[Math.min(4, h.years.length - 1)]}~${h.years[0]}），`
            + `最近年报 ${pc(r5[0], 1)}${p.roe != null ? `，当期 ${f(p.roe, 1)}%` : ''}`);
        }
      }
      if (a.key === 'pe_norm') {
        const ttmEps = safeDiv(p.netProfit, p.shares);
        diag.push(`假设营业利润率回归 7年中位 ${pc(a.normMargin, 1)} → 归一化EPS ${f(a.normEps)}${ttmEps ? `，最近年报EPS 约 ${f(ttmEps)}` : ''}`);
      }
      if (diag.length) L.push(`　　　　　　 诊断：${diag.join('；')}`);
    }
  }
  const fc = p.forecast;
  if (fc?.ok) {
    const ys = fc.years.map((y) => `${y.year}${y.mark === 'E' ? 'E' : 'A'} EPS ${f(y.eps)}${y.pe != null ? ` → PE ${f(y.pe, 1)}` : ''}`).join('｜');
    const rt = fc.ratings || {};
    const rating = rt.orgs ? `；评级 ${rt.orgs} 家（买入 ${rt.buy ?? 0} / 增持 ${rt.add ?? 0} / 中性 ${rt.neutral ?? 0} / 减持 ${rt.reduce ?? 0} / 卖出 ${rt.sell ?? 0}）` : '';
    const spread = fc.spread ? `；${fc.spread.year}E 近6月 ${fc.spread.n} 家预测 EPS ${f(fc.spread.min)}~${f(fc.spread.max)}` : '';
    L.push(`一致预期（接口，近六月平均，截至 ${fc.asOf}）：${ys}${spread}${rating}`);
  } else if (fc) {
    L.push(`一致预期：不可得（${fc.reason}）`);
  }
  return L;
}

/** 渲染成总裁决的输入片段。 */
export function renderProfile(p, i) {
  const cur = p.market === 'cn' ? '¥' : '$';
  const L = [];
  L.push(`### ${i + 1}. ${p.name}（${p.code}）｜${p.industry}｜${p.market === 'cn' ? 'A股' : '美股'}`);
  // 自选池挖掘里整份候选都来自用户点名，没有粗筛理由可给；市场挖掘则逐只带粗筛推理
  L.push(p.isWatch
    ? '来源：用户自选池（长期跟踪名单，未经粗筛——入池是用户的意图，不代表已通过任何检验）'
    : `粗筛理由：${p.coarseWhy || '—'}｜初步猜测：${p.coarseGuess || '—'}｜待验证：${p.checkNext || '—'}`);
  if (p.outOfPool) L.push('⚠ 该标的不在挖掘池内（池排除项），估值方法适配度有限');
  L.push(`现价 ${cur}${f(p.price)}　市值 ${p.marketCap ? (p.marketCap / 1e8).toFixed(0) + (p.market === 'cn' ? '亿' : '亿美元') : '—'}　PE ${f(p.pe, 1)}　PB ${f(p.pb)}`);

  const d = p.drawdowns || {};
  // 序列口径必须回写（§2.6 步骤 4）：模型看不到「这个序列只有 59 个点、跨了 17 年」，
  // 就无从怀疑喂给它的跌幅。「—」一律表示该区间历史不覆盖，不是「没跌」。
  L.push(renderCoverage(p.priceSeries, d));
  L.push(`回撤（月末收盘，距区间内最高月末收盘）：13周 ${pc(d.dd13w)}　26周 ${pc(d.dd26w)}　52周 ${pc(d.dd52w)}　3年 ${pc(d.dd3y)}　5年 ${pc(d.dd5y)}`
    + (p.drawdown52Daily?.value != null ? `｜距52周最高价（日频，行情接口）${pc(p.drawdown52Daily.value)}`
      : p.drawdown52Daily?.rejected != null ? `｜行情接口距52周最高价 ${pc(p.drawdown52Daily.rejected)} 与月线口径差异过大（疑似未复权），未采用` : ''));
  L.push(`区间收益：13周 ${pc(d.ret13w)}　26周 ${pc(d.ret26w)}　52周 ${pc(d.ret52w)}　3年 ${pc(d.ret3y)}　5年 ${pc(d.ret5y)}`);

  // F-Score 同时给出对应的参考安全边际（v0.11.3 批 C1）：榜单提示词里的达标门槛按它分档，
  // 模型要判「达标」就得能看到这个门槛，否则只能自由心证
  const reqMos = p.fScore != null ? requiredMos(p.fScore) : null;
  L.push(`基本面：ROE ${f(p.roe, 1)}%（5年中位 ${f(p.roeMedian5, 1)}%）　毛利率 ${f(p.grossMargin, 1)}%　负债率 ${f(p.debtRatio, 1)}%`
    + `　F-Score ${p.fScore ?? '—'}${reqMos != null ? `（F-Score ${p.fScore} 对应的参考安全边际 ${(reqMos * 100).toFixed(0)}%）` : ''}`);
  L.push(`　　　　营收CAGR ${pc(p.revenueCagr)}　累计FCF/净利 ${f(p.cumFcfToProfit)}`
    + `${p.cumFcfYears && p.fundamentals?.years?.length && p.cumFcfYears < p.fundamentals.years.length ? `（仅 ${p.cumFcfYears} 年配对得上）` : ''}`
    + `　ROIC ${f(p.roic, 1)}%　利息保障 ${f(p.interestCoverage, 1)}x`);

  L.push(...renderValuation(p));
  L.push('新闻与公告：');
  L.push(renderNews(p.news));
  return L.join('\n');
}
