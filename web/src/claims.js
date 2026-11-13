/* Claim presentation helpers: stage, price text, dates, deck order. Pure, no DOM, no network. */
import { odds, cents, toBigInt } from './market.js';

export const volumeOf = (fact) => toBigInt(fact.yes_pool) + toBigInt(fact.no_pool);

/** Open and Awaiting resolution both come from `status: Open`; the close time tells them apart. */
export function stageOf(fact, nowMs = Date.now()) {
  switch (fact.status) {
    case 'Resolved': return { key: 'resolved', label: `Resolved ${fact.outcome === 'Yes' ? 'YES' : 'NO'}`, attested: true };
    case 'Void': return { key: 'void', label: 'Void, refundable', attested: false };
    case 'Pending': return { key: 'awaiting', label: 'Verifying quote', attested: false };
    default: return Number(fact.resolve_after) > nowMs ? { key: 'open', label: 'Open', attested: false } : { key: 'awaiting', label: 'Awaiting resolution', attested: false };
  }
}

export function priceTexts(fact) {
  const { total, yesTenths, noTenths } = odds(fact.yes_pool, fact.no_pool);
  return { total, yesTenths, noTenths, yesPct: total ? `${Math.round(yesTenths / 10)}%` : '-', yesCents: total ? `${cents(yesTenths)}¢` : '-', noCents: total ? `${cents(noTenths)}¢` : '-' };
}

const STAGE_ORDER = { open: 0, awaiting: 1, resolved: 2, void: 3 };

/** Deck order: markets that take stakes first (soonest close first), then the rest by volume. */
export function deckOrder(facts, nowMs = Date.now()) {
  return [...facts].sort((a, b) => {
    const [sa, sb] = [stageOf(a, nowMs).key, stageOf(b, nowMs).key];
    if (sa !== sb) return STAGE_ORDER[sa] - STAGE_ORDER[sb];
    if (sa === 'open') return Number(a.resolve_after) - Number(b.resolve_after);
    const diff = volumeOf(b) - volumeOf(a);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });
}

const date = (ms, opts) => new Date(Number(ms)).toLocaleString('en-GB', { ...opts, timeZone: 'UTC' });
export const formatTime = (ms) => `${date(ms, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC`;
export const formatDay = (ms) => date(ms, { day: 'numeric', month: 'short', year: 'numeric' });
export const formatShortDay = (ms) => date(ms, { day: 'numeric', month: 'short' });

export function shortHash(value) {
  const text = String(value || '');
  return text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text;
}

export function shortAccount(value) {
  const text = String(value || '');
  return text.length > 24 ? `${text.slice(0, 10)}…${text.slice(-10)}` : text;
}
