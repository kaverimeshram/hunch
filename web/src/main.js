import { NearConnector } from '@hot-labs/near-connect';
import './style.css';
import { escapeHTML } from './html.js';
import { renderEvidenceRoom, evidenceFromChain, evidenceFromFact, evidenceSummaryMarkup, validateEvidenceInput } from './evidence.js';
import { parseContractJson, nearAmount, toYocto, odds, formatTenths, payoutFor, statusLabel, isAcceptingInput, toBigInt } from './market.js';

const RPC = 'https://near-testnet.drpc.org';
const EXPLORER = 'https://testnet.nearblocks.io';
const GAS = { stake: '30000000000000', evidence: '30000000000000', claim: '50000000000000', void: '30000000000000' };
const DEFAULT_EVIDENCE_DEPOSIT = '10000000000000000000000';
const DEFAULT_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const indexedFacts = await fetch('/facts.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
const generatedPages = await fetch('/generated-pages.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const attestationProof = await fetch('/attestation-proof.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
const query = new URLSearchParams(location.search);
// Contract to read: ?contract=..., then the visitor's last choice, then the deployment default
// (VITE_HUNCH_CONTRACT, set at build time, e.g. in Vercel's environment variables).
const contract = query.get('contract') || localStorage.getItem('hunch-contract') || localStorage.getItem('truthpage-contract') || import.meta.env.VITE_HUNCH_CONTRACT || '';
const state = document.querySelector('#page-state');
const app = document.querySelector('#app');
const walletButton = document.querySelector('#wallet-button');
const connector = new NearConnector({ network: 'testnet', features: { signAndSendTransaction: true } });
let wallet = null;
let accountId = '';

// ---------- NEAR RPC ----------

function rpcErrorText(error) {
  return typeof error === 'string' ? error : JSON.stringify(error ?? '');
}

async function view(method, args) {
  if (!contract) throw new Error('Enter the deployed contract account first.');
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  const response = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'hunch', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: argsBase64 } }) });
  if (!response.ok) throw new Error(`NEAR testnet RPC returned ${response.status}.`);
  const result = await response.json();
  const error = result.error || result.result?.error;
  if (error) {
    const text = rpcErrorText(error);
    const failure = new Error(/MethodNotFound/.test(text) ? `This contract does not support ${method}.` : (result.error?.cause?.name || 'NEAR testnet rejected the view call.'));
    failure.missingMethod = /MethodNotFound/.test(text);
    throw failure;
  }
  return parseContractJson(new TextDecoder().decode(new Uint8Array(result.result.result)));
}

/** A view that older contract versions may not have. Returns `fallback` if the method is missing. */
async function optionalView(method, args, fallback) {
  try { return await view(method, args); } catch (error) { if (error.missingMethod) return fallback; throw error; }
}

// ---------- Wallet ----------

function renderWalletButton() {
  if (!walletButton) return;
  walletButton.hidden = false;
  walletButton.textContent = accountId ? `${accountId} · Disconnect` : 'Connect wallet';
}

async function restoreWallet() {
  try {
    const connected = await connector.getConnectedWallet();
    wallet = connected.wallet;
    accountId = connected.accounts[0]?.accountId || '';
  } catch { wallet = null; accountId = ''; }
  renderWalletButton();
}

async function ensureWallet() {
  if (wallet && accountId) return wallet;
  wallet = await connector.connect();
  accountId = (await wallet.getAccounts())[0]?.accountId || '';
  if (!accountId) throw new Error('The connected wallet did not return an account.');
  renderWalletButton();
  return wallet;
}

async function callContract(methodName, args, deposit, gas) {
  const signer = await ensureWallet();
  return signer.signAndSendTransaction({ receiverId: contract, actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit } }] });
}

const walletReady = restoreWallet();
walletButton?.addEventListener('click', async () => {
  try {
    if (accountId) { await connector.disconnect(wallet); wallet = null; accountId = ''; renderWalletButton(); }
    else await ensureWallet();
    if (document.body.dataset.page === 'fact') await renderFact();
  } catch (error) {
    // Closing or rejecting the wallet popup is a normal choice, not an error.
    const text = error?.message || '';
    const cancelled = /closed|cancel|reject|denied/i.test(text);
    message(cancelled ? 'Wallet not connected. Reading claims does not need a wallet.' : (text || 'The wallet did not connect.'), !cancelled);
  }
});

