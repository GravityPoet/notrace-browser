#!/usr/bin/env node
// Headed/live stealth audit for the local patched CloakBrowser binary.
//
// This is intentionally an audit harness, not a challenge solver: it launches a
// temporary profile with the same Rust launch-plan flags, records observable
// detection-site verdicts, and saves a JSON report plus screenshots.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cloudflareMitigationSignal,
  mergeChallengeResponses,
} from "./challenge-signals.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dir);
const CLOAK = join(ROOT, "target", "debug", "cloak");
const EXT_SOURCE = join(ROOT, "extension", "cloak-companion");
const DEFAULT_BIN = `${process.env.HOME}/.cloakbrowser/current/Chromium.app/Contents/MacOS/Chromium`;
const RUNTIME_SHA_FILE = `${process.env.HOME}/.cloakbrowser/current.sha256`;
const SHA_FILE = process.env.CLOAK_BROWSER_SHA_FILE
  || (existsSync(RUNTIME_SHA_FILE) ? RUNTIME_SHA_FILE : join(ROOT, "packaging", "cloakbrowser-current.sha256"));
const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
const TURNSTILE_TEST_VALIDATION_KEY = "1x0000000000000000000000000000000AA";

const SITE_DEFS = {
  "version-consistency": {
    // Replaced at runtime with a local HTTP origin. The companion extension
    // intentionally matches web origins, not browser-internal about: pages.
    url: "local://version-consistency",
    waitMs: 1000,
    evaluate: `(async () => {
      const ua = navigator.userAgent || "";
      const uaMatch = ua.match(/Chrome\\/(\\d+)/);
      const uaMajor = uaMatch ? uaMatch[1] : null;
      const platform = navigator.platform;
      const hwConcurrency = navigator.hardwareConcurrency;
      const deviceMemory = navigator.deviceMemory ?? null;
      let uaDataResult = null;
      if (navigator.userAgentData) {
        try {
          uaDataResult = await navigator.userAgentData.getHighEntropyValues([
            "architecture", "bitness", "brands", "fullVersionList",
            "mobile", "model", "platform", "platformVersion", "uaFullVersion",
          ]);
        } catch (error) {
          uaDataResult = { error: String(error?.message || error) };
        }
      }
      const chMajor = uaDataResult?.brands?.[0]?.version || null;
      const fvlMajor = uaDataResult?.fullVersionList?.[0]?.version?.split(".")?.[0] || null;
      const issues = [];
      if (!uaMajor) issues.push("UA missing Chrome version");
      if (!uaDataResult) issues.push("userAgentData missing");
      if (uaMajor && chMajor && uaMajor !== chMajor) issues.push("UA major != brands major");
      if (uaMajor && fvlMajor && uaMajor !== fvlMajor) issues.push("UA major != fullVersionList major");
      if (uaDataResult && !uaDataResult.platformVersion) issues.push("platformVersion missing");
      if (uaDataResult && !uaDataResult.architecture) issues.push("architecture missing");
      if (uaDataResult && !uaDataResult.bitness) issues.push("bitness missing");
      if (uaDataResult && !Array.isArray(uaDataResult.fullVersionList)) issues.push("fullVersionList missing");
      return {
        ua,
        uaMajor,
        chMajor,
        fvlMajor,
        platform,
        hwConcurrency,
        deviceMemory,
        uaData: uaDataResult,
        issues,
        passed: issues.length === 0,
      };
    })()`,
  },
  "cloudflare-turnstile-test": {
    // Replaced at runtime with a local page using Cloudflare's official
    // always-pass dummy key. No production credential or challenge bypass is
    // involved.
    url: "local://cloudflare-turnstile-test",
    waitMs: 10000,
    expectedChallengeKind: "turnstile-widget",
    evaluate: `(async () => {
      const state = window.__turnstileAudit || {};
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      const token = state.token || input?.value || "";
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      const apiLoaded = Boolean(window.turnstile && typeof window.turnstile.render === "function");
      return {
        apiLoaded,
        iframePresentAtSample: Boolean(iframe),
        widgetCompleted: state.status === "passed" && token.length > 0,
        callbackStatus: state.status || "pending",
        tokenPresent: token.length > 0,
        dummyToken: /DUMMY\\.TOKEN/i.test(token),
        clientError: state.error || null,
        _turnstileToken: token,
        passed: apiLoaded
          && state.status === "passed"
          && /DUMMY\\.TOKEN/i.test(token)
          && !state.error,
      };
    })()`,
  },
  sannysoft: {
    url: "https://bot.sannysoft.com",
    waitMs: 6000,
    evaluate: `(() => {
      const rows = Array.from(document.querySelectorAll("table tr"));
      const failed = [];
      let total = 0;
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 2) continue;
        total += 1;
        const key = cells[0].innerText.trim();
        const value = cells[1].innerText.trim();
        const cls = cells[1].className || "";
        if (cls.includes("failed")) failed.push({ key, value });
      }
      return { total, failed, passed: total > 0 && failed.length === 0 };
    })()`,
  },
  browserscan: {
    url: "https://www.browserscan.net/bot-detection",
    waitMs: 9000,
    evaluate: `(() => {
      const text = document.body.innerText || "";
      const normal = (text.match(/Normal/g) || []).length;
      const abnormal = (text.match(/Abnormal/g) || []).length;
      return {
        normal,
        abnormal,
        passed: normal > 0 && abnormal === 0,
        sample: text.slice(0, 800),
      };
    })()`,
  },
  fingerprintjs: {
    url: "https://demo.fingerprint.com/web-scraping",
    waitMs: 9000,
    beforeEvaluate: `(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const search = buttons.find((button) => /search/i.test(button.innerText || button.textContent || ""));
      if (search) search.click();
      return Boolean(search);
    })()`,
    afterActionWaitMs: 6000,
    evaluate: `(() => {
      const text = document.body.innerText || "";
      const hasFlights = text.includes("Price per adult") || /\\$\\s*\\d/.test(text);
      const isBlocked = /malicious bot detected/i.test(text)
        || /access denied/i.test(text)
        || /request was blocked/i.test(text)
        || /bot visit detected/i.test(text);
      return {
        passed: hasFlights && !isBlocked,
        isBlocked,
        hasFlights,
        sample: text.slice(0, 800),
      };
    })()`,
  },
  "browserleaks-webrtc": {
    url: "https://browserleaks.com/webrtc",
    waitMs: 8000,
    evaluate: `((expectedIp) => new Promise((resolve) => {
      const text = document.body.innerText || "";
      const candidates = [];
      let pc = null;
      try {
        pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        pc.createDataChannel("cloak-audit");
        pc.onicecandidate = (event) => {
          if (event.candidate?.candidate) candidates.push(event.candidate.candidate);
        };
        pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
      } catch (error) {
        candidates.push(String(error?.message || error));
      }
      setTimeout(() => {
        try { pc?.close(); } catch {}
        const all = [text, ...candidates].join("\\n");
        const ips = Array.from(new Set(all.match(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g) || []));
        const privateIps = ips.filter((ip) => /^(10\\.|127\\.|169\\.254\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)/.test(ip));
        const hasExpectedIp = expectedIp ? all.includes(expectedIp) : null;
        resolve({
          expectedIp,
          pageLoaded: /WebRTC|Local IP|Public IP|Leak/i.test(text),
          ips,
          privateIps,
          hasExpectedIp,
          candidates: candidates.slice(0, 10),
          passed: privateIps.length === 0 && (expectedIp ? hasExpectedIp === true : true),
          sample: text.slice(0, 800),
        });
      }, 5000);
    }))(__EXPECTED_IP__)`,
  },
  creepjs: {
    url: "https://abrahamjuliot.github.io/creepjs",
    waitMs: 18000,
    evaluate: `(() => {
      const text = document.body.innerText || "";
      const likeMatch = text.match(/(\\d+)%\\s*like headless/i);
      const headlessMatch = text.match(/(\\d+)%\\s*headless:/i);
      const stealthMatch = text.match(/(\\d+)%\\s*stealth:/i);
      const scores = {
        likeHeadlessPct: likeMatch ? Number(likeMatch[1]) : null,
        headlessPct: headlessMatch ? Number(headlessMatch[1]) : null,
        stealthPct: stealthMatch ? Number(stealthMatch[1]) : null,
      };
      const signals = (() => {
        try {
          const headless = window.Fingerprint?.headless;
          if (!headless) return null;
          return {
            likeHeadless: headless.likeHeadless || null,
            headless: headless.headless || null,
            stealth: headless.stealth || null,
          };
        } catch {
          return null;
        }
      })();
      const diagnostics = (() => {
        try {
          const nav = navigator;
          const navProto = Navigator.prototype;
          const webdriverDescriptor = Object.getOwnPropertyDescriptor(navProto, "webdriver");
          const contactsDescriptor = Object.getOwnPropertyDescriptor(navProto, "contacts");
          const contacts = nav.contacts;
          return {
            webdriver: nav.webdriver,
            webdriverDescriptor: webdriverDescriptor ? {
              hasGetter: typeof webdriverDescriptor.get === "function",
              getterString: webdriverDescriptor.get ? Function.prototype.toString.call(webdriverDescriptor.get) : null,
              value: webdriverDescriptor.value,
            } : null,
            contactsInNavigator: "contacts" in nav,
            contactsType: typeof contacts,
            contactsString: contacts ? Object.prototype.toString.call(contacts) : null,
            contactsConstructor: contacts?.constructor?.name || null,
            contactsOwnKeys: contacts ? Reflect.ownKeys(contacts).map(String) : [],
            contactsDescriptor: contactsDescriptor ? {
              hasGetter: typeof contactsDescriptor.get === "function",
              getterString: contactsDescriptor.get ? Function.prototype.toString.call(contactsDescriptor.get) : null,
            } : null,
            contentIndex: typeof window.ContentIndex,
            connectionDownlinkMax: nav.connection ? ("downlinkMax" in nav.connection) : null,
            functionToString: Function.prototype.toString.toString(),
          };
        } catch (error) {
          return { error: String(error?.message || error) };
        }
      })();
      const badBot = /you are a bad bot/i.test(text);
      const trustMatch = text.match(/trust score[^0-9]*(\\d+(?:\\.\\d+)?)/i);
      return {
        pageLoaded: /creepjs|trust score|fingerprint|FP ID|Headless/i.test(text),
        trustScore: trustMatch ? Number(trustMatch[1]) : null,
        scores,
        signals,
        diagnostics,
        badBot,
        passed: text.length > 500
          && !badBot
          && scores.headlessPct !== null
          && scores.stealthPct !== null
          && scores.headlessPct <= 30
          && scores.stealthPct <= 30,
        sample: text.slice(0, 1000),
      };
    })()`,
  },
  "fingerprint-pro": {
    url: "https://fingerprint.com/products/bot-detection",
    waitMs: 12000,
    beforeEvaluate: `(() => {
      const buttons = Array.from(document.querySelectorAll("button, a"));
      const target = buttons.find((button) => {
        const text = (button.innerText || button.textContent || "").trim();
        return /test|try|detect|demo|playground/i.test(text) && !/contact sales|get started/i.test(text);
      });
      if (target) target.click();
      return target ? (target.innerText || target.textContent || "").trim() : "";
    })()`,
    afterActionWaitMs: 5000,
    evaluate: `(async () => {
      const text = document.body.innerText || "";
      const isBlocked = /malicious bot detected|access denied|request was blocked|bad bot|bot visit detected/i.test(text);
      const hasVerdict = /you are|not a bot|human|bot detected|automation|visitor/i.test(text);
      const browserMismatch = /browser not available on mac os x/i.test(text);
      const uaData = navigator.userAgentData
        ? await navigator.userAgentData.getHighEntropyValues([
            "architecture",
            "bitness",
            "brands",
            "fullVersionList",
            "mobile",
            "model",
            "platform",
            "platformVersion",
            "uaFullVersion",
          ]).catch((error) => ({ error: String(error?.message || error) }))
        : null;
      return {
        pageLoaded: /fingerprint|bot detection/i.test(text),
        hasVerdict,
        isBlocked,
        browserMismatch,
        navigator: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language,
          languages: Array.from(navigator.languages || []),
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory ?? null,
          uaData,
        },
        passed: hasVerdict ? !isBlocked && !browserMismatch : false,
        sample: text.slice(0, 1000),
      };
    })()`,
  },
  deviceinfo: {
    url: "https://deviceandbrowserinfo.com/are_you_a_bot",
    waitMs: 10000,
    evaluate: `(() => {
      const text = document.body.innerText || "";
      const botMatch = text.match(/"isBot":\\s*(true|false)/);
      const isBot = botMatch ? botMatch[1] === "true" : null;
      const checks = {};
      for (const key of [
        "isBot",
        "hasBotUserAgent",
        "hasWebdriverTrue",
        "isHeadlessChrome",
        "isAutomatedWithCDP",
        "hasSuspiciousWeakSignals",
        "isPlaywright",
        "hasInconsistentChromeObject",
      ]) {
        const match = text.match(new RegExp('"' + key + '":\\\\s*(true|false)'));
        if (match) checks[key] = match[1] === "true";
      }
      return { passed: isBot === false, isBot, checks, sample: text.slice(0, 800) };
    })()`,
  },
};

