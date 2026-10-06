"""Regression coverage for the multi-section patch-normalization memory loop."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "verify-source.py"
SPEC = importlib.util.spec_from_file_location("verify_source", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class NormalizePatchTest(unittest.TestCase):
    def test_two_sections_and_new_file_complete_with_bounded_output(self) -> None:
        patch = (b"--- a/one.cc\n+++ b/one.cc\n@@ -1 +1 @@\n-a\n+b\n"
                 b"--- /dev/null\n+++ b/two.h\n@@ -0,0 +1 @@\n+c\n")
        expected = (b"diff --git a/one.cc b/one.cc\n"
                    + patch.split(b"--- /dev/null")[0]
                    + b"diff --git a/two.h b/two.h\n--- /dev/null"
                    + patch.split(b"--- /dev/null")[1])
        probe = (
            "import importlib.util,sys; "
            "s=importlib.util.spec_from_file_location('v',sys.argv[1]); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "sys.stdout.buffer.write(m.normalize_unified_patch(sys.stdin.buffer.read()))"
        )
        # Run out of process with a deadline. A recurrence fails the test rather
        # than holding the entire suite in an unbounded append loop.
        result = subprocess.run([sys.executable, "-c", probe, str(SCRIPT)],
                                input=patch, capture_output=True, timeout=2,
                                check=True)
        self.assertEqual(result.stdout, expected)

    def test_existing_git_diff_unchanged(self) -> None:
        patch = b"diff --git a/one b/one\n--- a/one\n+++ b/one\n"
        self.assertEqual(MODULE.normalize_unified_patch(patch), patch)

    def test_rejects_missing_plus_header(self) -> None:
        with self.assertRaises(ValueError):
            MODULE.normalize_unified_patch(b"--- a/one\nnot a plus header\n")

    def test_real_rendering_overlay_has_one_header_per_file(self) -> None:
        patch = SCRIPT.parent / "patches/0007-stable-native-rendering.patch"
        raw = patch.read_bytes()
        result = MODULE.normalize_unified_patch(raw)
        sections = sum(line.startswith(b"--- ") for line in raw.splitlines())
        self.assertEqual(result.count(b"diff --git "), sections)
        self.assertLess(len(result), len(raw) * 2)


if __name__ == "__main__":
    unittest.main()
