// Writes web/facts-snapshot.json: every claim on the contract as the chain shows it now, so the deck paints its first card
// from a static file and refreshes from NEAR testnet a moment later. Run before a deploy: `node scripts/snapshot-facts.mjs`.
import { readFileSync, writeFileSync } from 'node:fs';

const deployment = JSON.parse(readFileSync(new URL('../docs/deployment.json', import.meta.url), 'utf8'));
const contract = process.env.HUNCH_CONTRACT || deployment.contract;
const RPCS = [process.env.HUNCH_RPC, 'https://near-testnet.drpc.org', 'https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'].filter(Boolean);

async function rpc(method, params) {
  let last = 'no RPC answered';
  for (const url of RPCS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const body = await res.json();
      if (body.result && !body.result.error) return body.result;
      last = JSON.stringify(body.error ?? body.result).slice(0, 160);
    } catch (error) { last = error.message; }
  }
  throw new Error(last);
}
const view = async (method, args) => {
  const out = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(out.result).toString('utf8'));
};

const index = JSON.parse(readFileSync(new URL('../web/facts.json', import.meta.url), 'utf8'));
const facts = [];
for (const { id } of index) { const fact = await view('get_fact', { id }); if (fact) facts.push(fact); }
if (!facts.length) throw new Error('the contract returned no claims; refusing to write an empty snapshot');
const status = await rpc('status', []);
writeFileSync(new URL('../web/facts-snapshot.json', import.meta.url), `${JSON.stringify({ contract, block_height: status.sync_info.latest_block_height, read_at: new Date().toISOString(), facts }, null, 2)}\n`);
console.log(`snapshot: ${facts.length} claims at block ${status.sync_info.latest_block_height}`);
