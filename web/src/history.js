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
  if (!response.ok) throw new Error(`NearBlocks returned ${response.status}.`);
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
