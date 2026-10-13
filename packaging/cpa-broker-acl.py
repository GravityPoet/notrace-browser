#!/usr/bin/env python3
"""Restore an inherited Broker read ACL masked by CPA's atomic 0600 writes.

Credential contents are never read. Only an existing, private named-user ACL
can be unmasked; ownership, file contents and all other principals are preserved.
"""
from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import json
import os
from pathlib import Path
import pwd
import stat
import struct

AUTH_DIR = Path('/opt/cliproxyapi/auths')
STATE_DIR = Path('/var/lib/notrace-cpa-acl')
ACL_ATTRIBUTE = 'system.posix_acl_access'
ACL_VERSION = 2
OWNER, USER, GROUP, NAMED_GROUP, MASK, OTHER = 1, 2, 4, 8, 16, 32


def repaired_acl(raw: bytes, broker_uid: int) -> bytes | None:
    """Unmask read only when Broker is the sole named ACL principal."""
    if len(raw) < 4 or (len(raw) - 4) % 8 or struct.unpack_from('<I', raw)[0] != ACL_VERSION:
        raise ValueError('unsupported POSIX ACL')
    entries = list(struct.iter_unpack('<HHI', raw[4:]))
    if any(permissions > 7 for _, permissions, _ in entries):
        raise ValueError('invalid POSIX ACL permissions')
    if sorted(tag for tag, _, _ in entries) != [OWNER, USER, GROUP, MASK, OTHER]:
        return None
    named = next(entry for entry in entries if entry[0] == USER)
    mask = next(entry[1] for entry in entries if entry[0] == MASK)
    if named[2] != broker_uid or not named[1] & 4 or mask & 4:
        return None
    if any(permissions for tag, permissions, _ in entries if tag in (GROUP, OTHER)):
        return None
    updated = [(tag, 4 if tag == USER else permissions | 4 if tag == MASK else permissions, uid)
               for tag, permissions, uid in entries]
    return struct.pack('<I', ACL_VERSION) + b''.join(struct.pack('<HHI', *entry) for entry in updated)


def open_directory(path: Path) -> int:
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError('directory must be canonical and must not contain symlinks')
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def identity(info: os.stat_result) -> tuple[int, int]:
    return info.st_dev, info.st_ino


def save_snapshot(path: Path, snapshot: dict) -> None:
    """Keep exactly two ACL-only recovery records, never credential copies."""
    pending = path.with_suffix('.pending')
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    with os.fdopen(os.open(pending, flags, 0o600), 'w') as stream:
        json.dump(snapshot, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    if path.exists():
        os.replace(path, path.with_suffix('.previous.json'))
    os.replace(pending, path)


def repair(auth_dir: Path, snapshot_path: Path, broker_uid: int, apply: bool) -> dict:
    directory = open_directory(auth_dir)
    before = identity(os.fstat(directory))
    descriptors: list[tuple[int, bytes, bytes]] = []
    records: list[dict] = []
    try:
        scanned = 0
        for name in sorted(os.listdir(directory)):
            if not name.endswith('.json'):
                continue
            try:
                # An open descriptor pins the inode across concurrent CPA rename.
                # Never call read() on this descriptor or parse credential JSON.
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            except FileNotFoundError:
                continue
            except OSError as error:
                if error.errno == errno.ELOOP:
                    continue
                raise
            retain = False
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0:
                    continue
                scanned += 1
                try:
                    raw = os.getxattr(fd, ACL_ATTRIBUTE)
                except OSError as error:
                    if error.errno == errno.ENODATA:
                        continue
                    raise
                updated = repaired_acl(raw, broker_uid)
                if updated is None:
                    continue
                descriptors.append((fd, raw, updated))
                records.append({'name': name, 'device': info.st_dev, 'inode': info.st_ino,
                                'before': base64.b64encode(raw).decode(),
                                'after': base64.b64encode(updated).decode()})
                retain = True
            finally:
                if not retain:
                    os.close(fd)
        if apply and records:
            save_snapshot(snapshot_path, {'version': 1, 'directory': str(auth_dir),
                                         'parent_identity': before, 'files': records})
            for fd, original, updated in descriptors:
                # An intervening ACL edit is not ours to overwrite.
                if os.getxattr(fd, ACL_ATTRIBUTE) != original:
                    raise RuntimeError('ACL changed during repair; saved snapshot is available')
                os.setxattr(fd, ACL_ATTRIBUTE, updated)
                if os.getxattr(fd, ACL_ATTRIBUTE) != updated:
                    raise RuntimeError('ACL verification failed')
        if identity(auth_dir.stat()) != before:
            raise RuntimeError('auth directory was replaced during repair')
        return {'scanned': scanned, 'candidates': len(records),
                'repaired': len(records) if apply else 0, 'parent_identity_unchanged': True}
    finally:
        for fd, _, _ in descriptors:
            os.close(fd)
        os.close(directory)


def rollback(auth_dir: Path, snapshot_path: Path, apply: bool) -> dict:
    snapshot = json.loads(snapshot_path.read_text())
    directory = open_directory(auth_dir)
    restored = skipped = 0
    try:
        if snapshot['directory'] != str(auth_dir) or tuple(snapshot['parent_identity']) != identity(os.fstat(directory)):
            raise ValueError('rollback directory identity does not match')
        for record in snapshot['files']:
            name = record['name']
            if Path(name).name != name or not name.endswith('.json'):
                raise ValueError('invalid snapshot filename')
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            except FileNotFoundError:
                skipped += 1
                continue
            try:
                info = os.fstat(fd)
                if identity(info) != (record['device'], record['inode']) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    skipped += 1
                    continue
                original = base64.b64decode(record['before'], validate=True)
                updated = base64.b64decode(record['after'], validate=True)
                actual = os.getxattr(fd, ACL_ATTRIBUTE)
                if actual == original:
                    continue
                if actual != updated:
                    skipped += 1
                    continue
                if apply:
                    os.setxattr(fd, ACL_ATTRIBUTE, original)
                    if os.getxattr(fd, ACL_ATTRIBUTE) != original:
                        raise RuntimeError('ACL rollback verification failed')
                restored += 1
            finally:
                os.close(fd)
        return {'rollback_candidates': restored, 'replaced_or_changed_skipped': skipped, 'applied': apply}
    finally:
        os.close(directory)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repair', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    uid = pwd.getpwnam('notrace-broker').pw_uid
    state = open_directory(STATE_DIR)
    try:
        info = os.fstat(state)
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('snapshot directory must be root-owned mode 0700')
        with os.fdopen(os.open('repair.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=state), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            snapshot = STATE_DIR / 'acl.json'
            result = rollback(AUTH_DIR, snapshot, args.repair) if args.rollback else repair(AUTH_DIR, snapshot, uid, args.repair)
            print(json.dumps(result, sort_keys=True))
    finally:
        os.close(state)


if __name__ == '__main__':
    main()
