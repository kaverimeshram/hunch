import './style.css';
import { query, contract, accountId, onAccount, ensureWallet, disconnectWallet, walletCancelled } from './chain.js';
import { renderDetail } from './detail.js';

const walletButton = document.querySelector('#wallet-button');
const page = document.body.dataset.page;

function paintWallet() {
  walletButton.hidden = false;
  if (accountId()) {
    walletButton.innerHTML = '<span class="wb-id"></span><span class="wb-out"> · Disconnect</span>';
    walletButton.querySelector('.wb-id').textContent = accountId();
    walletButton.title = 'Disconnect wallet';
  } else { walletButton.textContent = 'Connect wallet'; walletButton.removeAttribute('title'); }
  walletButton.classList.toggle('is-connected', Boolean(accountId()));
}

walletButton.addEventListener('click', async () => {
  try {
    if (accountId()) await disconnectWallet(); else await ensureWallet();
  } catch (error) {
    if (!walletCancelled(error)) console.warn('Wallet:', error.message);
  }
});
onAccount(paintWallet);
paintWallet();

if (page === 'fact') {
  const root = document.querySelector('#fact-view');
  const id = query.get('id');
  const draw = () => renderDetail(root, id, { side: query.get('side') || '' });
  if (!id) root.innerHTML = '<p class="notice is-error" role="alert">This claim link needs a claim ID.</p>';
  else { document.title = 'Hunch | Claim'; draw().then((fact) => { if (fact) document.title = `${fact.claim} | Hunch`; onAccount(draw); }); }
  document.querySelector('#back-link').href = `/?contract=${encodeURIComponent(contract)}`;
  document.querySelector('#app').setAttribute('aria-busy', 'false');
} else {
  const { startDeck } = await import('./deck.js');
  startDeck();
}
