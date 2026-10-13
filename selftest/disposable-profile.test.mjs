import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { disposableProfile } from "./disposable-profile.mjs";

test("rejects a fixture prefix that can traverse paths", () => {
  assert.throws(() => disposableProfile("../accounts/"), /invalid fixture prefix/);
});

test("recycles only its temporary fixture and retains a verified recovery receipt", { skip: process.platform !== "darwin" }, () => {
  const fixture = disposableProfile("cloak-trash-test-");
  const sibling = disposableProfile("cloak-trash-sentinel-");
  writeFileSync(join(fixture.path, "synthetic.txt"), "recoverable fixture");
  writeFileSync(join(sibling.path, "sentinel.txt"), "outside fixture");
  const receipt = fixture.recycle();
  assert.equal(receipt.parentUnchanged, true);
  assert.equal(readFileSync(join(receipt.recovery, "synthetic.txt"), "utf8"), "recoverable fixture");
  assert.equal(readFileSync(join(sibling.path, "sentinel.txt"), "utf8"), "outside fixture");
  const siblingReceipt = sibling.recycle();
  assert.equal(siblingReceipt.parentUnchanged, true);
});
