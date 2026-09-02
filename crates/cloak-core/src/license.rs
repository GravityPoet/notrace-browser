//! Small, read-only helpers around the official CloakBrowser license surface.
//!
//! NoTrace does not implement (or try to defeat) the upstream license check.
//! This module only makes the check observable and prevents a stale server-side
//! session from being mistaken for a browser crash.

use rand::Rng;
use reqwest::blocking::Client;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::{CloakError, Result};

pub(crate) const STATUS_FILE_ENV: &str = "CLOAKBROWSER_LICENSE_STATUS_FILE";
const SESSION_COUNT_URL: &str = "https://cloakbrowser.dev/api/license/session/count";
const STATUS_DIR_NAME: &str = "denials";
const STATUS_FILE_TTL: Duration = Duration::from_secs(60 * 60);
const SESSION_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const SESSION_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const SESSION_WAIT_INTERVAL: Duration = Duration::from_secs(3);

/// The official keyed binary writes one of these integers immediately before a
/// license-denied exit. Keep the text here rather than exposing a key or raw
/// server response to the user.
pub(crate) fn denial_message(code: u8) -> Option<&'static str> {
    match code {
        76 => Some("session limit reached for the current plan"),
        77 => Some("license key is invalid, expired, or missing"),
        78 => Some("license verification could not reach the license server"),
        79 => Some("local CloakBrowser license configuration is not writable"),
        _ => None,
    }
}

pub(crate) fn denial_error(code: u8) -> Option<CloakError> {
    denial_message(code).map(|message| CloakError::LicenseDenied {
        code,
        message: message.to_string(),
    })
}

/// A deliberately non-secret, per-launch path. The binary creates the file
/// only when it denies a launch; a successful launch leaves no file behind.
pub(crate) fn mint_status_file(root: &Path) -> Option<PathBuf> {
    let directory = root.join(STATUS_DIR_NAME);
    if fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return None;
    }
    fs::create_dir_all(&directory).ok()?;
    set_private_directory(&directory);
    sweep_stale_status_files(&directory);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let random = rand::thread_rng().gen::<u64>();
    let pid = std::process::id();
    let candidate = directory.join(format!("{pid}-{now:x}-{random:x}.json"));
    // The name is random and the file must not exist yet: the child binary is
    // the only writer. Refuse an accidental symlink/collision rather than
    // overwriting anything owned by another process.
    if fs::symlink_metadata(&candidate).is_ok() {
        return None;
    }
    Some(candidate)
}

/// Read and consume a complete status code written by the official binary.
/// Incomplete contents are left in place for the next poll, avoiding a race
/// with the child while it is still writing the tiny JSON payload.
pub(crate) fn read_denial_code(path: &Path) -> Option<u8> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let code = serde_json::from_str::<i32>(&raw).ok()?;
    let code = u8::try_from(code)
        .ok()
        .filter(|code| denial_message(*code).is_some())?;
    let _ = fs::remove_file(path);
    Some(code)
}

