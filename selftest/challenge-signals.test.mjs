import assert from "node:assert/strict";
import test from "node:test";

import {
  cloudflareMitigationSignal,
  mergeChallengeResponses,
} from "./challenge-signals.mjs";

test("recognizes Cloudflare's documented mitigation response header case-insensitively", () => {
  const signal = cloudflareMitigationSignal({
    params: {
      response: {
        headers: { "CF-MitIGAted": "challenge" },
        status: 403,
        url: "https://example.test/",
      },
    },
  });
  assert.deepEqual(signal, {
    provider: "cloudflare",
    signal: "cf-mitigated: challenge",
    status: 403,
    url: "https://example.test/",
  });
});

test("does not classify unrelated responses as challenges", () => {
  assert.equal(cloudflareMitigationSignal({
    params: { response: { headers: { server: "cloudflare" }, status: 200 } },
  }), null);
});

test("network signal is merged without losing existing DOM diagnostics", () => {
  const result = mergeChallengeResponses({
    passed: true,
    challenge: { detected: false, markers: ["existing-marker"] },
  }, [{ provider: "cloudflare", signal: "cf-mitigated: challenge" }]);
  assert.equal(result.passed, true);
  assert.equal(result.challenge_blocked, true);
  assert.equal(result.challenge.detected, true);
  assert.equal(result.challenge.blocked, true);
  assert.equal(result.challenge.kind, "interstitial");
  assert.deepEqual(result.challenge.markers, ["existing-marker"]);
});
