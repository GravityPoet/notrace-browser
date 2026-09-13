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
  pathname = "/",
  bodyText = "",
  sessionStore = new Map(),
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
    body: { innerText: bodyText, textContent: bodyText },
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
      pathname,
      reload() { reloads += 1; },
    },
    sessionStorage: {
      getItem(key) { return sessionStore.get(key) ?? null; },
      removeItem(key) { sessionStore.delete(key); },
      setItem(key, value) { sessionStore.set(key, String(value)); },
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
        if (!hydrated) return;
        if (action === "auth") authVisible = true;
        if (action === "model") expanded = "true";
      },
    };
    buttons.push(button);

    return {
      button,
      hydrate({ reactBinding = true } = {}) {
        hydrated = true;
        if (reactBinding) Object.defineProperty(button, "__reactProps$test", { value: {} });
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
        if (!event.defaultPrevented && !event.propagationStopped && hydrated) {
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

test("reloads the observed OpenAI HTML auth error once", () => {
  const sessionStore = new Map();
  const options = {
    hostname: "auth.openai.com",
    pathname: "/api/accounts/authorize",
    bodyText: 'Route Error (400 Invalid content type: text/html; charset=UTF-8): "Invalid content type: text/html; charset=UTF-8"',
    readyState: "complete",
    sessionStore,
  };

  const firstLoad = harness(options);
  firstLoad.flushTimers();
  assert.equal(firstLoad.reloadCount(), 1);

  const reloadedError = harness({ ...options, navigationType: "reload" });
  reloadedError.flushTimers();
  assert.equal(reloadedError.reloadCount(), 0);
});

test("leaves normal and unrelated OpenAI auth pages untouched", () => {
  const normalAuth = harness({
    hostname: "auth.openai.com",
    pathname: "/api/accounts/authorize",
    bodyText: "Continue to ChatGPT",
    readyState: "complete",
  });
  const unrelatedPath = harness({
    hostname: "auth.openai.com",
    pathname: "/password-reset",
    bodyText: "Route Error (400 Invalid content type: text/html; charset=UTF-8)",
    readyState: "complete",
  });

  normalAuth.flushTimers();
  unrelatedPath.flushTimers();
  assert.equal(normalAuth.reloadCount(), 0);
  assert.equal(unrelatedPath.reloadCount(), 0);
});

test("does not intercept login or signup clicks before hydration", () => {
  const page = harness();
  const login = page.addButton({ text: "登录", testId: "login-button" });
  const signup = page.addButton({ text: "免费注册", testId: "signup-button" });

  for (const control of [login, signup]) {
    const event = control.nativeClick();
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    control.hydrate();
  }
  page.setReadyState("complete");
  page.advance(10_000);
  assert.equal(login.programmaticClickCount(), 0);
  assert.equal(signup.programmaticClickCount(), 0);
  assert.equal(page.authVisible(), false);
  assert.equal(page.reloadCount(), 0);
});

for (const readyState of ["loading", "interactive", "complete"]) {
  for (const reactBinding of [false, true]) {
    test(`ready login and signup handlers respond immediately during ${readyState} (React marker: ${reactBinding})`, () => {
      for (const [text, testId] of [["登录", "login-button"], ["免费注册", "signup-button"]]) {
        const page = harness({ readyState });
        const control = page.addButton({ text, testId });
        control.hydrate({ reactBinding });

        const event = control.nativeClick();
        assert.equal(event.defaultPrevented, false);
        assert.equal(event.propagationStopped, false);
        assert.equal(control.nativeClickCount(), 1);
        assert.equal(page.authVisible(), true);
        page.setReadyState("complete");
        page.advance(10_000);
        assert.equal(control.programmaticClickCount(), 0);
        assert.equal(page.reloadCount(), 0);
      }
    });
  }
}

test("a fresh click after hydration is not trapped by an earlier click", () => {
  const page = harness();
  const login = page.addButton({ text: "登录", testId: "login-button" });
  login.nativeClick();
  login.hydrate();

  const event = login.nativeClick();
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.propagationStopped, false);
  assert.equal(login.nativeClickCount(), 1);
  assert.equal(page.authVisible(), true);
  page.advance(10_000);
  assert.equal(login.programmaticClickCount(), 0);
});

test("model and provider controls receive original clicks without delayed duplicates", () => {
  const page = harness({ readyState: "interactive" });
  const model = page.addButton({ text: "ChatGPT", testId: "model-switcher-dropdown-button", action: "model" });
  const provider = page.addButton({ text: "使用 Google 账户继续", dialog: true, action: "none" });
  for (const control of [model, provider]) {
    control.hydrate();
    const event = control.nativeClick();
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    assert.equal(control.nativeClickCount(), 1);
  }
  assert.equal(model.expanded(), "true");
  page.setReadyState("complete");
  page.advance(10_000);
  assert.equal(model.programmaticClickCount(), 0);
  assert.equal(provider.programmaticClickCount(), 0);
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
