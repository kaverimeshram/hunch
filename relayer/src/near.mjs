// Minimal NEAR client for a Worker: borsh FunctionCall transactions signed with WebCrypto ed25519, sent over JSON-RPC.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const te = new TextEncoder();

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}

export function b58decode(text) {
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  let zeros = 0;
  for (const ch of text) { if (ch === "1") zeros += 1; else break; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u128 = (n) => { let x = BigInt(n); const b = new Uint8Array(16); for (let i = 0; i < 16; i += 1) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
const str = (s) => { const e = te.encode(s); return cat(u32(e.length), e); };

// Transaction { signer_id, public_key, nonce, receiver_id, block_hash, actions: [FunctionCall] }
export function encodeTransaction({ signer, publicKey, nonce, receiver, blockHash, actions }) {
  return cat(
    str(signer), Uint8Array.of(0), publicKey, u64(nonce), str(receiver), blockHash, u32(actions.length),
    ...actions.map((a) => {
      if (a.transfer !== undefined) return cat(Uint8Array.of(3), u128(a.transfer));
      if (a.createAccount) return Uint8Array.of(0);
      if (a.deploy) return cat(Uint8Array.of(1), u32(a.deploy.length), a.deploy);
      if (a.addKey) return cat(Uint8Array.of(5), Uint8Array.of(0), a.addKey, u64(0), Uint8Array.of(1)); // full access key
      if (a.deleteKey) return cat(Uint8Array.of(6), Uint8Array.of(0), a.deleteKey);
      return cat(Uint8Array.of(2), str(a.method), u32(a.args.length), a.args, u64(a.gas), u128(a.deposit));
    }),
  );
}

async function importSeed(seed) {
  const pkcs8 = cat(Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]), seed);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

// "ed25519:<base58 of seed + public key>" is how near-cli stores a key
export async function keyFromSeed(seed, publicKey) {
  return { publicKey, sign: await importSeed(seed) };
}

export async function loadKey(secret) {
  const raw = b58decode(secret.trim().replace(/^ed25519:/, ""));
  if (raw.length !== 64) throw new Error("the sponsor key is not a 64 byte ed25519 secret");
  return { publicKey: raw.slice(32), sign: await importSeed(raw.slice(0, 32)) };
}

export async function signTransaction(key, tx) {
  const bytes = encodeTransaction({ ...tx, publicKey: key.publicKey });
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.sign, hash));
  return { hash: b58encode(hash), bytes: cat(bytes, Uint8Array.of(0), signature) };
}

export const toBase64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const down = new Map();
const isDown = (url) => Date.now() - (down.get(url) ?? -Infinity) < 60_000;
const TRANSIENT = /Temporary internal error|INTERNAL_ERROR|Service Unavailable|Bad Gateway/i;

