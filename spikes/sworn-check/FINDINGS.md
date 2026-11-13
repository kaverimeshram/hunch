Claim: A NEAR testnet contract can accept a resolution only when Sworn returns `ok: true` for the exact model, request hash, response hash, key, and provider signature. A changed response hash must return `ok: false`.

Verdict: CONFIRMED for Sworn registry verification. Fresh NEAR AI completion in this run is UNTESTED because `~/near-build/sworn/.env` is absent and no `NEAR_AI_API_KEY` was supplied through the prescribed path.

Measured: `sworn-reg7-1113.testnet` returned `ok: true` for the Qwen/Qwen3.6-35B-A3B-FP8 provider receipt in `~/near-build/sworn/web/sample-receipt.json`, in 0.91 seconds; changing the response hash returned `ok: false` with `signature does not verify over model:request:response`. Command: `node --input-type=module` with Sworn's installed `near-kit`, calling `near.view('sworn-reg7-1113.testnet', 'check', args)` and then the same call with one response hash nibble changed.

Negative case: The mutated response hash was refused by the live registry. A missing API key also caused the direct cloud API preflight to fail before any request was made; no key value was printed.

Caveat: The registry exposes `check` as a view. Hunch must make the view call as a promise and finalize resolution in a callback only after a successful response. The callback cannot prove that the upstream view remains available, so pending resolutions need a retry or cancellation path.

Blocks product: no for the contract verification path; yes for the final live inference E2E until a runtime API key is available.
