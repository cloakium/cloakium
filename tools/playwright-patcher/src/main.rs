//! CLI for deterministic replay of the Cloakium `playwright-core` patch set.
//!
//! The package marker (`cloakium` in package.json) is generated from the
//! package that is actually being patched, so a Playwright bump never requires
//! editing a patch.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use playwright_patcher::apply::{self, ReplayConfig};
use playwright_patcher::manifest::{self, MANIFEST_FILE};
use playwright_patcher::{fail, fsutil, Failure, Result};

const USAGE: &str = "\
playwright-patcher - deterministic patch replay for the Cloakium playwright-core build

USAGE:
    playwright-patcher apply --source <DIR> --target <DIR> [options]
    playwright-patcher check --source <DIR> [options]
    playwright-patcher list --patches <DIR>

OPTIONS:
    --source <DIR>       unpacked upstream package (read only)
    --target <DIR>       destination for the patched package (must be absent or empty)
    --patches <DIR>      directory of *.patch files [default: patches/playwright]
    --patch-set <NAME>   recorded in the package marker and manifest [default: playwright]
    --marker <FILE>      file that receives the cloakium marker [default: package.json]
    --no-marker          do not add the cloakium marker or touch package metadata
    --max-offset <N>     diagnostic only: limit hunk search to +/-N lines
    --check              verify the patch set applies, write nothing
    --no-manifest        do not write CLOAKIUM-PATCHES.json
    -h, --help           show this help
    -V, --version        show the version

PATCH SEMANTICS:
    Unified diffs are replayed with zero fuzz: every context and removed line
    must match the source byte for byte, and the match must be unique. A hunk
    that only matches in reverse is rejected as already applied. By default the
    whole file is searched, so unrelated upstream edits cannot break a patch
    just by moving code.
";

#[derive(Debug, Clone)]
struct Options {
    source: Option<PathBuf>,
    target: Option<PathBuf>,
    patches: PathBuf,
    patch_set: String,
    marker: Option<String>,
    max_offset: Option<usize>,
    check: bool,
    manifest: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            source: None,
            target: None,
            patches: PathBuf::from("patches/playwright"),
            patch_set: "playwright".to_string(),
            marker: Some("package.json".to_string()),
            max_offset: None,
            check: false,
            manifest: true,
        }
    }
}

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            eprintln!("playwright-patcher: {}", failure.message());
            ExitCode::FAILURE
        }
    }
}

fn run(args: Vec<String>) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("-h") | Some("--help") | Some("help") => {
            print!("{USAGE}");
            Ok(())
        }
        Some("-V") | Some("--version") => {
            println!("playwright-patcher {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("list") => {
            let options = parse_options(&args[1..])?;
            list(&options.patches)
        }
        Some("apply") => apply_command(&args[1..]),
        Some("check") => {
            let mut options = parse_options(&args[1..])?;
            options.check = true;
            apply_command_with(options)
        }
        Some(first) if first.starts_with('-') => apply_command(&args),
        Some(other) => Err(Failure::new(format!(
            "unknown command {other:?}; try --help"
        ))),
        None => Err(Failure::new("missing command; try --help")),
    }
}

fn apply_command(args: &[String]) -> Result<()> {
    apply_command_with(parse_options(args)?)
}

