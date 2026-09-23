#!/usr/bin/env node
// CLI：analyze（单股判定）/ mine（全市场挖掘）/ start|stop|restart|status|logs（服务）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    process.stderr.write('模型归因分析中（约 40s）…   \r');
    attribution = await attributionPass(r, {
      onEvent: (e) => process.stderr.write(`  [${e.type}] ${(e.values || e.message || '').toString().slice(0, 60)}\n`),
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
  const { collect } = await import('./src/collect.js');
  const { coarseScreen } = await import('./src/coarse.js');
  const { deepen } = await import('./src/deep.js');
  const { finalVerdict } = await import('./src/verdict.js');
  const { llmReady } = await import('./src/llm.js');
  const { SCREENING } = await import('./src/config.js');

  const t0 = Date.now();
  const say = (s) => process.stderr.write(('  ' + s).padEnd(56) + '\r');

  // ── 阶段 1 · 全市场信息收集（无淘汰）────────────────────────
  // v0.6：纯市场。自选池是另一条流水线（node mine.js watch mine <cn|us>），
  // 这里不再注入自选票、不再有分组配额。
  const { rows: marketRows, meta } = await collect(market, { onProgress: say });
  process.stderr.write(' '.repeat(58) + '\r');
  console.log(`\n阶段1 · 收集   全市场 ${meta.universe} → 池子 ${meta.pool} 只   ${((meta.elapsedMs) / 1000).toFixed(0)}s`);

  if (!flag('no-llm') && !llmReady()) await credentialHint('错杀挖掘的模型推理');
  if (flag('no-llm') || !llmReady()) {
    const { groupIntoBatches } = await import('./src/classify.js');
    console.log('\n（跳过模型层）各批标的数：');
    // 必须带上阈值，否则预览里的股息批恒为空，与实跑不一致
    groupIntoBatches(marketRows, market, { dividendYieldMin: SCREENING.dividendYieldMin })
      .forEach((b) => console.log(`   ${b.bucket.padEnd(10)} ${String(b.rows.length).padStart(5)} 只  名额 ${SCREENING.batchPicks[market]?.[b.bucket] ?? '—'}`));
    return;
  }

  // ── 阶段 2 · 粗筛（A股 6 批 / 美股 5 批）───────────────────
  const coarse = await coarseScreen(marketRows, market, {
    caveats: meta.caveats,
    onProgress: (d, t, b) => say(`阶段2 · 粗筛 ${d}/${t}（${b}）`),
    onEvent: (e) => { if (e.type !== 'fallback') return; process.stderr.write(`  [降级] ${e.bucket} ${e.from}→${e.to}\n`); },
  });
  process.stderr.write(' '.repeat(58) + '\r');
  console.log(`阶段2 · 粗筛   ${coarse.calls} 次调用 → 入围 ${coarse.picks.length} 只`);
  for (const r of coarse.results) {
    if (!r.ok) { console.log(`   ${r.bucket.padEnd(10)} ✗ ${r.reason}`); continue; }
    console.log(`   ${r.bucket.padEnd(10)} 扫描 ${String(r.scanned || 0).padStart(5)} → 入选 ${r.picks.length}`);
  }
  if (!coarse.picks.length) { console.log('\n本轮无候选。'); return; }

  // ── 阶段 3 · 深度补数（粗筛入围）────────────────────────────
  const profiles = await deepen(coarse.picks, { onProgress: (s) => say('阶段3 · ' + s) });
  process.stderr.write(' '.repeat(58) + '\r');
  console.log(`阶段3 · 补数   ${profiles.length} 只  估值区间 / 多区间回撤 / 新闻公告`);

  // ── 阶段 4 · 总裁决（纯市场 Top N）─────────────────────────
  say('阶段4 · 总裁决');
  const v = await finalVerdict(profiles, { onEvent: (e) => {} });
  process.stderr.write(' '.repeat(58) + '\r');
  if (!v.ok) { console.log(`阶段4 · 裁决失败：${v.reason}`); return; }

  const byCode = new Map(profiles.map((p) => [String(p.code).toUpperCase(), p]));
  const cur = market === 'cn' ? '¥' : '$';
  console.log(`\n${'━'.repeat(60)}\nTop ${v.top.length}\n${'━'.repeat(60)}`);
  for (const x of v.top) {
    const p = byCode.get(String(x.code).toUpperCase()) || {};
    const mos = p.band?.ok ? `安全边际 ${((1 - p.band.pv) * 100).toFixed(0)}%` : '估值区间不可得';
    console.log(`\n${String(x.rank).padStart(2)}. ${p.name}（${x.code}）${p.industry || ''}`);
    console.log(`    ${cur}${p.price?.toFixed(2) ?? '—'} ｜ ${mos} ｜ 归因 ${x.attribution}`);
    console.log(`    ${x.thesis}`);
    if (x.catalyst) console.log(`    催化剂：${x.catalyst}`);
    (x.killCriteria || []).forEach((k) => console.log(`    ⊘ ${k}`));
    if (x.valuationCaveat) console.log(`    ⚠ 估值提醒：${x.valuationCaveat}`);
  }
  if (v.note) console.log(`\n整体判断：${v.note}`);
  if (v.suspectNumbers?.length) {
    console.log(`\n⚠ 以下数字无法追溯到输入数据，请自行核实：${v.suspectNumbers.map((x) => x.value).join('、')}`);
  }

  // 快照落盘（与网页端共用 src/history.js）
  const { saveMine, buildMinePayload } = await import('./src/history.js');
  const file = saveMine(buildMinePayload({
    scope: 'market', market, meta, coarse, profiles, verdict: v,
    totalMs: Date.now() - t0, modelCalls: coarse.calls + 1,
  }));
  console.log(`\n模型调用 ${coarse.calls + 1} 次 ｜ 总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s ｜ 快照 snapshots/${file}`);
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

  const say = (s) => process.stderr.write(('  ' + s).padEnd(56) + '\r');
  let r;
  try {
    r = await runWatchMine(market, {
      onStage: (phase, text, done, total) =>
        say(`阶段${phase} · ${WATCH_PHASES[phase - 1]}${text ? ' · ' + text : ''}${done && total ? ` ${done}/${total}` : ''}`),
      onCollected: ({ meta, watch }) => {
        process.stderr.write(' '.repeat(58) + '\r');
        console.log(`\n阶段1 · 收集   自选池 ${watch.pool} 只 → 并入 ${watch.joined} 只   ${(meta.elapsedMs / 1000).toFixed(0)}s`);
        if (watch.missing.length) console.log(`   ⚠ 未在全市场列表中找到：${watch.missing.join('、')}`);
      },
    });
  } catch (e) { console.error(`\n${e.message}`); process.exit(1); }

  process.stderr.write(' '.repeat(58) + '\r');
  const v = r.verdict;
  if (!v.ok) { console.log(`裁决失败：${v.reason}`); return; }
  const byCode = new Map(r.profiles.map((p) => [String(p.code).toUpperCase(), p]));
  const cur = market === 'cn' ? '¥' : '$';

  const how = v.batches > 1 ? `分 ${v.batches} 批初筛 → 终裁 ${v.shortlist ?? 0} 只` : '单次裁决';
  console.log(`\n${'━'.repeat(60)}\n${marketName(market)}自选池 · 现在值得买的 ${v.top.length}/${v.pool} 只  （${how}）\n${'━'.repeat(60)}`);
  if (v.batchFailed?.length) console.log(`\n⚠ 有批次失败：${v.batchFailed.join('；')}`);
  if (!v.top.length) console.log('\n（池内当前没有一只达到买入标准——这是结论，不是故障）');
  for (const x of v.top) {
    const p = byCode.get(String(x.code).toUpperCase()) || {};
    const mos = p.band?.ok ? `安全边际 ${((1 - p.band.pv) * 100).toFixed(0)}%` : '估值区间不可得';
    console.log(`\n${String(x.rank).padStart(2)}. ${p.name}（${x.code}）${p.industry || ''}${p.outOfPool ? '  ［不在挖掘池内］' : ''}`);
    console.log(`    ${cur}${p.price?.toFixed(2) ?? '—'} ｜ ${mos} ｜ 归因 ${x.attribution}`);
    console.log(`    ${x.thesis}`);
    if (x.catalyst) console.log(`    催化剂：${x.catalyst}`);
    (x.killCriteria || []).forEach((k) => console.log(`    ⊘ ${k}`));
    if (x.valuationCaveat) console.log(`    ⚠ 估值提醒：${x.valuationCaveat}`);
  }

  if (v.rejected.length) {
    console.log(`\n${'─'.repeat(60)}\n暂不买入（${v.rejected.length}）\n${'─'.repeat(60)}`);
    for (const x of v.rejected) {
      const p = byCode.get(String(x.code).toUpperCase()) || {};
      console.log(`\n   ${p.name || x.code}（${x.code}）  ［${x.stance}］${x.suggestRemove ? '  ← 建议移出自选池（不代删）' : ''}`);
      console.log(`   ${x.why}`);
      if (x.keyData) console.log(`   关键数据：${x.keyData}`);
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
  console.log(`自选池（${items.length}）：A股 ${cn.length} · 美股 ${us.length}  挖掘：node mine.js watch mine <cn|us>（榜单取前 ${SCREENING.watch.topN} 只详析）`);
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
