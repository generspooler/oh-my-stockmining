// 自选池存取的回归测试。这里的不变式破掉不会报错，只会让
// 挖掘时自选票静默丢失或重复占席。
//
// MINE_WATCHLIST_FILE 必须在 import 之前设置——模块在加载时解析文件路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MINE_WATCHLIST_FILE = path.join(os.tmpdir(), `mine-watch-test-${process.pid}-${Date.now()}.json`);

const { listWatchlist, watchlistFor, addWatch, removeWatch } = await import('../src/watchlist.js');

const stock = (code, name, market, industry = '白酒Ⅱ') => ({ code, name, market, industry });

test('入池、按市场过滤、持久化', () => {
  addWatch(stock('600519', '贵州茅台', 'cn'));
  addWatch(stock('UNH', '联合健康', 'us', '医疗保健'));
  assert.deepEqual(listWatchlist().map((x) => x.code), ['600519', 'UNH']);
  assert.deepEqual(watchlistFor('cn').map((x) => x.code), ['600519']);
  assert.deepEqual(watchlistFor('us').map((x) => x.code), ['UNH']);
  // 文件真的写盘了（CLI 与 server 各自的进程要靠文件共享状态）
  assert.ok(fs.existsSync(process.env.MINE_WATCHLIST_FILE));
});

test('同一代码重复入池不产生重复条目（否则自选票会占两席）', () => {
  addWatch(stock('600519', '贵州茅台', 'cn'));
  addWatch({ code: '600519', name: '贵州茅台', market: 'cn' });
  assert.equal(listWatchlist().filter((x) => x.code === '600519').length, 1);
});

test('代码大小写不敏感：brk.b 与 BRK.B 是同一只', () => {
  addWatch(stock('BRK.B', '伯克希尔-B', 'us', '金融'));
  assert.equal(removeWatch('brk.b'), true, '小写代码应能删掉大写入池条目');
});

test('移出不存在的代码返回 false，不动池子', () => {
  const before = listWatchlist().length;
  assert.equal(removeWatch('NOPE'), false);
  assert.equal(listWatchlist().length, before);
});

test('入池校验：缺 code 或 market 直接抛错（调用方负责解析，这里只守底线）', () => {
  assert.throws(() => addWatch({ name: '无代码' }));
  assert.throws(() => addWatch({ code: 'X', name: '无市场' }));
});

test('清空后挖掘回到纯市场行为', () => {
  for (const x of listWatchlist()) removeWatch(x.code);
  assert.deepEqual(listWatchlist(), []);
  assert.deepEqual(watchlistFor('cn'), []);
});

// 测试文件清理：tmp 目录里的临时 watchlist
test.after?.(() => { try { fs.unlinkSync(process.env.MINE_WATCHLIST_FILE); } catch {} });
