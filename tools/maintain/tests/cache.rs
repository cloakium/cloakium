//! Behaviour tests for flattened, signed Nix cache staging.

mod support;

use std::fs;
use std::path::Path;

use cloakium_maintain::cache::{flatten_cache, verify_signed, write_checksums, ASSET_LIMIT};

const NARINFO: &str = "StorePath: /nix/store/example\nURL: nar/example.nar.xz\nNarHash: sha256:abc\nSig: cloakium:test\n";

fn write_narinfo(directory: &Path, name: &str, contents: &str) {
    fs::write(directory.join(name), contents).expect("write narinfo");
}

fn write_nar(directory: &Path, name: &str, contents: &[u8]) {
    let nar_directory = directory.join("nar");
    fs::create_dir_all(&nar_directory).expect("create nar");
    fs::write(nar_directory.join(name), contents).expect("write nar");
}

#[test]
fn flatten_preserves_signatures_and_nar_hashes() {
    let (_directory, root) = support::temp_root();
    write_nar(&root, "example.nar.xz", b"a compressed NAR");
    write_narinfo(&root, "example.narinfo", NARINFO);

    flatten_cache(&root).expect("flatten");

    assert_eq!(
        fs::read(root.join("example.nar.xz")).expect("flat nar"),
        b"a compressed NAR"
    );
    assert_eq!(
        fs::read_to_string(root.join("example.narinfo")).expect("narinfo"),
        NARINFO.replace("URL: nar/", "URL: ")
    );
    assert!(!root.join("nar").exists());
}

#[test]
fn flatten_rejects_traversal_and_remote_urls() {
    for url in [
        "../private.key",
        "https://example.test/evil.nar.xz",
        "nar/a/b.nar.xz",
    ] {
        let (_directory, root) = support::temp_root();
        write_narinfo(&root, "bad.narinfo", &format!("URL: {url}\n"));
        let error = flatten_cache(&root).expect_err(url);
        assert!(
            format!("{error:#}").contains("cache asset URL"),
            "{url}: {error:#}"
        );
    }
}

#[test]
fn multiple_store_paths_can_share_a_nar() {
    let (_directory, root) = support::temp_root();
    write_nar(&root, "shared.nar.xz", b"same contents");
    for name in ["a", "b"] {
        write_narinfo(
            &root,
            &format!("{name}.narinfo"),
            "URL: nar/shared.nar.xz\n",
        );
    }

    flatten_cache(&root).expect("flatten");

    for name in ["a", "b"] {
        assert_eq!(
            fs::read_to_string(root.join(format!("{name}.narinfo"))).expect("narinfo"),
            "URL: shared.nar.xz\n"
        );
    }
    assert_eq!(
        fs::read(root.join("shared.nar.xz")).expect("shared nar"),
        b"same contents"
    );
}

#[test]
fn a_narinfo_needs_exactly_one_url_line() {
    let (_directory, root) = support::temp_root();
    write_narinfo(&root, "none.narinfo", "StorePath: /nix/store/example\n");
    assert!(flatten_cache(&root).is_err());

    let (_directory, root) = support::temp_root();
    write_nar(&root, "example.nar.xz", b"x");
    write_narinfo(
        &root,
        "two.narinfo",
        "URL: nar/example.nar.xz\nURL: nar/example.nar.xz\n",
    );
    let error = flatten_cache(&root).expect_err("two URLs");
    assert!(
        format!("{error:#}").contains("exactly one URL"),
        "{error:#}"
    );
}

#[test]
fn a_missing_nar_is_rejected() {
    let (_directory, root) = support::temp_root();
    write_narinfo(&root, "example.narinfo", NARINFO);
    let error = flatten_cache(&root).expect_err("missing nar");
    assert!(format!("{error:#}").contains("missing"), "{error:#}");
}

#[test]
fn a_duplicate_asset_name_is_rejected() {
    let (_directory, root) = support::temp_root();
    write_nar(&root, "example.nar.xz", b"x");
    fs::write(root.join("example.nar.xz"), b"already here").expect("collision");
    write_narinfo(&root, "example.narinfo", NARINFO);

    let error = flatten_cache(&root).expect_err("duplicate");
    assert!(
        format!("{error:#}").contains("duplicate cache asset"),
        "{error:#}"
    );
}

#[test]
fn unreferenced_nars_are_rejected() {
    let (_directory, root) = support::temp_root();
    write_nar(&root, "example.nar.xz", b"x");
    write_nar(&root, "orphan.nar.xz", b"orphan");
    write_narinfo(&root, "example.narinfo", NARINFO);

    let error = flatten_cache(&root).expect_err("orphan nar");
    assert!(format!("{error:#}").contains("nar"), "{error:#}");
}

