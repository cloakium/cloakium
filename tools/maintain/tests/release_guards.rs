//! Guard rails for `cloakium-maintain release`: unsigned staging and refusals.

mod support;

use std::cell::RefCell;
use std::fs;
use std::path::Path;
use std::rc::Rc;

use anyhow::{bail, Result};
use cloakium_maintain::command::{Command, MockRunner, Output};
use cloakium_maintain::npm_pack::pack;
use cloakium_maintain::release::prepare;
use cloakium_maintain::report::Reporter;
use serde_json::json;
use support::release::{
    fixture, options, release_runner, unsigned_options, write_staged_cache, Fixture,
    BUNDLED_CHROMIUM, CHROMIUM,
};
use support::{is_command, ok, read_json, write_json};

fn unsigned_runner(
    fixture: &Fixture,
    destination: Rc<RefCell<String>>,
) -> MockRunner<impl FnMut(&Command) -> Result<Output>> {
    let chromium_out = fixture.store.join("chromium").display().to_string();
    let playwright_out = fixture.store.join("playwright").display().to_string();
    let browser_out = fixture.store.join("browser").display().to_string();
    let playwright_lib = fixture
        .store
        .join("playwright/lib/node_modules/playwright-core")
        .display()
        .to_string();
    let closure = json!({"/nix/store/aaa-first": {"narHash": "sha256:first"}}).to_string();

    MockRunner::new(move |command: &Command| -> Result<Output> {
        if command.program == "npm" {
            let index = command
                .args
                .iter()
                .position(|arg| arg == "--pack-destination")
                .expect("--pack-destination");
            let output = command.args[index + 1].clone();
            let source = command.args.last().expect("package directory");
            let name = if source.contains("@cloakium/browser") {
                "cloakium-browser-0.1.0.tgz"
            } else {
                "playwright-core-1.65.0.tgz"
            };
            fs::write(Path::new(&output).join(name), name.as_bytes()).expect("tarball");
            return Ok(ok(&json!([{"filename": name}]).to_string()));
        }
        if is_command(command, "nix", &["copy"]) {
            let raw = command.args[2].clone();
            let directory = raw
                .strip_prefix("file://")
                .and_then(|rest| rest.split('?').next())
                .expect("destination")
                .to_string();
            write_staged_cache(Path::new(&directory), false);
            *destination.borrow_mut() = raw;
            return Ok(ok(""));
        }
        if is_command(command, "nix", &["path-info"]) {
            return Ok(ok(&closure));
        }
        if is_command(command, "nix", &["eval"]) {
            let expression = command.args.last().expect("expression");
            if expression.ends_with("builtins.currentSystem") {
                return Ok(ok("x86_64-linux"));
            }
            if expression.ends_with("#chromium.version") {
                return Ok(ok(CHROMIUM));
            }
            if expression.ends_with("#playwright.libPath") {
                return Ok(ok(&playwright_lib));
            }
            if expression.ends_with(".chromium.outPath") {
                return Ok(ok(&chromium_out));
            }
            if expression.ends_with(".playwright.outPath") {
                return Ok(ok(&playwright_out));
            }
            if expression.ends_with(".browser.outPath") {
                return Ok(ok(&browser_out));
            }
        }
        Ok(ok(""))
    })
}

#[test]
fn unsigned_release_stages_without_a_key() {
    let current = fixture();
    let destination = Rc::new(RefCell::new(String::new()));
    let mut runner = unsigned_runner(&current, destination.clone());
    let mut requested = unsigned_options(&current);
    requested.public_key = None;

    let outcome = prepare(&requested, &mut runner, &Reporter::silent()).expect("unsigned release");

    let copy = destination.borrow().clone();
    assert!(!copy.contains("secret-key"), "{copy}");
    assert!(copy.contains("compression=xz"), "{copy}");
    let info = fs::read_to_string(current.output.join("first.narinfo")).expect("narinfo");
    assert!(!info.contains("Sig:"), "{info}");
    let manifest = read_json(&current.output.join("manifest.json"));
    assert_eq!(manifest["signed"], false);
    assert!(manifest.get("signing").is_none());
    let notes = fs::read_to_string(current.output.join("release-notes.md")).expect("notes");
    assert!(notes.contains("unsigned"), "{notes}");
    assert_eq!(outcome.tag, "chromium-157.0.8103.50-pw-1.65.0-0123456789");
}

