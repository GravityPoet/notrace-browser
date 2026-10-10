//! The same native process inventory drives seat checks and the Picker's
//! recovery action. Window counts do not describe Chromium's lifetime on Mac.

use crate::{CloakConfig, Result};
use serde::Serialize;
use std::path::Path;

pub(crate) struct AuthBrowserState {
    pub running: bool,
    pub has_window: Option<bool>,
}

pub(crate) fn auth_browser_state(
    pid: u32,
    binary: &Path,
    profile: &Path,
) -> Result<AuthBrowserState> {
    platform::auth_state(pid, binary, profile)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BrowserProcessStatus {
    pub browser_count: usize,
    pub helper_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ForceCloseResult {
    pub closed: usize,
    pub force_killed: usize,
    pub remaining: usize,
    pub seats: Option<SeatUsage>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SeatUsage {
    pub active: u32,
    pub limit: Option<u32>,
}

pub fn browser_process_status(config: &CloakConfig) -> Result<BrowserProcessStatus> {
    platform::status(config)
}

/// Query the uncached upstream seat count without exposing the license key.
/// `None` means the key is unavailable or the service could not answer.
pub fn license_session_status(config: &CloakConfig) -> Option<SeatUsage> {
    let browser = crate::resolve_browser(config).ok()?;
    if !crate::is_keyed_browser_binary(&browser.binary) {
        return None;
    }
    crate::resolve_cloakbrowser_license_key(&config.cloakbrowser_root)
        .and_then(|key| crate::license::query_session_seats(key.as_str()))
        .map(|seats| SeatUsage {
            active: seats.active,
            limit: seats.limit,
        })
}

pub fn force_close_all_browsers(config: &CloakConfig) -> Result<ForceCloseResult> {
    let mut result = platform::close_all(config)?;
    if result.remaining == 0 {
        result.seats = license_session_status(config);
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::collections::HashSet;
    use std::ffi::OsStr;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant};

    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    struct BrowserProcess {
        pid: i32,
        executable: PathBuf,
        primary: bool,
    }

    struct Scope {
        root: PathBuf,
        custom_binary: Option<PathBuf>,
        profiles: Vec<String>,
    }

    impl Scope {
        fn new(config: &CloakConfig) -> Self {
            let root = crate::real_browser_path(config.cloakbrowser_root.clone());
            let custom_binary = crate::resolve_browser(config)
                .ok()
                .map(|resolved| resolved.binary)
                .filter(|binary| !binary.starts_with(&root));
            let profiles = std::fs::read_dir(&config.account_base)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| crate::user_data_dir_needle(&entry.path()))
                .collect();
            Self {
                root,
                custom_binary,
                profiles,
            }
        }

        fn classify(&self, executable: &Path) -> Option<bool> {
            if !executable.starts_with(&self.root) {
                return None;
            }
            let bundle = executable.ancestors().find(|path| {
                path.extension() == Some(OsStr::new("app"))
                    && path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("Chromium"))
            })?;
            if !bundle.starts_with(&self.root) {
                return None;
            }
            let primary = bundle.file_name() == Some(OsStr::new("Chromium.app"))
                && executable == bundle.join("Contents/MacOS/Chromium");
            let helper = bundle
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("Chromium Helper"));
            (primary || helper).then_some(primary)
        }

        fn classify_command(&self, executable: &Path, command: &str) -> Option<bool> {
            let managed_profile = self
                .profiles
                .iter()
                .any(|profile| crate::command_line_mentions_user_data_dir(command, profile));
            if let Some(primary) = self.classify(executable) {
                // A bare launch under our runtime root is also ours, but a
                // different user's explicit profile is not. Never classify
                // by command text alone: scripts may contain browser paths.
                return (managed_profile || !command.contains("--user-data-dir="))
                    .then_some(primary);
            }
            (managed_profile
                && self.custom_binary.as_deref() == Some(executable)
                && !command.contains(" --type="))
            .then_some(true)
        }
    }

    fn executable_for_pid(pid: i32) -> Option<PathBuf> {
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // The buffer has the size required by libproc and remains live for the call.
        let length =
            unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        if length <= 0 {
            return None;
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(length as usize);
        Some(PathBuf::from(OsStr::from_bytes(&buffer[..end])))
    }

    pub(super) fn auth_state(pid: u32, binary: &Path, profile: &Path) -> Result<AuthBrowserState> {
        let matching_process = i32::try_from(pid)
            .ok()
            .filter(|pid| *pid > 1)
            .is_some_and(|pid| {
                executable_for_pid(pid).as_ref() == Some(&crate::real_browser_path(binary.into()))
            });
        let running = matching_process && crate::running_browser_pid(binary, profile)? == Some(pid);
        Ok(AuthBrowserState {
            running,
            has_window: running.then(|| auth_window_exists(pid)).flatten(),
        })
    }

    fn auth_window_exists(pid: u32) -> Option<bool> {
        use core_foundation::array::CFArray;
        use core_foundation::base::{CFType, TCFType};
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::number::CFNumber;
        use core_foundation::string::CFString;
        use core_graphics::window::{copy_window_info, kCGNullWindowID, kCGWindowListOptionAll};

        fn number(dictionary: &CFDictionary<CFString, CFType>, key: &str) -> Option<f64> {
            dictionary
                .find(CFString::new(key))?
                .downcast::<CFNumber>()?
                .to_f64()
        }
        // Include offscreen windows: minimizing, hiding or switching Spaces is
        // not cancellation. Only PID/layer/bounds are inspected, never titles.
        let array = copy_window_info(kCGWindowListOptionAll, kCGNullWindowID)?;
        // SAFETY: CGWindowListCopyWindowInfo returns an array of CFDictionary
        // objects with documented CFString keys and CFType values. This wrapper
        // retains the array; every value is type-checked before use.
        let windows: CFArray<CFDictionary<CFString, CFType>> =
            unsafe { CFArray::wrap_under_get_rule(array.as_concrete_TypeRef()) };
        Some(windows.iter().any(|window| {
            if number(&window, "kCGWindowOwnerPID") != Some(f64::from(pid))
                || number(&window, "kCGWindowLayer") != Some(0.0)
            {
                return false;
            }
            let Some(bounds) = window
                .find(CFString::new("kCGWindowBounds"))
                .and_then(|value| value.downcast::<CFDictionary>())
            else {
                return false;
            };
            // SAFETY: the documented bounds dictionary uses CFString keys;
            // number() validates each value as a CFNumber before reading it.
            let bounds: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(bounds.as_concrete_TypeRef()) };
            number(&bounds, "Width").is_some_and(|width| width >= 100.0)
                && number(&bounds, "Height").is_some_and(|height| height >= 100.0)
        }))
    }

    fn scan(scope: &Scope) -> Result<Vec<BrowserProcess>> {
        let output = Command::new("/bin/ps")
            .args(["ax", "-o", "pid=,uid=,stat="])
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other("无法读取本机浏览器进程状态").into());
        }
        // geteuid has no preconditions; the action only controls this user's processes.
        let uid = unsafe { libc::geteuid() };
        let mut processes = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut fields = line.split_whitespace();
            let Some(pid) = fields.next().and_then(|value| value.parse::<i32>().ok()) else {
                continue;
            };
            let owner = fields.next().and_then(|value| value.parse::<u32>().ok());
            let state = fields.next().unwrap_or_default();
            if pid <= 1
                || pid == std::process::id() as i32
                || owner != Some(uid)
                || state.starts_with('Z')
            {
                continue;
            }
            let Some(executable) = executable_for_pid(pid) else {
                continue;
            };
            if scope.classify(&executable).is_none()
                && scope.custom_binary.as_ref() != Some(&executable)
            {
                continue;
            }
            let command = Command::new("/bin/ps")
                .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
                .output()?;
            if !command.status.success() {
                continue;
            }
            let command = String::from_utf8_lossy(&command.stdout);
            let Some(primary) = scope.classify_command(&executable, &command) else {
                continue;
            };
            processes.push(BrowserProcess {
                pid,
                executable,
                primary,
            });
        }
        Ok(processes)
    }

    pub(super) fn status(config: &CloakConfig) -> Result<BrowserProcessStatus> {
        let processes = scan(&Scope::new(config))?;
        Ok(BrowserProcessStatus {
            browser_count: processes.iter().filter(|process| process.primary).count(),
            helper_count: processes.iter().filter(|process| !process.primary).count(),
        })
    }

    fn signal(process: &BrowserProcess, force: bool) -> Result<()> {
        // Revalidate the executable before every signal, including escalation.
        if executable_for_pid(process.pid).as_ref() != Some(&process.executable) {
            return Ok(());
        }
        if !force && process.primary {
            if let Some(app) =
                objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(
                    process.pid,
                )
            {
                if app.terminate() {
                    return Ok(());
                }
            }
        }
        // A positive PID is obtained from the current user's native inventory.
        let result = unsafe {
            libc::kill(
                process.pid,
                if force { libc::SIGKILL } else { libc::SIGTERM },
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        Ok(())
    }

    fn wait_for_exit(scope: &Scope, timeout: Duration) -> Result<Vec<BrowserProcess>> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = scan(scope)?;
            if remaining.is_empty() || Instant::now() >= deadline {
                return Ok(remaining);
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    pub(super) fn close_all(config: &CloakConfig) -> Result<ForceCloseResult> {
        let scope = Scope::new(config);
        let initial = scan(&scope)?;
        let mut seen: HashSet<_> = initial.iter().cloned().collect();
        // Let the primary application save state and release its license first.
        // Orphan helpers are also closed when no primary remains.
        let has_primary = initial.iter().any(|process| process.primary);
        for process in &initial {
            if process.primary || !has_primary {
                signal(process, false)?;
            }
        }
        let stubborn = wait_for_exit(&scope, Duration::from_secs(3))?;
        seen.extend(stubborn.iter().cloned());
        for process in &stubborn {
            signal(process, true)?;
        }
        let remaining = wait_for_exit(&scope, Duration::from_secs(2))?;
        Ok(ForceCloseResult {
            closed: seen
                .iter()
                .filter(|process| !remaining.contains(process))
                .count(),
            force_killed: stubborn
                .iter()
                .filter(|process| !remaining.contains(process))
                .count(),
            remaining: remaining.len(),
            seats: None,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn scope_matches_old_binaries_and_orphan_helpers_but_excludes_other_apps() {
            let scope = Scope {
                root: PathBuf::from("/tmp/cloak"),
                custom_binary: None,
                profiles: vec![],
            };
            assert_eq!(
                scope.classify(Path::new(
                    "/tmp/cloak/chromium-150/Chromium.app/Contents/MacOS/Chromium"
                )),
                Some(true)
            );
            assert_eq!(scope.classify(Path::new("/tmp/cloak/chromium-151-notrace/Chromium.app/Contents/Frameworks/Chromium Helper.app/Contents/MacOS/Chromium Helper")), Some(false));
            assert_eq!(
                scope.classify(Path::new(
                    "/tmp/cloak-other/Chromium.app/Contents/MacOS/Chromium"
                )),
                None
            );
            assert_eq!(
                scope.classify(Path::new(
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                )),
                None
            );
            assert_eq!(scope.classify(Path::new("/tmp/cloak/updater")), None);
        }

        #[test]
        fn scope_includes_bare_runtime_but_excludes_external_profiles_and_path_text() {
            let binary = Path::new("/tmp/cloak/chromium-test/Chromium.app/Contents/MacOS/Chromium");
            let scope = Scope {
                root: PathBuf::from("/tmp/cloak"),
                custom_binary: None,
                profiles: vec![crate::user_data_dir_needle(Path::new("/tmp/accounts/work"))],
            };
            assert_eq!(
                scope.classify_command(binary, &binary.to_string_lossy()),
                Some(true)
            );
            assert_eq!(
                scope.classify_command(
                    binary,
                    "Chromium --user-data-dir=/tmp/accounts/work --fingerprint=12345"
                ),
                Some(true)
            );
            assert_eq!(
                scope.classify_command(binary, "Chromium --user-data-dir=/tmp/accounts/work-other"),
                None
            );
            assert_eq!(
                scope.classify_command(Path::new("/bin/sh"), &binary.to_string_lossy()),
                None
            );
        }

        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        #[test]
        fn auth_window_inventory_distinguishes_hidden_minimized_closed_and_unrelated_processes() {
            use std::io::{BufRead, BufReader, Write};
            use std::process::Stdio;
            use std::sync::mpsc;

            let directory = tempfile::tempdir().unwrap();
            let source = directory.path().join("auth-window.m");
            let binary = directory.path().join("auth-window");
            std::fs::write(
                &source,
                include_str!("../../../packaging/auth-browser-window-fixture.m"),
            )
            .unwrap();
            assert!(Command::new("/usr/bin/xcrun")
                .args(["clang", "-framework", "AppKit", "-fblocks"])
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .status()
                .unwrap()
                .success());
            let profile = directory.path().join("profile");
            let mut child = ChildGuard(
                Command::new(&binary)
                    .arg(format!("--user-data-dir={}", profile.display()))
                    .env_remove("CLOAK_AUTH_TEST_TIMED")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let stdout = child.0.stdout.take().unwrap();
            let (sender, receiver) = mpsc::channel();
            let reader = thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    if sender.send(line.unwrap()).is_err() {
                        break;
                    }
                }
            });
            assert_eq!(
                receiver.recv_timeout(Duration::from_secs(10)).unwrap(),
                "ready"
            );
            assert!(auth_state(child.0.id(), &binary, &profile)
                .unwrap()
                .has_window
                .unwrap());
            assert!(
                !auth_state(child.0.id(), Path::new("/bin/sleep"), &profile)
                    .unwrap()
                    .running
            );
            assert!(
                !auth_state(
                    child.0.id(),
                    &binary,
                    &directory.path().join("other-profile")
                )
                .unwrap()
                .running
            );
            for action in ["minimize", "show", "hide", "show", "close"] {
                writeln!(child.0.stdin.as_mut().unwrap(), "{action}").unwrap();
                assert_eq!(
                    receiver.recv_timeout(Duration::from_secs(10)).unwrap(),
                    action
                );
                let state = auth_state(child.0.id(), &binary, &profile).unwrap();
                if action == "close" {
                    let deadline = Instant::now() + Duration::from_secs(3);
                    let mut closed = false;
                    while Instant::now() < deadline {
                        let current = auth_state(child.0.id(), &binary, &profile).unwrap();
                        if !current.running || current.has_window == Some(false) {
                            closed = true;
                            break;
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                    assert!(closed, "native window did not disappear after close");
                } else {
                    assert!(
                        state.running,
                        "native process must remain alive after {action}"
                    );
                    assert_eq!(
                        state.has_window,
                        Some(true),
                        "native window state after {action}"
                    );
                }
            }
            let _ = child.0.kill();
            let _ = child.0.wait();
            reader.join().unwrap();
            assert!(!auth_state(child.0.id(), &binary, &profile).unwrap().running);
        }

        #[test]
        fn closes_real_processes_and_reopens_without_touching_unrelated_processes() {
            let dir = tempfile::tempdir().unwrap();
            let binary = dir
                .path()
                .join("chromium-test/Chromium.app/Contents/MacOS/Chromium");
            std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
            let source = dir.path().join("fixture.c");
            std::fs::write(&source, "#include <signal.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc, char **argv) { if (argc > 1 && strcmp(argv[1], \"ignore-term\") == 0) signal(SIGTERM, SIG_IGN); for (;;) pause(); }\n").unwrap();
            let compiler = std::env::var_os("CC").unwrap_or_else(|| "cc".into());
            assert!(Command::new(compiler)
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .status()
                .unwrap()
                .success());
            let mut unrelated = ChildGuard(Command::new("/bin/sleep").arg("30").spawn().unwrap());
            let config = CloakConfig {
                repo_root: dir.path().into(),
                account_base: dir.path().join("accounts"),
                extension_source: dir.path().join("extension"),
                cloakbrowser_root: dir.path().into(),
            };
            for (force, bare) in [(false, false), (true, false), (false, true), (true, true)] {
                let helper = dir.path().join("chromium-test/Chromium.app/Contents/Frameworks/Chromium Helper.app/Contents/MacOS/Chromium Helper");
                if force {
                    std::fs::create_dir_all(helper.parent().unwrap()).unwrap();
                    std::fs::copy(&binary, &helper).unwrap();
                }
                let mut command = Command::new(if force { &helper } else { &binary });
                if force {
                    command.arg("ignore-term");
                }
                let profile = dir.path().join("accounts/work");
                std::fs::create_dir_all(&profile).unwrap();
                if !bare {
                    command.arg(format!("--user-data-dir={}", profile.display()));
                }
                let mut browser = ChildGuard(command.spawn().unwrap());
                thread::sleep(Duration::from_millis(100));
                let status = status(&config).unwrap();
                assert_eq!(status.browser_count + status.helper_count, 1);
                let result = close_all(&config).unwrap();
                browser.0.wait().unwrap();
                assert_eq!(result.remaining, 0);
                assert_eq!(result.closed, 1);
                assert!(result.force_killed <= 1);
                assert!(unrelated.0.try_wait().unwrap().is_none());
            }
            assert_eq!(close_all(&config).unwrap().closed, 0);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    pub(super) fn auth_state(_: u32, _: &Path, profile: &Path) -> Result<AuthBrowserState> {
        Ok(AuthBrowserState {
            running: crate::account_profile_is_running(profile)?,
            has_window: None,
        })
    }
    pub(super) fn status(_: &CloakConfig) -> Result<BrowserProcessStatus> {
        Err(std::io::Error::other("浏览器进程管理目前仅支持 macOS").into())
    }
    pub(super) fn close_all(_: &CloakConfig) -> Result<ForceCloseResult> {
        Err(std::io::Error::other("浏览器进程管理目前仅支持 macOS").into())
    }
}
