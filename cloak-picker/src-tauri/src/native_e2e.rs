use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

const REPORT_ENV: &str = "CLOAK_PICKER_NATIVE_E2E_REPORT";

#[derive(Serialize)]
struct NativeE2eReport {
    passed: bool,
    checks: Vec<String>,
    error: Option<String>,
}

pub(crate) fn enabled() -> bool {
    std::env::var_os(REPORT_ENV).is_some()
}

pub(crate) fn schedule(app: tauri::AppHandle) {
    if !enabled() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(350));
        let app_for_main_thread = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = app_for_main_thread.get_webview_window("main") {
                if let Err(error) = window.eval(NATIVE_E2E_DRIVER) {
                    let _ =
                        write_report(Vec::new(), Some(format!("注入原生 E2E 驱动失败：{error}")));
                }
            } else {
                let _ = write_report(Vec::new(), Some("原生主窗口不存在".to_string()));
            }
        });
    });
}

pub(crate) fn write_report(checks: Vec<String>, error: Option<String>) -> Result<(), String> {
    let path = report_path()?;
    let report = NativeE2eReport {
        passed: error.is_none(),
        checks,
        error,
    };
    let body = serde_json::to_vec_pretty(&report)
        .map_err(|err| format!("序列化原生 E2E 报告失败：{err}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "原生 E2E 报告路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("创建原生 E2E 报告目录失败：{err}"))?;

    let temporary = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|err| format!("创建原生 E2E 临时报告失败：{err}"))?;
    file.write_all(&body)
        .and_then(|_| file.sync_all())
        .map_err(|err| format!("写入原生 E2E 报告失败：{err}"))?;
    set_private_file(&temporary)?;
    fs::rename(&temporary, &path).map_err(|err| format!("提交原生 E2E 报告失败：{err}"))?;
    sync_directory(parent)?;
    Ok(())
}

