//! CLI argument shapes for the audit binary.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

use cloakium_audit::model::{DisplayKind, Identity, Layer};

#[derive(Debug, Parser)]
#[command(
    name = "cloakium-audit",
    version,
    about = "Inventory, plan, run, compare and catalogue private browser audits",
    long_about = "Inventory, plan, run, compare and catalogue private browser audits.\n\n\
        `inventory` proves an explicitly selected artifact is a native Linux ELF and the launcher is an ELF or trusted shebang script, records real paths and SHA-256 before/after, and never executes either.\n\n\
        `plan` writes a versioned comparison plan from explicit baseline/candidate artifacts and \
        a client module. The default matrix covers both headless and headed modes with two \
        iterations per target.\n\n\
        `validate` enforces the strict plan/report schema and separates validity from \
        completeness.\n\n\
        `run` validates a plan, executes a selected Node runner once for the whole plan under one \
        wall-clock deadline, clears the inherited environment, owns one process group plus tracked detached descendants, and writes a private report. It never launches a duplicate after a timeout.\n\n\
        `compare` retains raw differences while separating functional capability differences from \
        ordinary value variation, within-target headless regressions, iteration instability, \
        execution errors and environment/version confounders.\n\n\
        `catalog` merges canonical gap rows by feature id and preserves every provenance and \
        unknown.\n\n\
        `finalize` recovers a canonical report from a completed closed run using only its \
        private metadata, without launching Node or a browser. It revalidates identities and \
        cleanup, preserves the original observations and writes a new non-overwriting report.\n\n\
        Outputs are owner-only (directories 0700, files 0600); raw run output defaults outside a \
        checkout. No credentials, vendor binaries, detector scores or protected-site probes are \
        accepted.",
    propagate_version = true,
    arg_required_else_help = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Identify an artifact and launcher without executing either
    Inventory(InventoryArgs),
    /// Generate a versioned baseline/candidate comparison plan
    Plan(Box<PlanArgs>),
    /// Validate a plan or report and report completeness
    Validate(ValidateArgs),
    /// Execute a validated plan with an explicit Node runner
    Run(RunArgs),
    /// Recover a canonical report from a completed closed run without executing it
    Finalize(FinalizeArgs),
    /// Classify differences between two reports
    Compare(CompareArgs),
    /// Merge gap rows by feature id with provenance
    Catalog(CatalogArgs),
    /// Print the published JSON Schema contract
    Schema(SchemaArgs),
}

