import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { AuthPanel, type AuthCall, type AuthStatus } from "../src/AuthPanel";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function status(authority: AuthStatus["authority"]): AuthStatus {
  return {
    account: "demo@example.test",
    state: "connected",
    email: "demo@example.test",
    plan_type: "plus",
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    last_refresh_at: Math.floor(Date.now() / 1000),
    auto_refresh: authority === "no_trace",
    authority,
    next_retry_at: null,
    message: authority === "no_trace" ? null : `${authority} 负责刷新这条授权链；NoTrace 不会自动轮换它`,
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("ChatGPT authorization panel", () => {
  for (const state of ["missing", "expired"] as const) {
    it(`routes a Broker-owned ${state} local cache to unified renewal without offering another login`, async () => {
      const calls: string[] = [];
      let opened = 0;
      const data = { ...status("broker"), state, expires_at: state === "missing" ? null : 1 };
      const call: AuthCall = async function call<T>(command: string): Promise<T> {
        calls.push(command);
        return data as T;
      };
      container = document.createElement("div"); document.body.append(container); root = createRoot(container);
      await act(async () => root?.render(createElement(AuthPanel, { name: data.account, call, onOpenBroker: () => { opened++; } })));
      await settle();
      expect(container.textContent).toContain("统一续期托管");
      expect(container.textContent).not.toContain("未连接");
      expect(container.textContent).not.toContain("已到期");
      expect(container.textContent).not.toContain("凭证到期");
      expect(container.textContent).not.toContain("连接官方账号");
      expect(container.textContent).not.toContain("重新连接");
      const open = container.querySelector<HTMLButtonElement>("button")!;
      expect(open.textContent).toBe("查看统一授权续期");
      await act(async () => open.click());
      expect(opened).toBe(1);
      expect(calls).toEqual(["auth_status"]);
    });
  }

  it("does not offer a second refresh writer for an external authority", async () => {
    const calls: string[] = [];
    const call: AuthCall = async function call<T>(command: string): Promise<T> {
      calls.push(command);
      return status("cockpit") as T;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(AuthPanel, { name: "demo@example.test", call, onOpenBroker: () => {} })));
    await settle();

    expect(container.textContent).toContain("Cockpit");
    expect(container.textContent).toContain("NoTrace 不会并发轮换");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.includes("立即刷新"))).toBe(false);
    expect(calls).toContain("auth_status");
  });

  it("calls the refresh command only for a NoTrace-owned grant", async () => {
    const calls: string[] = [];
    const call: AuthCall = async function call<T>(command: string): Promise<T> {
      calls.push(command);
      return status("no_trace") as T;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(AuthPanel, { name: "demo@example.test", call, onOpenBroker: () => {} })));
    await settle();

    const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("立即刷新"));
    expect(refresh).toBeTruthy();
    await act(async () => refresh?.click());
    await settle();
    expect(calls).toContain("refresh_account_auth");
    expect(container.textContent).toContain("刷新完成，凭证已保存");
  });
});
