//! `cloakium-audit-display`: owned, dynamically allocated X display for audits.
//!
//! stdout carries exactly one JSON object per command; diagnostics go to stderr
//! and to log files inside the state directory.

mod json;
mod paths;
mod proc;
mod run;
mod selftest;
mod state;
mod x11;

use run::{StartOpts, Wm};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
cloakium-audit-display — owned X display for Cloakium audits

USAGE
  cloakium-audit-display start --state-dir DIR [options]
  cloakium-audit-display status --state-dir DIR
  cloakium-audit-display stop   --state-dir DIR
  cloakium-audit-display selftest --state-dir DIR

START OPTIONS (defaults in brackets)
  --width N            screen width            [1920]
  --height N           screen height           [1080]
  --depth N            colour depth            [24]
  --dpi N              server dots per inch    [96]
  --window-manager M   none | openbox          [openbox]

BEHAVIOUR
  * the display number is chosen by the server via -displayfd, never assumed
  * the cookie is written 0600 before the server starts and an unauthenticated
    client is verified to be refused
  * readiness is -displayfd + xdpyinfo + window-manager confirmation, all
    bounded; there are no startup sleeps
  * the state directory must be absolute, owned by the caller and mode 0700
  * `start` prints one JSON manifest; `stop` only signals processes whose pid,
    start ticks and executable all match the manifest

ENVIRONMENT
  CLOAKIUM_AUDIT_XVFB / _OPENBOX / _XPROP / _XDPIINFO select the tools; the Nix
  wrapper sets them. Without it they are looked up on PATH.
";

fn usage_error(message: &str) -> ExitCode {
    eprintln!("error: {}", message);
    eprintln!();
    eprintln!("{}", USAGE);
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "--help" || args[0] == "-h" {
        eprint!("{}", USAGE);
        return ExitCode::SUCCESS;
    }
    let command = args[0].clone();
    let mut state_dir: Option<PathBuf> = None;
    let mut width = 1920u32;
    let mut height = 1080u32;
    let mut depth = 24u32;
    let mut dpi = 96u32;
    let mut wm = Wm::Openbox;

    let mut i = 1;
    while i < args.len() {
        let flag = args[i].as_str();
        let value = match flag {
            "--state-dir" | "--width" | "--height" | "--depth" | "--dpi" | "--window-manager" => {
                match args.get(i + 1) {
                    Some(v) => v.clone(),
                    None => return usage_error(&format!("{} needs a value", flag)),
                }
            }
            other => return usage_error(&format!("unknown argument '{}'", other)),
        };
        i += 2;
        match flag {
            "--state-dir" => state_dir = Some(PathBuf::from(value)),
            "--width" => match parse_num("width", &value) {
                Ok(v) => width = v,
                Err(e) => return usage_error(&e),
            },
            "--height" => match parse_num("height", &value) {
                Ok(v) => height = v,
                Err(e) => return usage_error(&e),
            },
            "--depth" => match parse_num("depth", &value) {
                Ok(v) => depth = v,
                Err(e) => return usage_error(&e),
            },
            "--dpi" => match parse_num("dpi", &value) {
                Ok(v) => dpi = v,
                Err(e) => return usage_error(&e),
            },
            "--window-manager" => match Wm::parse(&value) {
                Ok(w) => wm = w,
                Err(e) => return usage_error(&e),
            },
            _ => unreachable!(),
        }
    }

    let Some(state_dir) = state_dir else {
        return usage_error("--state-dir is required");
    };

    let result = match command.as_str() {
        "start" => run::start(&StartOpts {
            state_dir,
            width,
            height,
            depth,
            dpi,
            window_manager: wm,
        }),
        "status" => run::status(&state_dir),
        "stop" => run::stop(&state_dir),
        "selftest" => selftest::run_selftest(&state_dir),
        other => return usage_error(&format!("unknown command '{}'", other)),
    };

    match result {
        Ok(json) => {
            println!("{}", json);
            if json.contains("\"ok\":false") {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(message) => {
            eprintln!("error: {}", message);
            let mut out = String::from("{");
            json::str_field(&mut out, "schema", state::SCHEMA, true);
            json::bool_field(&mut out, "ok", false, true);
            json::str_field(&mut out, "error", &message, false);
            out.push('}');
            println!("{}", out);
            ExitCode::from(1)
        }
    }
}

fn parse_num(name: &str, raw: &str) -> Result<u32, String> {
    match raw.parse::<u32>() {
        Ok(v) if v > 0 => Ok(v),
        Ok(_) => Err(format!("{} must be greater than zero", name)),
        Err(_) => Err(format!("{} is not a number: {}", name, raw)),
    }
}
