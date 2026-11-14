/*
 * Claim detail: odds, stake ticket, stake history chart, how it resolves and the evidence room.
 * Used inside the deck's overlay and as the standalone /fact/?id= page.
 */
import { escapeHTML } from './html.js';
import { renderEvidenceRoom, evidenceFromChain, evidenceFromFact, evidenceSummaryMarkup, validateEvidenceInput } from './evidence.js';
import { nearAmount, toYocto, formatTenths, payoutFor, statusLabel, isAcceptingInput, toBigInt, previewStake } from './market.js';
import { seriesFor, reconciles, cachedStakeHistory, forgetStakeHistory } from './history.js';
import { chartSvg } from './chart.js';
import { priceTexts, volumeOf, formatTime, formatDay, shortHash, shortAccount } from './claims.js';
import { stageChip, barMarkup, proofLinks, SEAL_ICON } from './markup.js';
import { contract, view, optionalView, callContract, ensureWallet, accountId, walletReady, attestationProof, proofValid, resolutionLinks, EXPLORER, GAS, DEFAULT_EVIDENCE_DEPOSIT, DEFAULT_GRACE_MS } from './chain.js';

const VERDICT_LABEL = { Yes: 'Claim judged true', No: 'Claim judged false', Insufficient: 'Insufficient evidence' };
const QUICK_AMOUNTS = ['0.1', '0.5', '1', '5'];

function proofMarkup() {
  if (!proofValid()) return '';
  const registryUrl = `${EXPLORER}/address/${encodeURIComponent(attestationProof.registry)}`;
  return `<div class="proof">
    <p class="trust-head">${SEAL_ICON}<span>Sworn registry · <code>${escapeHTML(attestationProof.model_id)}</code></span></p>
    <h3 id="proof-title">The arbiter quote is checked on chain</h3>
    <p>Sworn verified the enclave quote for this model. Changing one byte made the registry refuse it.</p>
    <div class="proof-links">${proofLinks()}<a class="proof-link" href="${registryUrl}" target="_blank" rel="noopener">Registry ${escapeHTML(attestationProof.registry)} ↗</a></div>
  </div>`;
}

/** Above the fold for a settled claim, read like a verdict: the question, the evidence weighed, the enclave proof, the ruling and the payout. */
function verdictBanner(fact) {
  if (fact.status !== 'Resolved' || !fact.outcome) return '';
  const links = resolutionLinks(fact.id);
  const side = fact.outcome === 'Yes' ? 'YES' : 'NO';
  const tx = (hash, label) => `<a href="${EXPLORER}/txns/${encodeURIComponent(hash)}" target="_blank" rel="noopener">${label} ↗</a>`;
  const sources = evidenceFromFact(fact).length;
  const enclave = proofValid()
    ? `<li><span class="vs-n">3</span><div><h3>Enclave proof</h3><p>The arbiter ran inside a TEE as <code>${escapeHTML(attestationProof.model_id)}</code>. The Sworn registry verified its signed quote on NEAR testnet.</p><p class="verdict-links">${tx(attestationProof.attestation_tx, 'Quote verified')}${tx(attestationProof.rejected_quote_tx, 'Flipped quote refused')}</p></div></li>`
    : '';
  return `<section class="verdict-banner verdict-${fact.outcome === 'Yes' ? 'yes' : 'no'}" aria-label="Resolution">
    <p class="verdict-ruling">${SEAL_ICON}<span>The attested arbiter ruled</span><b class="verdict-stamp">${side}</b></p>
    <ol class="verdict-steps">
      <li><span class="vs-n">1</span><div><h3>Evidence it weighed</h3><p>${sources ? `${sources} ${sources === 1 ? 'source' : 'sources'} from the evidence room.` : 'The sources attached to this claim.'}${fact.reasoning ? ` ${escapeHTML(fact.reasoning)}` : ''}</p></div></li>
      <li><span class="vs-n">2</span><div><h3>Ruling</h3><p>${side}. The contract accepted it only after the registry check.</p>${links ? `<p class="verdict-links">${tx(links.resolve_tx, 'Resolution transaction')}</p>` : ''}</div></li>
      ${enclave}
      <li><span class="vs-n">${proofValid() ? 4 : 3}</span><div><h3>Payout</h3><p>The ${side} side was paid from the pool.</p>${links?.claim_tx ? `<p class="verdict-links">${tx(links.claim_tx, 'Winner payout')}</p>` : ''}</div></li>
    </ol>
  </section>`;
}

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
  const steps = '<ol class="how-steps"><li><span class="step-n">1</span><h3>Evidence room</h3><p>Sources are grouped by stance below.</p></li><li><span class="step-n">2</span><h3>Arbiter in an enclave</h3><p>An AI model judges the evidence and signs its answer.</p></li><li><span class="step-n">3</span><h3>Quote checked on chain</h3><p>Sworn verifies the quote. The market settles only if it passes.</p></li></ol>';
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

