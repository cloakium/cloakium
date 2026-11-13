//! Behaviour tests for staged cache signing, unsigned staging and a real Nix
//! store round trip.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as Process;

use anyhow::Result;
use cloakium_maintain::cache::{stage_cache, verify_unsigned};
use cloakium_maintain::command::{Command, MockRunner, Output, ProcessRunner};

use support::{ok, write_cache_directory};

#[test]
fn stage_cache_refuses_reused_output_and_missing_keys() {
    let (_directory, root) = support::temp_root();
    let key = root.join("cache.key");
    fs::write(&key, "secret").expect("write key");
    let mut runner = MockRunner::new(|_: &Command| -> Result<Output> { Ok(ok("")) });

    let existing = root.join("release");
    fs::create_dir(&existing).expect("dir");
    let error = stage_cache(
        &[PathBuf::from("/nix/store/a")],
        &existing,
        Some(&key),
        &mut runner,
    )
    .expect_err("existing output");
    assert!(format!("{error:#}").contains("refuse"), "{error:#}");

    let missing_key = root.join("absent.key");
    let error = stage_cache(
        &[PathBuf::from("/nix/store/a")],
        &root.join("other"),
        Some(&missing_key),
        &mut runner,
    )
    .expect_err("missing key");
    assert!(format!("{error:#}").contains("signing key"), "{error:#}");
}

#[test]
fn stage_cache_flattens_and_verifies_what_the_copy_wrote() {
    let (_directory, root) = support::temp_root();
    let key = root.join("cache.key");
    fs::write(&key, "secret").expect("write key");
    let output = root.join("release");

    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        // Simulate `nix copy` writing an unflattened cache into the destination.
        let destination = command.args[2]
            .strip_prefix("file://")
            .and_then(|rest| rest.split('?').next())
            .expect("destination");
        write_cache_directory(
            Path::new(destination),
            "/nix/store/example",
            Some("cloakium-test:c2lnbmF0dXJl"),
        );
        Ok(ok(""))
    });

    let staged = stage_cache(
        &[PathBuf::from("/nix/store/example")],
        &output,
        Some(&key),
        &mut runner,
    )
    .expect("stage");

    assert!(staged.join("example.nar.xz").is_file());
    assert!(!staged.join("nar").exists());
    let info = fs::read_to_string(staged.join("example.narinfo")).expect("narinfo");
    assert!(info.contains("URL: example.nar.xz"), "{info}");
    assert!(info.contains("Sig: cloakium-test:"), "{info}");
    let history = runner.rendered_history();
    assert!(history[0].contains("nix copy --to file://"), "{history:?}");
    assert!(!history[0].contains("secret"), "the key path is redacted");
}

#[test]
fn unsigned_staging_has_no_key_and_no_signatures() {
    let (_directory, root) = support::temp_root();
    let output = root.join("release");
    let destination = std::cell::RefCell::new(String::new());
    {
        let destination = &destination;
        let mut runner = MockRunner::new(move |command: &Command| -> Result<Output> {
            let raw = command.args[2].clone();
            *destination.borrow_mut() = raw.clone();
            let directory = raw
                .strip_prefix("file://")
                .and_then(|rest| rest.split('?').next())
                .expect("destination");
            write_cache_directory(Path::new(directory), "/nix/store/example", None);
            Ok(ok(""))
        });
        stage_cache(
            &[PathBuf::from("/nix/store/example")],
            &output,
            None,
            &mut runner,
        )
        .expect("stage");
    }

    let copy = destination.borrow().clone();
    assert!(!copy.contains("secret-key"), "{copy}");
    assert!(copy.contains("compression=xz"), "{copy}");
    assert!(output.join("example.nar.xz").is_file());
    verify_unsigned(&output).expect("an unsigned staging cache is valid");
}

#[test]
fn total_size_sums_every_regular_file() {
    let (_directory, root) = support::temp_root();
    fs::write(root.join("a"), vec![0u8; 10]).expect("file");
    fs::create_dir(root.join("sub")).expect("directory");
    fs::write(root.join("sub/b"), vec![0u8; 5]).expect("file");

    assert_eq!(
        cloakium_maintain::cache::total_size(&root).expect("size"),
        15
    );
}

#[test]
fn a_signed_cache_is_rejected_as_unsigned() {
    let (_directory, root) = support::temp_root();
    write_cache_directory(&root, "/nix/store/example", Some("guard:abc"));
    let error = verify_unsigned(&root).expect_err("signed input");
    assert!(
        format!("{error:#}").contains("must not be signed"),
        "{error:#}"
    );
}

