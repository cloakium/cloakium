#[cfg(not(unix))]
compile_error!("cloakium-launcher is supported on Unix platforms only");

use std::process::ExitCode;

#[cfg(unix)]
fn main() -> ExitCode {
    use std::os::unix::process::CommandExt;

    let Some(real) = std::env::var_os("CLOAKIUM_REAL_CHROMIUM") else {
        eprintln!("cloakium-launcher: CLOAKIUM_REAL_CHROMIUM is not set");
        return ExitCode::from(2);
    };
    std::env::remove_var("CLOAKIUM_REAL_CHROMIUM");

    let args = cloakium_launcher::profile_args(std::env::args_os().skip(1).collect());
    let error = std::process::Command::new(real).args(args).exec();
    eprintln!("cloakium-launcher: failed to exec Chromium: {error}");
    ExitCode::FAILURE
}
