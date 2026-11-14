//! Behaviour tests for a full `cloakium-maintain release` run.

mod support;

use std::fs;

use cloakium_maintain::release::{prepare, release_tag, validate_revision};
use cloakium_maintain::report::Reporter;
use cloakium_maintain::util;
use serde_json::Value;
use support::read_json;
use support::release::{
    fixture, options, release_runner, BUNDLED_CHROMIUM, CHROMIUM, PLAYWRIGHT, REVISION,
};

#[test]
fn revisions_must_be_full_lowercase_commit_ids() {
    validate_revision(REVISION).expect("valid revision");
    for invalid in [
        "",
        "0123456",
        "0123456789ABCDEF0123456789ABCDEF01234567",
        "0123456789abcdef0123456789abcdef0123456",
        "0123456789abcdef0123456789abcdef012345678",
        "g123456789abcdef0123456789abcdef01234567",
    ] {
        let error = validate_revision(invalid).expect_err(invalid);
        assert!(format!("{error:#}").contains("--revision"), "{error:#}");
    }
}

#[test]
fn tags_identify_chromium_playwright_and_source() {
    assert_eq!(
        release_tag(CHROMIUM, PLAYWRIGHT, REVISION),
        "chromium-157.0.8103.50-pw-1.65.0-0123456789"
    );
}

#[test]
fn a_complete_release_is_staged() {
    let fixture = fixture();
    let mut runner = release_runner(&fixture);
    let outputs = fixture.root.join("github-output");
    let reporter = Reporter::new(Some(outputs.clone()), false);

    let outcome = prepare(&options(&fixture), &mut runner, &reporter).expect("release");

    assert_eq!(outcome.tag, "chromium-157.0.8103.50-pw-1.65.0-0123456789");
    let release = &fixture.output;
    assert!(!release.join("nar").exists());

    // Flat signed cache assets.
    for name in ["first.nar.xz", "second.nar.xz", "nix-cache-info"] {
        assert!(release.join(name).is_file(), "{name} is missing");
    }
    let first_info = fs::read_to_string(release.join("first.narinfo")).expect("narinfo");
    assert!(first_info.contains("URL: first.nar.xz"), "{first_info}");
    assert!(
        first_info.contains("Sig: cloakium-maintain-test:"),
        "{first_info}"
    );

    // Manifest pins, outputs, packages, patch hashes and the source lock.
    let manifest = read_json(&release.join("manifest.json"));
    assert_eq!(manifest["schemaVersion"], 1);
    assert_eq!(manifest["sourceRevision"], REVISION);
    assert_eq!(manifest["system"], "x86_64-linux");
    assert_eq!(manifest["chromium"], CHROMIUM);
    assert_eq!(manifest["playwright"], PLAYWRIGHT);
    assert_eq!(manifest["upstream"]["playwright"]["version"], PLAYWRIGHT);
    assert_eq!(
        manifest["upstream"]["playwright"]["chromiumVersion"], BUNDLED_CHROMIUM,
        "the CfT pin is preserved separately from the native build"
    );
    assert_eq!(
        manifest["upstream"]["chromium"]["version"], CHROMIUM,
        "the native pin records what was actually built"
    );
    assert_eq!(manifest["tag"], outcome.tag);
    assert_eq!(manifest["packageVersion"], "0.1.0");
    assert_eq!(manifest["signed"], true);
    assert_eq!(manifest["flakeLock"]["asset"], "source-flake.lock");
    assert_eq!(
        manifest["flakeLock"]["sha256"],
        util::digest(&fixture.root.join("flake.lock")).expect("lock digest")
    );
    assert_eq!(
        manifest["flakeLock"]["nixpkgsRevision"],
        "0123456789abcdef0123456789abcdef01234567"
    );
    assert_eq!(manifest["compatibility"]["nativeChromium"], CHROMIUM);
    assert_eq!(
        manifest["compatibility"]["playwrightChromium"],
        BUNDLED_CHROMIUM
    );
    assert_eq!(manifest["compatibility"]["majorsApart"], 1);
    assert_eq!(manifest["compatibility"]["informational"], true);
    assert!(release.join("source-flake.lock").is_file());
    assert_eq!(
        manifest["outputs"]["chromium"],
        fixture.store.join("chromium").display().to_string()
    );
    assert_eq!(
        manifest["packages"]["browser"],
        "cloakium-browser-0.1.0.tgz"
    );
    assert_eq!(
        manifest["packages"]["playwright"],
        "playwright-core-1.65.0.tgz"
    );
    assert_eq!(
        manifest["patches"]["patches/a.patch"],
        util::digest(&fixture.root.join("patches/a.patch")).expect("digest")
    );
    assert_eq!(
        manifest["patches"]["patches/nested/b.patch"],
        util::digest(&fixture.root.join("patches/nested/b.patch")).expect("digest")
    );
    assert!(manifest["patches"].get("patches/ignored.txt").is_none());

    // Ancillary assets.
    assert!(release.join("closure.json").is_file());
    assert!(release.join("verification.json").is_file());
    assert_eq!(
        fs::read_to_string(release.join("cache-public-key.txt")).expect("public key"),
        "cloakium-maintain-test:AAAA\n"
    );

    // SHA256SUMS covers every other asset exactly once.
    let sums = fs::read_to_string(release.join("SHA256SUMS")).expect("sums");
    let mut listed: Vec<&str> = sums
        .lines()
        .map(|line| line.split_once("  ").expect("two spaces").1)
        .collect();
    listed.sort_unstable();
    let mut present: Vec<String> = fs::read_dir(release)
        .expect("list release")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name != "SHA256SUMS")
        .collect();
    present.sort();
    assert_eq!(listed, present);
    for line in sums.lines() {
        let (digest, _) = line.split_once("  ").expect("two spaces");
        assert_eq!(digest.len(), 64, "{line}");
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()), "{line}");
    }

    // Release notes are original and pin the source.
    let notes = fs::read_to_string(release.join("release-notes.md")).expect("notes");
    assert!(notes.contains(&format!("# Cloakium {CHROMIUM} / Playwright {PLAYWRIGHT}")));
    assert!(notes.contains(REVISION));
    assert!(!notes.contains("CloakHQ"));
    assert!(!notes.to_lowercase().contains("adaptation"));

    // Workflow outputs.
    let emitted = fs::read_to_string(outputs).expect("outputs");
    for expected in [
        format!("tag={}", outcome.tag),
        format!("version={PLAYWRIGHT}"),
        format!("chromium={CHROMIUM}"),
        format!("assets={}", release.display()),
    ] {
        assert!(emitted.contains(&expected), "{emitted}");
    }

    // The flake reference must let Nix pick the git fetcher for a checkout.
    for entry in runner.rendered_history() {
        assert!(!entry.contains("path:"), "path: reference in {entry}");
    }
}

