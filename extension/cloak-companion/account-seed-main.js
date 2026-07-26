// MAIN world account seed handoff. The source extension leaves this blank;
// account launches write a per-account copy so canvas/audio perturbation is
// stable per identity and different across identities.
//
// This value is the one behind --fingerprint=<seed>: unique per account, stable
// forever, unaffected by clearing cookies or changing the proxy exit. Assigning
// it as a plain global handed every page a super-cookie that defeats the whole
// point of per-account isolation, so it now travels on a non-enumerable
// property that apply.js deletes within the same document_start batch — before
// any page script gets to run.
Object.defineProperty(window, "__cloakSeedHandoff", {
  value: "",
  configurable: true,
  enumerable: false,
  writable: true,
});
