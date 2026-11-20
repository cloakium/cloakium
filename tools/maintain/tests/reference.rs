//! Nix must exclude ignored outputs in colocated Jujutsu workspaces.

mod support;

use std::fs;
use std::path::Path;
use std::time::Duration;

use cloakium_maintain::command::{Command, ProcessRunner, Runner};
use cloakium_maintain::util;
use serde_json::Value;

fn nix_available() -> bool {
    std::env::var_os("CLOAKIUM_SKIP_NIX_TESTS").is_none()
        && ProcessRunner
            .run(&Command::new("nix", ["--version"]).timeout(Duration::from_secs(10)))
            .is_ok()
}

fn jj_available() -> bool {
    ProcessRunner
        .run(&Command::new("jj", ["--version"]).timeout(Duration::from_secs(10)))
        .is_ok()
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
fn a_jj_checkout_resolves_through_the_git_fetcher() {
    if !nix_available() || !jj_available() {
        eprintln!("skipping the colocated fetcher probe: nix or jj is unavailable");
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
        vec!["git", "init", "--colocate"],
        vec!["describe", "-m", "probe"],
        vec!["new"],
    ] {
        let mut args = vec![
            "--config",
            "signing.behavior=\"drop\"",
            "--config",
            "user.email=\"test@example.test\"",
            "--config",
            "user.name=\"Cloakium Test\"",
        ];
        args.extend(arguments);
        ProcessRunner
            .run(
                &Command::new("jj", args)
                    .cwd(&root)
                    .timeout(Duration::from_secs(30)),
            )
            .expect("the fixture's Jujutsu operation must succeed");
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
