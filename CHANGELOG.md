# Changelog

## Unreleased

- Contract: the arbiter prompt no longer includes stake pools; resolution accepts `insufficient`; markets with an insufficient answer, an answer for an unstaked side, or no resolution 14 days after the deadline become `Void` and refund every stake.
- Contract: community evidence submission (`submit_evidence`, `get_evidence`), curator review (`set_curator`, `review_evidence`), on-chain resolution history (`get_resolution_history`), `list_facts`, `get_claimed` and `get_config` views.
- Contract storage: new data uses new storage prefixes; existing fact, stake and claim records are unchanged. `Status` gains a `Void` variant appended after the existing ones.
- Scripts: live E2E handles the `insufficient` outcome by claiming refunds for both stakers.

## 2026-11-13

- Renamed the product to Hunch across the product, packages, scripts, and docs. Existing deployed testnet contract accounts remain supported.
