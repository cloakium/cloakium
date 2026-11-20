mod cli;

use std::process::ExitCode;
use std::time::Duration;

use anyhow::{bail, Context, Result};

use cloakium_audit::catalog::{self, CatalogOptions};
use cloakium_audit::compare::{self, CompareOptions};
use cloakium_audit::finalize::{self, FinalizeOptions};
use cloakium_audit::inventory::{self, InventoryBundle, INVENTORY_SCHEMA};
use cloakium_audit::model::{Plan, Seed, Target, PLAN_SCHEMA};
use cloakium_audit::plan::{self, DisplayOptions, PlanOptions};
use cloakium_audit::run::{self, RunOptions};
use cloakium_audit::schema;
use cloakium_audit::storage;
use cloakium_audit::time;
use cloakium_audit::util;
use cloakium_audit::validate::{self, Severity};

use clap::Parser;
use cli::{
    CatalogArgs, Cli, Commands, CompareArgs, FinalizeArgs, InventoryArgs, PlanArgs, RunArgs,
    SchemaArg, SchemaArgs, ValidateArgs,
};

fn main() -> ExitCode {
    match execute() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("cloakium-audit: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn execute() -> Result<ExitCode> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Inventory(args) => inventory_command(args),
        Commands::Plan(args) => plan_command(*args),
        Commands::Validate(args) => validate_command(args),
        Commands::Run(args) => run_command(args),
        Commands::Finalize(args) => finalize_command(args),
        Commands::Compare(args) => compare_command(args),
        Commands::Catalog(args) => catalog_command(args),
        Commands::Schema(args) => schema_command(args),
    }
}

fn inventory_command(args: InventoryArgs) -> Result<ExitCode> {
    let bundle = match (&args.plan, &args.artifact) {
        (Some(path), None) => {
            let plan_path = util::absolute(path)?;
            let plan: Plan = storage::read_json(&plan_path)?;
            let validation = validate::plan(&plan, &plan_path.to_string_lossy());
            if !validation.valid {
                bail!("plan is invalid: {:?}", validation.findings);
            }
            inventory::from_plan(&plan)?
        }
        (None, Some(artifact)) => {
            let artifact = util::absolute(artifact)?.to_string_lossy().into_owned();
            let executable = match &args.launcher {
                Some(path) => util::absolute(path)?.to_string_lossy().into_owned(),
                None => artifact.clone(),
            };
            let target = Target {
                id: args.id,
                label: args
                    .label
                    .unwrap_or_else(|| util::file_name(std::path::Path::new(&artifact))),
                artifact_path: artifact,
                executable_path: executable,
                client_module: args.client_module,
                layer: args.layer.into(),
                identity: args.identity.into(),
                args: args.args,
                headless_args: args.headless_args,
                headed_args: args.headed_args,
            };
            InventoryBundle {
                schema: INVENTORY_SCHEMA.to_string(),
                generated_at: time::now_rfc3339(),
                targets: vec![inventory::inventory_target(&target)?],
            }
        }
        (Some(_), Some(_)) => bail!("choose either --plan or --artifact, not both"),
        (None, None) => bail!("either --plan or --artifact is required"),
    };
    match &args.output {
        Some(path) => {
            let path = util::absolute(path)?;
            storage::write_private_json(&path, &bundle, args.force)?;
            println!(
                "inventory={} targets={}",
                path.display(),
                bundle.targets.len()
            );
        }
        None => storage::print_json(&bundle)?,
    }
    Ok(ExitCode::SUCCESS)
}

