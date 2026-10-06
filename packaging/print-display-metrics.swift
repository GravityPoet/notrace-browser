#!/usr/bin/swift
import CoreGraphics

// Logical points, not physical Retina pixels: match CSS device dimensions.
let bounds = CGDisplayBounds(CGMainDisplayID())
guard bounds.width.isFinite, bounds.height.isFinite,
      (1...16384).contains(bounds.width), (1...16384).contains(bounds.height) else {
    fputs("无法读取主显示器尺寸\n", stderr)
    exit(1)
}
print("\(Int(bounds.width.rounded())) \(Int(bounds.height.rounded()))")
