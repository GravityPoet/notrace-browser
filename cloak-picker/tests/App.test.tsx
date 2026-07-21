import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App, {
  cancelNextMockChallengeAuditForTest,
  failNextMockCommandForTest,
  mockCommandCountForTest,
  resetMockCommandsForTest,
} from "../src/App";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function installMemoryStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

function buttonWithText(text: string, scope: ParentNode = document): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

async function settle(milliseconds = 120) {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function inputText(element: HTMLInputElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openContextMenu(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
  });
}

async function pressKey(key: string, shiftKey = false) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, shiftKey }));
  });
}

beforeEach(async () => {
  installMemoryStorage();
  window.localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function getClientRects(
    this: HTMLElement,
  ) {
    return (this.isConnected ? [new DOMRect(0, 0, 1, 1)] : []) as unknown as DOMRectList;
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(App));
  });
  await settle(240);
  expect(buttonWithText("代理")).toBeTruthy();
  resetMockCommandsForTest();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("Cloak Picker dialog regressions", () => {
  it("labels the modal, traps focus in both directions, closes on Escape, and restores focus", async () => {
    const trigger = buttonWithText("代理");
    trigger.focus();
    await click(trigger);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const titleId = dialog?.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId ?? "")?.textContent).toContain("代理");

    const closeButton = dialog?.querySelector<HTMLButtonElement>('button[aria-label="关闭"]');
    const submitButton = buttonWithText("保存", dialog ?? document);
    expect(closeButton).not.toBeNull();

    submitButton.focus();
    await pressKey("Tab");
    expect(document.activeElement).toBe(closeButton);

    closeButton?.focus();
    await pressKey("Tab", true);
    expect(document.activeElement).toBe(submitButton);

    await pressKey("Escape");
    await settle(30);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the account row after a context-menu dialog closes", async () => {
    const accountRows = Array.from(document.querySelectorAll<HTMLButtonElement>(".accountRow"));
    const origin = accountRows[1];
    expect(origin).toBeTruthy();
    origin.focus();

    await openContextMenu(origin);
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    await click(buttonWithText("重命名", menu ?? document));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await pressKey("Escape");
    await settle(30);
    expect(document.activeElement).toBe(origin);
  });

  it("keeps legacy archived accounts in the trash workflow", async () => {
    const accountSearch = document.querySelector<HTMLInputElement>('input[type="search"]');
    expect(accountSearch?.placeholder).toBe("搜索所有账号、分组或标记");
    expect(accountSearch?.closest(".topbar")).not.toBeNull();
    expect(document.querySelector('.sidebar input[type="search"]')).toBeNull();

    await click(buttonWithText("回收站"));
    await settle(120);

    const archivedAccount = Array.from(document.querySelectorAll<HTMLButtonElement>(".accountRow")).find(
      (row) => row.textContent?.includes("demo-gamma"),
    );
    expect(archivedAccount).toBeTruthy();
    await click(archivedAccount as HTMLButtonElement);

    expect(document.querySelector(".detail")?.textContent).toContain("已移入回收站");
    expect(buttonWithText("恢复账号")).toBeTruthy();
    expect(buttonWithText("彻底删除")).toBeTruthy();
    expect(Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "启动")).toBe(
      false,
    );
  });

  it("searches every group and the trash without switching scope", async () => {
    const codexGroup = document.querySelector<HTMLButtonElement>('[data-group-label="codex"] .groupFilterSelect');
    expect(codexGroup).not.toBeNull();
    await click(codexGroup as HTMLButtonElement);

    const accountSearch = document.querySelector<HTMLInputElement>('input[type="search"]');
    expect(accountSearch).not.toBeNull();
    await inputText(accountSearch as HTMLInputElement, "old-lab");
    await settle(30);

    expect(document.querySelector(".viewSwitch")).toBeNull();
    expect(document.querySelector(".groupFilter")).toBeNull();
    expect(document.querySelector(".accountGroupHeader")).toBeNull();
    expect(document.querySelector(".searchScopeSummary")?.textContent).toContain("全部位置");
    expect(document.querySelector(".searchScopeSummary")?.textContent).toContain("1 个匹配");
    expect(document.querySelector(".searchScopeSummary")?.textContent).toContain("0 活跃 · 1 回收站");

    const resultRows = Array.from(document.querySelectorAll<HTMLButtonElement>(".accountRow"));
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0].textContent).toContain("old-lab");
    expect(resultRows[0].querySelector(".accountLocationTag")?.textContent).toContain("回收站");
    await click(resultRows[0]);

    expect(document.querySelector(".detail")?.textContent).toContain("已移入回收站");
    expect(buttonWithText("恢复账号")).toBeTruthy();
  });

  it("ranks an exact account name before broader matches across locations", async () => {
    const claudeGroup = document.querySelector<HTMLButtonElement>('[data-group-label="claude"] .groupFilterSelect');
    expect(claudeGroup).not.toBeNull();
    await click(claudeGroup as HTMLButtonElement);

    const accountSearch = document.querySelector<HTMLInputElement>('input[type="search"]');
    await inputText(accountSearch as HTMLInputElement, "demo-gamma");
    await settle(30);

    const resultRows = Array.from(document.querySelectorAll<HTMLButtonElement>(".accountRow"));
    expect(resultRows).toHaveLength(2);
    expect(resultRows[0].querySelector(".accountTitle strong")?.textContent).toBe("demo-gamma");
    expect(resultRows[0].querySelector(".accountLocationTag")?.textContent).toContain("回收站");
    expect(resultRows[1].querySelector(".accountTitle strong")?.textContent).toBe("demo-gamma-copy");
    expect(resultRows[1].querySelector(".accountLocationTag")?.textContent).toContain("活跃");
  });

  it("shows actual launch diagnostics after the single launch request completes", async () => {
    await settle(180);
    const launchButton = buttonWithText("启动");
    expect(launchButton.disabled).toBe(false);
    await click(launchButton);
    expect(buttonWithText("取消")).toBeTruthy();
    expect(document.querySelector(".launchStatus")?.textContent).toContain("正在启动");
    await settle(260);

    const diagnostics = document.querySelector<HTMLElement>(".diagnosticBox");
    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.textContent ?? "").toContain("启动诊断");
    expect(diagnostics?.textContent ?? "").toContain("420 ms");
    expect(diagnostics?.textContent ?? "").toContain("180 ms");
    expect(diagnostics?.textContent ?? "").toContain("isolated-profile-storage");
    expect(document.querySelector(".detail")?.textContent).toContain("Chromium 145.0.7632.109");
    expect(document.querySelector(".launchStatus")?.textContent).toContain("已启动");
    expect(mockCommandCountForTest("launch_account")).toBe(1);
    expect(mockCommandCountForTest("launch_preflight")).toBe(0);
  });

  it("cancels an in-flight preflight without opening the browser", async () => {
    await settle(180);
    await click(buttonWithText("启动"));
    await click(buttonWithText("取消"));
    await settle(140);

    expect(document.querySelector(".launchStatus")?.textContent).toContain("已取消");
    expect(document.querySelector(".diagnosticBox")).toBeNull();
    expect(mockCommandCountForTest("launch_account")).toBe(1);
    expect(mockCommandCountForTest("cancel_launch")).toBe(1);
  });

  it("keeps a failed launch recoverable and retries with one request", async () => {
    await settle(180);
    failNextMockCommandForTest("launch_account");
    await click(buttonWithText("启动"));
    await settle(140);

    expect(document.querySelector(".launchStatus")?.textContent).toContain("启动失败，可重试");
    expect(buttonWithText("启动")).toBeTruthy();

    await click(buttonWithText("启动"));
    await settle(180);
    expect(document.querySelector(".launchStatus")?.textContent).toContain("已启动");
    expect(mockCommandCountForTest("launch_account")).toBe(2);
    expect(mockCommandCountForTest("launch_preflight")).toBe(0);
  });

  it("surfaces the official Turnstile compatibility result and keeps it retryable", async () => {
    failNextMockCommandForTest("run_challenge_audit");
    await click(buttonWithText("挑战兼容"));
    await settle(140);
    expect(document.querySelector(".challengeAuditBox.failed")?.textContent).toContain("兼容检查失败，可重试");
    expect(buttonWithText("挑战兼容").disabled).toBe(false);

    await click(buttonWithText("挑战兼容"));
    expect(buttonWithText("检查挑战中").disabled).toBe(true);
    await settle(140);

    const audit = document.querySelector<HTMLElement>(".challengeAuditBox");
    expect(audit?.textContent ?? "").toContain("兼容通过");
    expect(audit?.textContent ?? "").toContain("版本一致性：通过");
    expect(audit?.textContent ?? "").toContain("官方 widget：完成");
    expect(audit?.textContent ?? "").toContain("Siteverify：通过");
    expect(audit?.textContent ?? "").toContain("阻断页：未检测到");
    expect(buttonWithText("挑战兼容").disabled).toBe(false);
    expect(mockCommandCountForTest("run_challenge_audit")).toBe(2);
  });

  it("explains when the audit browser is closed and keeps retry available", async () => {
    cancelNextMockChallengeAuditForTest();
    await click(buttonWithText("挑战兼容"));
    await settle(140);

    const audit = document.querySelector<HTMLElement>(".challengeAuditBox.cancelled");
    expect(audit?.textContent ?? "").toContain("浏览器已关闭，检查已结束，可重试");
    expect(audit?.textContent ?? "").toContain("审计浏览器已关闭，检查已结束");
    expect(buttonWithText("挑战兼容").disabled).toBe(false);
  });
});
