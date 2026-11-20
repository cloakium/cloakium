//! Certificate generation and DER helpers for the loopback HTTP/3 fixture.
//!
//! Only what the fixture needs: a per-run self-signed certificate for
//! 127.0.0.1/localhost, the SubjectPublicKeyInfo slice inside it, and the
//! base64(SHA-256(SPKI)) pin a caller supplies to the browser.

use std::net::{IpAddr, Ipv4Addr};

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rcgen::{CertificateParams, DnType, KeyPair, SanType};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};

/// Minimal DER cursor: only what is needed to slice SubjectPublicKeyInfo.
fn der_length(buf: &[u8], pos: usize) -> Option<(usize, usize)> {
    let first = *buf.get(pos)? as usize;
    if first & 0x80 == 0 {
        return Some((pos + 1, first));
    }
    let count = first & 0x7f;
    if count == 0 || count > 4 {
        return None;
    }
    let mut length = 0usize;
    for index in 0..count {
        length = (length << 8) | *buf.get(pos + 1 + index)? as usize;
    }
    Some((pos + 1 + count, length))
}

fn der_tlv(buf: &[u8], pos: usize) -> Option<(u8, usize, usize)> {
    let tag = *buf.get(pos)?;
    let (content, length) = der_length(buf, pos + 1)?;
    if content + length > buf.len() {
        return None;
    }
    Some((tag, content, length))
}

/// Extract the full SubjectPublicKeyInfo TLV from an X.509 certificate.
pub fn extract_spki(cert: &[u8]) -> Option<Vec<u8>> {
    let (tag, content, _length) = der_tlv(cert, 0)?;
    if tag != 0x30 {
        return None;
    }
    let (tbs_tag, tbs_start, tbs_len) = der_tlv(cert, content)?;
    if tbs_tag != 0x30 {
        return None;
    }
    let mut pos = tbs_start;
    let end = tbs_start + tbs_len;
    let (first_tag, first_start, first_len) = der_tlv(cert, pos)?;
    if first_tag == 0xA0 {
        pos = first_start + first_len;
    }
    // serialNumber, signature, issuer, validity, subject
    for _ in 0..5 {
        let (_tag, start, len) = der_tlv(cert, pos)?;
        pos = start + len;
        if pos > end {
            return None;
        }
    }
    let (spki_tag, spki_start, spki_len) = der_tlv(cert, pos)?;
    if spki_tag != 0x30 {
        return None;
    }
    Some(cert[pos..spki_start + spki_len].to_vec())
}

pub fn pem_of(der: &[u8]) -> String {
    let encoded = B64.encode(der);
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in encoded.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out
}

/// base64(SHA-256(DER SubjectPublicKeyInfo)); the value a caller pins by SPKI.
pub fn spki_pin(cert_der: &[u8]) -> Result<String> {
    let spki = extract_spki(cert_der).context("SPKI extraction")?;
    Ok(B64.encode(Sha256::digest(&spki)))
}

pub fn self_signed() -> Result<(CertificateDer<'static>, PrivatePkcs8KeyDer<'static>)> {
    let mut params = CertificateParams::new(vec![])?;
    params
        .distinguished_name
        .push(DnType::CommonName, "cloakium-lab-h3");
    params.subject_alt_names = vec![
        SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        SanType::DnsName("localhost".try_into()?),
    ];
    let key_pair = KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;
    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivatePkcs8KeyDer::from(key_pair.serialize_der());
    Ok((cert_der, key_der))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn certificate() -> Vec<u8> {
        self_signed().expect("self-signed certificate").0.to_vec()
    }

    #[test]
    fn der_length_reads_short_and_long_forms() {
        assert_eq!(der_length(&[0x05], 0), Some((1, 5)));
        assert_eq!(der_length(&[0x82, 0x01, 0x00], 0), Some((3, 256)));
        assert_eq!(der_length(&[0x85, 0, 0, 0, 0, 0], 0), None, "count above 4");
        assert_eq!(der_length(&[0x80], 0), None, "indefinite length");
        assert_eq!(der_length(&[], 0), None);
    }

    #[test]
    fn der_tlv_rejects_truncated_content() {
        assert_eq!(
            der_tlv(&[0x30, 0x03, 0x01, 0x02, 0x03], 0),
            Some((0x30, 2, 3))
        );
        assert_eq!(der_tlv(&[0x30, 0x04, 0x01], 0), None);
        assert_eq!(der_tlv(&[], 0), None);
    }

    #[test]
    fn spki_extraction_yields_a_sequence_tlv() {
        let cert = certificate();
        let spki = extract_spki(&cert).expect("SPKI");
        assert_eq!(spki.first(), Some(&0x30), "SPKI is a SEQUENCE");
        assert!(spki.len() > 32, "SPKI carries algorithm id and key");
        assert!(
            extract_spki(&[0x30, 0x00]).is_none(),
            "empty TBSCertificate"
        );
    }

    #[test]
    fn pin_is_stable_base64_of_sha256() {
        let cert = certificate();
        let first = spki_pin(&cert).expect("pin");
        assert_eq!(first, spki_pin(&cert).expect("pin"), "same cert, same pin");
        assert_eq!(B64.decode(&first).map(|raw| raw.len()), Ok(32));
        assert_eq!(first.len(), 44, "base64 of 32 bytes without padding");
    }

    #[test]
    fn pem_wraps_at_sixty_four_columns() {
        let pem = pem_of(&certificate());
        let body: Vec<&str> = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        assert!(body.len() > 1, "certificate spans several lines");
        for line in body {
            assert!(line.len() <= 64, "line {} too long", line.len());
        }
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----\n"));
        assert!(pem.ends_with("-----END CERTIFICATE-----\n"));
    }
}
