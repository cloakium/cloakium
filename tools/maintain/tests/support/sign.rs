//! Shared fixture for the `sign-release` test suites.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use anyhow::{bail, Result};
use cloakium_maintain::cache;
use cloakium_maintain::command::{Command, MockRunner, Output, Stdin};
use cloakium_maintain::narinfo::nix32_encode;
use cloakium_maintain::report::Reporter;
use cloakium_maintain::sign_release::{prepare, SignReleaseOptions, SignReleaseOutcome};
use cloakium_maintain::util;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{is_command, ok, read_json, write_json};

pub const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";
pub const CHROMIUM: &str = "157.0.8103.50";
/// The CfT major the driver bundles; deliberately one newer than native.
pub const BUNDLED_CHROMIUM: &str = "158.0.8127.18";
pub const PLAYWRIGHT: &str = "1.65.0";
pub const TAG: &str = "chromium-157.0.8103.50-pw-1.65.0-0123456789";
pub const PUBLIC_KEY: &str = "cloakium-test:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
pub const OUTPUTS: [(&str, &str); 3] = [
    ("chromium", "/nix/store/aaa-chromium"),
    ("playwright", "/nix/store/bbb-playwright"),
    ("browser", "/nix/store/ccc-browser"),
];

pub struct Staged {
    pub _directory: tempfile::TempDir,
    pub root: PathBuf,
    pub release: PathBuf,
    pub signing_key: PathBuf,
    pub public_key: PathBuf,
}

impl Staged {
    pub fn options(&self) -> SignReleaseOptions {
        SignReleaseOptions {
            input: self.release.clone(),
            output: None,
            revision: REVISION.to_string(),
            signing_key: self.signing_key.clone(),
            public_key: self.public_key.clone(),
        }
    }

    pub fn manifest(&self) -> Value {
        read_json(&self.release.join("manifest.json"))
    }

    pub fn narinfo(&self, name: &str) -> String {
        fs::read_to_string(self.release.join(format!("{name}.narinfo"))).expect("narinfo")
    }
}

pub fn nix32(bytes: &[u8]) -> String {
    nix32_encode(&Sha256::digest(bytes))
}

fn sri() -> String {
    format!("sha256-{}=", "A".repeat(43))
}

/// A staged release equivalent to `release --unsigned` output.
pub fn staged() -> Staged {
    let (directory, root) = super::temp_root();
    let release = root.join("release");
    fs::create_dir_all(&release).expect("release directory");

    for (name, store_path) in OUTPUTS {
        let payload = format!("payload for {name}").into_bytes();
        let digest = nix32(&payload);
        fs::write(release.join(format!("{name}.nar")), &payload).expect("nar");
        fs::write(
            release.join(format!("{name}.narinfo")),
            format!(
                "StorePath: {store_path}\nURL: {name}.nar\nCompression: none\nFileHash: sha256:{digest}\nFileSize: {len}\nNarHash: sha256:{digest}\nNarSize: {len}\nReferences: \n",
                len = payload.len()
            ),
        )
        .expect("narinfo");
    }
    fs::write(
        release.join("cloakium-browser-0.1.0.tgz"),
        b"browser tarball",
    )
    .expect("tarball");
    fs::write(
        release.join("playwright-core-1.65.0.tgz"),
        b"driver tarball",
    )
    .expect("tarball");

    // A runtime-closure dependency that is not one of the manifest outputs; it
    // must be signed too, otherwise it cannot be substituted from the release.
    let payload = b"dependency payload".to_vec();
    let digest = nix32(&payload);
    fs::write(release.join("dependency.nar"), &payload).expect("nar");
    fs::write(
        release.join("dependency.narinfo"),
        format!(
            "StorePath: /nix/store/ddd-dependency\nURL: dependency.nar\nCompression: none\nFileHash: sha256:{digest}\nFileSize: {len}\nNarHash: sha256:{digest}\nNarSize: {len}\nReferences: \n",
            len = payload.len()
        ),
    )
    .expect("narinfo");

    let lock = json!({
        "nodes": {
            "nixpkgs": {"locked": {"rev": "0123456789abcdef0123456789abcdef01234567", "narHash": "sha256-lock", "lastModified": 1}},
            "root": {"inputs": {"nixpkgs": "nixpkgs"}}
        },
        "root": "root",
        "version": 7
    });
    let lock_text = format!("{}\n", serde_json::to_string_pretty(&lock).expect("lock"));
    fs::write(release.join("source-flake.lock"), &lock_text).expect("lock");
    let lock_sha = util::digest(&release.join("source-flake.lock")).expect("digest");

    let manifest = json!({
        "schemaVersion": 1,
        "sourceRevision": REVISION,
        "tag": TAG,
        "system": "x86_64-linux",
        "chromium": CHROMIUM,
        "playwright": PLAYWRIGHT,
        "packageVersion": "0.1.0",
        "upstream": {
            "playwright": {
                "version": PLAYWRIGHT,
                "url": format!("https://registry.npmjs.org/playwright-core/-/playwright-core-{PLAYWRIGHT}.tgz"),
                "hash": sri(),
                "chromiumVersion": BUNDLED_CHROMIUM,
                "browserRevision": "1254",
                "notes": "inert metadata"
            },
            "chromium": {"version": CHROMIUM}
        },
        "outputs": {
            "chromium": OUTPUTS[0].1,
            "playwright": OUTPUTS[1].1,
            "browser": OUTPUTS[2].1
        },
        "packages": {
            "browser": "cloakium-browser-0.1.0.tgz",
            "playwright": "playwright-core-1.65.0.tgz"
        },
        "patches": {"patches/probe.patch": "a".repeat(64)},
        "flakeLock": {
            "asset": "source-flake.lock",
            "sha256": lock_sha,
            "content": lock_text,
            "nixpkgsRevision": "0123456789abcdef0123456789abcdef01234567"
        },
        "signed": false
    });
    write_json(&release.join("manifest.json"), &manifest);

    let evidence = json!({
        "status": "passed",
        "exitCode": 0,
        "signals": [],
        "browserVersion": format!("Chromium {CHROMIUM}"),
        "chromium": CHROMIUM,
        "playwright": PLAYWRIGHT,
        "checks": [
            {"name": "browser", "status": "passed"},
            {"name": "driver", "exitCode": 0, "signals": []}
        ]
    });
    write_json(&release.join("verification.json"), &evidence);

    let signing_key = root.join("cache.key");
    fs::write(&signing_key, "not a real key\n").expect("signing key");
    let public_key = root.join("cache-public-key.txt");
    fs::write(&public_key, format!("{PUBLIC_KEY}\n")).expect("public key");

    cache::write_checksums(&release).expect("checksums");

    Staged {
        _directory: directory,
        root,
        release,
        signing_key,
        public_key,
    }
}

