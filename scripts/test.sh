#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source /Volumes/AgentData/near/build/env.sh
cargo test -p truthpage-contract --lib
cargo test -p truthpage-sandbox --test market -- --nocapture
bash scripts/mutation-check.sh
