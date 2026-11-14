/*
 * The swipe deck: one claim card at a time. Right is YES, left is NO, up skips. Open markets open a
 * stake sheet after the swipe; closed ones route to the evidence. Gesture maths lives in swipe.js.
 */
import { escapeHTML } from './html.js';
import { nearAmount, toYocto, formatTenths, previewStake, isAcceptingInput, toBigInt } from './market.js';
import { stageOf, priceTexts, volumeOf, deckOrder, formatShortDay } from './claims.js';
import { barMarkup, stageChip, sealMarkup, sealPopMarkup } from './markup.js';
import { decide, stamps, tilt, thresholdFor } from './swipe.js';
import { recordSwipe, swipesFor, resetSwipes, unseen } from './swipes.js';
import { forgetStakeHistory } from './history.js';
import { contract, view, optionalView, indexedFacts, callContract, accountId, walletCancelled, deskStatus, deskStake, EXPLORER, GAS } from './chain.js';
import { renderDetail } from './detail.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const $ = (selector) => document.querySelector(selector);
const stackEl = $('#stack');
const actionsEl = $('#actions');
const sheetEl = $('#sheet');
const detailEl = $('#detail');
const toastEl = $('#toast');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let facts = [];
let swipes = {};
let busy = false;

// ---------- Data ----------

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
  return deckOrder([...byId.values()]);
}

const remaining = () => unseen(facts, swipes);
const factById = (id) => facts.find((fact) => fact.id === id);

// ---------- Card ----------

const SIDE_NAME = { Yes: 'YES', No: 'NO' };

function noteFor(fact) {
  const stage = stageOf(fact);
  if (stage.key === 'open') return '';
  if (stage.key === 'awaiting') return stage.label === 'Verifying quote' ? 'Staking closed, the arbiter quote is being verified' : 'Staking closed, awaiting attested resolution';
  if (stage.key === 'resolved') return `Staking closed, resolved ${fact.outcome === 'Yes' ? 'YES' : 'NO'} by the attested arbiter`;
  return 'Void: every stake is refundable';
}

function cardMarkup(fact, depth, position, total) {
  const price = priceTexts(fact);
  const close = Number(fact.resolve_after);
  const stage = stageOf(fact);
  const note = noteFor(fact);
  const open = stage.key === 'open';
  const big = price.total
    ? `<strong>${Math.round(price.yesTenths / 10)}</strong><sup>%</sup><span>YES</span>`
    : `<strong class="is-empty">No price yet</strong><span>${open ? 'Your stake sets the first price' : 'No stakes were placed'}</span>`;
  const sources = Array.isArray(fact.sources) ? fact.sources.length : 0;
  return `<article class="card" data-id="${escapeHTML(fact.id)}" data-depth="${depth}" data-stage="${stage.key}" aria-label="Claim ${position} of ${total}"${depth ? ' aria-hidden="true"' : ''}>
    <div class="card-top">${stageChip(fact)}${sealMarkup()}</div>
    ${sealPopMarkup()}
    <div class="card-main">
      <h2 class="card-claim">${escapeHTML(fact.claim)}</h2>
      <p class="card-evidence">${sources ? `${sources} ${sources === 1 ? 'source' : 'sources'} in the evidence room` : 'Evidence room open for sources'} · tap the card</p>
    </div>
    <div class="gauge">
      <div class="pct">${big}</div>
      ${barMarkup(fact)}
      <p class="legend"><span class="lg-yes">YES ${price.yesCents}</span><span class="lg-no">NO ${price.noCents}</span></p>
    </div>
    ${note ? `<p class="card-note">${escapeHTML(note)}</p>` : `<p class="card-note card-note-open">Swipe right for YES, left for NO${desk ? '. No wallet needed.' : ''}</p>`}
    <dl class="card-foot">
      <div><dt>Staked</dt><dd>${escapeHTML(nearAmount(volumeOf(fact)))}</dd></div>
      <div><dt>${close > Date.now() ? 'Closes' : 'Ended'}</dt><dd>${escapeHTML(formatShortDay(close))}</dd></div>
      <div><dt>Stakers</dt><dd>${fact.stakers}</dd></div>
    </dl>
    <span class="stamp stamp-yes" aria-hidden="true">YES</span>
    <span class="stamp stamp-no" aria-hidden="true">NO</span>
    <span class="stamp stamp-skip" aria-hidden="true">SKIP</span>
  </article>`;
}

