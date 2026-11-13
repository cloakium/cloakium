//! Shared fixtures for the maintenance crate's integration tests.
#![allow(dead_code)]

pub mod release;
pub mod sign;
pub mod update;
pub mod update_candidate;

use std::fs;
use std::path::{Path, PathBuf};

use cloakium_maintain::command::{Command, Output};
use serde_json::Value;

pub fn ok(stdout: &str) -> Output {
    Output {
        stdout: stdout.to_string(),
        stderr: String::new(),
        code: Some(0),
    }
}

pub fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent directory");
    }
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(value).expect("json")),
    )
    .expect("write json");
}

pub fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|_| panic!("read {}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("parse {}", path.display()))
}

/// True when the command's arguments begin with `expected`.
pub fn args_start_with(command: &Command, expected: &[&str]) -> bool {
    command.args.len() >= expected.len()
        && command
            .args
            .iter()
            .zip(expected)
            .all(|(actual, want)| actual == want)
}

pub fn is_command(command: &Command, program: &str, expected: &[&str]) -> bool {
    command.program == program && args_start_with(command, expected)
}

pub fn has_arg(command: &Command, expected: &str) -> bool {
    command.args.iter().any(|arg| arg == expected)
}

/// Build a gzipped npm tarball containing `package/browsers.json`.
pub fn write_npm_tarball(path: &Path, browsers: &Value) {
    let body = serde_json::to_vec(browsers).expect("serialize browsers.json");
    write_tarball_member(path, "package/browsers.json", &body);
}

pub fn write_tarball_member(path: &Path, member: &str, body: &[u8]) {
    let file = fs::File::create(path).expect("create tarball");
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_path(member).expect("tar path");
    header.set_size(body.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(0);
    header.set_cksum();
    builder.append(&header, body).expect("append member");
    let encoder = builder.into_inner().expect("finish tar");
    encoder.finish().expect("finish gzip");
}

/// Old-style `.narinfo` plus its NAR, as `nix copy` leaves them.
pub fn write_cache_directory(directory: &Path, store_path: &str, signature: Option<&str>) {
    let nar_directory = directory.join("nar");
    fs::create_dir_all(&nar_directory).expect("create nar directory");
    fs::write(nar_directory.join("example.nar.xz"), b"a compressed NAR").expect("write nar");
    let mut info = format!(
        "StorePath: {store_path}\nURL: nar/example.nar.xz\nCompression: xz\nNarHash: sha256:abc\nNarSize: 16\n"
    );
    if let Some(signature) = signature {
        info.push_str(&format!("Sig: {signature}\n"));
    }
    fs::write(directory.join("example.narinfo"), info).expect("write narinfo");
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub fn temp_root() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("tempdir");
    let root = directory.path().to_path_buf();
    (directory, root)
}
