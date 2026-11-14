# Hunch

Hunch is a prediction market you play by swiping: swipe right for YES, left for NO, and stake NEAR on a contested claim that an attested AI arbiter settles.

## Who uses it

Readers who want to put a position behind a contested claim, and desks that need an auditable record of how a claim was settled. A visitor with no wallet stakes real testnet NEAR in one swipe through the judge desk.

## How it works

- Each claim is one card with the live YES share, a YES and NO bar and the NEAR staked.
- A swipe on an open claim opens a stake sheet. The judge desk signs the stake from a testnet account, or the visitor's own wallet (Meteor, Intear, MyNearWallet, Nightly, Ledger) signs it.
- After the close time an arbiter answer from NEAR AI Cloud is submitted to the contract. The contract calls the Sworn registry on NEAR, which verifies the model's signature over the exact request and response. Only a verified answer settles the claim.
- Winners claim a pro rata share of both pools. An insufficient answer voids the claim and every staker takes their own stake back.

## Evidence

| Fact | Evidence |
|---|---|
| A cold visitor stakes with no wallet and gets a testnet transaction | [FiKonxGEazZzqkJXfX6Heo7YmV46NsDnptebJYGNGD7y](https://testnet.nearblocks.io/txns/FiKonxGEazZzqkJXfX6Heo7YmV46NsDnptebJYGNGD7y), [9unGUSzNJhRqiLK63eHdxpyv3qjSyMcKg9S42PkxwjZD](https://testnet.nearblocks.io/txns/9unGUSzNJhRqiLK63eHdxpyv3qjSyMcKg9S42PkxwjZD) |
| An attested arbiter answer settles a claim through the Sworn registry | [CzBJufB5Bn68dYnFUJCj8ECkHtj3cwzFka9hUNZhHNjG](https://testnet.nearblocks.io/txns/CzBJufB5Bn68dYnFUJCj8ECkHtj3cwzFka9hUNZhHNjG), `adam-back-satoshi` settles Resolved: No |
| The winning side is paid from both pools | [BNEAR6hynBbmd111qFcQMXfF5U5gasrKa4bDA7sZAwxV](https://testnet.nearblocks.io/txns/BNEAR6hynBbmd111qFcQMXfF5U5gasrKa4bDA7sZAwxV) |
| The registry accepts the genuine quote | [8uaeLKJHYtFdVAHz3QoN9d68pfabQN1BFKvexEVKVUp](https://testnet.nearblocks.io/txns/8uaeLKJHYtFdVAHz3QoN9d68pfabQN1BFKvexEVKVUp) |
| The registry refuses a quote with one byte flipped | [3RMXYbZnPMm88BiLrqNWLFL3Y52xu1LmwncFBSaG9stq](https://testnet.nearblocks.io/txns/3RMXYbZnPMm88BiLrqNWLFL3Y52xu1LmwncFBSaG9stq) |
| Every claim above is re-checked against the live URL, the stake desk and testnet | `npm run judge` (10 checks, also run by CI on every push) |
| Contract unit tests, sandbox tests and the response-hash mutation check | `bash scripts/test.sh` |

## Try it in 60 seconds

1. Open https://hunch-near.vercel.app (NEAR testnet, nothing to install).
2. Press the right arrow key or the YES button on the first card.
3. Press the green Stake button. The sheet shows the transaction hash, the signer and the seconds to finality within about 6 seconds.
4. Open the Adam Back card and tap it: the arbiter's ruling, its reasoning and the resolution and payout transactions are on the first screen.

## Why NEAR

Settlement needs an on-chain check of an enclave signature. The Sworn registry on NEAR verifies the Intel DCAP quote inside the contract call, so a claim cannot settle on an answer the registered model did not sign. NEAR AI Cloud supplies the attested model, and one-second blocks let a stake reach finality while the visitor is still on the sheet.

## Team and build window

Kaveri Meshram, 2026-11-13 to 2026-11-14 (git history: `git log --reverse --format='%ad %an' --date=short`).
