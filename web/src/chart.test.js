import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, chartSvg } from './chart.js';

const N = 10n ** 24n;
const series = [
  { at: 1000000, side: 'Yes', amount: N / 10n, yes: N / 10n, no: 0n, yesTenths: 1000 },
  { at: 4600000, side: 'No', amount: N / 20n, yes: N / 10n, no: N / 20n, yesTenths: 667 },
];

test('layout puts 100% at the top, lower shares lower, and time left to right', () => {
  const { points, endX } = layout(series, { width: 700, height: 240, nowMs: 9000000 });
  assert.ok(points[0].py < points[1].py, '100% sits above 66.7%');
  assert.ok(points[0].px < points[1].px && points[1].px < endX);
  assert.ok(points[0].px > 8, 'domain starts before the first stake');
});

test('step line holds its value until the next stake and ends at now', () => {
  const svg = chartSvg(series, { width: 700, nowMs: 9000000 });
  assert.match(svg, /class="line"[^>]*/);
  assert.match(svg, /d="M[\d.]+ [\d.]+ H[\d.]+ V[\d.]+ H[\d.]+"/);
  assert.equal((svg.match(/<circle/g) || []).length, 2, 'one marker per real stake, nothing else');
  assert.match(svg, /No 0\.05 NEAR/);
  assert.equal(chartSvg([], { width: 700 }), '', 'no stakes, no chart');
});