#[test]
fn an_unsigned_cache_entry_fails_a_signed_release() {
    let current = fixture();
    let mut runner = unsigned_runner(&current, Rc::new(RefCell::new(String::new())));
    let mut requested = options(&current);
    requested.evidence = None;
    requested.public_key = None;

    let error = prepare(&requested, &mut runner, &Reporter::silent())
        .expect_err("an unsigned cache cannot satisfy a signed release");
    assert!(format!("{error:#}").contains("unsigned"), "{error:#}");
}

#[test]
fn an_existing_output_directory_is_refused() {
    let current = fixture();
    fs::create_dir_all(&current.output).expect("existing output");
    let mut runner = release_runner(&current);
    let error =
        prepare(&options(&current), &mut runner, &Reporter::silent()).expect_err("existing output");
    assert!(format!("{error:#}").contains("refuse"), "{error:#}");
}

#[test]
fn missing_evidence_is_refused() {
    let current = fixture();
    let mut requested = options(&current);
    requested.evidence = Some(current.root.join("absent.json"));
    let mut runner = release_runner(&current);
    let error =
        prepare(&requested, &mut runner, &Reporter::silent()).expect_err("missing evidence");
    assert!(
        format!("{error:#}").contains("test evidence file does not exist"),
        "{error:#}"
    );
}

#[test]
fn invalid_build_options_are_rejected() {
    let current = fixture();
    let mut requested = options(&current);
    requested.cores = 0;
    let mut runner = release_runner(&current);
    let error = prepare(&requested, &mut runner, &Reporter::silent()).expect_err("zero cores");
    assert!(format!("{error:#}").contains("--cores"), "{error:#}");

    let current = fixture();
    let mut requested = options(&current);
    requested.build_timeout = std::time::Duration::ZERO;
    let mut runner = release_runner(&current);
    let error =
        prepare(&requested, &mut runner, &Reporter::silent()).expect_err("zero build timeout");
    assert!(
        format!("{error:#}").contains("--build-timeout"),
        "{error:#}"
    );
}

#[test]
fn missing_inputs_fail_before_any_command_runs() {
    let current = fixture();
    let mut requested = options(&current);
    requested.signing_key = Some(current.root.join("absent.key"));
    let mut runner = release_runner(&current);
    let error = prepare(&requested, &mut runner, &Reporter::silent()).expect_err("missing key");
    assert!(format!("{error:#}").contains("signing key"), "{error:#}");
    assert!(
        runner.rendered_history().is_empty(),
        "no command may run before the key is validated"
    );

    let current = fixture();
    let mut requested = options(&current);
    requested.public_key = Some(current.root.join("absent-public-key.txt"));
    let mut runner = release_runner(&current);
    let error =
        prepare(&requested, &mut runner, &Reporter::silent()).expect_err("missing public key");
    assert!(format!("{error:#}").contains("public key"), "{error:#}");
    assert!(runner.rendered_history().is_empty());
}

#[test]
fn a_key_and_unsigned_are_mutually_exclusive() {
    let current = fixture();
    let mut requested = unsigned_options(&current);
    requested.signing_key = Some(current.signing_key.clone());
    requested.unsigned = true;
    let mut runner = release_runner(&current);
    let error = prepare(&requested, &mut runner, &Reporter::silent()).expect_err("both modes");
    assert!(
        format!("{error:#}").contains("--unsigned cannot be combined"),
        "{error:#}"
    );
    assert!(runner.rendered_history().is_empty());
}

