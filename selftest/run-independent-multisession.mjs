#!/usr/bin/env node
// Use the real Rust launch path first, then its exact argv for native probes.
// Every profile, process and server here is owned by this isolated test.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.argv[2] || join(repo, "target/debug/cloak");
const root = mkdtempSync(join(tmpdir(), "notrace-independent-multi-"));
const env = { ...process.env, CLOAK_ACCOUNT_BASE: join(root, "Accounts"),
  CLOAK_REPO_ROOT: repo, CLOAK_EXTENSION_SOURCE: join(repo, "extension/cloak-companion"),
  CLOAK_SKIP_GEO: "1", CLOAK_EXTRA_EXTENSIONS: "0", CLOAK_COMPANION_PAGE_SPOOF: "0", TZ: "Asia/Tokyo" };
delete env.CLOAKBROWSER_LICENSE_KEY;
delete env.CLOAKBROWSER_LICENSE_STATUS_FILE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runCli = async args => JSON.parse((await promisify(execFile)(cli, args,
  { env, cwd: repo, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const launched = [], probes = [];

async function closeLaunch(item) {
  if (!alive(item.pid)) return;
  const command = execFileSync("/bin/ps", ["-p", String(item.pid), "-o", "command="], { encoding: "utf8" }).trim();
  assert.ok(command.startsWith(item.browser_binary + " ") && command.includes(`--user-data-dir=${item.profile_path}`), "Refusing to close an unrelated process");
  process.kill(item.pid, "SIGTERM");
  for (let i = 0; i < 100 && alive(item.pid); i++) await sleep(100);
  assert.ok(!alive(item.pid), "Owned browser did not close cleanly");
}

const html = `<!doctype html><script>
window.probe=async()=>{
 const hash=b=>{let h=2166136261;for(const v of b)h=Math.imul(h^v,16777619);return(h>>>0).toString(16)};
 const c=document.createElement('canvas');c.width=240;c.height=80;
 const ctx=c.getContext('2d');ctx.fillStyle='#4f8a75';ctx.fillRect(0,0,240,80);ctx.fillStyle='#c96425';ctx.font='18px Arial';ctx.fillText('NoTrace native fingerprint',8,38);
 const gl=document.createElement('canvas').getContext('webgl'),dbg=gl.getExtension('WEBGL_debug_renderer_info');
 const worker=await new Promise(resolve=>{const w=new Worker(URL.createObjectURL(new Blob(['onmessage=()=>postMessage({tz:Intl.DateTimeFormat().resolvedOptions().timeZone,cores:navigator.hardwareConcurrency})'],{type:'text/javascript'})));w.onmessage=e=>{w.terminate();resolve(e.data)};w.postMessage(0)});
 const uaData=await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','platformVersion','fullVersionList']);
 return {ua:navigator.userAgent,uaData,cores:navigator.hardwareConcurrency,memory:navigator.deviceMemory,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,worker,renderer:gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),canvas:hash(new TextEncoder().encode(c.toDataURL())),pixels:hash(ctx.getImageData(0,0,240,80).data),storage:localStorage.getItem('notrace-own-probe')};
};</script>`;
const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(html); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP connection failed")); });
  let id = 0;
  const pending = new Map();
  const close = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("CDP closed")); } pending.clear(); };
  ws.onclose = close;
  ws.onmessage = event => {
    const message = JSON.parse(event.data), p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
  };
  return { send(method, params = {}) { return new Promise((resolve, reject) => {
    const current = ++id, timer = setTimeout(() => { pending.delete(current); reject(new Error(`${method} timed out`)); }, 12000);
    pending.set(current, { resolve, reject, timer }); ws.send(JSON.stringify({ id: current, method, params }));
  }); }, close() { ws.close(); close(); } };
}

