//! Real regression for closure signing.
//!
//! A staging cache built from a real store path arrives with upstream
//! signatures on its substituted dependencies, and contains custom paths (the
//! patched browser and its sandbox helpers) that do not exist in any upstream
//! cache. Nix signatures attest cache-path integrity, so an unsigned closure
//! entry forces consumers to fall back and eventually rebuild. This test:
//!
//! 1. builds a real `nixpkgs#hello` closure plus two *custom* derivations, one
//!    of which is a transitive dependency that is not a manifest root;
//! 2. stages everything unsigned (inherited signatures stripped);
//! 3. proves an offline signed substitution from that cache is impossible
//!    before signing;
//! 4. runs the trusted signing flow and proves every narinfo carries the
//!    release key;
//! 5. proves the same offline substitution now succeeds and brings the custom
//!    transitive dependency with it, with no substituter or builder available.

mod support;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as Process;

use cloakium_maintain::cache;
use cloakium_maintain::command::ProcessRunner;
use cloakium_maintain::narinfo::NarInfo;
use cloakium_maintain::release;
use cloakium_maintain::report::Reporter;
use cloakium_maintain::sign_release::{prepare, SignReleaseOptions};
use cloakium_maintain::util;
use serde_json::json;
use support::write_json;

const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";
const CHROMIUM: &str = "157.0.8103.50";
const PLAYWRIGHT: &str = "1.65.0";
const BUNDLED_CHROMIUM: &str = "158.0.8127.18";

fn nix_available() -> bool {
    std::env::var_os("CLOAKIUM_SKIP_NIX_TESTS").is_none()
        && Process::new("nix")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
}

