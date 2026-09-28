// 美股章节抽取与单季趋势（v0.11.0）的纯函数测试。
//
// 这一版补的是「年报之后发生了什么」这个盲区：美股档案此前只有年报，而实测 44 只美股
// 自选里 15 只 MD&A、15 只风险章节取不到。这里守住四件事：
//   1. 被「目录簇」误伤的正文真标题能救回来——而且**只在一个候选都没有时**才救，
//      已经抽得对的文档行为不变（改动前后 33 份真实 10-K 逐字符一致）；
//   2. 写得长的章节放行，吃过头的照样拒绝（判据是中间有没有夹着别的章节的真标题）；
//   3. 10-Q 的 Part I / Part II 编号重复时靠章节名区分，短风险章节（「无重大变化」）是内容不是残留；
//   4. 单季同比按「约一年前那一季」配对，不按月日字符串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractItemUS } from '../src/sources/filings.js';
import { quarterlyHistory } from '../src/metrics/normalize.js';

const pad = (n, w = 'lorem ipsum dolor sit amet ') => w.repeat(Math.ceil(n / w.length)).slice(0, n);

// 带页码的目录 + 正文。正文里 Item 4~7 挤在一起（Item 5「None.」、Item 6「[Reserved]」），
// 复现 AMZN / GOOGL / ALAB 的排版：旧判据会把这一簇正文真标题当成目录
function denseDoc({ riskLen = 60000, mdnaLen = 40000 } = {}) {
  return [
    'Table of Contents Item 1. Business 3 Item 1A. Risk Factors 12 Item 1B. Unresolved Staff Comments 30',
    'Item 2. Properties 30 Item 3. Legal Proceedings 31 Item 5. Market for Registrant s Common Equity 32',
    "Item 6. [Reserved] 33 Item 7. Management's Discussion and Analysis of Financial Condition and Results of Operations 33",
    'Item 7A. Quantitative and Qualitative Disclosures About Market Risk 50 Item 8. Financial Statements and Supplementary Data 51',
    pad(20000),
    'Item 1. Business We make things.', pad(30000),
    'Item 1A. Risk Factors You should carefully consider the risks below.', pad(riskLen),
    'Item 1B. Unresolved Staff Comments None.',
    'Item 2. Properties We lease offices.', pad(3000),
    'Item 3. Legal Proceedings See Note 7.', pad(3000),
    'Item 4. Mine Safety Disclosures Not applicable.',
    'Item 5. Market for the Registrant s Common Stock, Related Stockholder Matters None.',
    'Item 6. [Reserved]',
    "Item 7. Management's Discussion and Analysis of Financial Condition and Results of Operations The following discussion should be read.",
    pad(mdnaLen),
    'Item 7A. Quantitative and Qualitative Disclosures About Market Risk We are exposed to rates.', pad(4000),
    'Item 8. Financial Statements and Supplementary Data', pad(10000),
  ].join(' ');
}

test('extractItemUS：正文真标题被目录簇误伤时，按「标题后是正文不是页码」救回', () => {
  const r = extractItemUS(denseDoc(), 'mdna');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.rescued, true);
  assert.match(r.text, /^Item 7\. Management's Discussion and Analysis[\s\S]*The following discussion/);
  assert.ok(!/Item 7A\. Quantitative/.test(r.text), '在 Item 7A 的真标题处结束');
  assert.ok(r.chars > 40000 && r.chars < 41000);
});

test('extractItemUS：只在没有候选时才救——正常文档不带 rescued 标记', () => {
  // 把正文里的短章节拉开，不再构成目录簇
  // 只改正文那一簇（目录里的同名条目带页码，字符串不同）
  const doc = denseDoc()
    .replace('Item 5. Market for the Registrant', `${pad(3000)} Item 5. Market for the Registrant`)
    .replace("Item 6. [Reserved] Item 7. Management's", `${pad(3000)} Item 6. [Reserved] ${pad(3000)} Item 7. Management's`);
  const r = extractItemUS(doc, 'mdna');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.rescued, undefined);
});

test('extractItemUS：写得长的风险章节放行并标注 long，不再一刀切', () => {
  const r = extractItemUS(denseDoc({ riskLen: 200000 }), 'risk');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.long, true);
  assert.match(r.text, /^Item 1A\. Risk Factors You should/);
});

test('extractItemUS：吃过头（中间夹着别的章节真标题）照样拒绝，不返回错内容', () => {
  // 删掉风险章节紧后的结束标记（1B/2），再在文末补一个 Item 2 真标题：
  // 选段于是"有界"，但中间夹着 Item 3~7 的真标题——典型的一路吃过了头
  const doc = denseDoc({ riskLen: 100000 })
    .replace('Item 1B. Unresolved Staff Comments None.', 'none.')
    .replace('Item 2. Properties We lease offices.', 'we lease offices.')
    .replace('Item 8. Financial Statements and Supplementary Data lorem', 'Item 2. Properties Extra heading. lorem');
  const r = extractItemUS(doc, 'risk');
  assert.equal(r.ok, false);
  assert.match(r.reason, /中间夹着 .*Item 7/);
});

