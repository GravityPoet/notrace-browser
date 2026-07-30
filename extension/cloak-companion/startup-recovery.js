// ChatGPT can occasionally render its server shell before React has attached
// handlers. Early repeated clicks can then keep the shell busy enough to delay
// hydration indefinitely. Coalesce those no-op clicks and replay the latest one
// once the target is interactive. Keep the existing one-shot reload for the
// separate unauth-mweb module failure.
(() => {
  "use strict";

  const recoveryWindowMs = 30_000;
  const fallbackReplayDelayMs = 7_000;
  const replayPollMs = 100;
  const moduleFailure = /Failed to fetch dynamically imported module:\s*https:\/\/chatgpt\.com\/unauth-mweb\/assets\//i;

  if (window.top !== window || window.location.hostname !== "chatgpt.com") return;

  const startedAt = window.performance?.now?.() || 0;
  let reloadScheduled = false;
  let pendingClick = null;
  let replayTimer = null;
  let replayingClick = false;

  function wasReloadNavigation() {
    try {
      const navigation = window.performance?.getEntriesByType?.("navigation")?.[0];
      return navigation?.type === "reload";
    } catch (_) {
      return false;
    }
  }

  function messageOf(reason) {
    if (typeof reason === "string") return reason;
    if (reason && typeof reason.message === "string") return reason.message;
    try {
      return String(reason || "");
    } catch (_) {
      return "";
    }
  }

  function recover(message) {
    if (reloadScheduled || wasReloadNavigation() || !moduleFailure.test(message)) return;
    const elapsed = (window.performance?.now?.() || startedAt) - startedAt;
    if (elapsed > recoveryWindowMs) return;

    reloadScheduled = true;
    window.setTimeout(() => window.location.reload(), 100);
  }

  function normalizedText(node) {
    return String(node?.innerText || node?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function clickKind(button) {
    if (!button) return "";

    const testId = button.getAttribute?.("data-testid") || "";
    if (testId === "login-button" ||
        /^(log ?in|sign ?in|登录|登入|ログイン)$/i.test(normalizedText(button))) {
      return "login";
    }
    if (testId === "signup-button" ||
        /^(sign ?up|注册|註冊|免费注册|免費註冊|サインアップ)$/i.test(normalizedText(button))) {
      return "signup";
    }
    if (testId === "model-switcher-dropdown-button") return "model";
    if (button.closest?.('[role="dialog"]')) return "dialog";
    return "";
  }

  function hasReactBinding(button) {
    try {
      // React adds these prefix-stable, suffix-randomized fields while hydrating.
      return Object.getOwnPropertyNames(button).some(
        (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactProps$"),
      );
    } catch (_) {
      return false;
    }
  }

  function snapshotClick(button) {
    return {
      button,
      kind: clickKind(button),
      testId: button.getAttribute?.("data-testid") || "",
      ariaLabel: button.getAttribute?.("aria-label") || "",
      text: normalizedText(button),
      replays: 0,
    };
  }

  function findReplayTarget(intent) {
    if (intent.button?.isConnected && clickKind(intent.button)) return intent.button;

    const buttons = Array.from(window.document.querySelectorAll("button,[role=button]"));
    return buttons.find((button) => clickKind(button) && (
      (intent.testId && button.getAttribute?.("data-testid") === intent.testId) ||
      (intent.ariaLabel && button.getAttribute?.("aria-label") === intent.ariaLabel) ||
      (intent.text && normalizedText(button) === intent.text)
    )) || null;
  }

  function replayOutcomeVisible(intent, target) {
    if (intent.kind === "login" || intent.kind === "signup") {
      return Boolean(window.document.querySelector(
        'input[type="email"],input[name="email"],input[autocomplete="email"]',
      ));
    }
    if (intent.kind === "model") {
      return target?.getAttribute?.("aria-expanded") === "true";
    }
    return false;
  }

  function scheduleReplay(delay = replayPollMs) {
    if (replayTimer !== null) return;
    replayTimer = window.setTimeout(pollReplay, delay);
  }

  function pollReplay() {
    replayTimer = null;
    if (!pendingClick) return;

    const elapsed = (window.performance?.now?.() || startedAt) - startedAt;
    const target = findReplayTarget(pendingClick);
    if (replayOutcomeVisible(pendingClick, target) || elapsed > recoveryWindowMs) {
      pendingClick = null;
      return;
    }

    const fallbackReady = window.document.readyState === "complete" &&
      elapsed >= fallbackReplayDelayMs;
    if (target && window.document.readyState === "complete" &&
        (hasReactBinding(target) || fallbackReady)) {
      pendingClick.replays += 1;
      replayingClick = true;
      try {
        target.click();
      } finally {
        replayingClick = false;
      }

      // Dialog actions can navigate or open a provider flow. Replay them only
      // once; login/model triggers get one bounded retry if the UI stayed put.
      if (pendingClick.kind === "dialog") {
        pendingClick = null;
        return;
      }
      if (pendingClick.replays >= 2) {
        const completedIntent = pendingClick;
        window.setTimeout(() => {
          if (pendingClick === completedIntent) pendingClick = null;
        }, 1_200);
        return;
      }
      scheduleReplay(1_800);
      return;
    }

    scheduleReplay();
  }

  window.document.addEventListener("click", (event) => {
    if (replayingClick || event.isTrusted === false) return;

    const button = event.target?.closest?.("button,[role=button]");
    const kind = clickKind(button);
    if (!kind) return;

    if (pendingClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingClick = snapshotClick(button);
      scheduleReplay();
      return;
    }

    const elapsed = (window.performance?.now?.() || startedAt) - startedAt;
    const interactive = window.document.readyState === "complete" &&
      (hasReactBinding(button) || elapsed >= fallbackReplayDelayMs);
    if (interactive) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    pendingClick = snapshotClick(button);
    scheduleReplay();
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    recover(messageOf(event.reason));
  }, true);

  window.addEventListener("error", (event) => {
    recover(messageOf(event.error || event.message));
  }, true);
})();
