import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../extension/cloak-companion/startup-recovery.js", import.meta.url),
  "utf8",
);

const dynamicModuleError =
  "Failed to fetch dynamically imported module: https://chatgpt.com/unauth-mweb/assets/en-US-example.js?worker_version=test";

function harness({ hostname = "chatgpt.com", navigationType = "navigate", initialNow = 0 } = {}) {
  const listeners = new Map();
  const timers = [];
  let now = initialNow;
  let reloads = 0;
  const window = {
    location: {
      hostname,
      reload() { reloads += 1; },
    },
    performance: {
      now: () => now,
      getEntriesByType: (type) => type === "navigation" ? [{ type: navigationType }] : [],
    },
    setTimeout(callback) { timers.push(callback); },
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  window.top = window;
  vm.runInNewContext(source, { window });
  return {
    emit(type, event) { listeners.get(type)?.(event); },
    flushTimers() { while (timers.length) timers.shift()(); },
    listenerCount: () => listeners.size,
    reloadCount: () => reloads,
    setNow(value) { now = value; },
  };
}

test("reloads once for the observed ChatGPT startup module failure", () => {
  const page = harness();
  page.emit("unhandledrejection", { reason: new TypeError(dynamicModuleError) });
  page.emit("error", { message: dynamicModuleError });
  page.flushTimers();
  assert.equal(page.reloadCount(), 1);
});

test("ignores unrelated errors and failures after the startup window", () => {
  const page = harness();
  page.emit("unhandledrejection", { reason: new TypeError("network failed") });
  page.setNow(30_001);
  page.emit("unhandledrejection", { reason: new TypeError(dynamicModuleError) });
  page.flushTimers();
  assert.equal(page.reloadCount(), 0);
});

test("does not loop after a reload navigation", () => {
  const page = harness({ navigationType: "reload" });
  page.emit("unhandledrejection", { reason: new TypeError(dynamicModuleError) });
  page.flushTimers();
  assert.equal(page.reloadCount(), 0);
});

test("does not install recovery outside chatgpt.com", () => {
  const page = harness({ hostname: "example.com" });
  assert.equal(page.listenerCount(), 0);
});
