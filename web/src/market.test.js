import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContractJson, nearAmount, toYocto, odds, formatTenths, payoutFor, statusLabel, isAcceptingInput } from './market.js';

test('parseContractJson keeps yoctoNEAR amounts exact', () => {
  const fact = parseContractJson('{"yes_pool":1234567890123456789012345,"no_pool":0,"stakers":2,"resolve_after":1830297540000}');
  assert.equal(fact.yes_pool, '1234567890123456789012345');
  assert.equal(JSON.parse('{"x":1234567890123456789012345}').x === 1234567890123456789012345, true, 'plain JSON.parse would round');
  assert.equal(fact.no_pool, 0);
  assert.equal(fact.stakers, 2);
  assert.equal(fact.resolve_after, 1830297540000, 'safe integers stay numbers');
});

test('odds always add up to exactly 100.0%', () => {
  for (const [yes, no] of [[1.2e24, 3.4e24], [2.5e24, 0.8e24], [1, 2], [1, 1], [7, 0], [1n, 999999n]]) {
    const { yesTenths, noTenths } = odds(BigInt(yes), BigInt(no));
    assert.equal(yesTenths + noTenths, 1000, `${yes}/${no}`);
  }
  const { yesTenths } = odds(12n * 10n ** 23n, 34n * 10n ** 23n);
  assert.equal(formatTenths(yesTenths), '26.1%', '1.2 / 4.6 = 26.09% rounds to 26.1%, not 26.0%');
  assert.deepEqual(odds(0, 0), { total: 0n, yesTenths: null, noTenths: null });
});

test('amount formatting and parsing', () => {
  assert.equal(nearAmount('1500000000000000000000000'), '1.5 NEAR');
  assert.equal(nearAmount(0), '0 NEAR');
  assert.equal(toYocto('0.01'), '10000000000000000000000');
  assert.throws(() => toYocto('0'));
  assert.throws(() => toYocto('-1'));
  assert.throws(() => toYocto('1e3'));
});

test('payoutFor mirrors the contract', () => {
  const resolved = { status: 'Resolved', outcome: 'Yes', yes_pool: '10', no_pool: '30' };
  assert.equal(payoutFor(resolved, 10, 0), 40n);
  assert.equal(payoutFor(resolved, 0, 30), 0n);
  assert.equal(payoutFor({ ...resolved, outcome: 'No' }, 0, 30), 40n);
  assert.equal(payoutFor({ status: 'Void', yes_pool: '10', no_pool: '30' }, 5, 7), 12n);
  assert.equal(payoutFor({ status: 'Open', yes_pool: '10', no_pool: '30' }, 10, 0), 0n);
  assert.equal(payoutFor({ ...resolved, yes_pool: '3', no_pool: '10' }, 1, 0), 4n, 'integer division rounds down like U256');
});

test('status labels and input window', () => {
  assert.equal(statusLabel({ status: 'Void' }), 'Void · stakes refundable');
  assert.equal(statusLabel({ status: 'Resolved', outcome: 'No' }), 'Resolved NO');
  assert.equal(isAcceptingInput({ status: 'Open', resolve_after: 2000 }, 1999), true);
  assert.equal(isAcceptingInput({ status: 'Open', resolve_after: 2000 }, 2000), false);
  assert.equal(isAcceptingInput({ status: 'Pending', resolve_after: 2000 }, 1000), false);
});
