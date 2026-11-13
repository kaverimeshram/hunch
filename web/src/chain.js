/*
 * Chain access shared by every view: contract choice, NEAR RPC reads, the wallet connector and the
 * static data files. Nothing here touches the DOM.
 */
import { NearConnector } from '@hot-labs/near-connect';
import { parseContractJson } from './market.js';

export const RPC = 'https://near-testnet.drpc.org';
export const EXPLORER = 'https://testnet.nearblocks.io';
export const GAS = { stake: '30000000000000', evidence: '30000000000000', claim: '50000000000000', void: '30000000000000' };
export const DEFAULT_EVIDENCE_DEPOSIT = '10000000000000000000000';
export const DEFAULT_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const json = (path, fallback) => fetch(path).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);
export const indexedFacts = await json('/facts.json', []);
export const generatedPages = await json('/generated-pages.json', {});
export const attestationProof = await json('/attestation-proof.json', null);

export const query = new URLSearchParams(location.search);
// Contract to read: ?contract=..., then the visitor's last choice, then the deployment default
// (VITE_HUNCH_CONTRACT, set at build time, e.g. in Vercel's environment variables).
export const contract = query.get('contract') || localStorage.getItem('hunch-contract') || localStorage.getItem('truthpage-contract') || import.meta.env.VITE_HUNCH_CONTRACT || 'hunch-c-261113191249-82174.testnet';

export const proofValid = () => attestationProof?.status === 'verified-and-refused' && /^[A-Za-z0-9]+$/.test(attestationProof.attestation_tx || '') && /^[A-Za-z0-9]+$/.test(attestationProof.rejected_quote_tx || '');

// ---------- NEAR RPC ----------

export async function view(method, args) {
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  const response = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'hunch', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: argsBase64 } }) });
  if (!response.ok) throw new Error(`NEAR testnet RPC returned ${response.status}.`);
  const result = await response.json();
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
