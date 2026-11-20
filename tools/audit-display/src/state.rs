//! Owned state directory and manifest. Every write is exclusive or replaces a
//! regular file we own; symlinks are refused, never followed. The socket is
//! never unlinked here: the server owns it.

use crate::json::{bool_field, num_field, str_field, Json};
use crate::paths;
use std::fs::{self, File};
use std::io::Write;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const SCHEMA: &str = "cloakium.audit.display/1";
pub const MANIFEST_NAME: &str = "display.json";
pub const AUTH_NAME: &str = "Xauthority";

const MANIFEST_KEYS: [&str; 13] = [
    "schema",
    "display",
    "xauthorityPath",
    "xvfbPid",
    "xvfbStartTicks",
    "wmPid",
    "wmStartTicks",
    "screen",
    "windowManager",
    "authEnforced",
    "owned",
    "socketDev",
    "socketIno",
];

const SCREEN_KEYS: [&str; 4] = ["width", "height", "depth", "dpi"];

#[derive(Debug, Clone, PartialEq)]
pub struct Screen {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub dpi: u32,
}

impl Screen {
    pub fn geometry(&self) -> String {
        format!("{}x{}x{}", self.width, self.height, self.depth)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub display: String,
    pub xauthority_path: PathBuf,
    pub xvfb_pid: u32,
    pub xvfb_start_ticks: u64,
    pub wm_pid: u32,
    pub wm_start_ticks: u64,
    pub screen: Screen,
    pub window_manager: String,
    pub auth_enforced: bool,
    /// Socket identity captured when the manifest was written; used only to
    /// report whether the endpoint is still the one we created.
    pub socket_dev: Option<u64>,
    pub socket_ino: Option<u64>,
}

pub fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_NAME)
}

pub fn auth_path(root: &Path) -> PathBuf {
    root.join(AUTH_NAME)
}

pub use crate::paths::euid;

pub fn ensure_dir(root: &Path) -> Result<(), String> {
    paths::ensure_dir(root)
}

pub fn private_dir(p: &Path) -> Result<(), String> {
    paths::private_dir(p)
}

pub fn write_manifest(root: &Path, m: &Manifest) -> Result<(), String> {
    let final_path = manifest_path(root);
    match fs::symlink_metadata(&final_path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!(
                "refusing to write through a symlinked manifest: {}",
                final_path.display()
            ))
        }
        Ok(_) => {
            return Err(format!(
                "refusing to overwrite an existing manifest: {}",
                final_path.display()
            ))
        }
        Err(_) => {}
    }
    let tmp = root.join(format!(
        ".{}.{}.{}.tmp",
        MANIFEST_NAME,
        std::process::id(),
        paths::nonce()
    ));
    let mut f = paths::open_exclusive(&tmp)?;
    let written = f
        .write_all(m.to_json().as_bytes())
        .and_then(|_| f.sync_all());
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {}", tmp.display(), e));
    }
    drop(f);
    fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {}", final_path.display(), e)
    })?;
    let meta = fs::symlink_metadata(&final_path)
        .map_err(|e| format!("{}: {}", final_path.display(), e))?;
    if meta.file_type().is_symlink() || !meta.is_file() || !paths::is_ours(&meta) {
        return Err(format!(
            "manifest did not land as our regular file: {}",
            final_path.display()
        ));
    }
    Ok(())
}