fn plan_command(args: PlanArgs) -> Result<ExitCode> {
    let options = PlanOptions {
        baseline: path_string(&args.baseline),
        candidate: path_string(&args.candidate),
        baseline_launcher: args.baseline_launcher.as_deref().map(path_string),
        candidate_launcher: args.candidate_launcher.as_deref().map(path_string),
        client_module: path_string(&args.client_module),
        iterations: args.iterations,
        environment_id: args.environment_id,
        locale: args.locale,
        timezone_id: args.timezone_id,
        fontconfig_file: args.fontconfig_file.as_deref().map(path_string),
        fontconfig_path: args.fontconfig_path.as_deref().map(path_string),
        font_manifest_sha256: args.font_manifest_sha256,
        display: DisplayOptions {
            kind: args.display_kind.into(),
            width: args.width,
            height: args.height,
            depth: args.depth,
            dpi: args.dpi,
            window_manager: args.window_manager,
            display_name: args.display_name,
            xauthority_path: args.xauthority.as_deref().map(path_string),
            ownership_manifest_path: args.ownership_manifest.as_deref().map(path_string),
        },
        notes: args.notes,
        suites: args.suites,
        probe_ids: if args.probes.is_empty() {
            None
        } else {
            Some(args.probes)
        },
        scenario_ids: if args.scenarios.is_empty() {
            None
        } else {
            Some(args.scenarios)
        },
        suite_options: parse_suite_options(&args.suite_options)?,
        probe_config: match &args.probe_config {
            Some(path) => Some(storage::read_json(&util::absolute(path)?)?),
            None => None,
        },
        seed: args.seed.map(Seed::Text),
        baseline_layer: args.baseline_layer.into(),
        candidate_layer: args.candidate_layer.into(),
        baseline_identity: args.baseline_identity.into(),
        candidate_identity: args.candidate_identity.into(),
    };
    let plan = plan::generate(&options)?;
    let validation = validate::plan(&plan, &args.output.to_string_lossy());
    if !validation.valid {
        bail!("generated plan is invalid: {:?}", validation.findings);
    }
    let output = util::absolute(&args.output)?;
    storage::write_private_json(&output, &plan, args.force)?;
    let bytes = storage::read_bytes(&output)?;
    println!(
        "plan={} schema={} sha256={} configurations={} complete={}",
        output.display(),
        PLAN_SCHEMA,
        cloakium_audit::hash::bytes(&bytes),
        plan.configurations.len(),
        validation.complete
    );
    if !validation.complete {
        for reason in &validation.completeness {
            eprintln!("cloakium-audit: incomplete: {reason}");
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn validate_command(args: ValidateArgs) -> Result<ExitCode> {
    let (target, path) = match (&args.plan, &args.report) {
        (Some(path), None) => ("plan", util::absolute(path)?),
        (None, Some(path)) => ("report", util::absolute(path)?),
        _ => bail!("choose either --plan or --report"),
    };
    let validation = if target == "plan" {
        let plan: Plan = storage::read_json(&path)?;
        validate::plan(&plan, &path.to_string_lossy())
    } else {
        let report: cloakium_audit::report::Report = storage::read_json(&path)?;
        validate::report(&report, &path.to_string_lossy())
    };
    storage::print_json(&validation)?;
    if validation
        .findings
        .iter()
        .any(|finding| finding.severity == Severity::Error)
    {
        return Ok(ExitCode::from(1));
    }
    Ok(ExitCode::SUCCESS)
}

fn run_command(args: RunArgs) -> Result<ExitCode> {
    if args.timeout == 0 {
        bail!("--timeout must be at least 1 second");
    }
    let options = RunOptions {
        plan: args.plan,
        node: args.node,
        runner: args.runner,
        output: args.output,
        timeout: Duration::from_secs(args.timeout),
        suite_manifest: args.suite_manifest,
        lock: args.lock,
    };
    let outcome = run::execute(&options)?;
    println!(
        "report={} complete={} runs={} errors={} planHash={}",
        outcome.report_path.display(),
        outcome.complete,
        outcome.run_count,
        outcome.error_count,
        outcome.plan_hash
    );
    Ok(if outcome.complete {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    })
}

fn compare_command(args: CompareArgs) -> Result<ExitCode> {
    let options = CompareOptions {
        baseline: args.baseline,
        candidate: args.candidate,
        policy: args.policy,
        plan: args.plan,
        output: args.output,
        baseline_target: args.baseline_target,
        candidate_target: args.candidate_target,
        force: args.force,
    };
    let (path, report) = compare::execute(&options)?;
    println!(
        "compare={} complete={} features={} differences={} gaps={} causalAttribution={}",
        path.display(),
        report.complete,
        report.summary.features,
        report.summary.differences,
        report.summary.gaps,
        report.causal_attribution
    );
    Ok(ExitCode::SUCCESS)
}

fn catalog_command(args: CatalogArgs) -> Result<ExitCode> {
    let options = CatalogOptions {
        inputs: args.input,
        output: args.output,
        force: args.force,
    };
    let (path, catalog) = catalog::execute(&options)?;
    println!(
        "catalog={} features={} gaps={} unknown={} sources={}",
        path.display(),
        catalog.summary.features,
        catalog.summary.gaps,
        catalog.summary.unknown,
        catalog.summary.sources
    );
    Ok(ExitCode::SUCCESS)
}

fn schema_command(args: SchemaArgs) -> Result<ExitCode> {
    match args.name {
        Some(name) => {
            let name = match name {
                SchemaArg::Plan => "plan",
                SchemaArg::Report => "report",
                SchemaArg::Runner => "runner",
                SchemaArg::Policy => "policy",
                SchemaArg::Compare => "compare",
                SchemaArg::Catalog => "catalog",
                SchemaArg::Inventory => "inventory",
                SchemaArg::Execution => "execution",
            };
            print!("{}", schema::text(name)?);
        }
        None => storage::print_json(&schema::all()?)?,
    }
    Ok(ExitCode::SUCCESS)
}

fn path_string(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

fn parse_suite_options(values: &[String]) -> Result<serde_json::Map<String, serde_json::Value>> {
    let mut result = serde_json::Map::new();
    for item in values {
        let (key, raw) = item
            .split_once('=')
            .with_context(|| format!("--suite-option needs KEY=JSON: {item}"))?;
        if key.trim().is_empty() {
            bail!("--suite-option key cannot be empty");
        }
        let value = serde_json::from_str(raw)
            .unwrap_or_else(|_| serde_json::Value::String(raw.to_string()));
        result.insert(key.to_string(), value);
    }
    Ok(result)
}

fn finalize_command(args: FinalizeArgs) -> Result<ExitCode> {
    let options = FinalizeOptions {
        run_dir: args.run_dir,
        output: args.output,
        reason: args.reason,
    };
    let (path, report) = finalize::execute(&options)?;
    println!(
        "report={} complete={} runs={} errors={} recoveredFrom={}",
        path.display(),
        report.complete,
        report.runs.len(),
        report.errors.len(),
        report
            .postprocessing_recovery
            .as_ref()
            .map(|value| value.original_report_path.as_str())
            .unwrap_or("unknown")
    );
    Ok(ExitCode::SUCCESS)
}
