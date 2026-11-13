import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, stamps, thresholdFor, tilt } from './swipe.js';

const T = thresholdFor(390);

test('threshold scales with the card and never drops under 90px', () => {
  assert.equal(thresholdFor(200), 90);
  assert.ok(Math.abs(thresholdFor(400) - 112) < 1e-9);
});

test('decide commits only past the threshold', () => {
  assert.equal(decide(T, 0, T), 'yes');
  assert.equal(decide(T - 1, 0, T), null);
  assert.equal(decide(-T, 5, T), 'no');
  assert.equal(decide(0, -T, T), 'skip');
  assert.equal(decide(0, T, T), null);
});

test('a diagonal flick counts as its side, a mostly vertical drag as skip', () => {
  assert.equal(decide(T + 10, -T - 10, T), 'yes');
  assert.equal(decide(20, -T - 10, T), 'skip');
});

test('stamps fade in with the drag and only one shows', () => {
  assert.deepEqual(stamps(0, 0, T), { yes: 0, no: 0, skip: 0 });
  assert.equal(stamps(T, 0, T).yes, 1);
  assert.equal(stamps(T, 0, T).no, 0);
  assert.ok(stamps(T * 0.35, 0, T).yes > 0.4 && stamps(T * 0.35, 0, T).yes < 0.6);
  assert.deepEqual(stamps(10, -T, T), { yes: 0, no: 0, skip: 1 });
});

test('tilt follows the drag and clamps', () => {
  assert.equal(tilt(0, 390), 0);
  assert.equal(tilt(1000, 390), 16);
  assert.equal(tilt(-1000, 390), -16);
});
