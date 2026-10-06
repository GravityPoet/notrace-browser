import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

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
  if (version?.independent) return false;
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

export function keylessMacos145(version) {
  return !version?.independent && version?.distribution === "145.0.7632.109.2";
}

export function nativeUserAgentSupported(version) {
  return Boolean(version?.independent || nativeEngineIdentitySupported(version) || keylessMacos145(version));
}

export function independentEngineMetadata(binary) {
  const app = dirname(dirname(dirname(binary)));
  const marker = join(dirname(app), ".notrace-independent-engine.json");
  let file;
  try { file = lstatSync(marker); } catch (error) {
    if (error.code === "ENOENT") {
      if (basename(dirname(app)) === "chromium-152.0.7977.82-notrace") throw new Error("missing independent engine marker");
      return null;
    }
    throw error;
  }
  if (!file.isFile() || file.size > 4096) throw new Error("invalid independent engine marker");
  const data = JSON.parse(readFileSync(marker, "utf8"));
  const fields = ["provider", "version", "archive_sha256", "source_commit", "binary_sha256", "framework_sha256"].sort();
  if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(fields)) {
    throw new Error("invalid independent engine fields");
  }
  const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  if (data.provider !== "chromix" || data.version !== "152.0.7977.82"
      || data.archive_sha256 !== "8ceefefced9018dfe917650ce156bd1ffdaa9bc2bc6b89b70b6d021262166eb4"
      || data.source_commit !== "ca52ae0d01168a8bc118ccc28d484011a7eb0efb"
      || hash(binary) !== data.binary_sha256
      || hash(join(app, `Contents/Frameworks/Chromium Framework.framework/Versions/${data.version}/Chromium Framework`)) !== data.framework_sha256) {
    throw new Error("independent engine provenance or hash mismatch");
  }
  return data;
}

export function independentFingerprintArgs(seed) {
  const bucket = createHash("sha256").update(`gpu:${seed}`).digest().readUInt32BE(0) % 4 + 1;
  return [
    "--uxr-synthetic-device-tests=true",
    "--uxr-native-fingerprint-noise=true",
    "--fingerprint-hardware-concurrency=8",
    "--fingerprint-device-memory=8",
    "--fingerprint-gpu-vendor=Google Inc. (Apple)",
    `--fingerprint-gpu-renderer=ANGLE (Apple, ANGLE Metal Renderer: Apple M${bucket}, Unspecified Version)`,
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

export function independentLanguageArgs(acceptLanguage) {
  const languages = String(acceptLanguage || "").split(",")
    .map(item => item.split(";", 1)[0].trim()).filter(Boolean).join(",");
  return languages ? [`--uxr-languages=${languages}`] : [];
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
