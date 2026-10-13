import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Test profiles must remain recoverable and must never resolve to user data.
export function disposableProfile(prefix) {
  if (!/^cloak-[a-z-]+-$/.test(prefix)) throw new Error("invalid fixture prefix");
  const parent = realpathSync(tmpdir());
  if (!/^\/private\/(?:tmp(?:\/|$)|var\/folders(?:\/|$))/.test(parent)) {
    throw new Error("profile fixture requires the macOS temporary directory");
  }
  const parentBefore = statSync(parent);
  const path = mkdtempSync(join(parent, prefix));
  const original = lstatSync(path);
  const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
  return {
    path,
    recycle() {
      const current = lstatSync(path);
      if (current.isSymbolicLink() || !current.isDirectory()
          || realpathSync(path) !== path || !same(current, original)
          || !same(statSync(parent), parentBefore)) {
        throw new Error("fixture identity changed; cleanup stopped");
      }
      const recovery = join(homedir(), ".Trash", basename(path));
      if (existsSync(recovery)) throw new Error("fixture recovery destination already exists");
      const helper = fileURLToPath(new URL("../packaging/recycle-paths.sh", import.meta.url));
      const result = spawnSync("/bin/bash", [helper, path], { encoding: "utf8" });
      if (result.status !== 0 || existsSync(path)
          || !same(statSync(parent), parentBefore)
          || !same(statSync(recovery), original)) {
        throw new Error("fixture Trash receipt could not be verified");
      }
      return { original: path, recovery, parentUnchanged: true };
    },
  };
}
