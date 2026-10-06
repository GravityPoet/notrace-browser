//! The same native process inventory drives seat checks and the Picker's
//! recovery action. Window counts do not describe Chromium's lifetime on Mac.

use crate::{CloakConfig, Result};
use serde::Serialize;

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
    pub(super) fn status(_: &CloakConfig) -> Result<BrowserProcessStatus> {
        Err(std::io::Error::other("浏览器进程管理目前仅支持 macOS").into())
    }
    pub(super) fn close_all(_: &CloakConfig) -> Result<ForceCloseResult> {
        Err(std::io::Error::other("浏览器进程管理目前仅支持 macOS").into())
    }
}
