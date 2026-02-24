#!/bin/bash
set -euo pipefail
#
# Setup a local Mac as a self-hosted GitHub Actions runner for Stealthium.
#
# Prerequisites:
#   - macOS with Xcode installed
#   - Homebrew
#   - gh CLI authenticated
#
# Usage:
#   ./setup-mac-runner.sh
#
# This installs the runner as a launchd service that starts on login.

REPO="dstockton/stealthium"
RUNNER_VERSION="2.322.0"
RUNNER_DIR="$HOME/.github-runner"
RUNNER_NAME="stealthium-mac-$(hostname -s)"
RUNNER_LABELS="self-hosted,macOS,ARM64"
WORK_DIR="$HOME/.github-runner-work"
CACHE_DIR="$HOME/.github-runner-cache"

echo "=== Stealthium macOS Runner Setup ==="
echo "Runner dir: $RUNNER_DIR"
echo "Work dir:   $WORK_DIR"
echo "Cache dir:  $CACHE_DIR"
echo ""

# Create directories
mkdir -p "$RUNNER_DIR" "$WORK_DIR" "$CACHE_DIR"

# Detect arch
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) RUNNER_ARCH="osx-arm64" ;;
  x86_64) RUNNER_ARCH="osx-x64"; RUNNER_LABELS="self-hosted,macOS,X64" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

# Download runner
cd "$RUNNER_DIR"
if [ ! -f ./run.sh ]; then
  echo "Downloading runner v${RUNNER_VERSION}..."
  curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" \
    | tar -xzf -
fi

# Get registration token
echo "Getting registration token..."
TOKEN="$(gh api "repos/${REPO}/actions/runners/registration-token" -q .token)"

# Configure
./config.sh \
  --url "https://github.com/${REPO}" \
  --token "$TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work "$WORK_DIR" \
  --unattended \
  --replace

# Install as launchd service
echo "Installing as launchd service..."
./svc.sh install

echo ""
echo "=== Setup complete ==="
echo "Start:   ./svc.sh start"
echo "Stop:    ./svc.sh stop"
echo "Status:  ./svc.sh status"
echo ""
echo "The runner will auto-start on login."
echo ""
echo "Environment variables for builds (add to ~/.zshrc):"
echo "  export CACHE_ROOT=$CACHE_DIR"
