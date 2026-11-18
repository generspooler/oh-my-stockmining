#!/usr/bin/env node
// CLI：analyze（单股判定）/ mine（全市场挖掘）/ start|stop|restart|status|logs（服务）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 单行刷新器（CLI 专用）。两类输出必须共存：**进度行**就地覆盖（每 2 秒刷新一次，
 * 不能每次都换行），**台账行**另起一行永久保留。直接在进度行上写日志会得到
 * 「半行进度 + 日志」粘在一起的乱码——两者必须共用一个写入器才知道对方占了几列。
 */
function lineWriter(out = process.stderr, width = 0) {
  // 终端列宽自适应：进度行比 68 列长（带计数摘要），写死宽度会把「取数 4」这类
  // 尾巴切掉——而那正是要看的信息。取不到列宽时退回 100。
  const W = Math.max(60, Math.min(width || out.columns || 100, 200)) - 1;
  let shown = 0;
  const erase = () => { if (shown) { out.write('\r' + ' '.repeat(shown) + '\r'); shown = 0; } };
  return {
    set(s) {
      erase();
      out.write(('  ' + String(s).slice(0, W - 2)).padEnd(W) + '\r');
      shown = W;
    },
    log(s) { erase(); out.write(String(s) + '\n'); },
    end: erase,
  };
}

/**
 * CLI 的活动台账打印（§5.1）。网页把台账渲染成「活动明细」面板，CLI 打成逐行日志
 * ——同一份数据的两种呈现。两个挖掘命令共用这一份：只打印**新增的**行（按 seq 判重），
 * 阶段事件可能因文案刷新而重发，但台账只增不改。
 */
const actLog = (lw) => {
  let seen = 0;
  return (snap) => {
    for (const x of snap?.recent || []) {
      if (x.seq <= seen) continue;
      seen = x.seq;
      const s = Math.floor((x.ms || 0) / 1000);
      lw.log(`  ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} ${x.text}`);
    }
  };
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(ROOT, '.run');
const PID = path.join(RUN, 'server.pid');
const LOG = path.join(RUN, 'server.log');
fs.mkdirSync(RUN, { recursive: true });

const [, , cmd = 'help', ...args] = process.argv;
const flag = (n) => args.includes(`--${n}`);
const positional = args.filter((a) => !a.startsWith('--'));

const HAS_KEY = Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);

/**
 * 凭据缺失时的引导（对齐 my-stock-track 的做法）：
 * 优先探测 shell 里已有的 MODELBEST_API_KEY，直接给出可粘贴的 export，
 * 而不是让使用者自己去翻密钥。服务与机械层不依赖凭据，只有定性分析需要。
 */