fn apply_command_with(options: Options) -> Result<()> {
    let source = options
        .source
        .as_deref()
        .ok_or_else(|| Failure::new("--source <DIR> is required"))?;
    if !source.is_dir() {
        fail!("source directory {} does not exist", source.display());
    }

    if !options.check {
        let target = options
            .target
            .as_deref()
            .ok_or_else(|| Failure::new("--target <DIR> is required"))?;
        if target == source {
            fail!("--target must differ from --source");
        }
        if target.exists() {
            if !target.is_dir() {
                fail!("target {} exists and is not a directory", target.display());
            }
            if !fsutil::is_empty_dir(target)? {
                fail!(
                    "target {} is not empty; remove it or pick another directory",
                    target.display()
                );
            }
        }
    }

    let patches = apply::load_patches(&options.patches)?;
    let config = ReplayConfig {
        patch_set: options.patch_set.clone(),
        marker_file: options.marker.clone(),
        max_offset: options.max_offset,
    };
    let (report, contents) = apply::replay(
        &patches,
        |relative| fsutil::read_text(&source.join(relative)),
        &config,
    )?;

    summarize(&report);
    if options.check {
        println!(
            "ok: {} patch(es) apply cleanly to {}",
            report.patches.len(),
            source.display()
        );
        return Ok(());
    }

    let target = options
        .target
        .as_deref()
        .ok_or_else(|| Failure::new("--target <DIR> is required"))?;
    fsutil::copy_tree(source, target)?;
    for (relative, content) in &contents {
        fsutil::write_text(&target.join(relative), content)?;
    }
    if options.manifest {
        let rendered = manifest::render(&options.patch_set, &report);
        fsutil::write_text(&target.join(MANIFEST_FILE), &rendered)?;
        println!("wrote {}", target.join(MANIFEST_FILE).display());
    }
    println!("patched package at {}", target.display());
    Ok(())
}

fn list(patches: &Path) -> Result<()> {
    let loaded = apply::load_patches(patches)?;
    for patch in &loaded {
        println!(
            "{:<48} {:>3} hunk(s)  -> {}",
            patch.name,
            patch.file.hunks.len(),
            patch.file.target
        );
    }
    Ok(())
}

fn summarize(report: &apply::Report) {
    for file in &report.files {
        println!(
            "{}: {} -> {}",
            file.path,
            &file.sha256_before[..12],
            &file.sha256_after[..12]
        );
    }
    if let Some(marker) = &report.marker {
        println!(
            "marker: {} {} (patch set {})",
            marker.package, marker.version, marker.patch_set
        );
    }
}

fn parse_options(args: &[String]) -> Result<Options> {
    let mut options = Options::default();
    let mut index = 0usize;
    while index < args.len() {
        let (key, inline) = match args[index].split_once('=') {
            Some((key, value)) => (key.to_string(), Some(value.to_string())),
            None => (args[index].clone(), None),
        };
        match key.as_str() {
            "--source" => {
                options.source = Some(PathBuf::from(take_value(args, &mut index, &key, inline)?))
            }
            "--target" => {
                options.target = Some(PathBuf::from(take_value(args, &mut index, &key, inline)?))
            }
            "--patches" => {
                options.patches = PathBuf::from(take_value(args, &mut index, &key, inline)?)
            }
            "--patch-set" => options.patch_set = take_value(args, &mut index, &key, inline)?,
            "--marker" => options.marker = Some(take_value(args, &mut index, &key, inline)?),
            "--no-marker" => {
                options.marker = None;
                index += 1;
            }
            "--max-offset" => {
                let value = take_value(args, &mut index, &key, inline)?;
                let offset: usize = value.parse().map_err(|_| {
                    Failure::new(format!("--max-offset expects a number, got {value:?}"))
                })?;
                options.max_offset = Some(offset);
            }
            "--check" => {
                options.check = true;
                index += 1;
            }
            "--no-manifest" => {
                options.manifest = false;
                index += 1;
            }
            "-h" | "--help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            other => fail!("unknown option {other:?}; try --help"),
        }
    }
    Ok(options)
}

fn take_value(
    args: &[String],
    index: &mut usize,
    key: &str,
    inline: Option<String>,
) -> Result<String> {
    if let Some(value) = inline {
        *index += 1;
        return Ok(value);
    }
    *index += 1;
    let value = args
        .get(*index)
        .cloned()
        .ok_or_else(|| Failure::new(format!("{key} requires a value")))?;
    *index += 1;
    Ok(value)
}
