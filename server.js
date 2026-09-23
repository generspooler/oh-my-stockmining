// HTTP 服务：静态站点 + API + SSE 流式进度 + 优雅退出。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, SHUTDOWN_GRACE_MS } from './src/config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const SNAP_DIR = path.join(ROOT, 'snapshots');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

let inFlight = 0;
let shuttingDown = false;

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

/** 读取请求体（JSON）。 */
const bodyOf = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => resolve(b));
});

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache', connection: 'keep-alive',
  });
  return {
    send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => res.end(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (shuttingDown && p.startsWith('/api/') && p !== '/api/health') {
    return json(res, 503, { error: '服务正在停止' });
  }

  if (p === '/api/health') return json(res, 200, { ok: true, inFlight, shuttingDown });

  if (p === '/api/search') {
    const { suggest } = await import('./src/single.js');
    try {
      const items = await suggest(url.searchParams.get('q') || '');
      return json(res, 200, { items });
    } catch { return json(res, 200, { items: [] }); }
  }

  // ── 自选池（watchlist）─────────────────────────────────
  // 纯手动进出（§3.2）：add 带 q（代码或名称），经 resolve 解析后入池；
  // remove 带 code。不设自动入池/出池。
  if (p === '/api/watchlist') {
    const wl = await import('./src/watchlist.js');
    const { SCREENING } = await import('./src/config.js');
    return json(res, 200, { items: wl.listWatchlist(), sizeHint: SCREENING.watch.sizeHint });
  }
  if (p === '/api/watchlist/add' && req.method === 'POST') {
    const { resolve } = await import('./src/single.js');
    const { addWatch } = await import('./src/watchlist.js');
    let q;
    try { q = JSON.parse(await bodyOf(req)).q; } catch {}
    if (!q) return json(res, 400, { error: '缺少参数 q' });
    try {
      const stock = await resolve(q);
      if (!stock) return json(res, 404, { error: `未找到标的：${q}` });
      if (!stock.industry && !(stock.marketCap > 0)) {
        return json(res, 400, { error: `${stock.name}（${stock.code}）无基本面数据（ETF/指数），不适合入池跟踪` });
      }
      const entry = addWatch(stock);
      return json(res, 200, { entry, items: (await import('./src/watchlist.js')).listWatchlist() });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/watchlist/remove' && req.method === 'POST') {
    const { removeWatch, listWatchlist } = await import('./src/watchlist.js');
    let code;
    try { code = JSON.parse(await bodyOf(req)).code; } catch {}
    if (!code) return json(res, 400, { error: '缺少参数 code' });
    if (!removeWatch(code)) return json(res, 404, { error: `自选池中没有 ${code}` });
    return json(res, 200, { items: listWatchlist() });
  }

  if (p === '/api/analyze') {
    const q = url.searchParams.get('q');
    if (!q) return json(res, 400, { error: '缺少参数 q' });
    const ch = sse(res);
    inFlight++;
    try {
      const { resolve, analyzeOne } = await import('./src/single.js');
      const { attributionPass } = await import('./src/analyze.js');
      const { llmReady } = await import('./src/llm.js');
      const { saveStock } = await import('./src/history.js');
      ch.send('stage', { text: '解析标的' });
      const stock = await resolve(q);
      if (!stock) { ch.send('error', { message: `未找到标的：${q}` }); return ch.end(); }
      ch.send('stage', { text: `${stock.name} · 计算估值与质量指标` });
      const r = await analyzeOne(stock);
      // seriesRows 是 2111 行逐日估值序列（179KB），前端从不使用，不推也不存
      const { seriesRows, ...slim } = r;
      ch.send('mechanical', slim);
      let a = null;
      if (llmReady()) {
        ch.send('stage', { text: '模型归因分析中' });
        a = await attributionPass(r, { onEvent: (e) => ch.send('llm', e) });
        ch.send('attribution', a);
      }
      try { saveStock({ result: r, attribution: a }); } catch {}
      ch.send('done', { ok: true });
    } catch (e) {
      ch.send('error', { message: e.message });
    } finally { inFlight--; ch.end(); }
    return;
  }

  if (p === '/api/mine') {
    const market = url.searchParams.get('market') === 'us' ? 'us' : 'cn';
    const ch = sse(res);
    inFlight++;
    try {
      const { collect } = await import('./src/collect.js');
      const { coarseScreen } = await import('./src/coarse.js');
      const { deepen } = await import('./src/deep.js');
      const { finalVerdict } = await import('./src/verdict.js');
      const { llmReady } = await import('./src/llm.js');
      const { saveMine, buildMinePayload } = await import('./src/history.js');
      const { watchlistFor } = await import('./src/watchlist.js');
      const tStart = Date.now();

      // 自选池：池内票绕过池子过滤并入阶段1（§3.2），跳过粗筛直通阶段3
      const watchItems = watchlistFor(market);

      // stage 事件带结构化 phase/done/total，前端据此驱动进度条，
      // 不必解析「阶段N · 」这种脆弱的字符串前缀。
      const stage = (phase, text, done, total) => ch.send('stage', { phase, text, done, total });
      stage(1, '全市场信息收集');
      const { rows, meta } = await collect(market, { onProgress: (t) => stage(1, t), includeCodes: watchItems.map((x) => x.code) });
      const joined = new Set((meta.watch?.codes || []).map(String));
      const watchRows = rows.filter((r) => r.isWatch);
      const watchMissing = watchItems.filter((x) => !joined.has(String(x.code))).map((x) => `${x.name}(${x.code})`);
      ch.send('collected', {
        meta,
        watch: watchItems.length ? { pool: watchItems.length, joined: watchRows.length, missing: watchMissing } : null,
      });

      if (!llmReady()) {
        ch.send('error', { message: '未检测到模型凭据：机械层已完成收集，模型推理不可用。请 export ANTHROPIC_AUTH_TOKEN 后重启服务。' });
        return ch.end();
      }

      // 粗筛只看市场候选——自选票免检直通深度补数，名额完整留给市场
      const marketRows = rows.filter((r) => !r.isWatch);
      const coarse = await coarseScreen(marketRows, market, {
        caveats: meta.caveats,
        onProgress: (d, t, b) => stage(2, `粗筛（${b}）`, d, t),
      });
      ch.send('coarse', {
        calls: coarse.calls, picks: coarse.picks.length,
        batches: coarse.results.map((r) => ({ label: r.label || r.bucket, scanned: r.scanned || 0, picked: (r.picks || []).length, note: r.note, ok: r.ok, reason: r.reason })),
      });
      if (!coarse.picks.length && !watchRows.length) { ch.send('done', { ok: true }); return ch.end(); }

      const watchPicks = watchRows.map((r) => ({ row: r, why: null, guess: null, checkNext: null }));
      const profiles = await deepen([...coarse.picks, ...watchPicks], {
        onProgress: (t) => {
          const m = String(t).match(/(\d+)\/(\d+)/);
          stage(3, t.replace(/\s*\d+\/\d+$/, ''), m ? Number(m[1]) : undefined, m ? Number(m[2]) : undefined);
        },
      });
      const okCodes = new Set(profiles.map((p) => String(p.code).toUpperCase()));
      const watchFailed = watchRows.filter((r) => !okCodes.has(String(r.code).toUpperCase())).map((r) => `${r.name}(${r.code})`);
      stage(4, '总裁决');
      const v = await finalVerdict(profiles);
      // 落盘：此前只有 CLI 写快照，网页跑的结果全部丢失
      try {
        saveMine(buildMinePayload({
          market, meta, coarse, profiles, verdict: v,
          watch: watchItems.length ? { pool: watchItems.length, joined: watchRows.length, missing: watchMissing, failed: watchFailed } : null,
          totalMs: Date.now() - tStart, modelCalls: coarse.calls + 1,
        }));
      } catch {}
      ch.send('verdict', { verdict: v, watch: watchItems.length ? { failed: watchFailed } : null, profiles: profiles.map((p) => ({
        code: p.code, name: p.name, industry: p.industry, price: p.price, market: p.market,
        pe: p.pe, pb: p.pb, fScore: p.fScore, roe: p.roe, roeMedian5: p.roeMedian5,
        drawdowns: p.drawdowns, band: p.band?.ok ? p.band : null, tier: p.band?.tier || null,
        coarseGuess: p.coarseGuess, coarseWhy: p.coarseWhy,
        isWatch: !!p.isWatch,
        newsCount: p.news?.news?.length || 0,
      })) });
      ch.send('done', { ok: true });
    } catch (e) {
      ch.send('error', { message: e.message });
    } finally { inFlight--; ch.end(); }
    return;
  }

  // ── 历史记录 Timeline ──────────────────────────────
  if (p === '/api/history') {
    const { listHistory } = await import('./src/history.js');
    try { return json(res, 200, { items: listHistory() }); }
    catch { return json(res, 200, { items: [] }); }
  }
  if (p === '/api/history/keep' && req.method === 'POST') {
    const { markKeep, listHistory } = await import('./src/history.js');
    let file;
    try { ({ file } = JSON.parse(await bodyOf(req))); } catch {}
    // 与 readHistory 同款校验：先确认这个名字本身合法，再改索引
    try { (await import('./src/history.js')).readHistory(file); }
    catch (e) { if (e.code === 'BAD_NAME') return json(res, 400, { error: '非法的记录名' }); }
    try { markKeep(file); return json(res, 200, { items: listHistory() }); }
    catch (e) { return json(res, 404, { error: e.message }); }
  }
  if (p.startsWith('/api/history/')) {
    const { readHistory } = await import('./src/history.js');
    const name = decodeURIComponent(p.slice('/api/history/'.length));
    try { return json(res, 200, readHistory(name)); }
    catch (e) {
      return json(res, e.code === 'BAD_NAME' ? 400 : 404, { error: e.code === 'BAD_NAME' ? '非法的记录名' : '记录不存在' });
    }
  }

  // ── 历史快照 ───────────────────────────────────────
  // 一次挖掘 12 分钟 + 6~7 次模型调用，结果不该刷新即丢。快照由 mine.js 落盘。
  if (p === '/api/snapshots') {
    try {
      const files = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.json'));
      const list = files.map((f) => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8'));
          return {
            file: f, market: d.market, at: d.at,
            top: d.top?.length || 0, candidates: d.candidates?.length || 0,
            totalMs: d.totalMs ?? null, modelCalls: d.modelCalls ?? null, model: d.model || null,
          };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 20);
      return json(res, 200, { list });
    } catch { return json(res, 200, { list: [] }); }
  }
  if (p.startsWith('/api/snapshot/')) {
    const name = decodeURIComponent(p.slice('/api/snapshot/'.length));
    const file = path.join(SNAP_DIR, name);
    // 路径穿越防护：解析后必须仍在 snapshots 目录内
    if (!file.startsWith(SNAP_DIR + path.sep) || !name.endsWith('.json')) {
      return json(res, 400, { error: '非法的快照名' });
    }
    try { return json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch { return json(res, 404, { error: '快照不存在' }); }
  }

  // 静态文件
  const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, async () => {
  console.log(`[${new Date().toISOString()}] 低估价值挖掘系统 http://localhost:${PORT}`);
  // 预热联想索引，避免首次搜索等待 universe 分页拉取
  try { const { warmIndex } = await import('./src/single.js'); await warmIndex(); } catch {}
  if (!(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY)) {
    const t = process.env.MODELBEST_API_KEY ? '"$MODELBEST_API_KEY"' : '"sk-你的key"';
    console.log(`[${new Date().toISOString()}] ⚠ 未检测到模型凭据：机械层正常，定性分析不可用。`);
    console.log(`    export ANTHROPIC_AUTH_TOKEN=${t} && export ANTHROPIC_BASE_URL="https://llm-center.modelbest.co" && npm restart`);
  }
});

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${new Date().toISOString()}] 收到 ${sig}，停止接受新请求；进行中 ${inFlight} 个`);
  server.close(() => process.exit(0));
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (inFlight === 0 || Date.now() - t0 > SHUTDOWN_GRACE_MS) { clearInterval(timer); process.exit(0); }
  }, 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
