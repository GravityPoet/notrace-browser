// Passive challenge reporting only. These helpers recognize Cloudflare's
// documented response signal; they do not solve, suppress, or bypass it.
export function cloudflareMitigationSignal(message) {
  const response = message?.params?.response;
  if (!response?.headers || typeof response.headers !== "object") return null;
  const entry = Object.entries(response.headers)
    .find(([name]) => name.toLowerCase() === "cf-mitigated");
  if (!entry || String(entry[1]).trim().toLowerCase() !== "challenge") return null;
  return {
    provider: "cloudflare",
    signal: "cf-mitigated: challenge",
    url: response.url || null,
    status: response.status ?? null,
  };
}

export function mergeChallengeResponses(details, signals) {
  if (!signals.length) return details;
  const output = details && typeof details === "object" ? details : {};
  const previous = output.challenge && typeof output.challenge === "object"
    ? output.challenge
    : {};
  return {
    ...output,
    challenge: {
      ...previous,
      detected: true,
      blocked: true,
      kind: "interstitial",
      provider: "cloudflare",
      response_signals: signals,
    },
    challenge_blocked: true,
  };
}
