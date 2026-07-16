use cloak_core::{
    account_is_running as core_account_is_running, build_launch_plan,
    create_account_with_group as core_create_account_with_group,
    delete_account as core_delete_account, launch_account as core_launch_account,
    launch_chrome_web_store as core_launch_chrome_web_store, list_accounts as core_list_accounts,
    list_trashed_accounts as core_list_trashed_accounts,
    permanently_delete_account as core_permanently_delete_account,
    rename_account as core_rename_account, set_account_trashed as core_set_account_trashed,
    set_group as core_set_group, set_mark as core_set_mark, set_proxy as core_set_proxy,
    set_region as core_set_region, toggle_locale as core_toggle_locale, Account, CloakConfig,
    LaunchOptions, LaunchPlan, LaunchResult,
};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

fn config() -> Result<CloakConfig, String> {
    CloakConfig::from_env().map_err(|err| err.to_string())
}

/// Core launch/preflight work uses blocking filesystem, process and HTTP APIs.
/// Keep it off Tauri's main/UI thread so a slow proxy or GeoIP provider cannot
/// make the picker appear frozen.
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|err| format!("后台任务异常：{err}"))?
}

struct PickerInstanceGuard {
    path: PathBuf,
}

#[derive(Clone, Default)]
struct LaunchCancellationRegistry {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl LaunchCancellationRegistry {
    fn begin(&self, name: &str) -> Result<Arc<AtomicBool>, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "启动取消状态已损坏".to_string())?;
        if let Some(previous) = active.remove(name) {
            previous.store(true, Ordering::Release);
        }
        let cancellation_flag = Arc::new(AtomicBool::new(false));
        active.insert(name.to_string(), Arc::clone(&cancellation_flag));
        Ok(cancellation_flag)
    }

    fn finish(&self, name: &str, cancellation_flag: &Arc<AtomicBool>) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .get(name)
                .map(|current| Arc::ptr_eq(current, cancellation_flag))
                .unwrap_or(false)
            {
                active.remove(name);
            }
        }
    }

    fn cancel(&self, name: &str) -> Result<bool, String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "启动取消状态已损坏".to_string())?;
        let Some(cancellation_flag) = active.get(name) else {
            return Ok(false);
        };
        cancellation_flag.store(true, Ordering::Release);
        Ok(true)
    }
}

impl Drop for PickerInstanceGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_picker_instance() -> Result<Option<PickerInstanceGuard>, String> {
    let lock_path = std::env::var_os("CLOAK_PICKER_LOCK")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            CloakConfig::from_env()
                .map(|config| {
                    config
                        .account_base
                        .parent()
                        .unwrap_or(&config.account_base)
                        .join(".cloak-picker.lock")
                })
                .unwrap_or_else(|_| PathBuf::from(".cloak-picker.lock"))
        });
    acquire_picker_instance_at(lock_path, focus_existing_picker)
}

fn acquire_picker_instance_at<F>(
    lock_path: PathBuf,
    focus_existing: F,
) -> Result<Option<PickerInstanceGuard>, String>
where
    F: Fn(),
{
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建单实例锁目录失败：{err}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }

    for _ in 0..2 {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                if let Err(err) = file.write_all(std::process::id().to_string().as_bytes()) {
                    drop(file);
                    let _ = fs::remove_file(&lock_path);
                    return Err(format!("写入单实例锁失败：{err}"));
                }
                set_private_file(&lock_path);
                return Ok(Some(PickerInstanceGuard { path: lock_path }));
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                let pid = fs::read_to_string(&lock_path)
                    .ok()
                    .and_then(|value| value.trim().parse::<u32>().ok());
                if let Some(pid) = pid {
                    if process_is_alive(pid) {
                        focus_existing();
                        return Ok(None);
                    }
                }
                let _ = fs::remove_file(&lock_path);
            }
            Err(err) => return Err(format!("创建单实例锁失败：{err}")),
        }
    }
    Err("无法取得单实例锁".to_string())
}

fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn set_private_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

fn focus_existing_picker() {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("/usr/bin/open")
            .args(["-b", "local.cloak.picker"])
            .status();
    }
}

#[tauri::command]
fn list_accounts() -> Result<Vec<Account>, String> {
    core_list_accounts(&config()?).map_err(|err| err.to_string())
}

