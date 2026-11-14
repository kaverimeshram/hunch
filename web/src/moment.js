/*
 * The moment after a stake lands: how far the stake moved the market, the text the visitor shares,
 * and the rows of the positions drawer. Pure so each number is testable against fact objects.
 */
import { odds, nearAmount, toBigInt, payoutFor } from './market.js';

const SIDE = { Yes: 'YES', No: 'NO' };

/** The chosen side's share of the pool in tenths of a percent (921 is 92.1%), or null while the pool is empty. */
export function sideTenths(fact, side) {
  const { total, yesTenths, noTenths } = odds(fact.yes_pool, fact.no_pool);
  if (!total) return null;
  return side === 'Yes' ? yesTenths : noTenths;
}

/** The share as a whole percent, for the card and the positions list. */
export const sidePercent = (fact, side) => { const t = sideTenths(fact, side); return t === null ? null : Math.round(t / 10); };

/** 921 -> "92.1%", 920 -> "92%". A small stake moves the price by tenths, so the mover shows them. */
export const pct = (tenths) => (tenths % 10 === 0 ? `${tenths / 10}%` : `${(tenths / 10).toFixed(1)}%`);

/** What a stake did to the odds. `before` and `after` are fact objects read from the contract. */
export function moveOf(before, after, side, amountRaw) {
  const from = sideTenths(before, side);
  const to = sideTenths(after, side);
  const name = SIDE[side];
  const amount = nearAmount(amountRaw);
  let text;
  if (to === null) text = `Your ${amount} is on ${name}.`;
  else if (from === null) text = `Your ${amount} opened the market at ${pct(to)} ${name}.`;
  else if (from === to) text = `Your ${amount} holds ${name} at ${pct(to)}.`;
  else text = `Your ${amount} moved ${name} from ${pct(from)} to ${pct(to)}.`;
  return { from, to, name, text };
}

export const claimUrl = (origin, id) => `${origin}/#${encodeURIComponent(id)}`;

/** The post a visitor sends from the receipt: the outcome of their stake and the transaction. `percent` and `from` are tenths. */
export function sharePost({ fact, side, percent, from, amountRaw, tx, explorer, origin }) {
  const name = SIDE[side];
  const lead = percent === null ? `I staked ${nearAmount(amountRaw)} on ${name}` : `I'm ${pct(percent)} ${name}`;
  const moved = from !== null && percent !== null && from !== percent ? ` My ${nearAmount(amountRaw)} moved it from ${pct(from)} to ${pct(percent)}.` : '';
  const claim = fact.claim.length > 110 ? `${fact.claim.slice(0, 107)}...` : fact.claim;
  const proof = tx ? ` ${explorer}/txns/${encodeURIComponent(tx)}` : '';
  return { text: `${lead} on "${claim}"${moved} Real stake on NEAR testnet.${proof}`, url: claimUrl(origin, fact.id) };
}

export const intentUrl = ({ text, url }) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

/** Payout if the visitor's side wins, at the pools as they stand now. */
export function payoutIfRight(fact, side, yocto) {
  const stake = toBigInt(yocto);
  if (stake <= 0n) return 0n;
  const pools = { status: 'Resolved', outcome: side, yes_pool: fact.yes_pool, no_pool: fact.no_pool };
  return payoutFor(pools, side === 'Yes' ? stake : 0n, side === 'No' ? stake : 0n);
}

/** One row per claim the visitor staked on, newest first, with the live odds and the settled result. */
export function positionRows(facts, swipes) {
  const rows = [];
  for (const fact of facts) {
    const swipe = swipes[fact.id];
    if (!swipe || swipe.kind !== 'staked' || !swipe.side) continue;
    const settled = fact.status === 'Resolved' && fact.outcome ? (fact.outcome === swipe.side ? 'won' : 'lost') : fact.status === 'Void' ? 'void' : 'open';
    rows.push({
      fact, side: swipe.side, name: SIDE[swipe.side], amount: swipe.amount || '', tx: swipe.tx || null, at: swipe.at || 0, settled,
      percent: sidePercent(fact, swipe.side),
      payout: swipe.yocto ? payoutIfRight(fact, swipe.side, swipe.yocto) : null,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}
