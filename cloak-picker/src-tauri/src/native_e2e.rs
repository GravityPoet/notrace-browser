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
    const search = await waitFor(() => document.querySelector('input[aria-label="搜索账号"]'), '右侧共享搜索');
    const pane = search.closest('.accountWorkbench');
    const scroll = pane.querySelector('.workbenchBody');
    const bounds = pane.getBoundingClientRect();
    const searchBounds = search.getBoundingClientRect();
    if (scroll.getBoundingClientRect().height < 150 || searchBounds.bottom > bounds.bottom || searchBounds.top < bounds.top) {
      throw new Error('账号工作区被裁切');
    }
    const hit = document.elementFromPoint(searchBounds.x + searchBounds.width / 2, searchBounds.y + searchBounds.height / 2);
    if (hit !== search) throw new Error('共享搜索被其他元素遮挡');
    if (document.querySelectorAll('input[type="search"]').length !== 1) throw new Error('仍有重复账号搜索');
    const firstTool = document.querySelector('#workbench-account-tab');
    if (!firstTool || !document.querySelector('#workbench-broker-tab')) throw new Error('两个账号页签不完整');
    const visibleRangeTabs = Array.from(document.querySelectorAll('.viewSwitch [role="tab"]'));
    if (visibleRangeTabs.length !== 3 || visibleRangeTabs.some(tab => tab.getBoundingClientRect().bottom > tab.parentElement.getBoundingClientRect().bottom)) {
      throw new Error('全环境、活跃或回收站范围入口被裁切');
    }
    checks.push('renewal-pane-visible-search');
    await waitFor(() => document.querySelector('.brokerRow'), '真实 IPC 读取授权列表');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(search, 'native-e2e-account');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('.brokerRow').length === 1 && pane.querySelector('h1')?.textContent === 'native-e2e-account', '搜索精确账号');
    const authorize = Array.from(document.querySelectorAll('.brokerRow button')).find(e => e.textContent.trim() === '授权并纳管');
    if (!authorize || authorize.disabled) throw new Error('搜索结果未提供可点击的授权操作');
    authorize.click();
    await waitFor(() => document.querySelector('.brokerRowFeedback[role="alert"]')?.textContent.includes('上游席位已占满'), '浏览器席位错误显示');
    if (authorize.disabled) await waitFor(() => !authorize.disabled, '授权失败后恢复重试');
    checks.push('renewal-search-authorize-seat-error');
    setter.call(search, 'native-e2e-sync-account');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const syncRow = await waitFor(() => {
      const rows = document.querySelectorAll('.brokerRow');
      return rows.length === 1 && rows[0].textContent.includes('待同步新凭据') ? rows[0] : null;
    }, '新授权等待手动同步');
    const syncButton = (label) => Array.from(syncRow.querySelectorAll('button')).find(e => e.textContent.trim() === label);
    if (syncButton('暂停 CPA 同步')) throw new Error('新授权误显示为正在自动同步');
    const readyToSync = await waitFor(() => {
      const button = syncButton('同步到 CPA');
      return button && !button.disabled ? button : null;
    }, '授权结束后恢复同步入口');
    readyToSync.click();
    await waitFor(() => syncButton('同步中…')?.disabled, '显示同步进度');
    const retry = await waitFor(() => syncButton('重试同步'), '同步失败提供重试');
    if (!pane.querySelector('[role="alert"]')?.textContent.includes('服务器文件读写失败')) {
      throw new Error('同步失败没有展示具体原因');
    }
    await waitFor(() => !retry.disabled, '同步失败恢复操作');
    retry.click();
    await waitFor(() => syncButton('暂停 CPA 同步') && Array.from(syncRow.querySelectorAll('.brokerStatus > span')).some(e => e.textContent === 'CPA已同步'), '重试成功后开启自动同步');
    if (pane.querySelector('[role="alert"]')) throw new Error('同步成功后仍显示旧错误');
    checks.push('cpa-sync-pending-retry-success');
    const verifyHeaderLaunch = async (name, temporary) => {
      setter.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const row = await waitFor(() => document.querySelector(`.accountRow[data-account-name="${name}"]`), '左侧启动账号');
      row.click();
      const header = document.querySelector('.workbenchAccountHeader');
      const label = temporary ? '临时启动' : '启动';
      const button = await waitFor(() => {
        const candidate = header?.querySelector('.launchButton');
        return header?.querySelector('h1')?.textContent === name && candidate?.textContent.trim() === label && !candidate.disabled ? candidate : null;
      }, '右上角直接启动入口');
      const bounds = button.getBoundingClientRect();
      const headerBounds = header.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      if (bounds.right > headerBounds.right || headerBounds.right - bounds.right > 30 || bounds.top < headerBounds.top || bounds.bottom > headerBounds.bottom || !button.contains(hit)) {
        throw new Error('右上角启动按钮被裁切、折叠或遮挡');
      }
      button.click();
      await waitFor(() => header.querySelector('.launchStatus')?.textContent.trim() === '启动失败，可重试', '真实启动命令反馈');
      if (temporary) {
        const trashed = await invoke('list_trashed_accounts');
        if (!trashed.some(account => account.name === name)) throw new Error('临时启动恢复了回收站账号');
        const currentRow = await waitFor(() => document.querySelector(`.accountRow[data-account-name="${name}"]`), '启动后的当前账号行');
        const rowBounds = currentRow.getBoundingClientRect();
        currentRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rowBounds.left + 20, clientY: rowBounds.top + 10 }));
        const menu = await waitFor(() => document.querySelector('.accountContextMenu'), '一级账号右键菜单');
        const restore = Array.from(menu.querySelectorAll('button')).find(control => control.textContent.trim() === '恢复');
        if (!restore || restore.disabled || restore.closest('.accountGroupSubmenu')) throw new Error('恢复未直接显示在一级右键菜单');
        if (!Array.from(menu.querySelectorAll('button')).some(control => control.textContent.trim() === '彻底删除')) throw new Error('回收站右键菜单缺少彻底删除');
        restore.click();
        await waitFor(() => document.querySelector('#cloak-account-active-tab[aria-selected="true"]') && header.querySelector('h1')?.textContent === name && !header.textContent.includes('临时启动'), '从授权页恢复账号并保留选中');
        const restored = await invoke('list_accounts');
        if (!restored.some(account => account.name === name)) throw new Error('账号未实际恢复到活跃列表');
        if (document.querySelector('.brokerAuthStatus')?.textContent.includes('回收站账号')) throw new Error('恢复后授权页仍显示旧回收站状态');
      }
    };
    await verifyHeaderLaunch('native-e2e-account', false);
    document.querySelector('#cloak-account-trash-tab').click();
    await verifyHeaderLaunch('native-e2e-sync-account', true);
    checks.push('renewal-header-active-and-trash-launch');
    document.querySelector('#cloak-account-active-tab').click();
    await waitFor(() => document.querySelector('.accountRow[data-account-name="native-e2e-account"]'), '恢复活跃列表').then(row => row.click());
    firstTool.click();
    await waitFor(() => !document.querySelector('#workbench-details').hidden && document.querySelector('#workbench-authorization').hidden, '共享账号资料页签');
    if (getComputedStyle(document.querySelector('#workbench-authorization')).display !== 'none') throw new Error('授权页没有随页签隐藏');
    if (pane.querySelector('h1')?.textContent !== 'native-e2e-account') throw new Error('切换资料时账号改变');
    if (!document.querySelector('button[aria-label="读取授权状态"]')) throw new Error('资料页没有保留共享状态入口');
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

    tabKey(trashTab, 'ArrowLeft');
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
    // Reproduce the hosted macOS WebView behavior where Clipboard API exposes
    // writeText but leaves its promise pending. This forces the native pbcopy
    // bridge instead of allowing a local runner's Clipboard implementation to
    // make the gate pass without exercising the recovery path.
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: () => new Promise(() => {}),
        });
      } catch (_) {
        try {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { ...navigator.clipboard, writeText: () => new Promise(() => {}) },
          });
        } catch (_) {}
      }
    }
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

    const closeButton = await waitFor(
      () => document.querySelector('button[aria-label="强制关闭所有 CloakBrowser 窗口"]'),
      '强制关闭所有窗口入口',
    );
    const closeBounds = closeButton.getBoundingClientRect();
    if (closeBounds.width < 60 || closeBounds.right > window.innerWidth || closeBounds.left < 0) {
      throw new Error('强制关闭按钮没有完整显示');
    }
    closeButton.focus();
    closeButton.click();
    await waitFor(
      () => document.body.textContent.includes('本机已无 CloakBrowser 窗口及后台进程') && !closeButton.disabled,
      '原生关闭命令与零进程结果',
    );
    if (!document.querySelector('.browserProcessCount')?.textContent.includes('运行中 0')) {
      throw new Error('关闭后运行状态没有归零');
    }
    checks.push('close-all-native-command');

    const accountRow = document.querySelector('.accountRow[data-account-name="native-e2e-account"]');
    const accountBounds = accountRow.getBoundingClientRect();
    accountRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: accountBounds.left + 20, clientY: accountBounds.top + 10 }));
    const accountMenu = await waitFor(() => document.querySelector('.accountContextMenu'), '紧凑账号菜单');
    const moveGroup = Array.from(accountMenu.querySelectorAll('button')).find(button => button.textContent.trim() === '移动分组');
    if (!moveGroup || document.querySelector('.accountGroupSubmenu')) throw new Error('分组未收纳为子菜单入口');
    moveGroup.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const groupMenu = await waitFor(() => document.querySelector('.accountGroupSubmenu'), '悬停打开分组子菜单');
    await waitFor(() => Number(getComputedStyle(groupMenu).opacity) > 0.9, '分组子菜单展开动画');
    const flyoutBounds = groupMenu.getBoundingClientRect();
    if (flyoutBounds.left < 0 || flyoutBounds.top < 0 || flyoutBounds.right > innerWidth || flyoutBounds.bottom > innerHeight) throw new Error('分组子菜单越出窗口');
    const codexGroup = Array.from(groupMenu.querySelectorAll('button')).find(button => button.textContent.trim() === 'codex');
    if (!codexGroup) throw new Error('子菜单缺少实际分组');
    codexGroup.click();
    await waitFor(() => !document.querySelector('.accountContextMenu') && document.querySelector('.accountRow[data-account-name="native-e2e-account"]')?.dataset.accountGroup === 'codex', '右键移动分组完成');
    if (!(await invoke('list_accounts')).some(account => account.name === 'native-e2e-account' && account.group === 'codex')) throw new Error('分组未实际保存');
    if (document.querySelector('.sidebarManageButton')) throw new Error('重复管理入口仍然存在');
    checks.push('account-context-submenu-and-restore');

    const multiSelect = await waitFor(() => {
      const button = document.querySelector('.sidebarSelectButton');
      return button && !button.disabled ? button : null;
    }, '多选入口');
    multiSelect.click();
    await waitFor(() => document.querySelectorAll('.accountRow.selectionMode').length === 2, '多选账号列表');
    document.querySelectorAll('.accountRow.selectionMode').forEach(row => row.click());
    await waitFor(() => document.querySelectorAll('.bulkSelectedPreview li').length === 2, '完整所选账号预览');
    const bulkActions = document.querySelectorAll('.bulkActionButton');
    if (bulkActions.length < 3 || Array.from(bulkActions).some(button => button.getBoundingClientRect().height < 72)) throw new Error('批量操作按钮过小或缺失');
    const exitSelection = Array.from(document.querySelectorAll('.bulkWorkspace button')).find(button => button.textContent.trim() === '退出多选');
    if (!exitSelection) throw new Error('批量工作区没有退出入口');
    exitSelection.click();
    await waitFor(() => !document.querySelector('.bulkWorkspace'), '退出多选');
    checks.push('bulk-workspace-large-actions');

    const visibleTools = Array.from(document.querySelectorAll('.workspaceTool strong'))
      .map((node) => node.textContent?.trim())
      .filter(Boolean);
    for (const label of ['工作区备份', '管理分组', '管理标签']) {
      if (!visibleTools.includes(label)) throw new Error(`首屏工具栏缺少：${label}`);
    }
    checks.push('workspace-tools-visible');

    const visibleWorkspaceButton = Array.from(document.querySelectorAll('.workspaceTool'))
      .find((button) => button.textContent?.includes('工作区备份'));
    const workspaceButton = visibleWorkspaceButton ?? (() => {
      const manageButton = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim().startsWith('管理'),
      );
      if (!manageButton) throw new Error('找不到管理菜单按钮');
      manageButton.click();
      return null;
    })();
    const workspaceEntry = workspaceButton ?? await waitFor(
      () => Array.from(document.querySelectorAll('[role="menuitem"]')).find(
        (button) => button.textContent?.includes('工作区备份'),
      ),
      '工作区备份入口',
    );
    workspaceEntry.click();
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
