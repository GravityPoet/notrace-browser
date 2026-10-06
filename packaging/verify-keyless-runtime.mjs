#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
assert.ok(process.argv[2],'Missing runtime directory');
const root=resolve(process.argv[2]);
for(const name of ['.notrace-local-runtime','.notrace-keyless-engine.json']){
  const stat=lstatSync(join(root,name));assert.ok(stat.isFile()&&stat.size<=4096,'Invalid runtime marker');
}
assert.ok(readFileSync(join(root,'.notrace-local-runtime'),'utf8').startsWith('NoTrace local runtime v1'));
const data=JSON.parse(readFileSync(join(root,'.notrace-keyless-engine.json'),'utf8'));
assert.deepEqual(Object.keys(data).sort(),['provider','version','engine_version','archive_sha256','source_binary_sha256','binary_sha256','framework_sha256'].sort());
assert.equal(data.provider,'cloak-keyless');assert.equal(data.version,'145.0.7632.109.2');
assert.equal(data.engine_version,'145.0.7632.109');
assert.equal(data.archive_sha256,'505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c');
assert.equal(data.source_binary_sha256,'79ddf7e7a7be8087319390ed79266387f6499b8a2e45ccfbaa724d7e7fff6b79');
const app=join(root,'Chromium.app'),binary=join(app,'Contents/MacOS/Chromium');
const framework=join(app,'Contents/Frameworks/Chromium Framework.framework/Versions/145.0.7632.109/Chromium Framework');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
assert.equal(hash(binary),data.binary_sha256,'Runtime binary changed');
assert.equal(hash(framework),data.framework_sha256,'Runtime framework changed');
for(const key of ['NSMicrophoneUsageDescription','NSCameraUsageDescription','NSBluetoothAlwaysUsageDescription']){
  assert.ok(execFileSync('/usr/libexec/PlistBuddy',['-c','Print :'+key,join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim());
}
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'pipe'});
assert.match(execFileSync(binary,['--version'],{encoding:'utf8',timeout:15000}),/Chromium 145\.0\.7632\.109/);
console.log('免 Key 内核版本、来源、签名、TCC 声明与本机哈希通过');
