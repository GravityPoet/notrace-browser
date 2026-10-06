#!/usr/bin/env python3
"""Verify public and NoTrace hunks in scratch; never rewrite live source."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys


def normalize_unified_patch(data: bytes) -> bytes:
    """Add Git section headers to the repo's legacy multi-file unified diff.

    The local rendering overlay predates the Chromix verifier and intentionally
    uses repeated `---/+++` sections. The verifier's transformer needs a
    section header to keep path/action accounting. This changes only the
    disposable verifier input; the checked-in patch and live source bytes stay
    untouched.
    """
    if data.startswith(b"diff --git "):
        return data
    lines = data.splitlines(keepends=True)
    out: list[bytes] = []
    index = 0
    while index < len(lines):
        if (not lines[index].startswith(b"--- ") or index + 1 >= len(lines)
                or not lines[index + 1].startswith(b"+++ ")):
            raise ValueError("legacy patch has a malformed file header")
        old = lines[index][4:].strip()
        new = lines[index + 1][4:].strip()
        if old == b"/dev/null":
            if not new.startswith(b"b/"):
                raise ValueError("legacy create patch has an invalid target path")
            old_path = new[2:]
            new_path = old_path
        elif new == b"/dev/null":
            if not old.startswith(b"a/"):
                raise ValueError("legacy delete patch has an invalid source path")
            old_path = old[2:]
            new_path = old_path
        else:
            if not old.startswith(b"a/") or not new.startswith(b"b/"):
                raise ValueError("legacy patch has an invalid path prefix")
            old_path = old[2:]
            new_path = new[2:]
        out.append(b"diff --git a/" + old_path + b" b/" + new_path + b"\n")
        # Consume both file headers before looking for the next section. The
        # previous loop stopped immediately at the second --- header forever,
        # repeatedly appending a Git header until the host exhausted memory.
        out.extend(lines[index:index + 2])
        index += 2
        while index < len(lines):
            if lines[index].startswith(b"--- "):
                break
            out.append(lines[index])
            index += 1
    return b"".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repaired", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    work = root / ".build/native-engine/work"
    repo = root / ".build/native-engine/upstream/chromix"
    sys.path.insert(0, str(repo / "tools"))
    import verify_patch_stack as upstream
    import apply_restored_patches as arp

    original_load = upstream.load_stack
    patch = root / "packaging/native-engine/patches/0007-stable-native-rendering.patch"
    linker_patch = root / "packaging/native-engine/patches/0008-v8-context-snapshot-no-compact-unwind.patch"
    framework_patch = root / "packaging/native-engine/patches/0009-chromium-framework-no-compact-unwind.patch"
    warning_patch = root / "packaging/native-engine/patches/0010-native-rendering-warning-cleanup.patch"

    def load_stack(*positional: object, **keywords: object) -> tuple[dict, list]:
        identity, patches = original_load(*positional, **keywords)
        local_patches = [
            root / "packaging/native-engine/patches/0003-bindgen-macos-sdk-linker.patch",
            linker_patch,
            framework_patch,
        ]
        if args.repaired:
            local_patches.append(patch)
            local_patches.append(warning_patch)
        local_identity: dict[str, str] = {}
        for local_patch in local_patches:
            raw = local_patch.read_bytes()
            if local_patch.name == patch.name:
                raw = normalize_unified_patch(raw)
            transformed, entries = arp.transform_patch(raw, set(), [])
            local_identity[local_patch.name] = hashlib.sha256(local_patch.read_bytes()).hexdigest()
            patches.append((local_patch.name, transformed, entries))
        identity = {"public_stack": identity, "local_patch_sha256": local_identity}
        return identity, patches

    upstream.load_stack = load_stack
    try:
        report = upstream.verify(
            work / "src", repo, core=work / "tooling/ungoogled-chromium",
            tooling=work / "tooling/ungoogled-chromium-macos", platform="macos")
    except (ValueError, OSError, arp.ApplyError) as error:
        report = {"status": "failed", "error": str(error)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    print(json.dumps({"status": report["status"], "repaired": args.repaired,
                      "error": report.get("error"), "output": str(args.output)}))
    return int(report["status"] != "verified")


if __name__ == "__main__":
    raise SystemExit(main())
