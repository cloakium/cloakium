//! Layout rules: full checkouts ignore build outputs, staged candidates stay
//! strict, and symlinked metadata paths are rejected.

mod support;

use std::fs;

use cloakium_maintain::report::Reporter;
use cloakium_maintain::validate_update::{prepare, ValidateUpdateOptions, ALLOWED_FILES};

use support::update_candidate::{
    add_build_outputs, as_checkout, expect_failure, new_trees, run, CHROMIUM, NEW_PLAYWRIGHT,
};

#[test]
fn a_real_workspace_with_build_outputs_is_accepted() {
    let trees = new_trees();
    as_checkout(&trees);
    add_build_outputs(&trees.base);
    add_build_outputs(&trees.candidate);

    let outcome = run(&trees.base, &trees.candidate).expect("a real workspace must validate");

    assert_eq!(outcome.files, ALLOWED_FILES.to_vec());
    assert_eq!(outcome.playwright, NEW_PLAYWRIGHT);
}

#[test]
fn a_metadata_symlink_is_rejected_in_a_checkout() {
    let trees = new_trees();
    as_checkout(&trees);
    let target = trees.base.join("package.json");
    let link = trees.candidate.join("package.json");
    fs::remove_file(&link).expect("remove package.json");
    std::os::unix::fs::symlink(&target, &link).expect("symlink");
    expect_failure(&trees, "path contains a symlink");
}

#[test]
fn a_symlinked_metadata_ancestor_is_rejected() {
    let trees = new_trees();
    as_checkout(&trees);
    let real = trees.candidate.join("nix-real");
    fs::rename(trees.candidate.join("nix"), &real).expect("rename nix");
    std::os::unix::fs::symlink(&real, trees.candidate.join("nix")).expect("symlink nix");
    expect_failure(&trees, "path contains a symlink");
}

#[test]
fn a_symlinked_candidate_root_is_rejected() {
    let trees = new_trees();
    let link = trees._directory.path().join("candidate-link");
    std::os::unix::fs::symlink(&trees.candidate, &link).expect("symlink candidate");
    let error = prepare(
        &ValidateUpdateOptions {
            base: trees.base.clone(),
            candidate: link,
        },
        &Reporter::silent(),
    )
    .expect_err("a symlinked candidate root must be rejected");
    assert!(
        format!("{error:#}").contains("candidate root must not be a symlink"),
        "{error:#}"
    );
}

#[test]
fn a_deleted_metadata_file_is_rejected_in_a_checkout() {
    let trees = new_trees();
    as_checkout(&trees);
    fs::remove_file(trees.candidate.join("package-lock.json")).expect("remove");
    expect_failure(&trees, "deletes package-lock.json");
}

#[test]
fn source_changes_in_a_checkout_are_outside_this_check() {
    let trees = new_trees();
    as_checkout(&trees);
    // The release workflow's diff allowlist owns source changes; this command
    // only proves the metadata is a legitimate pin update.
    fs::write(
        trees.candidate.join("src/app.ts"),
        "export const changed = true;\n",
    )
    .expect("source change");
    run(&trees.base, &trees.candidate).expect("metadata validation ignores source files");
}

#[test]
fn a_staged_candidate_still_rejects_extra_files_and_symlinks() {
    // No checkout markers: the directory is a staged candidate and stays strict.
    let trees = new_trees();
    fs::write(trees.candidate.join("src-injected.ts"), b"export {}").expect("extra file");
    expect_failure(&trees, "may not touch");
}

#[test]
fn a_normal_update_candidate_is_accepted() {
    let trees = new_trees();
    let reporter = Reporter::new(Some(trees.base.join("outputs")), false);

    let outcome = prepare(
        &ValidateUpdateOptions {
            base: trees.base.clone(),
            candidate: trees.candidate.clone(),
        },
        &reporter,
    )
    .expect("candidate accepted");

    assert_eq!(outcome.playwright, NEW_PLAYWRIGHT);
    assert_eq!(outcome.chromium, CHROMIUM);
    assert_eq!(outcome.files, ALLOWED_FILES.to_vec());
    let emitted = fs::read_to_string(trees.base.join("outputs")).expect("outputs");
    assert!(
        emitted.contains(&format!("playwright={NEW_PLAYWRIGHT}")),
        "{emitted}"
    );
    assert!(emitted.contains("files=flake.lock"), "{emitted}");
}

#[test]
fn a_file_outside_the_allowlist_is_rejected() {
    let trees = new_trees();
    fs::write(trees.candidate.join("src-injected.ts"), b"export {}").expect("extra file");
    expect_failure(&trees, "may not touch");
}

#[test]
fn a_nested_extra_file_is_rejected() {
    let trees = new_trees();
    fs::create_dir_all(trees.candidate.join("nix/extra")).expect("directory");
    fs::write(trees.candidate.join("nix/extra/hook.nix"), b"{}").expect("extra file");
    expect_failure(&trees, "may not touch");
}

#[test]
fn an_empty_candidate_is_rejected() {
    let trees = new_trees();
    fs::remove_dir_all(&trees.candidate).expect("remove candidate");
    fs::create_dir(&trees.candidate).expect("empty candidate");
    expect_failure(&trees, "no update files");
}

#[test]
fn a_candidate_symlink_is_rejected() {
    let trees = new_trees();
    std::os::unix::fs::symlink(
        trees.base.join("package.json"),
        trees.candidate.join("extra-link"),
    )
    .expect("symlink");
    expect_failure(&trees, "symlink");
}
