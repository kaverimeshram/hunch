import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const accounts = process.argv.slice(2);
if (!accounts.length) throw new Error('usage: create-accounts.mjs <account.testnet>...');
const rpcs = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'];
const workflowRepo = 'CryptoInnovators/near-sworn';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  return { publicKey: 'ed25519:' + base58(pub), privateKey: 'ed25519:' + base58(Buffer.concat([seed, pub])) };
}

async function exists(account) {
  for (const rpc of rpcs) {
    try {
      const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }), signal: AbortSignal.timeout(15_000) });
      if (res.status === 429) continue;
      const body = await res.json();
      if (body.result?.amount) return true;
      if (body.error) return false;
    } catch { /* next rpc */ }
  }
  return false;
}

const token = JSON.parse(readFileSync(join(homedir(), '.config/github/account.json'), 'utf8')).kamalbuilds.token;
const dir = join(homedir(), '.near-credentials/testnet');
mkdirSync(dir, { recursive: true });

async function create(account) {
  const file = join(dir, `${account}.json`);
  if (existsSync(file)) throw new Error(`credentials already exist for ${account}`);
  const { publicKey, privateKey } = keypair();
  writeFileSync(file, JSON.stringify({ account_id: account, public_key: publicKey, private_key: privateKey }), { mode: 0o600 });
  chmodSync(file, 0o600);
  execFileSync('gh', ['workflow', 'run', 'create-testnet-account.yml', '-R', workflowRepo, '-f', `account_id=${account}`, '-f', `public_key=${publicKey}`], { env: { ...process.env, GH_TOKEN: token }, stdio: ['ignore', 'ignore', 'inherit'] });
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    if (await exists(account)) { console.log(`ACCOUNT_READY ${account}`); return; }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`account ${account} did not appear on testnet`);
}

const results = await Promise.allSettled(accounts.map(create));
const failed = results.filter((r) => r.status === 'rejected');
for (const r of failed) console.error(r.reason.message);
if (failed.length) process.exit(1);
