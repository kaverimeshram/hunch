#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source /Volumes/AgentData/near/build/env.sh
cargo test -p hunch-contract --lib
cargo test -p hunch-sandbox --test market -- --nocapture
bash scripts/mutation-check.sh
