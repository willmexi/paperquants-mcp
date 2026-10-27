#!/bin/sh
# Copy the shared trading core from the PaperQuants server code into this package, so the open-source repo stands on
# its own and runs exactly the rules the server runs. Run after changing any of these files in ../src.
set -e
cd "$(dirname "$0")/.."
SRC=../src
for f in papertrade.ts venues.ts sim.ts market.ts sandbox.ts riskCore.ts live/papertrade.ts live/vault.ts; do
  cp "$SRC/$f" "core/$f"
done
echo "core synced from $SRC"
