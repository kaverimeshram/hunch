/*
 * Stake history read from chain data: NearBlocks lists the contract's transactions and each
 * `stake` call is decoded for its fact id, side and deposit. Pure helpers are exported for tests;
 * fetchStakeHistory does the I/O. Nothing here is estimated or filled in.
 */
import { toBigInt, odds } from './market.js';

const NEARBLOCKS_API = 'https://api-testnet.nearblocks.io/v3';
const MAX_PAGES = 20;
const cacheKey = (hash) => `hunch-stake-tx:${hash}`;

/** Stake events inside one transaction detail. Failed transactions yield nothing. */
export function stakeEventsFromTx(tx) {
  if (!tx?.outcomes?.status) return [];
  const at = Math.floor(Number(BigInt(tx.block_timestamp) / 1000000n));
  return (tx.actions || [])
    .filter((action) => action.method === 'stake' && action.args?.args_json?.id && /^(Yes|No)$/.test(action.args.args_json.side))
    .map((action) => ({ factId: action.args.args_json.id, side: action.args.args_json.side, amount: toBigInt(action.args.deposit), account: tx.signer_account_id, at, hash: tx.transaction_hash }));
}

/** Cumulative pools after each stake for one fact, oldest first. */
export function seriesFor(events, factId) {
  let yes = 0n;
  let no = 0n;
  return events
    .filter((event) => event.factId === factId)
    .sort((a, b) => a.at - b.at)
    .map((event) => {
      if (event.side === 'Yes') yes += event.amount; else no += event.amount;
      return { ...event, yes, no, yesTenths: odds(yes, no).yesTenths };
    });
}

/** The replayed history must land exactly on the contract's pools, otherwise it is incomplete. */
export function reconciles(series, fact) {
  const last = series[series.length - 1];
  return (last?.yes ?? 0n) === toBigInt(fact.yes_pool) && (last?.no ?? 0n) === toBigInt(fact.no_pool);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw Object.assign(new Error(`NearBlocks returned ${response.status}.`), { status: response.status });
  return response.json();
}

/** Every successful stake call on `contract`, across all facts. */
export async function fetchStakeHistory(contract, { getJson: get = getJson, storage = globalThis.localStorage } = {}) {
  const hashes = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const list = await get(`${NEARBLOCKS_API}/accounts/${encodeURIComponent(contract)}/txns?limit=100${cursor ? `&next=${encodeURIComponent(cursor)}` : ''}`);
    for (const tx of list.data || []) {
      if (tx.receiver_account_id === contract && tx.outcomes?.status && tx.actions?.some((a) => a.method === 'stake')) hashes.push(tx.transaction_hash);
    }
    cursor = list.meta?.next_page || '';
    if (!cursor) break;
    if (page === MAX_PAGES - 1) throw new Error('Contract history is longer than the page limit.');
  }
  const details = await Promise.all(hashes.map(async (hash) => {
    const cached = storage?.getItem(cacheKey(hash));
    if (cached) return JSON.parse(cached);
    const { data } = await get(`${NEARBLOCKS_API}/txns/${encodeURIComponent(hash)}`);
    const events = stakeEventsFromTx(data).map((e) => ({ ...e, amount: e.amount.toString() }));
    storage?.setItem(cacheKey(hash), JSON.stringify(events));
    return events;
  }));
  return details.flat().map((e) => ({ ...e, amount: BigInt(e.amount) }));
}

const listCacheKey = (contract) => `hunch-stake-history:${contract}`;
const HISTORY_TTL_MS = 2 * 60 * 1000;
const inflight = new Map();

/**
 * Stake history for the detail view. A copy younger than two minutes is reused, concurrent callers
 * share one fetch, and when NearBlocks refuses (429 or any failure) the last stored copy is returned
 * with `stale: true`. Chart code still reconciles the events against the contract's pools, so a stale
 * copy that no longer matches draws nothing. With nothing stored the original error is thrown.
 */
export async function cachedStakeHistory(contract, { fetcher = fetchStakeHistory, storage = globalThis.localStorage, now = Date.now() } = {}) {
  let stored = null;
  try { stored = JSON.parse(storage?.getItem(listCacheKey(contract)) || 'null'); } catch { stored = null; }
  const revive = (events) => events.map((e) => ({ ...e, amount: BigInt(e.amount) }));
  if (stored && now - stored.at < HISTORY_TTL_MS) return { events: revive(stored.events), stale: false };
  if (!inflight.has(contract)) inflight.set(contract, fetcher(contract).finally(() => inflight.delete(contract)));
  try {
    const events = await inflight.get(contract);
    storage?.setItem(listCacheKey(contract), JSON.stringify({ at: now, events: events.map((e) => ({ ...e, amount: e.amount.toString() })) }));
    return { events, stale: false };
  } catch (error) {
    if (stored) return { events: revive(stored.events), stale: true };
    throw error;
  }
}

/** Drop the stored copy, for example right after the visitor stakes. */
export const forgetStakeHistory = (contract, storage = globalThis.localStorage) => storage?.removeItem(listCacheKey(contract));
