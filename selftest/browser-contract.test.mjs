import { strict as assert } from "node:assert";
import test from "node:test";

import {
  browserIdentityForVersion,
  browserIdentityHeaderRules,
  companionPageSpoofEnabled,
  parseChromiumVersion,
  redactProxyCredentials,
} from "./browser-contract.mjs";

test("browser identity follows the installed Chromium version", () => {
  const version = parseChromiumVersion("Chromium 145.0.7632.109");
  const identity = browserIdentityForVersion(version);

  assert.deepEqual(version, { major: "145", full: "145.0.7632.109" });
  assert.match(identity.userAgent, /Chrome\/145\.0\.0\.0/);
  assert.equal(identity.uaData.brands[0].version, "145");
  assert.equal(identity.uaData.fullVersionList[0].version, "145.0.7632.109");
  assert.equal(identity.uaData.uaFullVersion, "145.0.7632.109");
});

test("companion page spoof is opt-in", () => {
  assert.equal(companionPageSpoofEnabled({}), false);
  assert.equal(companionPageSpoofEnabled({ CLOAK_COMPANION_PAGE_SPOOF: "1" }), true);
  assert.equal(companionPageSpoofEnabled({ CLOAK_JS_FINGERPRINT: "true" }), true);
  assert.equal(
    companionPageSpoofEnabled({ CLOAK_COMPANION_PAGE_SPOOF: "0", CLOAK_JS_FINGERPRINT: "1" }),
    false,
  );
});

test("browser identity rules never force high-entropy client hints", () => {
  const identity = browserIdentityForVersion({ major: "145", full: "145.0.7632.109" });
  const rules = browserIdentityHeaderRules(identity);
  const names = rules[0].action.requestHeaders.map((item) => item.header);

  assert.deepEqual(names, [
    "User-Agent",
    "Sec-CH-UA",
    "Sec-CH-UA-Mobile",
    "Sec-CH-UA-Platform",
  ]);
});

test("audit errors do not expose proxy credentials", () => {
  assert.equal(
    redactProxyCredentials("failed: socks5://alice:secret@proxy.example:1080"),
    "failed: socks5://***@proxy.example:1080",
  );
  assert.equal(
    redactProxyCredentials("http://127.0.0.1:7897"),
    "http://127.0.0.1:7897",
  );
});