function ticketBody(fact, config, position, claimed, preselect) {
  const price = priceTexts(fact);
  const own = position ? `<div class="position"><p>Your position <span>${escapeHTML(shortAccount(accountId()))}</span></p><div><span>YES</span><strong>${nearAmount(position[0])}</strong></div><div><span>NO</span><strong>${nearAmount(position[1])}</strong></div></div>` : '';
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
        <div><dt id="pv-payout-label">Payout if Yes wins</dt><dd id="pv-payout">-</dd></div>
        <div><dt>Profit</dt><dd id="pv-profit">-</dd></div>
      </dl>
      <button type="submit" class="btn btn-trade" id="stake-submit">${accountId() ? 'Stake' : 'Connect wallet to stake'}</button>
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
  const verb = () => (accountId() ? 'Stake' : 'Connect wallet to stake');
  const update = () => {
    const side = form.elements.side.value;
    form.querySelector('#pv-payout-label').textContent = `Payout if ${side} wins`;
    submit.classList.toggle('is-no', side === 'No');
    let amount = null;
    try { amount = toYocto(form.elements.amount.value); } catch { amount = null; }
    const filled = form.elements.amount.value.trim() !== '';
    if (amount === null) {
      form.querySelector('#pv-share').textContent = price.yesPct;
      form.querySelector('#pv-payout').textContent = '-';
      form.querySelector('#pv-profit').textContent = '-';
      submit.textContent = accountId() ? (filled ? 'Enter a valid amount' : 'Stake') : 'Connect wallet to stake';
      return;
    }
    const preview = previewStake(fact, side, amount, ownYes, ownNo);
    form.querySelector('#pv-share').textContent = formatTenths(preview.afterTenths);
    form.querySelector('#pv-payout').textContent = nearAmount(preview.payout);
    const profitCell = form.querySelector('#pv-profit');
    profitCell.textContent = preview.profit > 0n ? `+${nearAmount(preview.profit)}` : preview.profit < 0n ? `-${nearAmount(-preview.profit)}` : nearAmount(0n);
    profitCell.dataset.sign = preview.profit > 0n ? 'gain' : preview.profit < 0n ? 'loss' : 'flat';
    submit.textContent = `${verb()} ${nearAmount(amount)} on ${side}`;
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
    slot.innerHTML = `<p class="chart-empty">The stakes NearBlocks lists do not add up to this contract's pools yet, so no chart is drawn. <a href="${EXPLORER}/address/${encodeURIComponent(contract)}" target="_blank" rel="noopener noreferrer">Contract transactions ↗</a></p>`;
    return;
  }
  if (!series.length) { slot.innerHTML = '<p class="chart-empty">No stakes yet. The chart starts with the first stake and every point is a real transaction.</p>'; return; }
  const frame = Object.assign(document.createElement('div'), { className: 'chart-frame' });
  slot.innerHTML = '';
  slot.append(frame);
  slot.insertAdjacentHTML('beforeend', activityMarkup(series));
  const draw = () => { frame.innerHTML = chartSvg(series, { width: Math.max(260, Math.round(frame.clientWidth)), height: frame.clientWidth < 480 ? 200 : 240 }); };
  draw();
  let lastWidth = frame.clientWidth;
  chartObserver = new ResizeObserver(() => { if (Math.abs(frame.clientWidth - lastWidth) > 4) { lastWidth = frame.clientWidth; draw(); } });
  chartObserver.observe(frame);
}

