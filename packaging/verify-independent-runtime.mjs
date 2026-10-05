#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

assert.ok(process.argv[2], 'Missing independent runtime directory');
const root = resolve(process.argv[2]);
const localMarker = join(root, '.notrace-local-runtime');
const localStat = lstatSync(localMarker);
assert.ok(localStat.isFile() && localStat.size <= 4096, 'Invalid local TCC runtime marker');
assert.ok(readFileSync(localMarker, 'utf8').trim().startsWith('NoTrace local runtime v1'), 'Local TCC marker does not match core contract');
const marker = join(root, '.notrace-independent-engine.json');
const stat = lstatSync(marker);
assert.ok(stat.isFile() && stat.size < 4096, 'Invalid independent runtime marker');
const data = JSON.parse(readFileSync(marker, 'utf8'));
assert.deepEqual(Object.keys(data).sort(), ['provider', 'version', 'archive_sha256', 'source_commit', 'binary_sha256', 'framework_sha256'].sort());
assert.equal(data.provider, 'chromix');
assert.equal(data.version, '152.0.7977.82');
assert.equal(data.archive_sha256, '8ceefefced9018dfe917650ce156bd1ffdaa9bc2bc6b89b70b6d021262166eb4');
assert.equal(data.source_commit, 'ca52ae0d01168a8bc118ccc28d484011a7eb0efb');
const app = join(root, 'Chromium.app');
for (const key of ['NSMicrophoneUsageDescription', 'NSCameraUsageDescription', 'NSBluetoothAlwaysUsageDescription']) {
  const value = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Contents/Info.plist')], { encoding: 'utf8' });
  assert.ok(value.trim(), `Missing ${key}`);
}
const binary = join(app, 'Contents/MacOS/Chromium');
const framework = join(app, `Contents/Frameworks/Chromium Framework.framework/Versions/${data.version}/Chromium Framework`);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(hash(binary), data.binary_sha256, 'Independent runtime binary changed');
assert.equal(hash(framework), data.framework_sha256, 'Independent runtime framework changed');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
assert.match(execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 }), /Chromium 152\.0\.7977\.82/);
console.log('独立指纹内核来源、版本、签名和哈希验收通过');
