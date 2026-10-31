import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdirSync, writeFileSync, renameSync, symlinkSync } from "node:fs";
import { disposableProfile } from "./disposable-profile.mjs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import {
  acceptCanvasBaseline,
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

test("the accepted Canvas baseline is exact-version, exact-output and cannot waive unrelated failures", () => {
  const name = "canvas reads and encoded pixels agree across <canvas> and OffscreenCanvas";
  const realms = { html_pixels: "same", offscreen_pixels: "same", pixels_after_encode: "same",
    html_blob_pixels: { hash: "first" }, offscreen_blob_pixels: { hash: "second" } };
  const sample = seed => ({ seed, probe: { canvas_realms: structuredClone(realms) } });
  const baseline = { browser_binary: "/cache/chromium-151.0.7922.108.3-pro-notrace/Chromium.app/Contents/MacOS/Chromium",
    probe_sha256: "test-probe", options: { headless: true }, pair: { a: sample("1"), b: sample("2") },
    checks: [{ name: `A: ${name}`, pass: false, level: "hard" }, { name: `B: ${name}`, pass: false, level: "hard" },
      { name: "WebRTC", pass: true, level: "hard" }] };
  const candidate = () => ({ ...structuredClone(baseline),
    browser_binary: "/cache/chromium-154.0.8037.57.1-pro-notrace/Chromium.app/Contents/MacOS/Chromium" });
  const approved = candidate();
  assert.equal(acceptCanvasBaseline(approved, baseline), true);
  assert.equal(approved.checks[0].pass, false);
  assert.equal(approved.checks[0].level, "known-baseline-issue");
  const baseline155 = { ...structuredClone(baseline),
    browser_binary: "/cache/chromium-154.0.8037.57.1-pro-notrace/Chromium.app/Contents/MacOS/Chromium" };
  const candidate155 = { ...structuredClone(baseline155),
    browser_binary: "/cache/chromium-155.0.8059.39.1-pro-notrace/Chromium.app/Contents/MacOS/Chromium" };
  assert.equal(acceptCanvasBaseline(candidate155, baseline155), true);
  assert.equal(candidate155.checks[0].level, "known-baseline-issue");
  const selfBaseline155 = { ...structuredClone(candidate155) };
  const selfCandidate155 = { ...structuredClone(candidate155) };
  assert.equal(acceptCanvasBaseline(selfCandidate155, selfBaseline155), true);
  assert.equal(selfCandidate155.known_issues[0].id, "cloak-155-canvas-noise-encoder-parity");
  const unrelated = candidate();
  unrelated.checks[2].pass = false;
  assert.equal(acceptCanvasBaseline(unrelated, baseline), true);
  assert.equal(unrelated.checks[2].level, "hard");
  for (const change of [
    value => { value.browser_binary = value.browser_binary.replace("154.", "155."); },
    value => { value.probe_sha256 = "changed"; },
    value => { value.options.headless = false; },
    value => { value.pair.a.seed = "different"; },
    value => { value.pair.a.probe.canvas_realms.html_blob_pixels.hash = "new-defect"; },
    value => { value.pair.a.probe.canvas_realms.error = "new-error"; },
  ]) {
    const rejected = candidate(); change(rejected);
    assert.equal(acceptCanvasBaseline(rejected, baseline), false);
    assert.equal(rejected.checks[0].level, "hard");
  }
});

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
      "/tmp/fixture/.cloakbrowser/chromium-150.0.7871.114.3-pro/Chromium.app/Contents/MacOS/Chromium",
    ),
    "150.0.7871.114.3",
  );
  assert.equal(
    distributionVersionFromPath(
      "/tmp/fixture/.cloakbrowser/chromium-150.0.7871.114.4-pro-notrace/Chromium.app/Contents/MacOS/Chromium",
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
  const fixture = disposableProfile("cloak-independent-contract-");
  const root = fixture.path;
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
    renameSync(marker, join(root, "marker-before-symlink.json"));
    writeFileSync(join(root, "other.json"), JSON.stringify(data));
    symlinkSync(join(root, "other.json"), marker);
    assert.throws(() => independentEngineMetadata(binary), /marker/);
  } finally {
    fixture.recycle();
  }
});

test("native independent provenance accepts the local source and patch contract", () => {
  const fixture = disposableProfile("cloak-native-contract-");
  const root = fixture.path;
  try {
    const binary = join(root, "Chromium.app/Contents/MacOS/Chromium");
    const framework = join(root, "Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/152.0.7977.82/Chromium Framework");
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(dirname(framework), { recursive: true });
    writeFileSync(binary, "native-launcher");
    writeFileSync(framework, "native-framework");
    const hash = value => createHash("sha256").update(value).digest("hex");
    writeFileSync(join(root, ".notrace-independent-engine.json"), JSON.stringify({
      provider: "notrace-native",
      version: "152.0.7977.82",
      engine_version: "152.0.7977.82",
      source_commit: "f1e41d82ca3fb9e83cedc06e22ff5f3073e8c542",
      source_lock_sha256: "0".repeat(64),
      patch_stack_sha256: "1".repeat(64),
      binary_sha256: hash("native-launcher"),
      framework_sha256: hash("native-framework"),
    }));
    assert.equal(independentEngineMetadata(binary).provider, "notrace-native");
  } finally {
    fixture.recycle();
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
  const rawProxy = ["socks5://", "alice", ":secret@", "proxy.example:1080"].join("");
  assert.equal(
    redactProxyCredentials(`failed: ${rawProxy}`),
    "failed: socks5://***@proxy.example:1080",
  );
  assert.equal(
    redactProxyCredentials("http://127.0.0.1:7897"),
    "http://127.0.0.1:7897",
  );
});
