import { escapeHTML } from './html.js';

/*
 * Evidence Room: model and rendering for the evidence section of a fact page.
 *
 * Two independent properties describe every evidence item:
 *   stance        - how the source relates to the claim (supports it, contradicts it, ...)
 *   review_status - whether a reviewer has checked the source is relevant and genuine
 * Neither one says the claim, or the source, is true. Nothing here ever labels a
 * source "verified".
 *
 * Two on-chain inputs feed the room:
 *   Fact.sources      - bare https URLs added by the claim creator (UNCLASSIFIED, PENDING)
 *   get_evidence()    - community submissions with stance, note, contributor and review
 * Both pass through normalizeEvidence(), which treats every field as untrusted.
 */

export const STANCE_ORDER = Object.freeze(['SUPPORTING', 'CONTRADICTING', 'CONTEXT', 'UNCLASSIFIED']);

export const STANCES = Object.freeze({
  SUPPORTING: { label: 'Supporting', empty: 'No source is classified as supporting this claim yet.' },
  CONTRADICTING: { label: 'Contradicting', empty: 'No source is classified as contradicting this claim yet.' },
  CONTEXT: { label: 'Context', empty: 'No context sources yet.' },
  UNCLASSIFIED: { label: 'Unclassified', empty: 'Every source on this claim has a classification.' },
});

export const REVIEW_STATUSES = Object.freeze({
  PENDING: { label: 'Not reviewed', hint: 'No reviewer has checked this source yet.' },
  REVIEWED: { label: 'Reviewed', hint: 'A reviewer checked that this source is relevant and genuine. This does not mean its content is accurate.' },
  REJECTED: { label: 'Rejected', hint: 'A reviewer found this source irrelevant, inaccessible or not genuine.' },
});

const MAX_URL_LENGTH = 2048;
const MAX_TEXT = { title: 300, publisher: 120, author: 120, description: 600 };
const MAX_PATH_DISPLAY = 80;
const EXPLORER = 'https://testnet.nearblocks.io/address/';

/** Parse a source URL. Returns a URL object for well-formed https URLs only, otherwise null. */
export function parseSourceUrl(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanTimestamp(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Path and query of a URL in readable form, shortened for display. */
export function displayPath(url) {
  let path = url.pathname === '/' ? '' : url.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep the encoded form */ }
  const full = `${path}${url.search}`;
  return full.length > MAX_PATH_DISPLAY ? `${full.slice(0, MAX_PATH_DISPLAY - 1)}…` : full;
}

/**
 * Turn an untrusted evidence record into a safe, fully-populated one.
 * Returns null when the URL is unusable. Unknown stances fall back to UNCLASSIFIED and
 * unknown review states fall back to PENDING, so bad data can never look reviewed.
 */
export function normalizeEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = parseSourceUrl(raw.url);
  if (!url) return null;
  return {
    evidence_id: cleanText(raw.evidence_id, 200) || url.href,
    fact_id: cleanText(raw.fact_id, 64),
    url: url.href,
    host: url.hostname.replace(/^www\./, ''),
    path: displayPath(url),
    title: cleanText(raw.title, MAX_TEXT.title),
    publisher: cleanText(raw.publisher, MAX_TEXT.publisher),
    author: cleanText(raw.author, MAX_TEXT.author),
    published_at: cleanTimestamp(raw.published_at),
    description: cleanText(raw.description, MAX_TEXT.description),
    content_hash: typeof raw.content_hash === 'string' && /^[0-9a-f]{64}$/.test(raw.content_hash) ? raw.content_hash : null,
    submitted_by: cleanText(raw.submitted_by, 64),
    submitted_at: cleanTimestamp(raw.submitted_at),
    reviewed_by: cleanText(raw.reviewed_by, 64),
    stance: Object.hasOwn(STANCES, raw.stance) ? raw.stance : 'UNCLASSIFIED',
    review_status: Object.hasOwn(REVIEW_STATUSES, raw.review_status) ? raw.review_status : 'PENDING',
    origin: raw.origin === 'contract-source' ? 'contract-source' : 'submitted',
  };
}

/** Evidence items for a fact as returned by the contract's get_fact view. Skips invalid and duplicate URLs. */
export function evidenceFromFact(fact) {
  const sources = Array.isArray(fact?.sources) ? fact.sources : [];
  const seen = new Set();
  const items = [];
  sources.forEach((source, index) => {
    const item = normalizeEvidence({
      evidence_id: `${fact.id}:source:${index}`,
      fact_id: fact.id,
      url: source,
      submitted_by: fact.creator,
      origin: 'contract-source',
    });
    if (!item || seen.has(item.url)) return;
    seen.add(item.url);
    items.push(item);
  });
  return items;
}

