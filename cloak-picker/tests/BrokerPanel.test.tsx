import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerPanel, type BrokerMetadata, type BrokerOverview } from "../src/BrokerPanel";
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
    expect(document.body.textContent).toContain("统一授权续期");
    expect(document.body.textContent).toContain("本机授权尚未纳管");
    expect(document.body.textContent).toContain("交给 Broker");
    expect(calls).toContain("broker_overview");
  });

  it("shows recorded renewal counts independently of generation and consumer sync", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 9, refresh_count: 3, automatic_refresh_count: 2, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 9, cpa_sync_error: null, cockpit_synced_generation: null };
    const call: AuthCall = async function call<T>(command: string): Promise<T> { if (command === "broker_overview") return overview(remote) as T; return overview(remote) as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(document.body.textContent).toContain("已授权 · NoTrace Broker 自动续期");
    expect(document.body.textContent).toContain("已同步");
    expect(document.body.textContent).toContain("成功续期3 次");
    expect(document.body.textContent).toContain("自动 2 次 · 手动 1 次");
    expect(document.body.textContent).toContain("启用统计后累计");
    expect(document.body.textContent).not.toContain("9 次");
    expect(document.body.textContent).toContain("尚未完成适配验收");
    expect(document.body.textContent).not.toContain("refresh_token");
  });

  it("offers reauthorization when the Broker grant needs a new OAuth chain", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 0, next_refresh_at: 1_899_900_000, next_retry_at: null, error: "reauth_required", cpa_enabled: false, cpa_synced_generation: null, cpa_sync_error: null, cockpit_synced_generation: null };
    const calls: string[] = [];
    const call: AuthCall = async function call<T>(command: string): Promise<T> { calls.push(command); return overview(remote) as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(document.body.textContent).toContain("重新授权");
    const button = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.trim() === "重新授权");
    await act(async () => button?.click());
    await settle();
    expect(calls).toContain("login_account_auth");
    expect(calls).toContain("broker_push_account");
  });

  it("returns a reauthorized account to explicit CPA synchronization", async () => {
    let remote: BrokerMetadata = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 1, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 1, cpa_sync_error: null, cockpit_synced_generation: null };
    const cpaCalls: Array<Record<string, unknown> | undefined> = [];
    const call: AuthCall = async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (command === "broker_push_account") remote = { ...remote, generation: 2, cpa_enabled: false };
      if (command === "broker_set_cpa") {
        cpaCalls.push(args);
        remote = { ...remote, cpa_enabled: true, cpa_synced_generation: remote.generation };
        return remote as T;
      }
      return overview(remote) as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const button = (label: string) => [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.trim() === label);
    expect(button("暂停 CPA 同步")).toBeTruthy();
    await act(async () => button("重新授权")?.click());
    await settle();
    expect(document.body.textContent).toContain("待同步新凭据");
    expect(button("同步到 CPA")).toBeTruthy();
    expect(button("暂停 CPA 同步")).toBeUndefined();
    expect(cpaCalls).toHaveLength(0);
    await act(async () => button("同步到 CPA")?.click());
    await settle();
    expect(cpaCalls).toEqual([{ profileId: "profile-1", enabled: true }]);
    expect(button("暂停 CPA 同步")).toBeTruthy();
    expect(document.body.textContent).toContain("已同步");
  });

  it("retries failed synchronization and only offers pause after success", async () => {
    let remote: BrokerMetadata = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 2, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 1, cpa_sync_error: null, cockpit_synced_generation: null };
    const cpaCalls: Array<Record<string, unknown> | undefined> = [];
    let completeRetry: ((result: BrokerMetadata) => void) | undefined;
    const call: AuthCall = async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (command === "broker_set_cpa") {
        cpaCalls.push(args);
        if (cpaCalls.length === 1) {
          remote = { ...remote, cpa_sync_error: "storage" };
          return remote as T;
        }
        return new Promise<BrokerMetadata>(resolve => { completeRetry = resolve; }) as Promise<T>;
      }
      return overview(remote) as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const button = (label: string) => [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.trim() === label);
    expect(button("同步到 CPA")).toBeTruthy();
    await act(async () => button("同步到 CPA")?.click());
    await settle();
    expect(document.querySelector('.brokerRowFeedback[role="alert"]')?.textContent).toContain("服务器文件读写失败");
    expect(button("重试同步")).toBeTruthy();
    expect(button("暂停 CPA 同步")).toBeUndefined();
    await act(async () => button("重试同步")?.click());
    await settle();
    expect(button("同步中…")).toHaveProperty("disabled", true);
    await act(async () => {
      remote = { ...remote, cpa_sync_error: null, cpa_synced_generation: 2 };
      completeRetry?.(remote);
    });
    await settle();
    expect(cpaCalls).toEqual([{ profileId: "profile-1", enabled: true }, { profileId: "profile-1", enabled: true }]);
    expect(button("暂停 CPA 同步")).toBeTruthy();
    expect(document.querySelector('.brokerRowFeedback[role="alert"]')).toBeNull();
  });

  it("reports a CPA storage error separately from the reauthorization action", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 0, automatic_refresh_count: 0, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: null, cpa_sync_error: "storage", cockpit_synced_generation: null };
    const calls: string[] = [];
    const call: AuthCall = async function call<T>(command: string): Promise<T> { calls.push(command); return overview(remote) as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(document.body.textContent).toContain("服务器文件读写失败，请检查同步服务");
    const reauthorize = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.trim() === "重新授权");
    expect(reauthorize).toBeTruthy();
    expect(document.body.textContent).not.toContain("覆盖 CPA");
    await act(async () => reauthorize?.click());
    await settle();
    expect(calls).toContain("login_account_auth");
    expect(calls).toContain("broker_push_account");
    expect(calls).not.toContain("broker_set_cpa");
  });

  it("offers access-only JSON export for a Broker-owned grant", async () => {
    const remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 0, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: true, cpa_synced_generation: 3, cpa_sync_error: null, cockpit_synced_generation: null };
    const call: AuthCall = async function call<T>(command: string): Promise<T> { if (command === "broker_overview") return overview(remote) as T; return overview(remote) as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const button = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导出 JSON"));
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    await settle();
    expect(document.querySelector('[aria-label="导出 JSON"]')?.classList.contains("brokerJsonCard")).toBe(true);
    expect(document.body.textContent).toContain("清空 refresh_token（推荐）");
    expect(document.querySelector('input[type="checkbox"]')).toHaveProperty("checked", true);
    expect(document.body.textContent).toContain("Cockpit Tools");
    expect(document.body.textContent).toContain("Sub2API");
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
    const open = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导出 JSON"));
    await act(async () => open?.click());
    await settle();
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    const save = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("保存 JSON"));
    await act(async () => save?.click());
    await settle();
    expect(calls.find(item => item.command === "broker_export_json")?.args).toEqual({ profileId: "profile-1", accountName: "demo@example.test", format: "auth_json", includeRefreshToken: false });
    await act(async () => open?.click());
    await settle();
    const secondCheckbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => secondCheckbox.click());
    const secondSave = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("保存 JSON"));
    await act(async () => secondSave?.click());
    await settle();
    expect(calls.filter(item => item.command === "broker_export_json").at(-1)?.args).toEqual({ profileId: "profile-1", accountName: "demo@example.test", format: "auth_json", includeRefreshToken: true });
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
    expect(document.body.textContent).toContain("全部 2");
    expect(document.body.textContent).toContain("已授权 1");
    expect(document.body.textContent).toContain("未授权 1");
    const unauthorizedTab = [...document.querySelectorAll('[role="tab"]')].find(candidate => candidate.textContent?.includes("未授权"));
    await act(async () => (unauthorizedTab as HTMLElement | undefined)?.click());
    await settle();
    expect(document.body.textContent).toContain("显示 1 / 2 个账号");
    expect(document.body.textContent).toContain("unmanaged@example.test");
    expect(document.body.textContent).not.toContain("demo@example.test");
  });

  it("moves an invalidated Broker grant to unauthorized with a historical red state", async () => {
    const valid = { key: "profile-1", email: "valid@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 1, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: false, cpa_synced_generation: null, cpa_sync_error: null, cockpit_synced_generation: null };
    const invalid = { ...valid, key: "profile-2", email: "invalid@example.test", account_id: "acct-2", error: "reauth_required" as const };
    const base = overview(valid);
    const data = { ...base, accounts: [{ ...base.accounts[0], name: valid.email, profile_id: valid.key, local: { ...local, account: valid.email, email: valid.email }, remote: valid }, { ...base.accounts[0], name: invalid.email, profile_id: invalid.key, local: { ...local, account: invalid.email, email: invalid.email }, remote: invalid }] };
    const call: AuthCall = async function call<T>(command: string): Promise<T> { return command === "broker_overview" ? data as T : data as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(document.body.textContent).toContain("全部 2");
    expect(document.body.textContent).toContain("已授权 1");
    expect(document.body.textContent).toContain("未授权 1");
    expect(document.body.textContent).toContain("曾授权失效 1");
    const invalidRow = [...document.querySelectorAll<HTMLElement>(".brokerRow")].find(row => row.textContent?.includes("invalid@example.test"));
    expect(invalidRow?.textContent).toContain("未授权 · 曾授权 · 授权已失效");
    expect(invalidRow?.querySelector(".brokerAuthStatus-reauth_required")).toBeTruthy();
    expect(invalidRow?.textContent).toContain("点击“重新授权”获取新的授权链");
    expect(invalidRow?.querySelector('button:disabled')?.textContent).toContain("需重新授权");
    const authorizedTab = [...document.querySelectorAll('[role="tab"]')].find(candidate => candidate.textContent?.includes("已授权"));
    await act(async () => (authorizedTab as HTMLButtonElement | undefined)?.click());
    await settle();
    expect(document.body.textContent).not.toContain("invalid@example.test");
    expect(document.body.textContent).toContain("valid@example.test");
  });

  it("provides a clickable historical-invalidated shortcut with the exact accounts", async () => {
    const valid = { key: "profile-1", email: "valid@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 1, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: false, cpa_synced_generation: null, cpa_sync_error: null, cockpit_synced_generation: null };
    const invalid = { ...valid, key: "profile-2", email: "invalid@example.test", account_id: "acct-2", error: "reauth_required" as const };
    const otherInvalid = { ...valid, key: "profile-3", email: "other-invalid@example.test", account_id: "acct-3", error: "recovery_required" as const };
    const base = overview(valid);
    const rows = [valid, invalid, otherInvalid].map((remote) => ({ ...base.accounts[0], name: remote.email, profile_id: remote.key, local: { ...local, account: remote.email, email: remote.email }, remote }));
    const call: AuthCall = async function call<T>(): Promise<T> { return { ...base, accounts: rows } as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call, focusedAccount: "valid@example.test" })));
    await settle();
    const shortcut = document.querySelector<HTMLButtonElement>(".brokerIssueFilter");
    expect(shortcut?.textContent).toContain("曾授权失效 2");
    await act(async () => shortcut?.click());
    await settle();
    expect(document.body.textContent).toContain("显示 2 / 3 个账号 · 仅显示曾授权失效账号");
    expect(Array.from(document.querySelectorAll(".brokerRowMain strong"), (element) => element.textContent)).toEqual(["invalid@example.test", "other-invalid@example.test"]);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="搜索授权账号"]')?.value).toBe("");
    expect(shortcut?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => shortcut?.click());
    await settle();
    expect(document.body.textContent).toContain("显示 3 / 3 个账号");
  });

  it("keeps temporary Broker failures authorized and explains the warning", async () => {
    const remote = { key: "profile-1", email: "temporary@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 3, refresh_count: 0, next_refresh_at: 1_899_900_000, next_retry_at: 1_899_900_000, error: "service_unavailable" as const, cpa_enabled: false, cpa_synced_generation: null, cpa_sync_error: null, cockpit_synced_generation: null };
    const data = { ...overview(remote), accounts: [{ ...overview(remote).accounts[0], name: remote.email, profile_id: remote.key, local: { ...local, account: remote.email, email: remote.email }, remote }] };
    const call: AuthCall = async function call<T>(): Promise<T> { return data as T; };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(document.body.textContent).toContain("已授权 1");
    expect(document.body.textContent).toContain("授权服务暂不可用，按计划重试");
    expect(document.querySelector(".brokerAuthStatus-authorized")).toBeTruthy();
    expect(document.querySelector(".brokerAuthStatus-reauth_required")).toBeNull();
  });

  it("searches an account in the renewal pane and exposes direct authorization", async () => {
    const base = overview();
    const unauthorized = {
      ...base.accounts[0],
      name: "target@example.test",
      profile_id: "profile-target",
      local: { ...local, account: "target@example.test", state: "missing" as const },
      remote: null,
    };
    const data = { ...base, accounts: [base.accounts[0], unauthorized] };
    const calls: string[] = [];
    const call: AuthCall = async function call<T>(command: string): Promise<T> {
      calls.push(command);
      return data as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call, embedded: true })));
    await settle();
    const search = document.querySelector('input[aria-label="搜索授权账号"]') as HTMLInputElement;
    expect(search).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(search, "target@example.test");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(document.body.textContent).toContain("target@example.test");
    expect(document.body.textContent).not.toContain("demo@example.test");
    const authorize = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("授权并纳管"));
    expect(authorize).toBeTruthy();
    expect((authorize as HTMLButtonElement).disabled).toBe(false);
    await act(async () => authorize?.click());
    await settle();
    expect(calls).toContain("login_account_auth");
    expect(calls).toContain("broker_push_account");
  });

  it("allows a missing grant to start browser authorization after an old external authority record", async () => {
    const data = {
      ...overview(),
      accounts: [{
        ...overview().accounts[0],
        local: { ...local, state: "missing" as const, authority: "cpa" as const },
      }],
    };
    const calls: string[] = [];
    const call: AuthCall = async function call<T>(command: string): Promise<T> {
      calls.push(command);
      return data as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const button = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("授权并纳管"));
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await act(async () => button?.click());
    await settle();
    expect(calls).toContain("login_account_auth");
    expect(calls).toContain("broker_push_account");
  });

  it("preserves an imported refresh token by default and clears it only when selected", async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const preview = { path: "/tmp/input.json", detected_format: "官方 auth.json", account_count: 1, accounts: [{ email: "demo@example.test", account_id: "acct-1", has_access_token: true, has_id_token: true, has_refresh_token: true }], contains_refresh_token: true, message: "检测到 refresh_token" };
    const call: AuthCall = async function call<T>(command: string, args?: unknown): Promise<T> {
      calls.push({ command, args });
      if (command === "choose_broker_json_import_path") return "/tmp/input.json" as T;
      if (command === "broker_preview_json") return preview as T;
      return overview() as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const importButton = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导入/转换 JSON"));
    await act(async () => importButton?.click());
    await settle();
    await act(async () => [...document.querySelectorAll("button")].find(candidate => candidate.textContent === "仅转换文件")?.click());
    await settle();
    expect(document.body.textContent).toContain("默认保留输入文件中的真实 refresh_token");
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    const convert = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("转换并保存"));
    await act(async () => convert?.click());
    await settle();
    expect(calls.find(item => item.command === "broker_convert_json")?.args).toEqual({ path: "/tmp/input.json", format: "auth_json", includeRefreshToken: true });
    await act(async () => importButton?.click());
    await settle();
    await act(async () => [...document.querySelectorAll("button")].find(candidate => candidate.textContent === "仅转换文件")?.click());
    await settle();
    await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("转换并保存"))?.click());
    await settle();
    expect(calls.filter(item => item.command === "broker_convert_json").at(-1)?.args).toEqual({ path: "/tmp/input.json", format: "auth_json", includeRefreshToken: false });
    expect(calls.some(item => item.command === "broker_import_json")).toBe(false);
  });

  it("imports a complete file into Broker and immediately reveals the managed account without a browser login or CPA sync", async () => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const preview = { path: "/tmp/input.json", detected_format: "官方 auth.json", account_count: 1, accounts: [{ email: "demo@example.test", account_id: "acct-1", has_access_token: true, has_id_token: true, has_refresh_token: true }], contains_refresh_token: true, message: "检测到 refresh_token" };
    let remote: BrokerMetadata | null = null;
    const call: AuthCall = async function call<T>(command: string, args?: unknown): Promise<T> {
      calls.push({ command, args });
      if (command === "active_account_auth") return null as T;
      if (command === "choose_broker_json_import_path") return preview.path as T;
      if (command === "broker_preview_json") return preview as T;
      if (command === "broker_import_json") {
        remote = { key: "profile-1", email: "demo@example.test", account_id: "acct-1", plan_type: "plus", expires_at: 1_900_000_000, last_refresh_at: 1_899_000_000, generation: 1, next_refresh_at: 1_899_900_000, next_retry_at: null, error: null, cpa_enabled: false, cpa_synced_generation: null, cpa_sync_error: null, cockpit_synced_generation: null };
        return { email: remote.email, account_id: remote.account_id, profile_id: remote.key, generation: remote.generation } as T;
      }
      return { ...overview(remote), accounts: [{ ...overview(remote).accounts[0], local: { ...local, state: "missing" } }] } as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call, focusedAccount: "other@example.test" })));
    await settle();
    await act(async () => [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导入/转换 JSON"))?.click());
    await settle();
    expect(document.querySelector('[aria-label="JSON 处理方式"] [aria-pressed="true"]')?.textContent).toBe("导入并纳管");
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    const importButton = [...document.querySelectorAll("button")].find(candidate => candidate.textContent === "确认导入并纳管")!;
    expect(importButton.disabled).toBe(false);
    await act(async () => importButton.click());
    await settle();
    expect(calls.find(item => item.command === "broker_import_json")?.args).toEqual({ path: preview.path, email: "demo@example.test", accountId: "acct-1" });
    expect(calls.some(item => ["broker_convert_json", "login_account_auth", "broker_set_cpa"].includes(item.command))).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('[aria-label="搜索授权账号"]')?.value).toBe("demo@example.test");
    expect(document.body.textContent).toContain("已导入并纳管");
    expect(document.body.textContent).toContain("已授权 · NoTrace Broker 自动续期");
    expect(document.body.textContent).toContain("同步到 CPA");
  });

  it("keeps import errors visible inside the dialog and allows retrying the same file", async () => {
    const preview = { path: "/tmp/input.json", detected_format: "官方 auth.json", account_count: 1, accounts: [{ email: "demo@example.test", account_id: "acct-1", has_access_token: true, has_id_token: true, has_refresh_token: true }], contains_refresh_token: true, message: "检测到 refresh_token" };
    let attempts = 0;
    const call: AuthCall = async function call<T>(command: string): Promise<T> {
      if (command === "choose_broker_json_import_path") return preview.path as T;
      if (command === "broker_preview_json") return preview as T;
      if (command === "broker_import_json") { attempts++; throw new Error("无法连接 Broker，请稍后重试"); }
      return overview() as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    await act(async () => [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导入/转换 JSON"))?.click());
    await settle();
    const confirm = () => [...document.querySelectorAll("button")].find(candidate => candidate.textContent === "确认导入并纳管")!;
    await act(async () => confirm().click());
    await settle();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("无法连接 Broker");
    expect(confirm().disabled).toBe(false);
    await act(async () => confirm().click());
    await settle();
    expect(attempts).toBe(2);
    expect(document.body.textContent).not.toContain("已导入并纳管");
  });

  it("explains why an access-only file cannot be managed and still offers file conversion", async () => {
    const preview = { path: "/tmp/input.json", detected_format: "官方 auth.json", account_count: 1, accounts: [{ email: "demo@example.test", account_id: "acct-1", has_access_token: true, has_id_token: true, has_refresh_token: false }], contains_refresh_token: false, message: "access-only" };
    const call: AuthCall = async function call<T>(command: string): Promise<T> {
      if (command === "choose_broker_json_import_path") return preview.path as T;
      if (command === "broker_preview_json") return preview as T;
      return overview() as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    await act(async () => [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("导入/转换 JSON"))?.click());
    await settle();
    expect([...document.querySelectorAll("button")].find(candidate => candidate.textContent === "确认导入并纳管")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("此账号缺少 refresh_token，不能纳管");
    await act(async () => [...document.querySelectorAll("button")].find(candidate => candidate.textContent === "仅转换文件")?.click());
    await settle();
    expect([...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes("转换并保存"))?.disabled).toBe(false);
  });
  it("shows progress and cancellation while login is pending and does not hand off after cancellation", async () => {
    const data = overview();
    data.accounts[0].local = { ...local, state: "missing" };
    const commands: string[] = [];
    let rejectLogin: (error: Error) => void = () => {};
    const call: AuthCall = async function<T>(command: string): Promise<T> {
      commands.push(command);
      if (command === "broker_overview") return data as T;
      if (command === "active_account_auth") return null as T;
      if (command === "login_account_auth") return new Promise<T>((_resolve, reject) => { rejectLogin = reject; });
      if (command === "cancel_account_auth") { rejectLogin(new Error("授权已取消")); return true as T; }
      return undefined as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    const authorize = [...document.querySelectorAll("button")].find(button => button.textContent === "授权并纳管")!;
    await act(async () => authorize.click());
    expect(authorize.disabled).toBe(true);
    expect(document.body.textContent).toContain("正在准备官方授权");
    const cancel = [...document.querySelectorAll("button")].find(button => button.textContent === "取消授权")!;
    await act(async () => cancel.click());
    await settle();
    expect(document.querySelector('.brokerRow [role="alert"]')?.textContent).toContain("授权已取消");
    expect(authorize.disabled).toBe(false);
    expect(commands.filter(command => command === "login_account_auth")).toHaveLength(1);
    expect(commands).not.toContain("broker_push_account");
  });

  it("shows and cancels an authorization started before this panel was opened", async () => {
    let active: unknown = { account: "previous@example.test", phase: "waiting_browser", started_at: 1, cancelling: false };
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const call: AuthCall = async function<T>(command: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      if (command === "active_account_auth") return active as T;
      if (command === "cancel_account_auth") { active = null; return true as T; }
      return overview() as T;
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(document.body.textContent).toContain("previous@example.test");
    expect(document.body.textContent).toContain("授权页已打开");
    const cancel = [...document.querySelectorAll("button")].find(button => button.textContent === "取消授权")!;
    await act(async () => cancel.click());
    expect(calls.find(call => call.command === "cancel_account_auth")?.args).toEqual({ name: "previous@example.test" });
  });

  it("keeps search available when status cannot be loaded", async () => {
    const call: AuthCall = async function<T>(command: string): Promise<T> {
      if (command === "active_account_auth") return null as T;
      throw new Error("offline");
    };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(createElement(BrokerPanel, { call })));
    await settle();
    expect(document.querySelector('input[aria-label="搜索授权账号"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("无法读取统一授权状态");
  });

});
