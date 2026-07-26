// MAIN world, document_start, runs right after spoof.js. Applies the spoof
// synchronously from the localStorage timezone seed maintained by seed.js —
// this is the race-free path: it does NOT depend on the (cold-start-asleep)
// service worker.
//
// Wrapped in an IIFE because this runs in the page's global scope: a top-level
// `var fpSeed` would publish the account seed as window.fpSeed, which is the
// same super-cookie the non-enumerable handoff exists to prevent.
(function () {
  "use strict";
  try {
    var tz = localStorage.getItem("__cl_tz");
    // No localStorage fallback for the seed: localStorage is page-writable, so a
    // site could pin the seed to a value it chose and make the canvas and audio
    // noise predictable.
    var fpSeed = window.__cloakSeedHandoff;
    if (!tz && !fpSeed) return;
    // spoof.js publishes nothing on window — a global there is a one-expression
    // tell that names the product, and the bare engine has none. Its entry point
    // comes back from the toString handshake instead; the native toString ignores
    // extra arguments, so this call is simply inert if spoof.js did not load.
    var shared = Function.prototype.toString.call(null, "cloak.shared-state.v1");
    if (shared && typeof shared === "object" && shared.spoof) shared.spoof(tz, fpSeed);
  } catch (_) { /* restricted origin, no storage, or spoof.js absent: ignore */ }
  finally {
    try { delete window.__cloakSeedHandoff; } catch (_) {}
  }
})();
