//! AppKit window work belongs to the Picker's main event thread, not the
//! blocking Broker/HTTP worker. No credential data enters this module.

pub async fn foreground_pid(app: &tauri::AppHandle) -> Option<i32> {
    #[cfg(target_os = "macos")]
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        app.run_on_main_thread(move || {
            let pid = objc2_app_kit::NSWorkspace::sharedWorkspace()
                .frontmostApplication()
                .map(|application| application.processIdentifier());
            let _ = sender.try_send(pid);
        })
        .ok()?;
        receiver.recv().await.flatten()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

pub fn restore_background(
    app: &tauri::AppHandle,
    previous: Option<i32>,
) -> Result<(), &'static str> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        if app
            .run_on_main_thread(move || {
                let _ = sender.send(hide_once(previous));
            })
            .is_err()
        {
            return Err("无法调度 Cockpit 窗口处理");
        }
        let outcome = receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap_or(Err("Cockpit 窗口处理未及时返回"));
        if outcome.is_ok() {
            return outcome;
        }
        // open -j may already have hidden the app while AppKit still reports
        // its previous state. Observe on later main-loop turns; never repeat
        // the hide or activation operation merely to confirm it.
        for _ in 0..3 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let (sender, receiver) = std::sync::mpsc::channel();
            if app
                .run_on_main_thread(move || {
                    let _ = sender.send(cockpit_is_hidden());
                })
                .is_err()
            {
                break;
            }
            if receiver
                .recv_timeout(std::time::Duration::from_millis(250))
                .unwrap_or(false)
            {
                return Ok(());
            }
        }
        outcome
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, previous);
        Err("当前系统不支持后台窗口处理")
    }
}

#[cfg(target_os = "macos")]
fn cockpit_is_hidden() -> bool {
    let apps = objc2_app_kit::NSWorkspace::sharedWorkspace().runningApplications();
    (0..apps.count())
        .map(|index| apps.objectAtIndex(index))
        .any(|application| {
            application
                .executableURL()
                .and_then(|url| url.path())
                .is_some_and(|path| {
                    path.to_string()
                        == "/Applications/Cockpit Tools.app/Contents/MacOS/cockpit-tools"
                })
                && application.isHidden()
        })
}

#[cfg(target_os = "macos")]
fn hide_once(previous: Option<i32>) -> Result<(), &'static str> {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
    let apps = NSWorkspace::sharedWorkspace().runningApplications();
    let Some(cockpit) = (0..apps.count())
        .map(|index| apps.objectAtIndex(index))
        .find(|application| {
            application
                .executableURL()
                .and_then(|url| url.path())
                .is_some_and(|path| {
                    path.to_string()
                        == "/Applications/Cockpit Tools.app/Contents/MacOS/cockpit-tools"
                })
        })
    else {
        return Err("未找到官方 Cockpit 的运行实例，未处理窗口");
    };
    let was_active = cockpit.isActive();
    let requested = cockpit.isHidden() || cockpit.hide();
    // Restore only the app displaced by this import, never the Picker over a
    // different foreground app. Even a refused hide must not trap the user.
    if was_active {
        if let Some(previous) = previous
            .filter(|pid| *pid != cockpit.processIdentifier())
            .and_then(NSRunningApplication::runningApplicationWithProcessIdentifier)
        {
            previous.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    }
    if requested {
        Ok(())
    } else {
        Err("macOS 未接受 Cockpit 隐藏请求；已尝试恢复原前台")
    }
}
