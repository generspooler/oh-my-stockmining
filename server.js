// HTTP 服务：静态站点 + API + SSE 流式进度 + 优雅退出。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, SHUTDOWN_GRACE_MS } from './src/config.js';
import { compactAnchors } from './src/valuation.js';

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

/**
 * 档案瘦身后推给前端。整份 profile 带逐日估值序列与全文新闻（单只可达上百 KB），
 * 前端只用得到这几个字段；两个挖掘端点共用同一份裁剪口径。
 */
const slimProfiles = (profiles) => (profiles || []).map((p) => ({
  code: p.code, name: p.name, industry: p.industry, price: p.price, market: p.market,
  pe: p.pe, pb: p.pb, fScore: p.fScore, roe: p.roe, roeMedian5: p.roeMedian5,
  drawdowns: p.drawdowns, priceSeries: p.priceSeries || null,   // 回撤口径（§2.6）须随数据一起到前端
  band: p.band?.ok ? p.band : null, tier: p.band?.tier || null,
  // v0.10.0：全部估值锚（精简形态），卡片按模型选的锚显示、其余并列展示
  anchors: p.anchors ? compactAnchors(p.anchors) : undefined,
  coarseGuess: p.coarseGuess, coarseWhy: p.coarseWhy,
  isWatch: !!p.isWatch, outOfPool: !!p.outOfPool,
  newsCount: p.news?.news?.length || 0,
}));

/**
 * SSE 通道。
 * 必须容忍客户端中途断开：一轮挖掘十几分钟，用户关标签页是常态，
 * 而向已销毁的响应流 write 会触发 'error' 事件——没有监听者就是未捕获异常，
 * 整个服务会被一次关页面带走（连带丢掉还没落盘的结果）。
 * 断开后静默丢弃后续事件，流水线照常跑完并落盘。
 *
 * 另外**按内容指纹去重**（§5.1）：阶段 1 的每个网络请求都会报一次进度
 * （实测一轮 78 次 SEC frames），照发不误的话单轮就是数万条 SSE 消息。
 * 编排层已经兜了一道（内容没变就不发），这里再按 (事件名, 内容) 判一次——
 * 同一份文案在两个阶段各报一次是合法的，不该丢。
 */
function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache', connection: 'keep-alive',
  });
  let alive = true;
  let lastKey = '';
  const die = () => { alive = false; };
  res.on('error', die);
  res.on('close', die);
  return {
    get alive() { return alive; },
    send: (event, data) => {
      if (!alive) return false;
      const key = `${event}\u0000${JSON.stringify(data)}`;
      if (key === lastKey) return true;   // 与上一条完全相同：不重复占通道
      lastKey = key;
      try { return res.write(`event: ${event}\ndata: ${key.slice(event.length + 1)}\n\n`); }
      catch { alive = false; return false; }
    },
    end: () => { try { res.end(); } catch {} },
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
        ch.send('stage', { text: '联网研究 + 模型归因分析中' });
        // 联网研究约 1~3 分钟：它的进度要走 stage 通道，否则界面停在「模型归因分析中」一动不动
        a = await attributionPass(r, {
          onEvent: (e) => {
            if (e.type === 'research') ch.send('stage', { text: e.stage === 'end' ? `${e.text}；模型归因分析中` : e.text });
            ch.send('llm', e);
          },
        });
        ch.send('attribution', a);
      }
      try { saveStock({ result: r, attribution: a }); } catch {}
      ch.send('done', { ok: true });
    } catch (e) {
      ch.send('error', { message: e.message });
    } finally { inFlight--; ch.end(); }
    return;
  }

  // ── 市场挖掘（四阶段）──────────────────────────────────
  // v0.6：纯市场，不再注入自选票、不再有分组配额。自选票若本身在池内，
  // 作为普通市场候选参与粗筛竞争；榜上的「已自选」标记由前端按自选池比对。
  if (p === '/api/mine') {
    const market = url.searchParams.get('market') === 'us' ? 'us' : 'cn';
    const ch = sse(res);
    inFlight++;
    try {
      // 编排唯一入口，与 CLI 共用（§6.2）。落盘也在里面，网页不再各写一遍。
      const { runMarketMine } = await import('./src/marketRun.js');
      // stage 事件带结构化 phase/done/total + **活动快照**（§5.1）。
      // 快照里的 act/counters/summaries/recent 让界面能显示「具体在干什么」，
      // 而不是只有一个阶段名——阶段名在十几分钟里是不变的，等于没有进度。
      // 不必解析「阶段N · 」这种脆弱的字符串前缀。
      const r = await runMarketMine(market, {
        onStage: (phase, text, done, total, snap) => ch.send('stage', { phase, text, done, total, snap }),
        onCollected: ({ meta }) => ch.send('collected', { meta, watch: null }),
        onCoarse: (c) => ch.send('coarse', c),
        // 此前这里压根没传 onEvent，降级与存疑事件全部静默丢弃；
        // 现在连同深挖的取数事件一起送到前端。
        onEvent: (e) => ch.send('llm', e),
      });
      if (r.noCandidates) { ch.send('done', { ok: true }); return ch.end(); }
      ch.send('verdict', { scope: 'market', verdict: r.verdict, profiles: slimProfiles(r.profiles) });
      ch.send('done', { ok: true });
    } catch (e) {
      ch.send('error', { message: e.message });
    } finally { inFlight--; ch.end(); }
    return;
  }

  // ── 自选池挖掘（三阶段：收集 → 补数 → 裁决）─────────────
  // 与市场挖掘完全独立：不粗筛、不混排、不共用名额，只有 1 次模型调用。
  if (p === '/api/mine/watch') {
    const market = url.searchParams.get('market') === 'us' ? 'us' : 'cn';
    const ch = sse(res);
    inFlight++;
    try {
      const { runWatchMine } = await import('./src/watchRun.js');
      const r = await runWatchMine(market, {
        onStage: (phase, text, done, total, snap) => ch.send('stage', { phase, text, done, total, snap }),
        onCollected: (d) => ch.send('collected', d),
        // 自选那条此前也漏了 onEvent：降级与取数只反映在进度文案上，不留痕
        onEvent: (e) => ch.send('llm', e),
      });
      ch.send('verdict', {
        scope: 'watch', market, verdict: r.verdict,
        watch: r.watch, profiles: slimProfiles(r.profiles),
      });
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
