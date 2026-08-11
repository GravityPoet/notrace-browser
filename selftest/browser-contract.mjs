const MAC_UA_VERSION = "10_15_7";
const MAC_PLATFORM_VERSION = "15.5.0";
const NATIVE_IDENTITY_148_RELEASE = "148.0.7778.215.3";

const falsy = (value) => /^(0|off|false|no)$/i.test(String(value ?? ""));

export function parseChromiumVersion(output) {
  const match = String(output || "").match(/\b(\d+(?:\.\d+){1,4})\b/);
  if (!match) throw new Error(`could not parse Chromium version from: ${String(output || "").trim()}`);
  return { major: match[1].split(".", 1)[0], full: match[1] };
}

export function browserIdentityForVersion(version) {
  if (!version?.major || !version?.full) throw new Error("browser version requires major and full values");
  return {
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X ${MAC_UA_VERSION}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.major}.0.0.0 Safari/537.36`,
    platform: "MacIntel",
    uaData: {
      brands: [
        { brand: "Google Chrome", version: version.major },
        { brand: "Chromium", version: version.major },
        { brand: "Not)A;Brand", version: "24" },
      ],
      mobile: false,
      platform: "macOS",
      fullVersionList: [
        { brand: "Google Chrome", version: version.full },
        { brand: "Chromium", version: version.full },
        { brand: "Not)A;Brand", version: "24.0.0.0" },
      ],
      uaFullVersion: version.full,
      platformVersion: MAC_PLATFORM_VERSION,
      architecture: "arm",
      bitness: "64",
      model: "",
    },
  };
}

export function distributionVersionFromPath(binaryPath) {
  return String(binaryPath || "").match(
    /\/chromium-(\d+(?:\.\d+){3,4})(?:-pro)?(?:-notrace)?\/Chromium\.app\//,
  )?.[1] || "";
}

export function nativeEngineIdentitySupported(version) {
  const major = Number.parseInt(String(version?.major ?? ""), 10);
  if (Number.isInteger(major) && major >= 150) return true;
  if (major !== 148) return false;
  const current = String(version?.distribution || "").split(".").map(Number);
  const minimum = NATIVE_IDENTITY_148_RELEASE.split(".").map(Number);
  for (let index = 0; index < Math.max(current.length, minimum.length); index += 1) {
    if ((current[index] || 0) > (minimum[index] || 0)) return true;
    if ((current[index] || 0) < (minimum[index] || 0)) return false;
  }
  return current.length > 0;
}

export function companionPageSpoofEnabled(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, "CLOAK_COMPANION_PAGE_SPOOF")) {
    return !falsy(env.CLOAK_COMPANION_PAGE_SPOOF);
  }
  if (Object.prototype.hasOwnProperty.call(env, "CLOAK_JS_FINGERPRINT")) {
    return !falsy(env.CLOAK_JS_FINGERPRINT);
  }
  return false;
}

export function redactProxyCredentials(value) {
  return String(value ?? "").replace(
    /\b((?:https?|socks5):\/\/)[^/\s@]+@/gi,
    "$1***@",
  );
}

export function browserIdentityHeaderRules(identity) {
  if (!identity?.userAgent) return [];
  const uaData = identity.uaData || {};
  const headers = [
    { header: "User-Agent", operation: "set", value: identity.userAgent },
  ];
  const brands = formatHeaderBrands(uaData.brands);
  if (brands) headers.push({ header: "Sec-CH-UA", operation: "set", value: brands });
  headers.push({ header: "Sec-CH-UA-Mobile", operation: "set", value: uaData.mobile ? "?1" : "?0" });
  if (uaData.platform) {
    headers.push({ header: "Sec-CH-UA-Platform", operation: "set", value: quoteHeader(uaData.platform) });
  }
  return [{
    id: 91001,
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders: headers },
    condition: {
      regexFilter: "^https?://",
      resourceTypes: ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "xmlhttprequest", "media", "other"],
    },
  }];
}

function quoteHeader(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatHeaderBrands(brands) {
  if (!Array.isArray(brands)) return "";
  return brands
    .filter((item) => item && typeof item.brand === "string" && typeof item.version === "string")
    .map((item) => `${quoteHeader(item.brand)};v=${quoteHeader(item.version)}`)
    .join(", ");
}
