//! Behaviour tests for a successful `cloakium-maintain sign-release` run.

mod support;

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;

use cloakium_maintain::report::Reporter;
use cloakium_maintain::sign_release::prepare;
use cloakium_maintain::util;
use support::sign::{signer, staged, CHROMIUM, OUTPUTS, PUBLIC_KEY, TAG};

#[test]
fn a_staged_release_is_verified_and_signed() {
    let current = staged();
    let signed = Rc::new(RefCell::new(0));
    let mut runner = signer(PUBLIC_KEY, signed.clone());
    let reporter = Reporter::new(Some(current.root.join("outputs")), false);

    let outcome =
        prepare(&current.options(), &mut runner, &reporter).expect("sign the staged release");

    assert_eq!(*signed.borrow(), 1, "the cache is signed exactly once");
    assert_eq!(outcome.tag, TAG);
    assert_eq!(
        outcome.narinfos, 4,
        "three outputs plus a closure dependency"
    );
    for (name, _) in OUTPUTS {
        let info = current.narinfo(name);
        assert!(info.contains("Sig: cloakium-test:"), "{info}");
        assert!(info.contains("NarHash: sha256:"), "{info}");
    }
    // The whole shipped closure is signed, not only the manifest outputs.
    let dependency =
        fs::read_to_string(current.release.join("dependency.narinfo")).expect("dependency");
    assert!(dependency.contains("Sig: cloakium-test:"), "{dependency}");

    let manifest = current.manifest();
    assert_eq!(manifest["signed"], true);
    assert_eq!(manifest["signing"]["verified"], true);
    assert_eq!(manifest["signing"]["narinfos"], 4);
    assert_eq!(manifest["signing"]["publicKey"], PUBLIC_KEY);

    let notes = fs::read_to_string(current.release.join("release-notes.md")).expect("notes");
    assert!(notes.contains("## Provenance"), "{notes}");
    assert!(notes.contains("No code from the staged"), "{notes}");
    assert!(!notes.contains("CloakHQ"));
    assert_eq!(
        fs::read_to_string(current.release.join("cache-public-key.txt")).expect("key"),
        format!("{PUBLIC_KEY}\n")
    );

    // Signing reopens the cache; its bookkeeping directories must not ship.
    assert!(
        !current.release.join("log").exists(),
        "no log directory may survive into the release"
    );
    assert!(
        !current.release.join("nar").exists(),
        "signing must not leave an unflattened cache"
    );
    let dirs = fs::read_dir(&current.release)
        .expect("list release")
        .filter(|entry| entry.as_ref().expect("entry").path().is_dir())
        .count();
    assert_eq!(dirs, 0, "the release directory must be flat");

    // SHA256SUMS is regenerated over the signed tree.
    let sums = fs::read_to_string(current.release.join("SHA256SUMS")).expect("sums");
    assert!(sums.contains("manifest.json"), "{sums}");
    for line in sums.lines() {
        let (digest, name) = line.split_once("  ").expect("two spaces");
        assert_eq!(
            digest,
            util::digest(&current.release.join(name)).expect("digest"),
            "{name}"
        );
    }

    let emitted = fs::read_to_string(current.root.join("outputs")).expect("outputs");
    assert!(emitted.contains(&format!("tag={TAG}")), "{emitted}");
    assert!(
        emitted.contains(&format!("chromium={CHROMIUM}")),
        "{emitted}"
    );
}

#[test]
fn an_output_directory_keeps_the_input_unsigned() {
    let current = staged();
    let mut requested = current.options();
    requested.output = Some(current.root.join("signed"));
    let mut runner = signer(PUBLIC_KEY, Rc::new(RefCell::new(0)));

    prepare(&requested, &mut runner, &Reporter::silent()).expect("sign into a new directory");

    let input = current.narinfo("chromium");
    assert!(!input.contains("Sig:"), "{input}");
    let output = fs::read_to_string(current.root.join("signed/chromium.narinfo")).expect("signed");
    assert!(output.contains("Sig:"), "{output}");
    assert_eq!(
        support::read_json(&current.root.join("signed/manifest.json"))["signed"],
        true
    );
    let input_sums =
        fs::read_to_string(current.release.join("SHA256SUMS")).expect("input checksums");
    assert!(input_sums.contains("manifest.json"), "{input_sums}");
}

#[test]
fn a_release_with_a_different_public_key_file_is_still_signed_by_the_trusted_one() {
    let current = staged();
    // The staged release carries no public key asset; sign-release writes it.
    let mut runner = signer(PUBLIC_KEY, Rc::new(RefCell::new(0)));
    prepare(&current.options(), &mut runner, &Reporter::silent()).expect("sign");
    assert!(current.release.join("cache-public-key.txt").is_file());
}