// Contract enum names <-> display keys.
export const CONTRACT_STANCE = Object.freeze({ SUPPORTING: 'Supporting', CONTRADICTING: 'Contradicting', CONTEXT: 'Context', UNCLASSIFIED: 'Unclassified' });
const FROM_CONTRACT_STANCE = Object.fromEntries(Object.entries(CONTRACT_STANCE).map(([key, value]) => [value, key]));
const FROM_CONTRACT_REVIEW = Object.freeze({ Pending: 'PENDING', Reviewed: 'REVIEWED', Rejected: 'REJECTED' });

/** Evidence items from the contract's get_evidence view. Invalid entries are dropped. */
export function evidenceFromChain(factId, items) {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => normalizeEvidence({
    evidence_id: `${factId}:evidence:${raw?.evidence_id}`,
    fact_id: factId,
    url: raw?.url,
    stance: FROM_CONTRACT_STANCE[raw?.stance],
    review_status: FROM_CONTRACT_REVIEW[raw?.review_status],
    description: raw?.note,
    submitted_by: raw?.submitted_by,
    submitted_at: raw?.submitted_at,
    reviewed_by: raw?.reviewed_by,
    origin: 'submitted',
  })).filter(Boolean);
}

/**
 * Canonical form of a submitted URL, matching the contract's normalisation: https,
 * lowercase host with a dot, no credentials, no fragment, at most 512 bytes.
 */
export function canonicalEvidenceUrl(raw) {
  const url = parseSourceUrl(raw);
  if (!url || !url.hostname.includes('.') || /^[.-]/.test(url.hostname)) return null;
  url.hash = '';
  return new TextEncoder().encode(url.href).length <= 512 ? url.href : null;
}

/**
 * Validate the evidence form before asking the wallet to sign, using the same limits as
 * the contract so users see a clear message instead of a failed transaction.
 * Returns { value: { url, stance, note } } with contract-ready values, or { error }.
 */
export function validateEvidenceInput({ url, stance, note }, existingUrls = []) {
  const canonical = canonicalEvidenceUrl(url);
  if (!canonical) return { error: 'Enter a full https:// link to the source, up to 512 characters.' };
  if (existingUrls.includes(canonical)) return { error: 'This source is already listed for this claim.' };
  if (!Object.hasOwn(CONTRACT_STANCE, stance)) return { error: 'Choose how this source relates to the claim.' };
  const text = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim() : '';
  if (new TextEncoder().encode(text).length > 280) return { error: 'Keep the note to 280 bytes or fewer.' };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return { error: 'Remove control characters from the note.' };
  return { value: { url: canonical, stance: CONTRACT_STANCE[stance], note: text || null } };
}

