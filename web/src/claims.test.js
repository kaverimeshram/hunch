import test from 'node:test';
import assert from 'node:assert/strict';
import { stageOf, deckOrder, priceTexts } from './claims.js';

const NOW = 1_000_000;
const fact = (id, over) => ({ id, status: 'Open', resolve_after: NOW + 1000, yes_pool: '0', no_pool: '0', ...over });

test('open before the close time, awaiting after it', () => {
  assert.equal(stageOf(fact('a'), NOW).key, 'open');
  assert.equal(stageOf(fact('a', { resolve_after: NOW - 1 }), NOW).key, 'awaiting');
  assert.equal(stageOf(fact('a', { status: 'Resolved', outcome: 'No' }), NOW).label, 'Resolved NO');
});

test('deck puts stakeable markets first, soonest close first', () => {
  const facts = [
    fact('awaiting', { resolve_after: NOW - 5, yes_pool: '150' }),
    fact('late', { resolve_after: NOW + 9000 }),
    fact('soon', { resolve_after: NOW + 10 }),
    fact('done', { status: 'Resolved', outcome: 'Yes' }),
  ];
  assert.deepEqual(deckOrder(facts, NOW).map((f) => f.id), ['soon', 'late', 'awaiting', 'done']);
});

test('price text shows a dash until someone stakes', () => {
  assert.equal(priceTexts(fact('a')).yesPct, '-');
  assert.equal(priceTexts(fact('a', { yes_pool: '3', no_pool: '1' })).yesPct, '75%');
});
