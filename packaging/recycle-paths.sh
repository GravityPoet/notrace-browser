#!/bin/bash
set -euo pipefail

# Use the OS Trash API on older supported macOS releases as well as hosts
# providing the native trash CLI. Callers validate the exact owned targets.
if [[ -x /usr/bin/trash ]]; then
  exec /usr/bin/trash "$@"
fi
exec /usr/bin/xcrun swift - "$@" <<'SWIFT'
import Foundation
import Darwin

let manager = FileManager.default
let protected = Set(["/", NSHomeDirectory(), "/Applications", "/Users", "/Library",
                     "/System", "/private", "/private/tmp",
                     manager.temporaryDirectory.resolvingSymlinksInPath().path])
for path in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    guard path.hasPrefix("/"), !protected.contains(url.path) else {
        fputs("refusing to recycle a broad directory\n", stderr)
        exit(1)
    }
    do {
        var recovery: NSURL?
        try manager.trashItem(at: url, resultingItemURL: &recovery)
        guard let recovery = recovery else { exit(1) }
        print("recovery: \(recovery.path ?? "unknown")")
    } catch {
        fputs("Trash operation failed; source retained where possible\n", stderr)
        exit(1)
    }
}
SWIFT
