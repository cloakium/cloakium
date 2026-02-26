FROM ubuntu:24.04

ARG RUNNER_VERSION=2.322.0
ARG TARGETARCH=x64

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies for GitHub Actions runner + Chromium build
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git jq sudo lsb-release gnupg \
    # Chromium build deps
    build-essential clang lld llvm \
    python3 python3-pip python3-setuptools \
    pkg-config libglib2.0-dev libgtk-3-dev libnss3-dev \
    libatk1.0-dev libatk-bridge2.0-dev libcups2-dev \
    libxcomposite-dev libxdamage-dev libxrandr-dev \
    libgbm-dev libpango1.0-dev libasound2-dev \
    libdrm-dev libxshmfence-dev \
    gperf libffi-dev libxkbcommon-dev \
    # Packaging
    zip zstd pv \
    && rm -rf /var/lib/apt/lists/*

# Install MinIO client
RUN curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc \
    && chmod +x /usr/local/bin/mc

# Create runner user (force UID 1000 — ubuntu:24.04 has a default 'ubuntu' user at 1000)
RUN userdel -r ubuntu 2>/dev/null || true && \
    useradd -m -s /bin/bash -u 1000 runner && \
    echo "runner ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Install GitHub Actions runner
WORKDIR /home/runner
RUN curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${TARGETARCH}-${RUNNER_VERSION}.tar.gz" \
    | tar -xzf - && \
    ./bin/installdependencies.sh && \
    chown -R runner:runner /home/runner

# Create mount points
RUN mkdir -p /cache /work && chown runner:runner /cache /work

USER runner

COPY entrypoint.sh /home/runner/entrypoint.sh

ENTRYPOINT ["/home/runner/entrypoint.sh"]
