//! Shared fixture for the `upload-release` test suites.
//!
//! A signed release tree is built on disk; every `gh` invocation is served from
//! an in-memory draft, so no test touches the network or a real release.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use anyhow::Result;
use cloakium_maintain::cache;
use cloakium_maintain::command::{Command, MockRunner};
use cloakium_maintain::report::Reporter;
use cloakium_maintain::upload_pace::{Clock, ManualClock};
use cloakium_maintain::upload_release::{prepare, UploadOptions, UploadOutcome};
use cloakium_maintain::util;
use serde_json::json;

use super::upload_mock::{serve, InjectedFailure, Remote, RemoteAsset};
use super::write_json;

pub const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";
pub const CHROMIUM: &str = "157.0.8103.50";
pub const PLAYWRIGHT: &str = "1.65.0";
pub const TAG: &str = "chromium-157.0.8103.50-pw-1.65.0-0123456789";
pub const REPOSITORY: &str = "cloakium/cloakium";
pub const RELEASE_ID: u64 = 444_977_957;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10_800);

pub struct Fixture {
    pub _directory: tempfile::TempDir,
    pub input: PathBuf,
}

impl Fixture {
    pub fn options(&self) -> UploadOptions {
        self.options_with_timeout(DEFAULT_TIMEOUT)
    }

    pub fn options_with_timeout(&self, timeout: Duration) -> UploadOptions {
        UploadOptions {
            input: self.input.clone(),
            repository: REPOSITORY.to_string(),
            tag: TAG.to_string(),
            revision: REVISION.to_string(),
            timeout,
        }
    }

    /// Digest of every published file, including `SHA256SUMS` itself.
    pub fn digests(&self) -> BTreeMap<String, String> {
        let mut digests = BTreeMap::new();
        for entry in fs::read_dir(&self.input).expect("list release") {
            let path = entry.expect("entry").path();
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .expect("name");
            digests.insert(name, util::digest(&path).expect("digest"));
        }
        digests
    }

    pub fn names(&self) -> Vec<String> {
        self.digests().into_keys().collect()
    }

    pub fn size(&self, name: &str) -> u64 {
        fs::metadata(self.input.join(name)).expect("metadata").len()
    }
}

/// A complete signed release tree, equivalent to `sign-release` output.
pub fn fixture() -> Fixture {
    let (directory, root) = super::temp_root();
    let input = root.join("release");
    fs::create_dir_all(&input).expect("release directory");

    for name in ["aaa", "bbb", "ccc", "ddd", "eee", "fff"] {
        let payload = format!("payload for {name}\n").into_bytes();
        fs::write(input.join(format!("{name}.nar.xz")), &payload).expect("nar");
        fs::write(
            input.join(format!("{name}.narinfo")),
            format!(
                "StorePath: /nix/store/{name}-payload\nURL: {name}.nar.xz\nCompression: xz\n\
                 NarHash: sha256:aaaa\nNarSize: {len}\nReferences: \n\
                 Sig: cloakium-test:c2ln\n",
                len = payload.len()
            ),
        )
        .expect("narinfo");
    }
    fs::write(input.join("nix-cache-info"), "StoreDir: /nix/store\n").expect("cache info");
    fs::write(
        input.join("cloakium-browser-0.1.0.tgz"),
        b"browser tarball\n",
    )
    .expect("tarball");
    fs::write(
        input.join("playwright-core-1.65.0.tgz"),
        b"driver tarball\n",
    )
    .expect("tarball");
    fs::write(input.join("release-notes.md"), "# Cloakium release\n").expect("notes");
    fs::write(
        input.join("cache-public-key.txt"),
        "cloakium-test:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n",
    )
    .expect("public key");
    let lock = json!({
        "nodes": {
            "nixpkgs": {"locked": {"rev": REVISION, "narHash": "sha256-lock", "lastModified": 1}},
            "root": {"inputs": {"nixpkgs": "nixpkgs"}}
        },
        "root": "root",
        "version": 7
    });
    write_json(&input.join("source-flake.lock"), &lock);
    write_json(
        &input.join("verification.json"),
        &json!({"status": "passed", "exitCode": 0}),
    );
    write_json(
        &input.join("manifest.json"),
        &json!({
            "schemaVersion": 1,
            "sourceRevision": REVISION,
            "tag": TAG,
            "system": "x86_64-linux",
            "chromium": CHROMIUM,
            "playwright": PLAYWRIGHT,
            "packageVersion": "0.1.0",
            "signed": true,
            "signing": {"narinfos": 6, "verified": true}
        }),
    );
    cache::write_checksums(&input).expect("checksums");

    Fixture {
        _directory: directory,
        input,
    }
}

/// A fixture plus the mock server state its `gh` calls are served from.
pub struct Harness {
    pub fixture: Fixture,
    pub remote: Rc<RefCell<Remote>>,
    clock: Rc<RefCell<ManualClock>>,
    history: Vec<String>,
}

impl Harness {
    pub fn new() -> Self {
        Self {
            fixture: fixture(),
            remote: Rc::new(RefCell::new(Remote::default())),
            clock: Rc::new(RefCell::new(ManualClock::new())),
            history: Vec::new(),
        }
    }

