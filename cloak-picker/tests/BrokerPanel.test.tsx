import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerPanel, type BrokerOverview } from "../src/BrokerPanel";
import type { AuthCall } from "../src/AuthPanel";

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const local = { account: "demo@example.test", state: "connected", email: "demo@example.test", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, auto_refresh: true, next_retry_at: null, authority: "no_trace", message: null } as const;

function overview(remote: BrokerOverview["accounts"][number]["remote"] = null): BrokerOverview {
  return { configured: true, endpoint: "http://127.0.0.1:18555", connected: true, message: null, unmatched: [], accounts: [{ name: "demo@example.test", profile_id: "profile-1", trashed: false, local, remote }] };
}
async function settle() { await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); }); }
afterEach(() => { act(() => root?.unmount()); root = null; container?.remove(); container = null; });

describe("统一授权续期窗口", () => {
  it("shows an unmanaged account and does not claim it is already synchronized", async () => {
    const calls: string[] = [];
    const call: AuthCall = async function call<T>(command: string): Promise<T> { calls.push(command); return overview() as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(container.textContent).toContain("统一授权续期");
    expect(container.textContent).toContain("本机授权尚未纳管");
    expect(container.textContent).toContain("交给 Broker");
    expect(calls).toContain("broker_overview");
  });

  it("shows recorded renewal counts independently of generation and consumer sync", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 9, refresh_count: 3, automatic_refresh_count: 2, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 9, cpa_sync_error: null, cockpit_synced_generation: null };
    const call: AuthCall = async function call<T>(command: string): Promise<T> { if (command === "broker_overview") return overview(remote) as T; return overview(remote) as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(container.textContent).toContain("已授权 · NoTrace Broker 自动续期");
    expect(container.textContent).toContain("已同步");
    expect(container.textContent).toContain("成功续期3 次");
    expect(container.textContent).toContain("自动 2 次 · 手动 1 次");
    expect(container.textContent).toContain("启用统计后累计");
    expect(container.textContent).not.toContain("9 次");
    expect(container.textContent).toContain("尚未完成适配验收");
    expect(container.textContent).not.toContain("refresh_token");
  });

  it("offers reauthorization when the Broker grant needs a new OAuth chain", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 0, next_refresh_at: 1_899_900_000, next_retry_at: null, error: "reauth_required", cpa_enabled: false, cpa_synced_generation: null, cpa_sync_error: null, cockpit_synced_generation: null };
    const calls: string[] = [];
    const call: AuthCall = async function call<T>(command: string): Promise<T> { calls.push(command); return overview(remote) as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(container.textContent).toContain("重新授权并纳管");
    const button = [...container.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("重新授权并纳管"));
    await act(async () => button?.click());
    await settle();
    expect(calls).toContain("login_account_auth");
    expect(calls).toContain("broker_push_account");
  });

  it("offers access-only JSON export for a Broker-owned grant", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 0, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 3, cpa_sync_error: null, cockpit_synced_generation: null };
    const call: AuthCall = async function call<T>(command: string): Promise<T> { if (command === "broker_overview") return overview(remote) as T; return overview(remote) as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const button = [...container.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导出 JSON"));
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    await settle();
    expect(container.querySelector('[aria-label="导出 JSON"]')?.classList.contains("brokerJsonCard")).toBe(true);
    expect(container.textContent).toContain("清空 refresh_token（推荐）");
    expect(container.querySelector('input[type="checkbox"]')).toHaveProperty("checked", true);
    expect(container.textContent).toContain("Cockpit Tools");
    expect(container.textContent).toContain("Sub2API");
  });

  it("keeps refresh token clearing enabled by default and only preserves it when unchecked", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 0, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 3, cpa_sync_error: null, cockpit_synced_generation: null };
    const calls: Array<{ command: string; args?: unknown }> = [];
    const call: AuthCall = async function call<T>(command: string, args?: unknown): Promise<T> {
      calls.push({ command, args });
      return overview(remote) as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const open = [...container.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导出 JSON"));
    await act(async () => open?.click());
    await settle();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    const save = [...container.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("保存 JSON"));
    await act(async () => save?.click());
    await settle();
    expect(calls.find(item => item.command === "broker_export_json")?.args).toEqual({ profileId: "profile-1", format: "cockpit_tools", includeRefreshToken: false });
    await act(async () => open?.click());
    await settle();
    const secondCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => secondCheckbox.click());
    const secondSave = [...container.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("保存 JSON"));
    await act(async () => secondSave?.click());
    await settle();
    expect(calls.filter(item => item.command === "broker_export_json").at(-1)?.args).toEqual({ profileId: "profile-1", format: "cockpit_tools", includeRefreshToken: true });
  });

  it("filters the account list into all, authorized, and unauthorized views", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 0, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 3, cpa_sync_error: null, cockpit_synced_generation: null };
    const base = overview(remote);
    const unauthorized = { ...base.accounts[0], name: "unmanaged@example.test", profile_id: "profile-2", local: { ...local, account: "unmanaged@example.test", email: "unmanaged@example.test", state: "missing" as const }, remote: null };
    const data = { ...base, accounts: [base.accounts[0], unauthorized] };
    const call: AuthCall = async function call<T>(command: string): Promise<T> { if (command === "broker_overview") return data as T; return data as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(container.textContent).toContain("全部 2");
    expect(container.textContent).toContain("已授权 1");
    expect(container.textContent).toContain("未授权 1");
    const unauthorizedTab = [...container.querySelectorAll('[role="tab"]')].find(candidate => candidate.textContent?.includes("未授权"));
    await act(async () => (unauthorizedTab as HTMLElement | undefined)?.click());
    await settle();
    expect(container.textContent).toContain("显示 1 / 2 个账号");
    expect(container.textContent).toContain("unmanaged@example.test");
    expect(container.textContent).not.toContain("demo@example.test");
  });

  it("preserves an imported refresh token by default and clears it only when selected", async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const preview = { path: "/tmp/input.json", detected_format: "官方 auth.json", account_count: 1, accounts: [{ email: "demo@example.test", account_id: "acct-1", has_access_token: true, has_refresh_token: true }], contains_refresh_token: true, message: "检测到 refresh_token" };
    const call: AuthCall = async function call<T>(command: string, args?: unknown): Promise<T> {
      calls.push({ command, args });
      if (command === "choose_broker_json_import_path") return "/tmp/input.json" as T;
      if (command === "broker_preview_json") return preview as T;
      return overview() as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const importButton = [...container.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导入/转换 JSON"));
    await act(async () => importButton?.click());
    await settle();
    expect(container.textContent).toContain("默认保留输入文件中的真实 refresh_token");
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    const convert = [...container.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("转换并保存"));
    await act(async () => convert?.click());
    await settle();
    expect(calls.find(item => item.command === "broker_convert_json")?.args).toEqual({ path: "/tmp/input.json", format: "cockpit_tools", includeRefreshToken: true });
  });
});
