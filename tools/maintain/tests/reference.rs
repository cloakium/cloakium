//! The constructed flake reference must let Nix choose the git fetcher.
//!
//! A forced `path:` reference copies the whole working tree, including
//! `target/`, `node_modules/` and staged release artifacts, into the Nix store
//! on every update and signing run. A bare absolute path lets Nix detect a
//! colocated Git/JJ checkout and fall back to the path fetcher only for plain
//! scratch directories.

mod support;

use std::fs;
use std::path::Path;
use std::process::Command as Process;
use std::time::Duration;

use cloakium_maintain::command::{Command, ProcessRunner, Runner};
use cloakium_maintain::util;
use serde_json::Value;

fn nix_available() -> bool {
    std::env::var_os("CLOAKIUM_SKIP_NIX_TESTS").is_none()
        && Process::new("nix")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
}

fn git_available() -> bool {
    Process::new("git")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[test]
fn the_reference_is_a_bare_absolute_path() {
    let reference = util::flake_reference(Path::new("/work/cloakium"));
    assert_eq!(reference, "/work/cloakium");
    assert!(!reference.starts_with("path:"));
}

#[test]
fn a_plain_directory_still_evaluates_as_a_flake() {
    if !nix_available() {
        eprintln!("skipping the flake reference probe: nix is unavailable");
        return;
    }
    let (_directory, root) = support::temp_root();
    fs::write(
        root.join("flake.nix"),
        "{ outputs = _: { chromium.version = \"1.2.3.4\"; }; }\n",
    )
    .expect("flake.nix");

    let reference = util::flake_reference(&root);
    let output = ProcessRunner
        .run(
            &Command::new(
                "nix",
                vec![
                    "eval".to_string(),
                    "--raw".to_string(),
                    format!("{reference}#chromium.version"),
                ],
            )
            .timeout(Duration::from_secs(300)),
        )
        .expect("the scratch flake must evaluate");
    assert_eq!(output.stdout_trimmed(), "1.2.3.4");
}

#[test]
fn a_git_checkout_resolves_through_the_git_fetcher() {
    if !nix_available() || !git_available() {
        eprintln!("skipping the git fetcher probe: nix or git is unavailable");
        return;
    }
    let (_directory, root) = support::temp_root();
    fs::write(
        root.join("flake.nix"),
        "{ outputs = _: { chromium.version = \"5.6.7.8\"; }; }\n",
    )
    .expect("flake.nix");
    fs::write(root.join(".gitignore"), "target/\n").expect(".gitignore");
    fs::create_dir_all(root.join("target")).expect("target directory");
    fs::write(root.join("target/bloat.bin"), vec![0u8; 64 * 1024]).expect("bloat");

    for arguments in [
        vec!["init"],
        vec!["add", "-A"],
        vec![
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.email=test@example.test",
            "-c",
            "user.name=Cloakium Test",
            "commit",
            "-m",
            "probe",
        ],
    ] {
        let status = Process::new("git")
            .args(&arguments)
            .current_dir(&root)
            .status()
            .expect("git runs");
        assert!(status.success(), "git {arguments:?} failed");
    }

    let reference = util::flake_reference(&root);
    let output = ProcessRunner
        .run(
            &Command::new(
                "nix",
                vec![
                    "flake".to_string(),
                    "metadata".to_string(),
                    reference.clone(),
                    "--json".to_string(),
                ],
            )
            .timeout(Duration::from_secs(300)),
        )
        .expect("flake metadata");
    let metadata: Value = serde_json::from_str(output.stdout_trimmed()).expect("metadata json");
    let url = metadata["url"].as_str().expect("url");
    assert!(
        url.starts_with("git+file"),
        "a colocated checkout must resolve through the git fetcher, got {url}"
    );

    let snapshot = metadata["path"].as_str().expect("path");
    assert!(
        !Path::new(snapshot).join("target").exists(),
        "the ignored target/ directory must not be part of the flake input"
    );
}
