// Fetch every evidence source of a Hunch contract and write an evidence bundle.
//
//   node scripts/fetch-evidence.mjs <contract.testnet> [output.json]
//
// Default output: web/evidence-bundles/<contract>.json, which the web app reads to show
// each source's title, publisher, date, excerpt and fingerprints. Page metadata is
// reported as the page states it and is not verified. Excerpts are capped (~1,500
// characters) so the bundle never republishes whole articles.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalUrl, fetchSource, sha256Hex } from './lib/extract.mjs';

const [contract, outputArg] = process.argv.slice(2);
if (!contract || !/^[a-z0-9._-]{2,64}$/.test(contract)) throw new Error('usage: node scripts/fetch-evidence.mjs <contract-account> [output.json]');
const output = resolve(outputArg || `web/evidence-bundles/${contract}.json`);
const rpc = process.env.HUNCH_RPC || process.env.TRUTHPAGE_RPC || 'https://near-testnet.drpc.org';
const delayMs = Number(process.env.HUNCH_FETCH_DELAY_MS ?? 1000);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function view(method, args) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'hunch-evidence', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await response.json();
  const error = json.error || json.result?.error;
  if (error) {
    const text = typeof error === 'string' ? error : JSON.stringify(error);
    if (/MethodNotFound/.test(text)) return undefined;
    throw new Error(`NEAR RPC failed while reading ${method}`);
  }
  if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status} for ${method}`);
  return JSON.parse(Buffer.from(json.result.result).toString('utf8'));
}

async function factIds() {
  const ids = new Set();
  const config = await view('get_config', {});
  if (config) {
    for (let from = 0; from < config.fact_count; from += 50) {
      for (const fact of await view('list_facts', { from_index: from, limit: 50 })) ids.add(fact.id);
    }
  }
  // Facts created before list_facts existed are only listed in the static index.
  const indexed = JSON.parse(await readFile(new URL('../web/facts.json', import.meta.url), 'utf8'));
  for (const meta of indexed) ids.add(meta.id);
  return [...ids];
}

const facts = {};
const counts = {};
for (const id of await factIds()) {
  const fact = await view('get_fact', { id });
  if (!fact) continue;
  const submitted = (await view('get_evidence', { fact_id: id })) ?? [];
  const urls = [...new Set([...fact.sources, ...submitted.map((item) => item.url)].map(canonicalUrl).filter(Boolean))];
  const sources = [];
  for (const url of urls) {
    const record = await fetchSource(url);
    sources.push(record);
    counts[record.status] = (counts[record.status] || 0) + 1;
    console.log(`${record.status.padEnd(16)} ${id}  ${url}`);
    await sleep(delayMs);
  }
  facts[id] = { claim: fact.claim, sources };
}

const bundle = {
  version: 1,
  contract,
  network: 'testnet',
  generated_at: new Date().toISOString(),
  generator: 'scripts/fetch-evidence.mjs',
  note: 'Page metadata and excerpts are reported as each page states them and are not verified. text_sha256 fingerprints the extracted text; body_sha256 fingerprints the raw page.',
  facts,
};
const json = `${JSON.stringify(bundle, null, 2)}\n`;
await mkdir(dirname(output), { recursive: true });
await writeFile(`${output}.tmp`, json, { mode: 0o644 });
await rename(`${output}.tmp`, output);
console.log(`\nWrote ${output}`);
console.log(`bundle_sha256 ${sha256Hex(json)}`);
console.log(Object.entries(counts).map(([status, n]) => `${status}: ${n}`).join(', ') || 'no sources');