/// Mocked `nix` signing/verification. The secret must arrive on stdin, the
/// narinfos must be unsigned before signing, and signing recreates the
/// bookkeeping directories the real CLI creates.
pub fn signer(
    derived_key: &str,
    signed: Rc<RefCell<usize>>,
) -> MockRunner<impl FnMut(&Command) -> Result<Output>> {
    let derived_key = derived_key.to_string();
    MockRunner::new(move |command: &Command| -> Result<Output> {
        if is_command(command, "nix", &["key", "convert-secret-to-public"]) {
            assert!(
                matches!(command.stdin, Stdin::File(_)),
                "the secret must travel on stdin, never argv"
            );
            assert!(!command.display().contains("not a real key"));
            return Ok(ok(&derived_key));
        }
        if is_command(command, "nix", &["store", "sign"]) {
            let store = command
                .args
                .get(3)
                .and_then(|url| url.strip_prefix("file://"))
                .expect("store url");
            fs::create_dir_all(Path::new(store).join("log"))?;
            fs::write(Path::new(store).join("log/sign.log"), b"log")?;
            fs::create_dir_all(Path::new(store).join("nar"))?;
            for entry in fs::read_dir(store)? {
                let path = entry?.path();
                if path.extension().and_then(|value| value.to_str()) != Some("narinfo") {
                    continue;
                }
                let text = fs::read_to_string(&path)?;
                assert!(
                    !text.contains("Sig:"),
                    "narinfos must be stripped before signing"
                );
                fs::write(&path, format!("{text}Sig: cloakium-test:c2ln\n"))?;
            }
            *signed.borrow_mut() += 1;
            return Ok(ok("added 3 signatures"));
        }
        if is_command(command, "nix", &["store", "verify"]) {
            assert!(command.args.contains(&"--sigs-needed".to_string()));
            assert!(command.args.iter().any(|arg| arg == PUBLIC_KEY));
            for (_, store_path) in OUTPUTS {
                assert!(
                    command.args.iter().any(|arg| arg == store_path),
                    "{store_path} is not verified"
                );
            }
            return Ok(ok(""));
        }
        bail!("unexpected command: {}", command.display())
    })
}

pub fn run(options: &SignReleaseOptions) -> Result<SignReleaseOutcome> {
    let mut runner = signer(PUBLIC_KEY, Rc::new(RefCell::new(0)));
    prepare(options, &mut runner, &Reporter::silent())
}

pub fn expect_failure(options: &SignReleaseOptions, needle: &str) {
    let error = run(options).expect_err("prepare must fail");
    let message = format!("{error:#}");
    assert!(message.contains(needle), "expected {needle:?} in {message}");
}
