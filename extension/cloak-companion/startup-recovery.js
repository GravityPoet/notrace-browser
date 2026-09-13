// Recover two bounded OpenAI startup failures without touching normal pages:
// an auth route that received HTML instead of JSON, and ChatGPT's unauth-mweb
// module failure. Keep normal page interaction untouched while the app hydrates.
(() => {
  "use strict";

  const recoveryWindowMs = 30_000;
  const moduleFailure = /Failed to fetch dynamically imported module:\s*https:\/\/chatgpt\.com\/unauth-mweb\/assets\//i;
  const authRouteFailure = /Route Error\s*\(400 Invalid content type:\s*text\/html;\s*charset=UTF-8\)/i;
  const recoverableAuthPaths = new Set(["/api/accounts/authorize", "/log-in/password"]);
  const authRecoveryKeyPrefix = "notrace.auth-route-recovery:";

  if (window.top !== window) return;

  function wasReloadNavigation() {
    try {
      const navigation = window.performance?.getEntriesByType?.("navigation")?.[0];
      return navigation?.type === "reload";
    } catch (_) {
      return false;
    }
  }

  function recoverAuthRoute() {
    const path = window.location.pathname;
    if (!recoverableAuthPaths.has(path)) return;

    const key = `${authRecoveryKeyPrefix}${path}`;
    const pageText = String(
      window.document.body?.innerText || window.document.body?.textContent || "",
    ).replace(/\s+/g, " ");
    if (!authRouteFailure.test(pageText)) {
      try {
        window.sessionStorage.removeItem(key);
      } catch (_) {
        // A blocked session store must not affect a healthy auth page.
      }
      return;
    }

    if (wasReloadNavigation()) return;
    const now = Date.now();
    try {
      const lastAttempt = Number(window.sessionStorage.getItem(key) || 0);
      if (lastAttempt > 0 && now - lastAttempt < recoveryWindowMs) return;
      window.sessionStorage.setItem(key, String(now));
    } catch (_) {
      // Navigation type still provides a one-reload loop guard.
    }
    window.setTimeout(() => window.location.reload(), 250);
  }

  if (window.location.hostname === "auth.openai.com") {
    recoverAuthRoute();
    return;
  }
  if (window.location.hostname !== "chatgpt.com") return;

  const startedAt = window.performance?.now?.() || 0;
  let reloadScheduled = false;

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
