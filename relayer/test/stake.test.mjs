import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { parseStake, visitorQuota } from '../src/index.mjs';

test('parseStake accepts a well-formed stake and defaults to 0.05 NEAR', () => {
  const s = parseStake({ fact: 'patoshi-one-million-btc', side: 'Yes' });
  assert.equal(s.amount, 5n * 10n ** 22n);
  assert.equal(s.side, 'Yes');
});

test('parseStake refuses a bad side, a bad claim id and out-of-range amounts', () => {
  assert.throws(() => parseStake({ fact: 'x', side: 'Maybe' }), /Yes or No/);
  assert.throws(() => parseStake({ fact: 'Bad Id!', side: 'No' }), /claim id/);
  assert.throws(() => parseStake({ fact: 'x', side: 'No', amount: '1' }), /between 0.01 and 0.1/);
  assert.throws(() => parseStake({ fact: 'x', side: 'No', amount: String(10n ** 24n) }), /between 0.01 and 0.1/);
});

test('a fresh browser token has the full daily quota', () => {
  assert.equal(visitorQuota('fresh-token-123'), 6);
});

test('the stake route refuses a request with no visitor token before touching the chain', async () => {
  const res = await worker.fetch(new Request('https://x.test/api/stake', { method: 'POST', body: JSON.stringify({ fact: 'a', side: 'Yes' }) }), { ASSETS: { fetch: () => new Response('') } });
  assert.equal(res.status, 400);
});

test('the rpc relay refuses methods outside its allow list', async () => {
  const res = await worker.fetch(new Request('https://x.test/api/rpc', { method: 'POST', body: JSON.stringify({ method: 'broadcast_tx_commit', params: [] }) }), {});
  assert.equal(res.status, 400);
});
