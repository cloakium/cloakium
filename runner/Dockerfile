FROM ubuntu:22.04

ARG RUNNER_VERSION=2.322.0
ARG TARGETARCH=x64

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies for GitHub Actions runner + Chromium build
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git jq sudo lsb-release gnupg \
    # Chromium build deps (subset — full list from install-build-deps.sh)
    build-essential clang lld llvm \
    python3 python3-pip python3-setuptools \
    pkg-config libglib2.0-dev libgtk-3-dev libnss3-dev \
    libatk1.0-dev libatk-bridge2.0-dev libcups2-dev \
    libxcomposite-dev libxdamage-dev libxrandr-dev \
    libgbm-dev libpango1.0-dev libasound2-dev \
    libdrm-dev libxshmfence-dev \
    # Cross-compilation for ARM64
    gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
    # Cross-compilation for Windows (clang-cl)
    mingw-w64 \
    # Packaging
    zip zstd \
    # sccache for build caching
    && rm -rf /var/lib/apt/lists/*

# Install sccache
RUN curl -fsSL "https://github.com/mozilla/sccache/releases/download/v0.9.1/sccache-v0.9.1-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xzf - -C /usr/local/bin --strip-components=1 sccache-v0.9.1-x86_64-unknown-linux-musl/sccache \
    && chmod +x /usr/local/bin/sccache

# Create runner user
RUN useradd -m -s /bin/bash runner && \
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
