import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../src/App";

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
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.placeholder).toBe(
      "搜索账号、分组或标记",
    );

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
});
