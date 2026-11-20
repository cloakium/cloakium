//! Command-line shaping for Cloakium's default headless desktop profile.
//!
//! `profile_args` only acts when the caller explicitly requested headless
//! fingerprint mode: both switches must appear before any `--` delimiter. It
//! only prepends upstream Chromium flags and never rewrites caller arguments.

use std::ffi::{OsStr, OsString};

/// Standard desktop virtual screen used when the caller configured none.
pub const SCREEN_INFO_ARG: &str = "--screen-info={1920x1080}";

/// Desktop pointer/hover capabilities used when the caller configured none.
pub const BLINK_SETTINGS_ARG: &str =
    "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4";

fn matches_switch(arg: &OsStr, name: &str) -> bool {
    let bytes = arg.as_encoded_bytes();
    let name = name.as_bytes();
    bytes == name
        || (bytes.len() > name.len() && bytes.starts_with(name) && bytes[name.len()] == b'=')
}

fn has_switch(args: &[OsString], name: &str) -> bool {
    args.iter().any(|arg| matches_switch(arg, name))
}

/// Prepends the headless desktop defaults that the caller did not configure.
///
/// Guards are evaluated only before the first literal `--`; arguments after it
/// are treated as opaque payload. Explicit `--screen-info`,
/// `--ozone-override-screen-size` and `--force-device-scale-factor` suppress
/// the screen default. An explicit `--blink-settings` independently suppresses
/// the pointer default. Caller window sizes are never inspected or changed.
pub fn profile_args(args: Vec<OsString>) -> Vec<OsString> {
    let delimiter = args
        .iter()
        .position(|arg| arg.as_os_str() == OsStr::new("--"))
        .unwrap_or(args.len());
    let switches = &args[..delimiter];

    if !has_switch(switches, "--headless") || !has_switch(switches, "--fingerprint") {
        return args;
    }

    let explicit_screen = has_switch(switches, "--screen-info")
        || has_switch(switches, "--ozone-override-screen-size")
        || has_switch(switches, "--force-device-scale-factor");
    let explicit_blink = has_switch(switches, "--blink-settings");

    let mut result = Vec::with_capacity(args.len() + 2);
    if !explicit_screen {
        result.push(OsString::from(SCREEN_INFO_ARG));
    }
    if !explicit_blink {
        result.push(OsString::from(BLINK_SETTINGS_ARG));
    }
    if result.is_empty() {
        return args;
    }
    result.extend(args);
    result
}
