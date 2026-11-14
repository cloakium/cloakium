use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use playwright_patcher::apply::{self, ReplayConfig};
use playwright_patcher::{fsutil, manifest};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "cloakium-patcher-{}-{}-{}",
            std::process::id(),
            id,
            name
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create sandbox");
        Self { root }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn write(&self, relative: &str, content: &str) -> PathBuf {
        let path = self.path(relative);
        fsutil::write_text(&path, content).expect("write fixture");
        path
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

const SOURCE: &str = "\
line-one
line-two
line-three
line-four
line-five
line-six
";

const PATCH_ONE: &str = "\
--- a/lib/target.js
+++ b/lib/target.js
@@ -2,3 +2,4 @@
 line-two
-line-three
+LINE-THREE
+inserted
 line-four
";

const PATCH_TWO: &str = "\
--- a/lib/target.js
+++ b/lib/target.js
@@ -5,2 +5,2 @@
 line-five
-line-six
+LINE-SIX
";

const PACKAGE: &str = "{
  \"name\": \"playwright-core\",
  \"version\": \"1.65.0\",
  \"license\": \"Apache-2.0\",
  \"bin\": {
    \"playwright-core\": \"cli.js\"
  }
}
";

fn config(patch_set: &str) -> ReplayConfig {
    ReplayConfig {
        patch_set: patch_set.to_string(),
        marker_file: Some("package.json".to_string()),
        max_offset: None,
    }
}

fn setup(name: &str, patch_one: &str, patch_two: &str) -> (Sandbox, PathBuf) {
    let sandbox = Sandbox::new(name);
    sandbox.write("src/lib/target.js", SOURCE);
    sandbox.write("src/package.json", PACKAGE);
    sandbox.write("patches/0001-first.patch", patch_one);
    sandbox.write("patches/0002-second.patch", patch_two);
    let patches = sandbox.path("patches");
    (sandbox, patches)
}

fn replay(
    sandbox: &Sandbox,
    patches: &Path,
    config: &ReplayConfig,
) -> playwright_patcher::Result<(apply::Report, String, Option<String>)> {
    let loaded = apply::load_patches(patches)?;
    let (report, contents) = apply::replay(
        &loaded,
        |relative| fsutil::read_text(&sandbox.path("src").join(relative)),
        config,
    )?;
    Ok((
        report,
        contents.get("lib/target.js").expect("target").clone(),
        contents.get("package.json").cloned(),
    ))
}

#[test]
fn applies_patches_in_order_without_fuzz() {
    let (sandbox, patches) = setup("ok", PATCH_ONE, PATCH_TWO);
    let (report, rendered, _) =
        replay(&sandbox, &patches, &config("playwright-test")).expect("replay");

    assert_eq!(
        rendered,
        "line-one\nline-two\nLINE-THREE\ninserted\nline-four\nline-five\nLINE-SIX\n"
    );
    assert_eq!(report.patches.len(), 2);
    assert_eq!(report.patches[0].name, "0001-first.patch");
    assert!(report.files.iter().any(|file| file.path == "lib/target.js"));
    assert_eq!(report.files.len(), 2);
}

#[test]
fn marker_is_derived_from_the_package_being_patched() {
    // Simulated next release: only the package version moved, code is unchanged.
    let (sandbox, patches) = setup("marker-166", PATCH_ONE, PATCH_TWO);
    sandbox.write(
        "src/package.json",
        &PACKAGE.replace("\"1.65.0\"", "\"1.66.0\""),
    );

    let (report, _, package) =
        replay(&sandbox, &patches, &config("playwright-1.66.0")).expect("replay");
    let package = package.expect("package");
    let value: serde_json::Value = serde_json::from_str(&package).expect("valid json");
    let marker = value
        .get("cloakium")
        .expect("marker")
        .as_object()
        .expect("object");

    assert_eq!(
        marker.get("version").and_then(|v| v.as_str()),
        Some("1.66.0")
    );
    assert_eq!(
        marker.get("upstream").and_then(|v| v.as_str()),
        Some("1.66.0")
    );
    assert_eq!(
        marker.get("patchSet").and_then(|v| v.as_str()),
        Some("playwright-1.66.0")
    );
    assert_eq!(
        marker.get("source").and_then(|v| v.as_str()),
        Some("https://registry.npmjs.org/playwright-core/-/playwright-core-1.66.0.tgz")
    );
    assert!(
        !package.contains("1.65.0"),
        "stale release leaked into the marker"
    );

    let recorded = report.marker.expect("marker report");
    assert_eq!(recorded.version, "1.66.0");
    assert_eq!(recorded.package, "playwright-core");
}

#[test]
fn marker_can_be_disabled() {
    let (sandbox, patches) = setup("no-marker", PATCH_ONE, PATCH_TWO);
    let mut options = config("playwright-test");
    options.marker_file = None;
    let (report, _, package) = replay(&sandbox, &patches, &options).expect("replay");
    assert!(report.marker.is_none());
    assert_eq!(package, None);
    assert_eq!(report.files.len(), 1);
    assert!(report.files.iter().all(|file| file.path != "package.json"));
}

