use std::ffi::OsString;

use cloakium_launcher::{profile_args, BLINK_SETTINGS_ARG, SCREEN_INFO_ARG};

mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    fn profile(values: &[&str]) -> Vec<String> {
        profile_args(args(values))
            .into_iter()
            .map(|value| value.into_string().unwrap())
            .collect()
    }

    fn original_suffix<'a>(profiled: &'a [String], original: &[&str]) -> &'a [String] {
        &profiled[profiled.len() - original.len()..]
    }

    #[test]
    fn empty_args_are_unchanged() {
        assert!(profile(&[]).is_empty());
    }

    #[test]
    fn headed_args_are_unchanged() {
        assert_eq!(
            profile(&["--no-sandbox", "https://example.test"]),
            ["--no-sandbox", "https://example.test"]
        );
    }

    #[test]
    fn headless_without_fingerprint_is_unchanged() {
        assert_eq!(
            profile(&["--headless", "--no-sandbox"]),
            ["--headless", "--no-sandbox"]
        );
    }

    #[test]
    fn fingerprint_without_headless_is_unchanged() {
        assert_eq!(
            profile(&["--fingerprint=seed", "--no-sandbox"]),
            ["--fingerprint=seed", "--no-sandbox"]
        );
    }

    #[test]
    fn hardware_concurrency_alone_is_not_fingerprint_mode() {
        assert_eq!(
            profile(&["--headless", "--fingerprint-hardware-concurrency=8"]),
            ["--headless", "--fingerprint-hardware-concurrency=8"]
        );
    }

    #[test]
    fn headless_and_fingerprint_prepend_screen_then_blink() {
        assert_eq!(
            profile(&["--headless", "--fingerprint=seed", "--no-sandbox"]),
            [
                SCREEN_INFO_ARG,
                BLINK_SETTINGS_ARG,
                "--headless",
                "--fingerprint=seed",
                "--no-sandbox"
            ]
        );
    }

    #[test]
    fn equals_form_activates_fingerprint_mode() {
        assert_eq!(
            profile(&["--headless=new", "--fingerprint=seed"]),
            [
                SCREEN_INFO_ARG,
                BLINK_SETTINGS_ARG,
                "--headless=new",
                "--fingerprint=seed"
            ]
        );
    }

    #[test]
    fn empty_equals_values_still_activate() {
        assert_eq!(
            profile(&["--headless=", "--fingerprint="]),
            [
                SCREEN_INFO_ARG,
                BLINK_SETTINGS_ARG,
                "--headless=",
                "--fingerprint="
            ]
        );
    }

    #[test]
    fn explicit_screen_info_suppresses_only_screen() {
        assert_eq!(
            profile(&[
                "--headless",
                "--fingerprint=seed",
                "--screen-info={1280x720}"
            ]),
            [
                BLINK_SETTINGS_ARG,
                "--headless",
                "--fingerprint=seed",
                "--screen-info={1280x720}"
            ]
        );
    }

    #[test]
    fn bare_screen_info_suppresses_screen() {
        assert_eq!(
            profile(&["--headless", "--fingerprint=seed", "--screen-info"]),
            [
                BLINK_SETTINGS_ARG,
                "--headless",
                "--fingerprint=seed",
                "--screen-info"
            ]
        );
    }

    #[test]
    fn ozone_override_suppresses_screen() {
        assert_eq!(
            profile(&[
                "--headless",
                "--fingerprint=seed",
                "--ozone-override-screen-size=1024,768"
            ]),
            [
                BLINK_SETTINGS_ARG,
                "--headless",
                "--fingerprint=seed",
                "--ozone-override-screen-size=1024,768"
            ]
        );
    }

    #[test]
    fn bare_ozone_override_suppresses_screen() {
        assert_eq!(
            profile(&[
                "--headless",
                "--fingerprint=seed",
                "--ozone-override-screen-size"
            ]),
            [
                BLINK_SETTINGS_ARG,
                "--headless",
                "--fingerprint=seed",
                "--ozone-override-screen-size"
            ]
        );
    }

    #[test]
    fn forced_scale_factor_suppresses_screen() {
        assert_eq!(
            profile(&[
                "--headless",
                "--fingerprint=seed",
                "--force-device-scale-factor=1.25"
            ]),
            [
                BLINK_SETTINGS_ARG,
                "--headless",
                "--fingerprint=seed",
                "--force-device-scale-factor=1.25"
            ]
        );
    }

    #[test]
    fn bare_forced_scale_factor_suppresses_screen() {
        assert_eq!(
            profile(&[
                "--headless",
                "--fingerprint=seed",
                "--force-device-scale-factor"
            ]),
            [
                BLINK_SETTINGS_ARG,
                "--headless",
                "--fingerprint=seed",
                "--force-device-scale-factor"
            ]
        );
    }

    #[test]
    fn explicit_blink_settings_suppresses_only_pointer_default() {
        assert_eq!(
            profile(&[
                "--headless",
                "--fingerprint=seed",
                "--blink-settings=primaryHoverType=1,availableHoverTypes=1"
            ]),
            [
                SCREEN_INFO_ARG,
                "--headless",
                "--fingerprint=seed",
                "--blink-settings=primaryHoverType=1,availableHoverTypes=1"
            ]
        );
    }

    #[test]
    fn bare_blink_settings_suppresses_pointer_default() {
        assert_eq!(
            profile(&["--headless", "--fingerprint=seed", "--blink-settings"]),
            [
                SCREEN_INFO_ARG,
                "--headless",
                "--fingerprint=seed",
                "--blink-settings"
            ]
        );
    }

    #[test]
    fn both_explicit_switches_leave_args_unchanged() {
        assert_eq!(
            profile(&[
                "--headless",
                "--fingerprint=seed",
                "--screen-info={1280x720}",
                "--blink-settings=primaryHoverType=1"
            ]),
            [
                "--headless",
                "--fingerprint=seed",
                "--screen-info={1280x720}",
                "--blink-settings=primaryHoverType=1"
            ]
        );
    }

    #[test]
    fn explicit_screen_after_delimiter_does_not_suppress() {
        assert_eq!(
            profile(&[
                "--headless",
                "--fingerprint=seed",
                "--",
                "--screen-info={1280x720}"
            ]),
            [
                SCREEN_INFO_ARG,
                BLINK_SETTINGS_ARG,
                "--headless",
                "--fingerprint=seed",
                "--",
                "--screen-info={1280x720}"
            ]
        );
    }

    #[test]
    fn explicit_blink_after_delimiter_does_not_suppress() {
        assert_eq!(
            profile(&[
                "--headless",
                "--fingerprint=seed",
                "--",
                "--blink-settings=primaryHoverType=1"
            ]),
            [
                SCREEN_INFO_ARG,
                BLINK_SETTINGS_ARG,
                "--headless",
                "--fingerprint=seed",
                "--",
                "--blink-settings=primaryHoverType=1"
            ]
        );
    }

    #[test]
    fn headless_after_delimiter_does_not_activate() {
        assert_eq!(
            profile(&["--fingerprint=seed", "--", "--headless"]),
            ["--fingerprint=seed", "--", "--headless"]
        );
    }

    #[test]
    fn fingerprint_after_delimiter_does_not_activate() {
        assert_eq!(
            profile(&["--headless", "--", "--fingerprint=seed"]),
            ["--headless", "--", "--fingerprint=seed"]
        );
    }

    #[test]
    fn leading_delimiter_deactivates() {
        assert_eq!(
            profile(&["--", "--headless", "--fingerprint=seed"]),
            ["--", "--headless", "--fingerprint=seed"]
        );
    }

    #[test]
    fn caller_window_size_is_never_rewritten() {
        let original = [
            "--headless",
            "--fingerprint=seed",
            "--window-size=3840,2160",
        ];
        let profiled = profile(&original);
        assert_eq!(profiled.len(), original.len() + 2);
        assert_eq!(&profiled[2..], &original);
    }

    #[test]
    fn caller_credentials_and_file_urls_are_preserved() {
        let original = [
            "--headless",
            "--fingerprint=seed",
            "--proxy-server=http://user:pass@127.0.0.1:8080",
            "--",
            "file:///tmp/a%20b.html",
        ];
        let profiled = profile(&original);
        assert_eq!(original_suffix(&profiled, &original), &original);
    }

    #[test]
    fn order_is_preserved_exactly() {
        let original = [
            "--headless",
            "--fingerprint=seed",
            "--no-sandbox",
            "--use-gl=angle",
            "--proxy-server=http://127.0.0.1:9000",
        ];
        let profiled = profile(&original);
        assert_eq!(profiled.len(), original.len() + 2);
        assert_eq!(&profiled[2..], &original);
    }

    #[test]
    fn profiling_is_idempotent() {
        let once = profile_args(args(&["--headless", "--fingerprint=seed"]));
        let twice = profile_args(once.clone());
        assert_eq!(once, twice);
    }

    #[test]
    fn lookalike_switches_do_not_activate() {
        assert_eq!(
            profile(&["--headless-foo", "--fingerprint-foo"]),
            ["--headless-foo", "--fingerprint-foo"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_arguments_are_preserved_byte_for_byte() {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};

        let original = vec![
            OsString::from("--headless"),
            OsString::from("--fingerprint=seed"),
            OsString::from_vec(vec![b'f', b'i', 0xff, b'l', b'e']),
        ];
        let profiled = profile_args(original.clone());

        assert_eq!(profiled.len(), original.len() + 2);
        assert_eq!(profiled[0], OsString::from(SCREEN_INFO_ARG));
        assert_eq!(profiled[1], OsString::from(BLINK_SETTINGS_ARG));
        for (actual, expected) in profiled[2..].iter().zip(original.iter()) {
            assert_eq!(actual.as_bytes(), expected.as_bytes());
        }
    }
}
