//! Retry, pacing and proof behaviour of `cloakium-maintain upload-release`.

mod support;

use std::time::Duration;

use cloakium_maintain::upload_release::MAX_ASSET_ATTEMPTS;
use support::upload::Harness;

fn message<T: std::fmt::Debug>(result: anyhow::Result<T>) -> String {
    format!("{:#}", result.expect_err("the command must fail"))
}

fn first_missing(harness: &Harness) -> String {
    harness
        .missing()
        .into_iter()
        .next()
        .expect("an asset is still missing")
}

#[test]
fn a_landed_transport_failure_on_a_later_page_is_not_uploaded_twice() {
    let mut harness = Harness::new();
    let name = "playwright-core-1.65.0.tgz".to_string();
    harness.complete_all_except(&[name.as_str()]);
    harness.fail_next("gh: HTTP 502: Bad Gateway", true);
    harness.run().expect("upload");

    assert_eq!(
        harness.uploads(),
        vec![name.clone()],
        "the landed upload is recognised on a later page and never re-posted"
    );
    assert!(harness.deletes().is_empty());
    assert!(
        harness.sleeps().is_empty(),
        "a transient failure is rechecked immediately, without a rate-limit wait"
    );
    assert!(
        harness.last_page_count() > 1,
        "the recheck must read every page, not only the first"
    );
    assert!(
        harness
            .remote
            .borrow()
            .assets
            .iter()
            .any(|asset| { asset.name == name && asset.id >= 100 }),
        "the recognised asset has an id beyond the first page"
    );
}

#[test]
fn an_absent_asset_after_a_transport_failure_is_retried() {
    let mut harness = Harness::new();
    let name = first_missing(&harness);
    harness.complete_all_except(&[name.as_str()]);
    harness.fail_next("gh: HTTP 502: Bad Gateway", false);
    harness.run().expect("upload");
    assert_eq!(harness.uploads(), vec![name.clone(), name]);
}

#[test]
fn a_bad_gateway_starter_asset_is_removed_before_the_retry() {
    let mut harness = Harness::new();
    let name = first_missing(&harness);
    harness.complete_all_except(&[name.as_str()]);
    harness.fail_next_with_starter("gh: HTTP 502: Bad Gateway");
    harness.run().expect("upload");

    assert_eq!(harness.uploads(), vec![name.clone(), name.clone()]);
    assert_eq!(
        harness.deletes().len(),
        1,
        "the empty starter asset is deleted before the retry"
    );
}

#[test]
fn a_rate_limit_is_waited_out_before_any_further_request() {
    let mut harness = Harness::new();
    let name = first_missing(&harness);
    harness.complete_all_except(&[name.as_str()]);
    harness.fail_next_corrupt(
        "gh: HTTP 403: You have exceeded a secondary rate limit. \
         Please wait a few minutes before you try again.",
    );
    harness.run().expect("upload");

    let timeline = harness.timeline();
    let index = timeline
        .iter()
        .position(|(command, _)| command.starts_with("gh release upload"))
        .expect("the rate-limited upload is in the timeline");
    let failed_at = timeline[index].1;
    let (next_command, next_at) = timeline
        .get(index + 1)
        .expect("a request follows the failure");
    assert!(
        *next_at >= failed_at + Duration::from_secs(60),
        "the next request must wait at least a minute: {next_command} at {next_at:?}"
    );
    assert!(
        next_command.starts_with("gh api --paginate"),
        "only a read may follow the wait: {next_command}"
    );
    for (command, at) in &timeline {
        if command.contains("--method DELETE") {
            assert!(
                *at >= failed_at + Duration::from_secs(60),
                "no delete may precede the wait: {command} at {at:?}"
            );
        }
    }
    assert_eq!(harness.deletes().len(), 1, "the corrupt asset is replaced");
    assert_eq!(harness.uploads(), vec![name.clone(), name]);
    assert!(harness.sleeps().contains(&Duration::from_secs(60)));
}

#[test]
fn a_rate_limit_without_attempts_left_does_not_requery() {
    let mut harness = Harness::new();
    let name = first_missing(&harness);
    harness.complete_all_except(&[name.as_str()]);
    for _ in 0..MAX_ASSET_ATTEMPTS + 1 {
        harness.fail_next(
            "gh: HTTP 403: You have exceeded a secondary rate limit.",
            false,
        );
    }
    let text = message(harness.run());
    assert!(text.contains("attempts"), "{text}");
    assert_eq!(harness.uploads().len(), MAX_ASSET_ATTEMPTS);
    assert_eq!(
        harness.sleeps(),
        vec![
            Duration::from_secs(60),
            Duration::from_secs(120),
            Duration::from_secs(240)
        ],
        "the last failure gives up instead of waiting again"
    );
    let timeline = harness.timeline();
    let last = timeline.last().expect("commands ran");
    assert!(
        last.0.starts_with("gh release upload"),
        "no request may follow the final failed attempt: {}",
        last.0
    );
}

#[test]
fn a_permission_error_is_not_retried() {
    let mut harness = Harness::new();
    let name = first_missing(&harness);
    harness.complete_all_except(&[name.as_str()]);
    harness.fail_next(
        "gh: HTTP 403: Resource not accessible by integration",
        false,
    );
    let text = message(harness.run());
    assert!(text.contains("refusing to retry"), "{text}");
    assert_eq!(
        harness.uploads(),
        vec![name],
        "a permission failure must not be repeated"
    );
}

#[test]
fn repeated_transport_failures_stop_at_the_attempt_ceiling() {
    let mut harness = Harness::new();
    let name = first_missing(&harness);
    harness.complete_all_except(&[name.as_str()]);
    for _ in 0..10 {
        harness.fail_next("gh: HTTP 503: Service Unavailable", false);
    }
    let text = message(harness.run());
    assert!(text.contains("attempts"), "{text}");
    assert_eq!(harness.uploads().len(), MAX_ASSET_ATTEMPTS);
}

#[test]
fn a_wrong_server_digest_fails_the_final_proof() {
    let mut harness = Harness::new();
    harness.report_wrong_digest("aaa.nar.xz", &"d".repeat(64));
    let text = message(harness.run());
    assert!(
        text.contains("does not match SHA256SUMS"),
        "the final REST proof must reject a wrong digest: {text}"
    );
}

#[test]
fn an_asset_lost_after_upload_fails_the_final_proof() {
    let mut harness = Harness::new();
    let name = "aaa.nar.xz";
    harness.complete_all_except(&[name]);
    harness.drop_after_upload(name);
    let text = message(harness.run());
    assert!(text.contains("does not have"), "{text}");
}

#[test]
fn the_whole_run_respects_one_wall_deadline() {
    let mut harness = Harness::new();
    let options = harness
        .fixture
        .options_with_timeout(Duration::from_secs(24));
    let text = message(harness.run_with(options));
    assert!(
        text.contains("deadline"),
        "pacing must stay inside the run deadline: {text}"
    );
}

#[test]
fn the_deadline_includes_work_before_the_first_request() {
    let mut harness = Harness::new();
    let options = harness
        .fixture
        .options_with_timeout(Duration::from_secs(600));
    harness.advance(Duration::from_secs(600));
    let text = message(harness.run_with(options));
    assert!(
        text.contains("deadline"),
        "elapsed time before the first request counts: {text}"
    );
    assert!(harness.history().is_empty());
}

#[test]
fn a_release_published_during_the_run_is_reported() {
    let mut harness = Harness::new();
    harness.complete_all_except(&["aaa.nar.xz"]);
    harness.publish_after_upload();
    let text = message(harness.run());
    assert!(text.contains("already published"), "{text}");
}
