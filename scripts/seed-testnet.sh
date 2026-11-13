#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CONTRACT:?deployed Hunch contract account required}"
: "${SIGNER:?account that created the contract and holds its key required}"
SIGN_WITH="${SIGN_WITH:-sign-with-legacy-keychain}"
NETWORK="${NETWORK:-testnet}"
RESOLVE_AFTER="$(node -e 'process.stdout.write(String(Date.parse("2027-12-31T23:59:00Z")))')"
call() {
  local method="$1" args="$2" deposit="${3:-0 NEAR}" id tx
  id="$(jq -r '.id' <<<"$args")"
  near contract call-function as-transaction "$CONTRACT" "$method" json-args "$args" prepaid-gas '80 Tgas' attached-deposit "$deposit" sign-as "$SIGNER" network-config "$NETWORK" "$SIGN_WITH" send >"${TMPDIR:-/tmp}/hunch-seed-$CONTRACT.log"
  tx="$(grep -oE 'Transaction ID: [A-Za-z0-9]+' "${TMPDIR:-/tmp}/hunch-seed-$CONTRACT.log" | tail -1 | awk '{print $3}')"
  [ -n "$tx" ] || { echo "$method transaction id missing for $id" >&2; exit 1; }
  printf 'TX %s %s %s\n' "$method" "$id" "$tx"
}
while IFS= read -r fact; do
  id="$(jq -r .id <<<"$fact")"
  claim="$(jq -r .claim <<<"$fact")"
  resolve_after="$RESOLVE_AFTER"
  if [ "${FAST_RESOLVE:-0}" = '1' ] && [ "$id" = 'adam-back-satoshi' ]; then
    resolve_after="$(( $(node -e 'process.stdout.write(String(Date.now()))') + 300000 ))"
  fi
  call create_fact "$(jq -cn --arg id "$id" --arg claim "$claim" --argjson at "$resolve_after" '{id:$id,claim:$claim,resolve_after:$at}')" '0.1 NEAR'
  while IFS= read -r source; do
    call add_source "$(jq -cn --arg id "$id" --arg source "$source" '{id:$id,source:$source}')"
  done < <(jq -r '.sources[]' <<<"$fact")
  printf 'SEEDED %s\n' "$id"
done < <(jq -c '.[]' web/facts.json)
