# Truthpage

Truthpage gives contested claims a public NEAR market. Readers inspect the sources and live YES or NO stake, then follow the evidence used to settle the claim.

The contract records each claim, its source URLs, both stake pools, and each account's position. Odds are the share of NEAR in each pool. A NEAR AI Cloud answer can resolve a market only after the contract asks Sworn's on-chain registry to verify the registered model key and the signature over that exact request and response. Winners claim a pro rata share of the pools.

The web app reads a contract account on NEAR testnet without a wallet. A wallet is required only to stake or claim. The fact page shows sources, live odds, each side's stake, generated page text, and the reasoning attached to a verified resolution.

## Run the reader

```sh
cd web
npm install
npm run dev
```

Enter a deployed Truthpage contract account to read its markets. The three seeded claim records and their sources are in [`web/facts.json`](web/facts.json).

## Evidence

- Live verifier account: [sworn-reg7-1113.testnet](https://testnet.nearblocks.io/address/sworn-reg7-1113.testnet)
- NEAR AI Cloud OpenAI-compatible endpoint: [cloud-api.near.ai/v1](https://cloud-api.near.ai/v1)
- Claim, source, odds, and resolution checks: [`contract/src/lib.rs`](contract/src/lib.rs)
