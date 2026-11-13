import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSourceUrl, normalizeEvidence, evidenceFromFact, groupByStance, renderEvidenceRoom, STANCE_ORDER,
} from './evidence.js';

const fact = (sources, extra = {}) => ({ id: 'claim-1', claim: 'A claim.', creator: 'alice.testnet', sources, ...extra });

test('parseSourceUrl accepts only well-formed https URLs', () => {
  assert.equal(parseSourceUrl('https://example.com/a?b=1').href, 'https://example.com/a?b=1');
  for (const bad of ['http://example.com', 'javascript:alert(1)', 'https://', 'not a url', '', null, 42,
    'https://user:pass@example.com/', `https://example.com/${'a'.repeat(3000)}`]) {
    assert.equal(parseSourceUrl(bad), null, `should reject ${String(bad).slice(0, 40)}`);
  }
});

test('contract sources become unclassified, unreviewed items credited to the creator', () => {
  const items = evidenceFromFact(fact(['https://www.example.com/news/story']));
  assert.equal(items.length, 1);
  assert.deepEqual(
    { id: items[0].evidence_id, fact: items[0].fact_id, host: items[0].host, path: items[0].path, stance: items[0].stance, review: items[0].review_status, by: items[0].submitted_by, at: items[0].submitted_at, title: items[0].title },
    { id: 'claim-1:source:0', fact: 'claim-1', host: 'example.com', path: '/news/story', stance: 'UNCLASSIFIED', review: 'PENDING', by: 'alice.testnet', at: null, title: null },
  );
});

test('invalid and duplicate sources are skipped without throwing', () => {
  const items = evidenceFromFact(fact(['https://a.com/x', 'https://', 'http://b.com', 'https://a.com/x', 'https://c.com']));
  assert.deepEqual(items.map((i) => i.url), ['https://a.com/x', 'https://c.com/']);
  assert.deepEqual(evidenceFromFact({ id: 'x' }), []);
  assert.deepEqual(evidenceFromFact(null), []);
});

test('unknown stance or review status can never look classified or reviewed', () => {
  const item = normalizeEvidence({ url: 'https://a.com', stance: 'VERIFIED', review_status: 'TRUE' });
  assert.equal(item.stance, 'UNCLASSIFIED');
  assert.equal(item.review_status, 'PENDING');
  const proto = normalizeEvidence({ url: 'https://a.com', stance: 'toString', review_status: '__proto__' });
  assert.equal(proto.stance, 'UNCLASSIFIED');
  assert.equal(proto.review_status, 'PENDING');
  assert.equal(normalizeEvidence({ url: 'ftp://a.com' }), null);
});

test('untrusted metadata is trimmed, length-capped and type-checked', () => {
  const item = normalizeEvidence({ url: 'https://a.com', title: `  ${'x'.repeat(500)}  `, publisher: 7, content_hash: 'nothex', published_at: 'garbage' });
  assert.equal(item.title.length, 300);
  assert.equal(item.publisher, null);
  assert.equal(item.content_hash, null);
  assert.equal(item.published_at, null);
});

test('groupByStance returns every stance in display order', () => {
  const items = ['SUPPORTING', 'CONTRADICTING', 'SUPPORTING'].map((stance, i) => normalizeEvidence({ url: `https://a.com/${i}`, stance }));
  const groups = groupByStance(items);
  assert.deepEqual(Object.keys(groups), STANCE_ORDER);
  assert.deepEqual(STANCE_ORDER.map((s) => groups[s].length), [2, 1, 0, 0]);
});

test('rendering escapes hostile content from URLs', () => {
  const html = renderEvidenceRoom(fact(['https://evil.com/"><script>alert(1)</script>?q=<img onerror=x>']));
  assert.ok(!html.includes('<script>'), 'script tag must be escaped');
  assert.ok(!html.includes('<img'), 'img tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('rendering shows honest labels and useful empty states', () => {
  const html = renderEvidenceRoom(fact(['https://a.com/story', 'https://']));
  assert.match(html, /No source is classified as supporting this claim yet\./);
  assert.match(html, /No source is classified as contradicting this claim yet\./);
  assert.match(html, /Not reviewed/);
  assert.match(html, /claim creator/);
  assert.match(html, /Not shown: 1 source entry/);
  assert.ok(!/verified/i.test(html), 'must never call a source verified');
  assert.ok(!html.includes('evidence-context'), 'empty Context group is hidden');

  const empty = renderEvidenceRoom(fact([]));
  assert.match(empty, /No sources have been attached to this claim yet\./);
});
