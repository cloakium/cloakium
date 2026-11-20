//! Original loopback HTTP/3 (QUIC) fixture for behaviour probes.
//!
//! Deliberately tiny: one endpoint, one handler, one control socket. It exists to
//! pair UDP relay attribution with server-side connection counters so a probe can
//! tell "QUIC arrived through the SOCKS relay" from "QUIC bypassed the relay".
//!
//! No third-party code, no external network, no trust-store changes. The
//! certificate is generated per run and the caller pins it with the SPKI hash.

use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

mod cert;
use cert::{pem_of, self_signed, spki_pin};

const PEER_LIMIT: usize = 64;
const PATH_LIMIT: usize = 32;

#[derive(Default)]
struct PathTable {
    counts: HashMap<String, u64>,
    order: VecDeque<String>,
}

impl PathTable {
    fn bump(&mut self, key: &str) {
        *self.counts.entry(key.to_string()).or_insert(0) += 1;
        if !self.order.iter().any(|seen| seen == key) {
            self.order.push_back(key.to_string());
        }
        while self.order.len() > PATH_LIMIT {
            match self.order.pop_front() {
                Some(oldest) => self.counts.remove(&oldest),
                None => break,
            };
        }
    }
}

#[derive(Default)]
struct Counters {
    connections: AtomicU64,
    requests: AtomicU64,
    tcp_requests: AtomicU64,
    paths: Mutex<PathTable>,
    peers: Mutex<VecDeque<(String, u16)>>,
}

impl Counters {
    fn note_peer(&self, peer: SocketAddr) {
        let mut peers = self.peers.lock().expect("peers lock");
        peers.push_back((peer.ip().to_string(), peer.port()));
        while peers.len() > PEER_LIMIT {
            peers.pop_front();
        }
    }

    fn note_request(&self, path: &str) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        self.note_path(path);
    }

    fn note_tcp_request(&self, path: &str) {
        self.tcp_requests.fetch_add(1, Ordering::Relaxed);
        self.note_path(&format!("{path} [tcp]"));
    }

    fn note_path(&self, key: &str) {
        self.paths.lock().expect("paths lock").bump(key);
    }

    fn snapshot(&self) -> serde_json::Value {
        let peers = self.peers.lock().expect("peers lock");
        let paths = self.paths.lock().expect("paths lock");
        serde_json::json!({
            "connections": self.connections.load(Ordering::Relaxed),
            "requests": self.requests.load(Ordering::Relaxed),
            "tcpRequests": self.tcp_requests.load(Ordering::Relaxed),
            "paths": paths.counts.clone(),
            "peerPorts": peers.iter().map(|(_, port)| *port).collect::<Vec<u16>>(),
            "peerAddrs": peers.iter().map(|(ip, port)| format!("{ip}:{port}")).collect::<Vec<String>>(),
        })
    }
}

fn server_config(
    cert: CertificateDer<'static>,
    key: PrivatePkcs8KeyDer<'static>,
) -> Result<quinn::ServerConfig> {
    let mut crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key.into())?;
    crypto.alpn_protocols = vec![b"h3".to_vec()];
    let quic_crypto =
        quinn::crypto::rustls::QuicServerConfig::try_from(crypto).context("QUIC server crypto")?;
    let mut config = quinn::ServerConfig::with_crypto(Arc::new(quic_crypto));
    let mut transport = quinn::TransportConfig::default();
    transport.max_idle_timeout(Some(Duration::from_secs(30).try_into()?));
    config.transport_config(Arc::new(transport));
    Ok(config)
}

