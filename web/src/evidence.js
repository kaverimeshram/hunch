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
 * Today the contract stores each claim's sources as bare https URLs added by the
 * claim's creator (Fact.sources). Those become UNCLASSIFIED, PENDING items. The
 * record shape below already matches the planned on-chain evidence model, so
 * submitted evidence can flow through normalizeEvidence() unchanged later.
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
    metaRow('Review', `<span class="review-badge" data-status="${escapeHTML(item.review_status)}" title="${escapeHTML(review.hint)}">${escapeHTML(review.label)}</span>`),
  ].join('');
  return `<li class="evidence-item">
    <a class="evidence-link" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHTML(heading)}</span><span class="arrow" aria-hidden="true">↗</span></a>
    ${subline ? `<p class="evidence-path">${escapeHTML(subline)}</p>` : ''}
    ${item.description ? `<p class="evidence-description">${escapeHTML(item.description)}</p>` : ''}
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

/** HTML for the Evidence Room section of a fact page. All dynamic values are escaped. */
export function renderEvidenceRoom(fact) {
  const items = evidenceFromFact(fact);
  const groups = groupByStance(items);
  const rawCount = Array.isArray(fact?.sources) ? fact.sources.length : 0;
  const skipped = rawCount - items.length;
  // Context is optional in the layout: shown only when something is classified as context.
  const visible = STANCE_ORDER.filter((stance) => stance !== 'CONTEXT' || groups.CONTEXT.length);
  const allFromContract = items.length > 0 && items.every((item) => item.origin === 'contract-source');

  return `<section class="evidence-room" aria-labelledby="evidence-title">
    <p class="kicker">Evidence room</p>
    <h2 id="evidence-title">What the sources say</h2>
    <p class="evidence-lede">Sources are grouped by how they relate to the claim. A classification describes a source's position, not whether the claim is true. A review checks the source, not the conclusion.</p>
    <dl class="evidence-summary">${STANCE_ORDER.map((stance) => metaRow(STANCES[stance].label, String(groups[stance].length))).join('')}</dl>
    ${items.length
      ? visible.map((stance) => groupMarkup(stance, groups[stance])).join('')
      : '<p class="evidence-empty evidence-empty-all">No sources have been attached to this claim yet.</p>'}
    ${skipped > 0 ? `<p class="evidence-note">Not shown: ${skipped} source ${skipped === 1 ? 'entry' : 'entries'} that ${skipped === 1 ? 'is' : 'are'} not a valid https URL or ${skipped === 1 ? 'repeats' : 'repeat'} another source.</p>` : ''}
    ${allFromContract ? '<p class="evidence-note">These sources were attached by the claim creator and are stored on-chain as URLs only, so they have no classification yet. Titles and publishers are not shown because they have not been fetched or checked.</p>' : ''}
  </section>`;
}
