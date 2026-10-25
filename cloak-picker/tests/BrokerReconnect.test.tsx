import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerPanel, type BrokerOverview } from "../src/BrokerPanel";
import type { AuthCall } from "../src/AuthPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const data: BrokerOverview = {
  configured: true, connected: false, endpoint: "http://127.0.0.1:18555", message: null, unmatched: [],
  accounts: [{ name: "demo@example.com", profile_id: "fixture-profile", trashed: false, remote: null,
    local: { account: "demo@example.com", state: "missing", email: null, plan_type: null,
      expires_at: null, last_refresh_at: null, auto_refresh: false, authority: "no_trace", next_retry_at: null, message: null } }],
};

afterEach(() => {
  act(() => root?.unmount()); root = null; container?.remove(); container = null;
  vi.useRealTimers();
});

async function render(call: AuthCall) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(createElement(BrokerPanel, { call, selectedProfileId: "fixture-profile",
    workbenchHeader: action => createElement("div", { id: "fixture-header" }, action) })));
}

describe("续期服务自动重连", () => {
  it("recovers every five seconds and reenables authorization without starting OAuth", async () => {
    vi.useFakeTimers();
    let connected = false;
    const calls: string[] = [];
    const call: AuthCall = async <T,>(command: string): Promise<T> => {
      calls.push(command);
      return (command === "broker_overview" ? { ...data, connected } : null) as T;
    };
    await render(call);
    expect(document.querySelector<HTMLButtonElement>("#fixture-header button")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("正在自动重连");
    connected = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(document.querySelector<HTMLButtonElement>("#fixture-header button")?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain("正在自动重连");
    expect(calls.filter(name => name === "broker_overview")).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls.filter(name => name === "broker_overview")).toHaveLength(2);
    expect(calls).not.toContain("login_account_auth");
    expect(calls).not.toContain("broker_refresh_account");
    expect(calls).not.toContain("broker_set_cpa");
  });

  it("deduplicates slow reads from the timer, network and focus events", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let finish: ((value: BrokerOverview) => void) | undefined;
    const call: AuthCall = <T,>(command: string): Promise<T> => {
      if (command !== "broker_overview") return Promise.resolve(null as T);
      reads++;
      return new Promise<BrokerOverview>(resolve => { finish = resolve; }) as Promise<T>;
    };
    await render(call);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(reads).toBe(1);
    await act(async () => { finish?.(data); });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(reads).toBe(2);
    await act(async () => { finish?.({ ...data, connected: true }); });
    const oldReads = reads;
    act(() => root?.unmount()); root = null;
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(30_000); });
    expect(reads).toBe(oldReads);
  });

  it("clears first-load connection errors immediately when the window regains focus", async () => {
    vi.useFakeTimers();
    let fail = true;
    const call: AuthCall = <T,>(command: string): Promise<T> => {
      if (command !== "broker_overview") return Promise.resolve(null as T);
      if (fail) throw new Error("fixture disconnected");
      return Promise.resolve({ ...data, connected: true } as T);
    };
    await render(call);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("正在重试连接");
    fail = false;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>("#fixture-header button")?.disabled).toBe(false);
  });

  it("detects a later outage, offers retry and automatically resumes after recovery", async () => {
    vi.useFakeTimers();
    let connected = true;
    let reads = 0;
    const call: AuthCall = async <T,>(command: string): Promise<T> => {
      if (command !== "broker_overview") return null as T;
      reads++;
      return { ...data, connected } as T;
    };
    await render(call);
    connected = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(document.body.textContent).toContain("正在自动重连");
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "重新连接");
    expect(retry?.disabled).toBe(false);
    const beforeRetry = reads;
    await act(async () => retry?.click());
    expect(reads).toBe(beforeRetry + 1);
    connected = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(document.body.textContent).not.toContain("正在自动重连");
    expect(document.querySelector<HTMLButtonElement>("#fixture-header button")?.disabled).toBe(false);
  });
});
