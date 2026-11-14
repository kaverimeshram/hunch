// Send one signed FunctionCall from an account whose key is in ~/.near-credentials/testnet, through the relayer's NEAR client.
// usage: node scripts/send.mjs <signer> <receiver> <method> <args.json file or inline JSON> [depositYocto] [gasTgas]
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { client, loadKey, failureOf, successValue } from '../relayer/src/near.mjs';

const [signer, receiver, method, argsSource, deposit = '0', tgas = '100'] = process.argv.slice(2);
if (!signer || !receiver || !method || !argsSource) throw new Error('usage: send.mjs <signer> <receiver> <method> <args> [depositYocto] [gasTgas]');
const credentials = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${signer}.json`, 'utf8'));
const key = await loadKey(credentials.private_key);
const args = JSON.parse(existsSync(argsSource) ? readFileSync(argsSource, 'utf8') : argsSource);
const near = client();
const { tx, outcome } = await near.call(key, signer, receiver, method, args, { deposit, gas: `${tgas}000000000000` });
const failure = failureOf(outcome);
console.log(JSON.stringify({ tx, status: outcome.final_execution_status, failure, value: successValue(outcome) }));
if (failure) process.exit(2);