function renderStack() {
  const rem = remaining();
  stackEl.classList.remove('is-loading');
  if (!rem.length) { renderDone(); return; }
  actionsEl.hidden = false;
  document.body.classList.remove('deck-done');
  const total = facts.length;
  const done = total - rem.length;
  const cards = rem.slice(0, 3).map((fact, index) => cardMarkup(fact, index, done + index + 1, total));
  stackEl.innerHTML = cards.reverse().join('');
  attachTop();
  $('#count').textContent = `${done + 1} of ${total}`;
}

function topCard() { return stackEl.querySelector('.card[data-depth="0"]'); }

/** After the top card is swiped away: promote the others and deal one more from the pile. */
function advance() {
  topCard()?.remove();
  const rem = remaining();
  if (!rem.length) { renderDone(); return; }
  const total = facts.length;
  const done = total - rem.length;
  for (const card of stackEl.querySelectorAll('.card')) card.dataset.depth = String(Number(card.dataset.depth) - 1);
  for (const card of stackEl.querySelectorAll('.card')) card.toggleAttribute('aria-hidden', card.dataset.depth !== '0');
  if (rem.length >= 3) stackEl.insertAdjacentHTML('afterbegin', cardMarkup(rem[2], 2, done + 3, total));
  attachTop();
  $('#count').textContent = `${done + 1} of ${total}`;
}

// ---------- Gestures ----------