fn build(attributes: &[&str]) -> Option<PathBuf> {
    let output = Process::new("nix")
        .args(["build", "--no-link", "--print-out-paths"])
        .args(attributes)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

fn build_expression(expression: &str) -> Option<PathBuf> {
    let output = Process::new("nix")
        .args([
            "build",
            "--impure",
            "--no-link",
            "--print-out-paths",
            "--expr",
            expression,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

fn generate_keys(root: &Path) -> Option<(PathBuf, PathBuf, String)> {
    let secret = root.join("secret.key");
    let public = root.join("public.key");
    let generated = Process::new("nix")
        .args([
            "key",
            "generate-secret",
            "--key-name",
            &format!("cloakium-closure-test-{}", std::process::id()),
        ])
        .output()
        .ok()?;
    if !generated.status.success() {
        return None;
    }
    fs::write(&secret, &generated.stdout).ok()?;
    let converted = Process::new("nix")
        .args(["key", "convert-secret-to-public"])
        .stdin(fs::File::open(&secret).ok()?)
        .output()
        .ok()?;
    if !converted.status.success() {
        return None;
    }
    fs::write(&public, &converted.stdout).ok()?;
    Some((
        secret,
        public,
        String::from_utf8_lossy(&converted.stdout)
            .trim()
            .to_string(),
    ))
}

/// Substitute offline from the flat cache into a fresh chroot store.
fn copy_offline(
    cache_dir: &Path,
    destination: &Path,
    public_key: &str,
    root: &Path,
) -> (bool, String) {
    let output = Process::new("nix")
        .args([
            "copy",
            "--from",
            &format!("file://{}", cache_dir.display()),
            "--to",
            &format!("local?root={}", destination.display()),
            "--option",
            "require-sigs",
            "true",
            "--option",
            "trusted-public-keys",
            public_key,
            "--option",
            "substituters",
            "",
        ])
        .arg(root)
        .output()
        .expect("nix copy runs");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn write_release_metadata(directory: &Path, outputs: &[String], public: &Path) {
    let lock = json!({
        "nodes": {
            "nixpkgs": {"locked": {"rev": "0123456789abcdef0123456789abcdef01234567", "narHash": "sha256-lock", "lastModified": 1}},
            "root": {"inputs": {"nixpkgs": "nixpkgs"}}
        },
        "root": "root",
        "version": 7
    });
    let lock_text = format!("{}\n", serde_json::to_string_pretty(&lock).expect("lock"));
    fs::write(directory.join(release::FLAKE_LOCK_ASSET), &lock_text).expect("flake lock");
    let lock_sha = util::digest(&directory.join(release::FLAKE_LOCK_ASSET)).expect("digest");
    fs::write(directory.join("cloakium-browser-0.1.0.tgz"), b"browser").expect("tarball");
    fs::write(directory.join("playwright-core-1.65.0.tgz"), b"driver").expect("tarball");

    let manifest = json!({
        "schemaVersion": 1,
        "sourceRevision": REVISION,
        "tag": release::release_tag(CHROMIUM, PLAYWRIGHT, REVISION),
        "system": "x86_64-linux",
        "chromium": CHROMIUM,
        "playwright": PLAYWRIGHT,
        "packageVersion": "0.1.0",
        "upstream": {
            "playwright": {
                "version": PLAYWRIGHT,
                "url": format!("https://registry.npmjs.org/playwright-core/-/playwright-core-{PLAYWRIGHT}.tgz"),
                "hash": format!("sha256-{}=", "A".repeat(43)),
                "chromiumVersion": BUNDLED_CHROMIUM,
                "browserRevision": "1254"
            },
            "chromium": {"version": CHROMIUM}
        },
        "outputs": {
            "chromium": outputs[0],
            "playwright": outputs[1],
            "browser": outputs[2]
        },
        "packages": {
            "browser": "cloakium-browser-0.1.0.tgz",
            "playwright": "playwright-core-1.65.0.tgz"
        },
        "patches": {"patches/probe.patch": "a".repeat(64)},
        "flakeLock": {
            "asset": release::FLAKE_LOCK_ASSET,
            "sha256": lock_sha,
            "content": lock_text,
            "nixpkgsRevision": "0123456789abcdef0123456789abcdef01234567"
        },
        "signed": false
    });
    write_json(&directory.join(release::MANIFEST_ASSET), &manifest);

    let evidence = json!({
        "status": "passed",
        "exitCode": 0,
        "signals": [],
        "browserVersion": CHROMIUM,
        "playwright": PLAYWRIGHT,
        "checks": [{"name": "browser", "status": "passed"}]
    });
    write_json(&directory.join(release::EVIDENCE_ASSET), &evidence);

    fs::copy(public, directory.join(release::PUBLIC_KEY_ASSET)).expect("public key");
    cache::write_checksums(directory).expect("checksums");
}

#[test]
fn the_whole_closure_is_signed_and_substitutes_offline() {
    if !nix_available() {
        eprintln!("skipping the closure signing test: nix is unavailable");
        return;
    }
    let Some(hello) = build(&["nixpkgs#hello"]) else {
        eprintln!("skipping the closure signing test: nixpkgs#hello is unavailable");
        return;
    };
    // A custom root with a custom transitive dependency that is not a manifest
    // root and cannot come from any upstream cache.
    let Some(custom_root) = build_expression(
        "let dep = derivation { name = \"cloakium-custom-dep\"; system = builtins.currentSystem; \
         builder = \"/bin/sh\"; args = [ \"-c\" \"printf custom-dep > $out\" ]; }; \
         in derivation { name = \"cloakium-custom-root\"; system = builtins.currentSystem; \
         builder = \"/bin/sh\"; args = [ \"-c\" \"printf '%s' ${dep} > $out\" ]; }",
    ) else {
        eprintln!("skipping the closure signing test: cannot build the custom root");
        return;
    };
    let Some(custom_other) = build_expression(
        "derivation { name = \"cloakium-custom-other\"; system = builtins.currentSystem; \
         builder = \"/bin/sh\"; args = [ \"-c\" \"printf custom-other > $out\" ]; }",
    ) else {
        eprintln!("skipping the closure signing test: cannot build the second custom path");
        return;
    };

    let (_directory, root) = support::temp_root();
    let staged = cache::stage_cache(
        &[hello.clone(), custom_root.clone(), custom_other.clone()],
        &root.join("stage"),
        None,
        &mut ProcessRunner,
    )
    .expect("an unsigned stage must accept inherited upstream signatures");

    assert!(!staged.join("nar").exists(), "the cache must be flattened");
    let mut narinfos = BTreeMap::new();
    for path in cache::narinfo_paths(&staged).expect("narinfos") {
        let text = fs::read_to_string(&path).expect("narinfo");
        assert!(
            !cache::has_signature_line(&text),
            "an inherited signature survived in {}",
            path.display()
        );
        let info = NarInfo::parse(&text).expect("parse narinfo");
        info.verify_payload(&staged)
            .unwrap_or_else(|error| panic!("payload integrity for {}: {error:#}", info.store_path));
        narinfos.insert(info.store_path, path);
    }
    // hello's closure plus the two custom paths.
    assert!(narinfos.len() > 3, "the closure must contain dependencies");

    let custom_dependency = narinfos
        .keys()
        .find(|path| path.contains("cloakium-custom-dep"))
        .expect("the custom transitive dependency is staged")
        .clone();
    assert!(
        !custom_root
            .display()
            .to_string()
            .contains("cloakium-custom-dep"),
        "the custom dependency is not a manifest root"
    );

    let Some((secret, public, public_text)) = generate_keys(&root) else {
        eprintln!("skipping the signing half: cannot generate a key");
        return;
    };
    write_release_metadata(
        &staged,
        &[
            hello.display().to_string(),
            custom_root.display().to_string(),
            custom_other.display().to_string(),
        ],
        &public,
    );

    // Before signing, an offline signed substitution must fail: the custom
    // paths cannot come from anywhere else.
    let (unsigned_copy, unsigned_log) = copy_offline(
        &staged,
        &root.join("dst-unsigned"),
        &public_text,
        &custom_root,
    );
    assert!(
        !unsigned_copy,
        "an unsigned cache must not satisfy a require-sigs substitution:\n{unsigned_log}"
    );
    let lower = unsigned_log.to_lowercase();
    assert!(
        lower.contains("signature") || lower.contains("untrusted"),
        "the unsigned copy must fail for a signature reason:\n{unsigned_log}"
    );

    let options = SignReleaseOptions {
        input: staged.clone(),
        output: None,
        revision: REVISION.to_string(),
        signing_key: secret,
        public_key: public,
    };
    let outcome = prepare(&options, &mut ProcessRunner, &Reporter::silent())
        .expect("the trusted signer must sign the whole closure");
    assert_eq!(outcome.narinfos, narinfos.len());
    assert_eq!(outcome.manifest["signed"], true);

    let key_name = public_text
        .split_once(':')
        .map(|(name, _)| name.to_string())
        .expect("public key is name:base64");
    for (store_path, path) in &narinfos {
        let text = fs::read_to_string(path).expect("narinfo");
        assert!(
            text.contains(&format!("Sig: {key_name}:")),
            "{store_path} is not signed by the release key"
        );
    }

    // Now the same offline substitution succeeds and carries the custom
    // transitive dependency, with no substituter or builder available.
    let destination = root.join("dst-signed");
    let (signed_copy, signed_log) = copy_offline(&staged, &destination, &public_text, &custom_root);
    assert!(
        signed_copy,
        "the signed cache must substitute offline:\n{signed_log}"
    );
    let copied_custom_dep = destination.join(custom_dependency.trim_start_matches('/'));
    if !copied_custom_dep.exists() {
        let listing = Process::new("find")
            .arg(&destination)
            .args(["-maxdepth", "4"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
            .unwrap_or_default();
        panic!(
            "the custom transitive dependency was not substituted: {}\ncopy log:\n{signed_log}\ndestination:\n{listing}",
            copied_custom_dep.display()
        );
    }
    let copied_root = destination.join(custom_root.display().to_string().trim_start_matches('/'));
    assert!(copied_root.exists(), "the custom root was not substituted");

    // The regenerated checksums match the signed tree.
    let sums = fs::read_to_string(staged.join(release::SUMS_ASSET)).expect("sums");
    for line in sums.lines() {
        let (digest, name) = line.split_once("  ").expect("two spaces");
        assert_eq!(
            digest,
            util::digest(&staged.join(name)).expect("digest"),
            "{name}"
        );
    }
}