export function client(endpoints = ["https://near-testnet.drpc.org", "https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"], { fast = false } = {}) {
  const finality = fast ? "optimistic" : "final";
  const waitUntil = fast ? "EXECUTED_OPTIMISTIC" : "FINAL";
  async function rpc(method, params) {
    const failures = [];
    for (let pass = 0; pass < 3; pass += 1) {
      // an endpoint that failed in the last minute goes to the back: every wasted fetch counts against the Worker's 50 subrequests
      const order = [...endpoints].sort((x, y) => Number(isDown(x)) - Number(isDown(y)));
      for (const url of order) {
        try {
          const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          const json = await res.json();
          if (json.error && json.error.code !== -429 && json.error.code !== 30 && !TRANSIENT.test(JSON.stringify(json.error))) { down.delete(url); return json; } // 429, the free plan's timeout (30) and a temporary internal error move on to the next endpoint
          if (json.result) { down.delete(url); return json; }
          down.set(url, Date.now());
          failures.push(`${url}: ${json.error?.message ?? "no result"}`);
        } catch (error) {
          down.set(url, Date.now());
          failures.push(`${url}: ${error.message}`);
        }
      }
      await new Promise((r) => setTimeout(r, 600 * (pass + 1)));
    }
    throw new Error(`NEAR RPC did not answer ${method}: ${failures.slice(-2).join(" | ")}`);
  }

  async function view(account, method, args) {
    const json = await rpc("query", { request_type: "call_function", finality, account_id: account, method_name: method, args_base64: toBase64(te.encode(JSON.stringify(args))) });
    if (!json.result?.result) throw new Error(`${account}.${method} failed: ${json.error?.data ?? json.result?.error ?? "no result"}`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json.result.result)));
  }

  async function balance(account) {
    const json = await rpc("query", { request_type: "view_account", finality: "final", account_id: account });
    return BigInt(json.result?.amount ?? "0");
  }

  // one transaction at a time per signer inside this isolate; a nonce another isolate used is retried with a fresh read
  const EXECUTED = new Set(["EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"]);
  const queues = new Map();
  const nonces = new Map();
  let recentBlock = null;
  function transact(key, signer, receiver, actions) {
    const lane = `${signer}:${b58encode(key.publicKey)}`;
    const run = async () => {
      let lastError = "";
      for (let attempt = 0; attempt < 4; attempt += 1) {
        // the nonce and the block hash are read once per isolate and then counted locally: a Worker invocation may make only 50 subrequests
        // another isolate may have moved this key's nonce since: a counted nonce is trusted for 15 s after its last use
        if (!nonces.has(lane) || Date.now() - nonces.get(lane).at > 15_000) {
          const access = await rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: signer, public_key: `ed25519:${b58encode(key.publicKey)}` });
          if (!access.result) throw new Error(`the sponsor key is not an access key of ${signer}`);
          nonces.set(lane, { n: Number(access.result.nonce), at: Date.now() });
        }
        if (!recentBlock || Date.now() - recentBlock.at > 10 * 60_000) recentBlock = { at: Date.now(), hash: (await rpc("block", { finality: "final" })).result.header.hash };
        const nonce = nonces.get(lane).n + 1;
        const signed = await signTransaction(key, { signer, nonce, receiver, blockHash: b58decode(recentBlock.hash), actions });
        // every endpoint refusing is a lost reply, not proof the transaction was dropped: it is looked up by hash below
        const sent = await rpc("send_tx", { signed_tx_base64: toBase64(signed.bytes), wait_until: waitUntil }).catch((error) => ({ error: { cause: `Temporary internal error: ${error.message}` } }));
        if (sent.result) { nonces.set(lane, { n: nonce, at: Date.now() }); return { tx: signed.hash, outcome: sent.result }; }
        nonces.delete(lane);
        recentBlock = null;
        lastError = JSON.stringify(sent.error?.cause ?? sent.error ?? "");
        console.warn(`send_tx for ${receiver} ${actions[0]?.method ?? ""} attempt ${attempt} nonce ${nonce}: ${lastError.slice(0, 160)}`);
        if (!/InvalidNonce|Timeout|INVALID_TRANSACTION/i.test(lastError) && !TRANSIENT.test(lastError)) break;
        // a cut-off reply does not mean the transaction was dropped: signing again would run the call twice, so look its hash up first
        const slow = /timeout/i.test(lastError) || TRANSIENT.test(lastError);
        for (let poll = 0; poll < (slow ? 8 : 1); poll += 1) {
          const landed = await rpc("tx", { tx_hash: signed.hash, sender_account_id: signer, wait_until: "NONE" }).catch(() => ({}));
          if (EXECUTED.has(landed.result?.final_execution_status)) { nonces.set(lane, { n: nonce, at: Date.now() }); return { tx: signed.hash, outcome: landed.result }; }
          if (slow) await new Promise((r) => setTimeout(r, 1000));
        }
      }
      throw new Error(`NEAR did not accept the transaction: ${lastError.slice(0, 200)}`);
    };
    const queue = queues.get(lane) ?? Promise.resolve();
    const next = queue.then(run, run);
    queues.set(lane, next.catch(() => {}));
    return next;
  }

  const call = (key, signer, receiver, method, args, { deposit = "0", gas = "100000000000000" } = {}) =>
    transact(key, signer, receiver, [{ method, args: te.encode(JSON.stringify(args)), gas, deposit }]);
  const transfer = (key, signer, receiver, yocto) => transact(key, signer, receiver, [{ transfer: yocto }]);
  const addKey = (key, signer, publicKey) => transact(key, signer, signer, [{ addKey: publicKey }]);

  return { rpc, view, balance, call, transact, transfer, addKey };
}

// the Voucher event a receipt logged, if any
export function voucherEvent(outcome) {
  for (const r of outcome?.receipts_outcome ?? []) {
    for (const line of r.outcome?.logs ?? []) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(line.slice(11));
        if (e.standard === "voucher") return e;
      } catch { /* a log that is not JSON is not ours */ }
    }
  }
  return null;
}

export const failureOf = (outcome) => outcome?.status?.Failure ?? outcome?.receipts_outcome?.map((r) => r.outcome?.status?.Failure).find(Boolean) ?? null;
export const successValue = (outcome) => {
  const v = outcome?.status?.SuccessValue;
  return v === undefined ? null : new TextDecoder().decode(fromBase64(v));
};
