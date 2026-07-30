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

function harness({
  hostname = "chatgpt.com",
  navigationType = "navigate",
  initialNow = 0,
  readyState = "loading",
} = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const timers = [];
  let now = initialNow;
  let reloads = 0;
  let authVisible = false;
  const buttons = [];

  function setTimer(callback, delay = 0) {
    timers.push({ callback, at: now + delay });
    return timers.length;
  }

  const document = {
    readyState,
    addEventListener(type, callback) { documentListeners.set(type, callback); },
    querySelector(selector) {
      if (selector.includes('input[type="email"]')) return authVisible ? {} : null;
      return null;
    },
    querySelectorAll() { return buttons; },
  };

  const window = {
    document,
    location: {
      hostname,
      reload() { reloads += 1; },
    },
    performance: {
      now: () => now,
      getEntriesByType: (type) => type === "navigation" ? [{ type: navigationType }] : [],
    },
    setTimeout: setTimer,
    addEventListener(type, callback) { windowListeners.set(type, callback); },
  };
  window.top = window;
  vm.runInNewContext(source, { window });

  function addButton({
    text = "",
    testId = "",
    ariaLabel = "",
    dialog = false,
    action = "auth",
  } = {}) {
    let hydrated = false;
    let programmaticClicks = 0;
    let nativeClicks = 0;
    let expanded = "false";
    const attributes = new Map([
      ["data-testid", testId],
      ["aria-label", ariaLabel],
    ]);
    const button = {
      innerText: text,
      textContent: text,
      isConnected: true,
      getAttribute(name) {
        if (name === "aria-expanded") return expanded;
        return attributes.get(name) || null;
      },
      closest(selector) {
        if (selector === "button,[role=button]") return button;
        if (selector === '[role="dialog"]') return dialog ? {} : null;
        return null;
      },
      click() {
        programmaticClicks += 1;
        if (!hydrated || document.readyState !== "complete") return;
        if (action === "auth") authVisible = true;
        if (action === "model") expanded = "true";
      },
    };
    buttons.push(button);

    return {
      button,
      hydrate() {
        hydrated = true;
        Object.defineProperty(button, "__reactProps$test", { value: {} });
      },
      nativeClick() {
        const event = {
          isTrusted: true,
          target: button,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() { this.defaultPrevented = true; },
          stopImmediatePropagation() { this.propagationStopped = true; },
        };
        documentListeners.get("click")?.(event);
        if (!event.defaultPrevented && hydrated && document.readyState === "complete") {
          nativeClicks += 1;
          if (action === "auth") authVisible = true;
          if (action === "model") expanded = "true";
        }
        return event;
      },
      nativeClickCount: () => nativeClicks,
      programmaticClickCount: () => programmaticClicks,
      expanded: () => expanded,
    };
  }

  function advance(milliseconds) {
    const end = now + milliseconds;
    while (true) {
      timers.sort((a, b) => a.at - b.at);
      const timer = timers[0];
      if (!timer || timer.at > end) break;
      timers.shift();
      now = timer.at;
      timer.callback();
    }
    now = end;
  }

  return {
    addButton,
    advance,
    authVisible: () => authVisible,
    emit(type, event) { windowListeners.get(type)?.(event); },
    flushTimers() { advance(60_000); },
    listenerCount: () => windowListeners.size + documentListeners.size,
    reloadCount: () => reloads,
    setNow(value) { now = value; },
    setReadyState(value) { document.readyState = value; },
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

test("replays one early login click after ChatGPT hydration completes", () => {
  const page = harness();
  const login = page.addButton({ text: "登录", testId: "login-button" });

  const event = login.nativeClick();
  assert.equal(event.defaultPrevented, true);
  assert.equal(page.authVisible(), false);

  login.hydrate();
  page.setReadyState("complete");
  page.advance(200);

  assert.equal(login.programmaticClickCount(), 1);
  assert.equal(page.authVisible(), true);
  assert.equal(page.reloadCount(), 0);
});

test("coalesces repeated early clicks instead of starving hydration", () => {
  const page = harness();
  const login = page.addButton({ text: "登录", testId: "login-button" });

  for (let index = 0; index < 20; index += 1) login.nativeClick();
  login.hydrate();
  page.setReadyState("complete");
  page.advance(200);

  assert.equal(login.programmaticClickCount(), 1);
  assert.equal(page.authVisible(), true);
  assert.equal(login.nativeClickCount(), 0);
});

test("leaves an already interactive login control untouched", () => {
  const page = harness({ readyState: "complete", initialNow: 8_000 });
  const login = page.addButton({ text: "登录", testId: "login-button" });
  login.hydrate();

  const event = login.nativeClick();

  assert.equal(event.defaultPrevented, false);
  assert.equal(login.nativeClickCount(), 1);
  assert.equal(login.programmaticClickCount(), 0);
  assert.equal(page.authVisible(), true);
});

test("replays the model selector after its handler is attached", () => {
  const page = harness();
  const model = page.addButton({
    text: "ChatGPT",
    testId: "model-switcher-dropdown-button",
    action: "model",
  });

  model.nativeClick();
  model.hydrate();
  page.setReadyState("complete");
  page.advance(200);

  assert.equal(model.programmaticClickCount(), 1);
  assert.equal(model.expanded(), "true");
});

test("replays a server-rendered login-dialog button only once", () => {
  const page = harness();
  const provider = page.addButton({
    text: "使用 Google 账户继续",
    dialog: true,
    action: "none",
  });

  provider.nativeClick();
  provider.hydrate();
  page.setReadyState("complete");
  page.advance(5_000);

  assert.equal(provider.programmaticClickCount(), 1);
  assert.equal(page.reloadCount(), 0);
});

test("does not intercept unrelated server-rendered buttons", () => {
  const page = harness();
  const unrelated = page.addButton({ text: "帮助", action: "none" });

  const event = unrelated.nativeClick();
  page.advance(10_000);

  assert.equal(event.defaultPrevented, false);
  assert.equal(unrelated.programmaticClickCount(), 0);
});
