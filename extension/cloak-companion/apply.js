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
    if ((tz || fpSeed) && window.__cloakSpoof) window.__cloakSpoof(tz, fpSeed);
  } catch (_) { /* restricted origin or no storage: ignore */ }
  finally {
    try { delete window.__cloakSeedHandoff; } catch (_) {}
  }
})();
