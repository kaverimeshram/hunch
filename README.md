Hunch gives contested claims a public NEAR market where readers inspect sources, live YES or NO stakes, and the evidence used to settle each claim.

[![judge](https://github.com/kaverimeshram/hunch/actions/workflows/judge.yml/badge.svg)](https://github.com/kaverimeshram/hunch/actions/workflows/judge.yml)

**Live demo (NEAR testnet):** [hunch-near.vercel.app](https://hunch-near.vercel.app). It reads a test contract and uses testnet NEAR only.

The contract records each claim, its source URLs, both stake pools, and each account's position. Odds are the share of NEAR in each pool. A NEAR AI Cloud answer can resolve a market only after the contract asks Sworn's on-chain registry to verify the registered model key and the signature over that exact request and response. Winners claim a pro rata share of the pools.

How a market settles:

- The arbiter prompt contains the claim and its evidence only. It never includes stakes or odds, so market sentiment cannot steer the judgment.
- The attested answer is `yes`, `no` or `insufficient`. `insufficient`, or an answer for a side nobody staked, voids the market and every staker can claim their own stake back.
- If no attested resolution arrives within 14 days of the deadline, anyone can call `void_expired` and stakes become refundable. Funds cannot be locked forever.
- Every settlement is appended to an on-chain resolution history with the attestation hashes, key and signature Sworn verified. Attestation proves the answer came unaltered from the registered model. It does not prove the answer is correct.

Evidence: any account can submit an https source with a stance (Supporting, Contradicting, Context or Unclassified) and an optional note of up to 280 bytes, attaching a 0.01 NEAR storage deposit. URLs are normalised and duplicates refused, with up to 16 submissions per claim until its deadline. A curator appointed by the contract account (`set_curator`) can mark submissions Reviewed or Rejected. Review checks that a source is relevant and genuine, not that it is accurate. Rejected sources stay visible but are left out of the arbiter prompt.

The web app is a swipe deck. Each claim is one card with the live YES share, a YES/NO bar and the NEAR staked. Swipe right (or press the right arrow) for YES, left for NO, up to skip. A swipe on an open market opens a stake sheet with a payout preview computed from the contract's own payout math, and the stake is signed by the judge desk or by your wallet. Cards sit in a stack with two cards behind, a dragged card carries a stamp that grows with the drag and a released card springs back; a fast flick commits. Closed markets take a swipe as an opinion and open the evidence room. Tapping a card opens the claim room: sources grouped by stance, the stake history drawn from real transactions, the brass seal's proof links and the reasoning attached to a verified resolution. A settled claim opens as a verdict: the evidence the arbiter weighed, its ruling, the enclave proof and the payout transaction. The first card paints from a static snapshot of the chain and refreshes from NEAR testnet a moment later. The deck reads a contract account on NEAR testnet without a wallet; a wallet is needed only to stake or claim.

## Try it against the live URL

1. Open https://hunch-near.vercel.app and press the right arrow (or the YES button). A stake sheet opens with 0.05 NEAR preset.
2. Press **Stake YES 0.05 NEAR**. The judge desk signs a real `stake` transaction on NEAR testnet and the receipt shows its hash, signer and seconds to finality while the odds mover slides your side's share from the old number to the one the contract now shows ("Your 0.05 NEAR moved YES from 92.9% to 93.3%"). Follow the link to NearBlocks, or press **Post result on X** to share it.
   Open **Positions** in the header to see each stake with its live odds, the payout if your side wins and its transaction.
3. Tap the Adam Back card. The attested arbiter's ruling (NO), its reasoning, the resolution transaction and the winner's payout transaction are on the first screen.
4. Prefer your own account? Choose **Use my own wallet instead** in the sheet, or Connect wallet in the header, and sign the same `stake` with Meteor, Intear, MyNearWallet, Nightly or Ledger on testnet.
5. Run `npm run judge` to check every claim above against the live site, the stake desk and testnet (12 checks, no keys needed).

The stake desk is a Cloudflare Worker in [`relayer/`](relayer/): a funded testnet account signs `stake` for visitors, capped per browser and by the desk balance, and the same Worker relays the page's chain reads.

## Run the reader

```sh
cd web
npm install
npm run dev
```

Enter a deployed Hunch contract account to read its markets. The three seeded claim records and their sources are in [`web/facts.json`](web/facts.json).

## Deploy the reader

`npm run build` in `web/` writes a static site to `web/dist`, including the runtime data files (`facts.json`, and `generated-pages.json` / `attestation-proof.json` when they exist). The live demo at https://hunch-near.vercel.app is deployed this way. On Vercel: import the repository, set **Root Directory** to `web`, keep the detected Vite preset (build `npm run build`, output `dist`), and optionally set the environment variable `VITE_HUNCH_CONTRACT` to the testnet contract the site should open by default. Visitors can still choose another contract with `?contract=`.

## Evidence

- Live verifier account: [sworn-reg7-1113.testnet](https://testnet.nearblocks.io/address/sworn-reg7-1113.testnet)
- NEAR AI Cloud OpenAI-compatible endpoint: [cloud-api.near.ai/v1](https://cloud-api.near.ai/v1)
- Claim, source, odds, and resolution checks: [`contract/src/lib.rs`](contract/src/lib.rs)