function parseArgs(argv) {
  const opts = {
    headless: false,
    keep: false,
    screenshots: true,
    timeoutMs: 45000,
    accountName: `live-audit-${Date.now()}`,
    sites: [],
    manualUrls: [],
    resultDir: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case "--headless":
        opts.headless = true;
        break;
      case "--headed":
        opts.headless = false;
        break;
      case "--keep":
        opts.keep = true;
        break;
      case "--no-screenshots":
        opts.screenshots = false;
        break;
      case "--timeout-ms":
        opts.timeoutMs = Number(next());
        break;
      case "--account-name":
        opts.accountName = next();
        break;
      case "--site":
        opts.sites.push(next());
        break;
      case "--manual-url":
        opts.manualUrls.push(next());
        break;
      case "--result-dir":
        opts.resultDir = resolve(next());
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (opts.sites.length === 0 && opts.manualUrls.length === 0) {
    opts.sites = ["browserscan", "fingerprintjs"];
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 5000) {
    throw new Error("--timeout-ms must be at least 5000");
  }
  for (const site of opts.sites) {
    if (!SITE_DEFS[site]) {
      throw new Error(`unknown site: ${site}; use one of ${Object.keys(SITE_DEFS).join(", ")}`);
    }
  }
  return opts;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function ensureCli() {
  if (existsSync(CLOAK)) return;
  runChecked("cargo", ["build", "-p", "cloak-cli"], { cwd: ROOT });
}

function verifyBrowserHash() {
  const bin = process.env.CLOAK_BROWSER_BIN || DEFAULT_BIN;
  if (!existsSync(bin)) throw new Error(`CloakBrowser binary not found: ${bin}`);
  const envExpected = process.env.CLOAK_BROWSER_EXPECTED_SHA256;
  if (!envExpected && !existsSync(SHA_FILE)) return { bin, checked: false };
  const expected = (envExpected || readFileSync(SHA_FILE, "utf8").trim().split(/\s+/)[0]).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("CLOAK_BROWSER expected hash must be a 64-character SHA256");
  }
  const got = runChecked("shasum", ["-a", "256", bin]).trim().split(/\s+/)[0];
  if (got !== expected) {
    throw new Error(`CloakBrowser hash changed: got ${got}, expected ${expected}`);
  }
  return {
    bin,
    checked: true,
    sha256: got,
    hash_source: envExpected ? "CLOAK_BROWSER_EXPECTED_SHA256" : SHA_FILE,
  };
}

function truthy(value) {
  return /^(1|on|true|yes)$/i.test(String(value ?? ""));
}

function falsy(value) {
  return /^(0|off|false|no)$/i.test(String(value ?? ""));
}

function companionPageSpoofEnabled() {
  if (Object.prototype.hasOwnProperty.call(process.env, "CLOAK_COMPANION_PAGE_SPOOF")) {
    return !falsy(process.env.CLOAK_COMPANION_PAGE_SPOOF);
  }
  if (Object.prototype.hasOwnProperty.call(process.env, "CLOAK_JS_FINGERPRINT")) {
    return !falsy(process.env.CLOAK_JS_FINGERPRINT);
  }
  return true;
}

function stripCompanionPageScripts(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.content_scripts;
  delete manifest.host_permissions;
  delete manifest.background;
  delete manifest.declarative_net_request;
  manifest.permissions = ["storage"];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function prepareCompanion(plan) {
  const dest = plan.extension_runtime_path;
  rmSync(dest, { recursive: true, force: true });
  cpSync(EXT_SOURCE, dest, { recursive: true });
  const identity = plan.browser_identity || null;
  writeFileSync(join(dest, "browser-identity-main.js"), `window.__cloakBrowserIdentity = ${JSON.stringify(identity)};\n`);
  writeFileSync(join(dest, "browser-identity-worker.js"), `self.__cloakBrowserIdentity = ${JSON.stringify(identity)};\n`);
  writeBrowserIdentityHeaderRules(dest, identity);
  if (companionPageSpoofEnabled()) {
    writeFileSync(join(dest, "account-seed-main.js"), `window.__cloakAccountSeed = ${JSON.stringify(String(plan.seed))};\n`);
  } else {
    writeFileSync(join(dest, "account-seed-main.js"), "window.__cloakAccountSeed = \"\";\n");
    stripCompanionPageScripts(join(dest, "manifest.json"));
  }
}

function applyBrowserIdentityOverride(plan) {
  if (!process.env.CLOAK_AUDIT_BROWSER_IDENTITY_JSON) return null;
  const identity = JSON.parse(process.env.CLOAK_AUDIT_BROWSER_IDENTITY_JSON);
  if (!identity || typeof identity.userAgent !== "string") {
    throw new Error("CLOAK_AUDIT_BROWSER_IDENTITY_JSON must include string userAgent");
  }
  plan.browser_identity = identity;
  plan.argv = plan.argv.map((arg) => (
    arg.startsWith("--user-agent=") ? `--user-agent=${identity.userAgent}` : arg
  ));
  return identity;
}

function writeBrowserIdentityHeaderRules(dest, identity) {
  const rulesDir = join(dest, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(
    join(rulesDir, "browser-identity-headers.json"),
    `${JSON.stringify(browserIdentityHeaderRules(identity), null, 2)}\n`,
  );
}

function browserIdentityHeaderRules(identity) {
  if (!identity?.userAgent) return [];
  const uaData = identity.uaData || {};
  const headers = [
    { header: "User-Agent", operation: "set", value: identity.userAgent },
  ];
  const brands = formatHeaderBrands(uaData.brands);
  const fullVersionList = formatHeaderBrands(uaData.fullVersionList);
  if (brands) headers.push({ header: "Sec-CH-UA", operation: "set", value: brands });
  headers.push({ header: "Sec-CH-UA-Mobile", operation: "set", value: uaData.mobile ? "?1" : "?0" });
  if (uaData.platform) headers.push({ header: "Sec-CH-UA-Platform", operation: "set", value: quoteHeader(uaData.platform) });
  if (fullVersionList) headers.push({ header: "Sec-CH-UA-Full-Version-List", operation: "set", value: fullVersionList });
  if (uaData.uaFullVersion) headers.push({ header: "Sec-CH-UA-Full-Version", operation: "set", value: quoteHeader(uaData.uaFullVersion) });
  if (uaData.platformVersion) headers.push({ header: "Sec-CH-UA-Platform-Version", operation: "set", value: quoteHeader(uaData.platformVersion) });
  if (uaData.architecture) headers.push({ header: "Sec-CH-UA-Arch", operation: "set", value: quoteHeader(uaData.architecture) });
  if (uaData.bitness) headers.push({ header: "Sec-CH-UA-Bitness", operation: "set", value: quoteHeader(uaData.bitness) });
  if (typeof uaData.model === "string") headers.push({ header: "Sec-CH-UA-Model", operation: "set", value: quoteHeader(uaData.model) });
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
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function formatHeaderBrands(brands) {
  if (!Array.isArray(brands)) return "";
  return brands
    .filter((item) => item && typeof item.brand === "string" && typeof item.version === "string")
    .map((item) => `${quoteHeader(item.brand)};v=${quoteHeader(item.version)}`)
    .join(", ");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function startLocalAuditServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    });
    if (request.url === "/turnstile") {
      response.end(`<!doctype html>
<meta charset="utf-8">
<title>Cloudflare Turnstile compatibility audit</title>
<script>
window.__turnstileAudit = { status: "loading", token: "", error: null };
function onTurnstileSuccess(token) {
  window.__turnstileAudit = { status: "passed", token: token, error: null };
}
function onTurnstileError(code) {
  window.__turnstileAudit = { status: "error", token: "", error: String(code) };
  return true;
}
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<main>
  <h1>Turnstile compatibility audit</h1>
  <div class="cf-turnstile"
       data-sitekey="${TURNSTILE_TEST_SITE_KEY}"
       data-action="notrace_audit"
       data-callback="onTurnstileSuccess"
       data-error-callback="onTurnstileError"></div>
</main>`);
      return;
    }
    response.end("<!doctype html><meta charset=utf-8><title>Version consistency audit</title><p>version consistency audit</p>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const listenerInfo = server.address();
  if (!listenerInfo || typeof listenerInfo === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("local audit server did not expose a port");
  }
  return {
    versionUrl: `http://127.0.0.1:${listenerInfo.port}/version`,
    turnstileUrl: `http://127.0.0.1:${listenerInfo.port}/turnstile`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function validateTurnstileTestResponse(widgetResponse) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["secret", TURNSTILE_TEST_VALIDATION_KEY],
        ["response", widgetResponse],
      ]),
      signal: controller.signal,
    });
    const result = await response.json();
    return {
      success: response.ok && result?.success === true,
      httpStatus: response.status,
      hostname: result?.hostname || null,
      errorCodes: Array.isArray(result?.["error-codes"]) ? result["error-codes"] : [],
    };
  } catch (error) {
    return {
      success: false,
      error: String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP websocket open timeout")), 10000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (error) => {
      clearTimeout(timer);
      reject(error);
    };
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  const failAll = (error) => {
    for (const [current, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(current);
      entry.reject(error);
    }
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      } else {
        resolve(message);
      }
      return;
    }
    if (message.method && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) {
        try {
          listener(message);
        } catch {
          // A diagnostic listener must never break the CDP transport.
        }
      }
    }
  };
  ws.onerror = () => failAll(new Error("CDP websocket error"));
  ws.onclose = () => failAll(new Error("CDP websocket closed"));
  const send = (method, params = {}, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => {
      pending.delete(current);
      reject(new Error(`${method} timeout`));
    }, timeoutMs);
    pending.set(current, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: current, method, params }));
  });
  const on = (method, listener) => {
    const methodListeners = listeners.get(method) || new Set();
    methodListeners.add(listener);
    listeners.set(method, methodListeners);
    return () => {
      methodListeners.delete(listener);
      if (methodListeners.size === 0) listeners.delete(method);
    };
  };
  const close = () => new Promise((resolve) => {
    try {
      listeners.clear();
      ws.onmessage = null;
      ws.onerror = null;
      failAll(new Error("CDP websocket closing"));
      ws.onclose = resolve;
      ws.close();
      setTimeout(resolve, 500);
    } catch {
      resolve();
    }
  });
  return { send, on, close };
}