/** Group items by stance, always returning every stance key in display order. */
export function groupByStance(items) {
  const groups = Object.fromEntries(STANCE_ORDER.map((stance) => [stance, []]));
  for (const item of items) groups[item.stance].push(item);
  return groups;
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function metaRow(label, valueHTML) {
  return `<div><dt>${escapeHTML(label)}</dt><dd>${valueHTML}</dd></div>`;
}

function itemMarkup(item) {
  const review = REVIEW_STATUSES[item.review_status];
  const heading = item.title || item.host;
  const subline = item.title ? `${item.host}${item.path}` : item.path;
  const contributor = item.submitted_by
    ? `<a href="${escapeHTML(EXPLORER + encodeURIComponent(item.submitted_by))}" target="_blank" rel="noopener noreferrer">${escapeHTML(item.submitted_by)}</a>${item.origin === 'contract-source' ? ' <span class="evidence-role">claim creator</span>' : ''}`
    : 'Unknown';
  const rows = [
    item.publisher ? metaRow('Publisher', escapeHTML(item.publisher)) : metaRow('Domain', escapeHTML(item.host)),
    item.author ? metaRow('Author', escapeHTML(item.author)) : '',
    item.published_at ? metaRow('Published', escapeHTML(formatDate(item.published_at))) : '',
    metaRow('Added by', contributor),
    metaRow('Added', item.submitted_at ? escapeHTML(formatDate(item.submitted_at)) : 'Not recorded'),
    metaRow('Review', `<span class="review-badge" data-status="${escapeHTML(item.review_status)}" title="${escapeHTML(review.hint)}">${escapeHTML(review.label)}</span>${item.reviewed_by ? ` by ${escapeHTML(item.reviewed_by)}` : ''}`),
  ].join('');
  return `<li class="evidence-item">
    <a class="evidence-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHTML(heading)}</span><span class="arrow" aria-hidden="true">↗</span></a>
    ${subline ? `<p class="evidence-path">${escapeHTML(subline)}</p>` : ''}
    ${item.description ? `<p class="evidence-description"><span class="evidence-note-label">Submitter's note</span> ${escapeHTML(item.description)}</p>` : ''}
    <dl class="evidence-meta">${rows}</dl>
  </li>`;
}

function groupMarkup(stance, items) {
  const { label, empty } = STANCES[stance];
  const id = `evidence-${stance.toLowerCase()}`;
  return `<section class="evidence-group" aria-labelledby="${id}">
    <h3 id="${id}"><span>${escapeHTML(label)}</span><span class="evidence-count">${items.length}</span></h3>
    ${items.length ? `<ul class="evidence-list">${items.map(itemMarkup).join('')}</ul>` : `<p class="evidence-empty">${escapeHTML(empty)}</p>`}
  </section>`;
}

/** Creator sources first, then submitted evidence, without duplicate URLs. */
export function allEvidence(fact, submitted = []) {
  const items = evidenceFromFact(fact);
  const seen = new Set(items.map((item) => item.url));
  for (const item of submitted) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    items.push(item);
  }
  return items;
}

/**
 * One-line evidence overview for the top of a fact page, so readers meet the evidence
 * before the market. Links down to the Evidence Room.
 */
export function evidenceSummaryMarkup(fact, submitted = []) {
  const groups = groupByStance(allEvidence(fact, submitted));
  const total = STANCE_ORDER.reduce((sum, stance) => sum + groups[stance].length, 0);
  if (!total) return '<p class="evidence-glance">No evidence yet · <a href="#evidence-title">Add a source ↓</a></p>';
  const parts = STANCE_ORDER
    .filter((stance) => stance !== 'CONTEXT' || groups.CONTEXT.length)
    .map((stance) => `${groups[stance].length} ${STANCES[stance].label.toLowerCase()}`);
  return `<p class="evidence-glance"><a href="#evidence-title">Evidence ↓</a> ${escapeHTML(parts.join(' · '))}</p>`;
}

function formMarkup(form) {
  if (!form.open) return `<p class="evidence-note evidence-closed">${escapeHTML(form.closedReason || 'Evidence submission is closed for this claim.')}</p>`;
  const choices = STANCE_ORDER.map((stance) => `<label class="stance-choice"><input type="radio" name="stance" value="${stance}" required /> ${escapeHTML(STANCES[stance].label)}</label>`).join('');
  return `<form id="evidence-form" class="evidence-form" novalidate>
    <h3>Add a source</h3>
    <label for="evidence-url">Link to the source</label>
    <input id="evidence-url" name="url" type="url" inputmode="url" autocomplete="off" placeholder="https://" maxlength="512" required />
    <fieldset><legend>How does it relate to the claim?</legend><div class="stance-choices">${choices}</div></fieldset>
    <label for="evidence-note">Note <span class="optional">optional, up to 280 characters</span></label>
    <textarea id="evidence-note" name="note" rows="3" maxlength="280"></textarea>
    <p class="field-help">Your wallet signs a NEAR testnet transaction with a ${escapeHTML(form.depositLabel || '0.01 NEAR')} storage deposit. Your account and the time are recorded with the source. Adding a source does not verify it.</p>
    <div class="form-actions"><button type="submit">${form.connected ? 'Submit source' : 'Connect wallet and submit'}</button></div>
    <p class="form-error" id="evidence-error" role="alert"></p>
  </form>`;
}

/**
 * HTML for the Evidence Room section of a fact page. All dynamic values are escaped.
 * options.submitted: normalised items from evidenceFromChain()
 * options.form: null to hide, or { open, closedReason, connected, depositLabel }
 */
export function renderEvidenceRoom(fact, { submitted = [], form = null } = {}) {
  const creatorItems = evidenceFromFact(fact);
  const items = allEvidence(fact, submitted);
  const groups = groupByStance(items);
  const rawCount = Array.isArray(fact?.sources) ? fact.sources.length : 0;
  const skipped = rawCount - creatorItems.length;
  // Context is optional in the layout: shown only when something is classified as context.
  const visible = STANCE_ORDER.filter((stance) => stance !== 'CONTEXT' || groups.CONTEXT.length);

  return `<section class="evidence-room" aria-labelledby="evidence-title">
    <p class="kicker">Evidence room</p>
    <h2 id="evidence-title">What the sources say</h2>
    <p class="evidence-lede">Sources are grouped by how they relate to the claim. A classification describes a source's position, not whether the claim is true. A review checks the source, not the conclusion.</p>
    <dl class="evidence-summary">${STANCE_ORDER.map((stance) => metaRow(STANCES[stance].label, String(groups[stance].length))).join('')}</dl>
    ${items.length
      ? visible.map((stance) => groupMarkup(stance, groups[stance])).join('')
      : '<p class="evidence-empty evidence-empty-all">No sources have been attached to this claim yet.</p>'}
    ${skipped > 0 ? `<p class="evidence-note">Not shown: ${skipped} source ${skipped === 1 ? 'entry' : 'entries'} that ${skipped === 1 ? 'is' : 'are'} not a valid https URL or ${skipped === 1 ? 'repeats' : 'repeat'} another source.</p>` : ''}
    ${creatorItems.length ? '<p class="evidence-note">Sources from the claim creator are stored on-chain as URLs only, so they have no classification. Titles and publishers are not shown because they have not been fetched or checked.</p>' : ''}
    ${form ? formMarkup(form) : ''}
  </section>`;
}
