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

pub fn restore_background(app: &tauri::AppHandle, previous: Option<i32>) -> bool {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        if app
            .run_on_main_thread(move || {
                let _ = sender.send(hide_once(previous));
            })
            .is_err()
        {
            return false;
        }
        receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, previous);
        false
    }
}

#[cfg(target_os = "macos")]
fn hide_once(previous: Option<i32>) -> bool {
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
        return false;
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
    requested
}