async function evaluate(client, expression, timeoutMs) {
  const request = client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs + 1000);
  const response = await Promise.race([
    request,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Runtime.evaluate timeout")), timeoutMs)),
  ]);
  if (response.result?.exceptionDetails) {
    throw new Error(`evaluate threw: ${JSON.stringify(response.result.exceptionDetails)}`);
  }
  return response.result?.result?.value;
}

async function evaluateJson(client, expression, timeoutMs) {
  const raw = await evaluate(client, `(async () => JSON.stringify(await (${expression})))()`, timeoutMs);
  if (typeof raw !== "string") return null;
  return JSON.parse(raw);
}

function siteEvaluateExpression(site, plan) {
  const evaluation = site.evaluate.replaceAll("__EXPECTED_IP__", JSON.stringify(plan.geo?.exit_ip || ""));
  // Keep challenge detection orthogonal to each site's bespoke fingerprint
  // score. A page may load successfully while Cloudflare/Turnstile has put the
  // request into a challenge state; report that explicitly so a release gate
  // cannot mistake a challenge page for a clean pass.
  return `(async () => {
    const base = await (${evaluation});
    const body = document.body?.innerText || "";
    const title = document.title || "";
    const frameSources = Array.from(document.querySelectorAll("iframe[src]"))
      .map((frame) => frame.getAttribute("src") || "");
    const haystack = [body, title, ...frameSources].join("\\n");
    const interstitialMarkers = [
      /cf-chl-/i,
      /challenge-platform/i,
      /verify you are human/i,
      /just a moment/i,
      /checking your browser/i,
      /attention required/i,
    ].filter((pattern) => pattern.test(haystack)).map((pattern) => pattern.source);
    const widgetMarkers = [
      /challenges\\.cloudflare\\.com/i,
      /turnstile/i,
    ].filter((pattern) => pattern.test(haystack)).map((pattern) => pattern.source);
    const markers = [...interstitialMarkers, ...widgetMarkers];
    const blocked = interstitialMarkers.length > 0;
    const challenge = {
      detected: markers.length > 0,
      blocked,
      kind: blocked ? "interstitial" : (widgetMarkers.length > 0 ? "turnstile-widget" : null),
      provider: markers.some((marker) => /turnstile|cloudflare|cf-chl|challenge-platform/i.test(marker))
        ? "cloudflare"
        : null,
      markers,
      url: location.href,
      title,
    };
    const output = base && typeof base === "object" ? base : { value: base };
    return { ...output, challenge, challenge_blocked: challenge.blocked };
  })()`;
}