#[tauri::command]
fn list_trashed_accounts() -> Result<Vec<Account>, String> {
    core_list_trashed_accounts(&config()?).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_account(name: String, group: Option<String>) -> Result<Account, String> {
    core_create_account_with_group(&config()?, &name, group.as_deref())
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn rename_account(old_name: String, new_name: String) -> Result<Account, String> {
    core_rename_account(&config()?, &old_name, &new_name).map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_account(name: String) -> Result<(), String> {
    core_delete_account(&config()?, &name).map_err(|err| err.to_string())
}

#[tauri::command]
fn permanently_delete_account(name: String) -> Result<(), String> {
    core_permanently_delete_account(&config()?, &name).map_err(|err| err.to_string())
}

#[tauri::command]
fn restore_account(name: String) -> Result<Account, String> {
    core_set_account_trashed(&config()?, &name, false).map_err(|err| err.to_string())
}

#[tauri::command]
fn set_proxy(name: String, value: Option<String>) -> Result<Account, String> {
    core_set_proxy(&config()?, &name, value.as_deref()).map_err(|err| err.to_string())
}

#[tauri::command]
fn set_region(name: String, value: Option<String>) -> Result<Account, String> {
    core_set_region(&config()?, &name, value.as_deref()).map_err(|err| err.to_string())
}

#[tauri::command]
fn set_group(name: String, value: Option<String>) -> Result<Account, String> {
    core_set_group(&config()?, &name, value.as_deref()).map_err(|err| err.to_string())
}

#[tauri::command]
fn set_mark(name: String, marked: bool, note: Option<String>) -> Result<Account, String> {
    core_set_mark(&config()?, &name, marked, note.as_deref()).map_err(|err| err.to_string())
}

#[tauri::command]
fn toggle_locale(name: String) -> Result<Account, String> {
    core_toggle_locale(&config()?, &name).map_err(|err| err.to_string())
}

#[tauri::command]
async fn launch_dry_run(name: String) -> Result<LaunchPlan, String> {
    run_blocking(move || {
        let mut options = LaunchOptions::from_env(true);
        options.dry_run = true;
        options.skip_geo = true;
        build_launch_plan(&config()?, &name, &options).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn launch_preflight(name: String) -> Result<LaunchPlan, String> {
    run_blocking(move || {
        let mut options = LaunchOptions::from_env(true);
        options.dry_run = true;
        options.skip_geo = false;
        build_launch_plan(&config()?, &name, &options).map_err(|err| err.to_string())
    })
    .await
}

#[tauri::command]
async fn launch_account(
    name: String,
    cancellations: State<'_, LaunchCancellationRegistry>,
) -> Result<LaunchResult, String> {
    let registry = cancellations.inner().clone();
    let cancellation_flag = registry.begin(&name)?;
    let worker_name = name.clone();
    let worker_cancellation = Arc::clone(&cancellation_flag);
    let result = run_blocking(move || {
        let mut options = LaunchOptions::from_env(false);
        options.cancellation = Some(worker_cancellation);
        core_launch_account(&config()?, &worker_name, &options).map_err(|err| err.to_string())
    })
    .await;
    registry.finish(&name, &cancellation_flag);
    result
}

#[tauri::command]
async fn launch_web_store(
    name: String,
    cancellations: State<'_, LaunchCancellationRegistry>,
) -> Result<LaunchResult, String> {
    let registry = cancellations.inner().clone();
    let cancellation_flag = registry.begin(&name)?;
    let worker_name = name.clone();
    let worker_cancellation = Arc::clone(&cancellation_flag);
    let result = run_blocking(move || {
        let mut options = LaunchOptions::from_env(false);
        options.cancellation = Some(worker_cancellation);
        core_launch_chrome_web_store(&config()?, &worker_name, &options)
            .map_err(|err| err.to_string())
    })
    .await;
    registry.finish(&name, &cancellation_flag);
    result
}

#[tauri::command]
fn cancel_launch(
    name: String,
    cancellations: State<'_, LaunchCancellationRegistry>,
) -> Result<bool, String> {
    cancellations.cancel(&name)
}

#[tauri::command]
async fn account_is_running(name: String) -> Result<bool, String> {
    run_blocking(move || core_account_is_running(&config()?, &name).map_err(|err| err.to_string()))
        .await
}

#[tauri::command]
async fn run_challenge_audit() -> Result<serde_json::Value, String> {
    run_blocking(run_challenge_audit_blocking).await
}

fn resolve_node_binary(candidates: &[PathBuf]) -> PathBuf {
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned()
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn node_binary() -> PathBuf {
    resolve_node_binary(&[
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ])
}

fn run_challenge_audit_blocking() -> Result<serde_json::Value, String> {
    let config = config()?;
    let script = config
        .repo_root
        .join("selftest/run-live-challenge-audit.mjs");
    if !script.is_file() {
        return Err(format!("挑战审计脚本不存在：{}", script.display()));
    }
    #[cfg(target_os = "macos")]
    let browser = config
        .cloakbrowser_root
        .join("current/Chromium.app/Contents/MacOS/Chromium");
    #[cfg(not(target_os = "macos"))]
    let browser = config.cloakbrowser_root.join("current/chrome");
    if !browser.is_file() {
        return Err(format!("当前浏览器二进制不存在：{}", browser.display()));
    }
    let hash_output = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(&browser)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("计算浏览器 SHA256 失败：{err}"))?;
    if !hash_output.status.success() {
        return Err(format!(
            "计算浏览器 SHA256 失败：{}",
            String::from_utf8_lossy(&hash_output.stderr).trim()
        ));
    }
    let browser_sha256 = String::from_utf8_lossy(&hash_output.stdout)
        .split_whitespace()
        .next()
        .filter(|value| value.len() == 64)
        .ok_or_else(|| "浏览器 SHA256 输出无效".to_string())?
        .to_string();

    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    );
    let result_dir = std::env::temp_dir().join(format!("notrace-challenge-audit-{unique}"));
    fs::create_dir_all(&result_dir).map_err(|err| format!("创建挑战审计目录失败：{err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&result_dir, fs::Permissions::from_mode(0o700));
    }

    let started = std::time::Instant::now();
    let node = node_binary();
    let output = Command::new(&node)
        .arg(&script)
        .args([
            "--headed",
            "--site",
            "version-consistency",
            "--site",
            "cloudflare-turnstile-test",
            "--timeout-ms",
            "60000",
            "--no-screenshots",
            "--account-name",
        ])
        .arg(format!("picker-challenge-audit-{unique}"))
        .arg("--result-dir")
        .arg(&result_dir)
        .env("CLOAK_BROWSER_BIN", &browser)
        .env("CLOAK_BROWSER_EXPECTED_SHA256", &browser_sha256)
        .env("CLOAK_EXTRA_EXTENSIONS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("无法启动挑战审计（{}）：{err}", node.display()));
    let report_path = result_dir.join("report.json");
    let result = match output {
        Ok(output) if report_path.is_file() => (|| {
            let body = fs::read_to_string(&report_path)
                .map_err(|err| format!("读取挑战审计报告失败：{err}"))?;
            let report: serde_json::Value = serde_json::from_str(&body)
                .map_err(|err| format!("解析挑战审计报告失败：{err}"))?;
            let results = report
                .get("results")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let cancelled = report
                .get("cancelled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let passed = output.status.success()
                && !results.is_empty()
                && results.iter().all(|item| {
                    item.get("passed").and_then(serde_json::Value::as_bool) == Some(true)
                });
            Ok(serde_json::json!({
                "passed": passed,
                "cancelled": cancelled,
                "duration_ms": started
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
                "browser_sha256": browser_sha256,
                "results": results,
                "error": if passed {
                    serde_json::Value::Null
                } else if cancelled {
                    serde_json::Value::String("审计浏览器已关闭，检查已结束".to_string())
                } else {
                    serde_json::Value::String(
                        String::from_utf8_lossy(&output.stderr)
                            .trim()
                            .chars()
                            .take(800)
                            .collect()
                    )
                }
            }))
        })(),
        Ok(output) => Err(format!(
            "挑战审计未生成报告：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
        Err(err) => Err(err),
    };
    let _ = fs::remove_dir_all(&result_dir);
    result
}

pub fn run() {
    let instance_guard = match acquire_picker_instance() {
        Ok(Some(guard)) => Some(guard),
        Ok(None) => return,
        Err(err) => {
            // A damaged or unwritable lock must not turn into a silent startup
            // failure. Continue without de-duplication and keep the UI usable.
            eprintln!("{err}；本次将不启用单实例锁");
            None
        }
    };
    tauri::Builder::default()
        .manage(instance_guard)
        .manage(LaunchCancellationRegistry::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            let window = if let Some(window) = app.get_webview_window("main") {
                window
            } else {
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Cloak 账号管理")
                    .inner_size(920.0, 620.0)
                    .min_inner_size(760.0, 540.0)
                    .visible(true)
                    .center()
                    .build()?
            };
            let _ = window.unminimize();
            let _ = window.maximize();
            window.show()?;
            window.set_focus()?;
            focus_main_window_after_launch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_accounts,
            list_trashed_accounts,
            create_account,
            rename_account,
            delete_account,
            permanently_delete_account,
            restore_account,
            set_proxy,
            set_region,
            set_group,
            set_mark,
            toggle_locale,
            launch_dry_run,
            launch_preflight,
            launch_account,
            launch_web_store,
            cancel_launch,
            account_is_running,
            run_challenge_audit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cloak picker");
}

#[cfg(target_os = "macos")]
fn focus_main_window_after_launch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let app_for_main_thread = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = app_for_main_thread.show();
            if let Some(window) = app_for_main_thread.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.maximize();
                let _ = window.set_focus();
            }
        });
    });
}

#[cfg(not(target_os = "macos"))]
fn focus_main_window_after_launch(_: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_instance_lock_focuses_live_process_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("picker.lock");
        let guard = acquire_picker_instance_at(lock_path.clone(), || {})
            .unwrap()
            .expect("first instance should acquire lock");
        assert_eq!(
            fs::read_to_string(&lock_path).unwrap(),
            std::process::id().to_string()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let focused = Arc::new(AtomicBool::new(false));
        let focused_for_callback = Arc::clone(&focused);
        let second = acquire_picker_instance_at(lock_path.clone(), move || {
            focused_for_callback.store(true, Ordering::Release);
        })
        .unwrap();
        assert!(second.is_none());
        assert!(focused.load(Ordering::Acquire));

        drop(guard);
        assert!(!lock_path.exists());
    }

    #[test]
    fn stale_single_instance_lock_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("picker.lock");
        fs::write(&lock_path, "99999999").unwrap();

        let guard = acquire_picker_instance_at(lock_path.clone(), || {})
            .unwrap()
            .expect("stale lock should be replaced");
        assert_eq!(
            fs::read_to_string(&lock_path).unwrap(),
            std::process::id().to_string()
        );
        drop(guard);
        assert!(!lock_path.exists());
    }

    #[test]
    fn launch_cancellation_registry_cancels_and_replaces_tokens() {
        let registry = LaunchCancellationRegistry::default();
        let first = registry.begin("work").unwrap();
        let second = registry.begin("work").unwrap();
        assert!(first.load(Ordering::Acquire));
        assert!(!second.load(Ordering::Acquire));
        assert!(registry.cancel("work").unwrap());
        assert!(second.load(Ordering::Acquire));
        registry.finish("work", &second);
        assert!(!registry.cancel("work").unwrap());
    }

    #[test]
    fn account_command_acl_covers_registered_commands() {
        let source = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"));
        let handler_block = source
            .split_once("tauri::generate_handler![")
            .expect("invoke handler list should exist")
            .1
            .split_once("])")
            .expect("invoke handler list should be closed")
            .0;
        let acl = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/permissions/account-commands.toml"
        ));
        let allowed_commands = acl
            .lines()
            .filter_map(|line| {
                line.trim()
                    .trim_end_matches(',')
                    .strip_prefix('"')?
                    .strip_suffix('"')
            })
            .collect::<Vec<_>>();

        for command in handler_block
            .split(',')
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            assert!(
                allowed_commands.contains(&command),
                "registered Tauri command {command} is missing from account-commands ACL"
            );
        }
    }

    #[test]
    fn node_binary_resolution_prefers_an_existing_absolute_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing-node");
        let installed = dir.path().join("node");
        fs::write(&installed, "test node").unwrap();

        assert_eq!(
            resolve_node_binary(&[missing, installed.clone()]),
            installed
        );
        assert_eq!(resolve_node_binary(&[]), PathBuf::from("node"));
    }
}
