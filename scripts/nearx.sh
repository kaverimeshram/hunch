# near-cli wrapper: retries only when the public RPC refuses the nonce lookup, or when near-cli reports the
# transaction expired, or the RPC rejected the request for rate limiting. Both mean the transaction was never included, so a retry signs a fresh one.
nearx() {
  local log="$1" attempt=0 delay
  shift
  until near "$@" >"$log" 2>&1; do
    if ! grep -qE 'Cannot sign a transaction due to an error while fetching|Transaction has expired|exceeded the rate limit' "$log" || [ "$attempt" -ge 8 ]; then
      return 1
    fi
    attempt="$((attempt + 1))"
    delay="$((10 * attempt))"
    echo "RPC refused or transaction expired before inclusion; retrying in ${delay}s" >&2
    sleep "$delay"
  done
}
