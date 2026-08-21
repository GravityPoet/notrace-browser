#!/usr/bin/swift

import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]),
      pid > 0 else {
    fputs("用法：picker-native-window-check.swift <pid>\n", stderr)
    exit(2)
}

let deadline = Date().addingTimeInterval(20)
while Date() < deadline {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    let found = windows.contains { window in
        guard let ownerPid = window[kCGWindowOwnerPID as String] as? NSNumber,
              ownerPid.int32Value == pid,
              let layer = window[kCGWindowLayer as String] as? NSNumber,
              layer.intValue == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? NSNumber,
              let height = bounds["Height"] as? NSNumber else {
            return false
        }
        return width.doubleValue >= 760 && height.doubleValue >= 540
    }
    if found {
        print("native window verified: pid=\(pid)")
        exit(0)
    }
    Thread.sleep(forTimeInterval: 0.1)
}

fputs("未找到 PID \(pid) 对应的可见 macOS 主窗口\n", stderr)
exit(1)