#[test]
fn is_deterministic_across_runs() {
    let (sandbox, patches) = setup("determinism", PATCH_ONE, PATCH_TWO);
    let (first_report, first, first_package) =
        replay(&sandbox, &patches, &config("set")).expect("first");
    let (second_report, second, second_package) =
        replay(&sandbox, &patches, &config("set")).expect("second");
    assert_eq!(first, second);
    assert_eq!(first_package, second_package);
    assert_eq!(
        manifest::render("set", &first_report),
        manifest::render("set", &second_report)
    );
}

#[test]
fn rejects_mutated_context() {
    const DRIFTED_PATCH: &str = "\
--- a/lib/target.js
+++ b/lib/target.js
@@ -2,3 +2,4 @@
 line-two
-line-three-renamed-upstream
+LINE-THREE
+inserted
 line-four
";
    let (sandbox, patches) = setup("mutated", DRIFTED_PATCH, PATCH_TWO);
    let error = replay(&sandbox, &patches, &config("set")).expect_err("must fail");
    assert!(
        error.message().contains("no longer matches"),
        "unexpected error: {error}"
    );
}

#[test]
fn rejects_mutated_source_line() {
    let (sandbox, patches) = setup("mutated-source", PATCH_ONE, PATCH_TWO);
    sandbox.write("src/lib/target.js", &SOURCE.replace("line-three", "line-3"));
    let error = replay(&sandbox, &patches, &config("set")).expect_err("must fail");
    assert!(
        error.message().contains("no longer matches"),
        "unexpected error: {error}"
    );
}

#[test]
fn rejects_already_applied_patch() {
    let (sandbox, patches) = setup("reversed", PATCH_ONE, PATCH_TWO);
    sandbox.write(
        "src/lib/target.js",
        "line-one\nline-two\nLINE-THREE\ninserted\nline-four\nline-five\nline-six\n",
    );
    let error = replay(&sandbox, &patches, &config("set")).expect_err("must fail");
    assert!(
        error.message().contains("already applied or reversed"),
        "unexpected error: {error}"
    );
}

#[test]
fn rejects_ambiguous_hunk_anywhere_in_the_file() {
    let sandbox = Sandbox::new("ambiguous");
    // Duplicate the anchor block far from the declared position.
    let mut content = String::from("a\nb\nc\n");
    for index in 0..5000 {
        content.push_str(&format!("filler-{index}\n"));
    }
    content.push_str("a\nb\nc\n");
    sandbox.write("src/lib/target.js", &content);
    sandbox.write("src/package.json", PACKAGE);
    sandbox.write(
        "patches/0001-ambiguous.patch",
        "--- a/lib/target.js\n+++ b/lib/target.js\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n",
    );
    let error = replay(&sandbox, &sandbox.path("patches"), &config("set")).expect_err("must fail");
    assert!(
        error.message().contains("ambiguous"),
        "unexpected error: {error}"
    );
}

#[test]
fn applies_at_large_legitimate_offset() {
    let (sandbox, patches) = setup("large-offset", PATCH_ONE, PATCH_TWO);
    let mut content = String::new();
    for index in 0..25_000 {
        content.push_str(&format!("filler-{index}\n"));
    }
    content.push_str(SOURCE);
    sandbox.write("src/lib/target.js", &content);

    let (_, rendered, _) = replay(&sandbox, &patches, &config("set")).expect("large offset replay");
    assert!(rendered.contains("LINE-THREE\ninserted"));
    assert!(rendered.contains("LINE-SIX"));
}

#[test]
fn max_offset_is_opt_in_and_reports_the_hint() {
    let (sandbox, patches) = setup("max-offset", PATCH_ONE, PATCH_TWO);
    sandbox.write(
        "src/lib/target.js",
        &format!("{}{SOURCE}", "filler\n".repeat(500)),
    );
    let mut options = config("set");
    options.max_offset = Some(10);
    let error = replay(&sandbox, &patches, &options).expect_err("must fail");
    assert!(
        error.message().contains("--max-offset"),
        "unexpected error: {error}"
    );
}

#[test]
fn rejects_missing_target_file() {
    let sandbox = Sandbox::new("missing-target");
    sandbox.write("patches/0001-first.patch", PATCH_ONE);
    sandbox.write("src/package.json", PACKAGE);
    let error = replay(&sandbox, &sandbox.path("patches"), &config("set")).expect_err("must fail");
    assert!(
        error.message().contains("cannot read"),
        "unexpected error: {error}"
    );
}

