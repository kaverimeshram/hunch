import { readFile, rename, writeFile } from 'node:fs/promises';

const [contract, output] = process.argv.slice(2);
const key = process.env.NEAR_AI_API_KEY;
if (!contract || !output || !key) throw new Error('contract, output path, and NEAR_AI_API_KEY are required');
const rpc = process.env.TRUTHPAGE_RPC || 'https://near-testnet.drpc.org';
const model = 'Qwen/Qwen3.6-35B-A3B-FP8';
const facts = JSON.parse(await readFile(new URL('../web/facts.json', import.meta.url), 'utf8'));

async function call(method, args) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'truthpage', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await response.json();
  if (!response.ok || json.error) throw new Error(`NEAR RPC failed while reading ${method}`);
  return JSON.parse(Buffer.from(json.result.result).toString('utf8'));
}

const pages = {};
for (const meta of facts) {
  const fact = await call('get_fact', { id: meta.id });
  if (!fact) throw new Error(`claim ${meta.id} is not present on ${contract}`);
  const prompt = [
    'Write a neutral, concise encyclopedia paragraph of 80 to 120 words about the claim below.',
    'Use only the supplied source URLs and market state. Distinguish reported evidence from market opinion.',
    'Do not invent facts, dates, or citations. Do not decide the claim unless its market is resolved.',
    `Claim: ${fact.claim}`,
    `YES stake: ${fact.yes_pool} yoctoNEAR`,
    `NO stake: ${fact.no_pool} yoctoNEAR`,
    `Status: ${JSON.stringify(fact.status)}`,
    `Resolution: ${fact.reasoning || 'unresolved'}`,
    `Sources:\n${fact.sources.join('\n')}`,
  ].join('\n');
  const response = await fetch('https://cloud-api.near.ai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-no-aliasing': 'true' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 220, stream: false }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`NEAR AI Cloud page generation returned ${response.status}`);
  const completion = await response.json();
  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text || text.length > 2000) throw new Error(`NEAR AI Cloud returned invalid page text for ${meta.id}`);
  pages[meta.id] = text;
}

const temporary = `${output}.tmp`;
await writeFile(temporary, `${JSON.stringify(pages, null, 2)}\n`, { mode: 0o644 });
await rename(temporary, output);
console.log(`Generated ${Object.keys(pages).length} claim pages from live testnet state`);
