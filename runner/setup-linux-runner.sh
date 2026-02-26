#!/bin/bash
set -euo pipefail
#
# One-shot setup for the Cloakium self-hosted Linux runner on hel2.
#
# Prerequisites:
#   - Docker + Docker Compose installed
#   - gh CLI authenticated (for registration token)
#   - This script run from the repo root or runner/ directory
#
# Usage:
#   ssh root@hel2.tek4-newmedia.co.uk
#   bash runner/setup-linux-runner.sh

REPO="cloakium/cloakium"
RUNNER_BASE="/data/github-runner"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Cloakium Linux Runner Setup ==="
echo "Runner base: $RUNNER_BASE"
echo ""

# 1. Create directories
echo "Creating directories..."
mkdir -p "$RUNNER_BASE"/{cache,work,config}

# 2. Copy runner files
echo "Copying runner config..."
cp "$SCRIPT_DIR/docker-compose.yml" "$RUNNER_BASE/"
cp "$SCRIPT_DIR/Dockerfile" "$RUNNER_BASE/"
cp "$SCRIPT_DIR/entrypoint.sh" "$RUNNER_BASE/"
chmod +x "$RUNNER_BASE/entrypoint.sh"

# 3. Get registration token
echo "Getting registration token..."
if ! command -v gh &>/dev/null; then
  echo "ERROR: gh CLI not found. Install it: https://cli.github.com/"
  exit 1
fi
TOKEN="$(gh api "repos/${REPO}/actions/runners/registration-token" -q .token)"

# 4. Write .env
echo "Writing .env..."
cat > "$RUNNER_BASE/.env" << EOF
RUNNER_TOKEN=$TOKEN
EOF

# 5. Optionally configure MinIO (if running on same host)
if docker ps --format '{{.Names}}' | grep -q minio; then
  echo "Detected MinIO container — configuring cache endpoint..."
  # Assume MinIO is on localhost:9000 (host networking)
  cat >> "$RUNNER_BASE/.env" << 'EOF'
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=cloakium-ci
EOF
  echo "NOTE: Add MINIO_SECRET_KEY to $RUNNER_BASE/.env manually"
  echo "  (same value as MINIO_ROOT_PASSWORD from cache/docker-compose.yml)"
fi

echo ""
echo "=== .env written to $RUNNER_BASE/.env ==="
echo "Review it, then:"
echo ""
echo "  cd $RUNNER_BASE"
echo "  docker compose up -d --build"
echo ""
echo "Verify runner appears at:"
echo "  https://github.com/$REPO/settings/actions/runners"
