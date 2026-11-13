#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source /Volumes/AgentData/near/build/env.sh
set -a
. ~/near-build/.env.near-ai
set +a
: "${NEAR_AI_API_KEY:?NEAR_AI_API_KEY must be present in ~/near-build/.env.near-ai}"
SIGN_WITH="${SIGN_WITH:-sign-with-legacy-keychain}"
NETWORK="${NETWORK:-testnet}"
SUFFIX="$(date -u +%y%m%d%H%M%S)-$$"
CONTRACT="hunch-c-$SUFFIX.testnet"
ARBITER="hunch-a-$SUFFIX.testnet"
YES_ACCOUNT="hunch-y-$SUFFIX.testnet"
NO_ACCOUNT="hunch-n-$SUFFIX.testnet"
FACT_ID="adam-back-satoshi"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

create_account() {
  local attempt=0 delay
  until near account create-account sponsor-by-faucet-service "$1" autogenerate-new-keypair save-to-legacy-keychain network-config testnet create >"$TMP/account.log" 2>&1; do
    if ! grep -q '429 Too Many Requests' "$TMP/account.log" || [ "$attempt" -ge 5 ]; then
      echo "faucet account creation failed for $1" >&2
      exit 1
    fi
    delay="$((5 << attempt))"
    echo "faucet rate limited account creation; retrying in ${delay}s" >&2
    sleep "$delay"
    attempt="$((attempt + 1))"
  done
  account_tx="$(grep -oE 'Transaction ID: [A-Za-z0-9]+' "$TMP/account.log" | tail -1 | awk '{print $3}')"
  [ -z "$account_tx" ] || printf 'ACCOUNT_TX %s %s\n' "$1" "$account_tx"
  sleep 3
}

create_account "$CONTRACT"
create_account "$ARBITER"
create_account "$YES_ACCOUNT"
create_account "$NO_ACCOUNT"
cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml --out-dir target-wasm >/dev/null
near contract deploy "$CONTRACT" use-file target-wasm/hunch_contract.wasm with-init-call new json-args "$(jq -cn --arg arbiter "$ARBITER" '{arbiter:$arbiter,registry:"sworn-reg7-1113.testnet",model_id:"Qwen/Qwen3.6-35B-A3B-FP8"}')" prepaid-gas '80 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" "$SIGN_WITH" send >"$TMP/deploy.log"
deploy_tx="$(grep -oE 'Transaction ID: [A-Za-z0-9]+' "$TMP/deploy.log" | tail -1 | awk '{print $3}')"
[ -n "$deploy_tx" ] || { echo 'deployment transaction id missing' >&2; exit 1; }
printf 'DEPLOYED %s\nDEPLOY_TX %s\n' "$CONTRACT" "$deploy_tx"
CONTRACT="$CONTRACT" SIGNER="$CONTRACT" FAST_RESOLVE=1 SIGN_WITH="$SIGN_WITH" NETWORK="$NETWORK" TMPDIR="$TMP" bash scripts/seed-testnet.sh | tee "$TMP/seed.log"
near contract call-function as-transaction "$CONTRACT" stake json-args "$(jq -cn --arg id "$FACT_ID" '{id:$id,side:"Yes"}')" prepaid-gas '40 Tgas' attached-deposit '0.1 NEAR' sign-as "$YES_ACCOUNT" network-config "$NETWORK" "$SIGN_WITH" send >"$TMP/yes.log"
near contract call-function as-transaction "$CONTRACT" stake json-args "$(jq -cn --arg id "$FACT_ID" '{id:$id,side:"No"}')" prepaid-gas '40 Tgas' attached-deposit '0.05 NEAR' sign-as "$NO_ACCOUNT" network-config "$NETWORK" "$SIGN_WITH" send >"$TMP/no.log"
yes_tx="$(grep -oE 'Transaction ID: [A-Za-z0-9]+' "$TMP/yes.log" | tail -1 | awk '{print $3}')"
no_tx="$(grep -oE 'Transaction ID: [A-Za-z0-9]+' "$TMP/no.log" | tail -1 | awk '{print $3}')"
[ -n "$yes_tx" ] && [ -n "$no_tx" ] || { echo 'stake transaction id missing' >&2; exit 1; }
printf 'STAKE_TX %s %s\nSTAKE_TX %s %s\n' "$YES_ACCOUNT" "$yes_tx" "$NO_ACCOUNT" "$no_tx"
node scripts/generate-pages.mjs "$CONTRACT" web/generated-pages.json
node scripts/attest-proof.mjs web/attestation-proof.json
node scripts/prepare-resolution.mjs "$CONTRACT" "$FACT_ID" "$TMP/resolution.json"
outcome="$(jq -r .outcome "$TMP/resolution.json")"
before_yes="$(node scripts/chain.mjs balance "$YES_ACCOUNT")"
winner="$YES_ACCOUNT"
before_no="$(node scripts/chain.mjs balance "$NO_ACCOUNT")"
if [ "$outcome" = 'No' ]; then winner="$NO_ACCOUNT"; fi
before="$before_yes"
if [ "$winner" = "$NO_ACCOUNT" ]; then before="$before_no"; fi
near contract call-function as-transaction "$CONTRACT" resolve file-args "$TMP/resolution.json" prepaid-gas '120 Tgas' attached-deposit '0 NEAR' sign-as "$ARBITER" network-config "$NETWORK" "$SIGN_WITH" send >"$TMP/resolve.log"
resolution_tx="$(grep -oE 'Transaction ID: [A-Za-z0-9]+' "$TMP/resolve.log" | tail -1 | awk '{print $3}')"
[ -n "$resolution_tx" ] || { echo 'resolution transaction id missing' >&2; exit 1; }
resolved="$(node scripts/chain.mjs resolved "$CONTRACT" "$FACT_ID" 180)"
[ "$resolved" = "$outcome" ] || { echo "resolved outcome $resolved differs from signed outcome $outcome" >&2; exit 1; }
near contract call-function as-transaction "$CONTRACT" claim json-args "$(jq -cn --arg id "$FACT_ID" '{id:$id}')" prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as "$winner" network-config "$NETWORK" "$SIGN_WITH" send >"$TMP/claim.log"
claim_tx="$(grep -oE 'Transaction ID: [A-Za-z0-9]+' "$TMP/claim.log" | tail -1 | awk '{print $3}')"
[ -n "$claim_tx" ] || { echo 'claim transaction id missing' >&2; exit 1; }
after="$(node scripts/chain.mjs wait-balance "$winner" "$before")"
[ "$after" -gt "$before" ] || { echo 'winner balance did not increase after claim' >&2; exit 1; }
printf 'RESOLVED %s\nCLAIMED %s %s\nCONTRACT %s\n' "$resolution_tx" "$winner" "$claim_tx" "$CONTRACT"
