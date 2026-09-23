// 自选池：用户手动维护的长期跟踪名单（SYSTEM_DEFINITION §3.2 自选池）。
//
// 纯手动进出：入池靠网页「+ 自选」/ CLI watch add；出池只有用户能删。
// 不自动入池（挖掘 Top 不沉淀）、不自动出池（归因为陷阱只提示建议移出）——
// 池子是用户的意图，系统的判断只能建议，不能替用户改意图。
//
// 存取唯一入口：CLI、server、挖掘流程都经这里读写，不得各自直接碰文件
// （与 config.js 同一条取向）。市场不隔离——挖 A股带 A股自选、挖美股带美股自选。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.js';

const FILE = process.env.MINE_WATCHLIST_FILE || path.join(ROOT, 'watchlist.json');

const read = () => {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { items: [] }; }
};
const write = (items) => {
  fs.writeFileSync(FILE, JSON.stringify({ items }, null, 1));
  return items;
};

const keyOf = (code) => String(code || '').toUpperCase();

/** 池子内容（全部市场）。每条：{ code, name, market, industry, addedAt }。 */
export function listWatchlist() {
  return read().items || [];
}

/** 该市场的自选清单，挖掘时注入用。 */
export function watchlistFor(market) {
  return listWatchlist().filter((x) => x.market === market);
}

export function inWatchlist(code) {
  return read().items.some((x) => keyOf(x.code) === keyOf(code));
}

/**
 * 入池。stock 需带 code/name/market（industry 可选）——由调用方经 resolve/suggest
 * 解析后传入，这里不做代码解析。已存在则更新名称行业（标的可能改名）。
 */
export function addWatch(stock) {
  if (!stock?.code || !stock.market) throw new Error('入池需要 code 与 market');
  const items = read().items || [];
  const i = items.findIndex((x) => keyOf(x.code) === keyOf(stock.code));
  const entry = {
    code: stock.code, name: stock.name || stock.code, market: stock.market,
    industry: stock.industry || null,
    addedAt: i >= 0 ? items[i].addedAt : new Date().toISOString(),
  };
  if (i >= 0) items[i] = entry; else items.push(entry);
  write(items);
  return entry;
}

/** 出池。返回是否真的删了。 */
export function removeWatch(code) {
  const items = read().items || [];
  const rest = items.filter((x) => keyOf(x.code) !== keyOf(code));
  if (rest.length === items.length) return false;
  write(rest);
  return true;
}