    pub fn missing(&self) -> Vec<String> {
        let state = self.remote.borrow();
        self.fixture
            .names()
            .into_iter()
            .filter(|name| !state.assets.iter().any(|asset| &asset.name == name))
            .collect()
    }

    /// Publish the exact local bytes for `name`, as a completed upload would.
    pub fn complete(&mut self, name: &str) {
        let path = self.fixture.input.join(name);
        let digest = format!("sha256:{}", util::digest(&path).expect("digest"));
        let size = fs::metadata(&path).expect("metadata").len();
        self.push_asset(name, size, Some(digest), "uploaded");
    }

    pub fn push_asset(&mut self, name: &str, size: u64, digest: Option<String>, state: &str) {
        let mut remote = self.remote.borrow_mut();
        let id = remote.next_id;
        remote.next_id += 1;
        remote.assets.push(RemoteAsset {
            id,
            name: name.to_string(),
            size,
            digest,
            state: state.to_string(),
        });
    }

    pub fn asset_id(&self, name: &str) -> u64 {
        self.remote
            .borrow()
            .assets
            .iter()
            .find(|asset| asset.name == name)
            .map(|asset| asset.id)
            .expect("asset present")
    }

    pub fn fail_next(&mut self, message: &str, lands: bool) {
        self.push_failure(message, lands, false, false);
    }

    /// Fail the next upload after storing it with the wrong bytes.
    pub fn fail_next_corrupt(&mut self, message: &str) {
        self.push_failure(message, true, true, false);
    }

    /// Fail the next upload and leave GitHub's empty `starter` asset behind.
    pub fn fail_next_with_starter(&mut self, message: &str) {
        self.push_failure(message, false, false, true);
    }

    fn push_failure(&mut self, message: &str, lands: bool, corrupt: bool, starter: bool) {
        self.remote
            .borrow_mut()
            .failures
            .push_back(InjectedFailure {
                message: message.to_string(),
                lands,
                corrupt,
                starter,
            });
    }

    pub fn fail_view(&mut self, message: &str) {
        self.remote.borrow_mut().view_failure = Some(message.to_string());
    }

    pub fn drop_after_upload(&mut self, name: &str) {
        self.remote.borrow_mut().drop_after_upload = Some(name.to_string());
    }

    /// Publish the release as soon as the first asset is uploaded.
    pub fn publish_after_upload(&mut self) {
        self.remote.borrow_mut().publish_after_upload = true;
    }

    /// Publish the exact local bytes for every name except `except`.
    pub fn complete_all_except(&mut self, except: &[&str]) {
        for name in self.fixture.names() {
            if !except.contains(&name.as_str()) {
                self.complete(&name);
            }
        }
    }

    pub fn set_draft(&mut self, draft: bool) {
        self.remote.borrow_mut().draft = draft;
    }

    pub fn set_immutable(&mut self, immutable: bool) {
        self.remote.borrow_mut().immutable = immutable;
    }

    pub fn report_wrong_digest(&mut self, name: &str, digest: &str) {
        self.remote.borrow_mut().digest_override = Some((name.to_string(), digest.to_string()));
    }

    pub fn uploads(&self) -> Vec<String> {
        self.remote.borrow().uploads.clone()
    }

    pub fn deletes(&self) -> Vec<u64> {
        self.remote.borrow().deletes.clone()
    }

    pub fn history(&self) -> &[String] {
        &self.history
    }

    /// Every command with the virtual time it ran at.
    pub fn timeline(&self) -> Vec<(String, Duration)> {
        self.remote.borrow().timeline.clone()
    }

    pub fn sleeps(&self) -> Vec<Duration> {
        self.clock.borrow().sleeps().to_vec()
    }

    /// Move virtual time forward before a run starts.
    pub fn advance(&mut self, duration: Duration) {
        self.clock.borrow_mut().advance(duration);
    }

    pub fn last_page_count(&self) -> usize {
        self.remote.borrow().last_pages
    }

    pub fn remote_names(&self) -> Vec<String> {
        self.remote
            .borrow()
            .assets
            .iter()
            .map(|asset| asset.name.clone())
            .collect()
    }

    pub fn run(&mut self) -> Result<UploadOutcome> {
        self.run_with(self.fixture.options())
    }

    pub fn run_with(&mut self, options: UploadOptions) -> Result<UploadOutcome> {
        let remote = Rc::clone(&self.remote);
        let shared = Rc::clone(&self.clock);
        let served = {
            let clock = Rc::clone(&shared);
            move || clock.borrow().now()
        };
        let mut runner = MockRunner::new(move |command: &Command| serve(&remote, &served, command));
        let mut handle = SharedClock(shared);
        let result = prepare(&options, &mut runner, &mut handle, &Reporter::silent());
        self.history = runner.rendered_history();
        result
    }
}

/// Clock handle that delegates to the shared virtual clock.
struct SharedClock(Rc<RefCell<ManualClock>>);

impl Clock for SharedClock {
    fn now(&self) -> Duration {
        self.0.borrow().now()
    }

    fn sleep(&mut self, duration: Duration) {
        self.0.borrow_mut().sleep(duration);
    }
}
