import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const output = resolve(process.argv[2] || 'web/attestation-proof.json');
const api = process.env.SWORN_CATCH_API || 'https://sworn-12d.pages.dev/api/catch';
const registry = 'sworn-reg7-1113.testnet';
const model = 'Qwen/Qwen3.6-35B-A3B-FP8';
const otherModel = 'Qwen/Qwen3.8-27B';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function post(action, body = {}) {
  let failure;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(`${api}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (response.ok) return result;
    failure = new Error(`Sworn ${action} returned HTTP ${response.status}: ${result.error || 'request failed'}`);
    if (![429, 502, 503].includes(response.status)) throw failure;
    await sleep(10_000 * (attempt + 1));
  }
  throw failure;
}

async function report(modelId, nonce) {
  const url = new URL('https://cloud-api.near.ai/v1/attestation/report');
  url.search = new URLSearchParams({ model: modelId, signing_algo: 'ed25519', nonce }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`NEAR AI attestation report returned HTTP ${response.status}`);
  const body = await response.json();
  const matches = (body.model_attestations || []).filter((entry) => entry.model_name === modelId);
  if (matches.length !== 1 || !/^[0-9a-f]+$/i.test(matches[0].intel_quote || '')) throw new Error(`report did not contain one valid quote for ${modelId}`);
  return matches[0];
}

async function rpc(method, params) {
  let last;
  for (const url of ['https://near-testnet.drpc.org', 'https://test.rpc.fastnear.com']) {
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'hunch-proof', method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || 'RPC query failed');
      return body.result;
    } catch (error) { last = error; }
  }
  throw new Error(`testnet RPC unavailable: ${last?.message || 'no provider answered'}`);
}

async function txStatus(hash, signer) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const result = await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: signer, wait_until: 'NONE' });
      const status = result.status || {};
      if (status.Failure) return { state: 'Failure', reason: JSON.stringify(status.Failure) };
      if (status.SuccessValue !== undefined || status.SuccessReceiptId) return { state: 'Success' };
    } catch { /* The next RPC read retries an unindexed transaction. */ }
    await sleep(2000);
  }
  throw new Error(`transaction ${hash} did not reach a terminal status before timeout`);
}

if (process.argv.includes('--verify-existing')) {
  const stored = JSON.parse(await readFile(output, 'utf8'));
  const [accepted, second, refusedOnChain] = await Promise.all([
    txStatus(stored.attestation_tx, stored.sponsor), txStatus(stored.second_model_attestation_tx, stored.sponsor), txStatus(stored.rejected_quote_tx, stored.sponsor),
  ]);
  if (accepted.state !== 'Success' || second.state !== 'Success' || refusedOnChain.state !== 'Failure') throw new Error('stored Sworn proof does not match the chain');
  console.log(`PROOF_REVERIFIED ${stored.attestation_tx} ${stored.rejected_quote_tx}`);
  process.exit(0);
}

const nonce = await post('nonce');
if (!/^[a-z0-9._-]+\.testnet$/.test(nonce.sponsor || '') || !/^[0-9a-f]{64}$/.test(nonce.nonce || '') || !/^[A-Za-z0-9]+$/.test(nonce.tx || '')) throw new Error('Sworn did not issue a valid testnet nonce transaction and sponsor');
const [entry, other] = await Promise.all([report(model, nonce.nonce), report(otherModel, nonce.nonce)]);
const attested = await post('forge', { id: 'attest', model, entry, other });
if (attested.outcome !== 'ATTESTED' || !Array.isArray(attested.txs) || attested.txs.length !== 2) throw new Error('Sworn did not attest both live model quotes');
const quoteHash = createHash('sha256').update(Buffer.from(entry.intel_quote, 'hex')).digest('hex');
const attestations = await rpc('query', {
  request_type: 'call_function', finality: 'final', account_id: registry, method_name: 'get_attestations',
  args_base64: Buffer.from(JSON.stringify({ account_id: nonce.sponsor })).toString('base64'),
});
if (attestations.error) throw new Error('Sworn registry could not confirm the attested quote');
const stored = JSON.parse(Buffer.from(attestations.result).toString('utf8'));
if (!stored.some((item) => item.quote_sha256 === quoteHash && item.tcb_status === 'UpToDate')) throw new Error('Sworn registry did not store the verified live quote');

const refused = await post('forge', { id: 'quote-bit', model, entry, other });
if (refused.outcome !== 'REFUSED' || refused.step !== 'attest_quote' || !refused.tx) throw new Error('Sworn did not return an on-chain refusal transaction for the flipped quote');
const [acceptedStatus, refusedStatus] = await Promise.all([
  txStatus(attested.txs[0], nonce.sponsor), txStatus(refused.tx, nonce.sponsor),
]);
if (acceptedStatus.state !== 'Success' || refusedStatus.state !== 'Failure') throw new Error('Sworn quote transactions did not finish with the expected success and refusal');

const proof = {
  registry, sponsor: nonce.sponsor, model_id: model, quote_sha256: quoteHash, nonce_tx: nonce.tx, attestation_tx: attested.txs[0],
  second_model_attestation_tx: attested.txs[1], rejected_quote_tx: refused.tx,
  refusal_reason: refused.reason, status: 'verified-and-refused',
};
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.tmp`;
await writeFile(temporary, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o644 });
await rename(temporary, output);
console.log(`NONCE_TX ${nonce.tx}`);
console.log(`QUOTE_VERIFIED ${attested.txs[0]}`);
console.log(`SECOND_QUOTE_VERIFIED ${attested.txs[1]}`);
console.log(`QUOTE_REFUSED ${refused.tx}`);
