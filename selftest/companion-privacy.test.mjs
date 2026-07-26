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

  // apply.js reaches the spoof through the toString handshake spoof.js installs,
  // not through a window global — a global there is a one-expression tell that
  // names the product. Stand the handshake in rather than the entry point.
  const seedsSeen = [];
  context.__seen = seedsSeen;
  vm.runInContext(`
    var __shared = { spoof: function (tz, fpSeed) { __seen.push({ tz: tz, fpSeed: fpSeed }); } };
    var __native = Function.prototype.toString;
    Function.prototype.toString = function toString() {
      if (arguments.length && arguments[0] === "cloak.shared-state.v1") return __shared;
      return __native.call(this);
    };
  `, context);

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

/// A window with enough of the globals spoof.js touches for it to install.
/// No host built-ins are handed in: spoof.js replaces Date methods and
/// Intl.DateTimeFormat in place, so sharing this realm's copies would leave one
/// test's wrappers standing as the next test's "natives".
function spoofedPage() {
  const context = vm.createContext({});
  vm.runInContext("var window = this;", context);
  context.navigator = { userAgent: "Mozilla/5.0 (Macintosh) Chrome/145.0.0.0 Safari/537.36" };
  return context;
}

test("spoof.js leaves nothing on window for a page to find", () => {
  // Measured against the bare engine, which answers [] to both of these. The
  // companion used to add eight names — __cloakSpoof, __cloakState, the install
  // flags — so `Object.getOwnPropertyNames(window).some(n => n.startsWith("__cloak"))`
  // named the product and linked every account on the machine in one expression.
  const context = spoofedPage();
  const before = vm.runInContext("JSON.stringify(Object.getOwnPropertyNames(window))", context);

  vm.runInContext(read("spoof.js"), context);
  vm.runInContext(
    'Function.prototype.toString.call(null, "cloak.shared-state.v1").spoof("Asia/Shanghai", "92934");',
    context,
  );

  const added = JSON.parse(
    vm.runInContext("JSON.stringify(Object.getOwnPropertyNames(window))", context),
  ).filter((name) => !JSON.parse(before).includes(name));

  assert.deepEqual(added, [], "spoof.js added window properties a page can enumerate");
  assert.equal(
    vm.runInContext("Object.getOwnPropertySymbols(window).length", context),
    0,
    "a symbol on window is as findable as a name",
  );
});

test("a page cannot disable the toString mask", () => {
  // The mask used to read its map off window on every call, so
  // `window.__cloakNativeSources = { get() {} }` unmasked every patched native
  // in one line and printed its JavaScript source.
  const context = spoofedPage();
  vm.runInContext(read("spoof.js"), context);
  vm.runInContext(
    'Function.prototype.toString.call(null, "cloak.shared-state.v1").spoof("Asia/Shanghai", "92934");',
    context,
  );

  const masked = () => vm.runInContext("Date.prototype.getTimezoneOffset.toString()", context);
  assert.match(masked(), /\[native code\]/, "the wrapper was not masked to begin with");

  vm.runInContext(`
    window.__cloakNativeSources = { get: function () { return undefined; } };
    window.__cloakState = null;
    window.__cloakFingerprintInstalled = false;
  `, context);

  assert.match(masked(), /\[native code\]/, "a page global switched the mask off");
});

test("Intl.DateTimeFormat still owns its prototype", () => {
  // `X.prototype.constructor === X` holds for every constructor in an
  // unmodified browser. Wrapping DateTimeFormat in a Proxy broke it, which is a
  // free and decisive check — confirmed false in the engine before this fix.
  const context = spoofedPage();
  vm.runInContext(read("spoof.js"), context);
  vm.runInContext(
    'Function.prototype.toString.call(null, "cloak.shared-state.v1").spoof("Asia/Shanghai", "92934");',
    context,
  );

  assert.equal(
    vm.runInContext("Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat", context),
    true,
  );
  assert.equal(
    vm.runInContext("new Intl.DateTimeFormat().resolvedOptions().timeZone", context),
    "Asia/Shanghai",
    "repointing the constructor must not cost the zone default",
  );
});
