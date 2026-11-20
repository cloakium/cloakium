# HTTP/3 fixture (`cloakium-lab-h3`)

An original ~380-line Rust server used to make QUIC observability measurable on
loopback: it pairs server-side connection counters with per-peer UDP source ports
so a probe can distinguish "QUIC arrived through the SOCKS5 relay" from "QUIC
bypassed the relay". It is not a reference HTTP/3 implementation and makes no
conformance claim.

## Behaviour

- Binds QUIC on `127.0.0.1:0` (UDP), ALPN `h3`, and answers JSON:
  `{"protocol":"h3","path":...,"peerPort":...,"fixture":"cloakium-lab-h3"}`.
- Binds a **TCP/TLS** listener on the *same port number* speaking HTTP/1.1 with
  `{"protocol":"http/1.1",...}`. A proxied result is therefore unambiguous: a
  TCP fallback is visible, rather than an unexplained connection failure.
- Counters: `connections`, `requests`, `tcpRequests`, `paths` (FIFO-bounded),
  `peerPorts` and `peerAddrs` (bounded to 64 peers).
- Control socket (loopback, ephemeral): `STATS\n` → one JSON line, `SHUTDOWN\n`
  → exit.
- Startup line on stdout:
  `{"udpPort","tcpPort","controlPort","spkiSha256","certPath","origin"}`.
- Certificate: generated per run (ECDSA P-256, SAN `IP:127.0.0.1` +
  `DNS:localhost`). `spkiSha256` is base64(SHA-256(DER SubjectPublicKeyInfo)).

## Build and run

```bash
cargo build --release --manifest-path tools/audit-h3-lab/Cargo.toml
# binary: tools/audit-h3-lab/target/release/cloakium-lab-h3
# or point CLOAKIUM_H3_BIN at an existing binary
```

The Node lab spawns it with `--cert-dir <private scratch dir>` and deletes the
certificate directory on close. `cargo fmt --check`, `cargo clippy -- -D warnings`
and `cargo test` all run offline against the committed `Cargo.lock`.

Pinned crates: `quinn 0.11.12`, `h3 0.0.8`, `h3-quinn 0.0.10`, `rustls 0.23`
(ring provider), `tokio-rustls 0.26`, `rcgen 0.14`, `tokio 1`.

## Browser arguments the caller supplies

```text
--enable-quic
--origin-to-force-quic-on=127.0.0.1:<udpPort>
--ignore-certificate-errors-spki-list=<spkiSha256>
```

Only the ephemeral fixture certificate is pinned by SPKI. A blanket
`--ignore-certificate-errors` is never used and no trust store is modified.

## Safety

Loopback only, dynamic ports, no external egress, no third-party code, no
credentials, no licence material. The certificate and key live in a throwaway
directory and are removed by the caller.

## Selfcheck

```bash
node tests/audit/network/selfcheck/h3-fixture.mjs
```
