#!/usr/bin/env python3
"""Bounded verification for already-applied local Chromium overlays.

The full Chromix reverse/forward verifier copies the entire Chromium tree into
scratch. That is useful on a large build host but unsafe on a 16 GiB laptop.
This verifier does not claim full upstream attestation: it checks each local
patch against the live source with GNU patch's zero-fuzz reverse dry-run,
records hashes for touched files, and validates the NoTrace marker/critical
helper files without duplicating the tree.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time


HEADER = re.compile(rb"^(?:---|\+\+\+) (?:[ab]/)?([^\t\n]+)")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def patch_paths(patch: Path) -> list[str]:
    paths: set[str] = set()
    for line in patch.read_bytes().splitlines():
        match = HEADER.match(line)
        if not match:
            continue
        value = match.group(1).decode("utf-8", errors="strict")
        if value != "/dev/null":
            paths.add(value)
    return sorted(paths)


def reverse_dry_run(src: Path, patch: Path) -> tuple[bool, str]:
    command = [
        "gpatch", "-d", str(src), "-p1", "--fuzz=0", "--batch",
        "--reverse", "--dry-run", "-i", str(patch),
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=90,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return False, str(error)
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output[-2000:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repaired", action="store_true")
    parser.add_argument("--patch", action="append", type=Path, required=True)
    args = parser.parse_args()
    src = args.src.resolve()
    if not src.is_dir() or args.output.resolve().is_relative_to(src):
        parser.error("--src must be a directory and --output must be outside it")

    failures: list[str] = []
    patch_reports: list[dict[str, object]] = []
    touched: set[str] = set()
    for patch in args.patch:
        patch = patch.resolve()
        if not patch.is_file():
            failures.append(f"missing patch: {patch}")
            continue
        ok, detail = reverse_dry_run(src, patch)
        paths = patch_paths(patch)
        touched.update(paths)
        patch_reports.append({
            "path": str(patch),
            "reverse_dry_run": ok,
            "detail": detail,
            "touched_paths": paths,
        })
        if not ok:
            failures.append(f"patch reverse dry-run failed: {patch.name}: {detail}")

    required = [
        "base/notrace_render_privacy.h",
        "base/uxr_config.h",
        "base/uxr_config.cc",
        "third_party/blink/renderer/platform/graphics/image_data_buffer.cc",
        "third_party/blink/renderer/core/dom/document.cc",
        "tools/v8_context_snapshot/BUILD.gn",
        "chrome/BUILD.gn",
    ]
    if args.repaired:
        marker = src / ".notrace-custom-native-fingerprint"
        if not marker.is_file():
            failures.append("missing .notrace-custom-native-fingerprint marker")
    for relative in required:
        path = src / relative
        if not path.is_file():
            failures.append(f"missing required source: {relative}")
        else:
            touched.add(relative)

    outputs: dict[str, str] = {}
    for relative in sorted(touched):
        path = src / relative
        if path.is_file():
            outputs[relative] = sha256(path)

    report = {
        "schema_version": 1,
        "status": "verified" if not failures else "failed",
        "method": "bounded-live-reverse-dry-run",
        "qualification": "local overlays and touched-file hashes; not full upstream scratch attestation",
        "repaired": args.repaired,
        "patches": patch_reports,
        "outputs": outputs,
        "failures": failures,
        "created_unix": time.time(),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    print(json.dumps({
        "status": report["status"],
        "method": report["method"],
        "error": failures[0] if failures else None,
        "output": str(args.output),
    }))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