#[test]
fn pack_rejects_a_filename_with_a_path() {
    let (_directory, root) = support::temp_root();
    let package = root.join("package");
    fs::create_dir_all(&package).expect("package dir");
    let output = root.join("out");
    fs::create_dir_all(&output).expect("output dir");

    let mut runner = MockRunner::new(|_: &Command| -> Result<Output> {
        Ok(ok(&json!([{"filename": "../evil.tgz"}]).to_string()))
    });
    let error = pack(&package, &output, &mut runner).expect_err("traversal filename");
    assert!(
        format!("{error:#}").contains("unexpected npm pack filename"),
        "{error:#}"
    );
}

#[test]
fn pack_rejects_a_multi_tarball_result() {
    let (_directory, root) = support::temp_root();
    let package = root.join("package");
    fs::create_dir_all(&package).expect("package dir");
    let mut runner = MockRunner::new(|_: &Command| -> Result<Output> {
        Ok(ok(
            &json!([{"filename": "a.tgz"}, {"filename": "b.tgz"}]).to_string()
        ))
    });
    assert!(pack(&package, &root, &mut runner).is_err());
}

#[test]
fn pack_uses_ignore_scripts() {
    let (_directory, root) = support::temp_root();
    let package = root.join("package");
    fs::create_dir_all(&package).expect("package dir");
    let output = root.join("out");
    fs::create_dir_all(&output).expect("output dir");

    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        assert!(command.args.contains(&"--ignore-scripts".to_string()));
        assert!(command.args.contains(&"--json".to_string()));
        Ok(ok(&json!([{"filename": "browser-0.1.0.tgz"}]).to_string()))
    });
    let name = pack(&package, &output, &mut runner).expect("pack");
    assert_eq!(name, "browser-0.1.0.tgz");
}

#[test]
fn the_unsigned_staging_limit_is_nine_gib() {
    use cloakium_maintain::release::{ensure_staging_fits, UNSIGNED_STAGING_LIMIT};

    assert_eq!(UNSIGNED_STAGING_LIMIT, 9 * 1024 * 1024 * 1024);
    ensure_staging_fits(UNSIGNED_STAGING_LIMIT).expect("the limit itself fits");
    let error =
        ensure_staging_fits(UNSIGNED_STAGING_LIMIT + 1).expect_err("one byte over the limit");
    assert!(format!("{error:#}").contains("Actions cache"), "{error:#}");
}

#[test]
fn a_stale_native_chromium_pin_is_refused() {
    let current = fixture();
    write_json(
        &current.root.join("upstream.json"),
        &json!({
            "playwright": {"version": "1.65.0", "chromiumVersion": BUNDLED_CHROMIUM},
            "chromium": {"version": "156.0.8078.4"}
        }),
    );
    let mut runner = release_runner(&current);
    let error = prepare(&options(&current), &mut runner, &Reporter::silent())
        .expect_err("stale native pin");
    assert!(
        format!("{error:#}").contains("repair the native pin"),
        "{error:#}"
    );
}

#[test]
fn an_incompatible_bundled_chromium_is_refused() {
    let current = fixture();
    write_json(
        &current.root.join("upstream.json"),
        &json!({
            "playwright": {"version": "1.65.0", "chromiumVersion": "159.0.8200.1"},
            "chromium": {"version": CHROMIUM}
        }),
    );
    let mut runner = release_runner(&current);
    let error = prepare(&options(&current), &mut runner, &Reporter::silent())
        .expect_err("incompatible bundled browser");
    assert!(
        format!("{error:#}").contains("compatibility window"),
        "{error:#}"
    );
}

#[test]
fn a_pack_failure_is_reported() {
    let (_directory, root) = support::temp_root();
    let package = root.join("package");
    fs::create_dir_all(&package).expect("package dir");
    let mut runner = MockRunner::new(|_: &Command| -> Result<Output> { bail!("npm exploded") });
    let error = pack(&package, &root, &mut runner).expect_err("pack failure");
    assert!(format!("{error:#}").contains("npm exploded"), "{error:#}");
}
