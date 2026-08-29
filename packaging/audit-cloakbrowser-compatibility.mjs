#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packagingDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(packagingDir, "..");
const matrixPath = resolve(packagingDir, "cloakbrowser-compatibility.json");
const packagePath = resolve(packagingDir, "cloakbrowser-wrapper/package.json");
const lockPath = resolve(packagingDir, "cloakbrowser-wrapper/package-lock.json");
const updaterPath = resolve(packagingDir, "update-chromium.sh");

function fail(message) {
  process.stderr.write(`兼容审计失败：${message}\n`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`无法读取 ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const args = process.argv.slice(2);
let candidate = "";
let checkUpstream = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--candidate") {
    candidate = args[index + 1] ?? "";
    index += 1;
  } else if (args[index] === "--check-upstream") {
    checkUpstream = true;
  } else {
    fail(`未知参数 ${args[index]}`);
  }
}

const matrix = readJson(matrixPath);
const wrapperPackage = readJson(packagePath);
const lock = readJson(lockPath);
const updater = readFileSync(updaterPath, "utf8");
const requiredGates = [
  "wrapper-integrity",
  "tcc-local-copy",
  "persistent-signature",
  "current-sha256",
  "rollback-retention",
  "local-contract",
  "live-challenge",
  "native-picker-e2e",
];

if (matrix.schema_version !== 1 || matrix.platform !== "macos") {
  fail("矩阵 schema 或平台无效");
}
for (const gate of requiredGates) {
  if (!matrix.required_release_gates?.includes(gate)) fail(`矩阵缺少发布门禁 ${gate}`);
}

const pinned = wrapperPackage.dependencies?.cloakbrowser;
const lockRoot = lock.packages?.[""]?.dependencies?.cloakbrowser;
const lockedPackage = lock.packages?.["node_modules/cloakbrowser"];
const updaterPinned = updater.match(/^WRAPPER_VERSION="([^"]+)"$/m)?.[1];
if (!pinned || pinned !== lockRoot || pinned !== lockedPackage?.version || pinned !== updaterPinned) {
  fail(`wrapper pin 漂移：package=${pinned ?? "missing"} lock=${lockedPackage?.version ?? "missing"} updater=${updaterPinned ?? "missing"}`);
}
if (!matrix.wrapper?.approved_versions?.includes(pinned)) {
  fail(`wrapper ${pinned} 未进入兼容矩阵`);
}
if (lockedPackage?.integrity !== matrix.wrapper.integrity) {
  fail("wrapper 锁文件完整性与兼容矩阵不一致");
}
if (lockedPackage?.license !== matrix.wrapper.license
    || lockedPackage?.engines?.node !== matrix.wrapper.node) {
  fail("wrapper 许可证或 Node 运行要求与兼容矩阵不一致");
}
for (const [dependency, range] of Object.entries(matrix.wrapper.dependencies ?? {})) {
  if (lockedPackage?.dependencies?.[dependency] !== range) {
    fail(`wrapper 依赖 ${dependency} 与兼容矩阵不一致`);
  }
}

if (candidate) {
  const entry = matrix.engines?.find((engine) => engine.version === candidate);
  if (!entry) fail(`引擎 ${candidate} 未进入兼容矩阵，current 保持不变`);
  if (entry.status !== "approved") {
    fail(`引擎 ${candidate} 状态为 ${entry.status}：${entry.notes ?? "需要人工复核"}`);
  }
}

if (checkUpstream) {
  let upstream;
  try {
    upstream = JSON.parse(execFileSync(
      "npm",
      ["view", matrix.wrapper.package, "version", "license", "engines", "dist.integrity", "gitHead", "--json"],
      { cwd: root, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
    ));
  } catch (error) {
    fail(`无法查询 npm 上游版本：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!matrix.wrapper.approved_versions.includes(upstream.version)) {
    fail(`发现未审计 wrapper ${upstream.version ?? "unknown"}，当前仍固定 ${pinned}`);
  }
  if (upstream.license !== matrix.wrapper.license
      || upstream.engines?.node !== matrix.wrapper.node
      || (upstream.dist?.integrity ?? upstream["dist.integrity"]) !== matrix.wrapper.integrity
      || upstream.gitHead !== matrix.wrapper.upstream_git_head) {
    fail("npm 上游 wrapper 的许可证、Node 要求、完整性或源码提交发生漂移");
  }

  // The changelog can lag a binary release (or contain an Unreleased section
  // without a platform line). Prefer the official latest-release API when the
  // matrix provides it, and require evidence that the release actually ships
  // the macOS archive before accepting the pinned macOS version.
  if (matrix.wrapper.upstream_release_api) {
    let release;
    try {
      const response = await fetch(matrix.wrapper.upstream_release_api, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "notrace-compatibility-audit",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      release = await response.json();
    } catch (error) {
      fail(`无法读取上游最新 Release：${error instanceof Error ? error.message : String(error)}`);
    }
    const expected = matrix.wrapper.macos_stable_engine;
    const releaseText = `${release?.name ?? ""}\n${release?.tag_name ?? ""}\n${release?.body ?? ""}`;
    const releaseVersion = release?.tag_name?.match(/[0-9]+(?:\.[0-9]+){3,4}/)?.[0];
    if (release?.draft || release?.prerelease) {
      fail("上游最新 Release 不是正式版本，必须人工复核矩阵");
    }
    if (releaseVersion !== expected
        || !releaseText.includes(expected)
        || !/macOS/i.test(releaseText)
        || !/cloakbrowser-darwin-(?:arm64|x64)\.tar\.gz/i.test(releaseText)) {
      fail(`上游最新 Release 与 macOS Stable 矩阵不一致：release=${releaseVersion ?? "unknown"} matrix=${expected}`);
    }
  } else {
    let changelog;
    try {
      const response = await fetch(matrix.wrapper.upstream_changelog, {
        headers: { "User-Agent": "notrace-compatibility-audit" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      changelog = await response.text();
    } catch (error) {
      fail(`无法读取上游 changelog：${error instanceof Error ? error.message : String(error)}`);
    }
    const sections = changelog.match(/^## \[[^\n]+\][\s\S]*?(?=^---\s*$|^## \[)/gm) ?? [];
    const macStable = sections
      .map((section) => section.match(/macOS[^\n]*?Stable\s+`([0-9]+(?:\.[0-9]+){3,4})`/)?.[1])
      .find(Boolean);
    if (!macStable) {
      fail("无法从上游 changelog 解析 macOS Stable 引擎，必须人工复核矩阵");
    }
    if (macStable !== matrix.wrapper.macos_stable_engine) {
      fail(`macOS Stable 引擎漂移：upstream=${macStable} matrix=${matrix.wrapper.macos_stable_engine}`);
    }
  }
}

process.stdout.write(
  `兼容审计通过：wrapper=${pinned}${candidate ? ` engine=${candidate}` : ""}${checkUpstream ? " upstream=current" : ""}\n`,
);