// ---------------------------------------------------------------------------
// Real Nix store integration. Skipped when the environment cannot sign/copy.
// ---------------------------------------------------------------------------
fn nix_available() -> bool {
    std::env::var_os("CLOAKIUM_SKIP_NIX_TESTS").is_none()
        && Process::new("nix")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
}

fn build_probe_derivation() -> Option<PathBuf> {
    let expression =
        "derivation { name = \"cloakium-maintain-probe\"; system = builtins.currentSystem; \
        builder = \"/bin/sh\"; args = [ \"-c\" \"printf hi > $out\" ]; }";
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
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

fn signs_and_copies(
    public_key: &str,
    source: &Path,
    destination: &Path,
    store_path: &Path,
) -> bool {
    Process::new("nix")
        .args([
            "copy",
            "--from",
            &format!("file://{}", source.display()),
            "--to",
            &format!("local?root={}", destination.display()),
            "--option",
            "trusted-public-keys",
            public_key,
            "--option",
            "require-sigs",
            "true",
        ])
        .arg(store_path)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[test]
fn a_real_store_path_is_signed_flat_and_still_verifiable() {
    if !nix_available() {
        eprintln!("skipping the Nix signing integration test: nix is unavailable");
        return;
    }
    let Some(store_path) = build_probe_derivation() else {
        eprintln!("skipping the Nix signing integration test: cannot build a probe derivation");
        return;
    };
    let (_directory, root) = support::temp_root();
    let secret = root.join("secret.key");
    let public = root.join("public.key");

    let generated = Process::new("nix")
        .args([
            "key",
            "generate-secret",
            "--key-name",
            &format!("cloakium-maintain-test-{}", std::process::id()),
        ])
        .output()
        .expect("generate a signing key");
    assert!(generated.status.success());
    fs::write(&secret, &generated.stdout).expect("write secret key");

    let converted = Process::new("nix")
        .args(["key", "convert-secret-to-public"])
        .stdin(fs::File::open(&secret).expect("open secret"))
        .output()
        .expect("derive the public key");
    assert!(converted.status.success());
    fs::write(&public, &converted.stdout).expect("write public key");
    let public_key = String::from_utf8_lossy(&converted.stdout)
        .trim()
        .to_string();
    assert!(public_key.contains(':'), "public key must be name:base64");

    let staged = stage_cache(
        std::slice::from_ref(&store_path),
        &root.join("release"),
        Some(&secret),
        &mut ProcessRunner,
    )
    .expect("stage a signed cache");

    assert!(
        !staged.join("nar").exists(),
        "the nar directory is flattened"
    );
    let narinfos: Vec<PathBuf> = fs::read_dir(&staged)
        .expect("list the staged cache")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("narinfo"))
        .collect();
    assert_eq!(narinfos.len(), 1, "one store path, one narinfo");
    let info = fs::read_to_string(&narinfos[0]).expect("narinfo");
    assert!(info.contains("Sig: "), "{info}");
    assert!(info.contains("NarHash: "), "{info}");
    assert!(info.contains("URL: "), "{info}");
    assert!(!info.contains("URL: nar/"), "{info}");
    let store_line = info
        .lines()
        .find_map(|line| line.strip_prefix("StorePath: "))
        .expect("store path line");
    assert_eq!(store_line, store_path.display().to_string());
    let nar_name = info
        .lines()
        .find_map(|line| line.strip_prefix("URL: "))
        .expect("flat URL");
    assert!(staged.join(nar_name).is_file(), "{nar_name}");

    // A cache that still carries the original signature must be consumable.
    assert!(
        signs_and_copies(&public_key, &staged, &root.join("trusted"), &store_path),
        "the flattened cache must verify against the release public key"
    );

    // Prove the check is real: a tampered signature must be rejected.
    let tampered = root.join("tampered");
    copy_tree(&staged, &tampered);
    for entry in fs::read_dir(&tampered).expect("list") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|value| value.to_str()) != Some("narinfo") {
            continue;
        }
        let contents = fs::read_to_string(&path).expect("read narinfo");
        let rewritten: String = contents
            .lines()
            .map(|line| {
                if line.starts_with("Sig: ") {
                    "Sig: cloakium-maintain-test:AAAA"
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, format!("{rewritten}\n")).expect("write narinfo");
    }
    assert!(
        !signs_and_copies(&public_key, &tampered, &root.join("rejected"), &store_path),
        "a tampered signature must be rejected"
    );
}

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).expect("create destination");
    for entry in fs::read_dir(source).expect("list source") {
        let entry = entry.expect("entry");
        let target = destination.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("copy asset");
        }
    }
}
