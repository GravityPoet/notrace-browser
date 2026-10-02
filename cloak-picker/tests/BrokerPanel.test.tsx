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

  it("shows generation and consumer sync state for a Broker-owned grant", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 3, cpa_sync_error: null, cockpit_synced_generation: null };
    const call: AuthCall = async function call<T>(command: string): Promise<T> { if (command === "broker_overview") return overview(remote) as T; return overview(remote) as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(container.textContent).toContain("第 3 代");
    expect(container.textContent).toContain("已同步 · 第 3 代");
    expect(container.textContent).toContain("尚未完成适配验收");
    expect(container.textContent).not.toContain("refresh_token");
  });

  it("offers reauthorization when the Broker grant needs a new OAuth chain", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, next_refresh_at: 1_899_900_000, next_retry_at: null, error: "reauth_required", cpa_enabled: false, cpa_synced_generation: null, cpa_sync_error: null, cockpit_synced_generation: null };
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
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 3, cpa_sync_error: null, cockpit_synced_generation: null };
    const call: AuthCall = async function call<T>(command: string): Promise<T> { if (command === "broker_overview") return overview(remote) as T; return overview(remote) as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const button = [...container.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导出 JSON"));
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    await settle();
    expect(container.textContent).toContain("清空 refresh_token（推荐）");
    expect(container.querySelector('input[type="checkbox"]')).toHaveProperty("checked", true);
    expect(container.textContent).toContain("Cockpit Tools");
    expect(container.textContent).toContain("Sub2API");
  });

  it("keeps refresh token clearing enabled by default and only preserves it when unchecked", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 3, cpa_sync_error: null, cockpit_synced_generation: null };
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
});