function attachTop() {
  const el = topCard();
  if (!el) return;
  const seal = el.querySelector('.seal');
  seal?.addEventListener('click', () => {
    const pop = el.querySelector('.seal-pop');
    pop.hidden = !pop.hidden;
    seal.setAttribute('aria-expanded', String(!pop.hidden));
  });
  if (reduceMotion.matches) { el.addEventListener('click', (event) => { if (!event.target.closest('button, a')) openDetails(); }); return; }
  el.addEventListener('pointerdown', (event) => {
    if (busy || (event.pointerType === 'mouse' && event.button !== 0) || event.target.closest('button, a, .seal-pop')) return;
    const startX = event.clientX, startY = event.clientY, startedAt = performance.now();
    const threshold = thresholdFor(el.offsetWidth);
    let dx = 0, dy = 0;
    el.classList.add('is-dragging');
    const move = (e) => {
      dx = e.clientX - startX;
      dy = e.clientY - startY;
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${tilt(dx, el.offsetWidth)}deg)`;
      const s = stamps(dx, dy, threshold);
      el.style.setProperty('--o-yes', s.yes);
      el.style.setProperty('--o-no', s.no);
      el.style.setProperty('--o-skip', s.skip);
    };
    const end = (e) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      el.classList.remove('is-dragging');
      const action = e.type === 'pointercancel' ? null : decide(dx, dy, threshold);
      if (action) { commit(action, { dx, dy }); return; }
      const tap = e.type === 'pointerup' && Math.hypot(dx, dy) < 8 && performance.now() - startedAt < 450;
      resetCard(el);
      if (tap) openDetails();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
}

function resetCard(el) {
  el.style.transform = '';
  el.style.removeProperty('--o-yes');
  el.style.removeProperty('--o-no');
  el.style.removeProperty('--o-skip');
}

/** Fly the top card off in the swipe direction, then act on it. */
async function commit(action, { dx = 0, dy = 0 } = {}) {
  const el = topCard();
  if (!el || busy) return;
  busy = true;
  const fact = factById(el.dataset.id);
  if (!reduceMotion.matches) {
    const w = window.innerWidth, h = window.innerHeight;
    const x = action === 'yes' ? w * 1.2 : action === 'no' ? -w * 1.2 : dx;
    const y = action === 'skip' ? -h : dy + 40;
    el.classList.add('is-flying');
    el.style.setProperty(`--o-${action}`, 1);
    el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${action === 'skip' ? 0 : action === 'yes' ? 26 : -26}deg)`;
    await wait(320);
  }
  busy = false;
  if (action === 'skip') { recordSwipe(contract, { id: fact.id, side: null, kind: 'skip' }); swipes = swipesFor(contract); advance(); return; }
  const side = action === 'yes' ? 'Yes' : 'No';
  if (isAcceptingInput(fact)) { openSheet(fact, side); return; }
  recordSwipe(contract, { id: fact.id, side, kind: 'opinion' });
  swipes = swipesFor(contract);
  advance();
  openDetails(fact.id, { lean: side, focus: 'evidence-title' });
}

function returnCard() {
  const el = topCard();
  if (!el) return;
  el.classList.remove('is-flying');
  resetCard(el);
}

// ---------- Stake sheet ----------

let sheetState = null;

const AMOUNTS = { desk: ['0.01', '0.05', '0.1'], wallet: ['0.1', '0.5', '1'] };
let desk = null;
deskStatus().then((status) => { desk = status; });

async function openSheet(fact, side) {
  // The desk status is prefetched at load; if the visitor swipes before it answers, wait for it so the sheet opens in the right mode.
  if (!desk) desk = await deskStatus();
  const mode = desk && !accountId() ? 'desk' : 'wallet';
  sheetState = { fact, side, mode, amount: AMOUNTS[mode][mode === 'desk' ? 1 : 1], ownYes: 0n, ownNo: 0n, sending: false };
  sheetEl.hidden = false;
  document.body.classList.add('locked');
  paintSheet();
  sheetEl.querySelector('input').focus({ preventScroll: true });
  if (accountId() && mode === 'wallet') {
    Promise.all(['Yes', 'No'].map((s) => view('get_stake', { id: fact.id, account: accountId(), side: s })))
      .then(([yes, no]) => { if (sheetState?.fact === fact) { sheetState.ownYes = toBigInt(yes); sheetState.ownNo = toBigInt(no); updateSheet(); } })
      .catch(() => {});
  }
}

function switchMode() {
  if (sheetState.sending) return;
  sheetState.mode = sheetState.mode === 'desk' ? 'wallet' : 'desk';
  sheetState.amount = AMOUNTS[sheetState.mode][1];
  paintSheet();
}

function paintSheet() {
  const { fact, side, mode } = sheetState;
  const price = priceTexts(fact);
  const name = SIDE_NAME[side];
  const isDesk = mode === 'desk';
  const other = isDesk
    ? '<button type="button" class="btn-ghost" data-mode>Use my own wallet instead</button>'
    : (desk ? '<button type="button" class="btn-ghost" data-mode>No wallet? Let the judge desk stake</button>' : '');
  const help = isDesk
    ? 'Real NEAR testnet transaction. The judge desk account pays the stake and the gas, so there is nothing to install.'
    : `NEAR testnet. Your wallet signs the stake. ${accountId() ? '' : 'Connect a wallet when you confirm. '}Payout assumes no one else stakes before the market closes.`;
  sheetEl.innerHTML = `<div class="sheet-scrim" data-cancel></div>
  <form class="sheet-panel sheet-${side === 'Yes' ? 'yes' : 'no'}" id="stake-sheet" novalidate role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <span class="sheet-grab" aria-hidden="true"></span>
    <p class="sheet-kicker"><span class="dot"></span>You swiped ${name}</p>
    <h2 id="sheet-title" class="sheet-claim">${escapeHTML(fact.claim)}</h2>
    <label class="sr-only" for="sheet-amount">Amount in NEAR</label>
    <div class="amount-field"><input id="sheet-amount" name="amount" inputmode="decimal" autocomplete="off" value="${sheetState.amount}" /><span aria-hidden="true">NEAR</span></div>
    <div class="quick" role="group" aria-label="Quick amounts">${AMOUNTS[mode].map((a) => `<button type="button" class="quick-btn" data-amount="${a}" aria-pressed="${a === sheetState.amount}">${a} NEAR</button>`).join('')}</div>
    <dl class="preview" aria-live="polite">
      <div><dt>${name} share after</dt><dd id="pv-share">${price.yesPct}</dd></div>
      <div><dt>Payout if ${name} wins</dt><dd id="pv-payout">-</dd></div>
      <div><dt>Profit</dt><dd id="pv-profit">-</dd></div>
    </dl>
    <button type="submit" class="btn-stake" id="stake-submit">Stake</button>
    ${other}
    <button type="button" class="btn-ghost" data-cancel>Cancel</button>
    <p class="form-error" id="stake-error" role="alert"></p>
    <p class="sheet-help">${help}</p>
  </form>`;
  updateSheet();
}

function updateSheet() {
  const form = sheetEl.querySelector('form');
  if (!form || !sheetState) return;
  const { fact, side, ownYes, ownNo } = sheetState;
  const name = SIDE_NAME[side];
  sheetState.amount = form.elements.amount.value;
  for (const chip of form.querySelectorAll('.quick-btn')) chip.setAttribute('aria-pressed', String(chip.dataset.amount === sheetState.amount.trim()));
  const submit = form.querySelector('#stake-submit');
  let amount = null;
  try { amount = toYocto(sheetState.amount); } catch { amount = null; }
  const price = priceTexts(fact);
  if (amount === null) {
    form.querySelector('#pv-share').textContent = price.yesPct;
    form.querySelector('#pv-payout').textContent = '-';
    form.querySelector('#pv-profit').textContent = '-';
    submit.textContent = 'Enter an amount';
    submit.disabled = true;
    return;
  }
  const preview = previewStake(fact, side, amount, ownYes, ownNo);
  form.querySelector('#pv-share').textContent = formatTenths(side === 'Yes' ? preview.afterTenths : 1000 - preview.afterTenths);
  form.querySelector('#pv-payout').textContent = nearAmount(preview.payout);
  const profit = form.querySelector('#pv-profit');
  profit.textContent = preview.profit > 0n ? `+${nearAmount(preview.profit)}` : preview.profit < 0n ? `-${nearAmount(-preview.profit)}` : nearAmount(0n);
  profit.dataset.sign = preview.profit > 0n ? 'gain' : preview.profit < 0n ? 'loss' : 'flat';
  submit.textContent = `Stake ${name} ${nearAmount(amount)}`;
  submit.disabled = sheetState.sending;
}

function closeSheet() {
  sheetEl.hidden = true;
  sheetEl.innerHTML = '';
  sheetState = null;
  document.body.classList.remove('locked');
}

function cancelSheet() {
  if (sheetState?.sending) return;
  if (sheetState?.done) { closeSheet(); advance(); return; }
  closeSheet();
  returnCard();
}

/** Wait for the contract to show the stake: the pool of the chosen side must grow by the amount. */
async function confirmStake(fact, side, amount) {
  const key = side === 'Yes' ? 'yes_pool' : 'no_pool';
  const target = toBigInt(fact[key]) + BigInt(amount);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fresh = await view('get_fact', { id: fact.id });
    if (fresh && toBigInt(fresh[key]) >= target) return fresh;
    await wait(1500);
  }
  return null;
}

