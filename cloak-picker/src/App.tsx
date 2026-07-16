import { invoke } from "@tauri-apps/api/core";
import {
  ArchiveRestore,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  GripVertical,
  Globe2,
  KeyRound,
  Loader2,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

type Account = {
  name: string;
  profile_path: string;
  created_at: number;
  archived: boolean;
  trashed: boolean;
  seed: string;
  group: string | null;
  marked: boolean;
  mark_note: string | null;
  region: string | null;
  locale_enabled: boolean;
  proxy_display: string;
  has_proxy: boolean;
};

type LaunchPlan = {
  account: string;
  seed: string;
  profile_path: string;
  extension_runtime_path: string;
  load_extension_paths: string[];
  extra_extension_paths: string[];
  selftest_extension_paths: string[];
  browser_binary: string;
  proxy: {
    mode: "none" | "direct" | "relay";
    display: string;
    browser_arg: string | null;
    relay_needed: boolean;
    raw_url: string | null;
  };
  geo: {
    exit_ip: string | null;
    country: string | null;
    timezone: string | null;
  };
  locale: string | null;
  argv: string[];
  privacy_failures: string[];
};

type LaunchResult = {
  account: string;
  profile_path: string;
  browser_binary: string;
  url: string;
  pid: number;
  launched_at: number;
};

type DialogState =
  | { kind: "create"; value: string; group: string }
  | { kind: "rename"; account: Account; value: string }
  | { kind: "proxy"; account: Account; value: string }
  | { kind: "region"; account: Account; value: string }
  | { kind: "group"; account: Account; value: string }
  | { kind: "mark"; account: Account; value: string }
  | { kind: "delete"; account: Account }
  | { kind: "permanentDelete"; account: Account }
  | { kind: "deleteGroup"; groupLabel: string; count: number };

type GroupContextMenuState = {
  groupLabel: string;
  count: number;
  returnFocusElement: HTMLElement | null;
  x: number;
  y: number;
};

type AccountContextMenuState = {
  account: Account;
  returnFocusElement: HTMLElement;
  x: number;
  y: number;
};

type AccountDropTarget = {
  name: string;
  edge: "before" | "after";
};

const contextMenuWidth = 140;
const contextMenuHeight = 44;
const accountContextMenuWidth = 184;
const accountContextMenuMaxHeight = 320;
const contextMenuViewportPadding = 8;

const emptyAccounts: Account[] = [];
const mockMarkOverrides = new Map<string, { marked: boolean; note: string | null }>();
type AccountView = "active" | "trash";
const allGroupsValue = "__all__";
const allGroupsLabel = "全部";
const ungroupedLabel = "未分组";
const commonGroups = ["codex", "antigravity", "claude"];
const groupOrderStorageKey = "cloak-picker.groupOrder.v1";
const accountOrderStorageKey = "cloak-picker.accountOrder.v1";
const collapsedGroupsStorageKey = "cloak-picker.collapsedGroups.v1";
const hiddenGroupsStorageKey = "cloak-picker.hiddenGroups.v1";
const sidebarWidthStorageKey = "cloak-picker.sidebarWidth.v1";
const defaultSidebarWidth = 326;
const minSidebarWidth = 260;
const minDetailWidth = 360;
const paneResizerWidth = 8;

type GroupOption = {
  label: string;
  value: string;
};

type GroupFilter = GroupOption & {
  count: number;
};

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>(emptyAccounts);
  const [accountView, setAccountView] = useState<AccountView>("active");
  const [selectedName, setSelectedName] = useState<string>("");
  const [selectedGroup, setSelectedGroup] = useState<string>(allGroupsValue);
  const [accountSearch, setAccountSearch] = useState("");
  const [draggingAccountName, setDraggingAccountName] = useState<string>("");
  const [accountDropTarget, setAccountDropTarget] = useState<AccountDropTarget | null>(null);
  const [draggingGroupLabel, setDraggingGroupLabel] = useState<string>("");
  const [dropTargetGroup, setDropTargetGroup] = useState<string>("");
  const [groupOrder, setGroupOrder] = useState<string[]>(() => readStoredStringArray(groupOrderStorageKey));
  const [accountOrder, setAccountOrder] = useState<string[]>(() => readStoredStringArray(accountOrderStorageKey));
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readStoredNumber(sidebarWidthStorageKey, defaultSidebarWidth),
  );
  const [resizingPane, setResizingPane] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(() =>
    readStoredStringArray(collapsedGroupsStorageKey),
  );
  const [hiddenGroups, setHiddenGroups] = useState<string[]>(() => readStoredStringArray(hiddenGroupsStorageKey));
  const [busy, setBusy] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [webStoreStatus, setWebStoreStatus] = useState<{
    accountName: string;
    phase: "opening";
    startedAt: number;
  } | {
    accountName: string;
    phase: "opened";
    result: LaunchResult;
  } | null>(null);
  const [dialogError, setDialogError] = useState<string>("");
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [groupContextMenu, setGroupContextMenu] = useState<GroupContextMenuState | null>(null);
  const [accountContextMenu, setAccountContextMenu] = useState<AccountContextMenuState | null>(null);
  const draggingGroupLabelRef = useRef("");
  const groupDragStartRef = useRef<{ label: string; x: number; y: number } | null>(null);
  const groupDragMovedRef = useRef(false);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const resizingPaneRef = useRef(false);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);

  const orderedAccounts = useMemo(() => orderAccounts(accounts, accountOrder), [accounts, accountOrder]);
  const normalizedAccountSearch = accountSearch.trim().toLocaleLowerCase();
  const groupFilters = useMemo(
    () => buildGroupFilters(accounts, groupOrder, hiddenGroups),
    [accounts, groupOrder, hiddenGroups],
  );
  const visibleAccounts = useMemo(() => {
    const scopedAccounts =
      selectedGroup === allGroupsValue
        ? orderedAccounts
        : orderedAccounts.filter((account) => accountGroupLabel(account) === selectedGroup);
    if (!normalizedAccountSearch) return scopedAccounts;
    return scopedAccounts.filter((account) =>
      [account.name, account.group ?? "", account.mark_note ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(normalizedAccountSearch),
      ),
    );
  }, [normalizedAccountSearch, orderedAccounts, selectedGroup]);
  const selected = useMemo(
    () => visibleAccounts.find((account) => account.name === selectedName) ?? visibleAccounts[0] ?? null,
    [visibleAccounts, selectedName],
  );
  const groupedAccounts = useMemo(() => orderAccountGroups(groupAccounts(visibleAccounts), groupOrder), [visibleAccounts, groupOrder]);
  const groupOptions = useMemo(() => buildGroupOptions(accounts, hiddenGroups), [accounts, hiddenGroups]);

  async function refresh(preferredName?: string, view: AccountView = accountView) {
    setError("");
    const command = view === "trash" ? "list_trashed_accounts" : "list_accounts";
    const next = await call<Account[]>(command);
    const orderedNext = orderAccounts(next, accountOrder);
    setAccounts(next);
    setSelectedName((current) => {
      if (preferredName && next.some((account) => account.name === preferredName)) return preferredName;
      if (current && next.some((account) => account.name === current)) return current;
      return orderedNext[0]?.name ?? "";
    });
  }

  async function run<T>(operation: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError("");
    setDialogError("");
    try {
      return await operation();
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setDialogError(message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(() => refresh(undefined, accountView));
  }, [accountView]);

  useEffect(() => {
    if (selectedGroup === allGroupsValue) return;
    if (!groupFilters.some((group) => group.value === selectedGroup)) {
      setSelectedGroup(allGroupsValue);
    }
  }, [groupFilters, selectedGroup]);

  useEffect(() => {
    writeStoredStringArray(groupOrderStorageKey, groupOrder);
  }, [groupOrder]);

  useEffect(() => {
    writeStoredStringArray(accountOrderStorageKey, accountOrder);
  }, [accountOrder]);

  useEffect(() => {
    writeStoredStringArray(collapsedGroupsStorageKey, collapsedGroups);
  }, [collapsedGroups]);

  useEffect(() => {
    writeStoredStringArray(hiddenGroupsStorageKey, hiddenGroups);
  }, [hiddenGroups]);

  useEffect(() => {
    writeStoredNumber(sidebarWidthStorageKey, sidebarWidth);
  }, [sidebarWidth]);

  useEffect(() => {
    function clampSidebarToWorkspace() {
      const bounds = workspaceRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const maxSidebarWidth = Math.max(minSidebarWidth, bounds.width - minDetailWidth - paneResizerWidth);
      setSidebarWidth((current) => Math.round(clampNumber(current, minSidebarWidth, maxSidebarWidth)));
    }

    clampSidebarToWorkspace();
    window.addEventListener("resize", clampSidebarToWorkspace);
    return () => window.removeEventListener("resize", clampSidebarToWorkspace);
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(""), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (webStoreStatus?.phase !== "opened") return;
    let cancelled = false;
    const checkRunning = () => {
      call<boolean>("account_is_running", { name: webStoreStatus.accountName })
        .then((running) => {
          if (!cancelled && !running) setWebStoreStatus(null);
        })
        .catch(() => {
          if (!cancelled) setWebStoreStatus(null);
        });
    };
    const timer = window.setInterval(checkRunning, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [webStoreStatus]);

  useEffect(() => {
    if (!groupContextMenu && !accountContextMenu) return;
    const close = () => {
      setGroupContextMenu(null);
      setAccountContextMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", close);
    };
  }, [groupContextMenu, accountContextMenu]);

  useEffect(() => {
    if (!selected) {
      setPlan(null);
      return;
    }
    if (selected.trashed) {
      setPlan(null);
      return;
    }

    let cancelled = false;
    setPlanLoading(true);
    setError("");
    call<LaunchPlan>("launch_dry_run", { name: selected.name })
      .then((dryRun) => {
        if (!cancelled) setPlan(dryRun);
      })
      .catch((caught) => {
        if (!cancelled) {
          setPlan(null);
          setError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setPlanLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.name, selected?.trashed]);

  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog) return;

    if (dialog.kind === "delete") {
      await confirmDeleteAccount(dialog.account);
      return;
    }

    if (dialog.kind === "permanentDelete") {
      await confirmPermanentDeleteAccount(dialog.account);
      return;
    }

    if (dialog.kind === "deleteGroup") {
      await confirmDeleteGroup(dialog.groupLabel);
      return;
    }

    const value = dialog.value.trim();
    if (dialog.kind === "create") {
      if (!value) return;
      const group = dialog.group.trim() || null;
      const account = await run(() => call<Account>("create_account", { name: value, group }));
      if (account) {
        setAccountOrder((current) => [
          account.name,
          ...orderedAccountNames(accounts, current).filter((name) => name !== account.name),
        ]);
        if (group) {
          setHiddenGroups((current) => current.filter((label) => label !== group));
        }
        setDialog(null);
        setAccountView("active");
        await refresh(account.name, "active");
      }
      return;
    }

    if (dialog.kind === "rename") {
      if (!value || value === dialog.account.name) {
        setDialog(null);
        return;
      }
      const renamed = await run(() =>
        call<Account>("rename_account", { oldName: dialog.account.name, newName: value }),
      );
      if (renamed) {
        setAccountOrder((current) =>
          current.map((name) => (name === dialog.account.name ? renamed.name : name)),
        );
        setDialog(null);
        await refresh(renamed.name);
      }
      return;
    }

    if (dialog.kind === "proxy") {
      const updated = await run(() =>
        call<Account>("set_proxy", {
          name: dialog.account.name,
          value: value || null,
        }),
      );
      if (updated) {
        setDialog(null);
        await refresh(updated.name);
      }
      return;
    }

    if (dialog.kind === "group") {
      await assignAccountGroup(dialog.account, value || null, true);
      return;
    }

    if (dialog.kind === "mark") {
      const currentNote = dialog.account.mark_note?.trim() || "";
      if (dialog.account.marked && value === currentNote) {
        setDialog(null);
        return;
      }
      const updated = await run(() =>
        call<Account>("set_mark", {
          name: dialog.account.name,
          marked: true,
          note: value || null,
        }),
      );
      if (updated) {
        setDialog(null);
        await refresh(updated.name);
      }
      return;
    }

    const updated = await run(() =>
      call<Account>("set_region", {
        name: dialog.account.name,
        value: value || null,
      }),
    );
    if (updated) {
      setDialog(null);
      await refresh(updated.name);
    }
  }

  function openDialog(next: DialogState, trigger?: HTMLElement | null) {
    dialogTriggerRef.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setDialog(next);
  }

  function openCreateDialog(trigger?: HTMLElement | null) {
    setError("");
    setDialogError("");
    openDialog({ kind: "create", value: "", group: defaultCreateGroupValue() }, trigger);
  }

  function defaultCreateGroupValue() {
    if (accountView !== "active" || selectedGroup === allGroupsValue) return "";
    return selectedGroup === ungroupedLabel ? "" : selectedGroup;
  }

  async function assignAccountGroup(account: Account, value: string | null, closeDialog: boolean) {
    const nextGroup = value?.trim() || null;
    const currentGroup = account.group?.trim() || null;
    if (currentGroup === nextGroup) {
      if (closeDialog) setDialog(null);
      return;
    }

    const updated = await run(() =>
      call<Account>("set_group", {
        name: account.name,
        value: nextGroup,
      }),
    );
    if (!updated) return;
    if (nextGroup) {
      setHiddenGroups((current) => current.filter((label) => label !== nextGroup));
    }
    if (closeDialog) setDialog(null);
    await refresh(updated.name);
  }

  function startAccountDrag(event: DragEvent<HTMLButtonElement>, account: Account) {
    if (account.trashed) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", account.name);
    setAccountDropTarget(null);
    setDraggingAccountName(account.name);
    setSelectedName(account.name);
  }

  function allowAccountDrop(event: DragEvent<HTMLButtonElement>, target: Account) {
    const source = accounts.find((account) => account.name === draggingAccountName);
    if (!source || accountGroupLabel(source) !== accountGroupLabel(target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetGroup("");
    if (source.name === target.name) {
      setAccountDropTarget(null);
      return;
    }
    setAccountDropTarget({ name: target.name, edge: accountDropEdge(event) });
  }

  function dropAccountOnAccount(event: DragEvent<HTMLButtonElement>, target: Account) {
    const sourceName = event.dataTransfer.getData("text/plain") || draggingAccountName;
    const source = accounts.find((account) => account.name === sourceName);
    if (!source || accountGroupLabel(source) !== accountGroupLabel(target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (source.name !== target.name) {
      const edge = accountDropTarget?.name === target.name ? accountDropTarget.edge : accountDropEdge(event);
      setAccountOrder((current) => reorderAccountNames(current, accounts, source.name, target.name, edge));
    }
    setDraggingAccountName("");
    setAccountDropTarget(null);
    setDropTargetGroup("");
  }

  function leaveAccountDrop(event: DragEvent<HTMLButtonElement>, targetName: string) {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setAccountDropTarget((current) => (current?.name === targetName ? null : current));
  }

  function allowGroupDrop(event: DragEvent<HTMLElement>, groupLabel: string) {
    if (!draggingAccountName) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setAccountDropTarget(null);
    setDropTargetGroup(groupLabel);
  }

  async function dropAccountOnGroup(event: DragEvent<HTMLElement>, groupLabel: string) {
    event.preventDefault();
    const accountName = event.dataTransfer.getData("text/plain") || draggingAccountName;
    setDraggingAccountName("");
    setAccountDropTarget(null);
    setDropTargetGroup("");
    const account = accounts.find((item) => item.name === accountName);
    if (!account) return;
    await assignAccountGroup(account, groupLabel === ungroupedLabel ? null : groupLabel, false);
  }

  async function moveAccountFromContextMenu(account: Account, value: string) {
    setAccountContextMenu(null);
    await assignAccountGroup(account, value || null, false);
  }

  function renameAccountFromContextMenu(account: Account, trigger: HTMLElement) {
    setAccountContextMenu(null);
    openDialog({ kind: "rename", account, value: account.name }, trigger);
  }

  function markAccountFromContextMenu(account: Account, trigger: HTMLElement) {
    setAccountContextMenu(null);
    openDialog({ kind: "mark", account, value: account.mark_note ?? "" }, trigger);
  }

  async function clearAccountMarkFromContextMenu(account: Account) {
    setAccountContextMenu(null);
    const updated = await run(() =>
      call<Account>("set_mark", {
        name: account.name,
        marked: false,
        note: null,
      }),
    );
    if (updated) await refresh(updated.name);
  }

  function deleteAccountFromContextMenu(account: Account, trigger: HTMLElement) {
    setAccountContextMenu(null);
    openDialog(account.trashed ? { kind: "permanentDelete", account } : { kind: "delete", account }, trigger);
  }

  function openAccountContextMenu(event: MouseEvent<HTMLButtonElement>, account: Account) {
    event.preventDefault();
    event.stopPropagation();
    const menuPosition = placeContextMenu(
      event.clientX,
      event.clientY,
      accountContextMenuWidth,
      accountContextMenuHeight(groupOptions.length, account.marked),
    );
    setGroupContextMenu(null);
    setSelectedName(account.name);
    setAccountContextMenu({
      account,
      returnFocusElement: event.currentTarget,
      x: menuPosition.x,
      y: menuPosition.y,
    });
  }

  function startGroupPointerDrag(event: PointerEvent<HTMLElement>, group: GroupFilter) {
    if (group.value === allGroupsValue) return;
    if (event.button !== 0) return;
    draggingGroupLabelRef.current = group.label;
    groupDragStartRef.current = { label: group.label, x: event.clientX, y: event.clientY };
    groupDragMovedRef.current = false;
    setDraggingGroupLabel(group.label);
    setDropTargetGroup(group.label);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveGroupPointerDrag(event: PointerEvent<HTMLElement>) {
    const source = draggingGroupLabelRef.current;
    if (!source) return;
    event.preventDefault();
    const start = groupDragStartRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) {
      groupDragMovedRef.current = true;
    }
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const target = element?.closest("[data-group-label]") as HTMLElement | null;
    const targetLabel = target?.dataset.groupLabel ?? "";
    if (!targetLabel || targetLabel === allGroupsLabel) return;
    setDropTargetGroup(targetLabel);
    if (targetLabel !== source) {
      setGroupOrder((current) => reorderGroupLabels(current, groupFilters, source, targetLabel));
    }
  }

  function endGroupPointerDrag(event: PointerEvent<HTMLElement>) {
    const start = groupDragStartRef.current;
    const moved = groupDragMovedRef.current;
    if (draggingGroupLabelRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggingGroupLabelRef.current = "";
    groupDragStartRef.current = null;
    setDraggingGroupLabel("");
    setDropTargetGroup("");
    if (start && !moved) {
      setSelectedGroup(start.label);
    }
    window.setTimeout(() => {
      groupDragMovedRef.current = false;
    }, 0);
  }

  function handleGroupFilterClick(group: GroupFilter) {
    if (groupDragMovedRef.current) {
      groupDragMovedRef.current = false;
      return;
    }
    if (group.value === allGroupsValue && selectedGroup === allGroupsValue) {
      toggleAllGroupsCollapsed();
      return;
    }
    setSelectedGroup(group.value);
  }

  function resizeSidebarFromPointer(clientX: number) {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const maxSidebarWidth = Math.max(minSidebarWidth, bounds.width - minDetailWidth - paneResizerWidth);
    const next = clampNumber(clientX - bounds.left, minSidebarWidth, maxSidebarWidth);
    setSidebarWidth(Math.round(next));
  }

  function startPaneResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizingPaneRef.current = true;
    setResizingPane(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeSidebarFromPointer(event.clientX);
  }

  function movePaneResize(event: PointerEvent<HTMLDivElement>) {
    if (!resizingPaneRef.current) return;
    event.preventDefault();
    resizeSidebarFromPointer(event.clientX);
  }

  function endPaneResize(event: PointerEvent<HTMLDivElement>) {
    if (resizingPaneRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizingPaneRef.current = false;
    setResizingPane(false);
  }

  function toggleGroupCollapse(groupLabel: string) {
    setCollapsedGroups((current) => toggleStringInArray(current, groupLabel));
  }

  function toggleAllGroupsCollapsed() {
    const labels = groupedAccounts.map((group) => group.label);
    if (labels.length === 0) return;
    setCollapsedGroups((current) => {
      const next = new Set(current);
      const allCollapsed = labels.every((label) => next.has(label));
      for (const label of labels) {
        if (allCollapsed) {
          next.delete(label);
        } else {
          next.add(label);
        }
      }
      return [...next];
    });
  }

  async function toggleLocale(account: Account) {
    const updated = await run(() => call<Account>("toggle_locale", { name: account.name }));
    if (updated) await refresh(updated.name);
  }

  async function launchAccount(account: Account) {
    if (account.trashed) return;
    const checked = await runFullPreflight(account);
    if (!checked) return;
    if (checked.privacy_failures.length > 0) {
      setError("启动检查未通过，已停止启动。");
      return;
    }
    await run(() => call<LaunchResult>("launch_account", { name: account.name }));
  }

  async function launchWebStore(account: Account) {
    if (account.trashed) return;
    setWebStoreStatus({ accountName: account.name, phase: "opening", startedAt: Date.now() });
    const checked = await runFullPreflight(account);
    if (!checked) {
      setWebStoreStatus(null);
      return;
    }
    if (checked.privacy_failures.length > 0) {
      setWebStoreStatus(null);
      setError("启动检查未通过，已停止打开商店。");
      return;
    }
    const result = await run(() => call<LaunchResult>("launch_web_store", { name: account.name }));
    setWebStoreStatus(result === null ? null : { accountName: result.account, phase: "opened", result });
  }

  async function runFullPreflight(account: Account): Promise<LaunchPlan | null> {
    setPlanLoading(true);
    setError("");
    try {
      const checked = await call<LaunchPlan>("launch_preflight", { name: account.name });
      setPlan(checked);
      return checked;
    } catch (caught) {
      const message = errorMessage(caught);
      setPlan(null);
      setError(message);
      return null;
    } finally {
      setPlanLoading(false);
    }
  }

  async function confirmDeleteAccount(account: Account) {
    setBusy(true);
    setError("");
    setDialogError("");
    try {
      await call<void>("delete_account", { name: account.name });
      setDialog(null);
      setPlan(null);
      await refresh(undefined, accountView);
    } catch (caught) {
      const message = errorMessage(caught);
      setDialogError(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPermanentDeleteAccount(account: Account) {
    setBusy(true);
    setError("");
    setDialogError("");
    try {
      await call<void>("permanently_delete_account", { name: account.name });
      setDialog(null);
      setPlan(null);
      await refresh(undefined, "trash");
    } catch (caught) {
      const message = errorMessage(caught);
      setDialogError(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteGroup(groupLabel: string) {
    if (!groupLabel || groupLabel === allGroupsLabel || groupLabel === ungroupedLabel) {
      setDialog(null);
      return;
    }
    setBusy(true);
    setError("");
    setDialogError("");
    try {
      const [activeAccounts, trashedAccounts] = await Promise.all([
        call<Account[]>("list_accounts"),
        call<Account[]>("list_trashed_accounts"),
      ]);
      const accountsToClear = [...activeAccounts, ...trashedAccounts].filter(
        (account) => accountGroupLabel(account) === groupLabel,
      );
      await Promise.all(
        accountsToClear.map((account) =>
          call<Account>("set_group", {
            name: account.name,
            value: null,
          }),
        ),
      );
      setHiddenGroups((current) => (current.includes(groupLabel) ? current : [...current, groupLabel]));
      setGroupOrder((current) => current.filter((label) => label !== groupLabel));
      setCollapsedGroups((current) => current.filter((label) => label !== groupLabel));
      if (selectedGroup === groupLabel) setSelectedGroup(allGroupsValue);
      setDialog(null);
      await refresh(selectedName, accountView);
    } catch (caught) {
      const message = errorMessage(caught);
      setDialogError(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function restoreAccount(account: Account) {
    const restored = await run(() => call<Account>("restore_account", { name: account.name }));
    if (!restored) return;
    setPlan(null);
    setAccountView("active");
    await refresh(restored.name, "active");
  }

  const selectedGroupLabel = selectedGroup === allGroupsValue ? "" : `${selectedGroup} 分组 · `;
  const accountCountLabel =
    accountView === "trash"
      ? `${selectedGroupLabel}${visibleAccounts.length} 个回收站账号`
      : `${selectedGroupLabel}${visibleAccounts.length} 个活跃账号`;
  const hasAccountSearch = normalizedAccountSearch.length > 0;
  const emptyTitle = hasAccountSearch
    ? "未找到匹配账号"
    : accountView === "trash"
      ? "回收站为空"
      : "暂无活跃账号";
  const emptyAction = hasAccountSearch ? "清除搜索" : accountView === "active" ? "新建账号" : "查看活跃";
  const proxyLabel = selected ? middleTruncate(selected.proxy_display, 48) : "";
  const statusLabel = selected?.trashed ? "已移入回收站" : "活跃";
  const webStoreStatusIsCurrent = Boolean(selected && webStoreStatus?.accountName === selected.name);
  const webStoreStatusLabel = webStoreStatus
    ? webStoreStatus.phase === "opening"
      ? webStoreStatusIsCurrent
        ? "正在打开商店…"
        : `正在打开商店：${middleTruncate(webStoreStatus.accountName, 34)}`
      : webStoreStatusIsCurrent
        ? `商店已打开 · PID ${webStoreStatus.result.pid} · ${formatLaunchClock(webStoreStatus.result.launched_at)}`
        : `已打开商店：${middleTruncate(webStoreStatus.accountName, 34)} · PID ${webStoreStatus.result.pid} · ${formatLaunchClock(webStoreStatus.result.launched_at)}`
    : "";
  const workspaceStyle = { "--sidebar-width": `${sidebarWidth}px` } as CSSProperties & {
    "--sidebar-width": string;
  };
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <div>
            <strong>Cloak 账号管理</strong>
            <span>{accountCountLabel}</span>
          </div>
        </div>
        <div className="accountSearch">
          <div className="accountSearchField">
            <Search aria-hidden="true" size={15} />
            <input
              aria-label="搜索账号"
              autoComplete="off"
              placeholder="搜索账号、分组或标记"
              spellCheck={false}
              type="search"
              value={accountSearch}
              onChange={(event) => setAccountSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setAccountSearch("");
                  event.currentTarget.blur();
                }
              }}
            />
            {hasAccountSearch ? (
              <button aria-label="清除搜索" title="清除搜索" type="button" onClick={() => setAccountSearch("")}>
                <X aria-hidden="true" size={11} />
              </button>
            ) : null}
          </div>
        </div>
        <div className="topActions">
          <IconButton label="刷新" disabled={busy} onClick={() => void run(() => refresh())}>
            <RefreshCw size={15} />
          </IconButton>
          <button className="primaryButton" disabled={busy} onClick={(event) => openCreateDialog(event.currentTarget)}>
            <Plus size={15} />
            新建
          </button>
        </div>
      </header>

      <section className={`workspace ${resizingPane ? "resizing" : ""}`} ref={workspaceRef} style={workspaceStyle}>
        <aside className="sidebar">
          <div className="sidebarHeader">
            <span>账号</span>
            {busy ? <Loader2 className="spin" size={14} /> : null}
          </div>
          <div className="viewSwitch" role="tablist" aria-label="账号视图">
            <button
              className={accountView === "active" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={accountView === "active"}
              onClick={() => setAccountView("active")}
            >
              活跃
            </button>
            <button
              className={accountView === "trash" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={accountView === "trash"}
              onClick={() => setAccountView("trash")}
            >
              回收站
            </button>
          </div>

          <div className="groupFilter" aria-label="分组筛选">
            {groupFilters.map((group) => {
              const isAll = group.value === allGroupsValue;
              const isActive = selectedGroup === group.value;
              const canDeleteGroup = !isAll && group.label !== ungroupedLabel;
              return (
                <div
                  className={`groupFilterButton ${isActive ? "active" : ""} ${draggingGroupLabel === group.label ? "dragging" : ""} ${dropTargetGroup === group.label ? "dropTarget" : ""}`}
                  data-group-label={isAll ? undefined : group.label}
                  key={group.value}
                  title={isAll ? "再次点击可折叠或展开全部分组" : "按住拖动可调整分组顺序"}
                  onDragLeave={() => setDropTargetGroup((current) => (current === group.label ? "" : current))}
                  onDragOver={(event) => {
                    if (!isAll) {
                      allowGroupDrop(event, group.label);
                    }
                  }}
                  onDrop={(event) => {
                    if (!isAll) {
                      void dropAccountOnGroup(event, group.label);
                    }
                  }}
                  onPointerCancel={endGroupPointerDrag}
                  onPointerDown={(event) => startGroupPointerDrag(event, group)}
                  onPointerMove={moveGroupPointerDrag}
                  onPointerUp={endGroupPointerDrag}
                  onContextMenu={(event) => {
                    if (!canDeleteGroup) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const menuPosition = placeContextMenu(event.clientX, event.clientY, contextMenuWidth, contextMenuHeight);
                    setAccountContextMenu(null);
                    setGroupContextMenu({
                      groupLabel: group.label,
                      count: group.count,
                      returnFocusElement: event.currentTarget.querySelector<HTMLElement>(".groupFilterSelect"),
                      x: menuPosition.x,
                      y: menuPosition.y,
                    });
                  }}
                >
                  <button
                    className="groupFilterSelect"
                    type="button"
                    aria-pressed={isActive}
                    title={isAll ? "再次点击可折叠或展开全部分组" : "点击查看该分组；按住拖动调整顺序"}
                    onClick={() => handleGroupFilterClick(group)}
                  >
                    {isAll ? null : (
                      <span
                        className="groupDragHandle"
                        title="拖动调整分组顺序"
                      >
                        <GripVertical size={12} />
                      </span>
                    )}
                    {isAll ? null : <Folder className="groupIcon" size={12} />}
                    <span className="groupFilterLabel">{group.label}</span>
                    <small>{group.count}</small>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="accountList">
            {visibleAccounts.length === 0 ? (
              <div className="emptyState">
                {accountView === "active" ? <ShieldCheck size={24} /> : <Trash2 size={24} />}
                <strong>{emptyTitle}</strong>
                <button
                  className="subtleButton"
                  onClick={
                    hasAccountSearch
                      ? () => setAccountSearch("")
                      : accountView === "active"
                        ? (event) => openCreateDialog(event.currentTarget)
                        : () => setAccountView("active")
                  }
                >
                  {hasAccountSearch ? (
                    <X size={14} />
                  ) : accountView === "active" ? (
                    <Plus size={14} />
                  ) : (
                    <ArchiveRestore size={14} />
                  )}
                  {emptyAction}
                </button>
              </div>
            ) : (
              groupedAccounts.map((group) => (
                <AccountGroupSection
                  accountDropTarget={accountDropTarget}
                  collapsed={selectedGroup === allGroupsValue && collapsedGroups.includes(group.label)}
                  canCollapse={selectedGroup === allGroupsValue}
                  dropTarget={dropTargetGroup === group.label}
                  group={group}
                  key={group.label}
                  onAllowDrop={allowGroupDrop}
                  onAllowAccountDrop={allowAccountDrop}
                  onDropAccount={dropAccountOnGroup}
                  onDropAccountOnAccount={dropAccountOnAccount}
                  onLeaveAccountDrop={leaveAccountDrop}
                  onLaunchAccount={launchAccount}
                  onOpenAccountContextMenu={openAccountContextMenu}
                  onRestoreAccount={restoreAccount}
                  onSelectAccount={setSelectedName}
                  onStartAccountDrag={startAccountDrag}
                  onToggleCollapse={toggleGroupCollapse}
                  selectedName={selected?.name ?? ""}
                  setDraggingAccountName={setDraggingAccountName}
                  setAccountDropTarget={setAccountDropTarget}
                  setDropTargetGroup={setDropTargetGroup}
                />
              ))
            )}
          </div>
        </aside>

        <div
          className={`paneResizer ${resizingPane ? "dragging" : ""}`}
          role="separator"
          aria-label="调整账号列表宽度"
          aria-orientation="vertical"
          aria-valuemin={minSidebarWidth}
          aria-valuenow={sidebarWidth}
          onDoubleClick={() => setSidebarWidth(defaultSidebarWidth)}
          onPointerCancel={endPaneResize}
          onPointerDown={startPaneResize}
          onPointerMove={movePaneResize}
          onPointerUp={endPaneResize}
          title="左右拖动调整账号列表宽度，双击恢复默认"
        />

        <section className="detail">
          {selected ? (
            <>
              <header className="detailHeader">
                <div className="titleBlock">
                  <span className="eyebrow">隔离身份</span>
                  <h1 title={selected.name}>{middleTruncate(selected.name, 44)}</h1>
                  {webStoreStatusLabel ? (
                    <span
                      className={`webStoreStatus ${webStoreStatusIsCurrent ? "current" : "other"}`}
                      title={
                        webStoreStatus?.phase === "opened"
                          ? `${webStoreStatusLabel}｜profile=${webStoreStatus.result.profile_path}`
                          : webStoreStatusLabel
                      }
                    >
                      {webStoreStatusLabel}
                    </span>
                  ) : null}
                </div>
                {selected.trashed ? (
                  <button className="launchButton" disabled={busy} onClick={() => void restoreAccount(selected)}>
                    <ArchiveRestore size={16} />
                    恢复
                  </button>
                ) : (
                  <div className="detailHeaderControl">
                    <div className="detailHeaderActions">
                      <button
                        className="secondaryButton"
                        disabled={busy || planLoading}
                        title={`用 ${selected.name} 打开 Chrome Web Store`}
                        onClick={() => void launchWebStore(selected)}
                      >
                        <Store size={16} />
                        {webStoreStatus?.phase === "opening" && webStoreStatus.accountName === selected.name ? "打开中" : "商店"}
                      </button>
                      <button className="launchButton" disabled={busy || planLoading} onClick={() => void launchAccount(selected)}>
                        <Play size={16} />
                        启动
                      </button>
                    </div>
                  </div>
                )}
              </header>

              <div className="detailScroll">
                <section className="inspector">
                  <InspectorGroup title="身份">
                    <InfoRow icon={<KeyRound size={15} />} label="指纹" value={selected.seed} mono />
                    <InfoRow icon={<Folder size={15} />} label="分组" value={accountGroupLabel(selected)} />
                    <InfoRow icon={<CalendarClock size={15} />} label="创建时间" value={formatCreatedAt(selected.created_at)} />
                    <InfoRow icon={selected.trashed ? <Trash2 size={15} /> : <ShieldCheck size={15} />} label="状态" value={statusLabel} />
                    <InfoRow label="账号目录" value={selected.profile_path} mono />
                  </InspectorGroup>

                  <InspectorGroup title="网络">
                    <InfoRow icon={<Tag size={15} />} label="区域" value={selected.region ?? "未设置"} />
                    <InfoRow icon={<Globe2 size={15} />} label="语言" value={selected.locale_enabled ? "跟随出口" : "关"} />
                    <InfoRow icon={<Network size={15} />} label="代理" value={proxyLabel} />
                    <InfoRow label="出口 IP" value={plan?.geo.exit_ip ?? "启动时解析"} />
                    <InfoRow label="时区" value={plan?.geo.timezone ?? "启动时解析"} />
                  </InspectorGroup>

                  <InspectorGroup title="运行">
                    <InfoRow label="真实插件" value={plan ? extensionSummary(plan.extra_extension_paths) : "未解析"} />
                    <InfoRow label="自测插件" value={plan ? extensionSummary(plan.selftest_extension_paths) : "未解析"} />
                    <InfoRow label="浏览器" value={plan?.browser_binary ?? "未解析"} mono />
                  </InspectorGroup>
                </section>

                {plan?.privacy_failures.length ? (
                  <div className="warningBox">
                    {plan.privacy_failures.map((failure) => (
                      <p key={failure}>{failure}</p>
                    ))}
                  </div>
                ) : null}

                <details className="argv">
                  <summary>启动参数</summary>
                  <code>{[plan?.browser_binary, ...(plan?.argv ?? [])].filter(Boolean).join(" ")}</code>
                </details>
              </div>

              <footer className="detailFooter">
                <div className="actionBar">
                  {selected.trashed ? (
                    <>
                      <ActionButton icon={<ArchiveRestore size={15} />} label="恢复账号" onClick={() => void restoreAccount(selected)} />
                      <ActionButton danger icon={<Trash2 size={15} />} label="彻底删除" onClick={(event) => openDialog({ kind: "permanentDelete", account: selected }, event.currentTarget)} />
                    </>
                  ) : (
                    <>
                      <ActionButton icon={<Network size={15} />} label="代理" onClick={(event) => openDialog({ kind: "proxy", account: selected, value: "" }, event.currentTarget)} />
                      <ActionButton icon={<Tag size={15} />} label="区域" onClick={(event) => openDialog({ kind: "region", account: selected, value: selected.region ?? "" }, event.currentTarget)} />
                      <ActionButton icon={<Folder size={15} />} label="分组" onClick={(event) => openDialog({ kind: "group", account: selected, value: selected.group ?? "" }, event.currentTarget)} />
                      <ActionButton icon={<Globe2 size={15} />} label={selected.locale_enabled ? "关闭语言" : "开启语言"} onClick={() => void toggleLocale(selected)} />
                      <ActionButton icon={<Pencil size={15} />} label="重命名" onClick={(event) => openDialog({ kind: "rename", account: selected, value: selected.name }, event.currentTarget)} />
                      <ActionButton danger icon={<Trash2 size={15} />} label="删除" onClick={(event) => openDialog({ kind: "delete", account: selected }, event.currentTarget)} />
                    </>
                  )}
                </div>
              </footer>
            </>
          ) : (
            <div className="emptyState detailEmpty">
              <ShieldCheck size={28} />
              <strong>选择账号</strong>
            </div>
          )}
        </section>
      </section>

      {groupContextMenu ? (
        <div
          className="contextMenu"
          style={{ left: groupContextMenu.x, top: groupContextMenu.y }}
          role="menu"
          aria-label={`${groupContextMenu.groupLabel} 分组菜单`}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            className="contextMenuItem danger"
            disabled={busy}
            type="button"
            role="menuitem"
            onClick={() => {
              openDialog({
                kind: "deleteGroup",
                groupLabel: groupContextMenu.groupLabel,
                count: groupContextMenu.count,
              }, groupContextMenu.returnFocusElement);
              setGroupContextMenu(null);
            }}
          >
            <Trash2 size={14} />
            删除分组
          </button>
        </div>
      ) : null}

      {accountContextMenu ? (
        <div
          className="contextMenu accountContextMenu"
          style={{ left: accountContextMenu.x, top: accountContextMenu.y }}
          role="menu"
          aria-label={`${accountContextMenu.account.name} 账号菜单`}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="contextMenuTitle">移动到分组</div>
          {groupOptions.map((option) => {
            const activeValue = accountContextMenu.account.group?.trim() || "";
            const isActive = option.value === activeValue || (!option.value && !activeValue);
            return (
              <button
                className={`contextMenuItem ${isActive ? "active" : ""}`}
                disabled={busy}
                type="button"
                key={option.label}
                role="menuitem"
                aria-pressed={isActive}
                onClick={() => {
                  if (isActive) {
                    setAccountContextMenu(null);
                    return;
                  }
                  void moveAccountFromContextMenu(accountContextMenu.account, option.value);
                }}
              >
                <Folder size={14} />
                <span className="contextMenuItemLabel">{option.label}</span>
                {isActive ? <Check className="contextMenuCheck" size={14} /> : null}
              </button>
            );
          })}
          <div className="contextMenuDivider" />
          <div className="contextMenuTitle">账号操作</div>
          <button
            className="contextMenuItem"
            disabled={busy}
            type="button"
            role="menuitem"
            onClick={() =>
              markAccountFromContextMenu(accountContextMenu.account, accountContextMenu.returnFocusElement)
            }
          >
            <span className="contextMarkDot" aria-hidden="true" />
            <span className="contextMenuItemLabel">{accountContextMenu.account.marked ? "编辑标记" : "标记"}</span>
          </button>
          {accountContextMenu.account.marked ? (
            <button
              className="contextMenuItem"
              disabled={busy}
              type="button"
              role="menuitem"
              onClick={() => void clearAccountMarkFromContextMenu(accountContextMenu.account)}
            >
              <span className="contextMarkDot clear" aria-hidden="true" />
              <span className="contextMenuItemLabel">取消标记</span>
            </button>
          ) : null}
          <button
            className="contextMenuItem"
            disabled={busy}
            type="button"
            role="menuitem"
            onClick={() =>
              renameAccountFromContextMenu(accountContextMenu.account, accountContextMenu.returnFocusElement)
            }
          >
            <Pencil size={14} />
            <span className="contextMenuItemLabel">重命名</span>
          </button>
          <button
            className="contextMenuItem danger"
            disabled={busy}
            type="button"
            role="menuitem"
            onClick={() =>
              deleteAccountFromContextMenu(accountContextMenu.account, accountContextMenu.returnFocusElement)
            }
          >
            <Trash2 size={14} />
            <span className="contextMenuItemLabel">{accountContextMenu.account.trashed ? "彻底删除" : "删除"}</span>
          </button>
        </div>
      ) : null}

      {error && !dialog ? <div className="toast errorToast">{error}</div> : null}
      {dialog ? (
        <EditorDialog
          dialog={dialog}
          busy={busy}
          error={dialogError}
          returnFocusElement={dialogTriggerRef.current}
          onChange={(next) => {
            setDialogError("");
            setDialog(next);
          }}
          onClose={() => {
            setDialogError("");
            setDialog(null);
          }}
          onConfirmDelete={confirmDeleteAccount}
          onConfirmDeleteGroup={(groupLabel) => void confirmDeleteGroup(groupLabel)}
          onConfirmPermanentDelete={confirmPermanentDeleteAccount}
          groupOptions={groupOptions}
          onQuickGroup={(account, value) => void assignAccountGroup(account, value || null, true)}
          onSubmit={submitDialog}
        />
      ) : null}
    </main>
  );
}

function AccountGroupSection({
  accountDropTarget,
  canCollapse,
  collapsed,
  dropTarget,
  group,
  selectedName,
  onAllowAccountDrop,
  onAllowDrop,
  onDropAccount,
  onDropAccountOnAccount,
  onLeaveAccountDrop,
  onLaunchAccount,
  onOpenAccountContextMenu,
  onRestoreAccount,
  onSelectAccount,
  onStartAccountDrag,
  onToggleCollapse,
  setAccountDropTarget,
  setDraggingAccountName,
  setDropTargetGroup,
}: {
  accountDropTarget: AccountDropTarget | null;
  canCollapse: boolean;
  collapsed: boolean;
  dropTarget: boolean;
  group: AccountGroup;
  selectedName: string;
  onAllowAccountDrop: (event: DragEvent<HTMLButtonElement>, account: Account) => void;
  onAllowDrop: (event: DragEvent<HTMLElement>, groupLabel: string) => void;
  onDropAccount: (event: DragEvent<HTMLElement>, groupLabel: string) => Promise<void>;
  onDropAccountOnAccount: (event: DragEvent<HTMLButtonElement>, account: Account) => void;
  onLeaveAccountDrop: (event: DragEvent<HTMLButtonElement>, accountName: string) => void;
  onLaunchAccount: (account: Account) => Promise<void>;
  onOpenAccountContextMenu: (event: MouseEvent<HTMLButtonElement>, account: Account) => void;
  onRestoreAccount: (account: Account) => Promise<void>;
  onSelectAccount: (name: string) => void;
  onStartAccountDrag: (event: DragEvent<HTMLButtonElement>, account: Account) => void;
  onToggleCollapse: (groupLabel: string) => void;
  setAccountDropTarget: (target: AccountDropTarget | null) => void;
  setDraggingAccountName: (name: string) => void;
  setDropTargetGroup: (groupLabel: string) => void;
}) {
  return (
    <section
      className={`accountGroup ${dropTarget ? "dropTarget" : ""} ${collapsed ? "collapsed" : ""}`}
      onDragLeave={() => setDropTargetGroup("")}
      onDragOver={(event) => onAllowDrop(event, group.label)}
      onDrop={(event) => void onDropAccount(event, group.label)}
    >
      <div className="accountGroupHeader">
        <button
          className="accountGroupName"
          type="button"
          title={canCollapse ? "点击折叠或展开该分组" : group.label}
          onClick={() => {
            if (canCollapse) onToggleCollapse(group.label);
          }}
        >
          {canCollapse ? (
            collapsed ? (
              <ChevronRight className="collapseIcon" size={13} />
            ) : (
              <ChevronDown className="collapseIcon" size={13} />
            )
          ) : (
            <Folder size={13} />
          )}
          <strong>{middleTruncate(group.label, 28)}</strong>
        </button>
        <span className="accountGroupCount">{group.accounts.length}</span>
      </div>
      {collapsed
        ? null
        : group.accounts.map((account) => (
            <button
              className={`accountRow ${account.name === selectedName ? "selected" : ""} ${accountDropTarget?.name === account.name ? (accountDropTarget.edge === "before" ? "dropBefore" : "dropAfter") : ""}`}
              draggable={!account.trashed}
              key={account.name}
              title={`${account.name}${account.marked ? `｜已标记${account.mark_note ? `：${account.mark_note}` : ""}` : ""}${account.trashed ? "" : "｜拖动可调整顺序或移动分组"}`}
              onClick={() => onSelectAccount(account.name)}
              onContextMenu={(event) => onOpenAccountContextMenu(event, account)}
              onDoubleClick={() => {
                if (account.trashed) {
                  void onRestoreAccount(account);
                } else {
                  void onLaunchAccount(account);
                }
              }}
              onDragEnd={() => {
                setDraggingAccountName("");
                setAccountDropTarget(null);
                setDropTargetGroup("");
              }}
              onDragLeave={(event) => onLeaveAccountDrop(event, account.name)}
              onDragOver={(event) => onAllowAccountDrop(event, account)}
              onDragStart={(event) => onStartAccountDrag(event, account)}
              onDrop={(event) => onDropAccountOnAccount(event, account)}
            >
              <span className="accountRail" />
              <span className="accountMain">
                <span className="accountTitle">
                  <GripVertical className="dragHandle" size={14} />
                  <strong title={account.name}>{middleTruncate(account.name, 34)}</strong>
                  {account.marked ? (
                    <span
                      className={`accountMark ${account.mark_note ? "withNote" : ""}`}
                      title={account.mark_note ?? "已标记"}
                      aria-label={account.mark_note ? `标记：${account.mark_note}` : "已标记"}
                    >
                      <span className="markDot" aria-hidden="true" />
                      {account.mark_note ? <span className="markNote">{middleTruncate(account.mark_note, 16)}</span> : null}
                    </span>
                  ) : null}
                  <code>{formatCreatedDate(account.created_at)}</code>
                </span>
              </span>
            </button>
          ))}
    </section>
  );
}

function EditorDialog({
  dialog,
  busy,
  error,
  returnFocusElement,
  onChange,
  onClose,
  onConfirmDelete,
  onConfirmDeleteGroup,
  onConfirmPermanentDelete,
  groupOptions,
  onQuickGroup,
  onSubmit,
}: {
  dialog: DialogState;
  busy: boolean;
  error: string;
  returnFocusElement: HTMLElement | null;
  onChange: (next: DialogState | null) => void;
  onClose: () => void;
  onConfirmDelete: (account: Account) => void;
  onConfirmDeleteGroup: (groupLabel: string) => void;
  onConfirmPermanentDelete: (account: Account) => void;
  groupOptions: GroupOption[];
  onQuickGroup: (account: Account, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const modalRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    returnFocusElement ??
      (typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null),
  );
  const dialogTitleId = "cloak-editor-dialog-title";

  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      const modal = modalRef.current;
      if (!modal) return;

      if (event.key === "Escape") {
        if (busyRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = dialogFocusableElements(modal);
      if (focusable.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !modal.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !modal.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      const previous = previouslyFocusedRef.current;
      window.requestAnimationFrame(() => {
        if (!modalRef.current && previous?.isConnected) previous.focus();
      });
    };
  }, []);

  if (dialog.kind === "delete") {
    return (
      <div className="modalBackdrop">
        <div
          aria-labelledby={dialogTitleId}
          aria-modal="true"
          className="modal"
          ref={(node) => {
            modalRef.current = node;
          }}
          role="dialog"
          tabIndex={-1}
        >
          <button className="modalClose" type="button" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>
          <h2 id={dialogTitleId} title={`删除「${dialog.account.name}」？`}>
            删除「<span className="dialogAccountName">{middleTruncate(dialog.account.name, 28)}</span>」？
          </h2>
          <p>账号会移入回收站，可恢复；账号目录、登录数据和缓存会保留，不会立即释放磁盘。</p>
          {error ? <p className="modalError">{error}</p> : null}
          <div className="modalActions">
            <button autoFocus className="secondaryButton" disabled={busy} type="button" onClick={onClose}>
              取消
            </button>
            <button className="dangerButton" disabled={busy} type="button" onClick={() => onConfirmDelete(dialog.account)}>
              {busy ? "删除中..." : "删除"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (dialog.kind === "permanentDelete") {
    return (
      <div className="modalBackdrop">
        <div
          aria-labelledby={dialogTitleId}
          aria-modal="true"
          className="modal"
          ref={(node) => {
            modalRef.current = node;
          }}
          role="alertdialog"
          tabIndex={-1}
        >
          <button className="modalClose" type="button" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>
          <h2 id={dialogTitleId} title={`彻底删除「${dialog.account.name}」？`}>
            彻底删除「<span className="dialogAccountName">{middleTruncate(dialog.account.name, 28)}</span>」？
          </h2>
          <p>将永久删除该账号目录、登录数据和缓存。此操作不可恢复。</p>
          {error ? <p className="modalError">{error}</p> : null}
          <div className="modalActions">
            <button autoFocus className="secondaryButton" disabled={busy} type="button" onClick={onClose}>
              取消
            </button>
            <button className="dangerButton" disabled={busy} type="button" onClick={() => onConfirmPermanentDelete(dialog.account)}>
              {busy ? "删除中..." : "彻底删除"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (dialog.kind === "deleteGroup") {
    return (
      <div className="modalBackdrop">
        <div
          aria-labelledby={dialogTitleId}
          aria-modal="true"
          className="modal"
          ref={(node) => {
            modalRef.current = node;
          }}
          role="alertdialog"
          tabIndex={-1}
        >
          <button className="modalClose" type="button" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>
          <h2 id={dialogTitleId} title={`删除分组「${dialog.groupLabel}」？`}>
            删除分组「<span className="dialogAccountName">{middleTruncate(dialog.groupLabel, 28)}</span>」？
          </h2>
          <p>
            {dialog.count > 0
              ? `该分组下 ${dialog.count} 个账号会移到“未分组”，账号本身不会删除。`
              : "该空分组会从分组栏隐藏，账号本身不会删除。"}
          </p>
          {error ? <p className="modalError">{error}</p> : null}
          <div className="modalActions">
            <button autoFocus className="secondaryButton" disabled={busy} type="button" onClick={onClose}>
              取消
            </button>
            <button className="dangerButton" disabled={busy} type="button" onClick={() => onConfirmDeleteGroup(dialog.groupLabel)}>
              {busy ? "删除中..." : "删除分组"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const config = dialogConfig(dialog);
  const groupPicker =
    dialog.kind === "group" || dialog.kind === "create" ? (
      <div className="groupPicker" aria-label="可选分组">
        <span className="groupPickerLabel">分组</span>
        {groupOptions.map((option) => {
          const activeValue = dialog.kind === "create" ? dialog.group.trim() : dialog.value.trim();
          const isActive = option.value === activeValue || (!option.value && !activeValue);
          return (
            <button
              className={`groupOption ${isActive ? "active" : ""}`}
              disabled={busy}
              key={option.label}
              type="button"
              aria-pressed={isActive}
              onClick={() => {
                if (dialog.kind === "create") {
                  onChange({ ...dialog, group: option.value });
                  return;
                }
                onQuickGroup(dialog.account, option.value);
              }}
            >
              <Folder size={13} />
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    ) : null;
  return (
    <div className="modalBackdrop">
      <form
        aria-labelledby={dialogTitleId}
        aria-modal="true"
        className="modal"
        onSubmit={onSubmit}
        ref={(node) => {
          modalRef.current = node;
        }}
        role="dialog"
        tabIndex={-1}
      >
        <button className="modalClose" type="button" aria-label="关闭" onClick={onClose}>
          <X size={15} />
        </button>
        <h2 id={dialogTitleId}>{config.title}</h2>
        {config.description ? <p>{config.description}</p> : null}
        {dialog.kind === "group" ? groupPicker : null}
        <label className="field">
          <span>{config.label}</span>
          <input
            autoFocus
            maxLength={dialog.kind === "mark" ? 24 : undefined}
            value={dialog.value}
            placeholder={config.placeholder}
            onChange={(event) => onChange({ ...dialog, value: event.currentTarget.value })}
          />
        </label>
        {dialog.kind === "create" ? groupPicker : null}
        {error ? <p className="modalError">{error}</p> : null}
        <div className="modalActions">
          <button className="secondaryButton" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primaryButton" disabled={busy} type="submit">
            {config.action}
          </button>
        </div>
      </form>
    </div>
  );
}

function dialogConfig(
  dialog: Exclude<DialogState, { kind: "delete" } | { kind: "permanentDelete" } | { kind: "deleteGroup" }>,
): {
  title: string;
  label: string;
  placeholder: string;
  action: string;
  description?: string;
} {
  switch (dialog.kind) {
    case "create":
      return { title: "新建账号", label: "名称", placeholder: "work_01", action: "创建" };
    case "rename": {
      const accountName = middleTruncate(dialog.account.name, 28);
      return { title: `重命名「${accountName}」`, label: "新名称", placeholder: dialog.account.name, action: "保存" };
    }
    case "proxy": {
      const accountName = middleTruncate(dialog.account.name, 28);
      return {
        title: `代理「${accountName}」`,
        label: "代理地址",
        placeholder: "socks5://user:pass@host:1080",
        action: dialog.account.has_proxy ? "保存 / 清除" : "保存",
        description: dialog.account.has_proxy
          ? "现有代理已配置但不会回显。输入完整新地址可替换；留空并保存会清除当前代理。"
          : "支持 socks5://、http:// 和 https://。包含凭据时不会在账号详情中回显。",
      };
    }
    case "region": {
      const accountName = middleTruncate(dialog.account.name, 28);
      return { title: `区域「${accountName}」`, label: "区域代码", placeholder: "US / JP / Tokyo", action: dialog.account.region ? "保存 / 清除" : "保存" };
    }
    case "group": {
      const accountName = middleTruncate(dialog.account.name, 28);
      return { title: `分组「${accountName}」`, label: "分组名称", placeholder: "codex / antigravity / claude", action: dialog.account.group ? "保存 / 清除" : "保存" };
    }
    case "mark": {
      const accountName = middleTruncate(dialog.account.name, 28);
      return {
        title: `标记「${accountName}」`,
        label: "标记内容（可选，最多 24 个字符）",
        placeholder: "例如：待处理 / 备用 / 已验证",
        action: "保存标记",
        description: "不输入文字时只显示红色圆圈；输入后会显示在圆圈旁边。",
      };
    }
  }
}

function dialogFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="iconButton" type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  danger?: boolean;
}) {
  return (
    <button className={`actionButton ${danger ? "dangerText" : ""}`} type="button" onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function InspectorGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="inspectorGroup">
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}

function InfoRow({ icon, label, value, mono }: { icon?: ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="infoRow">
      <span className="infoLabel">
        {icon}
        {label}
      </span>
      <span className={`infoValue ${mono ? "mono" : ""}`} title={value}>
        {value}
      </span>
    </div>
  );
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (shouldUseMockTauri()) {
    return mockInvoke<T>(command, args);
  }
  return invoke<T>(command, args);
}

type AccountGroup = {
  label: string;
  accounts: Account[];
};

function orderAccounts(accounts: Account[], accountOrder: string[]): Account[] {
  const accountsByName = new Map(accounts.map((account) => [account.name, account]));
  return orderedAccountNames(accounts, accountOrder)
    .map((name) => accountsByName.get(name))
    .filter((account): account is Account => Boolean(account));
}

function orderedAccountNames(accounts: Account[], accountOrder: string[]): string[] {
  const known = new Set(accounts.map((account) => account.name));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of accountOrder) {
    if (!known.has(name) || seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }
  for (const account of accounts) {
    if (seen.has(account.name)) continue;
    seen.add(account.name);
    ordered.push(account.name);
  }
  return ordered;
}

function reorderAccountNames(
  currentOrder: string[],
  accounts: Account[],
  source: string,
  target: string,
  edge: AccountDropTarget["edge"],
): string[] {
  if (!source || source === target) return currentOrder;
  const names = orderedAccountNames(accounts, currentOrder).filter((name) => name !== source);
  const targetIndex = names.indexOf(target);
  if (targetIndex < 0) return currentOrder;
  names.splice(targetIndex + (edge === "after" ? 1 : 0), 0, source);
  return names;
}

function accountDropEdge(event: DragEvent<HTMLElement>): AccountDropTarget["edge"] {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before";
}

function groupAccounts(accounts: Account[]): AccountGroup[] {
  const groups: AccountGroup[] = [];
  const indexes = new Map<string, number>();
  for (const account of accounts) {
    const label = accountGroupLabel(account);
    const existing = indexes.get(label);
    if (existing === undefined) {
      indexes.set(label, groups.length);
      groups.push({ label, accounts: [account] });
    } else {
      groups[existing].accounts.push(account);
    }
  }
  return groups;
}

function buildGroupOptions(accounts: Account[], hiddenGroups: string[]): GroupOption[] {
  const options: GroupOption[] = [{ label: ungroupedLabel, value: "" }];
  const seen = new Set<string>([ungroupedLabel]);
  const hidden = new Set(hiddenGroups);
  for (const account of accounts) {
    const label = account.group?.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    options.push({ label, value: label });
  }
  for (const label of commonGroups) {
    if (seen.has(label) || hidden.has(label)) continue;
    seen.add(label);
    options.push({ label, value: label });
  }
  return options;
}

function orderAccountGroups(groups: AccountGroup[], groupOrder: string[]): AccountGroup[] {
  const labels = orderGroupLabels(
    groups.map((group) => group.label),
    groupOrder,
  );
  const groupsByLabel = new Map(groups.map((group) => [group.label, group]));
  return labels.map((label) => groupsByLabel.get(label)).filter((group): group is AccountGroup => Boolean(group));
}

function buildGroupFilters(accounts: Account[], groupOrder: string[], hiddenGroups: string[]): GroupFilter[] {
  const groups = groupAccounts(accounts);
  const counts = new Map(groups.map((group) => [group.label, group.accounts.length]));
  const hidden = new Set(hiddenGroups);
  for (const label of commonGroups) {
    if (!counts.has(label) && !hidden.has(label)) counts.set(label, 0);
  }
  const labels = orderGroupLabels([...counts.keys()], groupOrder);
  const filters: GroupFilter[] = [{ label: allGroupsLabel, value: allGroupsValue, count: accounts.length }];
  for (const label of labels) {
    filters.push({ label, value: label, count: counts.get(label) ?? 0 });
  }
  return filters;
}

function orderGroupLabels(labels: string[], groupOrder: string[]): string[] {
  const known = new Set(labels);
  const ordered = groupOrder.filter((label) => known.has(label));
  const remaining = labels.filter((label) => !ordered.includes(label));
  return [...ordered, ...remaining];
}

function reorderGroupLabels(currentOrder: string[], filters: GroupFilter[], source: string, target: string): string[] {
  if (!source || source === target || target === allGroupsLabel) return currentOrder;
  const labels = orderGroupLabels(
    filters.filter((group) => group.value !== allGroupsValue).map((group) => group.label),
    currentOrder,
  ).filter((label) => label !== source);
  const targetIndex = labels.indexOf(target);
  labels.splice(targetIndex >= 0 ? targetIndex : labels.length, 0, source);
  return labels;
}

function toggleStringInArray(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function readStoredStringArray(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function writeStoredStringArray(key: string, values: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Ignore storage failures; grouping still works for the current session.
  }
}

function readStoredNumber(key: string, fallback: number) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredNumber(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage failures; resizing still works for the current session.
  }
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function accountContextMenuHeight(optionCount: number, marked: boolean) {
  return Math.min(accountContextMenuMaxHeight, 70 + optionCount * 32 + 100 + (marked ? 32 : 0));
}

function placeContextMenu(x: number, y: number, width: number, height: number) {
  const maxX = Math.max(contextMenuViewportPadding, window.innerWidth - width - contextMenuViewportPadding);
  const maxY = Math.max(contextMenuViewportPadding, window.innerHeight - height - contextMenuViewportPadding);
  return {
    x: clampNumber(x, contextMenuViewportPadding, maxX),
    y: clampNumber(y, contextMenuViewportPadding, maxY),
  };
}

function accountGroupLabel(account: Account) {
  return account.group?.trim() || ungroupedLabel;
}

function shouldUseMockTauri() {
  return import.meta.env.DEV && !("__TAURI_INTERNALS__" in window);
}

async function mockInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, 80));
  const accounts = mockAccounts();
  if (command === "list_accounts") return accounts.filter((account) => !account.archived && !account.trashed) as T;
  if (command === "list_trashed_accounts") return accounts.filter((account) => account.trashed || account.archived) as T;
  if (command === "launch_dry_run" || command === "launch_preflight") {
    const name = String(args?.name ?? accounts[0].name);
    const account = accounts.find((item) => item.name === name) ?? accounts[0];
    return mockLaunchPlan(account, command === "launch_preflight") as T;
  }
  if (command === "create_account") {
    return {
      ...accounts[0],
      name: String(args?.name ?? "new"),
      created_at: Date.now() * 1000,
      archived: false,
      trashed: false,
      seed: "68122",
      group: (args?.group as string | null | undefined) ?? null,
      marked: false,
      mark_note: null,
    } as T;
  }
  if (command === "rename_account") return { ...accounts[0], name: String(args?.newName ?? "renamed") } as T;
  if (command === "restore_account") return { ...accounts[0], name: String(args?.name ?? accounts[0].name), archived: false, trashed: false } as T;
  if (command === "permanently_delete_account") return undefined as T;
  if (command === "set_group") {
    return { ...accounts[0], name: String(args?.name ?? accounts[0].name), group: (args?.value as string | null | undefined) ?? null } as T;
  }
  if (command === "set_mark") {
    const name = String(args?.name ?? accounts[0].name);
    const marked = Boolean(args?.marked);
    const note = (args?.note as string | null | undefined) ?? null;
    mockMarkOverrides.set(name, { marked, note });
    const account = accounts.find((item) => item.name === name) ?? accounts[0];
    return { ...account, name, marked, mark_note: marked ? note : null } as T;
  }
  if (command === "set_proxy" || command === "set_region" || command === "toggle_locale") return accounts[0] as T;
  return undefined as T;
}

function mockAccounts(): Account[] {
  const accounts: Account[] = [
    {
      name: "demo-alpha@example.test",
      profile_path: "/Users/example/Library/Application Support/NoTrace Browser/Accounts/demo-alpha@example.test",
      created_at: 1_700_000_001_000_000,
      archived: false,
      trashed: false,
      seed: "48366",
      group: "codex",
      marked: true,
      mark_note: null,
      region: null,
      locale_enabled: false,
      proxy_display: "关",
      has_proxy: false,
    },
    {
      name: "demo-beta",
      profile_path: "/Users/example/Library/Application Support/NoTrace Browser/Accounts/demo-beta",
      created_at: 1_700_000_002_000_000,
      archived: false,
      trashed: false,
      seed: "77296",
      group: "codex",
      marked: false,
      mark_note: null,
      region: "JP",
      locale_enabled: true,
      proxy_display: "关",
      has_proxy: false,
    },
    {
      name: "demo-gamma",
      profile_path: "/Users/example/Library/Application Support/NoTrace Browser/Accounts/demo-gamma",
      created_at: 1_700_000_003_000_000,
      archived: true,
      trashed: true,
      seed: "68098",
      group: "codex",
      marked: true,
      mark_note: "待检查",
      region: "US",
      locale_enabled: false,
      proxy_display: "socks5://proxy.example.net:1080（经本机 SOCKS5 中继）",
      has_proxy: true,
    },
    {
      name: "old-lab",
      profile_path: "/Users/example/Library/Application Support/NoTrace Browser/Accounts/old-lab",
      created_at: 1_700_000_004_000_000,
      archived: false,
      trashed: true,
      seed: "51024",
      group: null,
      marked: false,
      mark_note: null,
      region: "NL",
      locale_enabled: false,
      proxy_display: "关",
      has_proxy: false,
    },
  ];
  return accounts.map((account) => {
    const override = mockMarkOverrides.get(account.name);
    return override
      ? { ...account, marked: override.marked, mark_note: override.marked ? override.note : null }
      : account;
  });
}

function mockLaunchPlan(account: Account, full: boolean): LaunchPlan {
  return {
    account: account.name,
    seed: account.seed,
    profile_path: account.profile_path,
    extension_runtime_path: `${account.profile_path}/.cloak-companion`,
    load_extension_paths: [
      `${account.profile_path}/.cloak-companion`,
      "/Users/example/Library/Application Support/NoTrace Browser/Default Extensions/Chromium Web Store 插件",
      "/Users/example/Library/Application Support/NoTrace Browser/Default Extensions/get-cookies.txt-locally_v0.7.2_chrome",
      `${account.profile_path}/.cloak-extra-extensions/Cookies.crx`,
    ],
    extra_extension_paths: [
      "/Users/example/Library/Application Support/NoTrace Browser/Default Extensions/Chromium Web Store 插件",
      "/Users/example/Library/Application Support/NoTrace Browser/Default Extensions/get-cookies.txt-locally_v0.7.2_chrome",
      `${account.profile_path}/.cloak-extra-extensions/Cookies.crx`,
    ],
    selftest_extension_paths: [
      "/Users/example/Library/Application Support/NoTrace Browser/Default Extensions/get-cookies.txt-locally_v0.7.2_chrome",
      `${account.profile_path}/.cloak-extra-extensions/Cookies.crx`,
    ],
    browser_binary: "/Users/example/.cloakbrowser/current/Chromium.app/Contents/MacOS/Chromium",
    proxy: {
      mode: account.has_proxy ? "relay" : "none",
      display: account.proxy_display,
      browser_arg: account.has_proxy ? "socks5://127.0.0.1:<relay-port>" : null,
      relay_needed: account.has_proxy,
      raw_url: null,
    },
    geo: full
      ? { exit_ip: "45.92.159.252", country: account.region, timezone: account.region === "JP" ? "Asia/Tokyo" : "America/Los_Angeles" }
      : { exit_ip: null, country: null, timezone: null },
    locale: account.locale_enabled ? "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7" : null,
    argv: [
      `--user-data-dir=${account.profile_path}`,
      `--fingerprint=${account.seed}`,
      "--fingerprint-platform=macos",
      `--load-extension=${account.profile_path}/.cloak-companion`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "https://chatgpt.com/",
    ],
    privacy_failures: [],
  };
}

function middleTruncate(value: string, max: number) {
  if (value.length <= max) return value;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function formatCreatedAt(createdAtMicros: number) {
  if (!Number.isFinite(createdAtMicros) || createdAtMicros <= 0) return "未知";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Math.floor(createdAtMicros / 1000)));
}

function formatLaunchClock(launchedAtMicros: number) {
  if (!Number.isFinite(launchedAtMicros) || launchedAtMicros <= 0) return "未知时间";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(Math.floor(launchedAtMicros / 1000)));
}

function formatCreatedDate(createdAtMicros: number) {
  if (!Number.isFinite(createdAtMicros) || createdAtMicros <= 0) return "未知";
  const date = new Date(Math.floor(createdAtMicros / 1000));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extensionSummary(paths: string[]) {
  if (paths.length === 0) return "无";
  return paths.map(pathBaseName).join(" / ");
}

function pathBaseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function errorMessage(caught: unknown) {
  const raw = caught instanceof Error ? caught.message : String(caught);
  const alreadyExistsPrefix = "account already exists: ";
  const doesNotExistPrefix = "account does not exist: ";
  const runningPrefix = "account is running: ";
  const trashedPrefix = "account is in trash: ";
  const notTrashedPrefix = "account is not in trash: ";
  if (raw.startsWith(alreadyExistsPrefix)) {
    return `账号已存在：${raw.slice(alreadyExistsPrefix.length)}`;
  }
  if (raw.startsWith(doesNotExistPrefix)) {
    return `账号不存在：${raw.slice(doesNotExistPrefix.length)}`;
  }
  if (raw.startsWith(runningPrefix)) {
    return `账号正在运行：${raw.slice(runningPrefix.length)}。请先关闭这个浏览器窗口，再重命名、删除、恢复或彻底删除。`;
  }
  if (raw.startsWith(trashedPrefix)) {
    return `账号已在回收站：${raw.slice(trashedPrefix.length)}。请先恢复再启动。`;
  }
  if (raw.startsWith(notTrashedPrefix)) {
    return `账号不在回收站：${raw.slice(notTrashedPrefix.length)}。请先删除到回收站，再彻底删除。`;
  }
  if (raw.includes("account name is invalid")) {
    return "名字无效：可用字母、数字、.、@、+、-、_；不能叫 main，不能以 . 开头/结尾，不能含 /、\\ 或连续 ..。";
  }
  if (raw.includes("unsupported proxy URL")) {
    return "代理须以 socks5://、http:// 或 https:// 开头。";
  }
  if (raw.includes("account mark is invalid")) {
    return "标记内容无效：请使用不超过 24 个字符的单行文字。";
  }
  return raw;
}
