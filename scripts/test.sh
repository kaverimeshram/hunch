#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source /Volumes/AgentData/near/build/env.sh
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
cargo test -p hunch-contract --lib
cargo test -p hunch-sandbox --test market -- --nocapture
bash scripts/mutation-check.sh