/**
 * Render the detail view for claim `id` into `root`. Returns the fact, or null when it could not load.
 * options.side preselects a side on the ticket; options.lean shows the opinion banner for a closed market;
 * options.onChange runs after the visitor's transaction landed so the caller can refresh its own data.
 */
export async function renderDetail(root, id, { side = '', lean = '', onChange = () => {} } = {}) {
  root.setAttribute('aria-busy', 'true');
  root.innerHTML = '<p class="notice" role="status">Loading the live claim.</p>';
  const fail = (text) => { root.innerHTML = `<p class="notice is-error" role="alert">${escapeHTML(text)}</p>`; root.setAttribute('aria-busy', 'false'); return null; };
  try {
    const fact = await view('get_fact', { id });
    if (!fact) return fail('This claim has not been created on the selected contract.');
    await Promise.race([walletReady, new Promise((resolve) => setTimeout(resolve, 2500))]);
    const account = accountId();
    const [config, submittedRaw, history, position, claimed] = await Promise.all([
      optionalView('get_config', {}, null),
      optionalView('get_evidence', { fact_id: id }, null),
      optionalView('get_resolution_history', { id }, null),
      account ? Promise.all(['Yes', 'No'].map((s) => view('get_stake', { id, account, side: s }))) : null,
      account ? optionalView('get_claimed', { id, account }, false) : false,
    ]);
    const submitted = evidenceFromChain(id, submittedRaw);
    const price = priceTexts(fact);
    const closeLabel = Number(fact.resolve_after) > Date.now() ? 'Closes' : 'Ended';
    const refresh = async () => { forgetStakeHistory(contract); await renderDetail(root, id, { side }); onChange(); };
    root.innerHTML = `<div class="claim-layout">
      <header class="claim-head">
        <div class="head-chips">${stageChip(fact)}</div>
        <h1 id="detail-title">${escapeHTML(fact.claim)}</h1>
        ${lean ? `<p class="lean lean-${lean === 'Yes' ? 'yes' : 'no'}">You leaned <b>${lean === 'Yes' ? 'YES' : 'NO'}</b>. Staking is closed on this claim, so here is the evidence behind the call.</p>` : ''}
        <div class="claim-numbers">
          <div class="chance"><strong${price.total ? '' : ' class="is-empty"'}>${price.yesPct}</strong><span>${price.total ? 'YES share of staked NEAR' : 'no stakes yet'}</span></div>
          ${barMarkup(fact)}
          <dl class="claim-stats">
            <div><dt>Total staked</dt><dd>${nearAmount(volumeOf(fact))}</dd></div>
            <div><dt>Stakers</dt><dd>${fact.stakers}</dd></div>
            <div><dt>${closeLabel}</dt><dd>${escapeHTML(formatDay(fact.resolve_after))}</dd></div>
          </dl>
        </div>
        ${verdictBanner(fact)}
        ${proofValid() ? `<p class="trust-strip">${SEAL_ICON}<span>Settles only on an attested arbiter quote.</span>${proofLinks()}<a href="#resolves" data-jump="resolves">How this resolves</a></p>` : ''}
        ${evidenceSummaryMarkup(fact, submitted)}
      </header>
      <aside class="ticket" aria-labelledby="ticket-title">
        <h2 id="ticket-title">${isAcceptingInput(fact) ? 'Stake on this claim' : 'Position'}</h2>
        ${ticketBody(fact, config, position, claimed, side)}
      </aside>
      <section class="panel chart-panel" aria-labelledby="chart-title">
        <div class="panel-head"><h2 id="chart-title">YES share over time</h2><span class="muted">From on-chain stakes</span></div>
        <div id="chart-slot" class="chart-slot"><p class="chart-empty">Reading stake history.</p></div>
      </section>
      <div class="claim-rest">
        ${howResolvesMarkup(fact, history)}
        ${renderEvidenceRoom(fact, {
          submitted,
          form: submittedRaw === null ? null : {
            open: isAcceptingInput(fact),
            closedReason: `Evidence submission closed ${formatTime(fact.resolve_after)}.`,
            connected: Boolean(account),
            depositLabel: nearAmount(config?.evidence_deposit ?? DEFAULT_EVIDENCE_DEPOSIT),
          },
        })}
      </div>
    </div>`;

    const ctx = { id, existingUrls: [...evidenceFromFact(fact), ...submitted].map((item) => item.url), config, refresh };
    wireTicket(root, fact, position);
    root.querySelector('#stake-form')?.addEventListener('submit', (event) => stake(event, ctx));
    root.querySelector('#evidence-form')?.addEventListener('submit', (event) => submitEvidence(event, ctx));
    root.querySelector('[data-action="claim"]')?.addEventListener('click', (event) => runAction(event, root, '#claim-error', () => callContract('claim', { id }, '0', GAS.claim), refresh));
    root.querySelector('[data-action="void"]')?.addEventListener('click', (event) => runAction(event, root, '#void-error', () => callContract('void_expired', { id }, '0', GAS.void), refresh));
    root.querySelector('[data-action="connect"]')?.addEventListener('click', (event) => runAction(event, root, null, ensureWallet, refresh));
    root.querySelector('[data-jump]')?.addEventListener('click', (event) => { event.preventDefault(); root.querySelector('#resolves')?.scrollIntoView({ behavior: 'smooth' }); });
    root.setAttribute('aria-busy', 'false');
    const slot = root.querySelector('#chart-slot');
    cachedStakeHistory(contract)
      .then(({ events }) => fillChart(slot, fact, events))
      .catch(() => { slot.innerHTML = '<p class="chart-empty">The stake chart is resting. The odds above are read live from the contract.</p>'; });
    return fact;
  } catch (error) { return fail(error.message); }
}

