import { NearConnector } from '@hot-labs/near-connect';
import './style.css';
import { escapeHTML } from './html.js';
import { renderEvidenceRoom, evidenceFromChain, evidenceFromFact, evidenceSummaryMarkup, validateEvidenceInput } from './evidence.js';
import { parseContractJson, nearAmount, toYocto, odds, formatTenths, payoutFor, statusLabel, isAcceptingInput, toBigInt, cents, previewStake } from './market.js';
import { fetchStakeHistory, seriesFor, reconciles } from './history.js';
import { chartSvg } from './chart.js';

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
const contract = query.get('contract') || localStorage.getItem('hunch-contract') || localStorage.getItem('truthpage-contract') || import.meta.env.VITE_HUNCH_CONTRACT || 'hunch-c-261113191249-82174.testnet';
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

function hideMessage() { state.hidden = true; }

const volumeOf = (fact) => toBigInt(fact.yes_pool) + toBigInt(fact.no_pool);

/** Open and Awaiting resolution both come from `status: Open`; the close time tells them apart. */
function stageOf(fact, nowMs = Date.now()) {
  switch (fact.status) {
    case 'Resolved': return { key: 'resolved', label: `Resolved ${fact.outcome === 'Yes' ? 'YES' : 'NO'}`, attested: true };
    case 'Void': return { key: 'void', label: 'Void · refundable', attested: false };
    case 'Pending': return { key: 'awaiting', label: 'Verifying quote', attested: false };
    default: return Number(fact.resolve_after) > nowMs ? { key: 'open', label: 'Open', attested: false } : { key: 'awaiting', label: 'Awaiting resolution', attested: false };
  }
}

function chipsMarkup(fact) {
  const stage = stageOf(fact);
  const seal = `<span class="seal" title="The arbiter's signed quote was verified on chain by the Sworn registry before this market settled.">${SEAL_ICON}Attested</span>`;
  return `<span class="chip chip-${stage.key}"><i aria-hidden="true"></i>${escapeHTML(stage.label)}</span>${stage.attested ? seal : ''}`;
}

function priceTexts(fact) {
  const { total, yesTenths, noTenths } = odds(fact.yes_pool, fact.no_pool);
  return { total, yesTenths, yesPct: total ? `${Math.round(yesTenths / 10)}%` : '—', yesCents: total ? `${cents(yesTenths)}¢` : '—', noCents: total ? `${cents(noTenths)}¢` : '—' };
}

function factUrl(id, side = '') {
  const params = new URLSearchParams({ id });
  if (contract) params.set('contract', contract);
  if (side) params.set('side', side);
  return `/fact/?${params}`;
}

