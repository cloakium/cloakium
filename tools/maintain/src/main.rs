use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};

use cloakium_maintain::command::ProcessRunner;
use cloakium_maintain::release::{self, ReleaseOptions, DEFAULT_BUILD_TIMEOUT, DEFAULT_CORES};
use cloakium_maintain::report::Reporter;
use cloakium_maintain::sign_release::{self, SignReleaseOptions};
use cloakium_maintain::update::{self, UpdateOptions};
use cloakium_maintain::util;
use cloakium_maintain::validate_update::{self, ValidateUpdateOptions};
use cloakium_maintain::verify_publication::{self, VerifyPublicationOptions};

/// Prepare upstream candidates, stage and sign releases, verify publications.
#[derive(Debug, Parser)]
#[command(
    name = "cloakium-maintain",
    version,
    about = "Prepare Cloakium upstream candidates and staged release assets",
    long_about = "Prepare Cloakium upstream candidates and staged release assets.\n\n\
        `update` rewrites flake.lock, upstream.json, package.json, package-lock.json and \
        nix/npm-deps-hash.nix for the latest stable playwright-core. It publishes nothing. \
        Playwright's bundled CfT pin and the native Chromium pin are tracked separately and their \
        major distance is reported for information only: whether a pair is supported is decided by \
        the recorded driver+native integration evidence, not by a version heuristic.\n\n\
        `validate-update` compares an update candidate against a trusted checkout and accepts \
        only the five files, the dependency pin and the nixpkgs refresh an update may change.\n\n\
        `release` copies the flake outputs into a flat Nix binary cache and writes manifest.json, \
        closure.json, SHA256SUMS and release-notes.md. With `--unsigned` it produces an unsigned \
        staging directory (at most 9 GiB, sized for the Actions cache) for a trusted publisher; \
        otherwise it signs with --signing-key.\n\n\
        `sign-release` re-verifies a staged release and signs every narinfo in the cache \
        (the manifest outputs and their runtime closure, including custom patched paths) with \
        the trusted key. It runs no code from the staged artifacts. Signing keys are never printed.\n\n\
        `verify-publication` cross-checks an existing release's API JSON, SHA256SUMS and manifest \
        without network access, so re-running a publication is safe.\n\n\
        Every command reports workflow fields on stdout and in $GITHUB_OUTPUT.",
    propagate_version = true,
    arg_required_else_help = true
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Track the latest stable playwright-core and Chromium pin (no publication)
    Update(UpdateArgs),
    /// Check that an update candidate only touches the allowed pins
    ValidateUpdate(ValidateUpdateArgs),
    /// Stage a flat Nix cache and release assets for one commit
    Release(ReleaseArgs),
    /// Re-verify and sign a staged release with the trusted publisher key
    SignRelease(SignReleaseArgs),
    /// Verify an already published release from its API JSON and metadata
    VerifyPublication(VerifyPublicationArgs),
}

#[derive(Debug, Args)]
struct VerifyPublicationArgs {
    /// Release JSON from the GitHub API (`gh api releases/tags/<tag>`)
    #[arg(long, value_name = "PATH")]
    release_json: PathBuf,

    /// Downloaded SHA256SUMS asset of the published release
    #[arg(long, value_name = "PATH")]
    checksums: PathBuf,

    /// Downloaded manifest.json asset of the published release
    #[arg(long, value_name = "PATH")]
    manifest: PathBuf,

    /// Expected source revision recorded in the manifest
    #[arg(long, value_name = "SHA")]
    revision: String,
}

#[derive(Debug, Args)]
struct ValidateUpdateArgs {
    /// Trusted checkout that the candidate is compared against
    #[arg(long, value_name = "ROOT")]
    base: PathBuf,

    /// Candidate update files, or a whole checkout (`--candidate .`)
    #[arg(
        long,
        value_name = "DIR",
        long_help = "Directory holding the candidate update files. A full checkout (one with \
                     flake.nix/.git/.jj) is validated on the five metadata paths only, so build \
                     outputs such as result-* GC roots and node_modules are ignored; a bare \
                     metadata directory is validated strictly and may contain nothing else."
    )]
    candidate: PathBuf,
}

#[derive(Debug, Args)]
struct SignReleaseArgs {
    /// Staged unsigned release directory produced by `release --unsigned`
    #[arg(long, value_name = "DIR")]
    input: PathBuf,

    /// Expected source revision recorded in the staged manifest
    #[arg(long, value_name = "SHA")]
    revision: String,

