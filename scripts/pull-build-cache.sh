#!/bin/bash
# Pull build cache from MinIO to seed local incremental builds.
#
# Usage:
#   export CACHE_ENDPOINT=http://your-server:9000
#   export CACHE_ACCESS_KEY=cloakium-ci
#   export CACHE_SECRET_KEY=<secret>
#   ./scripts/pull-build-cache.sh <version> [chromium-src-dir]
#
# Example:
#   ./scripts/pull-build-cache.sh 136.0.7103.113 ~/chromium/src
#
# After pulling, run `gclient sync` at the same version, then
# `autoninja -C out/Cloakium-linux-amd64 chrome` for a fast incremental build.

set -euo pipefail

VERSION="${1:?Usage: pull-build-cache.sh <version> [chromium-src-dir]}"
CHROMIUM_SRC="${2:-$(pwd)}"
TARGET="${TARGET:-linux-amd64}"
CACHE_KEY="build-cache/$TARGET/$VERSION"

for var in CACHE_ENDPOINT CACHE_ACCESS_KEY CACHE_SECRET_KEY; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var not set" >&2
    exit 1
  fi
done

# Check mc is installed
if ! command -v mc &>/dev/null; then
  echo "Installing mc (MinIO client)..."
  curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o ~/.local/bin/mc
  chmod +x ~/.local/bin/mc
  export PATH="$HOME/.local/bin:$PATH"
fi

mc alias set cache "$CACHE_ENDPOINT" "$CACHE_ACCESS_KEY" "$CACHE_SECRET_KEY" 2>/dev/null

# Check if cache exists
if ! mc stat "cache/cloakium-cache/$CACHE_KEY/build-output.tar.zst" &>/dev/null; then
  echo "No cache found for $CACHE_KEY"
  mc ls "cache/cloakium-cache/build-cache/$TARGET/" 2>/dev/null || true
  exit 1
fi

echo "Pulling build cache for $VERSION..."
echo "  Source: cache/cloakium-cache/$CACHE_KEY/build-output.tar.zst"
echo "  Target: $CHROMIUM_SRC/"

mc cat "cache/cloakium-cache/$CACHE_KEY/build-output.tar.zst" \
  | zstd -d \
  | tar -C "$CHROMIUM_SRC" -xf -

echo "Done. Build cache extracted to $CHROMIUM_SRC/out/Cloakium-$TARGET/"
echo ""
echo "Next steps:"
echo "  1. cd $CHROMIUM_SRC"
echo "  2. Ensure source is at version $VERSION (gclient sync)"
echo "  3. Apply patches"
echo "  4. autoninja -C out/Cloakium-$TARGET chrome  # fast incremental build"