async function waitForDevTools(profilePath, timeoutMs) {
  const portFile = join(profilePath, "DevToolsActivePort");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
      const list = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then((response) => response.json())
        .catch(() => []);
      const target = list.find((item) => item.type === "page");
      if (target?.webSocketDebuggerUrl) {
        return { port, wsUrl: target.webSocketDebuggerUrl };
      }
    }
    await sleep(100);
  }
  throw new Error("page DevTools target never appeared");
}

async function navigate(client, url, waitMs, timeoutMs) {
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Page.navigate", { url });
  await sleep(Math.min(waitMs, timeoutMs));
}

async function collectChallengeResponses(client) {
  const signals = [];
  const off = client.on("Network.responseReceived", (message) => {
    const signal = cloudflareMitigationSignal(message);
    if (signal) signals.push(signal);
  });
  await client.send("Network.enable");
  return { signals, off };
}

async function captureScreenshot(client, path) {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  }, 20000);
  if (result.result?.data) {
    writeFileSync(path, Buffer.from(result.result.data, "base64"));
  }
}

function launchArgsFromPlan(plan, opts) {
  const args = plan.argv.filter((arg) => arg !== "--new-window" && !/^https:\/\/chatgpt\.com\/?$/i.test(arg));
  args.push("--remote-debugging-port=0", "--remote-allow-origins=*");
  if (process.env.CLOAK_AUDIT_EXTRA_ARGS) {
    const extraArgs = JSON.parse(process.env.CLOAK_AUDIT_EXTRA_ARGS);
    if (!Array.isArray(extraArgs) || extraArgs.some((arg) => typeof arg !== "string")) {
      throw new Error("CLOAK_AUDIT_EXTRA_ARGS must be a JSON string array");
    }
    args.push(...extraArgs);
  }
  if (opts.headless) {
    args.push("--headless=new", "--window-size=1440,900", "--force-device-scale-factor=2");
  }
  args.push("about:blank");
  return args;
}

