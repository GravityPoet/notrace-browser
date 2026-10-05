#!/usr/bin/env node
// Stream a private snapshot into one integrity digest without logging names/data.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.argv[2]) throw new Error("Missing snapshot directory");
const root = resolve(process.argv[2]);
const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
function scan(relative) {
  const path = join(root, relative), before = lstatSync(path);
  const kind = before.isSymbolicLink() ? "link" : before.isDirectory() ? "directory" : before.isFile() ? "file" : "unsupported";
  if (kind === "unsupported") throw new Error("Unsupported snapshot entry");
  hash.update(JSON.stringify([relative, kind, before.mode & 0o7777, kind === "file" ? before.size : null]) + "\n");
  if (kind === "directory") {
    for (const name of readdirSync(path).sort()) scan(relative ? join(relative, name) : name);
  } else if (kind === "link") {
    hash.update(JSON.stringify(readlinkSync(path)) + "\n");
  } else {
    const descriptor = openSync(path, "r");
    try {
      for (let length; (length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, length));
    } finally { closeSync(descriptor); }
    const after = lstatSync(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error("Snapshot changed during verification");
    hash.update("\n");
  }
}
scan("");
console.log(hash.digest("hex"));
