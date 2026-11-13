const [command, contract, idOrAccount, timeoutArg] = process.argv.slice(2);
const rpc = process.env.HUNCH_RPC || process.env.TRUTHPAGE_RPC || 'https://near-testnet.drpc.org';

const endpoints = [rpc, 'https://test.rpc.fastnear.com'];

async function query(params) {
  let last = 'no provider answered';
  for (let round = 0; round < 6; round += 1) {
    for (const url of endpoints) {
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'hunch', method: 'query', params }), signal: AbortSignal.timeout(15_000) });
        const result = await response.json();
        if (response.ok && !result.error) return result.result;
        last = result.error?.message || `HTTP ${response.status}`;
      } catch (error) { last = error.message; }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * (round + 1)));
  }
  throw new Error(`NEAR testnet RPC query failed: ${last}`);
}

async function view(account, method, args) {
  const result = await query({ request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

if (command === 'balance') {
  const result = await query({ request_type: 'view_account', finality: 'final', account_id: contract });
  console.log(result.amount);
} else if (command === 'resolved') {
  const deadline = Date.now() + Number(timeoutArg || 180) * 1000;
  let last = 'unavailable';
  while (Date.now() < deadline) {
    try {
      const fact = await view(contract, 'get_fact', { id: idOrAccount });
      last = fact?.status || 'missing';
      if (last === 'Resolved') { console.log(fact.outcome); process.exit(0); }
      if (last === 'Void') { console.log('Void'); process.exit(0); }
      if (last === 'Open') throw new Error('registry refused the attestation');
    } catch (error) {
      if (error.message === 'registry refused the attestation') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`resolution did not reach Resolved before timeout; last status: ${last}`);
} else if (command === 'ready') {
  const deadline = Date.now() + Number(timeoutArg || 600) * 1000;
  while (Date.now() < deadline) {
    const result = await query({ request_type: 'call_function', finality: 'final', account_id: contract, method_name: 'get_arbiter_prompt', args_base64: Buffer.from(JSON.stringify({ id: idOrAccount })).toString('base64') }).catch(() => null);
    if (result && !result.error) { console.log('ready'); process.exit(0); }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('fact did not reach its resolution time before timeout');
} else if (command === 'fact') {
  console.log(JSON.stringify(await view(contract, 'get_fact', { id: idOrAccount })));
} else if (command === 'wait-balance') {
  const before = BigInt(idOrAccount);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await query({ request_type: 'view_account', finality: 'final', account_id: contract });
    if (BigInt(result.amount) > before) { console.log(result.amount); process.exit(0); }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('winner balance did not increase before timeout');
} else {
  throw new Error('command must be balance, fact, ready, resolved, or wait-balance');
}
