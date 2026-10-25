#!/usr/bin/env python3
"""Install or restore the existing user's Broker tunnel without touching grants."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LABEL = "com.notrace-browser.broker-tunnel"
LAUNCHER = "后台统一授权续期隧道.sh"


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=15)


def recycle(path: Path) -> None:
    run("/bin/bash", str(ROOT / "packaging/recycle-paths.sh"), str(path))


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    if path.is_symlink():
        raise RuntimeError("拒绝覆盖符号链接")
    staging = path.with_name(f".{path.name}.staging-{os.getpid()}")
    try:
        with staging.open("xb") as stream:
            os.chmod(staging, mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staging, path)
    finally:
        if staging.exists():
            recycle(staging)


def backup_valid(path: Path) -> bool:
    try:
        if path.is_symlink() or not path.is_dir():
            return False
        manifest = json.loads((path / "manifest.json").read_text())
        return isinstance(manifest, dict) and bool(manifest) and all(
            name in {LAUNCHER, "tunnel.plist"}
            and hashlib.sha256((path / name).read_bytes()).hexdigest() == digest
            for name, digest in manifest.items()
        )
    except (OSError, ValueError):
        return False


def backup_current(root: Path, script: Path, plist: Path) -> Path | None:
    existing = {name: path for name, path in [(LAUNCHER, script), ("tunnel.plist", plist)] if path.is_file()}
    if not existing:
        print("备份：首次安装，无旧配置")
        return None
    manifest = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in existing.items()}
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    previous = [p for p in sorted(root.glob("backup-*"), reverse=True) if backup_valid(p)]
    if previous:
        candidate = previous[0]
        if json.loads((candidate / "manifest.json").read_text()) == manifest:
            print(f"备份：复用 {candidate}")
            return candidate
    backup = root / f"backup-{time.time_ns()}"
    backup.mkdir(mode=0o700)
    try:
        for name, path in existing.items():
            shutil.copy2(path, backup / name)
        (backup / "manifest.json").write_text(json.dumps(manifest))
        os.chmod(backup / "manifest.json", 0o600)
        if not backup_valid(backup):
            raise RuntimeError("隧道备份校验失败")
    except Exception:
        recycle(backup)
        raise
    print(f"备份：{backup}")
    return backup


def prune_backups(root: Path, protected: Path | None) -> None:
    valid = [p for p in sorted(root.glob("backup-*"), reverse=True) if backup_valid(p)]
    keep = set(valid[:2])
    if protected and protected not in keep:
        raise RuntimeError("当前回滚引用不在最新两份备份中，停止清理")
    for path in valid:
        if path not in keep:
            recycle(path)
    retained = [p for p in root.glob("backup-*") if backup_valid(p)]
    if len(retained) > 2:
        raise RuntimeError("隧道有效备份超过两份")
    print(f"有效备份：{len(retained)} 份")


def healthy() -> bool:
    try:
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with client.open("http://127.0.0.1:18555/healthz", timeout=3) as response:
            payload = json.loads(response.read(4097))
        return isinstance(payload, dict) and payload.get("ok") is True and payload.get("api_version") == 1
    except (OSError, ValueError):
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", help="已有 SSH 别名；后续升级从原 plist 读取")
    parser.add_argument("--rollback", type=Path, help="恢复经过校验的隧道备份目录")
    args = parser.parse_args()
    support = Path.home() / "Library/Application Support/NoTrace Browser"
    plist = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
    script = support / LAUNCHER
    backup_root = support / "Recovery/BrokerTunnel"
    for path in [support, script, plist, backup_root]:
        if path.is_symlink():
            raise RuntimeError("隧道安装路径不能是符号链接")
    original = {path: path.read_bytes() for path in [script, plist] if path.is_file()}
    previous_plist = plistlib.loads(original[plist]) if plist in original else {}
    host = args.host or previous_plist.get("EnvironmentVariables", {}).get("NOTRACE_VPS_HOST")
    target = f"gui/{os.getuid()}/{LABEL}"
    current_state = run("/bin/launchctl", "print", target, check=False)
    loaded = current_state.returncode == 0
    if args.rollback:
        rollback = args.rollback.resolve()
        if rollback.parent != backup_root.resolve() or not backup_valid(rollback):
            raise RuntimeError("回滚目录或备份校验无效")
        source = (rollback / LAUNCHER).read_bytes()
        payload = (rollback / "tunnel.plist").read_bytes()
        config = plistlib.loads(payload)
    else:
        if not host or not re.fullmatch(r"[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*", host):
            raise RuntimeError("请通过 --host 提供已有 SSH 别名")
        source = (ROOT / "packaging" / LAUNCHER).read_bytes()
        config = {
            **previous_plist,
            "Label": LABEL,
            "ProgramArguments": [str(script)],
            "EnvironmentVariables": {**previous_plist.get("EnvironmentVariables", {}), "NOTRACE_VPS_HOST": host},
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 10,
            "ProcessType": "Background",
            "StandardOutPath": str(support / "broker-tunnel.out.log"),
            "StandardErrorPath": str(support / "broker-tunnel.err.log"),
        }
        payload = plistlib.dumps(config)
    if config.get("Label") != LABEL or config.get("ProgramArguments") != [str(script)]:
        raise RuntimeError("隧道启动入口不匹配")
    subprocess.run(["/bin/bash", "-n"], input=source, check=True, capture_output=True, timeout=5)
    correct_program = f"program = {script}" in current_state.stdout
    if loaded and correct_program and original.get(script) == source and original.get(plist) == payload and healthy():
        print("隧道配置未变，健康检查通过")
        return
    backup = backup_current(backup_root, script, plist)
    support.mkdir(parents=True, exist_ok=True)
    plist.parent.mkdir(parents=True, exist_ok=True)
    try:
        if loaded:
            run("/bin/launchctl", "bootout", target)
        atomic_write(script, source, 0o700)
        atomic_write(plist, payload, 0o600)
        run("/bin/bash", "-n", str(script))
        run("/usr/bin/plutil", "-lint", str(plist))
        run("/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist))
        deadline = time.monotonic() + 30
        while not healthy():
            if time.monotonic() >= deadline:
                raise RuntimeError("新隧道未在 30 秒内通过健康检查")
            time.sleep(1)
        state = run("/bin/launchctl", "print", target).stdout
        if f"program = {script}" not in state or str(script) not in state.split("arguments = {", 1)[-1]:
            raise RuntimeError("launchctl 实际启动入口不匹配")
    except Exception:
        run("/bin/launchctl", "bootout", target, check=False)
        for path in [script, plist]:
            if path in original:
                atomic_write(path, original[path], 0o700 if path == script else 0o600)
            elif path.exists():
                recycle(path)
        if loaded:
            run("/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist))
        raise
    prune_backups(backup_root, backup)
    print("隧道安装验收通过：中文入口、launchctl 回读、Broker 健康检查")


if __name__ == "__main__":
    main()