fn report_path() -> Result<PathBuf, String> {
    let path = std::env::var_os(REPORT_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| "原生 E2E 模式未启用".to_string())?;
    if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("原生 E2E 报告必须是绝对 .json 路径".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !file_name.starts_with("cloak-picker-native-e2e-") {
        return Err("原生 E2E 报告文件名不在允许范围内".to_string());
    }
    let temporary_root = fs::canonicalize(std::env::temp_dir())
        .map_err(|err| format!("解析系统临时目录失败：{err}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "原生 E2E 报告路径缺少父目录".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .or_else(|_| {
            fs::create_dir_all(parent)?;
            fs::canonicalize(parent)
        })
        .map_err(|err| format!("解析原生 E2E 报告目录失败：{err}"))?;
    if !canonical_parent.starts_with(&temporary_root) {
        return Err("原生 E2E 报告只能写入系统临时目录".to_string());
    }
    Ok(path)
}

fn set_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("设置原生 E2E 报告权限失败：{err}"))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn sync_directory(path: &Path) -> Result<(), String> {
    use std::ffi::c_int;
    use std::os::fd::AsRawFd;

    const F_FULLFSYNC: c_int = 51;
    unsafe extern "C" {
        fn fcntl(file_descriptor: c_int, command: c_int, ...) -> c_int;
    }

    let directory =
        fs::File::open(path).map_err(|err| format!("打开原生 E2E 报告目录失败：{err}"))?;
    // SAFETY: directory remains open during the call and F_FULLFSYNC takes no
    // third argument. macOS does not support fsync(2) on a directory descriptor.
    if unsafe { fcntl(directory.as_raw_fd(), F_FULLFSYNC) } == -1 {
        return Err(format!(
            "同步原生 E2E 报告目录失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|err| format!("同步原生 E2E 报告目录失败：{err}"))
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> Result<(), String> {
    Ok(())
}

const NATIVE_E2E_DRIVER: &str = r#"
(async () => {
  const checks = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (read, label, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`等待超时：${label}`);
  };
  const tabKey = (element, key) => element.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  }));
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  try {
    const activeTab = await waitFor(
      () => document.querySelector('#cloak-account-active-tab[aria-selected="true"]'),
      '活跃账号 tab',
    );
    const activePanel = document.getElementById(activeTab.getAttribute('aria-controls'));
    if (!activePanel || activePanel.getAttribute('role') !== 'tabpanel' || activePanel.hidden) {
      throw new Error('活跃账号 tab 的 aria-controls 未指向可见面板');
    }
    checks.push('account-tab-aria-controls');

    activeTab.focus();
    tabKey(activeTab, 'ArrowRight');
    const trashTab = await waitFor(
      () => document.querySelector('#cloak-account-trash-tab[aria-selected="true"]'),
      '回收站键盘切换',
    );
    if (document.activeElement !== trashTab || trashTab.tabIndex !== 0) {
      throw new Error('回收站 tab 未取得 roving focus');
    }
    const trashPanel = document.getElementById(trashTab.getAttribute('aria-controls'));
    if (!trashPanel || trashPanel.hidden) throw new Error('回收站面板未随键盘切换显示');
    checks.push('account-tab-keyboard-focus');

    tabKey(trashTab, 'Home');
    await waitFor(
      () => document.querySelector('#cloak-account-active-tab[aria-selected="true"]'),
      '返回活跃账号 tab',
    );
    const pathButton = await waitFor(
      () => document.querySelector('button[aria-label="复制账号目录"]'),
      '账号目录复制按钮',
    );
    const pathValue = pathButton.closest('.infoValueControl')?.querySelector('.infoValue');
    if (!pathValue || !pathValue.title || pathValue.textContent !== pathValue.title) {
      throw new Error('账号目录没有保留完整路径供省略显示和复制');
    }
    const pathStyle = getComputedStyle(pathValue);
    if (pathStyle.textOverflow !== 'ellipsis' || pathStyle.whiteSpace !== 'nowrap'
        || pathValue.scrollWidth <= pathValue.clientWidth) {
      throw new Error('长账号目录没有在真实 WebView 中以省略号收纳');
    }
    checks.push('path-ellipsis-copy-source');
    pathButton.click();
    await waitFor(
      () => pathButton.getAttribute('aria-label') === '已复制账号目录',
      '账号目录复制动作',
    );
    checks.push('path-copy-action');

    const runtimeRow = await waitFor(() => {
      const row = Array.from(document.querySelectorAll('.infoRow')).find(
        (candidate) => candidate.querySelector('.infoLabel')?.textContent?.trim() === '运行时来源',
      );
      return row && row.querySelector('.infoValue')?.textContent?.trim() !== '未解析' ? row : null;
    }, '运行时来源解析完成');
    const runtimeText = runtimeRow.querySelector('.infoValue')?.textContent ?? '';
    if (!runtimeText.includes('上游源缓存') || !runtimeText.includes('SHA-256 已验证')) {
      throw new Error(`运行时来源没有准确显示源缓存 provenance：${runtimeText}`);
    }
    checks.push('runtime-source-provenance');

    const manageButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim().startsWith('管理'),
    );
    if (!manageButton) throw new Error('找不到管理菜单按钮');
    manageButton.click();
    const workspaceButton = await waitFor(
      () => Array.from(document.querySelectorAll('[role="menuitem"]')).find(
        (button) => button.textContent?.includes('工作区备份'),
      ),
      '工作区备份菜单项',
    );
    workspaceButton.click();
    const exportTab = await waitFor(
      () => document.querySelector('#cloak-workspace-export-tab[aria-selected="true"]'),
      '导出备份 tab',
    );
    const exportPanel = document.getElementById(exportTab.getAttribute('aria-controls'));
    if (!exportPanel || exportPanel.hidden) throw new Error('导出 tab 未关联可见面板');
    exportTab.focus();
    tabKey(exportTab, 'End');
    const importTab = await waitFor(
      () => document.querySelector('#cloak-workspace-import-tab[aria-selected="true"]'),
      '导入恢复键盘切换',
    );
    const importPanel = document.getElementById(importTab.getAttribute('aria-controls'));
    if (document.activeElement !== importTab || !importPanel || importPanel.hidden || importTab.tabIndex !== 0) {
      throw new Error('迁移 tab 的键盘焦点或 aria-controls 关联失败');
    }
    checks.push('migration-tab-keyboard-aria-controls');

    await invoke('complete_native_e2e', { checks, error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await invoke('complete_native_e2e', { checks, error: message });
  }
})().catch(() => {});
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_e2e_report_path_is_disabled_without_explicit_environment() {
        let previous = std::env::var_os(REPORT_ENV);
        std::env::remove_var(REPORT_ENV);
        assert!(report_path().is_err());
        if let Some(previous) = previous {
            std::env::set_var(REPORT_ENV, previous);
        }
    }
}
