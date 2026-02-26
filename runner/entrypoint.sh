#!/bin/bash
set -euo pipefail

# Required env vars:
#   GITHUB_REPO   — e.g. "cloakium/cloakium"
#   RUNNER_TOKEN  — registration token from GitHub
#   RUNNER_NAME   — unique name for this runner (default: hostname)
#   RUNNER_LABELS — comma-separated labels (default: "self-hosted,linux,x64")
#
# Optional:
#   MINIO_ENDPOINT   — MinIO URL (e.g. http://localhost:9000)
#   MINIO_ACCESS_KEY — MinIO access key
#   MINIO_SECRET_KEY — MinIO secret key

RUNNER_NAME="${RUNNER_NAME:-$(hostname)}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,x64}"
RUNNER_WORKDIR="${RUNNER_WORKDIR:-/work/_runner}"

mkdir -p "$RUNNER_WORKDIR"

# Configure mc alias for MinIO if credentials provided
if [ -n "${MINIO_ENDPOINT:-}" ] && [ -n "${MINIO_ACCESS_KEY:-}" ] && [ -n "${MINIO_SECRET_KEY:-}" ]; then
  echo "Configuring MinIO client..."
  mc alias set cache "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
  echo "MinIO alias 'cache' configured."
fi

# Configure runner (idempotent — skips if already configured)
if [ ! -f .runner ]; then
  ./config.sh \
    --url "https://github.com/${GITHUB_REPO}" \
    --token "${RUNNER_TOKEN}" \
    --name "${RUNNER_NAME}" \
    --labels "${RUNNER_LABELS}" \
    --work "${RUNNER_WORKDIR}" \
    --unattended \
    --replace
fi

# Clean up on exit
cleanup() {
  echo "Removing runner..."
  ./config.sh remove --token "${RUNNER_TOKEN}" 2>/dev/null || true
}
trap cleanup EXIT

# Run
exec ./run.sh