const shortTx = (tx) => `${tx.slice(0, 8)}…${tx.slice(-6)}`;

function paintReceipt(result, fresh, side) {
  const name = SIDE_NAME[side];
  sheetEl.querySelector('form').innerHTML = `<span class="sheet-grab" aria-hidden="true"></span>
    <p class="sheet-kicker"><span class="dot"></span>Staked on NEAR testnet</p>
    <h2 id="sheet-title" class="sheet-claim">${nearAmount(result.amount)} on ${name}</h2>
    <dl class="receipt">
      <div><dt>Transaction</dt><dd><a href="${EXPLORER}/txns/${encodeURIComponent(result.tx)}" target="_blank" rel="noopener">${shortTx(result.tx)}</a></dd></div>
      <div><dt>Signed by</dt><dd>${escapeHTML(result.account)}</dd></div>
      <div><dt>Time to finality</dt><dd>${result.seconds.toFixed(1)} s</dd></div>
      <div><dt>YES share now</dt><dd id="rc-share">${fresh ? formatTenths(priceTexts(fresh).yesTenths) : 'reading the chain'}</dd></div>
    </dl>
    <a class="btn-stake btn-link" href="${EXPLORER}/txns/${encodeURIComponent(result.tx)}" target="_blank" rel="noopener">Open the transaction on NearBlocks</a>
    <button type="button" class="btn-ghost" data-next>Next claim</button>`;
  sheetEl.querySelector('[data-next]').focus({ preventScroll: true });
}