async fn serve_connection(connection: quinn::Connection, counters: Arc<Counters>) {
    let peer = connection.remote_address();
    counters.note_peer(peer);
    counters.connections.fetch_add(1, Ordering::Relaxed);

    let quic = h3_quinn::Connection::new(connection);
    let mut server = match h3::server::Connection::<_, Bytes>::new(quic).await {
        Ok(server) => server,
        Err(_) => return,
    };

    loop {
        match server.accept().await {
            Ok(Some(resolver)) => {
                let (request, mut stream) = match resolver.resolve_request().await {
                    Ok(pair) => pair,
                    Err(_) => break,
                };
                let path = request.uri().path().to_string();
                counters.note_request(&path);
                let body = serde_json::json!({
                    "protocol": "h3",
                    "path": path,
                    "peerPort": peer.port(),
                    "fixture": "cloakium-lab-h3",
                })
                .to_string();
                let response = http::Response::builder()
                    .status(200)
                    .header("content-type", "application/json")
                    .header("cache-control", "no-store")
                    .body(())
                    .expect("static response");
                if stream.send_response(response).await.is_err() {
                    break;
                }
                let _ = stream.send_data(Bytes::from(body)).await;
                let _ = stream.finish().await;
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
}

async fn control_loop(listener: TcpListener, counters: Arc<Counters>) -> Result<()> {
    loop {
        let (socket, _) = listener.accept().await?;
        let counters = counters.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(socket);
            let mut line = String::new();
            if reader.read_line(&mut line).await.is_err() {
                return;
            }
            let reply = match line.trim() {
                "STATS" => format!("{}\n", counters.snapshot()),
                "SHUTDOWN" => {
                    let _ = reader.get_mut().write_all(b"{\"ok\":true}\n").await;
                    std::process::exit(0);
                }
                _ => "{\"error\":\"unknown-command\"}\n".to_string(),
            };
            let _ = reader.get_mut().write_all(reply.as_bytes()).await;
        });
    }
}

async fn tls_tcp_loop(
    listener: TcpListener,
    acceptor: tokio_rustls::TlsAcceptor,
    counters: Arc<Counters>,
) {
    loop {
        let (socket, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(_) => return,
        };
        let acceptor = acceptor.clone();
        let counters = counters.clone();
        tokio::spawn(async move {
            let mut stream = match acceptor.accept(socket).await {
                Ok(stream) => stream,
                Err(_) => return,
            };
            let mut buffer = vec![0u8; 8192];
            let mut read = 0usize;
            loop {
                match stream.read(&mut buffer[read..]).await {
                    Ok(0) => break,
                    Ok(count) => {
                        read += count;
                        let headers_done = buffer[..read]
                            .windows(4)
                            .any(|window| window == b"\r\n\r\n");
                        if headers_done || read >= buffer.len() {
                            break;
                        }
                    }
                    Err(_) => return,
                }
            }
            let head = String::from_utf8_lossy(&buffer[..read]).to_string();
            let path = head
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/")
                .to_string();
            counters.note_tcp_request(&path);
            let body = serde_json::json!({
                "protocol": "http/1.1",
                "path": path,
                "fixture": "cloakium-lab-h3",
                "note": "TCP fallback listener on the same port as the QUIC endpoint",
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        });
    }
}

fn cert_dir_arg() -> Option<std::path::PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--cert-dir" {
            return args.next().map(std::path::PathBuf::from);
        }
    }
    None
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (cert_der, key_der) = self_signed()?;
    let pin = spki_pin(cert_der.as_ref())?;

    let mut cert_path = None;
    if let Some(dir) = cert_dir_arg() {
        std::fs::create_dir_all(&dir).ok();
        let pem_path = dir.join("h3-cert.pem");
        let der_path = dir.join("h3-cert.der");
        std::fs::write(&pem_path, pem_of(cert_der.as_ref()))?;
        std::fs::write(&der_path, cert_der.as_ref())?;
        cert_path = Some(pem_path);
    }

    let mut tcp_crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der.clone()], key_der.clone_key().into())?;
    tcp_crypto.alpn_protocols = vec![b"http/1.1".to_vec()];

    let config = server_config(cert_der, key_der)?;
    let endpoint = quinn::Endpoint::server(config, SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    let udp_port = endpoint.local_addr()?.port();

    let counters = Arc::new(Counters::default());

    // Same port number on TCP: HTTP/1.1 fallback so a probe can distinguish
    // "proxy path works but QUIC was not attempted" from "proxy is broken".
    let tcp_acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tcp_crypto));
    let tcp_port = match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, udp_port))).await
    {
        Ok(listener) => {
            let tcp_counters = counters.clone();
            tokio::spawn(async move { tls_tcp_loop(listener, tcp_acceptor, tcp_counters).await });
            Some(udp_port)
        }
        Err(_) => None,
    };

    let accept_counters = counters.clone();
    tokio::spawn(async move {
        while let Some(incoming) = endpoint.accept().await {
            let counters = accept_counters.clone();
            tokio::spawn(async move {
                if let Ok(connection) = incoming.await {
                    serve_connection(connection, counters).await;
                }
            });
        }
    });

    let control = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
    let control_port = control.local_addr()?.port();
    let control_counters = counters.clone();
    tokio::spawn(async move {
        let _ = control_loop(control, control_counters).await;
    });

    let startup = serde_json::json!({
        "udpPort": udp_port,
        "tcpPort": tcp_port,
        "controlPort": control_port,
        "spkiSha256": pin,
        "certPath": cert_path,
        "origin": format!("https://127.0.0.1:{udp_port}"),
    });
    println!("{startup}");
    use std::io::Write as _;
    std::io::stdout().flush().ok();

    std::future::pending::<()>().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_bound_peers_and_report_shape() {
        let counters = Counters::default();
        for port in 0..(PEER_LIMIT as u16 + 8) {
            counters.note_peer(SocketAddr::from((Ipv4Addr::LOCALHOST, 10_000 + port)));
        }
        let snapshot = counters.snapshot();
        assert_eq!(
            snapshot["peerPorts"].as_array().map(Vec::len),
            Some(PEER_LIMIT)
        );
        assert_eq!(
            snapshot["connections"].as_u64(),
            Some(0),
            "observing peers does not count connections"
        );
        counters.connections.fetch_add(1, Ordering::Relaxed);
        counters.note_request("/probe");
        counters.note_tcp_request("/fallback");
        let snapshot = counters.snapshot();
        assert_eq!(snapshot["connections"].as_u64(), Some(1));
        assert_eq!(snapshot["requests"].as_u64(), Some(1));
        assert_eq!(snapshot["tcpRequests"].as_u64(), Some(1));
        assert_eq!(snapshot["paths"]["/probe"].as_u64(), Some(1));
        assert_eq!(snapshot["paths"]["/fallback [tcp]"].as_u64(), Some(1));
    }

    #[test]
    fn counters_bound_the_path_table() {
        let counters = Counters::default();
        for index in 0..(PATH_LIMIT + 5) {
            counters.note_request(&format!("/path-{index}"));
        }
        let snapshot = counters.snapshot();
        assert_eq!(snapshot["requests"].as_u64(), Some((PATH_LIMIT + 5) as u64));
        assert!(
            snapshot["paths"]
                .as_object()
                .map(|map| map.len())
                .unwrap_or(0)
                <= PATH_LIMIT
        );
        assert!(
            snapshot["paths"]["/path-0"].as_u64().is_none(),
            "oldest path entry is evicted"
        );
        assert_eq!(
            snapshot["paths"][format!("/path-{}", PATH_LIMIT + 4)].as_u64(),
            Some(1)
        );
    }
}
