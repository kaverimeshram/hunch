import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, stamps, thresholdFor, tilt, pullOf, stampScale, springStep, FLICK_SPEED } from './swipe.js';

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

test('a fast flick commits a short drag, a slow one does not, a flick against the drag does not', () => {
  assert.equal(decide(T * 0.4, 0, T, FLICK_SPEED + 0.1), 'yes');
  assert.equal(decide(-T * 0.4, 0, T, -(FLICK_SPEED + 0.1)), 'no');
  assert.equal(decide(T * 0.4, 0, T, 0.2), null);
  assert.equal(decide(T * 0.2, 0, T, FLICK_SPEED + 0.5), null);
  assert.equal(decide(T * 0.4, 0, T, -(FLICK_SPEED + 0.1)), null);
});

test('pull and stamp scale grow with the drag and clamp', () => {
  assert.equal(pullOf(0, 0, T), 0);
  assert.equal(pullOf(T * 5, 0, T), 1);
  assert.ok(pullOf(T * 0.7, 0, T) > 0.45 && pullOf(T * 0.7, 0, T) < 0.55);
  assert.equal(stampScale(0), 0.7);
  assert.ok(Math.abs(stampScale(1) - 1.15) < 1e-9);
  assert.equal(stampScale(9), stampScale(1));
});

test('the release spring overshoots once, then settles at rest', () => {
  let s = { x: 120, v: 0 };
  let crossed = false, minX = 120;
  for (let i = 0; i < 400; i += 1) {
    s = springStep(s, 1 / 120);
    if (s.x < 0) crossed = true;
    minX = Math.min(minX, s.x);
  }
  assert.ok(crossed, 'overshoots past zero');
  assert.ok(minX > -60, 'overshoot stays small');
  assert.ok(Math.abs(s.x) < 0.5 && Math.abs(s.v) < 0.5, 'settles');
});
