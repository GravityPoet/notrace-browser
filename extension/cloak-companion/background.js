// Timezone matching — service worker.
//
// The race-free, cold-start-proof path is the declared content scripts
// (seed.js + spoof.js/apply.js, document_start) driven by a localStorage seed.
// This worker only:
//   - auto-detects the IP timezone on first install (when none is chosen),
//   - re-injects already-open tabs immediately when the zone changes,
//   - provides a first-load fallback before the localStorage seed exists,
//   - answers the popup's "detect my IP zone" request.
// The page-visible spoof itself lives in spoof.js (single source of truth).

try { importScripts("browser-identity-worker.js"); } catch (_) {}

const ZONE_RE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+){1,2}$/;
const BROWSER_IDENTITY_HEADER_RULE_ID = 91001;
// No longer added — kept so a session rule left by an older build, which forced
// high-entropy client hints onto every request, is removed on startup.
const STALE_HIGH_ENTROPY_RULE_ID = 91002;

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
installBrowserIdentityHeaderRules();

async function init() {
  await installBrowserIdentityHeaderRules();
  let { tz, auto } = await chrome.storage.local.get(["tz", "auto"]);
  if (!tz && auto !== false) {
    const detected = await detectIPTimezone();
    if (detected) { tz = detected; await chrome.storage.local.set({ tz, autoDetected: detected }); }
  }
  if (tz) injectOpenTabs(tz);
}

// Zone changed (popup writes storage.tz): update every open tab now. seed.js will
// refresh the localStorage seed on the next load of each origin.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tz && changes.tz.newValue) injectOpenTabs(changes.tz.newValue);
});

// Fallback for the very first load of an origin, before its localStorage seed
// exists (declared apply.js no-ops then). Harmless duplicate once seeded.
chrome.webNavigation.onCommitted.addListener(async (d) => {
  const { tz } = await chrome.storage.local.get("tz");
  if (tz) injectTab({ tabId: d.tabId, frameIds: [d.frameId] }, tz);
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "detectTZ") { detectIPTimezone().then(reply); return true; }
});

// Inject spoof.js (defines window.__cloakSpoof) then invoke it with tz. Two
// sequential injections so the invoke never races the definition.
async function injectTab(target, tz) {
  if (!ZONE_RE.test(tz)) return;
  try {
    await chrome.scripting.executeScript({ target, world: "MAIN", injectImmediately: true, files: ["spoof.js"] });
    await chrome.scripting.executeScript({
      target, world: "MAIN", injectImmediately: true,
      func: (t) => { if (window.__cloakSpoof) window.__cloakSpoof(t); }, args: [tz],
    });
  } catch (_) { /* chrome:// and other restricted targets: ignore */ }
}

async function injectOpenTabs(tz) {
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const t of tabs) injectTab({ tabId: t.id, allFrames: true }, tz);
  } catch (_) {}
}

async function detectIPTimezone() {
  const sources = ["https://ipapi.co/timezone/", "https://worldtimeapi.org/api/ip"];
  for (const url of sources) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) continue;
      const body = await r.text();
      const tz = url.includes("worldtimeapi") ? (JSON.parse(body).timezone || "") : body.trim();
      // Strict IANA shape, anchored both ends, so a hostile response cannot smuggle
      // markup/extra data downstream (e.g. America/Argentina/Buenos_Aires).
      if (ZONE_RE.test(tz)) return tz;
    } catch (_) { /* try next */ }
  }
  return null;
}

async function installBrowserIdentityHeaderRules() {
  try {
    const dnr = chrome.declarativeNetRequest;
    const identity = self.__cloakBrowserIdentity;
    if (!dnr || !identity || !identity.userAgent) return;

    const uaData = identity.uaData || {};
    const brands = formatBrands(uaData.brands);

    // Chrome sends only these unprompted, so overriding them everywhere leaves
    // the request shape unchanged.
    const lowEntropy = [
      { header: "User-Agent", operation: "set", value: identity.userAgent },
    ];
    if (brands) lowEntropy.push({ header: "Sec-CH-UA", operation: "set", value: brands });
    lowEntropy.push({ header: "Sec-CH-UA-Mobile", operation: "set", value: uaData.mobile ? "?1" : "?0" });
    if (uaData.platform) lowEntropy.push({ header: "Sec-CH-UA-Platform", operation: "set", value: quoteHeader(uaData.platform) });

    // The remaining high-entropy hints are deliberately not forced. A real
    // Chrome sends them only to an origin that asked via Accept-CH, so setting
    // them on every request is a shape every server can spot, and strict CDNs
    // reject it — which looks like a page whose stylesheets failed while the
    // document loaded. declarativeNetRequest cannot scope them to opted-in
    // origins here: condition.requestHeaders is silently ignored by this engine.
    // The engine supplies them instead, though it currently sends an empty
    // Sec-CH-UA-Bitness and a Sec-CH-UA-Full-Version-List that disagrees with
    // Sec-CH-UA — an engine bug to fix at the source rather than trade for a
    // tell every origin can read.

    const resourceTypes = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "xmlhttprequest", "media", "other"];
    await dnr.updateSessionRules({
      removeRuleIds: [BROWSER_IDENTITY_HEADER_RULE_ID, STALE_HIGH_ENTROPY_RULE_ID],
      addRules: [{
        id: BROWSER_IDENTITY_HEADER_RULE_ID,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: lowEntropy },
        condition: { regexFilter: "^https?://", resourceTypes },
      }],
    });
  } catch (_) { /* header rules are best-effort; page spoof still applies */ }
}

function quoteHeader(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function formatBrands(brands) {
  if (!Array.isArray(brands)) return "";
  return brands
    .filter((item) => item && typeof item.brand === "string" && typeof item.version === "string")
    .map((item) => `${quoteHeader(item.brand)};v=${quoteHeader(item.version)}`)
    .join(", ");
}