function formatTime(ms) {
  return `${new Date(Number(ms)).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

function formatDay(ms) {
  return new Date(Number(ms)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function shortHash(value) {
  const text = String(value || '');
  return text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text;
}

function shortAccount(value) {
  const text = String(value || '');
  return text.length > 24 ? `${text.slice(0, 10)}…${text.slice(-10)}` : text;
}

const proofValid = () => attestationProof?.status === 'verified-and-refused' && /^[A-Za-z0-9]+$/.test(attestationProof.attestation_tx || '') && /^[A-Za-z0-9]+$/.test(attestationProof.rejected_quote_tx || '');

const SEAL_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1l2 1.6 2.5-.2.9 2.4 2.1 1.4-.8 2.4.8 2.4-2.1 1.4-.9 2.4-2.5-.2L8 15l-2-1.6-2.5.2-.9-2.4L.5 9.8 1.3 7.4.5 5l2.1-1.4.9-2.4 2.5.2z" fill="currentColor"/><path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Proof that the Sworn registry verifies this model's enclave quote and refuses a tampered one (from scripts/attest-proof.mjs). */
function proofMarkup({ compact = false } = {}) {
  if (!proofValid()) return '';
  const proof = attestationProof;
  const registryUrl = `${EXPLORER}/address/${encodeURIComponent(proof.registry)}`;
  const links = `<a class="proof-link proof-ok" href="${EXPLORER}/txns/${proof.attestation_tx}" target="_blank" rel="noopener">Quote verified ↗</a><a class="proof-link proof-bad" href="${EXPLORER}/txns/${proof.rejected_quote_tx}" target="_blank" rel="noopener">Flipped quote refused ↗</a>`;
  if (compact) return `<div class="trust-card"><p class="trust-head">${SEAL_ICON}<span>On-chain proof</span></p><p class="trust-copy">The Sworn registry verified the enclave quote for <code>${escapeHTML(proof.model_id)}</code>. Flip one byte and it refuses.</p><div class="proof-links">${links}</div></div>`;
  return `<div class="proof">
    <p class="trust-head">${SEAL_ICON}<span>Sworn registry · <code>${escapeHTML(proof.model_id)}</code></span></p>
    <h3 id="proof-title">The arbiter quote is checked on chain</h3>
    <p>Sworn verified the enclave quote for this model. Changing one byte made the registry refuse it.</p>
    <div class="proof-links">${links}<a class="proof-link" href="${registryUrl}" target="_blank" rel="noopener">Registry ${escapeHTML(proof.registry)} ↗</a></div>
  </div>`;
}

// ---------- Stake history (chain data from NearBlocks) ----------

let historyCache = null;
const stakeHistory = () => (historyCache ??= fetchStakeHistory(contract));

function sparkMarkup(events, fact) {
  const series = seriesFor(events, fact.id);
  if (!series.length || !reconciles(series, fact)) return '';
  return chartSvg(series, { width: 112, height: 36, mini: true });
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

function cardMarkup(fact) {
  const price = priceTexts(fact);
  const close = Number(fact.resolve_after);
  const closeText = close > Date.now() ? `Closes ${formatDay(close)}` : `Ended ${formatDay(close)}`;
  return `<li class="card" data-stage="${stageOf(fact).key}">
    <div class="card-chips">${chipsMarkup(fact)}</div>
    <h3 class="card-claim"><a class="card-link" href="${factUrl(fact.id)}">${escapeHTML(fact.claim)}</a></h3>
    <div class="card-chance">
      <div class="chance"><strong${price.total ? '' : ' class="is-empty"'}>${price.yesPct}</strong><span>${price.total ? 'chance YES' : 'no stakes yet'}</span></div>
      <div class="spark-slot" data-spark="${escapeHTML(fact.id)}"></div>
    </div>
    <div class="px-row">
      <a class="px px-yes" href="${factUrl(fact.id, 'Yes')}" aria-label="Buy Yes${price.total ? ` at ${price.yesCents}` : ''}"><span>Yes</span><b>${price.yesCents}</b></a>
      <a class="px px-no" href="${factUrl(fact.id, 'No')}" aria-label="Buy No${price.total ? ` at ${price.noCents}` : ''}"><span>No</span><b>${price.noCents}</b></a>
    </div>
    <p class="card-foot"><span><b>${nearAmount(volumeOf(fact))}</b> staked</span><span>${fact.stakers} ${fact.stakers === 1 ? 'staker' : 'stakers'}</span><span>${closeText}</span></p>
  </li>`;
}

function statsMarkup(facts) {
  const count = (key) => facts.filter((f) => stageOf(f).key === key).length;
  const volume = facts.reduce((sum, f) => sum + volumeOf(f), 0n);
  const stat = (value, label) => `<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<dl class="stat-row">${stat(String(facts.length), 'Markets')}${stat(nearAmount(volume), 'Total staked')}${stat(String(count('open')), 'Accepting stakes')}${stat(String(count('awaiting')), 'Awaiting resolution')}${stat(String(count('resolved')), 'Resolved')}</dl>`;
}

const FILTERS = [['all', 'All'], ['open', 'Open'], ['awaiting', 'Awaiting resolution'], ['resolved', 'Resolved'], ['void', 'Void']];

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
  document.querySelector('#trust-slot').innerHTML = proofMarkup({ compact: true });
  try {
    const facts = (await loadFacts()).sort((a, b) => (volumeOf(b) > volumeOf(a) ? 1 : volumeOf(b) < volumeOf(a) ? -1 : 0));
    const list = document.querySelector('#market-list');
    const filters = document.querySelector('#filters');
    document.querySelector('#stats').innerHTML = statsMarkup(facts);
    if (!facts.length) { message('This contract has no claims yet. Create one to open the first market.'); return; }
    hideMessage();
    list.innerHTML = facts.map(cardMarkup).join('');
    filters.innerHTML = FILTERS.filter(([key]) => key === 'all' || facts.some((f) => stageOf(f).key === key))
      .map(([key, label]) => `<button type="button" class="chip-btn" data-filter="${key}" aria-pressed="${key === 'all'}">${label} <span>${key === 'all' ? facts.length : facts.filter((f) => stageOf(f).key === key).length}</span></button>`).join('');
    filters.addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      for (const other of filters.querySelectorAll('[data-filter]')) other.setAttribute('aria-pressed', String(other === button));
      for (const card of list.children) card.hidden = button.dataset.filter !== 'all' && card.dataset.stage !== button.dataset.filter;
    });
    stakeHistory().then((events) => {
      for (const fact of facts) {
        const slot = list.querySelector(`[data-spark="${CSS.escape(fact.id)}"]`);
        if (slot) slot.innerHTML = sparkMarkup(events, fact);
      }
    }).catch((error) => console.warn('Stake history unavailable:', error.message));
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
  return `<div class="resolution-record">
    <h3 id="resolution-title">The arbiter's verdict</h3>
    <dl class="verdict-row">
      <div><dt>AI arbiter</dt><dd>${escapeHTML(verdict)}</dd></div>
      <div><dt>Market</dt><dd>${escapeHTML(statusLabel(fact))}</dd></div>
      ${latest ? `<div><dt>Recorded</dt><dd>${escapeHTML(formatTime(latest.recorded_at))}</dd></div>` : ''}
    </dl>
    ${latest?.reason ? `<p class="resolution-reason">${escapeHTML(latest.reason)}</p>` : ''}
    ${reasoning ? `<div class="reasoning"><h4>Attested reasoning</h4><p>${escapeHTML(reasoning)}</p></div>` : ''}
    ${attestation ? `<dl class="attestation">
      <div><dt>Model</dt><dd>${escapeHTML(attestation.model_id)}</dd></div>
      <div><dt>Signing key</dt><dd title="${escapeHTML(attestation.public_key)}">${escapeHTML(shortHash(attestation.public_key))}</dd></div>
      <div><dt>Request SHA-256</dt><dd title="${escapeHTML(attestation.request_sha256)}">${escapeHTML(shortHash(attestation.request_sha256))}</dd></div>
      <div><dt>Response SHA-256</dt><dd title="${escapeHTML(attestation.response_sha256)}">${escapeHTML(shortHash(attestation.response_sha256))}</dd></div>
      <div><dt>Signature</dt><dd title="${escapeHTML(attestation.signature)}">${escapeHTML(shortHash(attestation.signature))}</dd></div>
      <div><dt>Verified by</dt><dd><a href="${EXPLORER}/address/${encodeURIComponent(attestation.registry)}" target="_blank" rel="noopener noreferrer">${escapeHTML(attestation.registry)}</a></dd></div>
    </dl>
    <p class="evidence-note">The Sworn registry checked that the registered model key signed exactly this request and response, so the answer is authentic and unaltered.</p>` : ''}
    ${records.length > 1 ? `<details class="history"><summary>Full resolution history (${records.length})</summary><ol>${records.map((r) => `<li><strong>${escapeHTML(formatTime(r.recorded_at))}</strong> · ${escapeHTML(r.outcome ? VERDICT_LABEL[r.outcome] : 'No attested answer')} · ${escapeHTML(r.settlement)} · ${escapeHTML(r.reason)}</li>`).join('')}</ol></details>` : ''}
  </div>`;
}

function howResolvesMarkup(fact, history) {
  const steps = '<ol class="how-steps how-steps-inline"><li><span class="step-n">1</span><h3>Evidence room</h3><p>Sources are grouped by stance below.</p></li><li><span class="step-n">2</span><h3>Arbiter in an enclave</h3><p>An AI model judges the evidence and signs its answer.</p></li><li><span class="step-n">3</span><h3>Quote checked on chain</h3><p>Sworn verifies the quote. The market settles only if it passes.</p></li></ol>';
  return `<section class="section" id="resolves" aria-labelledby="resolves-title">
    <h2 id="resolves-title">How this resolves</h2>
    ${steps}${proofMarkup()}${resolutionMarkup(fact, history)}
    <a class="small-link" href="${EXPLORER}/address/${encodeURIComponent(contract)}" target="_blank" rel="noopener noreferrer">Contract transactions on NearBlocks ↗</a>
  </section>`;
}

function settlementMarkup(fact, position, claimed) {
  const settled = fact.status === 'Resolved' || fact.status === 'Void';
  if (!settled) return '';
  if (!position) return '<div class="settlement"><p>Connect your wallet to see whether you have winnings or a refund to claim.</p><button type="button" class="btn btn-secondary" data-action="connect">Connect wallet</button></div>';
  const payout = payoutFor(fact, position[0], position[1]);
  const kind = fact.status === 'Void' ? 'refund' : 'winnings';
  if (claimed) return `<div class="settlement"><p>You have claimed your ${kind}.</p></div>`;
  if (payout > 0n) return `<div class="settlement"><p>${fact.status === 'Void' ? 'This market was voided. Your stake is refundable.' : 'Your side won.'}</p><button type="button" class="btn btn-primary" data-action="claim">Claim ${nearAmount(payout)}</button><p class="form-error" id="claim-error" role="alert"></p></div>`;
  if (toBigInt(position[0]) + toBigInt(position[1]) > 0n) return '<div class="settlement"><p>Your stake was on the losing side.</p></div>';
  return '';
}

const QUICK_AMOUNTS = ['0.1', '0.5', '1', '5'];

function ticketBody(fact, config, position, claimed, preselect) {
  const price = priceTexts(fact);
  const own = position ? `<div class="position"><p>Your position <span>${escapeHTML(shortAccount(accountId))}</span></p><div><span>YES</span><strong>${nearAmount(position[0])}</strong></div><div><span>NO</span><strong>${nearAmount(position[1])}</strong></div></div>` : '';
  const settlement = settlementMarkup(fact, position, claimed);
  if (isAcceptingInput(fact)) {
    const side = preselect === 'No' ? 'No' : 'Yes';
    return `${own}<form id="stake-form" class="stake-form" novalidate>
      <div class="side-toggle" role="radiogroup" aria-label="Choose your side">
        <label class="side-opt side-yes"><input type="radio" name="side" value="Yes"${side === 'Yes' ? ' checked' : ''} /><span>Yes</span><b>${price.yesCents}</b></label>
        <label class="side-opt side-no"><input type="radio" name="side" value="No"${side === 'No' ? ' checked' : ''} /><span>No</span><b>${price.noCents}</b></label>
      </div>
      <label class="amount-label" for="amount">Amount</label>
      <div class="amount-field"><input id="amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" /><span aria-hidden="true">NEAR</span></div>
      <div class="quick" role="group" aria-label="Quick amounts">${QUICK_AMOUNTS.map((a) => `<button type="button" class="quick-btn" data-amount="${a}">${a}</button>`).join('')}</div>
      <dl class="preview" aria-live="polite">
        <div><dt>YES share after</dt><dd id="pv-share">${price.yesPct}</dd></div>
        <div><dt id="pv-payout-label">Payout if Yes wins</dt><dd id="pv-payout">—</dd></div>
        <div><dt>Profit</dt><dd id="pv-profit">—</dd></div>
      </dl>
      <button type="submit" class="btn btn-trade" id="stake-submit">${accountId ? 'Stake' : 'Connect wallet to stake'}</button>
      <p class="field-help">NEAR testnet. Your wallet signs the transaction. Payout assumes no one else stakes before the market closes; the pool is split pro rata among the winning side.</p>
      <p class="form-error" id="stake-error" role="alert"></p>
    </form>${settlement}`;
  }
  if (fact.status !== 'Open' && fact.status !== 'Pending') return `${own}${settlement}`;
  const graceEnds = Number(fact.resolve_after) + (config?.resolution_grace_ms ?? DEFAULT_GRACE_MS);
  const canVoid = config && Date.now() >= graceEnds;
  return `${own}<div class="stake-closed">
    <p><strong>Staking closed</strong> ${escapeHTML(formatTime(fact.resolve_after))}. The arbiter's attested answer settles this market.</p>
    ${config ? `<p class="field-help">If none is recorded by ${escapeHTML(formatTime(graceEnds))}, anyone can void the market so every stake is refunded.</p>` : ''}
    ${canVoid ? '<button type="button" class="btn btn-secondary" data-action="void">Void and enable refunds</button><p class="form-error" id="void-error" role="alert"></p>' : ''}
  </div>`;
}

/** Live payout preview. Reads the form, runs the contract's payout math, writes the three rows. */
function wireTicket(root, fact, position) {
  const form = root.querySelector('#stake-form');
  if (!form) return;
  const ownYes = position ? toBigInt(position[0]) : 0n;
  const ownNo = position ? toBigInt(position[1]) : 0n;
  const price = priceTexts(fact);
  const submit = form.querySelector('#stake-submit');
  const update = () => {
    const side = form.elements.side.value;
    form.querySelector('#pv-payout-label').textContent = `Payout if ${side} wins`;
    submit.classList.toggle('is-no', side === 'No');
    let amount = null;
    try { amount = toYocto(form.elements.amount.value); } catch { amount = null; }
    const filled = form.elements.amount.value.trim() !== '';
    if (amount === null) {
      form.querySelector('#pv-share').textContent = price.yesPct;
      form.querySelector('#pv-payout').textContent = '—';
      form.querySelector('#pv-profit').textContent = '—';
      submit.textContent = accountId ? (filled ? 'Enter a valid amount' : 'Stake') : 'Connect wallet to stake';
      return;
    }
    const preview = previewStake(fact, side, amount, ownYes, ownNo);
    const profit = preview.profit;
    form.querySelector('#pv-share').textContent = formatTenths(preview.afterTenths);
    form.querySelector('#pv-payout').textContent = nearAmount(preview.payout);
    const profitCell = form.querySelector('#pv-profit');
    profitCell.textContent = profit > 0n ? `+${nearAmount(profit)}` : profit < 0n ? `-${nearAmount(-profit)}` : nearAmount(0n);
    profitCell.dataset.sign = profit > 0n ? 'gain' : profit < 0n ? 'loss' : 'flat';
    submit.textContent = `${accountId ? 'Stake' : 'Connect wallet to stake'} ${nearAmount(amount)} on ${side}`.replace(/ NEAR NEAR/, ' NEAR');
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.querySelector('.quick').addEventListener('click', (event) => {
    const button = event.target.closest('[data-amount]');
    if (!button) return;
    form.elements.amount.value = button.dataset.amount;
    update();
    form.elements.amount.focus();
  });
  update();
}

function activityMarkup(series) {
  const rows = [...series].reverse().map((p) => `<li class="activity-row">
    <span class="side-tag side-tag-${p.side === 'Yes' ? 'yes' : 'no'}">${p.side}</span>
    <strong>${nearAmount(p.amount)}</strong>
    <a href="${EXPLORER}/address/${encodeURIComponent(p.account)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(p.account)}">${escapeHTML(shortAccount(p.account))}</a>
    <span class="muted">YES share ${formatTenths(p.yesTenths)}</span>
    <a class="tx" href="${EXPLORER}/txns/${encodeURIComponent(p.hash)}" target="_blank" rel="noopener noreferrer">${escapeHTML(formatTime(p.at))} ↗</a>
  </li>`).join('');
  return `<h3 class="activity-title">Stake history</h3><ol class="activity">${rows}</ol>`;
}

let chartObserver = null;

function fillChart(slot, fact, events) {
  chartObserver?.disconnect();
  const series = seriesFor(events, fact.id);
  if (!reconciles(series, fact)) {
    slot.innerHTML = `<p class="chart-empty">The stakes read from NearBlocks do not add up to this contract's pools yet, so no chart is drawn. <a href="${EXPLORER}/address/${encodeURIComponent(contract)}" target="_blank" rel="noopener noreferrer">Contract transactions ↗</a></p>`;
    return;
  }
  if (!series.length) { slot.innerHTML = '<p class="chart-empty">No stakes yet. The chart starts with the first stake and every point is a real transaction.</p>'; return; }
  const frame = slot.querySelector('.chart-frame') || slot.appendChild(Object.assign(document.createElement('div'), { className: 'chart-frame' }));
  const draw = () => { frame.innerHTML = chartSvg(series, { width: Math.max(260, Math.round(frame.clientWidth)), height: frame.clientWidth < 480 ? 200 : 240 }); };
  slot.innerHTML = '';
  slot.append(frame);
  slot.insertAdjacentHTML('beforeend', activityMarkup(series));
  draw();
  let lastWidth = frame.clientWidth;
  chartObserver = new ResizeObserver(() => { if (Math.abs(frame.clientWidth - lastWidth) > 4) { lastWidth = frame.clientWidth; draw(); } });
  chartObserver.observe(frame);
}