#[test]
fn build_runs_only_when_requested() {
    {
        let current = fixture();
        let mut runner = release_runner(&current);
        prepare(&options(&current), &mut runner, &Reporter::silent()).expect("release");
        assert!(
            !runner
                .rendered_history()
                .iter()
                .any(|entry| entry.starts_with("nix build")),
            "release must not rebuild without --build"
        );
    }

    let current = fixture();
    let mut runner = release_runner(&current);
    let mut requested = options(&current);
    requested.build = true;
    prepare(&requested, &mut runner, &Reporter::silent()).expect("release with build");

    let history = runner.rendered_history();
    let build = history
        .iter()
        .find(|entry| entry.starts_with("nix build"))
        .expect("nix build ran");
    assert!(build.contains("--no-link"), "{build}");
    assert!(build.contains("--max-jobs 1"), "{build}");
    assert!(build.contains("--cores 16"), "{build}");
    assert!(build.contains("#chromium"), "{build}");
    assert!(build.contains("#playwright"), "{build}");
    assert!(build.contains("#browser"), "{build}");
}

#[test]
fn the_pack_destination_is_the_release_directory() {
    let fixture = fixture();
    let mut runner = release_runner(&fixture);
    prepare(&options(&fixture), &mut runner, &Reporter::silent()).expect("release");
    let history = runner.rendered_history();
    let pack = history
        .iter()
        .find(|entry| entry.starts_with("npm pack"))
        .expect("npm pack");
    assert!(
        pack.contains(&fixture.output.display().to_string()),
        "{pack}"
    );
    assert!(
        pack.contains("lib/node_modules/@cloakium/browser"),
        "{pack}"
    );
}

#[test]
fn the_manifest_is_valid_json_with_stable_keys() {
    let fixture = fixture();
    let mut runner = release_runner(&fixture);
    let outcome = prepare(&options(&fixture), &mut runner, &Reporter::silent()).expect("release");
    let keys: Vec<&str> = outcome
        .manifest
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "schemaVersion",
            "sourceRevision",
            "tag",
            "system",
            "chromium",
            "playwright",
            "packageVersion",
            "upstream",
            "outputs",
            "packages",
            "patches",
            "flakeLock",
            "compatibility",
            "signed"
        ]
    );
    let on_disk = read_json(&fixture.output.join("manifest.json"));
    assert_eq!(on_disk, outcome.manifest);
    assert!(matches!(on_disk, Value::Object(_)));
}