pub(crate) fn remove_status_file(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SessionSeats {
    pub active: u32,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct SessionCountResponse {
    active: Option<u32>,
    limit: Option<u32>,
}

/// Query the official, uncached session count. A transport/HTTP/shape failure
/// is represented as `None`; in that case the binary remains the authority and
/// NoTrace must not invent a false “free” or “full” state.
pub(crate) fn query_session_seats(key: &str) -> Option<SessionSeats> {
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    let client = Client::builder()
        .timeout(SESSION_QUERY_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .post(SESSION_COUNT_URL)
        .json(&serde_json::json!({ "license_key": key }))
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.json::<SessionCountResponse>().ok()?;
    Some(SessionSeats {
        active: body.active?,
        limit: body.limit,
    })
}

/// Wait briefly for a stale server lease to disappear, but only when no local
/// browser process is holding the seat. The query and process checks are
/// injected so the policy is testable without touching the real license API.
pub(crate) fn wait_for_available_seat<Q, L>(
    cancellation: Option<&AtomicBool>,
    mut query: Q,
    mut local_browser_running: L,
) -> Result<()>
where
    Q: FnMut() -> Option<SessionSeats>,
    L: FnMut() -> Result<bool>,
{
    wait_for_available_seat_with(
        cancellation,
        &mut query,
        &mut local_browser_running,
        SESSION_WAIT_TIMEOUT,
        SESSION_WAIT_INTERVAL,
    )
}

fn wait_for_available_seat_with<Q, L>(
    cancellation: Option<&AtomicBool>,
    query: &mut Q,
    local_browser_running: &mut L,
    timeout: Duration,
    interval: Duration,
) -> Result<()>
where
    Q: FnMut() -> Option<SessionSeats>,
    L: FnMut() -> Result<bool>,
{
    let Some(initial) = query() else {
        // If the server cannot answer, let the official binary decide. This
        // avoids turning a transient network outage into a local dead-end.
        return Ok(());
    };
    if seat_is_available(initial) {
        return Ok(());
    }
    if local_browser_running()? {
        return Err(CloakError::LicenseSeatInUse);
    }

    let deadline = Instant::now() + timeout;
    loop {
        sleep_cancellable(interval, cancellation)?;
        let Some(current) = query() else {
            return Ok(());
        };
        if seat_is_available(current) {
            return Ok(());
        }
        if local_browser_running()? {
            return Err(CloakError::LicenseSeatInUse);
        }
        if Instant::now() >= deadline {
            return Err(CloakError::LicenseSeatStale);
        }
    }
}

fn seat_is_available(seats: SessionSeats) -> bool {
    seats
        .limit
        .map(|limit| seats.active < limit)
        .unwrap_or(true)
}

fn sleep_cancellable(duration: Duration, cancellation: Option<&AtomicBool>) -> Result<()> {
    let deadline = Instant::now() + duration;
    loop {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(CloakError::LaunchCancelled);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
}

fn sweep_stale_status_files(directory: &Path) {
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STATUS_FILE_TTL);
        if stale {
            let _ = fs::remove_file(path);
        }
    }
}

fn set_private_directory(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn known_denial_codes_are_mapped_without_exposing_secrets() {
        assert!(denial_message(76).is_some());
        assert!(denial_message(79).is_some());
        assert!(denial_message(75).is_none());
        let error = denial_error(76).expect("session-limit error");
        let rendered = error.to_string();
        assert!(rendered.contains("76"));
        assert!(!rendered.contains("license_key"));
    }

    #[test]
    fn denial_status_file_is_consumed_and_validated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("denial.json");
        fs::write(&path, "76").unwrap();
        assert_eq!(read_denial_code(&path), Some(76));
        assert!(!path.exists());

        fs::write(&path, "not-json").unwrap();
        assert_eq!(read_denial_code(&path), None);
        assert!(path.exists());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn stale_seat_waits_then_recovers_without_local_holder() {
        let mut responses = vec![
            Some(SessionSeats {
                active: 1,
                limit: Some(1),
            }),
            Some(SessionSeats {
                active: 0,
                limit: Some(1),
            }),
        ]
        .into_iter();
        let mut local_checks = 0;
        let mut query = || {
            responses.next().unwrap_or(Some(SessionSeats {
                active: 0,
                limit: Some(1),
            }))
        };
        let mut local = || {
            local_checks += 1;
            Ok(false)
        };
        let result = wait_for_available_seat_with(
            None,
            &mut query,
            &mut local,
            Duration::ZERO,
            Duration::ZERO,
        );
        assert!(result.is_ok());
        assert!(local_checks >= 1);
    }

    #[test]
    fn full_seat_without_local_holder_times_out_as_stale() {
        let mut query = || {
            Some(SessionSeats {
                active: 1,
                limit: Some(1),
            })
        };
        let mut local = || Ok(false);
        let result = wait_for_available_seat_with(
            None,
            &mut query,
            &mut local,
            Duration::ZERO,
            Duration::ZERO,
        );
        assert!(matches!(result, Err(CloakError::LicenseSeatStale)));
    }

    #[test]
    fn unavailable_seat_endpoint_defers_to_the_browser_binary() {
        let mut query = || None;
        let mut local_checks = 0;
        let mut local = || {
            local_checks += 1;
            Ok(false)
        };
        let result = wait_for_available_seat_with(
            None,
            &mut query,
            &mut local,
            Duration::ZERO,
            Duration::ZERO,
        );
        assert!(result.is_ok());
        assert_eq!(local_checks, 0);
    }

    #[test]
    fn full_seat_with_local_holder_fails_immediately() {
        let mut query = || {
            Some(SessionSeats {
                active: 1,
                limit: Some(1),
            })
        };
        let mut local = || Ok(true);
        let result = wait_for_available_seat_with(
            Some(&AtomicBool::new(false)),
            &mut query,
            &mut local,
            Duration::from_secs(1),
            Duration::ZERO,
        );
        assert!(matches!(result, Err(CloakError::LicenseSeatInUse)));
    }
}