async function renderFact() {
  const id = query.get('id');
  if (!contract || !id) { message('This claim link needs a claim ID and contract account.', true); app.setAttribute('aria-busy', 'false'); return; }
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
    const price = priceTexts(fact);
    const generatedText = generatedPages[id];
    document.title = `${fact.claim} | Hunch`;
    hideMessage();
    const viewRoot = document.querySelector('#fact-view');
    viewRoot.hidden = false;
    viewRoot.innerHTML = `<div class="claim-layout">
      <header class="claim-head">
        <div class="card-chips">${chipsMarkup(fact)}</div>
        <h1>${escapeHTML(fact.claim)}</h1>
        <div class="claim-numbers">
          <div class="chance chance-xl"><strong${price.total ? '' : ' class="is-empty"'}>${price.yesPct}</strong><span>${price.total ? 'chance YES' : 'no stakes yet'}</span></div>
          <dl class="claim-stats">
            <div><dt>Total staked</dt><dd>${nearAmount(volumeOf(fact))}</dd></div>
            <div><dt>Stakers</dt><dd>${fact.stakers}</dd></div>
            <div><dt>${Number(fact.resolve_after) > Date.now() ? 'Closes' : 'Ended'}</dt><dd>${escapeHTML(formatDay(fact.resolve_after))}</dd></div>
          </dl>
        </div>
        ${proofValid() ? `<p class="trust-strip">${SEAL_ICON}<span>Settles only on an attested arbiter quote.</span><a href="${EXPLORER}/txns/${attestationProof.attestation_tx}" target="_blank" rel="noopener">Quote verified ↗</a><a href="${EXPLORER}/txns/${attestationProof.rejected_quote_tx}" target="_blank" rel="noopener">Flipped quote refused ↗</a><a href="#resolves">How this resolves</a></p>` : ''}
        ${evidenceSummaryMarkup(fact, submitted)}
      </header>
      <aside class="ticket" aria-labelledby="ticket-title">
        <h2 id="ticket-title">Stake on this claim</h2>
        ${ticketBody(fact, config, position, claimed, query.get('side'))}
      </aside>
      <section class="panel chart-panel" aria-labelledby="chart-title">
        <div class="panel-head"><h2 id="chart-title">YES share over time</h2><span class="muted">From on-chain stakes</span></div>
        <div id="chart-slot" class="chart-slot"><p class="chart-empty">Reading stake history from NearBlocks.</p></div>
      </section>
      <div class="claim-rest">
        ${howResolvesMarkup(fact, history)}
        ${generatedText ? `<section class="panel generated-page"><p class="kicker">AI-written summary · not attested</p><p>${escapeHTML(generatedText)}</p></section>` : ''}
        ${renderEvidenceRoom(fact, {
          submitted,
          form: submittedRaw === null ? null : {
            open: isAcceptingInput(fact),
            closedReason: `Evidence submission closed ${formatTime(fact.resolve_after)}.`,
            connected: Boolean(accountId),
            depositLabel: nearAmount(config?.evidence_deposit ?? DEFAULT_EVIDENCE_DEPOSIT),
          },
        })}
      </div>
    </div>`;

    const ctx = { id, fact, config, existingUrls: [...evidenceFromFact(fact), ...submitted].map((item) => item.url) };
    wireTicket(viewRoot, fact, position);
    viewRoot.querySelector('#stake-form')?.addEventListener('submit', (event) => stake(event, ctx));
    viewRoot.querySelector('#evidence-form')?.addEventListener('submit', (event) => submitEvidence(event, ctx));
    viewRoot.querySelector('[data-action="claim"]')?.addEventListener('click', (event) => runAction(event, '#claim-error', () => callContract('claim', { id }, '0', GAS.claim)));
    viewRoot.querySelector('[data-action="void"]')?.addEventListener('click', (event) => runAction(event, '#void-error', () => callContract('void_expired', { id }, '0', GAS.void)));
    viewRoot.querySelector('[data-action="connect"]')?.addEventListener('click', (event) => runAction(event, null, ensureWallet));
    app.setAttribute('aria-busy', 'false');
    const slot = viewRoot.querySelector('#chart-slot');
    stakeHistory().then((events) => fillChart(slot, fact, events)).catch((error) => { slot.innerHTML = `<p class="chart-empty">Stake history is unavailable right now (${escapeHTML(error.message)}).</p>`; });
  } catch (error) { message(error.message, true); app.setAttribute('aria-busy', 'false'); }
}

async function runAction(event, errorSelector, action) {
  const button = event.currentTarget;
  const errorBox = errorSelector ? document.querySelector(errorSelector) : null;
  button.disabled = true;
  if (errorBox) errorBox.textContent = '';
  try { await action(); historyCache = null; await renderFact(); }
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
    historyCache = null;
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
