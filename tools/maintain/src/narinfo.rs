//! `.narinfo` parsing and NAR payload verification.
//!
//! A narinfo signature covers the store path, NAR hash, NAR size and
//! references — not the URL and not the compressed bytes. Publishing therefore
//! requires hashing the actual payload: `FileHash`/`FileSize` describe the
//! compressed file, and decompressing it must reproduce `NarHash`/`NarSize`.

use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use sha2::{Digest, Sha256};

const NIX32_ALPHABET: &[u8] = b"0123456789abcdfghijklmnpqrsvwxyz";

/// Nix's own base32 encoding (not RFC 4648), used in `sha256:` hash fields.
pub fn nix32_encode(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let length = (bytes.len() * 8 - 1) / 5 + 1;
    let mut encoded = String::with_capacity(length);
    for index in (0..length).rev() {
        let bit = index * 5;
        let byte = bit / 8;
        let offset = bit % 8;
        let low = (bytes[byte] as u32) >> offset;
        let high = if byte + 1 < bytes.len() {
            (bytes[byte + 1] as u32) << (8 - offset)
        } else {
            0
        };
        encoded.push(NIX32_ALPHABET[((low | high) & 0x1f) as usize] as char);
    }
    encoded
}

#[derive(Debug, Clone)]
pub struct NarInfo {
    pub store_path: String,
    pub url: String,
    pub compression: String,
    pub file_hash: Option<String>,
    pub file_size: Option<u64>,
    pub nar_hash: String,
    pub nar_size: u64,
    pub references: Vec<String>,
    pub signatures: Vec<String>,
}

impl NarInfo {
    pub fn parse(text: &str) -> Result<Self> {
        let mut store_path = None;
        let mut url = None;
        let mut compression = String::new();
        let mut file_hash = None;
        let mut file_size = None;
        let mut nar_hash = None;
        let mut nar_size = None;
        let mut references = Vec::new();
        let mut signatures = Vec::new();

        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let (key, value) = split_field(line)?;
            match key {
                "StorePath" => set_once(&mut store_path, value, key)?,
                "URL" => set_once(&mut url, value, key)?,
                "Compression" => compression = value.to_string(),
                "FileHash" => set_once(&mut file_hash, value, key)?,
                "FileSize" => {
                    let parsed = value
                        .parse::<u64>()
                        .with_context(|| format!("invalid FileSize {value:?}"))?;
                    if file_size.replace(parsed).is_some() {
                        bail!("duplicate FileSize in narinfo");
                    }
                }
                "NarHash" => set_once(&mut nar_hash, value, key)?,
                "NarSize" => {
                    let parsed = value
                        .parse::<u64>()
                        .with_context(|| format!("invalid NarSize {value:?}"))?;
                    if nar_size.replace(parsed).is_some() {
                        bail!("duplicate NarSize in narinfo");
                    }
                }
                "References" => {
                    references = value.split_whitespace().map(str::to_string).collect();
                }
                "Sig" => signatures.push(value.to_string()),
                _ => {}
            }
        }

        Ok(Self {
            store_path: required(store_path, "StorePath")?,
            url: required(url, "URL")?,
            compression,
            file_hash,
            file_size,
            nar_hash: required(nar_hash, "NarHash")?,
            nar_size: nar_size.context("narinfo is missing NarSize")?,
            references,
            signatures,
        })
    }

    /// The payload file must be a flat, single-component name.
    pub fn payload_path(&self, directory: &Path) -> Result<PathBuf> {
        let mut components = Path::new(&self.url).components();
        let name = match (components.next(), components.next()) {
            (Some(Component::Normal(name)), None) => name,
            _ => bail!("unexpected cache asset URL: {}", self.url),
        };
        Ok(directory.join(name))
    }

    /// Hash the compressed payload and the decompressed NAR.
    pub fn verify_payload(&self, directory: &Path) -> Result<()> {
        let path = self.payload_path(directory)?;
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("cache payload is missing: {}", self.url))?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "cache payload is not a regular file: {}",
            self.url
        );
        if let Some(expected) = self.file_size {
            ensure!(
                metadata.len() == expected,
                "FileSize for {} is {expected}, payload is {} bytes",
                self.url,
                metadata.len()
            );
        }

        if let Some(expected) = &self.file_hash {
            let mut reader = BufReader::new(File::open(&path)?);
            let actual = hash_and_count(&mut reader)?.0;
            ensure!(
                actual == *hash_digest(expected)?,
                "FileHash for {} does not match the payload (expected {expected}, got sha256:{actual})",
                self.url
            );
        }

        let reader = BufReader::new(File::open(&path)?);
        let mut decoder: Box<dyn Read> = match self.compression.as_str() {
            "xz" => Box::new(xz2::read::XzDecoder::new(reader)),
            "" | "none" => Box::new(reader),
            other => bail!("unsupported cache compression: {other}"),
        };
        let (actual, size) = hash_and_count(&mut decoder)?;
        ensure!(
            size == self.nar_size,
            "NarSize for {} is {}, decompressed payload is {size} bytes",
            self.url,
            self.nar_size
        );
        ensure!(
            actual == *hash_digest(&self.nar_hash)?,
            "NarHash for {} does not match the decompressed payload (expected {}, got sha256:{actual})",
            self.url,
            self.nar_hash
        );
        Ok(())
    }
}

