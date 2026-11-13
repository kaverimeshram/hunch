import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stakeEventsFromTx, seriesFor, reconciles, fetchStakeHistory } from './history.js';

const NEAR = 10n ** 24n;
const tx = (hash, id, side, near, ms, status = true) => ({
  transaction_hash: hash, signer_account_id: `${hash}.testnet`, block_timestamp: `${BigInt(ms) * 1000000n}`, outcomes: { status },
  actions: [{ method: 'stake', args: { deposit: String(BigInt(near * 100) * NEAR / 100n), args_json: { id, side } } }],
});

test('stake events decode id, side, amount and ms timestamp; failed txs are dropped', () => {
  const [event] = stakeEventsFromTx(tx('a', 'claim', 'Yes', 0.1, 1794597225597));
  assert.deepEqual({ ...event, amount: event.amount.toString() }, { factId: 'claim', side: 'Yes', amount: (NEAR / 10n).toString(), account: 'a.testnet', at: 1794597225597, hash: 'a' });
  assert.deepEqual(stakeEventsFromTx(tx('b', 'claim', 'No', 1, 1, false)), []);
});

test('series is cumulative per fact and reconciles with pools only when exact', () => {
  const events = [tx('a', 'x', 'Yes', 0.1, 1000), tx('b', 'x', 'No', 0.05, 2000), tx('c', 'other', 'No', 9, 1500)].flatMap(stakeEventsFromTx);
  const series = seriesFor(events, 'x');
  assert.deepEqual(series.map((p) => p.yesTenths), [1000, 667]);
  assert.equal(reconciles(series, { yes_pool: String(NEAR / 10n), no_pool: String(NEAR / 20n) }), true);
  assert.equal(reconciles(series, { yes_pool: String(NEAR / 10n), no_pool: '0' }), false, 'a missing stake must fail reconciliation');
  assert.equal(reconciles([], { yes_pool: '0', no_pool: '0' }), true);
  assert.equal(reconciles([], { yes_pool: '1', no_pool: '0' }), false);
});

test('fetchStakeHistory follows cursors, skips non-stake txs and uses the cache', async () => {
  const C = 'c.testnet';
  const listTx = (hash, method, status = true) => ({ transaction_hash: hash, receiver_account_id: C, outcomes: { status }, actions: [{ method }] });
  const pages = { '': { data: [listTx('a', 'stake'), listTx('z', 'create_fact')], meta: { next_page: 'p2' } }, p2: { data: [listTx('b', 'stake'), listTx('f', 'stake', false)] } };
  const details = { a: tx('a', 'x', 'Yes', 1, 10), b: tx('b', 'x', 'No', 2, 20) };
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    if (url.includes('/txns?')) return pages[new URL(url).searchParams.get('next') || ''];
    return { data: details[url.split('/txns/')[1]] };
  };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const first = await fetchStakeHistory(C, { getJson: get, storage });
  assert.deepEqual(first.map((e) => [e.hash, e.side, e.amount]), [['a', 'Yes', NEAR], ['b', 'No', 2n * NEAR]]);
  const before = calls.length;
  await fetchStakeHistory(C, { getJson: get, storage });
  assert.equal(calls.length - before, 2, 'second run only re-lists pages; tx details come from cache');
});