async function submitSheet(event) {
  event.preventDefault();
  const form = event.target;
  if (!sheetState || sheetState.sending) return;
  const errorBox = form.querySelector('#stake-error');
  const submit = form.querySelector('#stake-submit');
  errorBox.textContent = '';
  const { fact, side, mode } = sheetState;
  let amount;
  try { amount = toYocto(form.elements.amount.value); } catch (error) { errorBox.textContent = error.message; return; }
  sheetState.sending = true;
  submit.disabled = true;
  submit.textContent = mode === 'desk' ? 'Signing on NEAR testnet' : 'Waiting for your wallet';
  try {
    let result = null;
    if (mode === 'desk') {
      result = await deskStake(fact.id, side, amount);
      sheetState.sending = false;
      sheetState.done = true;
      paintReceipt(result, null, side);
    } else await callContract('stake', { id: fact.id, side }, amount, GAS.stake);
    if (!result) submit.textContent = 'Confirming on chain';
    forgetStakeHistory(contract);
    const fresh = await confirmStake(fact, side, amount);
    if (fresh) facts = facts.map((f) => (f.id === fresh.id ? fresh : f));
    recordSwipe(contract, { id: fact.id, side, kind: 'staked', amount: nearAmount(amount) });
    swipes = swipesFor(contract);
    if (result) {
      const share = sheetEl.querySelector('#rc-share');
      if (share) share.textContent = fresh ? formatTenths(priceTexts(fresh).yesTenths) : 'updates with the next block';
      return;
    }
    closeSheet();
    advance();
    toast(fresh
      ? `Staked ${nearAmount(amount)} on ${SIDE_NAME[side]}. YES share is now ${formatTenths(priceTexts(fresh).yesTenths)}.`
      : `Staked ${nearAmount(amount)} on ${SIDE_NAME[side]}. The odds update once the block finalises.`);
  } catch (error) {
    sheetState.sending = false;
    errorBox.textContent = walletCancelled(error) ? 'Wallet closed. Nothing was staked.' : (error.message || 'The stake did not go through.');
    updateSheet();
    if (error.wallet && desk) form.querySelector('[data-mode]')?.focus();
  }
}

sheetEl.addEventListener('click', (event) => {
  if (event.target.closest('[data-next]')) { closeSheet(); advance(); return; }
  if (event.target.closest('[data-mode]')) { switchMode(); return; }
  if (event.target.closest('[data-cancel]')) { if (sheetState?.done) { closeSheet(); advance(); } else cancelSheet(); }
});
sheetEl.addEventListener('input', (event) => { if (event.target.name === 'amount') updateSheet(); });
sheetEl.addEventListener('submit', submitSheet);
sheetEl.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-amount]');
  if (!chip) return;
  sheetEl.querySelector('input').value = chip.dataset.amount;
  updateSheet();
});

// ---------- Detail overlay ----------

let detailOpen = false;

function openDetails(id = topCard()?.dataset.id, { lean = '', focus = '' } = {}) {
  if (!id || detailOpen) return;
  detailOpen = true;
  detailEl.hidden = false;
  document.body.classList.add('locked');
  history.pushState({ detail: id }, '', `#${encodeURIComponent(id)}`);
  const body = detailEl.querySelector('#detail-body');
  detailEl.scrollTop = 0;
  renderDetail(body, id, { lean, onChange: refreshFacts }).then(() => {
    if (focus) body.querySelector(`#${focus}`)?.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
  });
  detailEl.querySelector('[data-close]').focus({ preventScroll: true });
}

function closeDetails({ fromPop = false } = {}) {
  if (!detailOpen) return;
  detailOpen = false;
  detailEl.hidden = true;
  detailEl.querySelector('#detail-body').innerHTML = '';
  document.body.classList.remove('locked');
  if (!fromPop && location.hash) history.back();
}