// ---------- Shared markup ----------

function message(text, isError = false) {
  state.hidden = false;
  state.classList.toggle('is-error', isError);
  state.textContent = text;
}

function oddsMarkup(fact) {
  const { total, yesTenths, noTenths } = odds(fact.yes_pool, fact.no_pool);
  const yesLabel = total ? formatTenths(yesTenths) : 'No stakes';
  const noLabel = total ? formatTenths(noTenths) : 'No stakes';
  return `<div class="odds" aria-label="${total ? `${yesLabel} of NEAR staked on YES` : 'No stakes yet'}">
    <div class="odds-label"><span>YES <strong>${yesLabel}</strong></span><span>NO <strong>${noLabel}</strong></span></div>
    <div class="odds-track${total ? '' : ' is-empty'}"><span style="width:${total ? yesTenths / 10 : 50}%"></span></div>
    <div class="pool-row"><span>YES ${nearAmount(fact.yes_pool)}</span><span>NO ${nearAmount(fact.no_pool)}</span></div>
  </div>`;
}

function factUrl(id) {
  const params = new URLSearchParams({ id });
  if (contract) params.set('contract', contract);
  return `/fact/?${params}`;
}

function formatTime(ms) {
  return `${new Date(Number(ms)).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

function shortHash(value) {
  const text = String(value || '');
  return text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text;
}

/** Proof that the Sworn registry verifies this model's enclave quote and refuses a tampered one (from scripts/attest-proof.mjs). */
function proofMarkup() {
  const proof = attestationProof;
  if (proof?.status !== 'verified-and-refused' || !/^[A-Za-z0-9]+$/.test(proof.attestation_tx || '') || !/^[A-Za-z0-9]+$/.test(proof.rejected_quote_tx || '')) return '';
  const registryUrl = `${EXPLORER}/address/${encodeURIComponent(proof.registry)}`;
  return `<section class="resolution" aria-labelledby="proof-title">
    <p class="kicker">Sworn registry · ${escapeHTML(proof.model_id)}</p>
    <h3 id="proof-title">The arbiter quote is checked on chain</h3>
    <p>Sworn verified the enclave quote for this model. Changing one byte made the registry refuse it.</p>
    <p>
      <a href="${EXPLORER}/txns/${proof.attestation_tx}" target="_blank" rel="noopener">Quote verified ↗</a>
      <br /><a href="${EXPLORER}/txns/${proof.rejected_quote_tx}" target="_blank" rel="noopener">Flipped quote refused ↗</a>
      <br /><a href="${registryUrl}" target="_blank" rel="noopener">Registry ${escapeHTML(proof.registry)} ↗</a>
    </p>
  </section>`;
}

// ---------- Claim list ----------

async function loadFacts() {
  const byId = new Map();
  const config = await optionalView('get_config', {}, null);
  if (config) {
    for (let from = 0; from < config.fact_count; from += 50) {
      for (const fact of await view('list_facts', { from_index: from, limit: 50 })) byId.set(fact.id, fact);
    }
  }
  // Facts created before list_facts existed are only reachable through the static index.
  const missing = indexedFacts.map((meta) => meta.id).filter((id) => !byId.has(id));
  for (const fact of await Promise.all(missing.map((id) => view('get_fact', { id })))) if (fact) byId.set(fact.id, fact);
  return [...byId.values()];
}

async function renderList() {
  const form = document.querySelector('#contract-form');
  const input = form.elements.contract;
  input.value = contract;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    localStorage.setItem('hunch-contract', input.value.trim());
    const params = new URLSearchParams(location.search);
    params.set('contract', input.value.trim());
    location.search = params;
  });
  if (!contract) { app.setAttribute('aria-busy', 'false'); return; }
  message('Reading market state from NEAR testnet.');
  try {
    const facts = await loadFacts();
    const list = document.querySelector('#market-list');
    list.innerHTML = facts.map((fact) => `<li class="market-row">
      <a class="market-claim" href="${factUrl(fact.id)}"><span>${escapeHTML(fact.claim)}</span><span class="arrow" aria-hidden="true">↗</span></a>
      <div class="market-meta"><span>${escapeHTML(statusLabel(fact))}</span><span>${nearAmount(toBigInt(fact.yes_pool) + toBigInt(fact.no_pool))} staked</span></div>
      <a class="market-odds" href="${factUrl(fact.id)}">${oddsMarkup(fact)}<span class="small-link">Open claim</span></a>
    </li>`).join('');
    document.querySelector('#market-count').textContent = `${facts.length} ${facts.length === 1 ? 'claim' : 'claims'}`;
    message(facts.length ? 'Market data read from the contract.' : 'This contract has no claims yet.');
    if (!facts.length) list.innerHTML = '<li class="notice">Create a claim on this contract to begin the first market.</li>';
  } catch (error) { message(error.message, true); }
  finally { app.setAttribute('aria-busy', 'false'); }
}

// ---------- Fact page ----------

const VERDICT_LABEL = { Yes: 'Claim judged true', No: 'Claim judged false', Insufficient: 'Insufficient evidence' };

function resolutionMarkup(fact, history) {
  const records = Array.isArray(history) ? history : [];
  if (!records.length && !fact.reasoning) return '';
  const latest = records[records.length - 1];
  const attestation = latest?.attestation;
  const reasoning = latest?.reasoning ?? fact.reasoning;
  const verdict = latest ? (latest.outcome ? VERDICT_LABEL[latest.outcome] : 'No attested answer') : (fact.outcome ? VERDICT_LABEL[fact.outcome] : 'Attested answer');
  return `<section class="resolution-record" aria-labelledby="resolution-title">
    <p class="kicker">Resolution</p>
    <h2 id="resolution-title">How this claim was settled</h2>
    <dl class="verdict-row">
      <div><dt>AI arbiter</dt><dd>${escapeHTML(verdict)}</dd></div>
      <div><dt>Market</dt><dd>${escapeHTML(statusLabel(fact))}</dd></div>
      ${latest ? `<div><dt>Recorded</dt><dd>${escapeHTML(formatTime(latest.recorded_at))}</dd></div>` : ''}
    </dl>
    ${latest?.reason ? `<p class="resolution-reason">${escapeHTML(latest.reason)}</p>` : ''}
    ${reasoning ? `<div class="resolution"><h3>Attested reasoning</h3><p>${escapeHTML(reasoning)}</p></div>` : ''}
    ${attestation ? `<dl class="attestation">
      <div><dt>Model</dt><dd>${escapeHTML(attestation.model_id)}</dd></div>
      <div><dt>Signing key</dt><dd title="${escapeHTML(attestation.public_key)}">${escapeHTML(shortHash(attestation.public_key))}</dd></div>
      <div><dt>Request SHA-256</dt><dd title="${escapeHTML(attestation.request_sha256)}">${escapeHTML(shortHash(attestation.request_sha256))}</dd></div>
      <div><dt>Response SHA-256</dt><dd title="${escapeHTML(attestation.response_sha256)}">${escapeHTML(shortHash(attestation.response_sha256))}</dd></div>
      <div><dt>Signature</dt><dd title="${escapeHTML(attestation.signature)}">${escapeHTML(shortHash(attestation.signature))}</dd></div>
      <div><dt>Verified by</dt><dd><a href="${EXPLORER}/address/${encodeURIComponent(attestation.registry)}" target="_blank" rel="noopener noreferrer">${escapeHTML(attestation.registry)}</a></dd></div>
    </dl>
    <p class="evidence-note">The Sworn registry checked that the registered model key signed exactly this request and response. That proves the answer is authentic and unaltered. It does not prove the answer is correct.</p>` : ''}
    ${records.length > 1 ? `<details class="history"><summary>Full resolution history (${records.length})</summary><ol>${records.map((r) => `<li><strong>${escapeHTML(formatTime(r.recorded_at))}</strong> · ${escapeHTML(r.outcome ? VERDICT_LABEL[r.outcome] : 'No attested answer')} · ${escapeHTML(r.settlement)} · ${escapeHTML(r.reason)}</li>`).join('')}</ol></details>` : ''}
    <a class="small-link" href="${EXPLORER}/address/${encodeURIComponent(contract)}" target="_blank" rel="noopener noreferrer">Contract transactions on NearBlocks ↗</a>
  </section>`;
}

function settlementMarkup(fact, position, claimed) {
  const settled = fact.status === 'Resolved' || fact.status === 'Void';
  if (!settled) return '';
  if (!position) return '<div class="settlement"><p>Connect your wallet to see whether you have winnings or a refund to claim.</p><button type="button" class="secondary" data-action="connect">Connect wallet</button></div>';
  const payout = payoutFor(fact, position[0], position[1]);
  const kind = fact.status === 'Void' ? 'refund' : 'winnings';
  if (claimed) return `<div class="settlement"><p>You have claimed your ${kind}.</p></div>`;
  if (payout > 0n) return `<div class="settlement"><p>${fact.status === 'Void' ? 'This market was voided. Your stake is refundable.' : 'Your side won.'}</p><button type="button" data-action="claim">Claim ${nearAmount(payout)}</button><p class="form-error" id="claim-error" role="alert"></p></div>`;
  if (toBigInt(position[0]) + toBigInt(position[1]) > 0n) return '<div class="settlement"><p>Your stake was on the losing side.</p></div>';
  return '';
}

function stakeMarkup(fact, config) {
  if (isAcceptingInput(fact)) {
    return `<form id="stake-form" class="stake-form">
      <label for="amount">Your stake</label><div class="field-row"><input id="amount" name="amount" inputmode="decimal" placeholder="0.1" required /><select name="side" aria-label="Choose your side"><option value="Yes">YES</option><option value="No">NO</option></select><button type="submit">${accountId ? 'Stake' : 'Connect and stake'}</button></div>
      <p class="field-help">NEAR testnet only. Your wallet signs the transaction.</p><p class="form-error" id="stake-error" role="alert"></p>
    </form>`;
  }
  if (fact.status !== 'Open' && fact.status !== 'Pending') return '';
  const graceEnds = Number(fact.resolve_after) + (config?.resolution_grace_ms ?? DEFAULT_GRACE_MS);
  const canVoid = config && Date.now() >= graceEnds;
  return `<div class="stake-closed">
    <p>Staking closed ${escapeHTML(formatTime(fact.resolve_after))}. Waiting for an attested resolution.</p>
    ${config ? `<p class="field-help">If none is recorded by ${escapeHTML(formatTime(graceEnds))}, anyone can void the market so every stake is refunded.</p>` : ''}
    ${canVoid ? '<button type="button" class="secondary" data-action="void">Void and enable refunds</button><p class="form-error" id="void-error" role="alert"></p>' : ''}
  </div>`;
}

async function renderFact() {
  const id = query.get('id');
  if (!contract || !id) { message('This fact link needs a claim ID and contract account.', true); app.setAttribute('aria-busy', 'false'); return; }
  try {
    const fact = await view('get_fact', { id });
    if (!fact) { message('This claim has not been created on the selected contract.', true); app.setAttribute('aria-busy', 'false'); return; }
    await Promise.race([walletReady, new Promise((resolve) => setTimeout(resolve, 2500))]);
    const [config, submittedRaw, history, position, claimed] = await Promise.all([
      optionalView('get_config', {}, null),
      optionalView('get_evidence', { fact_id: id }, null),
      optionalView('get_resolution_history', { id }, null),
      accountId ? Promise.all(['Yes', 'No'].map((side) => view('get_stake', { id, account: accountId, side }))) : null,
      accountId ? optionalView('get_claimed', { id, account: accountId }, false) : false,
    ]);
    const submitted = evidenceFromChain(id, submittedRaw);
    const { total, yesTenths } = odds(fact.yes_pool, fact.no_pool);
    const generatedText = generatedPages[id];
    message(`Live claim state read from ${contract} on NEAR testnet.`);
    const viewRoot = document.querySelector('#fact-view');
    viewRoot.hidden = false;
    viewRoot.innerHTML = `<section class="fact-heading">
      <p class="kicker">${escapeHTML(statusLabel(fact))}</p>
      <h1>${escapeHTML(fact.claim)}</h1>
      <p class="lede">The market shows where participants put their NEAR. The resolution comes separately, from an AI arbiter judging the evidence, and is only accepted once its signed answer is verified on-chain.</p>
      ${evidenceSummaryMarkup(fact, submitted)}
    </section>
    ${proofMarkup()}
    ${generatedText ? `<section class="generated-page"><p class="kicker">AI-written summary · not attested</p><p>${escapeHTML(generatedText)}</p></section>` : ''}
    ${resolutionMarkup(fact, history)}
    <section class="market-frame" aria-labelledby="odds-title">
      <div class="market-title"><div><p class="kicker">Market sentiment</p><h2 id="odds-title">${total ? `${formatTenths(yesTenths)} staked on YES` : 'No stakes yet'}</h2></div><span class="status">${escapeHTML(fact.status)}</span></div>
      ${oddsMarkup(fact)}
      <div class="pool-total"><span>Total stake</span><strong>${nearAmount(toBigInt(fact.yes_pool) + toBigInt(fact.no_pool))}</strong></div>
      <div class="pool-total"><span>Staking and evidence close</span><strong>${escapeHTML(formatTime(fact.resolve_after))}</strong></div>
      ${position ? `<div class="position"><p>Your position <span>${escapeHTML(accountId)}</span></p><div><span>YES</span><strong>${nearAmount(position[0])}</strong></div><div><span>NO</span><strong>${nearAmount(position[1])}</strong></div></div>` : ''}
      ${settlementMarkup(fact, position, claimed)}
      ${stakeMarkup(fact, config)}
    </section>
    ${renderEvidenceRoom(fact, {
      submitted,
      form: submittedRaw === null ? null : {
        open: isAcceptingInput(fact),
        closedReason: `Evidence submission closed ${formatTime(fact.resolve_after)}.`,
        connected: Boolean(accountId),
        depositLabel: nearAmount(config?.evidence_deposit ?? DEFAULT_EVIDENCE_DEPOSIT),
      },
    })}`;

    const ctx = { id, fact, config, existingUrls: [...evidenceFromFact(fact), ...submitted].map((item) => item.url) };
    viewRoot.querySelector('#stake-form')?.addEventListener('submit', (event) => stake(event, ctx));
    viewRoot.querySelector('#evidence-form')?.addEventListener('submit', (event) => submitEvidence(event, ctx));
    viewRoot.querySelector('[data-action="claim"]')?.addEventListener('click', (event) => runAction(event, '#claim-error', () => callContract('claim', { id }, '0', GAS.claim)));
    viewRoot.querySelector('[data-action="void"]')?.addEventListener('click', (event) => runAction(event, '#void-error', () => callContract('void_expired', { id }, '0', GAS.void)));
    viewRoot.querySelector('[data-action="connect"]')?.addEventListener('click', (event) => runAction(event, null, ensureWallet));
    app.setAttribute('aria-busy', 'false');
  } catch (error) { message(error.message, true); app.setAttribute('aria-busy', 'false'); }
}

async function runAction(event, errorSelector, action) {
  const button = event.currentTarget;
  const errorBox = errorSelector ? document.querySelector(errorSelector) : null;
  button.disabled = true;
  if (errorBox) errorBox.textContent = '';
  try { await action(); await renderFact(); }
  catch (error) { if (errorBox) errorBox.textContent = error.message || 'The wallet did not submit the transaction.'; else message(error.message || 'The wallet did not connect.', true); }
  finally { button.disabled = false; }
}

async function stake(event, { id }) {
  event.preventDefault();
  const form = event.currentTarget, errorBox = form.querySelector('#stake-error'), button = form.querySelector('button');
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const amount = toYocto(form.elements.amount.value);
    await callContract('stake', { id, side: form.elements.side.value }, amount, GAS.stake);
    await renderFact();
  } catch (error) { errorBox.textContent = error.message || 'The wallet did not submit the stake.'; }
  finally { button.disabled = false; }
}

async function submitEvidence(event, { id, config, existingUrls }) {
  event.preventDefault();
  const form = event.currentTarget, errorBox = form.querySelector('#evidence-error'), button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const result = validateEvidenceInput({ url: form.elements.url.value, stance: form.elements.stance.value, note: form.elements.note.value }, existingUrls);
    if (result.error) throw new Error(result.error);
    await callContract('submit_evidence', { fact_id: id, ...result.value }, String(config?.evidence_deposit ?? DEFAULT_EVIDENCE_DEPOSIT), GAS.evidence);
    await renderFact();
  } catch (error) { errorBox.textContent = error.message || 'The wallet did not submit the evidence.'; }
  finally { button.disabled = false; }
}

if (document.body.dataset.page === 'fact') renderFact(); else renderList();
