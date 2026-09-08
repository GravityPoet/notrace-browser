import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const auditUrl = new URL("../packaging/audit-cloakbrowser-compatibility.mjs", import.meta.url);
const { wrapper } = JSON.parse(readFileSync(
  new URL("../packaging/cloakbrowser-compatibility.json", import.meta.url), "utf8",
));
const macVersion = "151.0.7922.108.3";
const linuxVersion = "151.0.7922.108.4";
const macRelease = {
  tag_name: `chromium-v${macVersion}-pro`,
  body: `Chromium ${macVersion} is Stable on macOS.\ncloakbrowser-darwin-arm64.tar.gz`,
  draft: false,
  prerelease: false,
};
const linuxRelease = {
  tag_name: `chromium-v${linuxVersion}-pro`,
  body: `Linux Stable advances. Windows and macOS Stable remain on \`${macVersion}\`.`,
  draft: false,
  prerelease: false,
};

function runAudit(latest, retained = macRelease) {
  const upstream = {
    version: wrapper.approved_versions[0],
    license: wrapper.license,
    engines: { node: wrapper.node },
    "dist.integrity": wrapper.integrity,
    gitHead: wrapper.upstream_git_head,
  };
  const retainedUrl = wrapper.upstream_release_api.replace(
    /\/latest$/, `/tags/${macRelease.tag_name}`,
  );
  const bootstrap = `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    childProcess.execFileSync = (command) => {
      if (command !== "npm") throw new Error("unexpected subprocess");
      return JSON.stringify(${JSON.stringify(upstream)});
    };
    syncBuiltinESMExports();
    const releases = ${JSON.stringify({
      [wrapper.upstream_release_api]: latest,
      [retainedUrl]: retained,
    })};
    globalThis.fetch = async (url) => {
      if (!(url in releases)) throw new Error("unexpected release URL: " + url);
      const release = releases[url];
      return { ok: release !== null, status: release === null ? 404 : 200, json: async () => release };
    };
    process.argv = [process.execPath, ${JSON.stringify(auditUrl.pathname)}, "--check-upstream"];
    await import(${JSON.stringify(auditUrl.href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", bootstrap], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

test("accepts the current release when it ships the approved macOS archive", () => {
  const result = runAudit(macRelease);
  assert.equal(result.status, 0, result.stderr);
});

test("accepts a Linux-only update that explicitly retains the verified macOS release", () => {
  const result = runAudit(linuxRelease);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, latest, retained] of [
  ["a new macOS version", { ...macRelease, tag_name: `chromium-v${linuxVersion}-pro` }],
  ["a different retained macOS version", { ...linuxRelease, body: "macOS Stable remain on `152.0.0.1`." }],
  ["an update without macOS status", { ...linuxRelease, body: "Linux-only release." }],
  ["a contradictory macOS archive", { ...linuxRelease, body: linuxRelease.body + "\ncloakbrowser-darwin-arm64.tar.gz" }],
  ["a prerelease", { ...linuxRelease, prerelease: true }],
  ["a missing retained release", linuxRelease, null],
  ["a retained release without a macOS archive", linuxRelease, { ...macRelease, body: "macOS Stable unchanged." }],
  ["a retained prerelease", linuxRelease, { ...macRelease, prerelease: true }],
]) {
  test(`rejects ${name}`, () => {
    const result = runAudit(latest, retained);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /兼容审计失败/);
  });
}