#[test]
fn a_symlinked_nar_is_rejected() {
    let (_directory, root) = support::temp_root();
    write_nar(&root, "example.nar.xz", b"x");
    let target = root.join("real.nar.xz");
    fs::rename(root.join("nar/example.nar.xz"), &target).expect("move");
    std::os::unix::fs::symlink(&target, root.join("nar/example.nar.xz")).expect("symlink");
    write_narinfo(&root, "example.narinfo", NARINFO);

    let error = flatten_cache(&root).expect_err("symlink nar");
    assert!(format!("{error:#}").contains("regular file"), "{error:#}");
}

#[test]
fn unsigned_entries_are_rejected() {
    let (_directory, root) = support::temp_root();
    write_narinfo(&root, "signed.narinfo", "Sig: cloakium:abc\n");
    verify_signed(&root).expect("signed");

    let (_directory, root) = support::temp_root();
    write_narinfo(&root, "unsigned.narinfo", "StorePath: /nix/store/x\n");
    let error = verify_signed(&root).expect_err("unsigned");
    assert!(format!("{error:#}").contains("unsigned"), "{error:#}");

    let (_directory, root) = support::temp_root();
    write_narinfo(&root, "malformed.narinfo", "Sig: no-colon\n");
    assert!(verify_signed(&root).is_err());
}

#[test]
fn cache_bookkeeping_directories_are_removed() {
    let (_directory, root) = support::temp_root();
    write_nar(&root, "example.nar.xz", b"x");
    write_narinfo(&root, "example.narinfo", NARINFO);
    fs::create_dir(root.join("log")).expect("log directory");
    fs::write(root.join("log/build.log"), "build output").expect("log file");
    fs::create_dir(root.join("realisations")).expect("realisations directory");

    flatten_cache(&root).expect("flatten");

    assert!(!root.join("log").exists());
    assert!(!root.join("realisations").exists());
}

#[test]
fn content_addressed_realisations_are_rejected() {
    let (_directory, root) = support::temp_root();
    write_nar(&root, "example.nar.xz", b"x");
    write_narinfo(&root, "example.narinfo", NARINFO);
    fs::create_dir(root.join("realisations")).expect("realisations directory");
    fs::write(root.join("realisations/example.json"), "{}").expect("realisation");

    let error = flatten_cache(&root).expect_err("realisations");
    assert!(
        format!("{error:#}").contains("content-addressed realisations"),
        "{error:#}"
    );
}

#[test]
fn checksums_are_deterministic_and_exclude_themselves() {
    let (_directory, root) = support::temp_root();
    fs::write(root.join("hello.txt"), "hello\n").expect("write");
    fs::write(root.join("nix-cache-info"), "StoreDir: /nix/store\n").expect("write");

    write_checksums(&root).expect("checksums");
    let first = fs::read(root.join("SHA256SUMS")).expect("read sums");
    write_checksums(&root).expect("checksums again");
    assert_eq!(first, fs::read(root.join("SHA256SUMS")).expect("read sums"));

    let text = String::from_utf8(first).expect("utf8");
    assert!(
        text.contains(
            "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  hello.txt"
        ),
        "{text}"
    );
    assert!(!text.contains("SHA256SUMS"));
}

#[test]
fn an_empty_directory_produces_empty_checksums() {
    let (_directory, root) = support::temp_root();
    write_checksums(&root).expect("checksums");
    assert_eq!(
        fs::read_to_string(root.join("SHA256SUMS")).expect("sums"),
        ""
    );
}

#[test]
fn symlink_assets_are_rejected() {
    let (_directory, root) = support::temp_root();
    fs::write(root.join("target"), "secret").expect("write");
    std::os::unix::fs::symlink(root.join("target"), root.join("link")).expect("symlink");

    let error = write_checksums(&root).expect_err("symlink");
    assert!(format!("{error:#}").contains("regular files"), "{error:#}");
}

#[test]
fn directories_are_rejected_as_assets() {
    let (_directory, root) = support::temp_root();
    fs::create_dir(root.join("nested")).expect("dir");
    assert!(write_checksums(&root).is_err());
}

#[test]
fn asset_names_must_be_safe() {
    let (_directory, root) = support::temp_root();
    fs::write(root.join("bad name.txt"), "x").expect("write");
    let error = write_checksums(&root).expect_err("unsafe name");
    assert!(format!("{error:#}").contains("unsafe"), "{error:#}");
}

#[test]
fn assets_at_the_github_limit_are_rejected() {
    // Checking the real 2 GiB boundary would need a sparse 2 GiB file; assert
    // the constant instead and rely on the size check being a simple `>=`.
    assert_eq!(ASSET_LIMIT, 2 * 1024 * 1024 * 1024);

    let (_directory, root) = support::temp_root();
    let path = root.join("big");
    let file = fs::File::create(&path).expect("create");
    file.set_len(ASSET_LIMIT).expect("sparse file");
    let error = write_checksums(&root).expect_err("oversized asset");
    assert!(format!("{error:#}").contains("2 GiB"), "{error:#}");
}