detailEl.addEventListener('click', (event) => { if (event.target.closest('[data-close]')) closeDetails(); });
window.addEventListener('popstate', () => { if (detailOpen) closeDetails({ fromPop: true }); });

async function refreshFacts() {
  try {
    facts = await loadFacts();
    if (!detailOpen) renderStack();
  } catch { /* the deck keeps the facts it has */ }
}

// ---------- Done state ----------

function swipeStatus(swipe) {
  if (swipe.kind === 'staked') return `Staked ${swipe.amount} on ${SIDE_NAME[swipe.side]}`;
  if (swipe.kind === 'opinion') return `Leaned ${SIDE_NAME[swipe.side]}, staking closed`;
  return 'Skipped';
}

function renderDone() {
  actionsEl.hidden = true;
  document.body.classList.add('deck-done');
  const rows = facts.filter((fact) => swipes[fact.id]).map((fact) => {
    const swipe = swipes[fact.id];
    const tone = swipe.side ? (swipe.side === 'Yes' ? 'yes' : 'no') : 'skip';
    return `<li><button type="button" class="done-row" data-open="${escapeHTML(fact.id)}"><span class="done-tag done-${tone}">${swipe.side ? SIDE_NAME[swipe.side] : 'SKIP'}</span><span class="done-claim">${escapeHTML(fact.claim)}</span><span class="done-status">${escapeHTML(swipeStatus(swipe))} · ${escapeHTML(stageOf(fact).label)}</span></button></li>`;
  }).join('');
  stackEl.innerHTML = `<section class="done" aria-labelledby="done-title">
    <h2 id="done-title">You've seen every claim</h2>
    ${rows ? `<ul class="done-list">${rows}</ul>` : '<p class="done-empty">This contract has no claims yet.</p>'}
    <div class="done-actions">
      ${rows ? '<button type="button" class="btn-stake btn-plain" data-restart>Deal the stack again</button>' : ''}
      <form class="contract-form" id="contract-form"><label for="contract-id">Contract</label><div><input id="contract-id" name="contract" autocomplete="off" spellcheck="false" required /><button type="submit">Load</button></div></form>
    </div>
  </section>`;
  const input = stackEl.querySelector('#contract-id');
  input.value = contract;
}

stackEl.addEventListener('click', (event) => {
  const row = event.target.closest('[data-open]');
  if (row) openDetails(row.dataset.open);
  if (event.target.closest('[data-restart]')) { resetSwipes(contract); swipes = {}; renderStack(); }
});
stackEl.addEventListener('submit', (event) => {
  if (event.target.id !== 'contract-form') return;
  event.preventDefault();
  const value = event.target.elements.contract.value.trim();
  localStorage.setItem('hunch-contract', value);
  const params = new URLSearchParams(location.search);
  params.set('contract', value);
  location.search = params;
});

// ---------- Toast, buttons, keys ----------

let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 5200);
}

actionsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  if (act === 'details') openDetails(); else commit(act);
});

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Escape') {
    if (sheetState) cancelSheet(); else closeDetails();
    return;
  }
  if (sheetState || detailOpen || busy || !topCard()) return;
  if (event.target.closest('input, textarea, select')) return;
  const map = { ArrowRight: 'yes', ArrowLeft: 'no', ArrowUp: 'skip' };
  if (map[event.key]) { event.preventDefault(); commit(map[event.key]); }
  else if (event.key === 'Enter' && !event.target.closest('button, a')) openDetails();
});

// ---------- Start ----------

export async function startDeck() {
  swipes = swipesFor(contract);
  try {
    facts = await loadFacts();
    if (!desk) desk = await Promise.race([deskStatus(), wait(2500).then(() => null)]);
    if (!facts.length) { renderDone(); return; }
    renderStack();
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash && factById(hash)) openDetails(hash);
  } catch (error) {
    stackEl.classList.remove('is-loading');
    stackEl.innerHTML = `<section class="done"><h2>The claims did not load</h2><p class="done-empty">${escapeHTML(error.message)}</p><div class="done-actions"><button type="button" class="btn-stake btn-plain" onclick="location.reload()">Try again</button></div></section>`;
  } finally {
    document.querySelector('#app').setAttribute('aria-busy', 'false');
  }
}
