import test from 'node:test';
import assert from 'node:assert/strict';
import { sidePercent, sideTenths, pct, moveOf, sharePost, intentUrl, payoutIfRight, positionRows } from './moment.js';

const N = (near) => (BigInt(Math.round(near * 100)) * 10n ** 22n).toString();
const pool = (yes, no, extra = {}) => ({ id: 'c1', claim: 'The Patoshi-pattern miner mined at least 1,000,000 BTC.', status: 'Open', yes_pool: N(yes), no_pool: N(no), ...extra });

test('side percent reads the pools and is null when empty', () => {
  assert.equal(sidePercent(pool(2, 1), 'Yes'), 67);
  assert.equal(sidePercent(pool(2, 1), 'No'), 33);
  assert.equal(sidePercent(pool(0, 0), 'Yes'), null);
});

test('a stake that lifts YES says from and to, a stake on NO reports the NO side', () => {
  const before = pool(2, 1);
  const after = pool(2.5, 1);
  const move = moveOf(before, after, 'Yes', N(0.5));
  assert.deepEqual([move.from, move.to], [667, 714]);
  assert.equal(move.text, 'Your 0.5 NEAR moved YES from 66.7% to 71.4%.');
  assert.equal(moveOf(before, pool(2, 1.5), 'No', N(0.5)).text, 'Your 0.5 NEAR moved NO from 33.3% to 42.9%.');
});

test('first stake, unchanged price and unreadable result each get honest text', () => {
  assert.equal(moveOf(pool(0, 0), pool(0.5, 0), 'Yes', N(0.5)).text, 'Your 0.5 NEAR opened the market at 100% YES.');
  assert.equal(moveOf(pool(100, 100), pool(100.01, 100), 'Yes', N(0.01)).text, 'Your 0.01 NEAR holds YES at 50%.');
  assert.match(moveOf(pool(2, 1), pool(2, 1), 'Yes', N(0.05)).text, /holds YES at 66.7%/);
});

test('the post carries the odds, the claim, the transaction and the claim link', () => {
  const post = sharePost({ fact: pool(2, 1), side: 'Yes', percent: 714, from: 667, amountRaw: N(0.5), tx: 'ABC123', explorer: 'https://testnet.nearblocks.io', origin: 'https://hunch-near.vercel.app' });
  assert.match(post.text, /^I'm 71.4% YES on "The Patoshi/);
  assert.match(post.text, /moved it from 66.7% to 71.4%/);
  assert.match(post.text, /testnet\.nearblocks\.io\/txns\/ABC123$/);
  assert.equal(post.url, 'https://hunch-near.vercel.app/#c1');
  const href = intentUrl(post);
  assert.ok(href.startsWith('https://x.com/intent/post?text='));
  assert.ok(href.includes(encodeURIComponent(post.url)));
});

test('payout if right is pro rata on the pools as they stand', () => {
  // 1 NEAR on YES inside a 4 NEAR pool where YES holds 2: pays 1 * 4 / 2 = 2.
  assert.equal(payoutIfRight(pool(2, 2), 'Yes', N(1)), BigInt(N(2)));
  assert.equal(payoutIfRight(pool(2, 2), 'Yes', '0'), 0n);
});

test('positions list only stakes, newest first, with live odds and settled result', () => {
  const a = pool(2, 1, { id: 'a' });
  const b = pool(1, 3, { id: 'b', status: 'Resolved', outcome: 'No' });
  const c = pool(1, 1, { id: 'c' });
  const rows = positionRows([a, b, c], {
    a: { kind: 'staked', side: 'Yes', amount: '0.5 NEAR', yocto: N(0.5), tx: 'T1', at: 10 },
    b: { kind: 'staked', side: 'Yes', amount: '0.1 NEAR', yocto: N(0.1), at: 20 },
    c: { kind: 'opinion', side: 'No', at: 30 },
  });
  assert.deepEqual(rows.map((r) => r.fact.id), ['b', 'a']);
  assert.equal(rows[0].settled, 'lost');
  assert.equal(rows[1].settled, 'open');
  assert.equal(rows[1].percent, 67);
  assert.equal(rows[1].tx, 'T1');
});

test('tenths keep a small move visible and whole numbers stay clean', () => {
  assert.equal(pct(921), '92.1%');
  assert.equal(pct(920), '92%');
  assert.equal(sideTenths(pool(2, 1), 'No'), 333);
  assert.equal(moveOf(pool(6, 0.5), pool(6.05, 0.5), 'Yes', N(0.05)).text, 'Your 0.05 NEAR moved YES from 92.3% to 92.4%.');
});
