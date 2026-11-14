// Sponsored testnet staking for cold visitors. The judge account (JUDGE_KEY secret, a plain testnet account funded from the
// faucet) signs `stake` on the Hunch contract, so a visitor with no wallet and no NEAR still produces a real testnet transaction.
// The same Worker serves the built site (ASSETS) and relays the page's JSON-RPC reads.
import { client, loadKey, failureOf } from "./near.mjs";

const MIN_STAKE = 10n ** 22n; // 0.01 NEAR
const MAX_STAKE = 10n ** 23n; // 0.1 NEAR
const DEFAULT_STAKE = 5n * 10n ** 22n;
const PER_VISITOR = 6; // sponsored stakes per browser token per day
const PER_IP = 90; // per 15 minutes, shared by every visitor behind one address
const DAY_MS = 24 * 60 * 60 * 1000;
const IP_WINDOW_MS = 15 * 60 * 1000;
const FLOOR = 15n * 10n ** 23n; // 1.5 NEAR: below this the sponsor is out of testnet funds
const STAKE_GAS = "40000000000000";

const visitors = new Map();
const ips = new Map();
let keyPromise;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-visitor", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers } });

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const recent = (map, id, windowMs, now) => (map.get(id) ?? []).filter((t) => now - t < windowMs);

/** Sponsored stakes left for a browser token, counted from stakes that actually landed. */
export function visitorQuota(token, now = Date.now()) {
  return Math.max(0, PER_VISITOR - recent(visitors, token, DAY_MS, now).length);
}

function admit(token, ip, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) throw new HttpError(400, "The page did not send a visitor token. Reload and try again.");
  if (visitorQuota(token, now) === 0) throw new HttpError(429, "This browser has used its sponsored stakes for today. Connect a testnet wallet to keep staking.", { wallet: true });
  const byIp = recent(ips, ip, IP_WINDOW_MS, now);
  // A visitor's first sponsored stake is always allowed: another visitor behind the same address must not lock them out.
  if (byIp.length >= PER_IP && visitorQuota(token, now) === PER_VISITOR) return;
  if (byIp.length >= PER_IP) throw new HttpError(429, "Many stakes are arriving from this network. Wait a minute and try again.", { retryAfter: 60 });
}

export function parseStake(body, contractFacts = null) {
  const side = body?.side;
  if (side !== "Yes" && side !== "No") throw new HttpError(400, "side must be Yes or No.");
  const fact = String(body?.fact ?? "");
  if (!/^[a-z0-9-]{1,64}$/.test(fact)) throw new HttpError(400, "fact is not a claim id.");
  let amount = DEFAULT_STAKE;
  if (body?.amount !== undefined) {
    if (!/^\d{1,26}$/.test(String(body.amount))) throw new HttpError(400, "amount must be a yoctoNEAR integer.");
    amount = BigInt(body.amount);
  }
  if (amount < MIN_STAKE || amount > MAX_STAKE) throw new HttpError(400, "Sponsored stakes are between 0.01 and 0.1 NEAR.");
  return { fact, side, amount };
}

async function judge(env) {
  if (!env.JUDGE_KEY || !env.JUDGE_ACCOUNT || !env.HUNCH_CONTRACT) throw new HttpError(503, "The sponsored stake desk is not configured on this deployment.");
  const key = await (keyPromise ??= loadKey(env.JUDGE_KEY));
  return { key, account: env.JUDGE_ACCOUNT, contract: env.HUNCH_CONTRACT, near: client(undefined, { fast: true }) };
}

let balanceCache = { at: 0, value: 0n };
/** The desk's balance, read at most once a minute so the page's status call is one cheap request. */
async function deskBalance(near, account) {
  if (Date.now() - balanceCache.at > 60_000) {
    let value = 0n;
    for (let attempt = 0; attempt < 5 && value === 0n; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
      value = await near.balance(account).catch(() => 0n);
    }
    // 0 means the RPC refused the read, not that the desk is empty: keep the last good value rather than cache a false "unfunded"
    if (value === 0n) { if (balanceCache.value > 0n) return balanceCache.value; throw new HttpError(503, "NEAR testnet RPC is busy. Try again in a few seconds."); }
    balanceCache = { at: Date.now(), value };
  }
  return balanceCache.value;
}

async function status(req, env) {
  const { near, account, contract } = await judge(env);
  const balance = await deskBalance(near, account);
  const token = new URL(req.url).searchParams.get("visitor") || "";
  return json({ contract, account, funded: balance >= FLOOR, quota: /^[A-Za-z0-9_-]{8,64}$/.test(token) ? visitorQuota(token) : PER_VISITOR, perVisitor: PER_VISITOR });
}

async function stake(req, env) {
  let body;
  try { body = await req.json(); } catch { throw new HttpError(400, "The request body is not JSON."); }
  const { fact, side, amount } = parseStake(body);
  const token = req.headers.get("x-visitor") || "";
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  admit(token, ip, now);
  const { near, key, account, contract } = await judge(env);
  if ((await deskBalance(near, account)) < FLOOR) throw new HttpError(503, "The sponsored stake desk is out of testnet NEAR. The owner tops it up from the faucet.");
  const current = await near.view(contract, "get_fact", { id: fact }).catch(() => null);
  if (!current) throw new HttpError(404, "That claim is not on the contract.");
  if (current.status !== "Open" || Date.now() >= Number(current.resolve_after)) throw new HttpError(409, "That claim has closed for staking.");
  const started = Date.now();
  const { tx, outcome } = await near.call(key, account, contract, "stake", { id: fact, side }, { deposit: amount.toString(), gas: STAKE_GAS });
  const failure = failureOf(outcome);
  if (failure) throw new HttpError(502, `The contract refused the stake: ${JSON.stringify(failure).slice(0, 200)}`);
  visitors.set(token, [...recent(visitors, token, DAY_MS, now), now]);
  ips.set(ip, [...recent(ips, ip, IP_WINDOW_MS, now), now]);
  return json({ tx, explorer: `https://testnet.nearblocks.io/txns/${tx}`, account, contract, fact, side, amount: amount.toString(), seconds: (Date.now() - started) / 1000, quota: visitorQuota(token) });
}

// Same-origin JSON-RPC relay for the page's chain reads: the browser never depends on a third-party host's CORS header.
const RPC_UPSTREAMS = ["https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com", "https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
const RPC_METHODS = new Set(["query", "block", "tx", "EXPERIMENTAL_tx_status", "status"]);
async function relay(req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "the body is not JSON" }, 400); }
  if (!RPC_METHODS.has(body?.method)) return json({ error: "method not relayed" }, 400);
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: body.method, params: body.params });
  for (const upstream of [...RPC_UPSTREAMS, ...RPC_UPSTREAMS]) {
    try {
      const res = await fetch(upstream, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
      const out = await res.json();
      if (!out.result && (out.error?.code === -429 || out.code === 429 || /rate limit|too many requests|Temporary internal/i.test(JSON.stringify(out)))) { await new Promise((r) => setTimeout(r, 250)); continue; }
      if (!out.result && !out.error) continue;
      return json(out);
    } catch { /* next upstream */ }
  }
  return json({ error: "NEAR testnet RPC did not answer" }, 502);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === "/api/status" && req.method === "GET") return await status(req, env);
      if (url.pathname === "/api/stake" && req.method === "POST") return await stake(req, env);
      if (url.pathname === "/api/rpc" && req.method === "POST") return await relay(req);
      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message, ...error.extra }, error.status);
      console.error("relayer", error);
      return json({ error: "The sponsored stake desk could not reach NEAR testnet. Try again." }, 502);
    }
  },
};
