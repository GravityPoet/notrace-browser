import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import {
  browserIdentityForVersion,
  browserIdentityHeaderRules,
  companionPageSpoofEnabled,
  distributionVersionFromPath,
  independentEngineMetadata,
  independentFingerprintArgs,
  independentLanguageArgs,
  nativeEngineIdentitySupported,
  nativeUserAgentSupported,
  keylessMacos145,
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

test("new engine generations keep native identity surfaces authoritative", () => {
  assert.equal(nativeEngineIdentitySupported({ major: "145" }), false);
  assert.equal(
    nativeEngineIdentitySupported({ major: "148", distribution: "148.0.7778.215.2" }),
    false,
  );
  assert.equal(
    nativeEngineIdentitySupported({ major: "148", distribution: "148.0.7778.215.3" }),
    true,
  );
  assert.equal(nativeEngineIdentitySupported({ major: "150" }), true);
  assert.equal(
    distributionVersionFromPath(
      "/Users/example/.cloakbrowser/chromium-150.0.7871.114.3-pro/Chromium.app/Contents/MacOS/Chromium",
    ),
    "150.0.7871.114.3",
  );
  assert.equal(
    distributionVersionFromPath(
      "/Users/example/.cloakbrowser/chromium-150.0.7871.114.4-pro-notrace/Chromium.app/Contents/MacOS/Chromium",
    ),
    "150.0.7871.114.4",
  );
});

test("verified keyless 145 keeps native UA without claiming the newer complete identity engine", () => {
  const version = { major: "145", distribution: "145.0.7632.109.2" };
  assert.equal(keylessMacos145(version), true);
  assert.equal(nativeUserAgentSupported(version), true);
  assert.equal(nativeEngineIdentitySupported(version), false);
  assert.equal(nativeUserAgentSupported({ major: "145" }), false);
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

test("independent runtime selects tested native flags without disabling the sandbox", () => {
  assert.equal(nativeEngineIdentitySupported({ major: "152", independent: true }), false);
  const args = independentFingerprintArgs("24680");
  assert.deepEqual(args, independentFingerprintArgs("24680"));
  assert.ok(args.includes("--uxr-synthetic-device-tests=true"));
  assert.ok(args.includes("--uxr-native-fingerprint-noise=true"));
  assert.ok(args.some(arg => arg.includes("Apple M3")));
  assert.ok(args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(!args.includes("--no-sandbox"));
  assert.ok(!args.some(arg => arg.startsWith("--fingerprint-webrtc-ip=")));
});

test("independent locale keeps fallback tags without passing HTTP quality weights to ICU", () => {
  assert.deepEqual(independentLanguageArgs("ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7"),
    ["--uxr-languages=ja-JP,ja,en-US,en"]);
  assert.deepEqual(independentLanguageArgs("en-US,en;q=0.9"), ["--uxr-languages=en-US,en"]);
  assert.deepEqual(independentLanguageArgs(""), []);
});

test("independent provenance rejects framework changes, unknown fields and symlink markers", () => {
  const root = mkdtempSync(join(tmpdir(), "notrace-independent-contract-"));
  try {
    const binary = join(root, "Chromium.app/Contents/MacOS/Chromium");
    const framework = join(root, "Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/152.0.7977.82/Chromium Framework");
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(dirname(framework), { recursive: true });
    writeFileSync(binary, "launcher");
    writeFileSync(framework, "fingerprints");
    assert.equal(independentEngineMetadata(binary), null);
    const hash = value => createHash("sha256").update(value).digest("hex");
    const data = { provider: "chromix", version: "152.0.7977.82",
      archive_sha256: "8ceefefced9018dfe917650ce156bd1ffdaa9bc2bc6b89b70b6d021262166eb4",
      source_commit: "ca52ae0d01168a8bc118ccc28d484011a7eb0efb",
      binary_sha256: hash("launcher"), framework_sha256: hash("fingerprints") };
    const marker = join(root, ".notrace-independent-engine.json");
    writeFileSync(marker, JSON.stringify(data));
    assert.equal(independentEngineMetadata(binary).provider, "chromix");
    writeFileSync(framework, "tampered");
    assert.throws(() => independentEngineMetadata(binary), /hash mismatch/);
    writeFileSync(framework, "fingerprints");
    writeFileSync(marker, JSON.stringify({ ...data, extra: true }));
    assert.throws(() => independentEngineMetadata(binary), /fields/);
    rmSync(marker);
    writeFileSync(join(root, "other.json"), JSON.stringify(data));
    symlinkSync(join(root, "other.json"), marker);
    assert.throws(() => independentEngineMetadata(binary), /marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
