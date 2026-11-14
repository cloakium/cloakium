//! End-to-end test of the real binary against a stub `gh` executable.
//!
//! The stub answers the documented REST endpoints from a state directory, so
//! this exercises the actual subprocess and `$GITHUB_OUTPUT` paths without a
//! network call or a real release.

mod support;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use support::upload::{fixture, RELEASE_ID, REPOSITORY, REVISION, TAG};

/// Every `gh` command this backend accepts; anything else fails the stub.
/// The shebang is added at runtime because the Nix sandbox has no `/usr/bin/env`.
const STUB: &str = r#"set -euo pipefail
state="${GH_STUB_STATE:?}"
emit_assets() {
  local first=1 id=0 name size digest status
  printf '['
  while IFS=$'\t' read -r name size digest status; do
    [ -n "${name:-}" ] || continue
    id=$((id + 1))
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"id":%d,"name":"%s","size":%s,"digest":"sha256:%s","state":"%s"}' \
      "$id" "$name" "$size" "$digest" "$status"
  done < "$state/assets.tsv"
  printf ']'
}
cmd="${1:-}"
shift || true
case "$cmd" in
  release)
    sub="${1:-}"
    shift || true
    case "$sub" in
      view) cat "$state/view.json" ;;
      upload)
        tag="$1"
        path="$2"
        name="$(basename "$path")"
        [ "$tag" = "$GH_STUB_TAG" ]
        printf '%s\n' "$name" >> "$state/uploads.log"
        size="$(stat -c %s "$path")"
        digest="$(sha256sum "$path" | cut -d' ' -f1)"
        printf '%s\t%s\t%s\tuploaded\n' "$name" "$size" "$digest" >> "$state/assets.tsv"
        ;;
      *)
        echo "unexpected release subcommand: $sub" >&2
        exit 1
        ;;
    esac
    ;;
  api)
    method=GET
    paginate=0
    endpoint=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --method)
          method="$2"
          shift 2
          ;;
        --paginate)
          paginate=1
          shift
          ;;
        --slurp | --silent)
          shift
          ;;
        -*)
          echo "unexpected flag: $1" >&2
          exit 1
          ;;
        *)
          endpoint="$1"
          shift
          ;;
      esac
    done
    if [ "$method" = DELETE ]; then
      printf '%s\n' "$endpoint" >> "$state/deletes.log"
      exit 0
    fi
    case "$endpoint" in
      *"?name="*)
        echo "undocumented asset name filter: $endpoint" >&2
        exit 1
        ;;
      *"/assets?per_page=100")
        if [ "$paginate" = 1 ]; then printf '[%s]' "$(emit_assets)"; else emit_assets; fi
        ;;
      *)
        echo "unexpected endpoint: $endpoint" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unexpected gh command: $cmd" >&2
    exit 1
    ;;
esac
"#;

struct Backend {
    _directory: tempfile::TempDir,
    bin: PathBuf,
    state: PathBuf,
    github_output: PathBuf,
}

impl Backend {
    fn new(published: &[String]) -> Self {
        let (directory, root) = support::temp_root();
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("bin directory");
        let gh = bin.join("gh");
        let script = format!("#!{}\n{STUB}", bash().display());
        fs::write(&gh, script).expect("stub");
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).expect("executable");

        let state = root.join("state");
        fs::create_dir_all(&state).expect("state directory");
        fs::write(
            state.join("view.json"),
            format!(
                "{{\"databaseId\":{RELEASE_ID},\"isDraft\":true,\"isImmutable\":false,\
                 \"tagName\":\"{TAG}\"}}"
            ),
        )
        .expect("view");
        let mut rows = String::new();
        for line in published {
            rows.push_str(line);
            rows.push('\n');
        }
        fs::write(state.join("assets.tsv"), rows).expect("assets");

