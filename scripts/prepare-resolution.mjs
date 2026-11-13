import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const [contract, id, output] = process.argv.slice(2);
const key = process.env.NEAR_AI_API_KEY;
if (!contract || !id || !output || !key) throw new Error('contract, fact id, output path, and NEAR_AI_API_KEY are required');
const rpc = process.env.HUNCH_RPC || process.env.TRUTHPAGE_RPC || 'https://near-testnet.drpc.org';
const model = 'Qwen/Qwen3.6-35B-A3B-FP8';

async function call(method, args) {
  const result = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'hunch', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await result.json();
  if (!result.ok || json.error) throw new Error(`NEAR RPC failed while reading ${method}`);
  return JSON.parse(Buffer.from(json.result.result).toString('utf8'));
}

const prompt = await call('get_arbiter_prompt', { id });
const request = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024, stream: false });
const completionResponse = await fetch('https://cloud-api.near.ai/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-no-aliasing': 'true' },
  body: request,
  signal: AbortSignal.timeout(45_000),
});
if (!completionResponse.ok) throw new Error(`NEAR AI Cloud completion returned ${completionResponse.status}`);
const responseBody = await completionResponse.text();
const completion = JSON.parse(responseBody);
if (typeof completion.id !== 'string') throw new Error('NEAR AI Cloud response has no completion id');
const signatureResponse = await fetch(`https://cloud-api.near.ai/v1/signature/${encodeURIComponent(completion.id)}?signing_algo=ed25519`, {
  headers: { authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(15_000),
});
if (!signatureResponse.ok) throw new Error(`NEAR AI Cloud signature returned ${signatureResponse.status}`);
const receipt = await signatureResponse.json();
if (receipt.signature_kind !== 'provider_tee' || receipt.signing_algo !== 'ed25519') throw new Error('NEAR AI Cloud returned a non-provider receipt');
const requestHash = createHash('sha256').update(request).digest('hex');
const responseHash = createHash('sha256').update(responseBody).digest('hex');
if (receipt.text !== `${model}:${requestHash}:${responseHash}`) throw new Error('NEAR AI Cloud receipt does not bind this request and response');
// Same parsing rule as the contract: optional ```json fence, then strict JSON.
const content = (completion.choices?.[0]?.message?.content || '').trim();
const unfenced = content.startsWith('```') ? content.replace(/^```(?:json)?/, '').replace(/```$/, '').trim() : content;
let answer = null;
try { answer = JSON.parse(unfenced); } catch { /* reported below */ }
const OUTCOMES = { yes: 'Yes', no: 'No', insufficient: 'Insufficient' };
if (!OUTCOMES[answer?.outcome] || typeof answer.reasoning !== 'string' || !answer.reasoning.trim()) throw new Error('attested answer has no valid outcome or reasoning');
await writeFile(output, JSON.stringify({
  id,
  outcome: OUTCOMES[answer.outcome],
  evidence: {
    public_key: receipt.signing_address,
    model_id: model,
    request_sha256: requestHash,
    response_sha256: responseHash,
    signature: receipt.signature.replace(/^0x/, ''),
    request_body: request,
    response_body: responseBody,
  },
}));
console.log(`Attested resolution prepared for ${id}`);
