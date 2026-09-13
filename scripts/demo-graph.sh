#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo 'Node.js 24+ is required. Install Node 24, then rerun this command.' >&2
  exit 2
fi
npm ci
npm run build
output="${GRAPH_DEMO_OUT:-evidence/latest/tokens.jsonl}"
auth=()
if [[ -z "${GRAPH_API_KEY:-${THEGRAPH_GATEWAY_API_KEY:-}}" ]]; then
  auth=(--anonymous)
fi
mkdir -p "$(dirname "$output")"
node dist/examples/subgraph-to-training-set.js "${auth[@]}" \
  --keyword uniswap --subgraph 5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV \
  --first 20 --out "$output" "$@" 2>&1 | tee "$output.transcript.txt"
node scripts/validate-graph-evidence.mjs "$output" | tee "$output.validation.txt"
