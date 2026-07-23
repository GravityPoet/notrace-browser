// ChatGPT can occasionally return 403 for an initial unauth-mweb module while
// the rest of the shell still renders. Recover that otherwise inert shell with
// one normal reload, matching the manual recovery path.
(() => {
  "use strict";

  const recoveryWindowMs = 30_000;
  const moduleFailure = /Failed to fetch dynamically imported module:\s*https:\/\/chatgpt\.com\/unauth-mweb\/assets\//i;

  if (window.top !== window || window.location.hostname !== "chatgpt.com") return;

  const startedAt = window.performance?.now?.() || 0;
  let reloadScheduled = false;

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

  window.addEventListener("unhandledrejection", (event) => {
    recover(messageOf(event.reason));
  }, true);

  window.addEventListener("error", (event) => {
    recover(messageOf(event.error || event.message));
  }, true);
})();
