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

async function pressKeyOn(element: HTMLElement, key: string, shiftKey = false) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      shiftKey,
    }));
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
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
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
  function accountRow(name: string): HTMLButtonElement {
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>(".accountRow")).find(
      (candidate) => candidate.querySelector(".accountTitle strong")?.textContent === name,
    );
    if (!row) throw new Error(`account row not found: ${name}`);
    return row;
  }

  async function openMarkDialog(name: string) {
    await openContextMenu(accountRow(name));
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    const action = Array.from(menu?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) =>
      ["标记", "编辑标记"].includes(button.textContent?.trim() ?? ""),
    );
    expect(action).toBeTruthy();
    await click(action as HTMLButtonElement);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    return dialog as HTMLElement;
  }

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

  it("applies the built-in Plus mark with one click", async () => {
    const dialog = await openMarkDialog("demo-beta");
    expect(buttonWithText("Plus", dialog)).toBeTruthy();
    expect(buttonWithText("自用", dialog)).toBeTruthy();
    expect(Array.from(dialog.querySelectorAll(".markColorOption")).map((option) => option.textContent?.trim())).toEqual([
      "绿色",
      "蓝色",
      "红色",
    ]);

    await click(buttonWithText("Plus", dialog));
    await settle(180);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mockCommandCountForTest("set_mark")).toBe(1);

    const reopened = await openMarkDialog("demo-beta");
    expect(reopened.querySelector<HTMLInputElement>(".field input")?.value).toBe("Plus");
    expect(reopened.querySelector('button[aria-label="使用快捷标记 Plus，采用当前红色，立即保存"]')).not.toBeNull();
    expect(reopened.querySelector('button[aria-label^="修改 Plus 的颜色"]')).toBeNull();
  });

  it("uses the selected color when applying a permanently blue quick mark", async () => {
    const dialog = await openMarkDialog("demo-beta");
    const quickMark = buttonWithText("Plus", dialog);
    expect(quickMark.querySelector(".markPresetDot")).not.toBeNull();
    expect(quickMark.closest(".markPresetItem")?.hasAttribute("style")).toBe(false);
    const chooseGreen = dialog.querySelector<HTMLButtonElement>('button[aria-label="使用绿色"]');
    expect(chooseGreen).not.toBeNull();
    await click(chooseGreen as HTMLButtonElement);
    expect(dialog.querySelector('button[aria-label="使用快捷标记 Plus，采用当前绿色，立即保存"]')).not.toBeNull();

    await click(buttonWithText("Plus", dialog));
    await settle(180);

    const mark = accountRow("demo-beta").querySelector<HTMLElement>(".accountMark");
    expect(mark?.getAttribute("aria-label")).toBe("标记：Plus，颜色：绿色");
    expect(mark?.style.getPropertyValue("--mark-solid")).toBe("#1a8f4b");

    const reopened = await openMarkDialog("demo-beta");
    expect(reopened.querySelector('button[aria-label="使用快捷标记 Plus，采用当前绿色，立即保存"]')).not.toBeNull();
  });

  it("saves a manually entered mark with the selected color", async () => {
    const dialog = await openMarkDialog("demo-beta");
    const useBlue = dialog.querySelector<HTMLButtonElement>('button[aria-label="使用蓝色"]');
    expect(useBlue).not.toBeNull();
    await click(useBlue as HTMLButtonElement);

    const input = dialog.querySelector<HTMLInputElement>(".field input");
    expect(input).not.toBeNull();
    await inputText(input as HTMLInputElement, "主力");
    await click(buttonWithText("保存标记", dialog));
    await settle(180);

    const mark = accountRow("demo-beta").querySelector<HTMLElement>(".accountMark");
    expect(mark?.getAttribute("aria-label")).toBe("标记：主力，颜色：蓝色");
    expect(mark?.style.getPropertyValue("--mark-solid")).toBe("#0071e3");
  });

  it("persists, applies, and removes a custom quick mark", async () => {
    const dialog = await openMarkDialog("demo-beta");
    const useGreen = dialog.querySelector<HTMLButtonElement>('button[aria-label="使用绿色"]');
    expect(useGreen).not.toBeNull();
    await click(useGreen as HTMLButtonElement);
    await click(buttonWithText("新增快捷项", dialog));
    const presetInput = dialog.querySelector<HTMLInputElement>('input[aria-label="新的快捷标记"]');
    expect(presetInput).not.toBeNull();
    expect(presetInput?.maxLength).toBe(24);
    await inputText(presetInput as HTMLInputElement, "工作");
    await click(buttonWithText("添加", dialog));

    expect(window.localStorage.getItem("cloak-picker.markPresets.v3")).toBe('["工作"]');
    await click(buttonWithText("工作", dialog));
    await settle(180);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mockCommandCountForTest("set_mark")).toBe(1);

    const reopened = await openMarkDialog("demo-beta");
    expect(reopened.querySelector<HTMLInputElement>(".field input")?.value).toBe("工作");
    expect(reopened.querySelector('button[aria-label="使用快捷标记 工作，采用当前绿色，立即保存"]')).not.toBeNull();
    const removeButton = reopened.querySelector<HTMLButtonElement>('button[aria-label="删除快捷标记 工作"]');
    expect(removeButton).not.toBeNull();
    await click(removeButton as HTMLButtonElement);

    expect(window.localStorage.getItem("cloak-picker.markPresets.v3")).toBe("[]");
    expect(Array.from(reopened.querySelectorAll("button")).some((button) => button.textContent?.trim() === "工作")).toBe(
      false,
    );
  });

  it("ignores invalid or duplicate quick marks from local storage", async () => {
    window.localStorage.setItem(
      "cloak-picker.markPresets.v1",
      JSON.stringify(["Plus", "", "1234567890123456789012345", "两行\n标记", "工作", "工作", 42]),
    );

    const dialog = await openMarkDialog("demo-beta");
    expect(Array.from(dialog.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "Plus")).toHaveLength(
      1,
    );
    expect(Array.from(dialog.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "工作")).toHaveLength(
      1,
    );
    expect(dialog.textContent).not.toContain("1234567890123456789012345");
    expect(dialog.textContent).not.toContain("两行");
  });

  it("migrates quick-mark text from the old color-aware format and ignores its colors", async () => {
    window.localStorage.setItem(
      "cloak-picker.markPresets.v2",
      JSON.stringify([
        { label: "Plus", color: "green" },
        { label: "工作", color: "pink" },
        { label: "复查", color: "purple" },
        { label: "复查", color: "blue" },
      ]),
    );

    const dialog = await openMarkDialog("demo-beta");
    expect(buttonWithText("工作", dialog)).toBeTruthy();
    expect(buttonWithText("复查", dialog)).toBeTruthy();
    expect(Array.from(dialog.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "复查")).toHaveLength(
      1,
    );
    expect(dialog.querySelector('button[aria-label^="修改 Plus 的颜色"]')).toBeNull();
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

  it("locates a matching account inside the complete left list", async () => {
    const codexGroup = document.querySelector<HTMLButtonElement>('[data-group-label="codex"] .groupFilterSelect');
    expect(codexGroup).not.toBeNull();
    await click(codexGroup as HTMLButtonElement);
    expect(document.querySelectorAll(".accountRow")).toHaveLength(2);

    const accountSearch = document.querySelector<HTMLInputElement>('input[type="search"]');
    expect(accountSearch).not.toBeNull();
    await inputText(accountSearch as HTMLInputElement, "missing-account");
    await settle(30);

    expect(document.querySelectorAll(".accountRow")).toHaveLength(3);
    expect(document.querySelector(".accountSearchResultStatus")?.textContent).toBe("无匹配");
    expect(document.querySelector(".accountSearchField")?.classList.contains("notFound")).toBe(true);
    expect(document.querySelector(".searchLocateStatus")).toBeNull();
    expect(document.querySelector<HTMLButtonElement>(".groupFilterSelect[aria-pressed=\"true\"]")?.textContent).toContain(
      "全部",
    );

    await inputText(accountSearch as HTMLInputElement, "demo-gamma-copy");
    await settle(30);

    expect(document.querySelector(".viewSwitch")).not.toBeNull();
    expect(document.querySelector(".groupFilter")).not.toBeNull();
    expect(document.querySelector(".accountGroupHeader")).not.toBeNull();
    expect(document.querySelector(".searchScopeSummary")).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('.viewSwitch [role="tab"][aria-selected="true"]')?.textContent).toContain(
      "活跃",
    );
    expect(document.querySelector<HTMLButtonElement>(".groupFilterSelect[aria-pressed=\"true\"]")?.textContent).toContain(
      "全部",
    );

    const accountRows = Array.from(document.querySelectorAll<HTMLButtonElement>(".accountRow"));
    expect(accountRows).toHaveLength(3);
    expect(accountRows.map((row) => row.querySelector(".accountTitle strong")?.textContent)).toEqual([
      "demo-alpha@example.test",
      "demo-beta",
      "demo-gamma-copy",
    ]);
    const selectedRow = accountRows.find((row) => row.classList.contains("selected"));
    expect(selectedRow?.querySelector(".accountTitle strong")?.textContent).toBe("demo-gamma-copy");
    expect(selectedRow?.classList.contains("searchLocated")).toBe(true);
    expect(selectedRow?.querySelector(".searchMatchIcon")).not.toBeNull();
    expect(selectedRow?.querySelector(".accountLocationTag")).toBeNull();
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenLastCalledWith({
      block: "center",
      inline: "nearest",
    });
    expect(document.querySelector(".accountSearchResultStatus")?.textContent).toBe("1/1");

    expect(document.querySelector(".detail h1")?.textContent).toBe("demo-gamma-copy");
  });

  it("ranks an exact account across locations and opens its complete view", async () => {
    const claudeGroup = document.querySelector<HTMLButtonElement>('[data-group-label="claude"] .groupFilterSelect');
    expect(claudeGroup).not.toBeNull();
    await click(claudeGroup as HTMLButtonElement);

    const accountSearch = document.querySelector<HTMLInputElement>('input[type="search"]');
    await inputText(accountSearch as HTMLInputElement, "demo-gamma");
    await settle(30);

    expect(document.querySelector<HTMLButtonElement>('.viewSwitch [role="tab"][aria-selected="true"]')?.textContent).toContain(
      "回收站",
    );
    const accountRows = Array.from(document.querySelectorAll<HTMLButtonElement>(".accountRow"));
    expect(accountRows).toHaveLength(2);
    expect(accountRows.map((row) => row.querySelector(".accountTitle strong")?.textContent)).toEqual([
      "demo-gamma",
      "old-lab",
    ]);
    expect(accountRows[0].classList.contains("selected")).toBe(true);
    expect(document.querySelector(".detail h1")?.textContent).toBe("demo-gamma");
    expect(document.querySelector(".detail")?.textContent).toContain("已移入回收站");
    expect(document.querySelector(".accountSearchResultStatus")?.textContent).toBe("1/2");
  });

  it("moves through ranked matches without replacing the complete account list", async () => {
    const accountSearch = document.querySelector<HTMLInputElement>('input[type="search"]');
    await inputText(accountSearch as HTMLInputElement, "demo");
    await settle(30);

    expect(document.querySelector(".accountSearchResultStatus")?.textContent).toBe("1/4");
    expect(document.querySelector(".detail h1")?.textContent).toBe("demo-gamma-copy");
    expect(document.querySelectorAll(".accountRow")).toHaveLength(3);

    const nextResult = document.querySelector<HTMLButtonElement>('button[aria-label="下一个匹配"]');
    expect(nextResult).not.toBeNull();
    await click(nextResult as HTMLButtonElement);
    expect(document.querySelector(".accountSearchResultStatus")?.textContent).toBe("2/4");
    expect(document.querySelector(".detail h1")?.textContent).toBe("demo-gamma");
    expect(document.querySelectorAll(".accountRow")).toHaveLength(2);
    expect(document.querySelector<HTMLButtonElement>('.viewSwitch [role="tab"][aria-selected="true"]')?.textContent).toContain(
      "回收站",
    );

    await click(nextResult as HTMLButtonElement);
    expect(document.querySelector(".accountSearchResultStatus")?.textContent).toBe("3/4");
    expect(document.querySelector(".detail h1")?.textContent).toBe("demo-beta");
    expect(document.querySelectorAll(".accountRow")).toHaveLength(3);
    expect(document.querySelector<HTMLButtonElement>('.viewSwitch [role="tab"][aria-selected="true"]')?.textContent).toContain(
      "活跃",
    );

    await pressKeyOn(accountSearch as HTMLInputElement, "ArrowUp");
    expect(document.querySelector(".accountSearchResultStatus")?.textContent).toBe("2/4");
    await pressKeyOn(accountSearch as HTMLInputElement, "Enter");
    expect(document.querySelector(".accountSearchResultStatus")?.textContent).toBe("3/4");
    expect(mockCommandCountForTest("launch_account")).toBe(0);
  });

  it("clears a stale locator when the user manually leaves its result", async () => {
    const accountSearch = document.querySelector<HTMLInputElement>('input[type="search"]');
    await inputText(accountSearch as HTMLInputElement, "demo-gamma");
    await settle(30);

    expect(accountSearch?.value).toBe("demo-gamma");
    expect(document.querySelector(".accountSearchResultStatus")?.textContent).toBe("1/2");
    expect(document.querySelector<HTMLButtonElement>('.viewSwitch [role="tab"][aria-selected="true"]')?.textContent).toContain(
      "回收站",
    );

    await click(buttonWithText("活跃"));

    expect(accountSearch?.value).toBe("");
    expect(document.querySelector(".accountSearchResultStatus")).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('.viewSwitch [role="tab"][aria-selected="true"]')?.textContent).toContain(
      "活跃",
    );
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

describe("Cloak Picker cross-account and failure-state regressions", () => {
  function argvPreview(): string {
    return document.querySelector("details.argv code")?.textContent ?? "";
  }

  function accountRow(name: string): HTMLButtonElement {
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>(".accountRow")).find(
      (candidate) => candidate.querySelector(".accountTitle strong")?.textContent === name,
    );
    if (!row) throw new Error(`account row not found: ${name}`);
    return row;
  }

  it("never shows one account's launch plan under another account's name", async () => {
    await click(accountRow("demo-alpha@example.test"));
    await settle(200);
    expect(argvPreview()).toContain("demo-alpha@example.test");

    // Switch, then look before the new dry run can answer. The panel is already
    // titled demo-beta, so any demo-alpha identity still on screen is a lie the
    // user could act on.
    await click(accountRow("demo-beta"));
    expect(argvPreview()).not.toContain("demo-alpha@example.test");

    await settle(200);
    expect(argvPreview()).toContain("demo-beta");
  });

  it("keeps a double-clicked launch to a single request", async () => {
    const row = accountRow("demo-beta");
    await click(row);
    await settle(200);

    await act(async () => {
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await settle(300);

    expect(mockCommandCountForTest("launch_account")).toBe(1);
  });

  it("says the list is stale instead of silently showing yesterday's accounts", async () => {
    failNextMockCommandForTest("list_accounts");
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="刷新"]')!);
    await settle(300);

    // The rows on screen are the last good ones, which is right — but saying
    // nothing would let the user act on a list that no longer matches disk.
    const toast = document.querySelector('.errorToast[role="alert"]');
    expect(toast?.textContent).toContain("账号列表加载失败");
    expect(buttonWithText("重试", toast ?? document)).toBeTruthy();
  });

  it("distinguishes a failed first load from a genuinely empty account list", async () => {
    await act(async () => {
      root?.unmount();
    });
    failNextMockCommandForTest("list_accounts");
    root = createRoot(container!);
    await act(async () => {
      root?.render(createElement(App));
    });
    await settle(300);

    const empty = document.querySelector(".emptyState");
    expect(empty?.textContent).toContain("账号列表加载失败");
    expect(empty?.textContent).not.toContain("暂无活跃账号");
  });
});
