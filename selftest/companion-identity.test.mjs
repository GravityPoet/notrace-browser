// The identity spoof rewrites what navigator reports. Getting the *values*
// right is only half of it: the objects carrying them have to keep the shape
// the engine's own WebIDL bindings have, or the forgery announces itself.
//
// The companion used to hand back a hand-built object in place of
// navigator.userAgentData. Measured against the bare engine, that answered
// "Object" to `navigator.userAgentData.constructor.name` where every real
// Chrome answers "NavigatorUAData", listed five own properties where the real
// instance lists none, and printed the wrapper's own JavaScript source from
// `Function.prototype.toString`. Any one of those identifies the companion in a
// single expression, whatever the values say.
//
// These tests pin the shape. selftest/run-selftest.mjs checks the same thing
// against the live engine; this runs without one.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "cloak-companion");
const SPOOF = readFileSync(join(EXT, "spoof.js"), "utf8");

const IDENTITY = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  platform: "MacIntel",
  uaData: {
    brands: [{ brand: "Google Chrome", version: "145" }, { brand: "Not)A;Brand", version: "24" }],
    mobile: false,
    platform: "macOS",
    fullVersionList: [{ brand: "Google Chrome", version: "145.0.0.0" }],
    uaFullVersion: "145.0.0.0",
    platformVersion: "15.5.0",
    architecture: "arm",
    bitness: "64",
    model: "",
  },
};

// Navigator and NavigatorUAData as Chromium exposes them: attributes are
// enumerable accessors on the interface prototype, methods are writable data
// properties there, and the instance itself owns nothing.
const DOM_STUB = `
  function Navigator() {}
  function NavigatorUAData() {}
  function attribute(target, name, value) {
    var get = function () { return value; };
    Object.defineProperty(get, "name", { value: "get " + name });
    Object.defineProperty(target, name, { get: get, enumerable: true, configurable: true });
  }
  function method(target, name, arity, value) {
    Object.defineProperty(value, "name", { value: name });
    Object.defineProperty(value, "length", { value: arity });
    target[name] = value;
  }
  attribute(Navigator.prototype, "userAgent", "ENGINE-UA");
  attribute(Navigator.prototype, "platform", "ENGINE-PLATFORM");
  attribute(NavigatorUAData.prototype, "brands", []);
  attribute(NavigatorUAData.prototype, "mobile", false);
  attribute(NavigatorUAData.prototype, "platform", "ENGINE-CH-PLATFORM");
  method(NavigatorUAData.prototype, "getHighEntropyValues", 1, function () { return Promise.resolve({}); });
  method(NavigatorUAData.prototype, "toJSON", 0, function () { return {}; });
  var uaDataInstance = new NavigatorUAData();
  var navigator = new Navigator();
  attribute(Navigator.prototype, "userAgentData", uaDataInstance);
`;

/// Every member the identity spoof replaces. In the engine each of these is a
/// native binding printing "[native code]"; here they are ordinary functions, so
/// the contract the tests can check is the one that actually holds either way —
/// the replacement reports exactly what the thing it stands in for reported.
const PATCHED_MEMBERS = [
  "navigator.userAgentData.getHighEntropyValues",
  "navigator.userAgentData.toJSON",
  'Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, "brands").get',
  'Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, "mobile").get',
  'Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, "platform").get',
  'Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent").get',
  'Object.getOwnPropertyDescriptor(Navigator.prototype, "platform").get',
];

function page({ identity = IDENTITY, secureContext = true } = {}) {
  const context = vm.createContext({ Object, Array, JSON, Promise, String, Math, Date, Intl });
  vm.runInContext("var window = this;", context);
  vm.runInContext(DOM_STUB, context);
  if (!secureContext) {
    // userAgentData is secure-context only: on an http:// origin real Chrome has
    // neither the interface nor the attribute.
    vm.runInContext("delete Navigator.prototype.userAgentData; NavigatorUAData = undefined;", context);
  }
  if (identity) {
    context.__identity = identity;
    vm.runInContext(
      'Object.defineProperty(window, "__cloakBrowserIdentity", { value: __identity, configurable: true, enumerable: false, writable: true });',
      context,
    );
  }
  const source = (expr) => vm.runInContext(`Function.prototype.toString.call(${expr})`, context);
  const before = vm.runInContext("navigator.userAgentData", context);
  const sourcesBefore = secureContext ? PATCHED_MEMBERS.map(source) : [];
  vm.runInContext(SPOOF, context);
  vm.runInContext('Function.prototype.toString.call(null, "cloak.shared-state.v1").spoof(null, null);', context);
  return { context, before, sourcesBefore, source, run: (expr) => vm.runInContext(expr, context) };
}