#[derive(Debug, Clone, ValueEnum)]
pub enum LayerArg {
    Engine,
    Launcher,
    Product,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum IdentityArg {
    Native,
    Persona,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum DisplayKindArg {
    ExternalOwned,
    Managed,
}

impl From<LayerArg> for Layer {
    fn from(value: LayerArg) -> Self {
        match value {
            LayerArg::Engine => Layer::Engine,
            LayerArg::Launcher => Layer::Launcher,
            LayerArg::Product => Layer::Product,
        }
    }
}

impl From<IdentityArg> for Identity {
    fn from(value: IdentityArg) -> Self {
        match value {
            IdentityArg::Native => Identity::Native,
            IdentityArg::Persona => Identity::Persona,
        }
    }
}

impl From<DisplayKindArg> for DisplayKind {
    fn from(value: DisplayKindArg) -> Self {
        match value {
            DisplayKindArg::ExternalOwned => DisplayKind::ExternalOwned,
            DisplayKindArg::Managed => DisplayKind::Managed,
        }
    }
}

#[derive(Debug, Args)]
pub struct InventoryArgs {
    /// Plan whose targets are inventoried
    #[arg(long, value_name = "PATH", conflicts_with = "artifact")]
    pub plan: Option<PathBuf>,

    /// Explicit artifact path; identified before any digest is computed
    #[arg(long, value_name = "PATH", visible_alias = "binary")]
    pub artifact: Option<PathBuf>,

    /// Trusted launcher or wrapper, kept distinct from the artifact
    #[arg(long, value_name = "PATH", visible_alias = "executable")]
    pub launcher: Option<PathBuf>,

    /// Client module path recorded in the inventory (not executed)
    #[arg(long, value_name = "PATH", default_value = "")]
    pub client_module: String,

    /// Target id for a standalone artifact
    #[arg(long, value_name = "ID", default_value = "target")]
    pub id: String,

    /// Target label for a standalone artifact
    #[arg(long, value_name = "TEXT")]
    pub label: Option<String>,

    /// Layer changed by this target
    #[arg(long, value_enum, default_value_t = LayerArg::Engine)]
    pub layer: LayerArg,

    /// Identity policy of this target
    #[arg(long, value_enum, default_value_t = IdentityArg::Native)]
    pub identity: IdentityArg,

    /// Extra argument recorded on the target
    #[arg(long = "arg", value_name = "ARG")]
    pub args: Vec<String>,

    /// Extra headless argument recorded on the target
    #[arg(long = "headless-arg", value_name = "ARG")]
    pub headless_args: Vec<String>,

    /// Extra headed argument recorded on the target
    #[arg(long = "headed-arg", value_name = "ARG")]
    pub headed_args: Vec<String>,

    /// Write the inventory bundle privately instead of stdout
    #[arg(long, value_name = "PATH")]
    pub output: Option<PathBuf>,

    /// Replace an existing output file
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct PlanArgs {
    /// Explicit baseline artifact path
    #[arg(long, value_name = "PATH")]
    pub baseline: PathBuf,

    /// Explicit candidate artifact path
    #[arg(long, value_name = "PATH")]
    pub candidate: PathBuf,

    /// Optional trusted baseline launcher, distinct from the artifact
    #[arg(long, value_name = "PATH")]
    pub baseline_launcher: Option<PathBuf>,

    /// Optional trusted candidate launcher, distinct from the artifact
    #[arg(long, value_name = "PATH")]
    pub candidate_launcher: Option<PathBuf>,

    /// Explicit client module used by both targets
    #[arg(long, value_name = "PATH")]
    pub client_module: PathBuf,

    /// Iterations per target and mode
    #[arg(long, value_name = "N", default_value_t = 2)]
    pub iterations: u32,

    /// Private plan output path
    #[arg(long, value_name = "PATH")]
    pub output: PathBuf,

    /// Replace an existing plan file
    #[arg(long)]
    pub force: bool,

    /// Environment id
    #[arg(long, default_value = "local")]
    pub environment_id: String,

    /// BCP 47 browser locale; the child POSIX locale stays C.UTF-8
    #[arg(long, default_value = "en-US")]
    pub locale: String,

    /// IANA timezone applied to the child environment
    #[arg(long = "timezone", default_value = "UTC")]
    pub timezone_id: String,

    /// Fontconfig file whose digest is part of provenance
    #[arg(long, value_name = "PATH")]
    pub fontconfig_file: Option<PathBuf>,

    /// Fontconfig search path recorded in provenance
    #[arg(long, value_name = "PATH")]
    pub fontconfig_path: Option<PathBuf>,

    /// Expected fontconfig SHA-256 (lowercase hex)
    #[arg(long, value_name = "SHA256")]
    pub font_manifest_sha256: Option<String>,

    /// Display ownership model
    #[arg(long, value_enum, default_value_t = DisplayKindArg::Managed)]
    pub display_kind: DisplayKindArg,

    /// Display width in pixels
    #[arg(long, default_value_t = 1280)]
    pub width: u32,

    /// Display height in pixels
    #[arg(long, default_value_t = 800)]
    pub height: u32,

    /// Display depth in bits
    #[arg(long, default_value_t = 24)]
    pub depth: u32,

    /// Display DPI
    #[arg(long, default_value_t = 96)]
    pub dpi: u32,

    /// Window manager selected for headed runs
    #[arg(long, default_value = "none")]
    pub window_manager: String,

    /// Exact display name, for an external-owned display
    #[arg(long, value_name = "NAME")]
    pub display_name: Option<String>,

    /// Xauthority path; its content is never read
    #[arg(long, value_name = "PATH")]
    pub xauthority: Option<PathBuf>,

    /// Managed-display ownership manifest path
    #[arg(long, value_name = "PATH")]
    pub ownership_manifest: Option<PathBuf>,

    /// Environment note recorded in the plan
    #[arg(long)]
    pub notes: Option<String>,

    /// Suite name selected in every configuration
    #[arg(long = "suite", value_name = "NAME", default_value = "fingerprint")]
    pub suites: Vec<String>,

    /// Probe id selected in every configuration
    #[arg(long = "probe", value_name = "ID")]
    pub probes: Vec<String>,

    /// Exact scenario id selected within the named suites
    #[arg(long = "scenario", value_name = "ID")]
    pub scenarios: Vec<String>,

    /// Suite-specific JSON setting, as KEY=JSON
    #[arg(long = "suite-option", value_name = "KEY=JSON")]
    pub suite_options: Vec<String>,

    /// JSON file with arbitrary probe configuration
    #[arg(long, value_name = "PATH")]
    pub probe_config: Option<PathBuf>,

    /// Fixed fingerprint seed applied to every configuration
    #[arg(long, value_name = "SEED")]
    pub seed: Option<String>,

    /// Baseline layer
    #[arg(long, value_enum, default_value_t = LayerArg::Engine)]
    pub baseline_layer: LayerArg,

    /// Candidate layer
    #[arg(long, value_enum, default_value_t = LayerArg::Engine)]
    pub candidate_layer: LayerArg,

    /// Baseline identity policy
    #[arg(long, value_enum, default_value_t = IdentityArg::Native)]
    pub baseline_identity: IdentityArg,

    /// Candidate identity policy
    #[arg(long, value_enum, default_value_t = IdentityArg::Native)]
    pub candidate_identity: IdentityArg,
}

#[derive(Debug, Args)]
pub struct ValidateArgs {
    /// Plan to validate
    #[arg(long, value_name = "PATH", conflicts_with = "report")]
    pub plan: Option<PathBuf>,

    /// Report to validate
    #[arg(long, value_name = "PATH")]
    pub report: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct RunArgs {
    /// Validated plan to execute
    #[arg(long, value_name = "PATH")]
    pub plan: PathBuf,

    /// Explicit Node executable
    #[arg(long, value_name = "PATH")]
    pub node: PathBuf,

    /// Explicit JS runner implementing the published runner protocol
    #[arg(long, value_name = "PATH")]
    pub runner: PathBuf,

    /// Private output directory outside the checkout
    #[arg(long, value_name = "PATH")]
    pub output: Option<PathBuf>,

    /// Whole-run wall-clock budget in seconds
    #[arg(
        long,
        value_name = "SECONDS",
        default_value_t = 3600,
        long_help = "Wall-clock budget for the complete run in seconds, beginning before Node \
                     selection and covering every configuration and cleanup. A timed-out runner \
                     group receives SIGTERM and then SIGKILL; no duplicate is launched."
    )]
    pub timeout: u64,

    /// Suite manifest whose digest is recorded in the report
    #[arg(long, value_name = "PATH")]
    pub suite_manifest: Option<PathBuf>,

    /// Exclusive flock seat path
    #[arg(long, value_name = "PATH")]
    pub lock: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct CompareArgs {
    /// Baseline report
    #[arg(long, value_name = "PATH")]
    pub baseline: PathBuf,

    /// Candidate report
    #[arg(long, value_name = "PATH")]
    pub candidate: PathBuf,

    /// Recorded policy with exact allowlist entries and stable fields
    #[arg(long, value_name = "PATH")]
    pub policy: Option<PathBuf>,

    /// Plan used for both reports; required for a complete comparison
    #[arg(long, value_name = "PATH")]
    pub plan: Option<PathBuf>,

    /// Private compare output path
    #[arg(long, value_name = "PATH")]
    pub output: PathBuf,

    /// Baseline target id when a report contains several
    #[arg(long, value_name = "ID")]
    pub baseline_target: Option<String>,

    /// Candidate target id when a report contains several
    #[arg(long, value_name = "ID")]
    pub candidate_target: Option<String>,

    /// Replace an existing compare file
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct CatalogArgs {
    /// Compare output or existing catalogue to merge
    #[arg(long, value_name = "PATH", required = true)]
    pub input: Vec<PathBuf>,

    /// Private catalogue output path
    #[arg(long, value_name = "PATH")]
    pub output: PathBuf,

    /// Replace an existing catalogue file
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum SchemaArg {
    Plan,
    Report,
    Runner,
    Policy,
    Compare,
    Catalog,
    Inventory,
    Execution,
}

#[derive(Debug, Args)]
pub struct SchemaArgs {
    /// Schema to print; omit for the complete contract object
    #[arg(long, value_enum)]
    pub name: Option<SchemaArg>,
}

#[derive(Debug, Args)]
pub struct FinalizeArgs {
    /// Completed run directory containing plan, inventory, execution and runner-report
    #[arg(long, value_name = "DIR")]
    pub run_dir: PathBuf,

    /// New private report path; must not exist
    #[arg(long, value_name = "PATH")]
    pub output: PathBuf,

    /// Recovery reason recorded in the report
    #[arg(long, value_name = "TEXT")]
    pub reason: Option<String>,
}
