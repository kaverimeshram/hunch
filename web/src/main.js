import { NearConnector } from '@hot-labs/near-connect';
import './style.css';
import { escapeHTML } from './html.js';
import { renderEvidenceRoom } from './evidence.js';

const RPC = 'https://near-testnet.drpc.org';
const facts = await fetch('/facts.json').then((r) => r.json());
const generatedPages = await fetch('/generated-pages.json').then((r) => r.ok ? r.json() : {}).catch(() => ({}));
const attestationProof = await fetch('/attestation-proof.json').then((r) => r.ok ? r.json() : null).catch(() => null);
const query = new URLSearchParams(location.search);
const contract = query.get('contract') || localStorage.getItem('hunch-contract') || localStorage.getItem('truthpage-contract') || '';
const state = document.querySelector('#page-state');
const app = document.querySelector('#app');
const connector = new NearConnector({ network: 'testnet', features: { signAndSendTransaction: true } });
let accountId = '';

function nearAmount(raw) {
  const value = BigInt(raw || 0);
  const whole = value / 10n ** 24n;
  const fraction = (value % 10n ** 24n).toString().padStart(24, '0').slice(0, 3).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} NEAR`;
}

function percent(yes, no) {
  const total = BigInt(yes) + BigInt(no);
  const tenths = total ? BigInt(yes) * 1000n / total : 0n;
  return total ? `${tenths / 10n}.${tenths % 10n}%` : 'No stakes';
}

function yocto(value) {
  const match = /^(\d+)(?:\.(\d{1,24}))?$/.exec(value.trim());
  if (!match) throw new Error('Enter a stake greater than zero, up to 24 decimal places.');
  const amount = BigInt(match[1]) * 10n ** 24n + BigInt((match[2] || '').padEnd(24, '0') || '0');
  if (amount === 0n) throw new Error('Enter a stake greater than zero, up to 24 decimal places.');
  return amount.toString();
}

async function view(method, args) {
  if (!contract) throw new Error('Enter the deployed contract account first.');
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  const response = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'hunch', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: argsBase64 } }) });
  if (!response.ok) throw new Error(`NEAR testnet RPC returned ${response.status}.`);
  const result = await response.json();
  if (result.error) throw new Error(result.error.cause?.name || result.error.message || 'NEAR testnet rejected the view call.');
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result.result)));
}

function message(text, isError = false) {
  state.hidden = false;
  state.classList.toggle('is-error', isError);
  state.textContent = text;
}

function oddsMarkup(fact) {
  const yes = BigInt(fact.yes_pool), no = BigInt(fact.no_pool), total = yes + no;
  const share = total ? Number(yes * 1000n / total) / 10 : 50;
  return `<div class="odds" aria-label="YES ${percent(fact.yes_pool, fact.no_pool)}">
    <div class="odds-label"><span>YES <strong>${percent(fact.yes_pool, fact.no_pool)}</strong></span><span>NO <strong>${percent(fact.no_pool, fact.yes_pool)}</strong></span></div>
    <div class="odds-track"><span style="width:${total ? share : 50}%"></span></div>
    <div class="pool-row"><span>YES ${nearAmount(fact.yes_pool)}</span><span>NO ${nearAmount(fact.no_pool)}</span></div>
  </div>`;
}

function factUrl(id) {
  const params = new URLSearchParams({ id });
  if (contract) params.set('contract', contract);
  return `/fact/?${params}`;
}

function proofMarkup() {
  const proof = attestationProof;
  if (proof?.status !== 'verified-and-refused' || !/^[A-Za-z0-9]+$/.test(proof.attestation_tx || '') || !/^[A-Za-z0-9]+$/.test(proof.rejected_quote_tx || '')) return '';
  const registryUrl = `https://testnet.nearblocks.io/address/${encodeURIComponent(proof.registry)}`;
  return `<section class="resolution" aria-labelledby="proof-title">
    <p class="kicker">Sworn registry · ${escapeHTML(proof.model_id)}</p>
    <h3 id="proof-title">The arbiter quote is checked on chain</h3>
    <p>Sworn verified the enclave quote for this model. Changing one byte made the registry refuse it.</p>
    <p>
      <a href="https://testnet.nearblocks.io/txns/${proof.attestation_tx}" target="_blank" rel="noopener">Quote verified ↗</a>
      <br /><a href="https://testnet.nearblocks.io/txns/${proof.rejected_quote_tx}" target="_blank" rel="noopener">Flipped quote refused ↗</a>
      <br /><a href="${registryUrl}" target="_blank" rel="noopener">Registry ${escapeHTML(proof.registry)} ↗</a>
    </p>
  </section>`;
}