test("navigator.userAgentData stays the engine's own instance", () => {
  const { before, run } = page();

  assert.equal(run("navigator.userAgentData"), before, "the instance was swapped for a stand-in");
  assert.equal(run("navigator.userAgentData.constructor.name"), "NavigatorUAData");
  assert.equal(run("Object.getPrototypeOf(navigator.userAgentData) === NavigatorUAData.prototype"), true);
  assert.deepEqual(
    run("Object.getOwnPropertyNames(navigator.userAgentData)"),
    [],
    "a real NavigatorUAData owns nothing; own properties here are the forgery showing through",
  );
});

test("every patched member still reports the source of the thing it replaced", () => {
  // In the engine these are native bindings, so this is what keeps them printing
  // "[native code]". The uaData members had no mask at all: getHighEntropyValues
  // printed the wrapper's own JavaScript, which is decisive on its own.
  const { source, sourcesBefore } = page();

  for (let i = 0; i < PATCHED_MEMBERS.length; i += 1) {
    assert.equal(
      source(PATCHED_MEMBERS[i]),
      sourcesBefore[i],
      `${PATCHED_MEMBERS[i]} prints its replacement's source instead of the original's`,
    );
  }
  assert.notEqual(
    sourcesBefore[0],
    undefined,
    "the member list went stale — nothing was captured to compare against",
  );
});

test("patched members keep the descriptors and arity WebIDL gives them", () => {
  const { run } = page();
  const shape = (expr) => run(`(function () {
    var d = ${expr};
    return [Object.keys(d).sort().join(","), !!d.enumerable, !!d.configurable, !!d.writable].join("|");
  })()`);

  for (const name of ["brands", "mobile", "platform"]) {
    assert.equal(
      shape(`Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, "${name}")`),
      "configurable,enumerable,get,set|true|true|false",
      `NavigatorUAData.${name} is no longer an enumerable accessor`,
    );
  }
  assert.equal(
    shape('Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, "getHighEntropyValues")'),
    "configurable,enumerable,value,writable|true|true|true",
  );
  assert.equal(run("navigator.userAgentData.getHighEntropyValues.name"), "getHighEntropyValues");
  assert.equal(run("navigator.userAgentData.getHighEntropyValues.length"), 1);
  assert.equal(run("navigator.userAgentData.toJSON.length"), 0);
});

test("the forged values are the ones the launch handed over", async () => {
  const { run } = page();

  assert.equal(run("navigator.userAgent"), IDENTITY.userAgent);
  assert.equal(run("navigator.platform"), "MacIntel");
  assert.deepEqual(run("navigator.userAgentData.brands"), IDENTITY.uaData.brands);
  assert.equal(run("navigator.userAgentData.mobile"), false);
  assert.deepEqual(JSON.parse(run("JSON.stringify(navigator.userAgentData.toJSON())")), {
    brands: IDENTITY.uaData.brands, mobile: false, platform: "macOS",
  });

  const high = await run('navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "uaFullVersion", "model"])');
  assert.deepEqual(JSON.parse(JSON.stringify(high)), {
    brands: IDENTITY.uaData.brands, mobile: false, platform: "macOS",
    architecture: "arm", bitness: "64", uaFullVersion: "145.0.0.0", model: "",
  });
});

test("a mutable copy is handed out, so a page cannot rewrite the identity", () => {
  const { run } = page();

  run("navigator.userAgentData.brands.push({ brand: 'injected', version: '1' })");
  run("navigator.userAgentData.brands[0].brand = 'rewritten'");

  assert.deepEqual(run("navigator.userAgentData.brands"), IDENTITY.uaData.brands);
});

test("no userAgentData is conjured on an origin where the engine has none", () => {
  // Synthesizing one on an insecure origin announces the companion on exactly
  // the pages where real Chrome exposes nothing at all.
  const { run } = page({ secureContext: false });

  assert.equal(run("navigator.userAgentData"), undefined);
  assert.equal(
    run('Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgentData")'),
    undefined,
    "the companion defined an attribute the engine does not expose",
  );
  assert.equal(run("navigator.userAgent"), IDENTITY.userAgent, "the rest of the identity must still apply");
});
