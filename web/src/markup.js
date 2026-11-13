/* Markup shared by the deck card and the detail view. Every dynamic value goes through escapeHTML. */
import { escapeHTML } from './html.js';
import { odds } from './market.js';
import { stageOf } from './claims.js';
import { attestationProof, proofValid, EXPLORER } from './chain.js';

export const SEAL_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1l2 1.6 2.5-.2.9 2.4 2.1 1.4-.8 2.4.8 2.4-2.1 1.4-.9 2.4-2.5-.2L8 15l-2-1.6-2.5.2-.9-2.4L.5 9.8 1.3 7.4.5 5l2.1-1.4.9-2.4 2.5.2z" fill="currentColor"/><path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="#f1ead9" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function stageChip(fact) {
  const stage = stageOf(fact);
  return `<span class="chip chip-${stage.key}"><i aria-hidden="true"></i>${escapeHTML(stage.label)}</span>`;
}

/** Thin YES/NO bar. With no stakes it draws an empty track instead of inventing a 50/50 split. */
export function barMarkup(fact) {
  const { total, yesTenths, noTenths } = odds(fact.yes_pool, fact.no_pool);
  if (!total) return '<div class="bar bar-empty" role="img" aria-label="No stakes yet"><i></i></div>';
  return `<div class="bar" role="img" aria-label="YES ${yesTenths / 10} percent, NO ${noTenths / 10} percent"><i class="bar-yes" style="width:${yesTenths / 10}%"></i><i class="bar-no" style="width:${noTenths / 10}%"></i></div>`;
}

export function proofLinks() {
  if (!proofValid()) return '';
  return `<a class="proof-link proof-ok" href="${EXPLORER}/txns/${attestationProof.attestation_tx}" target="_blank" rel="noopener">Quote verified ↗</a><a class="proof-link proof-bad" href="${EXPLORER}/txns/${attestationProof.rejected_quote_tx}" target="_blank" rel="noopener">Flipped quote refused ↗</a>`;
}

/** The brass seal on a card. A button, so it opens the proof without starting a swipe. */
export function sealMarkup() {
  if (!proofValid()) return '';
  return `<button type="button" class="seal" aria-expanded="false" aria-controls="seal-pop">${SEAL_ICON}<span>Resolved by an attested AI arbiter</span></button>`;
}

export function sealPopMarkup() {
  if (!proofValid()) return '';
  const registryUrl = `${EXPLORER}/address/${encodeURIComponent(attestationProof.registry)}`;
  return `<div class="seal-pop" id="seal-pop" hidden>
    <p class="seal-pop-head">${SEAL_ICON}<span>Sworn registry on NEAR</span></p>
    <p>The enclave quote for <code>${escapeHTML(attestationProof.model_id)}</code> is verified on chain before any market settles. Flip one byte and the registry refuses it.</p>
    <div class="proof-links">${proofLinks()}<a class="proof-link" href="${registryUrl}" target="_blank" rel="noopener">Registry ↗</a></div>
  </div>`;
}
