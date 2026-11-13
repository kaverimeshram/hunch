#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Optional toolchain setup. Defaults to the original maintainer's path; override with
# HUNCH_TOOLCHAIN_ENV, or put cargo, cargo-near and near on PATH yourself.
HUNCH_TOOLCHAIN_ENV="${HUNCH_TOOLCHAIN_ENV:-/Volumes/AgentData/near/build/env.sh}"
if [ -f "$HUNCH_TOOLCHAIN_ENV" ]; then source "$HUNCH_TOOLCHAIN_ENV"; fi
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
node --test 'scripts/lib/*.test.mjs'
cargo test -p hunch-contract --lib
cargo test -p hunch-sandbox --test market -- --nocapture
bash scripts/mutation-check.sh
