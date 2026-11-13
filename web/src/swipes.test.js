import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSwipe, swipesFor, resetSwipes, unseen } from './swipes.js';

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('swipes persist per contract and drain the stack', () => {
  const storage = memory();
  recordSwipe('a.testnet', { id: 'f1', side: 'Yes', kind: 'staked', amount: '0.5 NEAR', at: 1 }, storage);
  recordSwipe('b.testnet', { id: 'f2', side: null, kind: 'skip', at: 2 }, storage);
  assert.equal(swipesFor('a.testnet', storage).f1.kind, 'staked');
  assert.equal(swipesFor('a.testnet', storage).f2, undefined);
  const facts = [{ id: 'f1' }, { id: 'f3' }];
  assert.deepEqual(unseen(facts, swipesFor('a.testnet', storage)).map((f) => f.id), ['f3']);
  resetSwipes('a.testnet', storage);
  assert.deepEqual(swipesFor('a.testnet', storage), {});
  assert.equal(swipesFor('b.testnet', storage).f2.kind, 'skip');
});

test('corrupt storage reads as no swipes', () => {
  const storage = { getItem: () => '{not json', setItem() {} };
  assert.deepEqual(swipesFor('a.testnet', storage), {});
});
