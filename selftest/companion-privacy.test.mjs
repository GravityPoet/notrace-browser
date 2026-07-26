// The companion runs in the page's MAIN world, so anything it leaves on
// `window` is readable by every site. The per-account fingerprint seed is the
// value behind --fingerprint=<seed>: unique per account, stable across cookie
// clears, IP changes and proxy changes. Leaving it reachable turns it into a
// super-cookie that links exactly the accounts this browser exists to separate.
//
// These tests pin the handoff contract: the seed arrives non-enumerable and is
// deleted before any page script can run.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "cloak-companion");
const read = (name) => readFileSync(join(EXT, name), "utf8");

/// Run the MAIN-world document_start scripts against a bare window, in the same
/// order the manifest declares them. `seedScript` stands in for the per-account
/// account-seed-main.js that a launch generates.
function runDocumentStart(seedScript, { localStorageEntries = {} } = {}) {
  const context = vm.createContext({});
  vm.runInContext("var window = this;", context);
  context.localStorage = {
    getItem: (key) => (key in localStorageEntries ? localStorageEntries[key] : null),
    setItem: (key, value) => { localStorageEntries[key] = String(value); },
    removeItem: (key) => { delete localStorageEntries[key]; },
  };

  const seedsSeen = [];
  context.window.__cloakSpoof = (tz, fpSeed) => { seedsSeen.push({ tz, fpSeed }); };

  vm.runInContext(seedScript, context);
  vm.runInContext(read("apply.js"), context);
  return { context, seedsSeen };
}

const LAUNCH_SEED_SCRIPT = read("account-seed-main.js").replace('value: ""', 'value: "92934"');

test("the account seed never reaches page scripts", () => {
  const { context, seedsSeen } = runDocumentStart(LAUNCH_SEED_SCRIPT);

  assert.equal(seedsSeen.length, 1, "the spoof should still receive the seed");
  assert.equal(seedsSeen[0].fpSeed, "92934");

  assert.equal(
    context.window.__cloakSeedHandoff,
    undefined,
    "apply.js must delete the handoff before page scripts run",
  );
  const remaining = Object.getOwnPropertyNames(context.window)
    .filter((key) => context.window[key] === "92934");
  assert.deepEqual(remaining, [], "no window property may still hold the seed");
});

test("the seed handoff is not enumerable while it exists", () => {
  const context = vm.createContext({});
  vm.runInContext("var window = this;", context);
  vm.runInContext(LAUNCH_SEED_SCRIPT, context);

  assert.equal(context.window.__cloakSeedHandoff, "92934");
  assert.ok(
    !Object.keys(context.window).includes("__cloakSeedHandoff"),
    "a page walking Object.keys(window) must not find the seed",
  );
});

test("a page-written localStorage seed is ignored", () => {
  // localStorage is page-writable. Honouring a seed from it would let a site
  // pin the canvas and audio noise to a value it chose.
  const { seedsSeen } = runDocumentStart(read("account-seed-main.js"), {
    localStorageEntries: { __cl_fp_seed: "attacker-chosen" },
  });

  assert.deepEqual(seedsSeen, [], "no spoof should run from a page-supplied seed");
});

test("the timezone still applies without a seed", () => {
  const { seedsSeen } = runDocumentStart(read("account-seed-main.js"), {
    localStorageEntries: { __cl_tz: "Asia/Shanghai" },
  });

  assert.equal(seedsSeen.length, 1);
  assert.equal(seedsSeen[0].tz, "Asia/Shanghai");
});
