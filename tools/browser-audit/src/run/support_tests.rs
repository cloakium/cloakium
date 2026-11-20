use super::support::*;
mod tests {
    use super::*;
    use crate::model::{DisplayKind, DisplaySpec, EnvironmentSpec, Identity, Layer, Target};

    #[test]
    fn child_environment_is_a_fixed_allowlist() {
        let directory = tempfile::tempdir().expect("tempdir");
        let environment = EnvironmentSpec {
            id: "test".to_string(),
            locale: "en-US".to_string(),
            timezone_id: "UTC".to_string(),
            fontconfig_file: None,
            fontconfig_path: None,
            font_manifest_sha256: None,
            display: DisplaySpec {
                kind: DisplayKind::Managed,
                width: 1280,
                height: 800,
                depth: 24,
                dpi: 96,
                window_manager: "none".to_string(),
                display_name: Some(":99".to_string()),
                xauthority_path: Some("/private/Xauthority".to_string()),
                ownership_manifest_path: None,
            },
            notes: None,
        };
        let target = Target {
            id: "subject".to_string(),
            label: "Subject".to_string(),
            artifact_path: "/opt/artifact".to_string(),
            executable_path: "/opt/launcher".to_string(),
            client_module: "/opt/client/index.js".to_string(),
            layer: Layer::Engine,
            identity: Identity::Native,
            args: Vec::new(),
            headless_args: Vec::new(),
            headed_args: Vec::new(),
        };
        let plan = crate::model::Plan {
            schema: crate::model::PLAN_SCHEMA.to_string(),
            id: "plan-test".to_string(),
            environment,
            targets: vec![target],
            configurations: Vec::new(),
        };
        let runtime = RuntimeEnv {
            h3_bin: None,
            display_bin: None,
            fc_list_bin: None,
            openssl_bin: None,
        };
        let env = minimal_env(&plan, directory.path(), &runtime, Some(&"a".repeat(64)));
        for forbidden in [
            "DISPLAY",
            "XAUTHORITY",
            "DBUS_SESSION_BUS_ADDRESS",
            "LD_PRELOAD",
            "DYLD_LIBRARY_PATH",
            "RUST_BACKTRACE",
        ] {
            assert!(!env.contains_key(forbidden), "unexpected {forbidden}");
        }
        assert_eq!(env.get("LANG").map(String::as_str), Some("C.UTF-8"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("C.UTF-8"));
        assert_eq!(
            env.get("CLOAKIUM_AUDIT_SEAT_RUST").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            env.get("CLOAKIUM_AUDIT_SUITE_MANIFEST_SHA256")
                .map(String::as_str),
            Some("a".repeat(64).as_str())
        );
    }
}