        Self {
            _directory: directory,
            bin,
            state,
            github_output: root.join("github-output"),
        }
    }

    fn run(&self, input: &Path) -> std::process::Output {
        let path = format!(
            "{}:{}",
            self.bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        Command::new(env!("CARGO_BIN_EXE_cloakium-maintain"))
            .args([
                "upload-release",
                "--input",
                &input.display().to_string(),
                "--repository",
                REPOSITORY,
                "--tag",
                TAG,
                "--revision",
                REVISION,
                "--timeout",
                "10800",
            ])
            .env("PATH", path)
            .env("GH_STUB_STATE", &self.state)
            .env("GH_STUB_TAG", TAG)
            .env("GITHUB_OUTPUT", &self.github_output)
            .env_remove("GH_TOKEN")
            .output()
            .expect("run the maintain binary")
    }

    fn uploads(&self) -> Vec<String> {
        fs::read_to_string(self.state.join("uploads.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn outputs(&self) -> String {
        fs::read_to_string(&self.github_output).unwrap_or_default()
    }
}

/// Locate `bash` on `PATH`; the stub needs a real interpreter because the Nix
/// sandbox has no `/usr/bin/env`.
fn bash() -> PathBuf {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|directory| directory.join("bash"))
        .find(|candidate| candidate.is_file())
        .expect("bash must be available to run the gh stub")
}

/// `name<TAB>size<TAB>sha256<TAB>uploaded` rows for every local asset except
/// the ones named, so the run performs no more than one upload.
fn published_rows(input: &Path, missing: &[&str]) -> Vec<String> {
    let mut rows = Vec::new();
    let mut names: Vec<String> = fs::read_dir(input)
        .expect("list release")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    for name in names {
        if missing.contains(&name.as_str()) {
            continue;
        }
        let path = input.join(&name);
        let size = fs::metadata(&path).expect("metadata").len();
        let digest = cloakium_maintain::util::digest(&path).expect("digest");
        rows.push(format!("{name}\t{size}\t{digest}\tuploaded"));
    }
    rows
}

#[test]
fn the_real_binary_uploads_only_the_missing_asset_and_reports_outputs() {
    let fixture = fixture();
    let backend = Backend::new(&published_rows(&fixture.input, &["aaa.nar.xz"]));
    let output = backend.run(&fixture.input);

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    assert_eq!(backend.uploads(), vec!["aaa.nar.xz".to_string()]);

    let outputs = backend.outputs();
    for expected in [
        "verified=true".to_string(),
        format!("tag={TAG}"),
        format!("revision={REVISION}"),
        format!("release_id={RELEASE_ID}"),
        "uploaded=1".to_string(),
        "replaced=0".to_string(),
        "content_operations=1".to_string(),
    ] {
        assert!(
            outputs.contains(&expected),
            "{expected} missing from {outputs}"
        );
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"verified\": true"), "{stdout}");
    assert!(stdout.contains("aaa.nar.xz"), "{stdout}");
    assert!(
        stdout.contains("assets; 1 to upload"),
        "the plan is reported before uploading: {stdout}"
    );
    assert!(!stdout.contains("GH_TOKEN"), "{stdout}");
    assert!(!stderr.contains("token"), "{stderr}");
}

#[test]
fn the_real_binary_leaves_a_complete_release_alone() {
    let fixture = fixture();
    let backend = Backend::new(&published_rows(&fixture.input, &[]));
    let started = std::time::Instant::now();
    let output = backend.run(&fixture.input);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(backend.uploads().is_empty(), "nothing may be re-uploaded");
    assert!(backend.outputs().contains("content_operations=0"));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("assets processed"),
        "a long run must report progress: {stdout}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(120),
        "a complete release must finish without pacing waits"
    );
}

#[test]
fn the_real_binary_refuses_a_published_release() {
    let fixture = fixture();
    let backend = Backend::new(&published_rows(&fixture.input, &["aaa.nar.xz"]));
    fs::write(
        backend.state.join("view.json"),
        format!(
            "{{\"databaseId\":{RELEASE_ID},\"isDraft\":false,\"isImmutable\":false,\
             \"tagName\":\"{TAG}\"}}"
        ),
    )
    .expect("view");

    let output = backend.run(&fixture.input);
    assert!(!output.status.success());
    assert!(backend.uploads().is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("already published"), "{stderr}");
}
