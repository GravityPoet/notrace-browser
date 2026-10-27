#!/usr/bin/env python3
"""Exercise the real Bash supervisor using isolated children and HTTP fixtures."""
from __future__ import annotations

import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock
import plistlib
import sys

sys.dont_write_bytecode = True

PACKAGING = Path(__file__).resolve().parent
SCRIPT = PACKAGING / "后台统一授权续期隧道.sh"
spec = importlib.util.spec_from_file_location("broker_tunnel_installer", PACKAGING / "install-broker-tunnel.py")
assert spec and spec.loader
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class TunnelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="notrace-tunnel-fixture-")).resolve()
        self.parent_identity = (self.root.parent.stat().st_dev, self.root.parent.stat().st_ino)
        self.processes: list[subprocess.Popen[str]] = []

    def tearDown(self) -> None:
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=8)
        self.assertEqual(self.parent_identity, (self.root.parent.stat().st_dev, self.root.parent.stat().st_ino))
        identity = self.root.stat()
        if not self.root.name.startswith("notrace-tunnel-fixture-") or self.root.is_symlink():
            raise RuntimeError("invalid isolated fixture")
        command = ["/usr/bin/trash", "-v", str(self.root)] if Path("/usr/bin/trash").is_file() else ["/bin/bash", str(PACKAGING / "recycle-paths.sh"), str(self.root)]
        result = subprocess.run(command,
                                check=True, capture_output=True, text=True)
        receipt = next((line.removeprefix("recovery: ") for line in result.stdout.splitlines() if line.startswith("recovery: ")), None)
        if not receipt:
            match = re.search(r' to "([^"]+)"', result.stdout)
            receipt = match.group(1) if match else None
        self.assertIsNotNone(receipt)
        recovered = Path(receipt).stat()
        self.assertEqual((identity.st_dev, identity.st_ino), (recovered.st_dev, recovered.st_ino))
        self.assertEqual(self.parent_identity, (self.root.parent.stat().st_dev, self.root.parent.stat().st_ino))
        print(f"fixture-recovery={receipt}")

    def start_supervisor(self, health: str = "return 1", ssh: str = 'exec /bin/sleep 120') -> subprocess.Popen[str]:
        driver = self.root / "driver.sh"
        driver.write_text('''#!/bin/bash
set -euo pipefail
source "$1"
tunnel_healthy() { ''' + health + '''; }
tunnel_ssh() { printf 'started\\n' >> "$FIXTURE/starts"; ''' + ssh + '''; }
tunnel_pause() { printf '%s\\n' "$1" >> "$FIXTURE/pauses"; /bin/sleep 0.05; }
tunnel_main
''')
        log = (self.root / "supervisor.log").open("w")
        process = subprocess.Popen(["/bin/bash", str(driver), str(SCRIPT)], text=True, stdout=log, stderr=log,
                                   env={**os.environ, "NOTRACE_VPS_HOST": "fixture.example.com", "FIXTURE": str(self.root)})
        log.close()
        self.processes.append(process)
        return process

    def wait_for(self, path: Path, count: int, log_path: Path | None = None) -> None:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if path.exists() and len(path.read_text().splitlines()) >= count:
                return
            time.sleep(0.03)
        self.fail((log_path or (self.root / "supervisor.log")).read_text())

    def test_alive_child_without_listener_is_replaced_and_unrelated_child_survives(self) -> None:
        unrelated = subprocess.Popen(["/bin/sleep", "120"], text=True)
        self.processes.append(unrelated)
        supervisor = self.start_supervisor()
        self.wait_for(self.root / "starts", 2)
        self.assertIn("连续 3 次健康检查失败", (self.root / "supervisor.log").read_text())
        self.assertIsNone(unrelated.poll())
        children = subprocess.check_output(["/usr/bin/pgrep", "-P", str(supervisor.pid)], text=True).splitlines()
        supervisor.terminate()
        supervisor.wait(timeout=8)
        for child in children:
            self.assertNotEqual(subprocess.run(["/bin/kill", "-0", child], capture_output=True).returncode, 0)
        self.assertIsNone(unrelated.poll())

    def test_failed_starts_back_off_with_a_sixty_second_cap(self) -> None:
        supervisor = self.start_supervisor(ssh="exit 255")
        self.wait_for(self.root / "starts", 6)
        supervisor.terminate(); supervisor.wait(timeout=8)
        pauses = (self.root / "pauses").read_text().splitlines()
        retries = [int(value) for value in pauses if value != "15"]
        self.assertEqual(retries[:5], [5, 10, 20, 40, 60])
        self.assertTrue(all(value <= 60 for value in retries))

    def test_switches_to_the_next_ssh_host_before_backing_off(self) -> None:
        driver = self.root / "fallback-driver.sh"
        driver.write_text('''#!/bin/bash
set -euo pipefail
source "$1"
tunnel_healthy() { [[ -f "$FIXTURE/healthy" ]]; }
tunnel_ssh() {
  printf '%s\\n' "$1" >> "$FIXTURE/hosts"
  if [[ "$1" == primary.example.com ]]; then exit 255; fi
  printf 'healthy\\n' > "$FIXTURE/healthy"
  exec /bin/sleep 120
}
tunnel_pause() { printf '%s\\n' "$1" >> "$FIXTURE/pauses"; /bin/sleep 0.05; }
tunnel_main
''')
        log = (self.root / "fallback.log").open("w")
        process = subprocess.Popen(
            ["/bin/bash", str(driver), str(SCRIPT)],
            text=True,
            stdout=log,
            stderr=log,
            env={
                **os.environ,
                "NOTRACE_VPS_HOSTS": "primary.example.com,backup.example.com",
                "FIXTURE": str(self.root),
            },
        )
        log.close()
        self.processes.append(process)
        self.wait_for(self.root / "healthy", 1, self.root / "fallback.log")
        self.assertEqual((self.root / "hosts").read_text().splitlines()[:2], ["primary.example.com", "backup.example.com"])
        self.assertIn("切换备用入口", (self.root / "fallback.log").read_text())
        process.terminate(); process.wait(timeout=8)

    def test_healthy_existing_endpoint_does_not_spawn_another_ssh(self) -> None:
        supervisor = self.start_supervisor(health="return 0")
        self.wait_for(self.root / "pauses", 3)
        self.assertFalse((self.root / "starts").exists())
        supervisor.terminate(); supervisor.wait(timeout=8)

    def test_health_check_requires_real_json_and_has_a_request_deadline(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(inner) -> None:
                if inner.path == "/slow":
                    time.sleep(4)
                payload = {"ok": True, "api_version": 1} if inner.path == "/healthz" else {"ok": False, "api_version": 1}
                inner.send_response(200); inner.end_headers()
                try:
                    inner.wfile.write(json.dumps(payload).encode())
                except BrokenPipeError:
                    pass

            def log_message(inner, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            for path, expected in [("/healthz", 0), ("/wrong", 1), ("/slow", 1)]:
                start = time.monotonic()
                result = subprocess.run(["/bin/bash", "-c", 'source "$1"; tunnel_healthy "$2"', "fixture", str(SCRIPT),
                                         f"http://127.0.0.1:{server.server_port}{path}"], timeout=5)
                self.assertEqual(result.returncode, expected)
                self.assertLess(time.monotonic() - start, 4)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_installer_retains_only_two_verified_backups_and_atomic_write_preserves_mode(self) -> None:
        script = self.root / "launcher.sh"; plist = self.root / "tunnel.plist"
        backup_root = self.root / "backups"
        plist.write_text("fixture plist")
        for value in [b"one", b"two", b"three"]:
            installer.atomic_write(script, value, 0o700)
            self.assertEqual(script.stat().st_mode & 0o777, 0o700)
            backup = installer.backup_current(backup_root, script, plist)
            self.assertTrue(installer.backup_valid(backup))
            installer.prune_backups(backup_root, backup)
        self.assertEqual(len(list(backup_root.glob("backup-*"))), 2)
        repeated = installer.backup_current(backup_root, script, plist)
        self.assertEqual(repeated, backup)
        self.assertEqual(len(list(backup_root.glob("backup-*"))), 2)

    def test_installer_failure_restores_previous_files_and_loaded_job(self) -> None:
        support = self.root / "Library/Application Support/NoTrace Browser"
        support.mkdir(parents=True)
        script = support / installer.LAUNCHER
        plist = self.root / "Library/LaunchAgents" / f"{installer.LABEL}.plist"
        plist.parent.mkdir(parents=True)
        old_script = b"#!/bin/bash\nexit 0\n"
        old_plist = plistlib.dumps({"Label": installer.LABEL, "ProgramArguments": [str(script)]})
        script.write_bytes(old_script); plist.write_bytes(old_plist)
        calls: list[tuple[str, ...]] = []
        bootstraps = 0
        job_loaded = True

        def fake_run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
            nonlocal bootstraps, job_loaded
            calls.append(args)
            if "print" in args:
                if job_loaded:
                    return subprocess.CompletedProcess(args, 0, stdout=f"program = {script}\n", stderr="")
                return subprocess.CompletedProcess(args, 1, stdout="", stderr="not found")
            if "bootout" in args:
                job_loaded = False
            if "bootstrap" in args:
                bootstraps += 1
                if bootstraps == 1:
                    raise subprocess.CalledProcessError(1, args)
                job_loaded = True
            return subprocess.CompletedProcess(args, 0, stdout=f"program = {script}\n", stderr="")

        with mock.patch.object(installer.Path, "home", return_value=self.root), \
             mock.patch.object(sys, "argv", ["install-broker-tunnel.py", "--host", "fixture.example.com"]), \
             mock.patch.object(installer, "run", side_effect=fake_run):
            with self.assertRaises(subprocess.CalledProcessError):
                installer.main()
        self.assertEqual(script.read_bytes(), old_script)
        self.assertEqual(plist.read_bytes(), old_plist)
        self.assertEqual(bootstraps, 2)
        self.assertEqual(sum("bootout" in args for args in calls), 2)


if __name__ == "__main__":
    unittest.main()
