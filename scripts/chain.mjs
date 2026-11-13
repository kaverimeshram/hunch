const [command, contract, idOrAccount, timeoutArg] = process.argv.slice(2);
const rpc = process.env.HUNCH_RPC || process.env.TRUTHPAGE_RPC || 'https://near-testnet.drpc.org';

async function query(params) {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'hunch', method: 'query', params }), signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error('NEAR testnet RPC query failed');
  return result.result;
}

async function view(account, method, args) {
  const result = await query({ request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

if (command === 'balance') {
  const result = await query({ request_type: 'view_account', finality: 'final', account_id: idOrAccount });
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
} else if (command === 'fact') {
  console.log(JSON.stringify(await view(contract, 'get_fact', { id: idOrAccount })));
} else if (command === 'wait-balance') {
  const before = BigInt(timeoutArg);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await query({ request_type: 'view_account', finality: 'final', account_id: idOrAccount });
    if (BigInt(result.amount) > before) { console.log(result.amount); process.exit(0); }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('winner balance did not increase before timeout');
} else {
  throw new Error('command must be balance, fact, resolved, or wait-balance');
}
