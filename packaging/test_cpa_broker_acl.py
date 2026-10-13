#!/usr/bin/env python3
"""Pure ACL tests; --linux-fixture also checks real xattrs without credentials."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('cpa_broker_acl', Path(__file__).with_name('cpa-broker-acl.py'))
acl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acl)


def encoded(entries):
    return struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)


def private_acl(uid=1234, mask=0, permission=7):
    undefined = 0xFFFFFFFF
    return encoded([(1, 6, undefined), (2, permission, uid), (4, 0, undefined),
                    (16, mask, undefined), (32, 0, undefined)])


class AclTests(unittest.TestCase):
    def test_restores_only_broker_read(self):
        raw = private_acl()
        self.assertEqual(acl.repaired_acl(raw, 1234), private_acl(mask=4, permission=4))

    def test_idempotent_and_preserves_already_readable_acl(self):
        for mask in (4, 6, 7):
            self.assertIsNone(acl.repaired_acl(private_acl(mask=mask), 1234))

    def test_never_adds_an_ungranted_principal(self):
        self.assertIsNone(acl.repaired_acl(private_acl(uid=5678), 1234))
        self.assertIsNone(acl.repaired_acl(private_acl(permission=0), 1234))
        self.assertIsNone(acl.repaired_acl(encoded([(1, 6, 0xFFFFFFFF), (4, 0, 0xFFFFFFFF), (32, 0, 0xFFFFFFFF)]), 1234))

    def test_never_unmasks_other_principals(self):
        for entries in (
            [(1, 6, 0xFFFFFFFF), (2, 7, 1234), (4, 4, 0xFFFFFFFF), (16, 0, 0xFFFFFFFF), (32, 0, 0xFFFFFFFF)],
            [(1, 6, 0xFFFFFFFF), (2, 7, 1234), (2, 4, 5678), (4, 0, 0xFFFFFFFF), (16, 0, 0xFFFFFFFF), (32, 0, 0xFFFFFFFF)],
        ):
            self.assertIsNone(acl.repaired_acl(encoded(entries), 1234))

    def test_rejects_malformed_acl(self):
        for raw in (b'', b'bad!', private_acl()[:-1]):
            with self.assertRaises(ValueError):
                acl.repaired_acl(raw, 1234)


def linux_fixture():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('Linux fixture requires root for synthetic root-owned files')
    root = Path(tempfile.mkdtemp(prefix='notrace-acl-fixture-', dir='/tmp')).resolve()
    parent = root.parent.stat()
    root_identity = acl.identity(root.stat())
    directory = root / 'auths'
    directory.mkdir(mode=0o700)
    before_directory = acl.identity(directory.stat())
    snapshot = root / 'acl.json'
    uid = pwd.getpwnam('notrace-broker').pw_uid
    item = directory / 'synthetic.json'
    item.write_text('synthetic test data; no credentials\n')
    os.chmod(item, 0o600)
    original = private_acl(uid=uid)
    os.setxattr(item, acl.ACL_ATTRIBUTE, original)
    outside = root / 'outside.txt'
    outside.write_text('unchanged fixture sentinel\n')
    outside_before = outside.stat()
    (directory / 'link.json').symlink_to(outside)
    os.link(outside, directory / 'hardlink.json')
    self_before = item.stat()
    assert acl.repair(directory, snapshot, uid, False)['candidates'] == 1
    assert acl.repair(directory, snapshot, uid, True)['repaired'] == 1
    assert item.stat().st_mtime_ns == self_before.st_mtime_ns
    assert item.stat().st_size == self_before.st_size
    assert stat.S_IMODE(item.stat().st_mode) == 0o640
    assert acl.repair(directory, snapshot, uid, True)['repaired'] == 0
    assert acl.rollback(directory, snapshot, False)['rollback_candidates'] == 1
    assert acl.rollback(directory, snapshot, True)['rollback_candidates'] == 1
    assert os.getxattr(item, acl.ACL_ATTRIBUTE) == original
    assert acl.repair(directory, snapshot, uid, True)['repaired'] == 1
    replacement = directory / 'replacement.tmp'
    replacement.write_text('synthetic atomic replacement\n')
    os.setxattr(replacement, acl.ACL_ATTRIBUTE, original)
    # Keep the pre-replacement fixture recoverable, and preserve parent identity.
    os.rename(item, root / 'original.synthetic.json')
    os.rename(replacement, item)
    assert acl.rollback(directory, snapshot, True)['replaced_or_changed_skipped'] == 1
    assert acl.repair(directory, snapshot, uid, True)['repaired'] == 1
    assert acl.repair(directory, snapshot, uid, True)['repaired'] == 0
    assert len(list(root.glob('acl*.json'))) == 2
    assert acl.identity(directory.stat()) == before_directory
    assert acl.identity(root.stat()) == root_identity
    assert acl.identity(root.parent.stat()) == acl.identity(parent)
    assert acl.identity(outside.stat()) == acl.identity(outside_before)
    assert outside.stat().st_mtime_ns == outside_before.st_mtime_ns
    assert outside.read_text() == 'unchanged fixture sentinel\n'
    assert 'before' in json.loads(snapshot.read_text())['files'][0]
    # Exercise the same systemd path trigger as production on this private
    # fixture, including CPA's create-temp/chmod-0600/rename sequence.
    unit = root.name
    subprocess.run(['systemd-run', '--quiet', '--collect', '--unit=' + unit,
                    '--path-property=PathChanged=' + str(directory),
                    sys.executable, str(Path(__file__).resolve()), '--repair-fixture', str(root)], check=True)
    try:
        replacement = directory / 'next.tmp'
        replacement.write_text('synthetic second atomic replacement\n')
        os.setxattr(replacement, acl.ACL_ATTRIBUTE, original)
        os.rename(item, root / 'second.synthetic.json')
        os.rename(replacement, item)
        deadline = time.monotonic() + 10
        while not (stat.S_IMODE(item.stat().st_mode) & 0o040):
            if time.monotonic() >= deadline:
                raise RuntimeError('systemd path did not repair synthetic replacement')
            time.sleep(0.1)
        assert acl.identity(root.parent.stat()) == acl.identity(parent)
        assert acl.identity(directory.stat()) == before_directory
    finally:
        subprocess.run(['systemctl', 'stop', unit + '.path'], check=True)
        loaded = subprocess.check_output(['systemctl', 'show', unit + '.service', '-p', 'LoadState', '--value'], text=True).strip()
        if loaded != 'not-found':
            subprocess.run(['systemctl', 'stop', unit + '.service'], check=True)
    print(json.dumps({'fixture': str(root), 'actual_acl_repair': True, 'rollback_verified': True,
                      'atomic_replacement_repaired': True, 'idempotent': True,
                      'systemd_event_repair': True,
                      'symlink_and_hardlink_untouched': True, 'parents_unchanged': True,
                      'recovery_records': 2, 'fixture_retained': True}))


if __name__ == '__main__':
    if sys.argv[1:] == ['--linux-fixture']:
        linux_fixture()
    elif len(sys.argv) == 3 and sys.argv[1] == '--repair-fixture':
        root = Path(sys.argv[2])
        if root.resolve(strict=True) != root or root.parent != Path('/tmp') or not root.name.startswith('notrace-acl-fixture-'):
            raise ValueError('not an isolated fixture')
        print(json.dumps(acl.repair(root / 'auths', root / 'acl.json', pwd.getpwnam('notrace-broker').pw_uid, True)))
    else:
        unittest.main()