async function credentialHint(context = '定性分析') {
  const viaModelbest = Boolean(process.env.MODELBEST_API_KEY);
  const token = viaModelbest ? '"$MODELBEST_API_KEY"' : '"sk-你的key"';
  // 真实链 = 配置里的 model + fallbacks。曾经这里读 MINE_MODEL/MINE_FALLBACK_MODELS 环境变量，
  // 与 config.js 的实际默认值脱节——打印的链跟真正跑的完全不是一回事。
  const { NARRATIVE } = await import('./src/config.js');
  const chain = [NARRATIVE.model, ...NARRATIVE.fallbacks].join(' → ');
  console.log(`
  \x1b[33m未检测到 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY\x1b[0m，${context}不可用（机械层不受影响）。
  ${viaModelbest
    ? '\x1b[2m已在 shell 中发现 MODELBEST_API_KEY，下面直接复用它。\x1b[0m'
    : '\x1b[2m未发现 MODELBEST_API_KEY，请把 sk- 开头的密钥填进第一行。\x1b[0m'}

  修复步骤：把下面三行粘到终端执行；想永久生效就写进 ~/.zshrc

    \x1b[36mexport ANTHROPIC_AUTH_TOKEN=${token}\x1b[0m
    \x1b[36mexport ANTHROPIC_BASE_URL="https://llm-center.modelbest.co"\x1b[0m
    \x1b[36mnpm restart\x1b[0m

  \x1b[2m当前模型链：${chain}；改 src/config.js 的 NARRATIVE.model / fallbacks，或用 MINE_MODEL / MINE_FALLBACK_MODELS 覆盖。\x1b[0m`);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = () => { try { const p = Number(fs.readFileSync(PID, 'utf8').trim()); return alive(p) ? p : null; } catch { return null; } };

async function cmdAnalyze(query) {
  if (!query) { console.error('用法: node mine.js analyze <代码或名称>'); process.exit(1); }
  const { resolve, analyzeOne } = await import('./src/single.js');
  const { attributionPass } = await import('./src/analyze.js');
  const { renderSingle } = await import('./src/render.js');
  const { llmReady } = await import('./src/llm.js');

  process.stderr.write('解析标的…\r');
  const stock = await resolve(query);
  if (!stock) { console.error(`未找到标的：${query}`); process.exit(1); }
  process.stderr.write('计算估值与质量指标…      \r');
  const r = await analyzeOne(stock);
  let attribution = null;
  if (!flag('no-llm') && !llmReady()) await credentialHint();
  if (!flag('no-llm') && llmReady()) {
    process.stderr.write('联网研究 + 模型归因分析中（约 2~4 分钟）…   \r');
    attribution = await attributionPass(r, {
      onEvent: (e) => process.stderr.write(e.type === 'research'
        ? `  [联网] ${e.text}\n`
        : `  [${e.type}] ${(e.values || e.message || '').toString().slice(0, 60)}\n`),
    });
  }
  process.stderr.write(' '.repeat(40) + '\r');
  console.log('\n' + renderSingle(r, attribution) + '\n');
  // 落盘（--no-llm 时 attribution 为 null，同样入历史）
  try {
    const { saveStock } = await import('./src/history.js');
    saveStock({ result: r, attribution });
  } catch {}
}

async function cmdMine(market = 'cn') {
  if (!['cn', 'us'].includes(market)) { console.error('用法: node mine.js mine <cn|us>'); process.exit(1); }
  const { llmReady } = await import('./src/llm.js');
  const { SCREENING } = await import('./src/config.js');

  const lw = lineWriter();
  const say = (s) => lw.set(s);
  const clear = () => lw.end();
  const logAct = actLog(lw);

  // `--no-llm` 的批次预览是 CLI 专有的展示功能，不属于编排，因此留在这里；
  // 它需要自己跑一次收集（编排入口没有「只收集不裁决」的模式）。
  if (flag('no-llm') || !llmReady()) {
    if (!flag('no-llm')) await credentialHint('错杀挖掘的模型推理');
    const { collect } = await import('./src/collect.js');
    const { groupIntoBatches } = await import('./src/classify.js');
    const { rows, meta } = await collect(market, { onProgress: (t) => say(t) });
    clear();
    console.log(`\n阶段1 · 收集   全市场 ${meta.universe} → 池子 ${meta.pool} 只   ${(meta.elapsedMs / 1000).toFixed(0)}s`);
    console.log('\n（跳过模型层）各批标的数：');
    // 必须带上阈值，否则预览里的股息批恒为空，与实跑不一致
    groupIntoBatches(rows, market, { dividendYieldMin: SCREENING.dividendYieldMin })
      .forEach((b) => console.log(`   ${b.bucket.padEnd(10)} ${String(b.rows.length).padStart(5)} 只  名额 ${SCREENING.batchPicks[market]?.[b.bucket] ?? '—'}`));
    return;
  }

  // 编排唯一入口，与网页端共用（§6.2）
  const { runMarketMine } = await import('./src/marketRun.js');
  // 活动台账在 CLI 上就是逐行日志：一行一条，带「距起跑 mm:ss」，
  // 与网页的「活动明细」是同一份数据的两种呈现（§5.1）。
  const r = await runMarketMine(market, {
    onStage: (phase, text, done, total, snap) => {
      logAct(snap);
      say(`阶段${phase} · ${text}${done && total ? ` ${done}/${total}` : ''}`
        + (snap?.counters ? `　｜ ${snap.counters}` : ''));
    },
    onCollected: ({ meta }) => {
      clear();
      console.log(`\n阶段1 · 收集   全市场 ${meta.universe} → 池子 ${meta.pool} 只   ${(meta.elapsedMs / 1000).toFixed(0)}s`);
    },
    onCoarse: (c) => {
      // 逐批明细照旧保留（它们比台账那一行「6 批 → 入围 50 只」细）
      clear();
      console.log(`阶段2 · 粗筛   ${c.calls} 次调用 → 入围 ${c.picks} 只`);
      for (const b of c.batches) {
        if (!b.ok) { console.log(`   ${String(b.label).padEnd(10)} ✗ ${b.reason}`); continue; }
        console.log(`   ${String(b.label).padEnd(10)} 扫描 ${String(b.scanned).padStart(5)} → 入选 ${b.picked}`);
      }
    },
    onVerdictProgress: () => {},   // 收尾行已由编排层记进活动台账，这里不重复
  });
  clear();

  if (r.noCandidates) { console.log('\n本轮无候选。'); return; }
  const v = r.verdict;
  if (!v?.ok) { console.log(`阶段4 · 裁决失败：${v?.reason || '未知原因'}`); return; }

  const profiles = r.profiles;
  const byCode = new Map(profiles.map((p) => [String(p.code).toUpperCase(), p]));
  const cur = market === 'cn' ? '¥' : '$';
  console.log(`\n${'━'.repeat(60)}\nTop ${v.top.length}${boardSplit(v)}\n${'━'.repeat(60)}`);
  if (webStatusLine(v.research)) console.log(webStatusLine(v.research));
  for (const x of v.top) {
    const p = byCode.get(String(x.code).toUpperCase()) || {};
    console.log(`\n${String(x.rank).padStart(2)}. ${p.name}（${x.code}）${p.industry || ''}${x.meetsBar === false ? '  ［未达标 · 机制补位］' : ''}`);
    console.log(`    ${cur}${p.price?.toFixed(2) ?? '—'} ｜ ${mosText(p, x)} ｜ ${x.attribution ? `归因 ${x.attribution}` : `状态 ${x.stance || '—'}`}`);
    belowBarLines(x, v).forEach((l) => console.log(l));
    pitchLines(x).forEach((l) => console.log(l));
    anchorLines(p, x).forEach((l) => console.log(l));
    if (x.catalyst) console.log(`    催化剂：${x.catalyst}`);
    (x.killCriteria || []).forEach((k) => console.log(`    ⊘ ${k}`));
    if (x.valuationCaveat) console.log(`    ⚠ 估值提醒：${x.valuationCaveat}`);
    webLines(v.research, x.code).forEach((l) => console.log(l));
  }
  if (v.note) console.log(`\n整体判断：${v.note}`);
  // 分层数字 L3：与实测结论显著分开——它没经过本系统验证
  if (v.externalNotes?.length) {
    console.log(`\n${'─'.repeat(60)}\n模型的外部知识判断（未经本系统验证，请自行核实）\n${'─'.repeat(60)}`);
    for (const x of v.externalNotes) {
      const p = x.code ? byCode.get(String(x.code).toUpperCase()) : null;
      console.log(`\n   ${p ? `${p.name}（${x.code}）— ` : ''}${x.claim}`);
      if (x.why) console.log(`   依据：${x.why}`);
    }
  }
  if (v.toolsDisabled) console.log('\n⚠ 深挖阶段的取数工具不可用（渠道不支持），本轮榜单仅基于档案');
  if (v.suspectNumbers?.length) {
    console.log(`\n⚠ 以下数字无法追溯到输入数据，请自行核实：${v.suspectNumbers.map((x) => x.value).join('、')}`);
  }
  if (v.toolLog?.length) {
    const by = {};
    for (const x of v.toolLog) by[x.name] = (by[x.name] || 0) + 1;
    console.log(`\n深挖取数 ${v.toolLog.length} 次：${Object.entries(by).map(([k, n]) => `${k}×${n}`).join('　')}`
      + `${v.budgetExhausted ? '　（预算用尽）' : ''}`);
  }
  console.log(`\n模型调用 ${r.modelCalls} 次（粗筛 ${r.coarse.calls} + 裁决 ${v.calls}）`
    + `${v.toolCalls ? ` ＋ 取数 ${v.toolCalls} 次` : ''}`
    + ` ｜ 总耗时 ${(r.totalMs / 1000).toFixed(0)}s${r.file ? ` ｜ 快照 snapshots/${r.file}` : ''}`);
}

// ── 榜单 5~10 席的终端呈现（v0.9.0）。两张榜共用，与网页 renderTop 同一套口径 ──

/** 标题里把达标与补位分开数：「值得买 5 只」里若有 2 只是补位，就是在误导。 */
function boardSplit(v) {
  const below = (v.top || []).filter((x) => x.meetsBar === false).length;
  return below ? `（达标 ${v.top.length - below} · 机制补位 ${below}）` : '';
}

/**
 * 安全边际按**模型选的锚**（v0.10.0，数字由 resolveAnchor 回填）。没选锚的（旧数据）
 * 退回当时的单一口径；那种情况下模型写了估值提醒 = 它不采信这个数，必须看得出来。
 */
function mosText(p, x) {
  const v = x.valuation;
  const pc = (pv) => `${((1 - pv) * 100).toFixed(0)}%`;
  if (v?.key === 'none') return '安全边际 —（模型判定各机械口径均不可信）';
  if (v?.pv != null) return `安全边际 ${pc(v.pv)}（${v.label}）`;
  if (v?.invalid) return `安全边际 —（所选口径不可用：${v.reason || v.key}）`;
  if (p.band?.ok) return `安全边际 ${pc(p.band.pv)}${x.valuationCaveat ? '（口径存疑，见估值提醒）' : ''}`;
  return '安全边际 —（模型未选口径）';
}

/** 股性与各口径并列：选了哪个、其他口径怎么说，同时可见。 */
function anchorLines(p, x) {
  const out = [];
  if (x.stockType || x.anchorWhy) out.push(`    股性：${x.stockType || '—'}${x.anchorWhy ? `｜选锚：${x.anchorWhy}` : ''}`);
  const ok = (p.anchors || []).filter((a) => a.ok);
  if (ok.length) {
    out.push(`    各口径安全边际：${ok.map((a) => `${a.key === x.valuation?.key ? '［' : ''}${a.label} ${((1 - a.pv) * 100).toFixed(0)}%${a.key === x.valuation?.key ? '］' : ''}`).join(' · ')}`);
  }
  return out;
}

/** 联网研究（v0.11.0）：网络来源，与实测结论分开呈现。indent 对齐上下文的缩进。 */
function webLines(research, code, indent = '    ') {
  const f = (research?.findings || []).find((x) => String(x.code).toUpperCase() === String(code).toUpperCase());
  if (!f) return [];
  const out = [`${indent}联网研究（网络来源，未经本系统核实${f.confidence ? `，研究员自评可信度 ${f.confidence}` : ''}）：${f.summary || '—'}`];
  for (const e of f.events.slice(0, 4)) out.push(`${indent}  · ${e.date || '日期不明'} ${e.source || ''}｜${e.claim || e.title || ''}  ${e.url}`);
  if (f.events.length > 4) out.push(`${indent}  · 另有 ${f.events.length - 4} 条，见网页或快照`);
  for (const c of f.conflicts) out.push(`${indent}  ⚠ 与给定数据冲突：${c.claim}`);
  return out;
}

/** 整轮联网研究的状态行。未执行 / 未完成都要说出来，不静默。 */
function webStatusLine(r) {
  if (!r) return null;
  if (r.skipped) return `联网研究：未执行（${r.reason}）`;
  if (!r.ok && !r.findings?.length) return `⚠ 联网研究未完成：${r.reason}——本轮结论只有结构化数据与取数工具支撑`;
  return `联网研究：交回 ${r.findings.length}/${r.requested} 只 · 搜索 ${r.searches} 次、读网页 ${r.fetches} 篇`
    + ` · ${Math.max(1, Math.round((r.ms || 0) / 60e3))} 分钟${r.timedOut ? ' · 到时限被终止' : ''}`
    + `${r.missing?.length ? ` · 未交回：${r.missing.join('、')}` : ''}`;
}

/** 补位条目的说明行：为什么它在榜上、差在哪。 */
function belowBarLines(x, v) {
  if (x.meetsBar !== false) return [];
  return [
    `    ⚠ 未达买入标准：榜单${v.minN != null ? `至少 ${v.minN} 只` : '有席位下限'}，达标的不够，作为最接近达标的补位进榜，不是推荐`
      + (x.filledBy === 'code' ? '（模型未排入，系统按落选次序补位，无完整投资逻辑）' : ''),
    `    差在哪：${x.belowBarReason || '模型未写明'}`,
  ];
}

/** 榜单条目的两层叙述（§3.1.2）：开篇 pitch 在前（保留三段换行），thesis 折进「核实与细节」。 */
function pitchLines(x) {
  const out = [];
  if (x.pitch) for (const l of String(x.pitch).split('\n')) out.push(`    ${l}`.trimEnd());
  if (x.thesis) out.push(x.pitch ? `    核实与细节：${x.thesis}` : `    ${x.thesis}`);
  return out;
}

/**
 * 自选池挖掘（三阶段，与全市场挖掘彻底分开）。
 * 编排在 src/watchRun.js，与网页端共用一份——这里只负责把结果打到终端。
 */
async function cmdWatchMine(market = 'cn') {
  if (!['cn', 'us'].includes(market)) { console.error('用法: node mine.js watch mine <cn|us>'); process.exit(1); }
  const { runWatchMine, marketName, WATCH_PHASES } = await import('./src/watchRun.js');
  const { llmReady } = await import('./src/llm.js');
  if (!llmReady()) await credentialHint('自选池裁决');

  const lw = lineWriter();
  const say = (s) => lw.set(s);
  // 与 cmdMine 同款：台账逐行落日志，进度行刷新在同一行
  const logAct = actLog(lw);
  let r;
  try {
    r = await runWatchMine(market, {
      onStage: (phase, text, done, total, snap) => {
        logAct(snap);
        say(`阶段${phase} · ${WATCH_PHASES[phase - 1]}${text ? ' · ' + text : ''}${done && total ? ` ${done}/${total}` : ''}`
          + (snap?.counters ? `　｜ ${snap.counters}` : ''));
      },
      onCollected: ({ meta, watch }) => {
        lw.end();
        console.log(`\n阶段1 · 收集   自选池 ${watch.pool} 只 → 并入 ${watch.joined} 只   ${(meta.elapsedMs / 1000).toFixed(0)}s`);
        if (watch.missing.length) console.log(`   ⚠ 未在全市场列表中找到：${watch.missing.join('、')}`);
      },
      onEvent: () => {},   // 降级与取数已由台账逐条打印，这里再打就是重复
    });
  } catch (e) { console.error(`\n${e.message}`); process.exit(1); }

  lw.end();
  const v = r.verdict;
  if (!v.ok) { console.log(`裁决失败：${v.reason}`); return; }
  const byCode = new Map(r.profiles.map((p) => [String(p.code).toUpperCase(), p]));
  const cur = market === 'cn' ? '¥' : '$';

  const how = v.batches > 1 ? `分 ${v.batches} 批初筛 → 终裁 ${v.shortlist ?? 0} 只` : '单次裁决';
  console.log(`\n${'━'.repeat(60)}\n${marketName(market)}自选池 · 榜单 ${v.top.length}/${v.pool} 只${boardSplit(v)}  （${how}）\n${'━'.repeat(60)}`);
  if (webStatusLine(v.research)) console.log(webStatusLine(v.research));
  if (v.batchFailed?.length) console.log(`\n⚠ 有批次失败：${v.batchFailed.join('；')}`);
  if (!v.top.length) console.log('\n（池内当前没有一只达到买入标准——这是结论，不是故障）');
  for (const x of v.top) {
    const p = byCode.get(String(x.code).toUpperCase()) || {};
    console.log(`\n${String(x.rank).padStart(2)}. ${p.name}（${x.code}）${p.industry || ''}${p.outOfPool ? '  ［不在挖掘池内］' : ''}`
      + `${x.meetsBar === false ? '  ［未达标 · 机制补位］' : ''}`);
    console.log(`    ${cur}${p.price?.toFixed(2) ?? '—'} ｜ ${mosText(p, x)} ｜ ${x.attribution ? `归因 ${x.attribution}` : `状态 ${x.stance || '—'}`}`);
    belowBarLines(x, v).forEach((l) => console.log(l));
    pitchLines(x).forEach((l) => console.log(l));
    anchorLines(p, x).forEach((l) => console.log(l));
    if (x.keyData) console.log(`    关键数据：${x.keyData}`);
    if (x.catalyst) console.log(`    催化剂：${x.catalyst}`);
    (x.killCriteria || []).forEach((k) => console.log(`    ⊘ ${k}`));
    if (x.valuationCaveat) console.log(`    ⚠ 估值提醒：${x.valuationCaveat}`);
    webLines(v.research, x.code).forEach((l) => console.log(l));
  }

  if (v.rejected.length) {
    console.log(`\n${'─'.repeat(60)}\n暂不买入（${v.rejected.length}）\n${'─'.repeat(60)}`);
    for (const x of v.rejected) {
      const p = byCode.get(String(x.code).toUpperCase()) || {};
      console.log(`\n   ${p.name || x.code}（${x.code}）  ［${x.stance}］${x.suggestRemove ? '  ← 建议移出自选池（不代删）' : ''}  ${mosText(p, x)}`);
      console.log(`   ${x.why}`);
      anchorLines(p, x).forEach((l) => console.log(l.replace(/^ {4}/, '   ')));
      if (x.keyData) console.log(`   关键数据：${x.keyData}`);
      webLines(v.research, x.code, '   ').forEach((l) => console.log(l));
    }
  }
  if (r.watch.failed.length) console.log(`\n⚠ 深度补数失败：${r.watch.failed.join('、')}`);
  if (v.unanswered) console.log(`\n⚠ ${v.unanswered} 只未拿到结论（见上方「模型未给结论」），建议重跑`);
  if (v.note) console.log(`\n整体判断：${v.note}`);
  // 分层数字 L3：与实测数据显著区分呈现——它没经过本系统验证
  if (v.externalNotes?.length) {
    console.log(`\n${'─'.repeat(60)}\n模型的外部知识判断（未经本系统验证，请自行核实）\n${'─'.repeat(60)}`);
    for (const x of v.externalNotes) {
      const p = x.code ? byCode.get(String(x.code).toUpperCase()) : null;
      console.log(`\n   ${p ? `${p.name}（${x.code}）— ` : ''}${x.claim}`);
      if (x.why) console.log(`   依据：${x.why}`);
    }
  }
  if (v.toolsDisabled) console.log('\n⚠ 本轮取数工具不可用（渠道不支持），已退回纯档案裁决');
  if (v.suspectNumbers?.length) {
    console.log(`\n⚠ 以下数字无法追溯到输入数据，请自行核实：${v.suspectNumbers.map((x) => x.value).join('、')}`);
  }
  if (v.toolLog?.length) {
    const by = {};
    for (const x of v.toolLog) by[x.name] = (by[x.name] || 0) + 1;
    console.log(`\n主动取数 ${v.toolLog.length} 次：${Object.entries(by).map(([k, n]) => `${k}×${n}`).join('　')}`
      + `${v.budgetExhausted ? '　（预算用尽）' : ''}`);
  }
  console.log(`\n模型调用 ${v.calls ?? 1} 次 ｜ 总耗时 ${(r.totalMs / 1000).toFixed(0)}s${r.file ? ` ｜ 快照 snapshots/${r.file}` : ''}`);
}

/** watch mine <cn|us> / watch add <代码|名称> / watch remove <代码> / watch list */
async function cmdWatch([action = 'list', ...rest] = []) {
  if (action === 'mine') return cmdWatchMine(rest[0] || 'cn');
  const { listWatchlist, addWatch, removeWatch, watchlistFor } = await import('./src/watchlist.js');

  if (action === 'add') {
    const q = rest[0];
    if (!q) { console.error('用法: node mine.js watch add <代码或名称>'); process.exit(1); }
    const { resolve } = await import('./src/single.js');
    const stock = await resolve(q);
    if (!stock) { console.error(`未找到标的：${q}`); process.exit(1); }
    if (!stock.industry && !(stock.marketCap > 0)) {
      console.error(`${stock.name}（${stock.code}）无基本面数据（ETF/指数），不适合入池跟踪`);
      process.exit(1);
    }
    const existed = listWatchlist().some((x) => String(x.code).toUpperCase() === String(stock.code).toUpperCase());
    addWatch(stock);
    console.log(`${existed ? '已在池内，已更新名称' : '已加入自选池'}：${stock.name}（${stock.code}，${stock.market === 'cn' ? 'A股' : '美股'}）`);
    return;
  }
  if (action === 'remove' || action === 'rm') {
    const q = rest[0];
    if (!q) { console.error('用法: node mine.js watch remove <代码>'); process.exit(1); }
    const ok = removeWatch(q);
    if (!ok) { console.error(`自选池中没有 ${q}`); process.exit(1); }
    console.log(`已移出自选池：${q}`);
    return;
  }
  if (action !== 'list') { console.error('用法: node mine.js watch mine|add|remove|list'); process.exit(1); }

  const items = listWatchlist();
  const { SCREENING } = await import('./src/config.js');
  if (!items.length) {
    console.log('自选池为空。\n加入：node mine.js watch add <代码或名称>');
    return;
  }
  const cn = watchlistFor('cn'), us = watchlistFor('us');
  console.log(`自选池（${items.length}）：A股 ${cn.length} · 美股 ${us.length}  挖掘：node mine.js watch mine <cn|us>（榜单 ${SCREENING.watch.minN}~${SCREENING.watch.topN} 只详析，达标不足下限时补位并标注）`);
  for (const m of [['A股', cn], ['美股', us]]) {
    if (!m[1].length) continue;
    console.log(`  ${m[0]}：`);
    m[1].forEach((x) => console.log(`    ${String(x.code).padEnd(10)} ${String(x.name).padEnd(14)} ${(x.industry || '—').padEnd(14)} ${x.addedAt?.slice(0, 10) || ''}`));
  }
  if (items.length > SCREENING.watch.sizeHint) {
    console.log(`  ⚠ 池子超过 ${SCREENING.watch.sizeHint} 只：逐股深度补数，自选池挖掘耗时随池子线性增加`);
  }
}

function cmdStart() {
  const existing = readPid();
  if (existing) { console.log(`已在运行 (pid ${existing})`); return; }
  // 子进程继承当前 shell 的环境变量：这里没有，服务里也不会有
  if (!HAS_KEY) {
    // credentialHint 是 async（它读 config.js 拿真实模型链）；
    // 启动路径不阻塞等它——提示是给人看的，先起服务再补密钥是本项目的既定用法。
    credentialHint('网页上的定性分析');
  }
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    detached: true, stdio: ['ignore', out, out],
  });
  fs.writeFileSync(PID, String(child.pid));
  child.unref();
  console.log(`已启动 (pid ${child.pid})，日志：${path.relative(ROOT, LOG)}`);
}
function cmdStop() {
  const pid = readPid();
  if (!pid) { console.log('未在运行'); return; }
  process.kill(pid, flag('now') ? 'SIGKILL' : 'SIGTERM');
  try { fs.unlinkSync(PID); } catch {}
  console.log(`已停止 (pid ${pid})`);
}
function cmdStatus() {
  const pid = readPid();
  console.log(pid ? `运行中 (pid ${pid})` : '未运行');
}
function cmdLogs() {
  if (!fs.existsSync(LOG)) { console.log('暂无日志'); return; }
  if (flag('f')) spawn('tail', ['-f', LOG], { stdio: 'inherit' });
  else console.log(fs.readFileSync(LOG, 'utf8').split('\n').slice(-60).join('\n'));
}

const HELP = `低估价值挖掘系统

  node mine.js analyze <代码|名称>   单股低估判定（--no-llm 只跑机械层）
  node mine.js mine <cn|us>          全市场错杀低估挖掘（四阶段，十几分钟；--no-llm 只跑机械层）
  node mine.js watch mine <cn|us>    自选池挖掘（三阶段，不粗筛，1 次模型调用）
  node mine.js watch add <代码|名称>  加入自选池
  node mine.js watch remove <代码>    移出自选池
  node mine.js watch list            查看自选池
  node mine.js start|stop|status|logs  Web 服务（stop --now 立即停止，logs -f 跟随）
`;

const table = {
  analyze: () => cmdAnalyze(positional[0]),
  mine: () => cmdMine(positional[0] || 'cn'),
  watch: () => cmdWatch(positional),
  start: cmdStart, stop: cmdStop, status: cmdStatus, logs: cmdLogs,
  restart: () => { cmdStop(); setTimeout(cmdStart, 500); },
  help: () => console.log(HELP),
};
(table[cmd] || table.help)();
