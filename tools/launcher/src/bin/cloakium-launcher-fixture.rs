//! Test-only exec fixture. Not installed by the launcher package.

#[cfg(unix)]
fn main() {
    use std::io::{Read, Write};
    use std::os::unix::io::FromRawFd;

    let mut stdout = std::io::stdout();
    for arg in std::env::args_os().skip(1) {
        writeln!(stdout, "ARG:{}", arg.to_string_lossy()).unwrap();
    }
    writeln!(
        stdout,
        "ENV:{}",
        std::env::var_os("CLOAKIUM_REAL_CHROMIUM").is_some()
    )
    .unwrap();

    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    writeln!(stdout, "STDIN:{input}").unwrap();

    for fd in [3, 4] {
        // These descriptors are provided by the exec-preservation test.
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let _ = writeln!(file, "FD{fd}");
        std::mem::forget(file);
    }

    stdout.flush().unwrap();
    std::process::exit(42);
}

#[cfg(not(unix))]
fn main() {}