/// Remove every signature line, keeping all other fields byte-identical.
pub fn strip_signatures(text: &str) -> String {
    let mut stripped = String::with_capacity(text.len());
    for segment in text.split_inclusive('\n') {
        if segment.starts_with("Sig: ") || segment.trim_end() == "Sig:" {
            continue;
        }
        stripped.push_str(segment);
    }
    stripped
}

fn split_field(line: &str) -> Result<(&str, &str)> {
    if let Some((key, value)) = line.split_once(": ") {
        return Ok((key, value));
    }
    if let Some(key) = line.strip_suffix(':') {
        return Ok((key, ""));
    }
    bail!("invalid narinfo line: {line:?}")
}

fn set_once(slot: &mut Option<String>, value: &str, key: &str) -> Result<()> {
    if slot.replace(value.to_string()).is_some() {
        bail!("duplicate {key} in narinfo");
    }
    Ok(())
}

fn required(value: Option<String>, key: &str) -> Result<String> {
    value.with_context(|| format!("narinfo is missing {key}"))
}

fn hash_and_count(reader: &mut dyn Read) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut total = 0u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((nix32_encode(&hasher.finalize()), total))
}

/// Split `sha256:<nix32>` and reject any other algorithm.
pub fn hash_digest(value: &str) -> Result<&str> {
    let (algorithm, digest) = value
        .split_once(':')
        .with_context(|| format!("invalid hash {value:?}"))?;
    ensure!(
        algorithm == "sha256",
        "unsupported hash algorithm {algorithm:?} in {value:?}"
    );
    ensure!(
        digest.len() == 52 && digest.bytes().all(|byte| NIX32_ALPHABET.contains(&byte)),
        "invalid nix32 digest in {value:?}"
    );
    Ok(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "StorePath: /nix/store/abc-example\nURL: abc.nar.xz\nCompression: none\nFileHash: sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73\nFileSize: 0\nNarHash: sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73\nNarSize: 0\nReferences: \nSig: key:AAAA\n";

    #[test]
    fn nix32_matches_nix() {
        assert_eq!(
            nix32_encode(&Sha256::digest(b"hello\n")),
            "00xyyr3fi8l6hb839bv3f7yb86yjv7xi1cgh1xnhipym4asvb4aq"
        );
        assert_eq!(
            nix32_encode(&Sha256::digest(b"")),
            "0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73"
        );
    }

    #[test]
    fn parse_reads_required_fields() {
        let info = NarInfo::parse(SAMPLE).expect("parse");
        assert_eq!(info.store_path, "/nix/store/abc-example");
        assert_eq!(info.url, "abc.nar.xz");
        assert_eq!(info.compression, "none");
        assert_eq!(info.signatures, vec!["key:AAAA".to_string()]);
        assert_eq!(info.nar_size, 0);
        assert!(info.references.is_empty());
    }

    #[test]
    fn parse_rejects_missing_and_duplicate_fields() {
        let missing = SAMPLE.replace("NarHash", "IgnoredHash");
        assert!(NarInfo::parse(&missing).is_err());
        let duplicate = format!("{SAMPLE}NarSize: 1\n");
        assert!(NarInfo::parse(&duplicate).is_err());
    }

    #[test]
    fn strip_signatures_keeps_everything_else() {
        let stripped = strip_signatures(SAMPLE);
        assert!(!stripped.contains("Sig:"));
        assert_eq!(stripped, SAMPLE.replace("Sig: key:AAAA\n", ""));
    }

    #[test]
    fn payload_verification_accepts_an_empty_nar() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("abc.nar.xz"), b"").expect("payload");
        NarInfo::parse(SAMPLE)
            .expect("parse")
            .verify_payload(directory.path())
            .expect("empty payload verifies");
    }

    #[test]
    fn payload_verification_rejects_wrong_bytes() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("abc.nar.xz"), b"not empty").expect("payload");
        let error = NarInfo::parse(SAMPLE)
            .expect("parse")
            .verify_payload(directory.path())
            .expect_err("payload mismatch");
        assert!(format!("{error:#}").contains("FileSize"), "{error:#}");
    }

    #[test]
    fn xz_payloads_are_decompressed_before_hashing() {
        let directory = tempfile::tempdir().expect("tempdir");
        let nar = b"a fake but consistent NAR payload";
        let mut encoder = xz2::write::XzEncoder::new(Vec::new(), 6);
        std::io::Write::write_all(&mut encoder, nar).expect("compress");
        let compressed = encoder.finish().expect("finish");
        std::fs::write(directory.path().join("abc.nar.xz"), &compressed).expect("payload");

        let nar_hash = nix32_encode(&Sha256::digest(nar));
        let file_hash = nix32_encode(&Sha256::digest(&compressed));
        let text = format!(
            "StorePath: /nix/store/abc-example\nURL: abc.nar.xz\nCompression: xz\nFileHash: sha256:{file_hash}\nFileSize: {}\nNarHash: sha256:{nar_hash}\nNarSize: {}\nReferences: \n",
            compressed.len(),
            nar.len()
        );
        NarInfo::parse(&text)
            .expect("parse")
            .verify_payload(directory.path())
            .expect("xz payload verifies");

        let mut tampered = text.clone();
        tampered = tampered.replace(&nar_hash, &nix32_encode(&Sha256::digest(b"other")));
        let error = NarInfo::parse(&tampered)
            .expect("parse")
            .verify_payload(directory.path())
            .expect_err("nar hash mismatch");
        assert!(format!("{error:#}").contains("NarHash"), "{error:#}");
    }

    #[test]
    fn signature_text_never_bypasses_payload_verification() {
        // A signature line is just text; tampering with the payload must still
        // be caught, both before and after normalisation drops inherited
        // signatures.
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("abc.nar"), b"tampered payload").expect("payload");
        let narinfo = "StorePath: /nix/store/abc-example\nURL: abc.nar\nCompression: none\nNarHash: sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73\nNarSize: 0\nSig: cache.nixos.org-1:not-a-real-signature\n";
        let info = NarInfo::parse(narinfo).expect("parse");
        assert!(info.verify_payload(directory.path()).is_err());

        let stripped = strip_signatures(narinfo);
        assert!(!stripped.contains("Sig:"));
        let info = NarInfo::parse(&stripped).expect("parse stripped");
        assert!(info.verify_payload(directory.path()).is_err());
    }

    #[test]
    fn malformed_signature_lines_are_removed() {
        let text = "StorePath: /nix/store/abc-example\nURL: abc.nar\nNarHash: sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73\nNarSize: 0\nSig: no-colon\nSig:\nSig: key:value\n";
        let stripped = strip_signatures(text);
        assert!(!stripped.contains("Sig"));
        assert_eq!(
            stripped,
            "StorePath: /nix/store/abc-example\nURL: abc.nar\nNarHash: sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73\nNarSize: 0\n"
        );
    }

    #[test]
    fn payload_urls_must_be_flat() {
        let text = SAMPLE.replace("URL: abc.nar.xz", "URL: nar/abc.nar.xz");
        let info = NarInfo::parse(&text).expect("parse");
        let directory = tempfile::tempdir().expect("tempdir");
        assert!(info.payload_path(directory.path()).is_err());
    }

    #[test]
    fn unsupported_compression_is_rejected() {
        let text = SAMPLE.replace("Compression: none", "Compression: bzip2");
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("abc.nar.xz"), b"").expect("payload");
        let error = NarInfo::parse(&text)
            .expect("parse")
            .verify_payload(directory.path())
            .expect_err("compression");
        assert!(format!("{error:#}").contains("unsupported"), "{error:#}");
    }
}
