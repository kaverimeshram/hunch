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

import { evidenceFromChain, validateEvidenceInput, canonicalEvidenceUrl } from './evidence.js';

test('submitted evidence from the contract keeps stance, note, contributor and review', () => {
  const [item] = evidenceFromChain('claim-1', [{ evidence_id: 0, url: 'https://news.example.org/a', stance: 'Contradicting', note: 'Denial.', submitted_by: 'carol.testnet', submitted_at: 1_700_000_000_000, review_status: 'Reviewed', reviewed_by: 'curator.testnet' }]);
  assert.deepEqual(
    [item.stance, item.review_status, item.description, item.submitted_by, item.submitted_at, item.reviewed_by, item.origin],
    ['CONTRADICTING', 'REVIEWED', 'Denial.', 'carol.testnet', 1_700_000_000_000, 'curator.testnet', 'submitted'],
  );
  assert.deepEqual(evidenceFromChain('x', null), []);
  assert.equal(evidenceFromChain('x', [{ url: 'http://bad' }]).length, 0);
});

test('canonical URLs match the contract normalisation', () => {
  assert.equal(canonicalEvidenceUrl('HTTPS://News.Example.org/Story?x=1#top'), 'https://news.example.org/Story?x=1');
  assert.equal(canonicalEvidenceUrl('https://example.com'), 'https://example.com/');
  assert.equal(canonicalEvidenceUrl('https://localhost/a'), null);
  assert.equal(canonicalEvidenceUrl(`https://example.com/${'a'.repeat(600)}`), null);
});

test('evidence form validation gives clear errors before the wallet is asked to sign', () => {
  const ok = validateEvidenceInput({ url: 'https://news.example.org/a#x', stance: 'SUPPORTING', note: '  line one\nline two ' });
  assert.deepEqual(ok.value, { url: 'https://news.example.org/a', stance: 'Supporting', note: 'line one line two' });
  assert.equal(validateEvidenceInput({ url: 'https://news.example.org/a', stance: 'CONTEXT', note: '' }).value.note, null);
  assert.match(validateEvidenceInput({ url: 'http://x.org', stance: 'SUPPORTING' }).error, /https/);
  assert.match(validateEvidenceInput({ url: 'https://a.org/b', stance: 'SUPPORTING' }, ['https://a.org/b']).error, /already listed/);
  assert.match(validateEvidenceInput({ url: 'https://a.org/b', stance: '' }).error, /Choose/);
  assert.match(validateEvidenceInput({ url: 'https://a.org/b', stance: 'VERIFIED' }).error, /Choose/);
  assert.match(validateEvidenceInput({ url: 'https://a.org/b', stance: 'CONTEXT', note: 'é'.repeat(141) }).error, /280 bytes/);
});

test('rendering merges submitted evidence and shows the form only when allowed', () => {
  const fact = { id: 'f', creator: 'alice.testnet', sources: ['https://a.com/x'] };
  const submitted = evidenceFromChain('f', [
    { evidence_id: 0, url: 'https://b.com/y', stance: 'Supporting', note: '<b>bold</b>', submitted_by: 'carol.testnet', submitted_at: 1, review_status: 'Pending' },
    { evidence_id: 1, url: 'https://a.com/x', stance: 'Contradicting', submitted_by: 'dave.testnet', submitted_at: 2, review_status: 'Pending' },
  ]);
  const open = renderEvidenceRoom(fact, { submitted, form: { open: true, connected: false, depositLabel: '0.01 NEAR' } });
  assert.match(open, /<dt>Supporting<\/dt><dd>1<\/dd>/);
  assert.match(open, /<dt>Unclassified<\/dt><dd>1<\/dd>/, 'duplicate of a creator source is not counted twice');
  assert.ok(open.includes('&lt;b&gt;bold&lt;/b&gt;'), 'notes are escaped');
  assert.match(open, /id="evidence-form"/);
  assert.match(open, /Connect wallet and submit/);
  const closed = renderEvidenceRoom(fact, { submitted, form: { open: false, closedReason: 'Closed at deadline.' } });
  assert.ok(!closed.includes('evidence-form"'));
  assert.match(closed, /Closed at deadline\./);
  assert.ok(!renderEvidenceRoom(fact).includes('evidence-form'), 'no form for contracts without evidence support');
});