pub fn read_manifest(root: &Path) -> Result<Manifest, String> {
    let path = manifest_path(root);
    let meta = fs::symlink_metadata(&path)
        .map_err(|_| format!("no display manifest at {}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("manifest is a symlink: {}", path.display()));
    }
    if !meta.is_file() {
        return Err(format!(
            "manifest is not a regular file: {}",
            path.display()
        ));
    }
    let mode = meta.permissions().mode() & 0o777;
    if mode != 0o600 {
        return Err(format!("manifest mode is {:04o}, expected 0600", mode));
    }
    if !paths::is_ours(&meta) {
        return Err("manifest is not owned by this uid".into());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {}", path.display(), e))?;
    let json = Json::parse(&text)?;
    Manifest::from_json(root, &json)
}

fn display_is_valid(s: &str) -> bool {
    let rest = match s.strip_prefix(':') {
        Some(r) => r,
        None => return false,
    };
    !rest.is_empty() && rest.len() <= 4 && rest.bytes().all(|b| b.is_ascii_digit())
}

impl Manifest {
    pub fn to_json(&self) -> String {
        let mut out = String::from("{");
        str_field(&mut out, "schema", SCHEMA, true);
        str_field(&mut out, "display", &self.display, true);
        str_field(
            &mut out,
            "xauthorityPath",
            &self.xauthority_path.display().to_string(),
            true,
        );
        num_field(&mut out, "xvfbPid", self.xvfb_pid as i64, true);
        num_field(
            &mut out,
            "xvfbStartTicks",
            self.xvfb_start_ticks as i64,
            true,
        );
        num_field(&mut out, "wmPid", self.wm_pid as i64, true);
        num_field(&mut out, "wmStartTicks", self.wm_start_ticks as i64, true);
        out.push_str("\"screen\":{");
        num_field(&mut out, "width", self.screen.width as i64, true);
        num_field(&mut out, "height", self.screen.height as i64, true);
        num_field(&mut out, "depth", self.screen.depth as i64, true);
        num_field(&mut out, "dpi", self.screen.dpi as i64, false);
        out.push_str("},");
        str_field(&mut out, "windowManager", &self.window_manager, true);
        bool_field(&mut out, "authEnforced", self.auth_enforced, true);
        bool_field(&mut out, "owned", true, false);
        if let Some(dev) = self.socket_dev {
            out.push(',');
            num_field(&mut out, "socketDev", dev as i64, false);
        }
        if let Some(ino) = self.socket_ino {
            out.push(',');
            num_field(&mut out, "socketIno", ino as i64, false);
        }
        out.push('}');
        out
    }

    /// Strict reader: unknown fields are refused so a manifest cannot smuggle
    /// extra semantics past the consumer.
    pub fn from_json(root: &Path, j: &Json) -> Result<Manifest, String> {
        if let Json::Obj(pairs) = j {
            for (key, _) in pairs {
                if !MANIFEST_KEYS.contains(&key.as_str()) {
                    return Err(format!("manifest: unknown field '{}'", key));
                }
            }
        } else {
            return Err("manifest: not an object".into());
        }
        let schema = j
            .get("schema")
            .and_then(Json::as_str)
            .ok_or("manifest: missing schema")?;
        if schema != SCHEMA {
            return Err(format!("manifest: unsupported schema '{}'", schema));
        }
        let owned = j
            .get("owned")
            .and_then(Json::as_bool)
            .ok_or("manifest: missing owned flag")?;
        if !owned {
            return Err("manifest: not marked owned".into());
        }
        let auth_enforced = j
            .get("authEnforced")
            .and_then(Json::as_bool)
            .ok_or("manifest: missing authEnforced")?;
        if !auth_enforced {
            return Err("manifest: auth was not enforced".into());
        }
        let display = j
            .get("display")
            .and_then(Json::as_str)
            .ok_or("manifest: missing display")?
            .to_string();
        if !display_is_valid(&display) {
            return Err(format!("manifest: display '{}' is not :N", display));
        }
        let auth = j
            .get("xauthorityPath")
            .and_then(Json::as_str)
            .ok_or("manifest: missing xauthorityPath")?;
        let auth_file = PathBuf::from(auth);
        let expected = auth_path(root);
        if auth_file != expected {
            return Err(format!(
                "manifest: xauthorityPath {} is not {}",
                auth_file.display(),
                expected.display()
            ));
        }
        let screen = j.get("screen").ok_or("manifest: missing screen")?;
        if let Json::Obj(pairs) = screen {
            for (key, _) in pairs {
                if !SCREEN_KEYS.contains(&key.as_str()) {
                    return Err(format!("manifest: unknown screen field '{}'", key));
                }
            }
        }
        let numeric = |key: &str| -> Result<u32, String> {
            screen
                .get(key)
                .and_then(Json::as_u32)
                .ok_or_else(|| format!("manifest: screen.{} missing or not a number", key))
        };
        let screen = Screen {
            width: numeric("width")?,
            height: numeric("height")?,
            depth: numeric("depth")?,
            dpi: numeric("dpi")?,
        };
        if screen.width == 0 || screen.height == 0 || screen.depth == 0 || screen.dpi == 0 {
            return Err("manifest: screen values must be non-zero".into());
        }
        let window_manager = j
            .get("windowManager")
            .and_then(Json::as_str)
            .ok_or("manifest: missing windowManager")?
            .to_string();
        if window_manager != "none" && window_manager != "openbox" {
            return Err(format!(
                "manifest: unknown windowManager '{}'",
                window_manager
            ));
        }
        let pid = |key: &str| -> Result<u32, String> {
            j.get(key)
                .and_then(Json::as_u32)
                .ok_or_else(|| format!("manifest: {} missing or not a number", key))
        };
        let ticks = |key: &str| -> Result<u64, String> {
            j.get(key)
                .and_then(Json::as_i64)
                .filter(|v| *v >= 0)
                .map(|v| v as u64)
                .ok_or_else(|| format!("manifest: {} missing or not a number", key))
        };
        let opt_u64 = |key: &str| -> Option<u64> {
            j.get(key)
                .and_then(Json::as_i64)
                .filter(|v| *v >= 0)
                .map(|v| v as u64)
        };
        Ok(Manifest {
            display,
            xauthority_path: auth_file,
            xvfb_pid: pid("xvfbPid")?,
            xvfb_start_ticks: ticks("xvfbStartTicks")?,
            wm_pid: pid("wmPid")?,
            wm_start_ticks: ticks("wmStartTicks")?,
            screen,
            window_manager,
            auth_enforced,
            socket_dev: opt_u64("socketDev"),
            socket_ino: opt_u64("socketIno"),
        })
    }
}

pub fn ensure_reusable(root: &Path) -> Result<Option<Manifest>, String> {
    if !manifest_path(root).exists() {
        return Ok(None);
    }
    read_manifest(root).map(Some)
}

pub fn auth_file_ok(path: &Path) -> Result<(), String> {
    let meta =
        fs::symlink_metadata(path).map_err(|_| format!("no auth file at {}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("auth file is a symlink: {}", path.display()));
    }
    if !meta.is_file() {
        return Err(format!(
            "auth file is not a regular file: {}",
            path.display()
        ));
    }
    if meta.permissions().mode() & 0o777 != 0o600 {
        return Err("auth file mode is not 0600".into());
    }
    if !paths::is_ours(&meta) {
        return Err("auth file is not owned by this uid".into());
    }
    Ok(())
}

/// Write a fresh cookie file. An existing path is never truncated: our own
/// stale file is removed first, anything else (symlink, foreign file) refuses.
pub fn write_auth(path: &Path) -> Result<(), String> {
    paths::clear_stale(path)?;
    let mut cookie = [0u8; 16];
    {
        use std::io::Read;
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut cookie))
            .map_err(|e| format!("/dev/urandom: {}", e))?;
    }
    let name = b"MIT-MAGIC-COOKIE-1";
    let mut record: Vec<u8> = Vec::with_capacity(44);
    record.extend_from_slice(&[0xff, 0xff, 0, 0, 0, 0]);
    record.extend_from_slice(&(name.len() as u16).to_be_bytes());
    record.extend_from_slice(name);
    record.extend_from_slice(&16u16.to_be_bytes());
    record.extend_from_slice(&cookie);
    let mut f = paths::open_exclusive(path)?;
    f.write_all(&record).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    auth_file_ok(path)
}

/// Socket identity (device, inode) for the display's protocol path.
pub fn socket_identity(path: &Path) -> Option<(u64, u64)> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|m| m.file_type().is_socket())
        .map(|m| (m.dev(), m.ino()))
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
