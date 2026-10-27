#!/bin/sh
# Mirror this package into the public repo checkout (../../../paperquants-mcp by default) and commit.
set -e
cd "$(dirname "$0")/.."
DEST=${1:-../../../paperquants-mcp}
./scripts/sync-core.sh
rsync -a --delete --exclude node_modules --exclude dist --exclude .git --exclude '*.tmp' ./ "$DEST/"
cd "$DEST" && git add -A && git commit -q -m "${2:-sync from PaperQuants}" && echo "committed in $DEST"