async function renderList() {
  const form = document.querySelector('#contract-form');
  const input = form.elements.contract;
  input.value = contract;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    localStorage.setItem('hunch-contract', input.value.trim());
    const params = new URLSearchParams(location.search);
    params.set('contract', input.value.trim());
    location.search = params;
  });
  if (!contract) { app.setAttribute('aria-busy', 'false'); return; }
  message('Reading market state from NEAR testnet.');
  try {
    const rows = await Promise.all(facts.map(async (fact) => ({ meta: fact, live: await view('get_fact', { id: fact.id }) })));
    const list = document.querySelector('#market-list');
    const existing = rows.filter((row) => row.live);
    list.innerHTML = existing.map(({ meta, live }) => `<li class="market-row">
      <a class="market-claim" href="${factUrl(meta.id)}"><span>${escapeHTML(meta.claim)}</span><span class="arrow" aria-hidden="true">↗</span></a>
      <div class="market-meta"><span>${live.status === 'Resolved' ? `Resolved ${live.outcome}` : live.status === 'Pending' ? 'Resolution checking' : 'Open'}</span><span>${nearAmount(BigInt(live.yes_pool) + BigInt(live.no_pool))} staked</span></div>
      <a class="market-odds" href="${factUrl(meta.id)}">${oddsMarkup(live)}<span class="small-link">Open claim</span></a>
    </li>`).join('');
    document.querySelector('#market-count').textContent = `${existing.length} live ${existing.length === 1 ? 'market' : 'markets'}`;
    message(existing.length ? 'Market data read from the contract.' : 'This contract has no seeded claims yet.');
    if (!existing.length) list.innerHTML = '<li class="notice">Create a claim on this contract to begin the first market.</li>';
  } catch (error) { message(error.message, true); }
  finally { app.setAttribute('aria-busy', 'false'); }
}

async function renderFact() {
  const id = query.get('id');
  if (!contract || !id) { message('This fact link needs a claim ID and contract account.', true); app.setAttribute('aria-busy', 'false'); return; }
  const meta = facts.find((item) => item.id === id);
  if (!meta) { message('This claim is not in the current index.', true); app.setAttribute('aria-busy', 'false'); return; }
  try {
    const fact = await view('get_fact', { id });
    if (!fact) return message('This claim has not been created on the selected contract.', true);
    const position = accountId ? await Promise.all(['Yes', 'No'].map((side) => view('get_stake', { id, account: accountId, side }))) : null;
    const generatedText = generatedPages[id];
    message('Live claim state read from NEAR testnet.');
    const viewRoot = document.querySelector('#fact-view');
    viewRoot.hidden = false;
    viewRoot.innerHTML = `<section class="fact-heading">
      <p class="kicker">${fact.status === 'Resolved' ? `Resolved ${fact.outcome}` : fact.status === 'Pending' ? 'Resolution being checked' : 'Claim under review'}</p>
      <h1>${escapeHTML(fact.claim)}</h1>
      <p class="lede">The odds follow NEAR staked on each side. Resolution waits for a provider receipt that the Sworn registry accepts.</p>
    </section>
    ${proofMarkup()}
    ${generatedText ? `<section class="generated-page"><p class="kicker">NEAR AI Cloud page</p><p>${escapeHTML(generatedText)}</p></section>` : ''}
    <section class="market-frame" aria-labelledby="odds-title">
      <div class="market-title"><div><p class="kicker">Current market</p><h2 id="odds-title">${percent(fact.yes_pool, fact.no_pool)} say yes</h2></div><span class="status">${fact.status}</span></div>
      ${oddsMarkup(fact)}
      <div class="pool-total"><span>Total stake</span><strong>${nearAmount(BigInt(fact.yes_pool) + BigInt(fact.no_pool))}</strong></div>
      ${position ? `<div class="position"><p>Your position <span>${escapeHTML(accountId)}</span></p><div><span>YES</span><strong>${nearAmount(position[0])}</strong></div><div><span>NO</span><strong>${nearAmount(position[1])}</strong></div></div>` : ''}
      ${fact.status === 'Open' ? `<form id="stake-form" class="stake-form">
        <label for="amount">Your stake</label><div class="field-row"><input id="amount" name="amount" inputmode="decimal" placeholder="0.1" required /><select name="side" aria-label="Choose your side"><option value="Yes">YES</option><option value="No">NO</option></select><button type="submit">Connect and stake</button></div>
        <p class="field-help">NEAR testnet only. Your wallet signs the transaction.</p><p class="form-error" id="stake-error" role="alert"></p>
      </form>` : ''}
      ${fact.status === 'Resolved' ? `<div class="resolution"><h3>Attested reasoning</h3><p>${escapeHTML(fact.reasoning || 'The signed answer did not include a reasoning field.')}</p><a href="https://testnet.nearblocks.io" target="_blank" rel="noopener">View testnet transactions ↗</a></div>` : ''}
    </section>
    ${renderEvidenceRoom(fact)}`;
    const form = document.querySelector('#stake-form');
    if (form) form.addEventListener('submit', stake);
    app.setAttribute('aria-busy', 'false');
  } catch (error) { message(error.message, true); app.setAttribute('aria-busy', 'false'); }
}

async function stake(event) {
  event.preventDefault();
  const form = event.currentTarget, errorBox = form.querySelector('#stake-error'), button = form.querySelector('button');
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const amount = yocto(form.elements.amount.value);
    const wallet = await connector.connect();
    accountId = (await wallet.getAccounts())[0]?.accountId || '';
    if (!accountId) throw new Error('The connected wallet did not return an account.');
    await wallet.signAndSendTransaction({
      receiverId: contract,
      actions: [{ type: 'FunctionCall', params: { methodName: 'stake', args: { id: query.get('id'), side: form.elements.side.value }, gas: '30000000000000', deposit: amount } }],
    });
    await renderFact();
  } catch (error) { errorBox.textContent = error.message || 'The wallet did not submit the stake.'; }
  finally { button.disabled = false; }
}

if (document.body.dataset.page === 'fact') renderFact(); else renderList();