// 10-Q：Part I Item 2 是 MD&A，Part II Item 2 是股票回购；Part II Item 1A 常常只有一句话
function tenQ({ risk = 'There have been no material changes from the risk factors disclosed in our Annual Report.' } = {}) {
  return [
    'PART I. FINANCIAL INFORMATION Item 1. Financial Statements 3 Item 2. Management s Discussion and Analysis 20',
    'Item 3. Quantitative and Qualitative Disclosures About Market Risk 35 Item 4. Controls and Procedures 36',
    'PART II. OTHER INFORMATION Item 1. Legal Proceedings 37 Item 1A. Risk Factors 37 Item 2. Unregistered Sales 38 Item 6. Exhibits 39',
    pad(5000),
    'Item 1. Financial Statements', pad(30000),
    'Item 2. Management s Discussion and Analysis of Financial Condition and Results of Operations This quarter revenue grew.', pad(25000),
    'Item 3. Quantitative and Qualitative Disclosures About Market Risk No material change.', pad(1500),
    'Item 4. Controls and Procedures Effective.', pad(1500),
    'PART II Item 1. Legal Proceedings See Note 9.', pad(1500),
    `Item 1A. Risk Factors ${risk}`,
    'Item 2. Unregistered Sales of Equity Securities and Use of Proceeds We repurchased shares.', pad(2000),
    'Item 5. Other Information None. Item 6. Exhibits 31.1',
  ].join(' ');
}

test('extractItemUS(10-Q)：同号不同章靠章节名区分，MD&A 不会被抽成股票回购', () => {
  const r = extractItemUS(tenQ(), 'mdna', { form: '10-Q' });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /^Item 2\. Management s Discussion[\s\S]*revenue grew/);
  assert.ok(!/Unregistered Sales/.test(r.text));
  assert.ok(!/Quantitative and Qualitative Disclosures About Market Risk No material/.test(r.text), '在 Part I Item 3 处结束');
});

test('extractItemUS(10-Q)：「无重大变化」的一句话风险章节是内容，不是残留', () => {
  const r = extractItemUS(tenQ(), 'risk', { form: '10-Q' });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /no material changes/);
  assert.ok(!/repurchased/.test(r.text), '在 Part II Item 2 处结束');
});

test('extractItemUS：「Risk Factors section in our 10-K」是交叉引用，不当标题', () => {
  // PFE 实测：MD&A 正文里的这句交叉引用曾被当成风险章节起点，抽出 1.8 万字符的 MD&A
  const doc = tenQ().replace('This quarter revenue grew.',
    'This quarter revenue grew. See Item 1A. Risk Factors section in our 2025 Form 10-K for more.');
  const r = extractItemUS(doc, 'risk', { form: '10-Q' });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /^Item 1A\. Risk Factors There have been no material changes/);
});

test('extractItemUS：10-Q 没有业务描述章节，如实说明', () => {
  const r = extractItemUS(tenQ(), 'business', { form: '10-Q' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /10-Q 没有/);
});

test('quarterlyHistory：同比按约一年前那一季配对，财年季末在周六也配得上', () => {
  const st = {
    quarterly: [
      { period: '2026-06-27', revenue: 150, operateProfit: 30, parentNetProfit: 20, eps: 1.2, currency: 'USD' },
      { period: '2026-03-28', revenue: 140, operateProfit: 28, parentNetProfit: 18 },
      { period: '2025-12-27', revenue: 130, operateProfit: 26, parentNetProfit: 16 },
      { period: '2025-09-27', revenue: 120, operateProfit: 24, parentNetProfit: 15 },
      { period: '2025-06-28', revenue: 100, operateProfit: 20, parentNetProfit: 10 },
    ],
  };
  const q = quarterlyHistory(st, 'us');
  assert.equal(q.asOf, '2026-06-27');
  assert.equal(q.rows.length, 5);
  assert.equal(q.rows[0].revYoy, 0.5, '150 vs 一年前（相差 364 天）的 100');
  assert.equal(q.rows[0].npYoy, 1);
  assert.equal(q.rows[0].opMargin, 0.2);
  assert.equal(q.rows[0].currency, 'USD');
  assert.equal(q.rows[1].revYoy, null, '没有一年前的那一季就不编同比');
});

test('quarterlyHistory：A股（累计口径）与无数据返回 null', () => {
  assert.equal(quarterlyHistory({ quarterly: [{ period: '2026-06-30', revenue: 1 }] }, 'cn'), null);
  assert.equal(quarterlyHistory({}, 'us'), null);
  assert.equal(quarterlyHistory(null, 'us'), null);
});
