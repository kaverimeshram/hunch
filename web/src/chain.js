/*
 * Chain access shared by every view: contract choice, NEAR RPC reads, the wallet connector and the
 * static data files. Nothing here touches the DOM.
 */
import { NearConnector } from '@hot-labs/near-connect';
import { parseContractJson } from './market.js';

export const RPC = 'https://near-testnet.drpc.org';
// The relayer Worker: relays chain reads (so the page never depends on a third-party CORS header) and signs sponsored
// testnet stakes for visitors who have no wallet.
export const RELAYER = (import.meta.env.VITE_HUNCH_RELAYER || 'https://near-hunch.nearbuild.workers.dev').replace(/\/$/, '');
export const EXPLORER = 'https://testnet.nearblocks.io';
export const GAS = { stake: '30000000000000', evidence: '30000000000000', claim: '50000000000000', void: '30000000000000' };
export const DEFAULT_EVIDENCE_DEPOSIT = '10000000000000000000000';
export const DEFAULT_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const json = (path, fallback) => fetch(path).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);
const [indexedFacts_, generatedPages_, attestationProof_, resolutionData, snapshot_] = await Promise.all([
  json('/facts.json', []), json('/generated-pages.json', {}), json('/attestation-proof.json', null), json('/resolutions.json', null), json('/facts-snapshot.json', null),
]);
export const indexedFacts = indexedFacts_;
export const generatedPages = generatedPages_;
export const attestationProof = attestationProof_;
/** The last chain read taken at deploy time: lets the first card paint before any RPC answers. */
export const factsSnapshot = snapshot_;

export const query = new URLSearchParams(location.search);
// Contract to read: ?contract=..., then the visitor's last choice, then the deployment default
// (VITE_HUNCH_CONTRACT, set at build time, e.g. in Vercel's environment variables).
export const contract = query.get('contract') || localStorage.getItem('hunch-contract') || localStorage.getItem('truthpage-contract') || import.meta.env.VITE_HUNCH_CONTRACT || 'hunch-c-261113191249-82174.testnet';

/** Transaction links for a settled claim, only when the file was written for the contract this page reads. */
export const resolutionLinks = (id) => (resolutionData?.contract === contract ? resolutionData.facts?.[id] || null : null);

export const proofValid = () => attestationProof?.status === 'verified-and-refused' && /^[A-Za-z0-9]+$/.test(attestationProof.attestation_tx || '') && /^[A-Za-z0-9]+$/.test(attestationProof.rejected_quote_tx || '');

// ---------- NEAR RPC ----------

async function rpcCall(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`NEAR testnet RPC returned ${response.status}.`);
  const result = await response.json();
  if (result.error && !result.result) throw Object.assign(new Error('rpc'), { transient: true, detail: result });
  return result;
}

export async function view(method, args) {
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'hunch', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: argsBase64 } });
  let result;
  try { result = await rpcCall(`${RELAYER}/api/rpc`, body); } catch { result = await rpcCall(RPC, body); }
  const error = result.error || result.result?.error;
  if (error) {
    const text = typeof error === 'string' ? error : JSON.stringify(error ?? '');
    const failure = new Error(/MethodNotFound/.test(text) ? `This contract does not support ${method}.` : (result.error?.cause?.name || 'NEAR testnet rejected the view call.'));
    failure.missingMethod = /MethodNotFound/.test(text);
    throw failure;
  }
  return parseContractJson(new TextDecoder().decode(new Uint8Array(result.result.result)));
}

/** A view that older contract versions may not have. Returns `fallback` if the method is missing. */
export async function optionalView(method, args, fallback) {
  try { return await view(method, args); } catch (error) { if (error.missingMethod) return fallback; throw error; }
}

// ---------- Wallet ----------

// HOT Wallet declares no testnet support (its executor throws "HOT Wallet not supported on testnet"),
// so the connector's manifest filter lists only wallets that can sign here.
const connector = new NearConnector({ network: 'testnet', features: { signAndSendTransaction: true } });
let wallet = null;
let account = '';
const listeners = new Set();

export const accountId = () => account;
export const onAccount = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const setAccount = (next) => { account = next; listeners.forEach((fn) => fn(account)); };

export const walletReady = (async () => {
  try {
    const connected = await connector.getConnectedWallet();
    wallet = connected.wallet;
    setAccount(connected.accounts[0]?.accountId || '');
  } catch { wallet = null; setAccount(''); }
})();

export async function ensureWallet() {
  if (wallet && account) return wallet;
  wallet = await connector.connect();
  const id = (await wallet.getAccounts())[0]?.accountId || '';
  if (!id) throw new Error('The connected wallet did not return an account.');
  setAccount(id);
  return wallet;
}

export async function disconnectWallet() {
  await connector.disconnect(wallet);
  wallet = null;
  setAccount('');
}

export async function callContract(methodName, args, deposit, gas) {
  const signer = await ensureWallet();
  return signer.signAndSendTransaction({ receiverId: contract, actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit } }] });
}

/** Closing or rejecting the wallet popup is a normal choice, not an error. */
export const walletCancelled = (error) => /closed|cancel|reject|denied/i.test(error?.message || '');


// ---------- Sponsored stake desk ----------

export function visitorToken() {
  try {
    let token = localStorage.getItem('hunch-visitor');
    if (!token) { token = crypto.randomUUID().replace(/-/g, ''); localStorage.setItem('hunch-visitor', token); }
    return token;
  } catch { return `session${Math.random().toString(36).slice(2, 12)}`; }
}

let deskPromise = null;
/** The desk is offered only when it signs for the contract this page is reading and still has testnet funds. */
export function deskStatus() {
  deskPromise ??= fetch(`${RELAYER}/api/status?visitor=${visitorToken()}`, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => (s && s.funded && s.contract === contract ? s : null))
    .catch(() => null);
  return deskPromise;
}

/** One real testnet stake signed by the judge desk account. Resolves with the transaction and timing. */
export async function deskStake(fact, side, amount) {
  const response = await fetch(`${RELAYER}/api/stake`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-visitor': visitorToken() }, body: JSON.stringify({ fact, side, amount }), signal: AbortSignal.timeout(60000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `The judge desk answered ${response.status}.`), { wallet: Boolean(body.wallet) });
  return body;
}