async function run() {
  const opts = parseArgs(process.argv);
  const browser = verifyBrowserHash();
  ensureCli();

  const tempRoot = mkdtempSync(join(tmpdir(), "cloak-live-audit-"));
  const resultDir = opts.resultDir || join(ROOT, "selftest", "live-results", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(resultDir, { recursive: true });

  const env = {
    ...process.env,
    CLOAK_ACCOUNT_BASE: join(tempRoot, "accounts"),
    CLOAK_EXTRA_EXTENSIONS: process.env.CLOAK_EXTRA_EXTENSIONS || "0",
    LOCALE: process.env.LOCALE || "1",
  };
  mkdirSync(env.CLOAK_ACCOUNT_BASE, { recursive: true });

  runChecked(CLOAK, ["account", "create", opts.accountName, "--json"], { env, cwd: ROOT });
  const plan = JSON.parse(runChecked(CLOAK, ["launch", opts.accountName, "--dry-run", "--json"], { env, cwd: ROOT }));
  const browserIdentityOverride = applyBrowserIdentityOverride(plan);
  if (plan.privacy_failures?.length) {
    throw new Error(`privacy gate inputs failed:\n${plan.privacy_failures.join("\n")}`);
  }
  prepareCompanion(plan);

  const args = launchArgsFromPlan(plan, opts);
  const child = spawn(plan.browser_binary, args, {
    env: { ...env, TZ: plan.geo?.timezone || process.env.TZ || "" },
    stdio: "ignore",
  });

  let client = null;
  let localAuditServer = null;
  const report = {
    ts: new Date().toISOString(),
    mode: opts.headless ? "headless" : "headed",
    browser,
    account: opts.accountName,
    profile_path: plan.profile_path,
    geo: plan.geo,
    locale: plan.locale,
    companion_page_spoof: companionPageSpoofEnabled(),
    extra_extensions: env.CLOAK_EXTRA_EXTENSIONS,
    browser_identity_override: browserIdentityOverride,
    results: [],
  };

  try {
    if (opts.sites.some((site) => ["version-consistency", "cloudflare-turnstile-test"].includes(site))) {
      localAuditServer = await startLocalAuditServer();
    }
    const reconnect = async () => {
      if (client) {
        try { await client.close(); } catch {}
        client = null;
      }
      const devtools = await waitForDevTools(plan.profile_path, opts.timeoutMs);
      client = await cdp(devtools.wsUrl);
    };

    for (const siteName of opts.sites) {
      const site = SITE_DEFS[siteName];
      const siteUrl = siteName === "version-consistency"
        ? localAuditServer.versionUrl
        : siteName === "cloudflare-turnstile-test"
          ? localAuditServer.turnstileUrl
          : site.url;
      const item = { name: siteName, url: siteUrl, passed: false };
      let challengeResponses = null;
      try {
        await reconnect();
        challengeResponses = await collectChallengeResponses(client);
        await navigate(client, siteUrl, site.waitMs, opts.timeoutMs);
        if (site.beforeEvaluate) {
          item.action = await evaluate(client, site.beforeEvaluate, 5000);
          await sleep(site.afterActionWaitMs || 3000);
        }
        item.details = mergeChallengeResponses(
          await evaluateJson(client, siteEvaluateExpression(site, plan), 12000),
          challengeResponses.signals,
        );
        if (siteName === "cloudflare-turnstile-test") {
          const widgetResponse = item.details?._turnstileToken || "";
          if (item.details && typeof item.details === "object") {
            delete item.details._turnstileToken;
            item.details.serverValidation = widgetResponse
              ? await validateTurnstileTestResponse(widgetResponse)
              : { success: false, error: "dummy token missing" };
            item.details.passed = Boolean(item.details.passed)
              && item.details.serverValidation.success === true;
          }
        }
        if (site.expectedChallengeKind && item.details?.challenge?.kind !== site.expectedChallengeKind) {
          item.details.passed = false;
          item.details.expectedChallengeKind = site.expectedChallengeKind;
        }
        item.passed = Boolean(item.details?.passed) && item.details?.challenge_blocked !== true;
        if (opts.screenshots) {
          item.screenshot = join(resultDir, `${siteName}.png`);
          try {
            await captureScreenshot(client, item.screenshot);
          } catch (error) {
            item.screenshot_error = String(error?.message || error);
          }
        }
      } catch (error) {
        item.error = String(error?.message || error);
      } finally {
        challengeResponses?.off();
      }
      report.results.push(item);
      console.log(`${item.passed ? "PASS" : "CHECK"} ${siteName}: ${JSON.stringify(item.details || item.error || {})}`);
    }

    let manualIndex = 0;
    for (const url of opts.manualUrls) {
      manualIndex += 1;
      const name = `manual-${manualIndex}`;
      const item = { name, url, passed: null, manual: true };
      let challengeResponses = null;
      try {
        await reconnect();
        challengeResponses = await collectChallengeResponses(client);
        await navigate(client, url, 12000, opts.timeoutMs);
        item.sample = await evaluate(client, "document.body.innerText.slice(0, 1200)", 10000);
        item.challenge = mergeChallengeResponses({}, challengeResponses.signals).challenge || null;
        if (opts.screenshots) {
          item.screenshot = join(resultDir, `${name}.png`);
          try {
            await captureScreenshot(client, item.screenshot);
          } catch (error) {
            item.screenshot_error = String(error?.message || error);
          }
        }
      } catch (error) {
        item.error = String(error?.message || error);
      } finally {
        challengeResponses?.off();
      }
      report.results.push(item);
      console.log(`MANUAL ${url}: ${item.screenshot || item.error || "loaded"}`);
    }
  } finally {
    if (client) await client.close();
    if (localAuditServer) await localAuditServer.close();
    if (!opts.keep) {
      try { child.kill("SIGKILL"); } catch {}
      rmSync(tempRoot, { recursive: true, force: true });
    } else {
      report.temp_root = tempRoot;
      report.browser_pid = child.pid;
    }
  }

  const reportPath = join(resultDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const hardFailures = report.results.filter((item) => item.manual !== true && item.passed !== true);
  console.log(`report: ${reportPath}`);
  process.exitCode = hardFailures.length === 0 ? 0 : 1;
}

run().catch((error) => {
  console.error(`LIVE AUDIT ERROR: ${error.message}`);
  process.exit(2);
});