#[test]
fn manifest_is_stable_and_complete() {
    let (sandbox, patches) = setup("manifest", PATCH_ONE, PATCH_TWO);
    let (report, _, _) = replay(&sandbox, &patches, &config("playwright-1.65.0")).expect("replay");
    let json = manifest::render("playwright-1.65.0", &report);

    assert!(json.starts_with("{\n  \"format\": 1,\n  \"tool\": \"playwright-patcher\",\n"));
    assert!(json.contains("\"patchSet\": \"playwright-1.65.0\""));
    assert!(json.contains("\"name\": \"0001-first.patch\""));
    assert!(json.contains("\"path\": \"lib/target.js\""));
    assert!(json.contains("\"path\": \"package.json\""));
    assert!(json.contains("\"marker\": {"));
    assert!(json.contains("\"version\": \"1.65.0\""));
    assert!(json.ends_with("}\n"));
    assert!(!json.contains("timestamp"));
}

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_playwright-patcher")
}

#[test]
fn cli_applies_and_writes_manifest() {
    let sandbox = Sandbox::new("cli-apply");
    sandbox.write("src/lib/target.js", SOURCE);
    sandbox.write(
        "src/package.json",
        &PACKAGE.replace("\"1.65.0\"", "\"1.66.0\""),
    );
    sandbox.write("patches/0001-first.patch", PATCH_ONE);
    sandbox.write("patches/0002-second.patch", PATCH_TWO);
    let target = sandbox.path("out");

    let output = Command::new(binary())
        .arg("apply")
        .arg("--source")
        .arg(sandbox.path("src"))
        .arg("--target")
        .arg(&target)
        .arg("--patches")
        .arg(sandbox.path("patches"))
        .arg("--patch-set")
        .arg("playwright-1.66.0")
        .output()
        .expect("run binary");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let patched = std::fs::read_to_string(target.join("lib/target.js")).expect("patched file");
    assert!(patched.contains("LINE-THREE"));

    let package = std::fs::read_to_string(target.join("package.json")).expect("package");
    assert!(package.contains("\"version\": \"1.66.0\""));
    assert!(package.contains("playwright-core-1.66.0.tgz"));

    let manifest = std::fs::read_to_string(target.join("CLOAKIUM-PATCHES.json")).expect("manifest");
    assert!(manifest.contains("playwright-1.66.0"));
}

#[test]
fn cli_check_writes_nothing_and_reports_failure() {
    let sandbox = Sandbox::new("cli-check");
    sandbox.write("src/lib/target.js", &SOURCE.replace("line-three", "moved"));
    sandbox.write("src/package.json", PACKAGE);
    sandbox.write("patches/0001-first.patch", PATCH_ONE);

    let output = Command::new(binary())
        .arg("check")
        .arg("--source")
        .arg(sandbox.path("src"))
        .arg("--patches")
        .arg(sandbox.path("patches"))
        .output()
        .expect("run binary");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("no longer matches"), "stderr: {stderr}");
    assert!(!sandbox.path("out").exists());
}

#[test]
fn cli_refuses_non_empty_target() {
    let sandbox = Sandbox::new("cli-non-empty");
    sandbox.write("src/lib/target.js", SOURCE);
    sandbox.write("src/package.json", PACKAGE);
    sandbox.write("patches/0001-first.patch", PATCH_ONE);
    sandbox.write("out/keep.txt", "already here");

    let output = Command::new(binary())
        .arg("apply")
        .arg("--source")
        .arg(sandbox.path("src"))
        .arg("--target")
        .arg(sandbox.path("out"))
        .arg("--patches")
        .arg(sandbox.path("patches"))
        .output()
        .expect("run binary");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("not empty"));
}

#[test]
fn cli_help_and_list_work() {
    let help = Command::new(binary()).arg("--help").output().expect("help");
    assert!(help.status.success());
    let stdout = String::from_utf8_lossy(&help.stdout);
    assert!(stdout.contains("--source"));
    assert!(stdout.contains("deterministic"));

    let sandbox = Sandbox::new("cli-list");
    sandbox.write("patches/0001-first.patch", PATCH_ONE);
    let list = Command::new(binary())
        .arg("list")
        .arg("--patches")
        .arg(sandbox.path("patches"))
        .output()
        .expect("list");
    assert!(list.status.success());
    assert!(String::from_utf8_lossy(&list.stdout).contains("0001-first.patch"));
}

/// The repository patch set must never carry release-specific metadata hunks.
#[test]
fn repo_patch_set_has_no_metadata_hunks() {
    let patches = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../patches/playwright");
    if !patches.is_dir() {
        return;
    }
    let mut checked = 0;
    for entry in std::fs::read_dir(&patches).expect("read patches") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("patch") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("patch text");
        let file = playwright_patcher::patchfile::PatchFile::parse(
            path.file_name().and_then(|n| n.to_str()).unwrap_or("patch"),
            &text,
        )
        .expect("patch parses");
        assert_ne!(
            file.target,
            "package.json",
            "{} must not patch package.json; the marker is generated at apply time",
            path.display()
        );
        assert!(
            !text.contains("\"version\": \"1."),
            "{} looks like it embeds a release version",
            path.display()
        );
        checked += 1;
    }
    assert!(checked > 0, "expected at least one patch file");
}
