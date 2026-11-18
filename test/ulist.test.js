// v0.11.5 回归：ulist 点名行情（自选池路径不再依赖 clist）+ cached() 的 stale 回退。
// ulist 部分打真实网络（与 suggest.test.js 同一取向——数据源契约本身就是要回归的东西）；
// stale 部分用临时缓存目录纯本地验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { quotesBySecids, toNum } from '../src/sources/em.js';
import { cached, ROOT } from '../src/util.js';

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

test('quotesBySecids：A股点名返回 universe 同构对象（缩放原值）', async () => {
  const rows = await quotesBySecids(['600519', '000001'], 'cn');
  assert.equal(rows.length, 2, '两只都找到');
  const mt = rows.find((r) => r.code === '600519');
  assert.equal(mt.name, '贵州茅台');
  assert.ok(mt.marketCap > 1e10, '市值量级正常');
  assert.ok(mt.pe > 0 && mt.pe < 100, `PE 为原值而非 ×100（实测 ${mt.pe}）`);
  assert.ok(mt.pb > 0 && mt.pb < 20, `PB 为原值（实测 ${mt.pb}）`);
  assert.ok(mt.industry, '行业有值');
  assert.ok(/^\d{8}$/.test(mt.listDate), '上市日期为 YYYYMMDD');
  assert.ok(mt.dividendYield != null && mt.dividendYield > 0, '股息率有值');
  assert.equal(mt.secid, '1.600519');
  assert.equal(mt.market, 'cn');
});

test('quotesBySecids：美股 105/106/107 试错法定位真身', async () => {
  const rows = await quotesBySecids(['AAPL', 'BABA'], 'us');
  assert.equal(rows.length, 2, '两只都找到');
  const aapl = rows.find((r) => r.code === 'AAPL');
  assert.equal(aapl.mk, 105, 'AAPL 是 NASDAQ');
  assert.equal(aapl.secid, '105.AAPL');
  const baba = rows.find((r) => r.code === 'BABA');
  assert.equal(baba.mk, 106, 'BABA 是 NYSE');
  assert.equal(baba.secid, '106.BABA');
  assert.ok(aapl.pe > 0 && aapl.pe < 100, '美股 PE 缩放正常');
});

test('quotesBySecids：不存在的代码被静默略过，不报错', async () => {
  const rows = await quotesBySecids(['600519', 'ZZZZZZ'], 'cn');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '600519');
});

test('quotesBySecids：缓存命中后行为一致（键含市场与代码集）', async () => {
  const a = await quotesBySecids(['600519'], 'cn');
  const b = await quotesBySecids(['600519'], 'cn');
  assert.deepEqual(a, b);
});

test('cached：producer 失败时回退过期缓存并标注 _staleAt', async () => {
  const key = 'stale-test-v0.11.5';
  const file = path.join(ROOT, '.cache', `${sha(key)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 直接写一份“过期”缓存
  fs.writeFileSync(file, JSON.stringify({ t: Date.now() - 24 * 3600e3, k: key, v: [{ a: 1 }] }));
  try {
    // cached 读不到新鲜值 → producer 抛错 → 回退过期值
    const v = await cached(key, 60e3, async () => { throw new Error('boom'); }, { staleFallback: true });
    assert.ok(Array.isArray(v), '回退到数组');
    assert.equal(v[0].a, 1);
    assert.ok(v._staleAt, '带 _staleAt 数据时点');
    // 无 staleFallback 选项时保持原行为：直接抛
    await assert.rejects(() => cached(key, 60e3, async () => { throw new Error('boom'); }));
    // 缓存里没有过期值时也直接抛
    await assert.rejects(() => cached('no-such-key-v0.11.5', 60e3, async () => { throw new Error('boom'); }, { staleFallback: true }));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('toNum：空串/横杠/null 归 null（universe 与 ulist 共用）', () => {
  assert.equal(toNum(''), null);
  assert.equal(toNum('-'), null);
  assert.equal(toNum(null), null);
  assert.equal(toNum('3.94'), 3.94);
});
