//! Shared fixture for the `update` test suites.

use std::fs;
use std::path::Path;

use cloakium_maintain::update::UpdateOptions;
use serde_json::json;

use super::write_json;

pub const CHROMIUM: &str = "157.0.8103.50";
/// The CfT version `playwright-core` bundles; one major newer than the native
/// browser on purpose.
pub const BUNDLED_CHROMIUM: &str = "158.0.8127.18";

pub fn fixture(root: &Path) {
    fs::create_dir(root.join("nix")).expect("nix directory");
    fs::write(root.join("flake.lock"), "old-lock").expect("flake.lock");
    write_json(
        &root.join("upstream.json"),
        &json!({
            "playwright": {"version": "1.65.0", "chromiumVersion": BUNDLED_CHROMIUM},
            "chromium": {"version": CHROMIUM}
        }),
    );
    write_json(
        &root.join("package.json"),
        &json!({"devDependencies": {"playwright-core": "1.65.0"}}),
    );
}

/// Pins an older playwright-core so the bump path runs.
pub fn older_fixture(root: &Path) {
    fixture(root);
    write_json(
        &root.join("upstream.json"),
        &json!({
            "playwright": {"version": "1.64.0", "chromiumVersion": BUNDLED_CHROMIUM},
            "chromium": {"version": CHROMIUM}
        }),
    );
}

pub fn options(root: &Path, refresh_toolchain: bool) -> UpdateOptions {
    UpdateOptions {
        root: root.to_path_buf(),
        refresh_toolchain,
    }
}