    /// Nix cache signing key file; only nix reads it and it is never printed
    #[arg(long, value_name = "PATH")]
    signing_key: PathBuf,

    /// Public key that must match the signing key; written into the release
    #[arg(long, value_name = "PATH")]
    public_key: PathBuf,

    /// Write the signed release into a fresh directory instead of in place
    #[arg(long, value_name = "PATH")]
    output: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct UpdateArgs {
    /// Checkout root; defaults to the nearest parent directory containing flake.nix
    #[arg(long, value_name = "PATH")]
    root: Option<PathBuf>,

    /// Keep a refreshed nixpkgs lock even when upstream versions did not change
    #[arg(long)]
    refresh_toolchain: bool,
}

#[derive(Debug, Args)]
struct ReleaseArgs {
    /// Full 40-character lowercase commit ID being released
    #[arg(long, value_name = "SHA")]
    revision: String,

    /// Checkout root; defaults to the nearest parent directory containing flake.nix
    #[arg(long, value_name = "PATH")]
    root: Option<PathBuf>,

    /// Fresh directory for the release assets; must not exist yet
    #[arg(
        long,
        value_name = "PATH",
        long_help = "Fresh directory for the release assets; must not exist yet. Defaults to <root>/artifacts/release."
    )]
    output: Option<PathBuf>,

    /// Sign the cache with this key; omit and pass --unsigned to stage instead
    #[arg(
        long,
        value_name = "PATH",
        required_unless_present = "unsigned",
        conflicts_with = "unsigned",
        long_help = "Nix cache signing key file. Its contents are never printed. Required unless --unsigned is given."
    )]
    signing_key: Option<PathBuf>,

    /// Stage an unsigned cache for a separate trusted signing job
    #[arg(
        long,
        long_help = "Stage an unsigned, flattened cache plus the same manifest, evidence and release assets. The trusted publisher re-verifies and signs it with `sign-release`."
    )]
    unsigned: bool,

    /// Public key copied into the release as cache-public-key.txt
    #[arg(long, value_name = "PATH")]
    public_key: Option<PathBuf>,

    /// Test evidence copied into the release as verification.json
    #[arg(long, value_name = "PATH")]
    evidence: Option<PathBuf>,

    /// Build the flake outputs first; omit when a previous job already built them
    #[arg(long)]
    build: bool,

    /// Build cores passed to nix build
    #[arg(long, value_name = "CORES", default_value_t = DEFAULT_CORES)]
    cores: u32,

    /// Wall-clock budget for nix build, in seconds
    #[arg(long, value_name = "SECONDS", default_value_t = DEFAULT_BUILD_TIMEOUT.as_secs())]
    build_timeout: u64,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match execute(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cloakium-maintain: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn execute(cli: Cli) -> Result<()> {
    let mut runner = ProcessRunner;
    let reporter = Reporter::from_env();
    match cli.command {
        Commands::Update(args) => {
            let root = util::resolve_root(args.root.as_deref())?;
            let options = UpdateOptions {
                root,
                refresh_toolchain: args.refresh_toolchain,
            };
            update::prepare(&options, &mut runner, &reporter)?;
        }
        Commands::ValidateUpdate(args) => {
            let options = ValidateUpdateOptions {
                base: args.base,
                candidate: args.candidate,
            };
            validate_update::prepare(&options, &reporter)?;
        }
        Commands::Release(args) => {
            let root = util::resolve_root(args.root.as_deref())?;
            let options = ReleaseOptions {
                output: args
                    .output
                    .unwrap_or_else(|| release::default_output(&root)),
                root,
                revision: args.revision,
                signing_key: args.signing_key,
                unsigned: args.unsigned,
                public_key: args.public_key,
                evidence: args.evidence,
                build: args.build,
                cores: args.cores,
                build_timeout: Duration::from_secs(args.build_timeout),
            };
            release::prepare(&options, &mut runner, &reporter)?;
        }
        Commands::SignRelease(args) => {
            let options = SignReleaseOptions {
                input: args.input,
                output: args.output,
                revision: args.revision,
                signing_key: args.signing_key,
                public_key: args.public_key,
            };
            sign_release::prepare(&options, &mut runner, &reporter)?;
        }
        Commands::VerifyPublication(args) => {
            let options = VerifyPublicationOptions {
                release_json: args.release_json,
                checksums: args.checksums,
                manifest: args.manifest,
                revision: args.revision,
            };
            verify_publication::prepare(&options, &reporter)?;
        }
    }
    Ok(())
}
