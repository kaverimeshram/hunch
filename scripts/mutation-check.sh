#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
file=contract/src/lib.rs
original="$(mktemp)"
output="$(mktemp)"
cp "$file" "$original"
restore() { cp "$original" "$file"; rm -f "$original" "$output"; }
trap restore EXIT
python3 - "$file" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
guard = 'require!(sha256_hex(evidence.response_body.as_bytes()) == evidence.response_sha256, "response hash mismatch");'
assert s.count(guard) == 1, "response hash guard not uniquely found"
p.write_text(s.replace(guard, 'require!(true, "response hash mismatch");'))
PY
if cargo test -p hunch-sandbox --test market sandbox_refuses_a_resolution_without_a_matching_signed_response_hash -- --nocapture >"$output" 2>&1; then
  echo 'FAIL: tampered response was accepted after removing its hash guard' >&2
  exit 1
fi
cp "$original" "$file"
if ! cargo test -p hunch-sandbox --test market sandbox_refuses_a_resolution_without_a_matching_signed_response_hash -- --nocapture >"$output" 2>&1; then
  tail -n 30 "$output" >&2
  echo 'FAIL: restored response-hash refusal check did not pass' >&2
  exit 1
fi
echo 'RED confirmed: removing response-hash guard fails the negative sandbox assertion.'
echo 'GREEN confirmed: restoring the guard passes the negative sandbox assertion.'
