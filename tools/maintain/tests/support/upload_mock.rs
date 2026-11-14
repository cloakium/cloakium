//! In-memory draft release state and the mocked `gh` command handler.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use anyhow::{bail, Result};
use cloakium_maintain::command::Output;
use cloakium_maintain::util;
use serde_json::{json, Value};

use super::upload::{RELEASE_ID, TAG};
use super::{has_arg, is_command, ok};

/// Assets per mocked page, so a recheck has to walk beyond the first page.
pub const PAGE_SIZE: usize = 2;

/// A `gh` failure that the next upload should report.
#[derive(Debug, Clone)]
pub struct InjectedFailure {
    pub message: String,
    /// True when the POST landed even though the transport reported an error.
    pub lands: bool,
    /// True when the landed asset has the wrong bytes.
    pub corrupt: bool,
    /// True when the failed POST left an empty `starter` asset behind.
    pub starter: bool,
}

#[derive(Debug, Clone)]
pub struct RemoteAsset {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub digest: Option<String>,
    pub state: String,
}

#[derive(Debug)]
pub struct Remote {
    pub draft: bool,
    pub immutable: bool,
    pub tag: String,
    pub assets: Vec<RemoteAsset>,
    pub next_id: u64,
    pub failures: VecDeque<InjectedFailure>,
    pub uploads: Vec<String>,
    pub deletes: Vec<u64>,
    pub lists: usize,
    pub views: usize,
    pub last_pages: usize,
    /// Every command with the virtual time it ran at.
    pub timeline: Vec<(String, std::time::Duration)>,
    /// (asset name, digest to report instead of the uploaded bytes)
    pub digest_override: Option<(String, String)>,
    /// Identity read failure, used to test the unreachable-release path.
    pub view_failure: Option<String>,
    /// Asset the server silently loses after a "successful" upload.
    pub drop_after_upload: Option<String>,
    /// Simulate someone publishing the release while assets are uploaded.
    pub publish_after_upload: bool,
}

impl Default for Remote {
    fn default() -> Self {
        Self {
            draft: true,
            immutable: false,
            tag: TAG.to_string(),
            assets: Vec::new(),
            next_id: 1_000,
            failures: VecDeque::new(),
            uploads: Vec::new(),
            deletes: Vec::new(),
            lists: 0,
            views: 0,
            last_pages: 0,
            timeline: Vec::new(),
            digest_override: None,
            view_failure: None,
            drop_after_upload: None,
            publish_after_upload: false,
        }
    }
}

/// Serve one `gh` invocation from the draft state.
pub fn serve(
    remote: &Rc<RefCell<Remote>>,
    now: impl Fn() -> std::time::Duration,
    command: &cloakium_maintain::command::Command,
) -> Result<Output> {
    remote
        .borrow_mut()
        .timeline
        .push((command.display(), now()));

    if is_command(command, "gh", &["release", "view"]) {
        let mut state = remote.borrow_mut();
        state.views += 1;
        if let Some(message) = &state.view_failure {
            bail!("{message}");
        }
        return Ok(ok(&json!({
            "databaseId": RELEASE_ID,
            "isDraft": state.draft,
            "isImmutable": state.immutable,
            "tagName": state.tag,
        })
        .to_string()));
    }
    if is_command(command, "gh", &["api", "--method", "DELETE"]) {
        let id: u64 = command.args[3]
            .rsplit('/')
            .next()
            .and_then(|value| value.parse().ok())
            .expect("asset id");
        let mut state = remote.borrow_mut();
        state.deletes.push(id);
        state.assets.retain(|asset| asset.id != id);
        return Ok(ok(""));
    }
    if is_command(command, "gh", &["api", "--paginate"]) {
        assert!(
            !has_arg(command, "--method"),
            "a recheck must not mutate the release"
        );
        let mut state = remote.borrow_mut();
        state.lists += 1;
        let pages: Vec<Value> = state
            .assets
            .chunks(PAGE_SIZE)
            .map(|chunk| Value::Array(chunk.iter().map(render).collect()))
            .collect();
        state.last_pages = pages.len();
        let pages = if pages.is_empty() {
            vec![Value::Array(Vec::new())]
        } else {
            pages
        };
        return Ok(ok(&Value::Array(pages).to_string()));
    }
    if is_command(command, "gh", &["release", "upload"]) {
        assert!(
            !has_arg(command, "--clobber"),
            "--clobber deletes and re-POSTs assets; the uploader must not use it"
        );
        let path = PathBuf::from(&command.args[3]);
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .expect("file name");
        let mut state = remote.borrow_mut();
        state.uploads.push(name.clone());
        let failure = state.failures.pop_front();
        if let Some(failure) = &failure {
            if failure.lands {
                store(&mut state, &path, &name, failure.corrupt);
            }
            if failure.starter {
                let id = state.next_id;
                state.next_id += 1;
                state.assets.push(RemoteAsset {
                    id,
                    name: name.clone(),
                    size: 0,
                    digest: None,
                    state: "starter".to_string(),
                });
            }
            bail!("{}", failure.message);
        }
        store(&mut state, &path, &name, false);
        if state.drop_after_upload.as_deref() == Some(name.as_str()) {
            state.assets.retain(|asset| asset.name != name);
        }
        if state.publish_after_upload {
            state.draft = false;
        }
        return Ok(ok(""));
    }
    bail!("unexpected command: {}", command.display())
}

fn store(state: &mut Remote, path: &Path, name: &str, corrupt: bool) {
    let size = fs::metadata(path).expect("metadata").len();
    let digest = if corrupt {
        format!("sha256:{}", "e".repeat(64))
    } else {
        match &state.digest_override {
            Some((overridden, digest)) if overridden == name => format!("sha256:{digest}"),
            _ => format!("sha256:{}", util::digest(path).expect("digest")),
        }
    };
    state.assets.retain(|asset| asset.name != name);
    let id = state.next_id;
    state.next_id += 1;
    state.assets.push(RemoteAsset {
        id,
        name: name.to_string(),
        size,
        digest: Some(digest),
        state: "uploaded".to_string(),
    });
}

fn render(asset: &RemoteAsset) -> Value {
    let mut entry = serde_json::Map::new();
    entry.insert("id".into(), json!(asset.id));
    entry.insert("name".into(), json!(asset.name));
    entry.insert("size".into(), json!(asset.size));
    entry.insert("state".into(), json!(asset.state));
    if let Some(digest) = &asset.digest {
        entry.insert("digest".into(), json!(digest));
    }
    Value::Object(entry)
}
