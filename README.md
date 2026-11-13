Hunch gives contested claims a public NEAR market where readers inspect sources, live YES or NO stakes, and the evidence used to settle each claim.

The contract records each claim, its source URLs, both stake pools, and each account's position. Odds are the share of NEAR in each pool. A NEAR AI Cloud answer can resolve a market only after the contract asks Sworn's on-chain registry to verify the registered model key and the signature over that exact request and response. Winners claim a pro rata share of the pools.

How a market settles:

- The arbiter prompt contains the claim and its evidence only. It never includes stakes or odds, so market sentiment cannot steer the judgment.
- The attested answer is `yes`, `no` or `insufficient`. `insufficient`, or an answer for a side nobody staked, voids the market and every staker can claim their own stake back.
- If no attested resolution arrives within 14 days of the deadline, anyone can call `void_expired` and stakes become refundable. Funds cannot be locked forever.
- Every settlement is appended to an on-chain resolution history with the attestation hashes, key and signature Sworn verified. Attestation proves the answer came unaltered from the registered model. It does not prove the answer is correct.

Evidence: any account can submit an https source with a stance (Supporting, Contradicting, Context or Unclassified) and an optional note of up to 280 bytes, attaching a 0.01 NEAR storage deposit. URLs are normalised and duplicates refused, with up to 16 submissions per claim until its deadline. A curator appointed by the contract account (`set_curator`) can mark submissions Reviewed or Rejected. Review checks that a source is relevant and genuine, not that it is accurate. Rejected sources stay visible but are left out of the arbiter prompt.

The web app reads a contract account on NEAR testnet without a wallet. A wallet is required only to stake or claim. The fact page shows sources, live odds, each side's stake, generated page text, and the reasoning attached to a verified resolution.

## Run the reader

```sh
cd web
npm install
npm run dev
```

Enter a deployed Hunch contract account to read its markets. The three seeded claim records and their sources are in [`web/facts.json`](web/facts.json).

## Deploy the reader

`npm run build` in `web/` writes a static site to `web/dist`, including the runtime data files (`facts.json`, and `generated-pages.json` / `attestation-proof.json` when they exist). On Vercel: import the repository, set **Root Directory** to `web`, keep the detected Vite preset (build `npm run build`, output `dist`), and optionally set the environment variable `VITE_HUNCH_CONTRACT` to the testnet contract the site should open by default. Visitors can still choose another contract with `?contract=`.

## Evidence

- Live verifier account: [sworn-reg7-1113.testnet](https://testnet.nearblocks.io/address/sworn-reg7-1113.testnet)
- NEAR AI Cloud OpenAI-compatible endpoint: [cloud-api.near.ai/v1](https://cloud-api.near.ai/v1)
- Claim, source, odds, and resolution checks: [`contract/src/lib.rs`](contract/src/lib.rs)