async function startProbe(plan) {
  // Only our temporary profile: stale DevToolsActivePort survives clean exits.
  rmSync(join(plan.profile_path, "DevToolsActivePort"), { force: true });
  const args = plan.argv.filter(arg => arg !== "--new-window" && !/^https:\/\/chatgpt\.com\/?$/i.test(arg));
  args.push("--remote-debugging-port=0", "--remote-allow-origins=*", "about:blank");
  assert.ok(!args.includes("--no-sandbox"));
  const child = spawn(plan.browser_binary, args, { env, stdio: "ignore" });
  const item = { child, plan };
  probes.push(item);
  const portFile = join(plan.profile_path, "DevToolsActivePort");
  for (let i = 0; i < 150 && !existsSync(portFile); i++) {
    assert.equal(child.exitCode, null, "Independent browser exited during startup");
    await sleep(100);
  }
  assert.ok(existsSync(portFile), "No CDP port from owned launch");
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  item.browser = await connect(info.webSocketDebuggerUrl);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  item.page = await connect(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await item.page.send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    const value = await item.page.send("Runtime.evaluate", { expression: "typeof window.probe", returnByValue: true });
    if (value.result.value === "function") break;
    await sleep(100);
  }
  item.measure = async () => {
    const result = await item.page.send("Runtime.evaluate", { expression: "window.probe()", awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, "Native probe exception");
    return result.result.value;
  };
  item.result = await item.measure();
  return item;
}

async function closeProbe(item) {
  if (item.browser) { try { await item.browser.send("Browser.close"); } catch {} item.browser.close(); }
  item.page?.close();
  for (let i = 0; i < 50 && item.child.exitCode === null && item.child.signalCode === null; i++) await sleep(100);
  if (item.child.exitCode === null && item.child.signalCode === null) { item.child.kill("SIGTERM"); await sleep(500); }
}

try {
  const names = ["synthetic-multi-a", "synthetic-multi-b", "synthetic-multi-c"];
  for (const name of names) await runCli(["account", "create", name, "--json"]);
  const plans = await Promise.all(names.map(name => runCli(["launch", name, "--dry-run", "--skip-geo", "--json"])));
  for (const plan of plans) {
    assert.ok(plan.argv.includes("--uxr-synthetic-device-tests=true"), "Selected runtime is not independent");
    assert.deepEqual(plan.privacy_failures, []);
    assert.ok(!plan.argv.some(arg => arg.startsWith("--user-agent=")), "Raw UA override clears independent high-entropy hints");
  }
  for (const name of names) {
    const result = await runCli(["launch", name, "--skip-geo", "--json"]);
    launched.push(result);
    assert.ok(!result.diagnostics.capabilities.includes("webrtc-exit-ip-binding"));
  }
  assert.equal(new Set(launched.map(item => item.pid)).size, 3);
  assert.ok(launched.every(item => alive(item.pid)), "Real LaunchServices launches did not coexist");
  console.log("正式 LaunchServices 启动路径：三个独立进程共存");
  for (const item of launched) await closeLaunch(item);
  const browsers = await Promise.all(plans.map(startProbe));
  for (const item of browsers) {
    const result = item.result;
    assert.equal(result.cores, 8); assert.equal(result.memory, 8);
    assert.equal(result.timezone, "Asia/Tokyo"); assert.equal(result.worker.tz, "Asia/Tokyo"); assert.equal(result.worker.cores, 8);
    assert.match(result.ua, /Chrome\/152\./); assert.equal(result.uaData.platformVersion, "15.5.0");
    assert.equal(result.uaData.architecture, "arm"); assert.equal(result.uaData.bitness, "64");
    assert.ok(result.uaData.fullVersionList.some(item => item.brand === "Google Chrome" && item.version === "152.0.7977.82"));
    assert.equal(result.renderer, item.plan.argv.find(arg => arg.startsWith("--fingerprint-gpu-renderer=")).split("=").slice(1).join("="));
    assert.equal((await item.measure()).canvas, result.canvas);
  }
  assert.equal(new Set(browsers.map(item => item.result.canvas)).size, 3, "Canvas fingerprints collide");
  await browsers[0].page.send("Runtime.evaluate", { expression: 'localStorage.setItem("notrace-own-probe","owned-A")' });
  for (const item of browsers.slice(1)) assert.equal((await item.measure()).storage, null);
  const first = browsers[0].result;
  await closeProbe(browsers[0]);
  const restarted = await startProbe(plans[0]);
  assert.equal(restarted.result.canvas, first.canvas); assert.equal(restarted.result.pixels, first.pixels);
  assert.equal(restarted.result.storage, "owned-A");
  console.log(JSON.stringify({ passed: true, realLaunchServicesConcurrent: 3, nativeFingerprintConcurrent: 3,
    storageIsolated: true, restartStable: true, sandboxDisabled: false,
    canvasHashes: browsers.map(item => item.result.canvas) }, null, 2));
} finally {
  for (const item of probes) await closeProbe(item);
  for (const item of launched) await closeLaunch(item);
  server.close();
  rmSync(root, { recursive: true, force: true });
}
