// `npm run judge`: every claim the README makes, checked against the live URL, the live relayer and NEAR testnet.
// Exit 0 only when every check passes. No wallet, no keys, no NEAR needed. Add --stake to also place one real sponsored stake.
import { readFileSync } from 'node:fs';

const SITE = process.env.HUNCH_URL || 'https://hunch-near.vercel.app';
const RELAYER = process.env.HUNCH_RELAYER || 'https://near-hunch.earn-shield-alerts.workers.dev';
const evidence = JSON.parse(readFileSync(new URL('../docs/deployment.json', import.meta.url), 'utf8'));
const CONTRACT = evidence.contract;
const results = [];

async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, ok: true, detail }); console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`FAIL  ${name}  (${error.message})`); }
}

async function rpc(method, params) {
  let last = 'no answer';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`${RELAYER}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
    const body = await res.json().catch(() => ({}));
    if (body.result) return body.result;
    last = JSON.stringify(body.error ?? body).slice(0, 120);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(last);
}
const view = async (method, args) => {
  const out = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  if (out.error) throw new Error(out.error.slice(0, 100));
  return JSON.parse(Buffer.from(out.result).toString('utf8'));
};
const txSucceeded = async (hash, signer) => {
  const out = await rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' });
  const failed = out.status?.Failure || out.receipts_outcome?.some((r) => r.outcome.status?.Failure);
  if (failed) throw new Error('transaction failed');
  return out;
};

await check('live site serves the swipe deck', async () => {
  const html = await (await fetch(SITE)).text();
  if (!/Swipe a claim, stake NEAR/.test(html)) throw new Error('title missing');
  const js = html.match(/assets\/main-[A-Za-z0-9_-]+\.js/)?.[0];
  if (!js) throw new Error('bundle missing');
  return js;
});
await check('link card: og tags and a 1200x630 image served from the live origin', async () => {
  const html = await (await fetch(SITE)).text();
  const image = html.match(/property="og:image" content="([^"]+)"/)?.[1];
  if (!image || !/twitter:card" content="summary_large_image"/.test(html) || !/property="og:title"/.test(html)) throw new Error('og or twitter tags missing');
  const res = await fetch(image);
  const type = res.headers.get('content-type') || '';
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !type.startsWith('image/')) throw new Error(`image ${res.status} ${type}`);
  if (bytes.readUInt32BE(16) !== 1200 || bytes.readUInt32BE(20) !== 630) throw new Error('image is not 1200x630');
  return `${image.split('/').pop()} ${type}`;
});
await check('the first card paints from the deploy snapshot of the contract', async () => {
  const snapshot = await (await fetch(`${SITE}/facts-snapshot.json`)).json();
  if (snapshot.contract !== CONTRACT || !snapshot.facts?.length) throw new Error('snapshot does not match the contract');
  return `${snapshot.facts.length} claims at block ${snapshot.block_height}`;
});
await check('sponsored stake desk is funded and signs for this contract', async () => {
  const status = await (await fetch(`${RELAYER}/api/status?visitor=judge-check-0001`)).json();
  if (!status.funded || status.contract !== CONTRACT) throw new Error(JSON.stringify(status));
  return status.account;
});
await check('contract code hash matches the recorded deployment', async () => {
  const account = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: CONTRACT });
  if (account.code_hash !== evidence.code_hash) throw new Error(`got ${account.code_hash}`);
  return account.code_hash.slice(0, 12);
});
await check('the seeded claims are on chain', async () => {
  for (const id of evidence.claims) if (!(await view('get_fact', { id }))) throw new Error(`${id} missing`);
  return `${evidence.claims.length} claims`;
});
await check('an open claim holds real stakes', async () => {
  const fact = await view('get_fact', { id: 'patoshi-one-million-btc' });
  if (fact.status !== 'Open' || BigInt(fact.yes_pool) + BigInt(fact.no_pool) === 0n) throw new Error(fact.status);
  return `${fact.stakers} stakers`;
});
await check('a claim settled through the Sworn registry', async () => {
  const fact = await view('get_fact', { id: evidence.settled.claim });
  if (fact.status !== 'Resolved' || fact.outcome !== evidence.settled.outcome || !fact.reasoning) throw new Error(`${fact.status} ${fact.outcome}`);
  return `${fact.id} resolved ${fact.outcome}`;
});
await check('resolution transaction succeeded on testnet', async () => { await txSucceeded(evidence.settled.resolve_tx, evidence.arbiter); return evidence.settled.resolve_tx.slice(0, 10); });
await check('winner payout transaction succeeded on testnet', async () => { await txSucceeded(evidence.settled.claim_tx, evidence.settled.claimer); return evidence.settled.claim_tx.slice(0, 10); });
await check('sponsored stake transaction succeeded on testnet', async () => { await txSucceeded(evidence.sponsored_stake_tx, evidence.judge_account); return evidence.sponsored_stake_tx.slice(0, 10); });
await check('the desk refuses a request with no visitor token', async () => {
  const res = await fetch(`${RELAYER}/api/stake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fact: 'patoshi-one-million-btc', side: 'Yes' }) });
  if (res.status !== 400) throw new Error(`status ${res.status}`);
});
if (process.argv.includes('--stake')) {
  await check('a fresh visitor places a real sponsored stake', async () => {
    const token = `judge${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${RELAYER}/api/stake`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-visitor': token }, body: JSON.stringify({ fact: 'ethereum-flips-bitcoin-2027', side: 'No' }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    await txSucceeded(body.tx, body.account);
    return `${body.explorer} in ${body.seconds}s`;
  });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