async function runAction(event, root, errorSelector, action, refresh) {
  const button = event.currentTarget;
  const errorBox = errorSelector ? root.querySelector(errorSelector) : null;
  button.disabled = true;
  if (errorBox) errorBox.textContent = '';
  try { await action(); await refresh(); }
  catch (error) { if (errorBox) errorBox.textContent = error.message || 'The wallet did not submit the transaction.'; }
  finally { button.disabled = false; }
}

async function stake(event, { id, refresh }) {
  event.preventDefault();
  const form = event.currentTarget, errorBox = form.querySelector('#stake-error'), button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const amount = toYocto(form.elements.amount.value);
    await callContract('stake', { id, side: form.elements.side.value }, amount, GAS.stake);
    await refresh();
  } catch (error) { errorBox.textContent = error.message || 'The wallet did not submit the stake.'; }
  finally { button.disabled = false; }
}

async function submitEvidence(event, { id, config, existingUrls, refresh }) {
  event.preventDefault();
  const form = event.currentTarget, errorBox = form.querySelector('#evidence-error'), button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const result = validateEvidenceInput({ url: form.elements.url.value, stance: form.elements.stance.value, note: form.elements.note.value }, existingUrls);
    if (result.error) throw new Error(result.error);
    await callContract('submit_evidence', { fact_id: id, ...result.value }, String(config?.evidence_deposit ?? DEFAULT_EVIDENCE_DEPOSIT), GAS.evidence);
    await refresh();
  } catch (error) { errorBox.textContent = error.message || 'The wallet did not submit the evidence.'; }
  finally { button.disabled = false; }
}
