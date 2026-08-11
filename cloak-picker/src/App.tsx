import { invoke } from "@tauri-apps/api/core";
import {
  ArchiveRestore,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  GripVertical,
  Globe2,
  KeyRound,
  Loader2,
  MessageSquareText,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Store,
  Tag,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

const markColorValues = ["green", "blue", "red"] as const;
type MarkColor = (typeof markColorValues)[number];

type Account = {
  name: string;
  profile_path: string;
  created_at: number;
  deleted_at: number | null;
  archived: boolean;
  trashed: boolean;
  seed: string;
  group: string | null;
  marked: boolean;
  mark_note: string | null;
  mark_color: MarkColor | null;
  note: string | null;
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
  engine_major: string;
  engine_version: string;
  proxy: {
    mode: "none" | "direct" | "relay";
    display: string;
    browser_arg: string | null;
    relay_needed: boolean;
  };
  geo: {
    exit_ip: string | null;
    country: string | null;
    timezone: string | null;
  };
  geo_cache_hit: boolean;
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
  diagnostics: {
    engine_major: string;
    engine_version: string;
    proxy_mode: "none" | "direct" | "relay";
    proxy_display: string;
    exit_ip: string | null;
    country: string | null;
    timezone: string | null;
    geo_cache_hit: boolean;
    preflight_ms: number;
    launch_ms: number;
    capabilities: string[];
  };
};

type LaunchStatus = {
  accountName: string;
  target: "chatgpt" | "web-store";
  phase: "checking" | "starting" | "cancelling" | "cancelled" | "opened" | "failed";
  startedAt: number;
  result?: LaunchResult;
};

type ChallengeAuditResult = {
  passed: boolean;
  cancelled?: boolean;
  duration_ms: number;
  browser_sha256: string;
  error: string | null;
  results: Array<{
    name: string;
    passed: boolean;
    details?: {
      issues?: string[];
      challenge?: {
        detected?: boolean;
        blocked?: boolean;
        kind?: string | null;
      };
      apiLoaded?: boolean;
      widgetCompleted?: boolean;
      serverValidation?: { success?: boolean };
    };
    error?: string;
  }>;
};

type ChallengeAuditStatus = {
  phase: "running" | "passed" | "failed" | "cancelled";
  result?: ChallengeAuditResult;
  error?: string;
};

type DialogState =
  | { kind: "create"; value: string; group: string }
  | { kind: "createGroup"; value: string; returnToManage?: boolean }
  | { kind: "rename"; account: Account; value: string }
  | { kind: "renameGroup"; groupLabel: string; count: number; value: string; returnToManage?: boolean }
  | { kind: "manage"; section: "groups" | "marks" }
  | { kind: "proxy"; account: Account; value: string }
  | { kind: "region"; account: Account; value: string }
  | { kind: "group"; account: Account; value: string }
  | { kind: "mark"; account: Account; value: string; color: MarkColor }
  | { kind: "note"; account: Account; value: string }
  | { kind: "delete"; account: Account }
  | { kind: "permanentDelete"; account: Account }
  | { kind: "deleteGroup"; groupLabel: string; count: number; returnToManage?: boolean };

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

type GroupDropTarget = {
  label: string;
  edge: "before" | "after";
};

type GroupPointerDrag = {
  label: string;
  pointerId: number;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  width: number;
  height: number;
  active: boolean;
  initialOrder: string[];
  captureElement: HTMLElement;
};

type AccountPointerDrag = {
  accountName: string;
  sourceGroup: string;
  pointerId: number;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  width: number;
  height: number;
  active: boolean;
  captureElement: HTMLButtonElement;
};

const contextMenuWidth = 140;
const contextMenuHeight = 68;
const accountContextMenuWidth = 184;
const accountContextMenuMaxHeight = 320;
const contextMenuViewportPadding = 8;
const groupDragActivationDistance = 8;
const groupDragAutoScrollEdge = 24;
const groupDragAutoScrollStep = 9;
const accountDragActivationDistance = 8;
const accountDragAutoScrollEdge = 44;
const accountDragAutoScrollStep = 14;

const emptyAccounts: Account[] = [];
const mockMarkOverrides = new Map<string, { marked: boolean; note: string | null; color: MarkColor | null }>();
const mockNoteOverrides = new Map<string, string | null>();
const mockGroupOverrides = new Map<string, string | null>();
const mockCommandCounts = new Map<string, number>();
const mockCommandFailures = new Map<string, number>();
const mockCancelledLaunches = new Set<string>();
let mockChallengeAuditCancelled = false;

export function resetMockCommandsForTest() {
  mockMarkOverrides.clear();
  mockNoteOverrides.clear();
  mockGroupOverrides.clear();
  mockCommandCounts.clear();
  mockCommandFailures.clear();
  mockCancelledLaunches.clear();
  mockChallengeAuditCancelled = false;
}

export function mockCommandCountForTest(command: string) {
  return mockCommandCounts.get(command) ?? 0;
}

export function failNextMockCommandForTest(command: string) {
  mockCommandFailures.set(command, (mockCommandFailures.get(command) ?? 0) + 1);
}

export function cancelNextMockChallengeAuditForTest() {
  mockChallengeAuditCancelled = true;
}

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
const legacyMarkPresetsStorageKey = "cloak-picker.markPresets.v1";
const colorAwareMarkPresetsStorageKey = "cloak-picker.markPresets.v2";
const markPresetsStorageKey = "cloak-picker.markPresets.v3";
const defaultMarkPresets = ["Plus", "自用"] as const;
const maxMarkLength = 24;
const maxNoteLength = 1000;
const maxGroupLength = 40;
const defaultSidebarWidth = 326;
const minSidebarWidth = 260;
const minDetailWidth = 360;
const paneResizerWidth = 8;

type MarkColorDefinition = {
  label: string;
  solid: string;
  text: string;
  background: string;
  strongBackground: string;
  border: string;
  ring: string;
};

const markColorDefinitions: Record<MarkColor, MarkColorDefinition> = {
  green: {
    label: "绿色",
    solid: "#1a8f4b",
    text: "#13713b",
    background: "#edf9f1",
    strongBackground: "#ddf3e5",
    border: "#a8dbb9",
    ring: "rgba(26, 143, 75, 0.16)",
  },
  blue: {
    label: "蓝色",
    solid: "#0071e3",
    text: "#005fc2",
    background: "#eef6ff",
    strongBackground: "#dcecff",
    border: "#a9cdf3",
    ring: "rgba(0, 113, 227, 0.16)",
  },
  red: {
    label: "红色",
    solid: "#e02b20",
    text: "#b42318",
    background: "#fff2f1",
    strongBackground: "#ffe7e5",
    border: "#f2b9b4",
    ring: "rgba(217, 45, 32, 0.16)",
  },
};

type MarkColorStyle = CSSProperties & {
  "--mark-solid": string;
  "--mark-text": string;
  "--mark-bg": string;
  "--mark-bg-strong": string;
  "--mark-border": string;
  "--mark-ring": string;
};

function markColorStyle(value: unknown): MarkColorStyle {
  const definition = markColorDefinitions[normalizeMarkColor(value)];
  return {
    "--mark-solid": definition.solid,
    "--mark-text": definition.text,
    "--mark-bg": definition.background,
    "--mark-bg-strong": definition.strongBackground,
    "--mark-border": definition.border,
    "--mark-ring": definition.ring,
  };
}

function parseMarkColor(value: unknown): MarkColor | null {
  return typeof value === "string" && markColorValues.includes(value as MarkColor)
    ? (value as MarkColor)
    : null;
}

function normalizeMarkColor(value: unknown): MarkColor {
  return parseMarkColor(value) ?? "green";
}

function markColorLabel(value: unknown): string {
  return markColorDefinitions[normalizeMarkColor(value)].label;
}

type GroupOption = {
  label: string;
  value: string;
};

type GroupFilter = GroupOption & {
  count: number;
};

type ManagedGroup = {
  label: string;
  count: number;
};

export default function App() {
  const [activeAccounts, setActiveAccounts] = useState<Account[]>(emptyAccounts);
  const [trashedAccounts, setTrashedAccounts] = useState<Account[]>(emptyAccounts);
  const [accountView, setAccountView] = useState<AccountView>("active");
  const [selectedName, setSelectedName] = useState<string>("");
  const [selectedGroup, setSelectedGroup] = useState<string>(allGroupsValue);
  const [accountSearch, setAccountSearch] = useState("");
  const [draggingAccountName, setDraggingAccountName] = useState<string>("");
  const [pressedAccountName, setPressedAccountName] = useState<string>("");
  const [accountDropTarget, setAccountDropTarget] = useState<AccountDropTarget | null>(null);
  const [accountDropGroup, setAccountDropGroup] = useState("");
  const [accountReorderAnnouncement, setAccountReorderAnnouncement] = useState("");
  const [pressedGroupLabel, setPressedGroupLabel] = useState("");
  const [draggingGroupLabel, setDraggingGroupLabel] = useState<string>("");
  const [groupDropTarget, setGroupDropTarget] = useState<GroupDropTarget | null>(null);
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
  const [launchStatus, setLaunchStatus] = useState<LaunchStatus | null>(null);
  const [challengeAudit, setChallengeAudit] = useState<ChallengeAuditStatus | null>(null);
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
  // Kept apart from `error`, which auto-dismisses after five seconds: a failed
  // list load has to stay on screen because it changes what the list means.
  const [loadError, setLoadError] = useState<string>("");
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [manageMenuOpen, setManageMenuOpen] = useState(false);
  const [groupContextMenu, setGroupContextMenu] = useState<GroupContextMenuState | null>(null);
  const [accountContextMenu, setAccountContextMenu] = useState<AccountContextMenuState | null>(null);
  const groupPointerDragRef = useRef<GroupPointerDrag | null>(null);
  const groupDropTargetRef = useRef<GroupDropTarget | null>(null);
  const groupDragPreviewRef = useRef<HTMLDivElement | null>(null);
  const groupDragFrameRef = useRef<number | null>(null);
  const groupDragSuppressClickRef = useRef(false);
  const groupFilterPositionsRef = useRef<Map<string, { left: number; top: number }>>(new Map());
  const groupFilterAnimationsRef = useRef<Map<string, Animation>>(new Map());
  const accountPointerDragRef = useRef<AccountPointerDrag | null>(null);
  const accountDropTargetRef = useRef<AccountDropTarget | null>(null);
  const accountDropTargetGroupRef = useRef("");
  const accountDragPreviewRef = useRef<HTMLDivElement | null>(null);
  const accountDragFrameRef = useRef<number | null>(null);
  const accountDragSuppressClickRef = useRef(false);
  const accountRowPositionsRef = useRef<Map<string, number>>(new Map());
  const accountRowAnimationsRef = useRef<Map<string, Animation>>(new Map());
  const workspaceRef = useRef<HTMLElement | null>(null);
  const groupFilterRef = useRef<HTMLDivElement | null>(null);
  const accountListRef = useRef<HTMLDivElement | null>(null);
  const resizingPaneRef = useRef(false);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const manageButtonRef = useRef<HTMLButtonElement | null>(null);
  const markSaveInFlightRef = useRef(false);
  const noteSaveInFlightRef = useRef(false);

  const accounts = accountView === "trash" ? trashedAccounts : activeAccounts;
  const allAccounts = useMemo(
    () => [...activeAccounts, ...trashedAccounts].sort(compareAccountsByCreatedAt),
    [activeAccounts, trashedAccounts],
  );
  const orderedAccounts = useMemo(
    () => orderAccountsForView(accounts, accountOrder, accountView),
    [accountOrder, accountView, accounts],
  );
  const allOrderedAccounts = useMemo(() => orderAccounts(allAccounts, accountOrder), [allAccounts, accountOrder]);
  const normalizedAccountSearch = normalizeAccountSearch(accountSearch);
  const hasAccountSearch = normalizedAccountSearch.length > 0;
  const accountSearchMatches = useMemo(
    () =>
      hasAccountSearch
        ? searchAccounts(allOrderedAccounts, normalizedAccountSearch)
        : [],
    [allOrderedAccounts, hasAccountSearch, normalizedAccountSearch],
  );
  const selectedAccountSearchIndex = accountSearchMatches.findIndex((account) => account.name === selectedName);
  const accountSearchIndex = selectedAccountSearchIndex >= 0 ? selectedAccountSearchIndex : 0;
  const accountSearchMatch = accountSearchMatches[accountSearchIndex] ?? null;
  const groupFilters = useMemo(
    () => buildGroupFilters(accounts, groupOrder, hiddenGroups),
    [accounts, groupOrder, hiddenGroups],
  );
  const browsedAccounts = useMemo(
    () =>
      selectedGroup === allGroupsValue
        ? orderedAccounts
        : orderedAccounts.filter((account) => accountGroupLabel(account) === selectedGroup),
    [orderedAccounts, selectedGroup],
  );
  const visibleAccounts = browsedAccounts;
  const selected = useMemo(
    () => visibleAccounts.find((account) => account.name === selectedName) ?? visibleAccounts[0] ?? null,
    [visibleAccounts, selectedName],
  );
  // Async handlers close over a stale `selected`; this ref always holds whoever
  // is on screen when a slow call finally resolves.
  const selectedNameRef = useRef<string>("");
  selectedNameRef.current = selected?.name ?? "";
  const launchInFlightRef = useRef<Set<string>>(new Set());
  const groupedAccounts = useMemo(() => {
    if (accountView === "trash") {
      return visibleAccounts.length > 0
        ? [{ label: "回收站", accounts: visibleAccounts }]
        : [];
    }
    return orderAccountGroups(groupAccounts(visibleAccounts), groupOrder);
  }, [accountView, groupOrder, visibleAccounts]);
  const groupOptions = useMemo(
    () => buildGroupOptions(accounts, groupOrder, hiddenGroups),
    [accounts, groupOrder, hiddenGroups],
  );
  const managedGroups = useMemo(
    () => buildManagedGroups(activeAccounts, trashedAccounts, groupOrder, hiddenGroups),
    [activeAccounts, groupOrder, hiddenGroups, trashedAccounts],
  );

  async function refresh(preferredName?: string, view: AccountView = accountView) {
    setError("");
    let nextActiveAccounts: Account[];
    let nextTrashedAccounts: Account[];
    try {
      [nextActiveAccounts, nextTrashedAccounts] = await Promise.all([
        call<Account[]>("list_accounts"),
        call<Account[]>("list_trashed_accounts"),
      ]);
    } catch (caught) {
      // Callers await refresh() outside run(), so an unhandled rejection here
      // used to leave a silently stale list with no message at all.
      setLoadError(errorMessage(caught));
      return;
    }
    setLoadError("");
    setActiveAccounts(nextActiveAccounts);
    setTrashedAccounts(nextTrashedAccounts);
    const nextViewAccounts = view === "trash" ? nextTrashedAccounts : nextActiveAccounts;
    const selectionPool = nextViewAccounts;
    const orderedNext = orderAccountsForView(selectionPool, accountOrder, view);
    setSelectedName((current) => {
      if (preferredName && selectionPool.some((account) => account.name === preferredName)) return preferredName;
      if (current && selectionPool.some((account) => account.name === current)) return current;
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

  function handleAccountSearchChange(value: string) {
    setAccountSearch(value);
    const normalizedSearch = normalizeAccountSearch(value);
    if (!normalizedSearch) return;

    setSelectedGroup(allGroupsValue);
    const match = searchAccounts(allOrderedAccounts, normalizedSearch)[0] ?? null;
    if (!match) return;

    const matchingGroup = accountGroupLabel(match);
    setAccountView(match.trashed ? "trash" : "active");
    setCollapsedGroups((current) =>
      current.includes(matchingGroup) ? current.filter((label) => label !== matchingGroup) : current,
    );
    setSelectedName(match.name);
  }

  function moveAccountSearchMatch(offset: number) {
    if (accountSearchMatches.length < 2) return;
    const nextIndex = (accountSearchIndex + offset + accountSearchMatches.length) % accountSearchMatches.length;
    const match = accountSearchMatches[nextIndex];
    const matchingGroup = accountGroupLabel(match);
    setSelectedGroup(allGroupsValue);
    setAccountView(match.trashed ? "trash" : "active");
    setCollapsedGroups((current) =>
      current.includes(matchingGroup) ? current.filter((label) => label !== matchingGroup) : current,
    );
    setSelectedName(match.name);
  }

  function handleAccountSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setAccountSearch("");
      event.currentTarget.blur();
      return;
    }
    if (event.key === "ArrowDown" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      moveAccountSearchMatch(1);
      return;
    }
    if (event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey)) {
      event.preventDefault();
      moveAccountSearchMatch(-1);
    }
  }

  function handleAccountViewChange(view: AccountView) {
    setAccountSearch("");
    setAccountView(view);
  }

  function handleAccountSelection(name: string) {
    if (accountDragSuppressClickRef.current) return;
    setAccountSearch("");
    setSelectedName(name);
  }

  useEffect(() => {
    void run(() => refresh(undefined, "active"));
  }, []);

  useEffect(() => {
    if (selectedGroup === allGroupsValue) return;
    if (!groupFilters.some((group) => group.value === selectedGroup)) {
      setSelectedGroup(allGroupsValue);
    }
  }, [groupFilters, selectedGroup]);

  useEffect(() => {
    if (!hasAccountSearch) return;
    if (selectedGroup !== allGroupsValue) setSelectedGroup(allGroupsValue);
    if (!accountSearchMatch) return;
    const matchingGroup = accountGroupLabel(accountSearchMatch);
    const matchingView = accountSearchMatch.trashed ? "trash" : "active";
    if (accountView !== matchingView) setAccountView(matchingView);
    setCollapsedGroups((current) =>
      current.includes(matchingGroup) ? current.filter((label) => label !== matchingGroup) : current,
    );
    if (selectedName !== accountSearchMatch.name) setSelectedName(accountSearchMatch.name);
  }, [
    accountSearchMatch?.group,
    accountSearchMatch?.name,
    accountSearchMatch?.trashed,
    accountView,
    hasAccountSearch,
    selectedGroup,
    selectedName,
  ]);

  useEffect(() => {
    if (!accountSearchMatch || selected?.name !== accountSearchMatch.name) return;
    const frame = window.requestAnimationFrame(() => {
      accountListRef.current
        ?.querySelector<HTMLElement>(".accountRow.selected")
        ?.scrollIntoView?.({ block: "center", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [accountSearchMatch?.name, accountView, collapsedGroups, selected?.name, selectedGroup]);

  useEffect(() => {
    writeStoredStringArray(groupOrderStorageKey, groupOrder);
  }, [groupOrder]);

  useLayoutEffect(() => {
    const previousPositions = groupFilterPositionsRef.current;
    groupFilterPositionsRef.current = new Map();
    if (previousPositions.size === 0) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const groups = groupFilterRef.current?.querySelectorAll<HTMLElement>(".groupFilterButton[data-group-label]");
    groups?.forEach((group) => {
      const label = group.dataset.groupLabel ?? "";
      if (!label || label === draggingGroupLabel || typeof group.animate !== "function") return;
      const previous = previousPositions.get(label);
      if (!previous) return;
      const bounds = group.getBoundingClientRect();
      const deltaX = previous.left - bounds.left;
      const deltaY = previous.top - bounds.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
      const animation = group.animate(
        [{ transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      groupFilterAnimationsRef.current.set(label, animation);
      animation.addEventListener("finish", () => {
        if (groupFilterAnimationsRef.current.get(label) === animation) {
          groupFilterAnimationsRef.current.delete(label);
        }
      }, { once: true });
    });
  }, [draggingGroupLabel, groupOrder]);

  useEffect(() => {
    writeStoredStringArray(accountOrderStorageKey, accountOrder);
  }, [accountOrder]);

  useLayoutEffect(() => {
    const previousPositions = accountRowPositionsRef.current;
    accountRowPositionsRef.current = new Map();
    if (!draggingAccountName || previousPositions.size === 0) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const rows = accountListRef.current?.querySelectorAll<HTMLElement>(".accountRow[data-account-name]");
    rows?.forEach((row) => {
      const name = row.dataset.accountName ?? "";
      if (!name || name === draggingAccountName || typeof row.animate !== "function") return;
      const previousTop = previousPositions.get(name);
      if (previousTop === undefined) return;
      const deltaY = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 0.5) return;
      const animation = row.animate(
        [{ transform: `translate3d(0, ${deltaY}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration: 170, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      accountRowAnimationsRef.current.set(name, animation);
      animation.addEventListener("finish", () => {
        if (accountRowAnimationsRef.current.get(name) === animation) {
          accountRowAnimationsRef.current.delete(name);
        }
      }, { once: true });
    });
  }, [accountDropGroup, accountDropTarget, draggingAccountName]);

  useEffect(() => {
    if (!draggingAccountName) return;
    scheduleAccountDragPreview();
    function cancelOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelAccountPointerDrag();
    }
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [draggingAccountName]);

  useEffect(() => {
    if (!draggingGroupLabel) return;
    scheduleGroupDragPreview();
    function cancelOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelGroupPointerDrag();
    }
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [draggingGroupLabel]);

  useEffect(() => () => {
    if (groupDragFrameRef.current !== null) {
      window.cancelAnimationFrame(groupDragFrameRef.current);
    }
    const drag = groupPointerDragRef.current;
    if (drag?.captureElement.hasPointerCapture(drag.pointerId)) {
      drag.captureElement.releasePointerCapture(drag.pointerId);
    }
    groupFilterAnimationsRef.current.forEach((animation) => animation.cancel());
    groupFilterAnimationsRef.current.clear();
    groupPointerDragRef.current = null;
  }, []);

  useEffect(() => () => {
    if (accountDragFrameRef.current !== null) {
      window.cancelAnimationFrame(accountDragFrameRef.current);
    }
    const drag = accountPointerDragRef.current;
    if (drag?.captureElement.hasPointerCapture(drag.pointerId)) {
      drag.captureElement.releasePointerCapture(drag.pointerId);
    }
    accountRowAnimationsRef.current.forEach((animation) => animation.cancel());
    accountRowAnimationsRef.current.clear();
    accountPointerDragRef.current = null;
  }, []);

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
    if (!groupContextMenu && !accountContextMenu && !manageMenuOpen) return;
    const close = () => {
      setGroupContextMenu(null);
      setAccountContextMenu(null);
      setManageMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [accountContextMenu, groupContextMenu, manageMenuOpen]);

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
    // Clear first: the panel is already titled with the new account, so keeping
    // the previous plan would show one identity's seed, exit IP and profile path
    // under another account's name until the call returns.
    setPlan(null);
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

    if (dialog.kind === "manage") return;

    const value = dialog.value.trim();
    if (dialog.kind === "createGroup") {
      if (createStandaloneGroup(value)) {
        setDialog(dialog.returnToManage ? { kind: "manage", section: "groups" } : null);
      }
      return;
    }

    if (dialog.kind === "renameGroup") {
      await renameGroup(dialog.groupLabel, value, dialog.returnToManage);
      return;
    }

    if (dialog.kind === "create") {
      if (!value) {
        setDialogError("请输入账号名称。");
        document.getElementById("cloak-account-name")?.focus();
        return;
      }
      const group = dialog.group.trim() || null;
      const account = await run(() => call<Account>("create_account", { name: value, group }));
      if (account) {
        setAccountOrder((current) => [
          account.name,
          ...mergedAccountOrder(current, accounts).filter((name) => name !== account.name),
        ]);
        if (group) {
          setHiddenGroups((current) => current.filter((label) => label !== group));
          setGroupOrder((current) => appendNewGroup(current, groupFilters, group));
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

    if (dialog.kind === "note") {
      await saveAccountNote(dialog.account, value);
      return;
    }

    if (dialog.kind === "mark") {
      await saveAccountMark(dialog.account, value, dialog.color);
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
    // Any failed action writes dialogError, so without this reset a brand new
    // dialog opens already showing the previous action's error.
    setDialogError("");
    setDialog(next);
  }

  async function saveAccountMark(account: Account, rawValue: string, color: MarkColor) {
    if (markSaveInFlightRef.current) return;
    const value = rawValue.trim();
    const currentNote = account.mark_note?.trim() || "";
    if (account.marked && value === currentNote && color === normalizeMarkColor(account.mark_color)) {
      setDialog(null);
      return;
    }

    markSaveInFlightRef.current = true;
    try {
      const updated = await run(() =>
        call<Account>("set_mark", {
          name: account.name,
          marked: true,
          note: value || null,
          color,
        }),
      );
      if (updated) {
        setDialog(null);
        await refresh(updated.name);
      }
    } finally {
      markSaveInFlightRef.current = false;
    }
  }

  async function saveAccountNote(account: Account, rawValue: string) {
    if (noteSaveInFlightRef.current) return;
    const value = rawValue.trim();
    if (value === (account.note?.trim() || "")) {
      setDialog(null);
      return;
    }

    noteSaveInFlightRef.current = true;
    try {
      const updated = await run(() =>
        call<Account>("set_note", {
          name: account.name,
          value: value || null,
        }),
      );
      if (updated) {
        setDialog(null);
        await refresh(updated.name);
      }
    } finally {
      noteSaveInFlightRef.current = false;
    }
  }

  function openCreateDialog(trigger?: HTMLElement | null) {
    setError("");
    setDialogError("");
    openDialog({ kind: "create", value: "", group: defaultCreateGroupValue() }, trigger);
  }

  function openManageDialog(section: "groups" | "marks", trigger?: HTMLElement | null) {
    setManageMenuOpen(false);
    setGroupContextMenu(null);
    setAccountContextMenu(null);
    openDialog({ kind: "manage", section }, trigger ?? manageButtonRef.current);
  }

  function defaultCreateGroupValue() {
    if (accountView !== "active" || selectedGroup === allGroupsValue) return "";
    return selectedGroup === ungroupedLabel ? "" : selectedGroup;
  }

  function createStandaloneGroup(rawValue: string): boolean {
    const value = rawValue.trim();
    const validationError = groupNameError(value);
    if (validationError) {
      setDialogError(validationError);
      return false;
    }
    if (managedGroups.some((group) => group.label === value)) {
      setDialogError(`分组“${value}”已经存在。`);
      return false;
    }
    setHiddenGroups((current) => current.filter((label) => label !== value));
    setGroupOrder((current) => appendNewGroup(current, groupFilters, value));
    setAccountView("active");
    setSelectedGroup(value);
    setDialogError("");
    return true;
  }

  async function renameGroup(groupLabel: string, rawValue: string, returnToManage = false) {
    const value = rawValue.trim();
    if (value === groupLabel) {
      setDialog(returnToManage ? { kind: "manage", section: "groups" } : null);
      return;
    }
    const validationError = groupNameError(value);
    if (validationError) {
      setDialogError(validationError);
      return;
    }
    if (managedGroups.some((group) => group.label === value && group.label !== groupLabel)) {
      setDialogError(`分组“${value}”已经存在，请换一个名称。`);
      return;
    }

    setBusy(true);
    setError("");
    setDialogError("");
    try {
      const [freshActiveAccounts, freshTrashedAccounts] = await Promise.all([
        call<Account[]>("list_accounts"),
        call<Account[]>("list_trashed_accounts"),
      ]);
      const accountsToRename = [...freshActiveAccounts, ...freshTrashedAccounts].filter(
        (account) => accountGroupLabel(account) === groupLabel,
      );
      const renamedAccounts: Account[] = [];
      try {
        for (const account of accountsToRename) {
          await call<Account>("set_group", { name: account.name, value });
          renamedAccounts.push(account);
        }
      } catch (caught) {
        const rollback = await Promise.allSettled(
          renamedAccounts.map((account) =>
            call<Account>("set_group", { name: account.name, value: groupLabel }),
          ),
        );
        if (rollback.some((result) => result.status === "rejected")) {
          throw new Error(`${errorMessage(caught)}；部分账号回滚失败，请刷新后重试。`);
        }
        throw caught;
      }

      setGroupOrder((current) => renameGroupInOrder(
        current,
        managedGroups.map((group) => group.label),
        groupLabel,
        value,
      ));
      setHiddenGroups((current) => {
        const next = current.filter((label) => label !== groupLabel && label !== value);
        return [...next, groupLabel];
      });
      setCollapsedGroups((current) => renameStringInArray(current, groupLabel, value));
      if (selectedGroup === groupLabel) setSelectedGroup(value);
      setDialog(returnToManage ? { kind: "manage", section: "groups" } : null);
      await refresh(selectedName, accountView);
    } catch (caught) {
      const message = errorMessage(caught);
      setDialogError(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function assignAccountGroup(account: Account, value: string | null, closeDialog: boolean): Promise<boolean> {
    const nextGroup = value?.trim() || null;
    const currentGroup = account.group?.trim() || null;
    if (currentGroup === nextGroup) {
      if (closeDialog) setDialog(null);
      return true;
    }

    const updated = await run(() =>
      call<Account>("set_group", {
        name: account.name,
        value: nextGroup,
      }),
    );
    if (!updated) return false;
    if (nextGroup) {
      setHiddenGroups((current) => current.filter((label) => label !== nextGroup));
      setGroupOrder((current) => appendNewGroup(current, groupFilters, nextGroup));
    }
    if (closeDialog) setDialog(null);
    await refresh(updated.name);
    return true;
  }

  function captureAccountRowPositions() {
    const rows = accountListRef.current?.querySelectorAll<HTMLElement>(".accountRow[data-account-name]");
    const positions = new Map<string, number>();
    rows?.forEach((row) => {
      const name = row.dataset.accountName ?? "";
      if (name) positions.set(name, row.getBoundingClientRect().top);
    });
    accountRowAnimationsRef.current.forEach((animation) => animation.cancel());
    accountRowAnimationsRef.current.clear();
    accountRowPositionsRef.current = positions;
  }

  function updateAccountDropDestination(
    target: AccountDropTarget | null,
    groupLabel: string,
    animateLayout = true,
  ) {
    const currentTarget = accountDropTargetRef.current;
    if (
      currentTarget?.name === target?.name
      && currentTarget?.edge === target?.edge
      && accountDropTargetGroupRef.current === groupLabel
    ) {
      return;
    }
    if (animateLayout) captureAccountRowPositions();
    accountDropTargetRef.current = target;
    accountDropTargetGroupRef.current = groupLabel;
    setAccountDropGroup((current) => (current === groupLabel ? current : groupLabel));
    setAccountDropTarget((current) =>
      current?.name === target?.name && current?.edge === target?.edge ? current : target,
    );
    const sourceGroup = accountPointerDragRef.current?.sourceGroup ?? "";
    const highlightedGroup = groupLabel && groupLabel !== sourceGroup ? groupLabel : "";
    setDropTargetGroup((current) => (current === highlightedGroup ? current : highlightedGroup));
  }

  function scheduleAccountDragPreview() {
    if (accountDragFrameRef.current !== null) return;
    accountDragFrameRef.current = window.requestAnimationFrame(() => {
      accountDragFrameRef.current = null;
      const drag = accountPointerDragRef.current;
      const preview = accountDragPreviewRef.current;
      if (!drag?.active) return;
      scrollAccountListForPointer(drag.latestY);
      updateAccountPointerDestination(drag.latestX, drag.latestY, drag);
      if (!preview) return;
      const x = Math.round(drag.latestX - drag.grabOffsetX);
      const y = Math.round(drag.latestY - drag.grabOffsetY);
      preview.style.transform = `translate3d(${x}px, ${y}px, 0) scale(var(--account-drag-scale, 1.012))`;
    });
  }

  function startAccountPointerDrag(event: PointerEvent<HTMLButtonElement>, account: Account) {
    if (account.trashed || event.button !== 0 || event.isPrimary === false) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".dragHandle")) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    accountPointerDragRef.current = {
      accountName: account.name,
      sourceGroup: accountGroupLabel(account),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      grabOffsetX: event.clientX - bounds.left,
      grabOffsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
      active: false,
      captureElement: event.currentTarget,
    };
    updateAccountDropDestination(null, "", false);
    setPressedAccountName(account.name);
    setSelectedName(account.name);
  }

  function scrollAccountListForPointer(clientY: number) {
    const list = accountListRef.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    if (clientY < bounds.top - 12 || clientY > bounds.bottom + 12) return;
    if (clientY < bounds.top + accountDragAutoScrollEdge) {
      const strength = 1 - Math.max(clientY - bounds.top, 0) / accountDragAutoScrollEdge;
      list.scrollTop -= Math.ceil(accountDragAutoScrollStep * strength);
    } else if (clientY > bounds.bottom - accountDragAutoScrollEdge) {
      const strength = 1 - Math.max(bounds.bottom - clientY, 0) / accountDragAutoScrollEdge;
      list.scrollTop += Math.ceil(accountDragAutoScrollStep * strength);
    }
  }

  function updateAccountPointerDestination(clientX: number, clientY: number, source: AccountPointerDrag) {
    const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const groupFilter = hit?.closest<HTMLElement>("[data-group-label]");
    const filterGroup = groupFilter?.dataset.groupLabel ?? "";
    if (filterGroup) {
      updateAccountDropDestination(null, filterGroup);
      return;
    }

    let groupElement = hit?.closest<HTMLElement>(".accountGroup[data-account-group]") ?? null;
    if (!groupElement) {
      const list = accountListRef.current;
      const listBounds = list?.getBoundingClientRect();
      if (
        list
        && listBounds
        && clientX >= listBounds.left
        && clientX <= listBounds.right
        && clientY >= listBounds.top
        && clientY <= listBounds.bottom
      ) {
        let nearestDistance = Number.POSITIVE_INFINITY;
        list.querySelectorAll<HTMLElement>(".accountGroup[data-account-group]").forEach((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          const distance = clientY < bounds.top
            ? bounds.top - clientY
            : clientY > bounds.bottom
              ? clientY - bounds.bottom
              : 0;
          if (distance < nearestDistance) {
            nearestDistance = distance;
            groupElement = candidate;
          }
        });
      }
    }

    const targetGroup = groupElement?.dataset.accountGroup ?? "";
    if (!groupElement || !targetGroup) {
      updateAccountDropDestination(null, "");
      return;
    }

    const rows = Array.from(
      groupElement.querySelectorAll<HTMLElement>(".accountRow[data-account-name]"),
    ).filter((row) => row.dataset.accountName !== source.accountName);
    const targetRow = rows.find((row) => {
      const bounds = row.getBoundingClientRect();
      return clientY < bounds.top + bounds.height / 2;
    });
    if (targetRow) {
      updateAccountDropDestination(
        { name: targetRow.dataset.accountName ?? "", edge: "before" },
        targetGroup,
      );
      return;
    }
    const lastRow = rows[rows.length - 1];
    updateAccountDropDestination(
      lastRow ? { name: lastRow.dataset.accountName ?? "", edge: "after" } : null,
      targetGroup,
    );
  }

  function moveAccountPointerDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = accountPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.latestX = event.clientX;
    drag.latestY = event.clientY;

    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < accountDragActivationDistance) return;
      drag.active = true;
      setAccountSearch("");
      setPressedAccountName("");
      setDraggingAccountName(drag.accountName);
      updateAccountPointerDestination(event.clientX, event.clientY, drag);
    }

    event.preventDefault();
    event.stopPropagation();
    scheduleAccountDragPreview();
  }

  async function commitAccountPointerDrop(
    sourceName: string,
    target: AccountDropTarget | null,
    requestedGroup: string,
  ) {
    const source = accounts.find((account) => account.name === sourceName);
    const targetAccount = target ? accounts.find((account) => account.name === target.name) : null;
    if (!source) return;
    const sourceGroup = accountGroupLabel(source);
    const destinationGroup = requestedGroup || (targetAccount ? accountGroupLabel(targetAccount) : sourceGroup);

    if (destinationGroup === sourceGroup) {
      if (!targetAccount || targetAccount.name === source.name || !target) return;
      setAccountOrder((current) => reorderAccountNames(current, accounts, source.name, targetAccount.name, target.edge));
      setAccountReorderAnnouncement(`${source.name} 的顺序已调整`);
      return;
    }

    const moved = await assignAccountGroup(
      source,
      destinationGroup === ungroupedLabel ? null : destinationGroup,
      false,
    );
    if (!moved) return;
    setAccountOrder((current) => {
      if (targetAccount && target) {
        return reorderAccountNames(current, accounts, source.name, targetAccount.name, target.edge);
      }
      const destinationAccounts = orderAccounts(accounts, current).filter(
        (account) => account.name !== source.name && accountGroupLabel(account) === destinationGroup,
      );
      const lastAccount = destinationAccounts[destinationAccounts.length - 1];
      return lastAccount
        ? reorderAccountNames(current, accounts, source.name, lastAccount.name, "after")
        : mergedAccountOrder(current, accounts);
    });
    setAccountReorderAnnouncement(`${source.name} 已移动到 ${destinationGroup}`);
  }

  function clearAccountPointerDrag() {
    if (accountDragFrameRef.current !== null) {
      window.cancelAnimationFrame(accountDragFrameRef.current);
      accountDragFrameRef.current = null;
    }
    accountRowAnimationsRef.current.forEach((animation) => animation.cancel());
    accountRowAnimationsRef.current.clear();
    accountRowPositionsRef.current = new Map();
    setPressedAccountName("");
    setDraggingAccountName("");
    updateAccountDropDestination(null, "", false);
  }

  function finishAccountPointerDrag(event: PointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const drag = accountPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active && !cancelled) {
      drag.latestX = event.clientX;
      drag.latestY = event.clientY;
      updateAccountPointerDestination(event.clientX, event.clientY, drag);
    }
    const target = accountDropTargetRef.current;
    const targetGroup = accountDropTargetGroupRef.current;
    accountPointerDragRef.current = null;
    if (drag.captureElement.hasPointerCapture(event.pointerId)) {
      drag.captureElement.releasePointerCapture(event.pointerId);
    }
    if (drag.active) {
      event.preventDefault();
      accountDragSuppressClickRef.current = true;
      window.setTimeout(() => {
        accountDragSuppressClickRef.current = false;
      }, 0);
    }
    if (drag.active && !cancelled) {
      void commitAccountPointerDrop(drag.accountName, target, targetGroup).finally(clearAccountPointerDrag);
    } else {
      clearAccountPointerDrag();
    }
  }

  function cancelAccountPointerDrag() {
    const drag = accountPointerDragRef.current;
    accountPointerDragRef.current = null;
    if (drag?.captureElement.hasPointerCapture(drag.pointerId)) {
      drag.captureElement.releasePointerCapture(drag.pointerId);
    }
    clearAccountPointerDrag();
  }

  function moveAccountFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, account: Account) {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key) || account.trashed) return;
    const siblings = orderedAccounts.filter((candidate) => accountGroupLabel(candidate) === accountGroupLabel(account));
    const sourceIndex = siblings.findIndex((candidate) => candidate.name === account.name);
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const target = siblings[sourceIndex + direction];
    event.preventDefault();
    event.stopPropagation();
    if (!target) {
      setAccountReorderAnnouncement(`${account.name} 已在当前分组的${direction < 0 ? "顶部" : "底部"}`);
      return;
    }
    setAccountOrder((current) =>
      reorderAccountNames(current, accounts, account.name, target.name, direction < 0 ? "before" : "after"),
    );
    setSelectedName(account.name);
    setAccountReorderAnnouncement(
      `${account.name} 已移至第 ${sourceIndex + direction + 1} 位，共 ${siblings.length} 个账号`,
    );
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
    openDialog(
      {
        kind: "mark",
        account,
        value: account.mark_note ?? "",
        color: normalizeMarkColor(account.mark_color),
      },
      trigger,
    );
  }

  function noteAccountFromContextMenu(account: Account, trigger: HTMLElement) {
    setAccountContextMenu(null);
    openDialog({ kind: "note", account, value: account.note ?? "" }, trigger);
  }

  async function clearAccountMarkFromContextMenu(account: Account) {
    setAccountContextMenu(null);
    const updated = await run(() =>
      call<Account>("set_mark", {
        name: account.name,
        marked: false,
        note: null,
        color: null,
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
    setAccountSearch("");
    setSelectedName(account.name);
    setAccountContextMenu({
      account,
      returnFocusElement: event.currentTarget,
      x: menuPosition.x,
      y: menuPosition.y,
    });
  }

  function captureGroupFilterPositions() {
    const positions = new Map<string, { left: number; top: number }>();
    groupFilterRef.current
      ?.querySelectorAll<HTMLElement>(".groupFilterButton[data-group-label]")
      .forEach((group) => {
        const label = group.dataset.groupLabel ?? "";
        if (!label) return;
        const bounds = group.getBoundingClientRect();
        positions.set(label, { left: bounds.left, top: bounds.top });
      });
    groupFilterAnimationsRef.current.forEach((animation) => animation.cancel());
    groupFilterAnimationsRef.current.clear();
    groupFilterPositionsRef.current = positions;
  }

  function resolveGroupDropTarget(clientX: number, clientY: number, sourceLabel: string): GroupDropTarget | null {
    const filter = groupFilterRef.current;
    if (!filter) return null;
    const filterBounds = filter.getBoundingClientRect();
    if (
      clientX < filterBounds.left - 12
      || clientX > filterBounds.right + 12
      || clientY < filterBounds.top - 12
      || clientY > filterBounds.bottom + 12
    ) {
      return groupDropTargetRef.current;
    }

    const candidates = Array.from(
      filter.querySelectorAll<HTMLElement>(".groupFilterButton[data-group-label]"),
    ).filter((group) => group.dataset.groupLabel && group.dataset.groupLabel !== sourceLabel);
    if (candidates.length === 0) return null;

    const hit = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)
      ?.closest<HTMLElement>(".groupFilterButton[data-group-label]");
    let target = hit && hit.dataset.groupLabel !== sourceLabel ? hit : null;
    if (!target) {
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        const bounds = candidate.getBoundingClientRect();
        const deltaX = clientX - (bounds.left + bounds.width / 2);
        const deltaY = clientY - (bounds.top + bounds.height / 2);
        const distance = deltaX * deltaX + deltaY * deltaY;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          target = candidate;
        }
      }
    }
    const label = target?.dataset.groupLabel ?? "";
    if (!target || !label) return null;
    const bounds = target.getBoundingClientRect();
    return {
      label,
      edge: clientX >= bounds.left + bounds.width / 2 ? "after" : "before",
    };
  }

  function updateGroupDropDestination(target: GroupDropTarget | null) {
    const drag = groupPointerDragRef.current;
    if (!drag?.active) return;
    const current = groupDropTargetRef.current;
    if (current?.label === target?.label && current?.edge === target?.edge) return;
    captureGroupFilterPositions();
    groupDropTargetRef.current = target;
    setGroupDropTarget(target);
    if (!target) return;
    setGroupOrder((currentOrder) =>
      reorderGroupLabels(currentOrder, groupFilters, drag.label, target.label, target.edge),
    );
  }

  function updateGroupPointerDestination(clientX: number, clientY: number, drag: GroupPointerDrag) {
    updateGroupDropDestination(resolveGroupDropTarget(clientX, clientY, drag.label));
  }

  function scrollGroupFilterForPointer(clientY: number) {
    const filter = groupFilterRef.current;
    if (!filter) return;
    const bounds = filter.getBoundingClientRect();
    if (clientY < bounds.top - 8 || clientY > bounds.bottom + 8) return;
    if (clientY < bounds.top + groupDragAutoScrollEdge) {
      const strength = 1 - Math.max(clientY - bounds.top, 0) / groupDragAutoScrollEdge;
      filter.scrollTop -= Math.ceil(groupDragAutoScrollStep * strength);
    } else if (clientY > bounds.bottom - groupDragAutoScrollEdge) {
      const strength = 1 - Math.max(bounds.bottom - clientY, 0) / groupDragAutoScrollEdge;
      filter.scrollTop += Math.ceil(groupDragAutoScrollStep * strength);
    }
  }

  function scheduleGroupDragPreview() {
    if (groupDragFrameRef.current !== null) return;
    groupDragFrameRef.current = window.requestAnimationFrame(() => {
      groupDragFrameRef.current = null;
      const drag = groupPointerDragRef.current;
      const preview = groupDragPreviewRef.current;
      if (!drag?.active) return;
      scrollGroupFilterForPointer(drag.latestY);
      updateGroupPointerDestination(drag.latestX, drag.latestY, drag);
      if (!preview) return;
      const x = Math.round(drag.latestX - drag.grabOffsetX);
      const y = Math.round(drag.latestY - drag.grabOffsetY);
      preview.style.transform = `translate3d(${x}px, ${y}px, 0) scale(var(--group-drag-scale, 1.018))`;
    });
  }

  function startGroupPointerDrag(event: PointerEvent<HTMLElement>, group: GroupFilter) {
    if (group.value === allGroupsValue || event.button !== 0 || event.isPrimary === false) return;
    const groupElement = event.currentTarget.closest<HTMLElement>(".groupFilterButton[data-group-label]");
    const captureElement = groupFilterRef.current;
    if (!groupElement || !captureElement) return;
    const bounds = groupElement.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    groupElement.querySelector<HTMLButtonElement>(".groupFilterSelect")?.focus({ preventScroll: true });
    captureElement.setPointerCapture(event.pointerId);
    const initialOrder = orderGroupLabels(
      groupFilters.filter((item) => item.value !== allGroupsValue).map((item) => item.label),
      groupOrder,
    );
    groupPointerDragRef.current = {
      label: group.label,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      grabOffsetX: event.clientX - bounds.left,
      grabOffsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
      active: false,
      initialOrder,
      captureElement,
    };
    groupDropTargetRef.current = null;
    setGroupDropTarget(null);
    setPressedGroupLabel(group.label);
  }

  function moveGroupPointerDrag(event: PointerEvent<HTMLElement>) {
    const drag = groupPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.latestX = event.clientX;
    drag.latestY = event.clientY;
    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < groupDragActivationDistance) return;
      drag.active = true;
      setAccountSearch("");
      setPressedGroupLabel("");
      setDraggingGroupLabel(drag.label);
      updateGroupPointerDestination(event.clientX, event.clientY, drag);
    }
    event.preventDefault();
    event.stopPropagation();
    scheduleGroupDragPreview();
  }

  function clearGroupPointerDrag() {
    if (groupDragFrameRef.current !== null) {
      window.cancelAnimationFrame(groupDragFrameRef.current);
      groupDragFrameRef.current = null;
    }
    groupDropTargetRef.current = null;
    setPressedGroupLabel("");
    setDraggingGroupLabel("");
    setGroupDropTarget(null);
  }

  function finishGroupPointerDrag(event: PointerEvent<HTMLElement>, cancelled: boolean) {
    const drag = groupPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const releaseMoved = event.clientX !== drag.latestX || event.clientY !== drag.latestY;
    if (drag.active && !cancelled && (releaseMoved || !groupDropTargetRef.current)) {
      drag.latestX = event.clientX;
      drag.latestY = event.clientY;
      updateGroupPointerDestination(event.clientX, event.clientY, drag);
    }
    groupPointerDragRef.current = null;
    if (drag.captureElement.hasPointerCapture(event.pointerId)) {
      drag.captureElement.releasePointerCapture(event.pointerId);
    }
    if (drag.active) {
      event.preventDefault();
      event.stopPropagation();
      groupDragSuppressClickRef.current = true;
      window.setTimeout(() => {
        groupDragSuppressClickRef.current = false;
      }, 0);
      if (cancelled) {
        captureGroupFilterPositions();
        setGroupOrder(drag.initialOrder);
      } else {
        setAccountReorderAnnouncement(`${drag.label} 分组顺序已调整`);
      }
    }
    clearGroupPointerDrag();
  }

  function cancelGroupPointerDrag() {
    const drag = groupPointerDragRef.current;
    groupPointerDragRef.current = null;
    if (drag?.captureElement.hasPointerCapture(drag.pointerId)) {
      drag.captureElement.releasePointerCapture(drag.pointerId);
    }
    if (drag?.active) {
      captureGroupFilterPositions();
      setGroupOrder(drag.initialOrder);
    }
    clearGroupPointerDrag();
  }

  function moveGroupFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, group: GroupFilter) {
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const labels = orderGroupLabels(
      groupFilters.filter((item) => item.value !== allGroupsValue).map((item) => item.label),
      groupOrder,
    );
    const sourceIndex = labels.indexOf(group.label);
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const targetIndex = sourceIndex + direction;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= labels.length) {
      setAccountReorderAnnouncement(`${group.label} 分组已在${direction < 0 ? "最前" : "最后"}`);
      return;
    }
    captureGroupFilterPositions();
    const nextOrder = [...labels];
    nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, group.label);
    setGroupOrder(nextOrder);
    setAccountSearch("");
    setSelectedGroup(group.value);
    setAccountReorderAnnouncement(`${group.label} 分组已移至第 ${targetIndex + 1} 位`);
  }

  function handleGroupFilterClick(group: GroupFilter) {
    if (groupDragSuppressClickRef.current) {
      groupDragSuppressClickRef.current = false;
      return;
    }
    setAccountSearch("");
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
    setAccountSearch("");
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

  async function diagnoseAccount(account: Account) {
    if (account.trashed) return;
    setPlanLoading(true);
    setError("");
    try {
      // launch_preflight resolves GeoIP over the network and takes seconds, so
      // the user can switch accounts while it runs. Applying a late result would
      // pin one account's exit IP onto another's panel — the one thing this
      // button exists to let people trust.
      const checked = await call<LaunchPlan>("launch_preflight", { name: account.name });
      if (selectedNameRef.current !== account.name) return;
      setPlan(checked);
      if (checked.privacy_failures.length > 0) {
        setError("出口/隐私契约检查未通过；启动仍会被核心安全闸门拦截。");
      }
    } catch (caught) {
      if (selectedNameRef.current !== account.name) return;
      setPlan(null);
      setError(errorMessage(caught));
    } finally {
      if (selectedNameRef.current === account.name) setPlanLoading(false);
    }
  }

  async function auditChallengeCompatibility() {
    setChallengeAudit({ phase: "running" });
    setError("");
    try {
      const result = await call<ChallengeAuditResult>("run_challenge_audit");
      setChallengeAudit({
        phase: result.cancelled ? "cancelled" : result.passed ? "passed" : "failed",
        result,
        error: result.error ?? undefined,
      });
    } catch (caught) {
      const message = errorMessage(caught);
      setChallengeAudit({ phase: "failed", error: message });
      setError(message);
    }
  }

  async function launchAccount(account: Account) {
    // A row launches on double click, which bypasses the button's disabled
    // state. Without this guard the second call cancels the first, so the user
    // is told "启动已取消" while a third launch quietly opens the browser.
    if (launchInFlightRef.current.has(account.name)) return;
    launchInFlightRef.current.add(account.name);
    setError("");
    setLaunchStatus({ accountName: account.name, target: "chatgpt", phase: "checking", startedAt: Date.now() });
    // The backend now performs the privacy/GeoIP preflight and launch in one
    // blocking worker. This avoids the old check-then-launch double network
    // round-trip while keeping the strict privacy gate in the core.
    setLaunchStatus((current) => current?.accountName === account.name ? { ...current, phase: "starting" } : current);
    try {
      const result = await call<LaunchResult>("launch_account", { name: account.name });
      applyLaunchDiagnostics(result);
      setLaunchStatus((current) => current?.accountName === account.name
        ? { accountName: result.account, target: "chatgpt", phase: "opened", startedAt: current.startedAt, result }
        : current);
    } catch (caught) {
      const message = errorMessage(caught);
      const cancelled = isLaunchCancelledError(message);
      setLaunchStatus((current) => current?.accountName === account.name
        ? { ...current, phase: cancelled ? "cancelled" : "failed" }
        : current);
      setError(cancelled ? "启动已取消，账号和隐私配置未改变。" : message);
    } finally {
      launchInFlightRef.current.delete(account.name);
    }
  }

  async function launchWebStore(account: Account) {
    if (account.trashed) return;
    if (launchInFlightRef.current.has(account.name)) return;
    launchInFlightRef.current.add(account.name);
    setError("");
    setWebStoreStatus({ accountName: account.name, phase: "opening", startedAt: Date.now() });
    setLaunchStatus({ accountName: account.name, target: "web-store", phase: "checking", startedAt: Date.now() });
    setLaunchStatus((current) => current?.accountName === account.name ? { ...current, phase: "starting" } : current);
    try {
      const result = await call<LaunchResult>("launch_web_store", { name: account.name });
      applyLaunchDiagnostics(result);
      setWebStoreStatus({ accountName: result.account, phase: "opened", result });
      setLaunchStatus((current) => current?.accountName === account.name
        ? { accountName: result.account, target: "web-store", phase: "opened", startedAt: current.startedAt, result }
        : current);
    } catch (caught) {
      const message = errorMessage(caught);
      const cancelled = isLaunchCancelledError(message);
      setWebStoreStatus(null);
      setLaunchStatus((current) => current?.accountName === account.name
        ? { ...current, phase: cancelled ? "cancelled" : "failed" }
        : current);
      setError(cancelled ? "启动已取消，账号和隐私配置未改变。" : message);
    } finally {
      launchInFlightRef.current.delete(account.name);
    }
  }

  async function cancelLaunch(account: Account) {
    if (launchStatus?.accountName !== account.name) return;
    setLaunchStatus((current) => current?.accountName === account.name
      ? { ...current, phase: "cancelling" }
      : current);
    try {
      const cancelled = await call<boolean>("cancel_launch", { name: account.name });
      if (cancelled) {
        setLaunchStatus((current) => current?.accountName === account.name
          ? { ...current, phase: "cancelled" }
          : current);
        setWebStoreStatus((current) => current?.accountName === account.name ? null : current);
      } else {
        // cancel_launch returns false when the launch already finished. Only
        // undo our own "cancelling" label — writing "starting" unconditionally
        // would overwrite the "opened"/"failed" the launch just wrote, leaving a
        // spinner and a Cancel button that never resolve.
        setLaunchStatus((current) => current?.accountName === account.name && current.phase === "cancelling"
          ? { ...current, phase: "starting" }
          : current);
      }
    } catch (caught) {
      setError(errorMessage(caught));
      setLaunchStatus((current) => current?.accountName === account.name
        ? { ...current, phase: "failed" }
        : current);
    }
  }

  function applyLaunchDiagnostics(result: LaunchResult) {
    setPlan((current) => {
      if (!current || current.account !== result.account) return current;
      return {
        ...current,
        engine_major: result.diagnostics.engine_major,
        engine_version: result.diagnostics.engine_version,
        geo_cache_hit: result.diagnostics.geo_cache_hit,
        geo: {
          exit_ip: result.diagnostics.exit_ip,
          country: result.diagnostics.country,
          timezone: result.diagnostics.timezone,
        },
      };
    });
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

  async function confirmDeleteGroup(groupLabel: string, returnToManage = false) {
    if (!groupLabel || groupLabel === allGroupsLabel || groupLabel === ungroupedLabel) {
      setDialog(returnToManage ? { kind: "manage", section: "groups" } : null);
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
      setDialog(returnToManage ? { kind: "manage", section: "groups" } : null);
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
  const emptyTitle = accountView === "trash" ? "回收站为空" : "暂无活跃账号";
  const emptyAction = accountView === "active" ? "新建账号" : "查看活跃";
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
  const launchStatusIsCurrent = Boolean(selected && launchStatus?.accountName === selected.name);
  const launchStatusIsPending = Boolean(
    launchStatusIsCurrent
    && launchStatus
    && ["checking", "starting", "cancelling"].includes(launchStatus.phase),
  );
  const launchStatusLabel = launchStatus
    ? launchStatus.phase === "checking"
      ? launchStatusIsCurrent ? "正在检查出口与隐私契约…" : `正在检查：${middleTruncate(launchStatus.accountName, 34)}`
      : launchStatus.phase === "starting"
        ? launchStatusIsCurrent ? "检查通过，正在启动…" : `正在启动：${middleTruncate(launchStatus.accountName, 34)}`
        : launchStatus.phase === "cancelling"
          ? launchStatusIsCurrent ? "正在取消…" : `正在取消：${middleTruncate(launchStatus.accountName, 34)}`
          : launchStatus.phase === "cancelled"
            ? launchStatusIsCurrent ? "已取消，可重新启动" : `已取消：${middleTruncate(launchStatus.accountName, 34)}`
        : launchStatus.phase === "failed"
          ? launchStatusIsCurrent ? "启动失败，可重试" : `启动失败：${middleTruncate(launchStatus.accountName, 34)}`
          : launchStatusIsCurrent
            ? `${launchStatus.target === "web-store" ? "商店" : "已启动"} · ${launchStatus.result?.diagnostics.launch_ms ?? 0} ms`
            : `已启动：${middleTruncate(launchStatus.accountName, 34)}`
    : "";
  const challengeVersionResult = challengeAudit?.result?.results.find((item) => item.name === "version-consistency");
  const challengeTurnstileResult = challengeAudit?.result?.results.find((item) => item.name === "cloudflare-turnstile-test");
  const challengeAuditLabel = challengeAudit?.phase === "running"
    ? "正在用临时 profile 检查真实引擎与官方 Turnstile 测试密钥…"
    : challengeAudit?.phase === "passed"
      ? `兼容通过 · ${challengeAudit.result?.duration_ms ?? 0} ms`
      : challengeAudit?.phase === "failed"
        ? "兼容检查失败，可重试"
        : challengeAudit?.phase === "cancelled"
          ? "浏览器已关闭，检查已结束，可重试"
          : "";
  const workspaceStyle = { "--sidebar-width": `${sidebarWidth}px` } as CSSProperties & {
    "--sidebar-width": string;
  };
  const draggingGroup = draggingGroupLabel
    ? groupFilters.find((group) => group.label === draggingGroupLabel) ?? null
    : null;
  const activeGroupDrag = groupPointerDragRef.current;
  const groupDragPreviewStyle = activeGroupDrag?.active
    ? {
        width: activeGroupDrag.width,
        height: activeGroupDrag.height,
        transform: `translate3d(${Math.round(activeGroupDrag.latestX - activeGroupDrag.grabOffsetX)}px, ${Math.round(activeGroupDrag.latestY - activeGroupDrag.grabOffsetY)}px, 0) scale(var(--group-drag-scale, 1.018))`,
      }
    : undefined;
  const draggingAccount = draggingAccountName
    ? accounts.find((account) => account.name === draggingAccountName) ?? null
    : null;
  const activeAccountDrag = accountPointerDragRef.current;
  const accountDragPreviewStyle = activeAccountDrag?.active
    ? {
        width: activeAccountDrag.width,
        height: activeAccountDrag.height,
        transform: `translate3d(${Math.round(activeAccountDrag.latestX - activeAccountDrag.grabOffsetX)}px, ${Math.round(activeAccountDrag.latestY - activeAccountDrag.grabOffsetY)}px, 0) scale(var(--account-drag-scale, 1.012))`,
      }
    : undefined;
  return (
    <main className={`shell ${draggingAccountName ? "accountDragging" : ""} ${draggingGroupLabel ? "groupDragging" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <div>
            <strong>Cloak 账号管理</strong>
            <span>{accountCountLabel}</span>
          </div>
        </div>
        <div className="accountSearch">
          <div className={`accountSearchField ${hasAccountSearch && !accountSearchMatch ? "notFound" : ""}`}>
            <Search aria-hidden="true" size={15} />
            <input
              aria-describedby={hasAccountSearch ? "account-search-result-status" : undefined}
              aria-label="搜索账号"
              autoComplete="off"
              placeholder="搜索所有账号、分组、标记或备注"
              spellCheck={false}
              type="search"
              value={accountSearch}
              onChange={(event) => handleAccountSearchChange(event.currentTarget.value)}
              onKeyDown={handleAccountSearchKeyDown}
            />
            {hasAccountSearch ? (
              <div className="accountSearchNavigator" aria-label="搜索结果导航">
                <span
                  className={`accountSearchResultStatus ${accountSearchMatch ? "" : "notFound"}`}
                  id="account-search-result-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {accountSearchMatch ? `${accountSearchIndex + 1}/${accountSearchMatches.length}` : "无匹配"}
                </span>
                {accountSearchMatches.length > 1 ? (
                  <>
                    <button
                      aria-label="上一个匹配"
                      className="accountSearchNavButton"
                      title="上一个匹配（↑ 或 Shift+Enter）"
                      type="button"
                      onClick={() => moveAccountSearchMatch(-1)}
                    >
                      <ChevronUp aria-hidden="true" size={11} />
                    </button>
                    <button
                      aria-label="下一个匹配"
                      className="accountSearchNavButton"
                      title="下一个匹配（↓ 或 Enter）"
                      type="button"
                      onClick={() => moveAccountSearchMatch(1)}
                    >
                      <ChevronDown aria-hidden="true" size={11} />
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            {hasAccountSearch ? (
              <button
                aria-label="清除搜索"
                className="accountSearchClear"
                title="清除搜索"
                type="button"
                onClick={() => setAccountSearch("")}
              >
                <X aria-hidden="true" size={11} />
              </button>
            ) : null}
          </div>
        </div>
        <div className="topActions">
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
            <div className="sidebarHeaderActions">
              <IconButton label="重新读取账号列表" disabled={busy} onClick={() => void run(() => refresh())}>
                <RefreshCw aria-hidden="true" className={busy ? "spin" : undefined} size={13} />
              </IconButton>
              <div className="manageMenuWrap sidebarManageMenuWrap">
                <button
                  aria-expanded={manageMenuOpen}
                  aria-haspopup="menu"
                  className={`sidebarManageButton manageButton ${manageMenuOpen ? "active" : ""}`}
                  disabled={busy}
                  ref={manageButtonRef}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setGroupContextMenu(null);
                    setAccountContextMenu(null);
                    setManageMenuOpen((current) => !current);
                  }}
                >
                  <Settings2 aria-hidden="true" size={13} />
                  管理
                  <ChevronDown aria-hidden="true" className="manageChevron" size={10} />
                </button>
                {manageMenuOpen ? (
                  <div
                    aria-label="管理选项"
                    className="contextMenu manageMenu"
                    role="menu"
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    <button
                      autoFocus
                      className="contextMenuItem"
                      role="menuitem"
                      type="button"
                      onClick={() => openManageDialog("groups", manageButtonRef.current)}
                    >
                      <Folder aria-hidden="true" size={14} />
                      <span className="contextMenuItemLabel">管理分组</span>
                    </button>
                    <button
                      className="contextMenuItem"
                      role="menuitem"
                      type="button"
                      onClick={() => openManageDialog("marks", manageButtonRef.current)}
                    >
                      <Tags aria-hidden="true" size={14} />
                      <span className="contextMenuItemLabel">管理标签</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="viewSwitch" role="tablist" aria-label="账号视图">
            <button
              className={accountView === "active" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={accountView === "active"}
              onClick={() => handleAccountViewChange("active")}
            >
              活跃
            </button>
            <button
              className={accountView === "trash" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={accountView === "trash"}
              onClick={() => handleAccountViewChange("trash")}
            >
              回收站
            </button>
          </div>

          <div
            className="groupFilter"
            aria-label="分组筛选"
            ref={groupFilterRef}
            onLostPointerCapture={(event) => finishGroupPointerDrag(event, true)}
            onPointerCancel={(event) => finishGroupPointerDrag(event, true)}
            onPointerMove={moveGroupPointerDrag}
            onPointerUp={(event) => finishGroupPointerDrag(event, false)}
          >
            {groupFilters.map((group) => {
              const isAll = group.value === allGroupsValue;
              const isActive = selectedGroup === group.value;
              const canDeleteGroup = !isAll && group.label !== ungroupedLabel;
              const reorderEdge = groupDropTarget?.label === group.label ? groupDropTarget.edge : undefined;
              return (
                <div
                  className={`groupFilterButton ${isActive ? "active" : ""} ${pressedGroupLabel === group.label ? "pressed" : ""} ${draggingGroupLabel === group.label ? "dragOrigin" : ""} ${dropTargetGroup === group.label ? "dropTarget" : ""} ${reorderEdge ? "reorderTarget" : ""}`}
                  data-drop-edge={reorderEdge}
                  data-group-label={isAll ? undefined : group.label}
                  key={group.value}
                  title={isAll ? "再次点击可折叠或展开全部分组" : "点击查看分组；拖动手柄调整顺序"}
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
                    aria-keyshortcuts={isAll ? undefined : "Alt+ArrowLeft Alt+ArrowRight"}
                    title={isAll ? "再次点击可折叠或展开全部分组" : "点击查看；拖动左侧手柄排序；⌥← / ⌥→ 微调"}
                    onClick={() => handleGroupFilterClick(group)}
                    onKeyDown={(event) => moveGroupFromKeyboard(event, group)}
                  >
                    {isAll ? null : (
                      <span
                        className="groupDragHandle"
                        aria-hidden="true"
                        title="拖动调整分组顺序"
                        onPointerDown={(event) => startGroupPointerDrag(event, group)}
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

          <div className="accountList" ref={accountListRef}>
            {visibleAccounts.length === 0 && loadError ? (
              // "暂无活跃账号" next to a full disk of accounts is a lie, and the
              // error toast has already auto-dismissed by the time anyone looks.
              <div className="emptyState">
                <ShieldAlert size={24} />
                <strong>账号列表加载失败</strong>
                <p className="emptyStateDetail">{loadError}</p>
                <button className="subtleButton" onClick={() => void refresh()}>
                  <RefreshCw size={14} />
                  重试
                </button>
              </div>
            ) : visibleAccounts.length === 0 ? (
              <div className="emptyState">
                {accountView === "active" ? <ShieldCheck size={24} /> : <Trash2 size={24} />}
                <strong>{emptyTitle}</strong>
                <button
                  className="subtleButton"
                  onClick={
                    accountView === "active"
                      ? (event) => openCreateDialog(event.currentTarget)
                      : () => setAccountView("active")
                  }
                >
                  {accountView === "active" ? (
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
                  chronological={accountView === "trash"}
                  draggingAccountName={draggingAccountName}
                  pressedAccountName={pressedAccountName}
                  collapsed={accountView === "active" && selectedGroup === allGroupsValue && collapsedGroups.includes(group.label)}
                  canCollapse={accountView === "active" && selectedGroup === allGroupsValue}
                  dropTarget={dropTargetGroup === group.label}
                  dropPlaceholderAtEnd={Boolean(
                    draggingAccountName && accountDropGroup === group.label && !accountDropTarget,
                  )}
                  group={group}
                  key={group.label}
                  onFinishAccountDrag={finishAccountPointerDrag}
                  onLaunchAccount={launchAccount}
                  onMoveAccountDrag={moveAccountPointerDrag}
                  onMoveAccountFromKeyboard={moveAccountFromKeyboard}
                  onOpenAccountContextMenu={openAccountContextMenu}
                  onSelectAccount={handleAccountSelection}
                  onStartAccountDrag={startAccountPointerDrag}
                  onToggleCollapse={toggleGroupCollapse}
                  locatedName={hasAccountSearch ? accountSearchMatch?.name ?? "" : ""}
                  searching={false}
                  selectedName={selected?.name ?? ""}
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
                  {launchStatus && launchStatusLabel ? (
                    <span className={`launchStatus ${launchStatus.phase === "failed" ? "failed" : launchStatus.phase === "opened" ? "current" : launchStatus.phase === "cancelled" ? "cancelled" : "pending"}`}>
                      {["checking", "starting", "cancelling"].includes(launchStatus.phase) ? <Loader2 className="spin" size={12} /> : null}
                      {launchStatusLabel}
                    </span>
                  ) : null}
                </div>
                {selected.trashed ? (
                  <div className="detailHeaderControl">
                    <div className="detailHeaderActions">
                      <button className="secondaryButton" disabled={busy} onClick={() => void restoreAccount(selected)}>
                        <ArchiveRestore size={16} />
                        恢复
                      </button>
                      <button
                        className="launchButton"
                        disabled={busy || (launchStatusIsPending && launchStatus?.target !== "chatgpt")}
                        title="启动账号但保持回收站状态"
                        onClick={() => void (
                          launchStatusIsPending && launchStatus?.target === "chatgpt"
                            ? cancelLaunch(selected)
                            : launchAccount(selected)
                        )}
                      >
                        {launchStatusIsPending && launchStatus?.target === "chatgpt" ? <X size={16} /> : <Play size={16} />}
                        {launchStatusIsPending && launchStatus?.target === "chatgpt" ? "取消" : "临时启动"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="detailHeaderControl">
                    <div className="detailHeaderActions">
                      <button
                        className="secondaryButton"
                        disabled={busy || planLoading || (launchStatusIsPending && launchStatus?.target !== "web-store")}
                        title={`用 ${selected.name} 打开 Chrome Web Store`}
                        onClick={() => void (
                          launchStatusIsPending && launchStatus?.target === "web-store"
                            ? cancelLaunch(selected)
                            : launchWebStore(selected)
                        )}
                      >
                        {launchStatusIsPending && launchStatus?.target === "web-store" ? <X size={16} /> : <Store size={16} />}
                        {launchStatusIsPending && launchStatus?.target === "web-store" ? "取消" : "商店"}
                      </button>
                      <button
                        className="launchButton"
                        disabled={busy || planLoading || (launchStatusIsPending && launchStatus?.target !== "chatgpt")}
                        onClick={() => void (
                          launchStatusIsPending && launchStatus?.target === "chatgpt"
                            ? cancelLaunch(selected)
                            : launchAccount(selected)
                        )}
                      >
                        {launchStatusIsPending && launchStatus?.target === "chatgpt" ? <X size={16} /> : <Play size={16} />}
                        {launchStatusIsPending && launchStatus?.target === "chatgpt" ? "取消" : "启动"}
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
                    <InfoRow
                      icon={<MessageSquareText size={15} />}
                      label="备注"
                      value={selected.note ?? "未填写"}
                      multiline={Boolean(selected.note)}
                    />
                    <InfoRow icon={<CalendarClock size={15} />} label="创建时间" value={formatCreatedAt(selected.created_at)} />
                    {selected.trashed ? (
                      <InfoRow icon={<Trash2 size={15} />} label="删除时间" value={formatCreatedAt(selected.deleted_at ?? 0)} />
                    ) : null}
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
                    <InfoRow label="引擎版本" value={plan?.engine_version ? `Chromium ${plan.engine_version}` : "未解析"} mono />
                    <InfoRow label="出口缓存" value={plan?.geo_cache_hit ? "代理缓存命中（5 分钟内）" : "未使用缓存"} />
                    <InfoRow label="浏览器" value={plan?.browser_binary ?? "未解析"} mono />
                  </InspectorGroup>
                </section>

                {launchStatusIsCurrent && launchStatus?.phase === "opened" && launchStatus.result?.diagnostics ? (
                  <div className="diagnosticBox">
                    <div className="diagnosticTitle"><ShieldCheck size={14} />启动诊断</div>
                    <div className="diagnosticGrid">
                      <span>预检</span><strong>{launchStatus.result.diagnostics.preflight_ms} ms</strong>
                      <span>启动</span><strong>{launchStatus.result.diagnostics.launch_ms} ms</strong>
                      <span>代理</span><strong>{launchStatus.result.diagnostics.proxy_display}</strong>
                      <span>出口</span><strong>{launchStatus.result.diagnostics.exit_ip ?? "未取得"}</strong>
                      <span>地区</span><strong>{launchStatus.result.diagnostics.country ?? "未取得"}</strong>
                      <span>缓存</span><strong>{launchStatus.result.diagnostics.geo_cache_hit ? "命中（5 分钟内）" : "未命中"}</strong>
                    </div>
                    <div className="capabilityList" title="当前实际可用的编排能力，不代表引擎已升级到 Pro 版本">
                      {launchStatus.result.diagnostics.capabilities.map((capability) => <span key={capability}>{capability}</span>)}
                    </div>
                  </div>
                ) : null}

                {challengeAudit ? (
                  <div className={`challengeAuditBox ${challengeAudit.phase}`}>
                    <div className="diagnosticTitle">
                      {challengeAudit.phase === "running" ? <Loader2 className="spin" size={14} /> : <ShieldCheck size={14} />}
                      Cloudflare / Turnstile
                    </div>
                    <strong>{challengeAuditLabel}</strong>
                    {challengeAudit.result ? (
                      <div className="challengeAuditSignals">
                        <span>版本一致性：{challengeVersionResult?.passed ? "通过" : "失败"}</span>
                        <span>官方 widget：{challengeTurnstileResult?.details?.widgetCompleted ? "完成" : "未完成"}</span>
                        <span>Siteverify：{challengeTurnstileResult?.details?.serverValidation?.success ? "通过" : "失败"}</span>
                        <span>阻断页：{challengeTurnstileResult?.details?.challenge?.blocked ? "检测到" : "未检测到"}</span>
                      </div>
                    ) : null}
                    {challengeAudit.error ? <p>{challengeAudit.error}</p> : null}
                  </div>
                ) : null}

                {plan?.privacy_failures.length ? (
                  <div className="warningBox">
                    {plan.privacy_failures.map((failure) => (
                      <p key={failure}>{failure}</p>
                    ))}
                  </div>
                ) : null}

                <details className="argv">
                  <summary>启动参数（敏感值已遮罩）</summary>
                  <code>{[plan?.browser_binary, ...(plan?.argv ?? [])].filter((arg): arg is string => Boolean(arg)).map(sanitizeLaunchArg).join(" ")}</code>
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
                      <ActionButton icon={<ShieldCheck size={15} />} label="检查出口" onClick={() => void diagnoseAccount(selected)} />
                      <ActionButton
                        icon={challengeAudit?.phase === "running" ? <Loader2 className="spin" size={15} /> : <ShieldCheck size={15} />}
                        label={challengeAudit?.phase === "running" ? "检查挑战中" : "挑战兼容"}
                        disabled={challengeAudit?.phase === "running" || launchStatusIsPending}
                        onClick={() => void auditChallengeCompatibility()}
                      />
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

      {draggingGroup && activeGroupDrag?.active && groupDragPreviewStyle ? (
        <div
          aria-hidden="true"
          className="groupDragPreview"
          ref={groupDragPreviewRef}
          style={groupDragPreviewStyle}
        >
          <span className="groupDragPreviewHandle">
            <GripVertical size={12} />
          </span>
          <Folder className="groupIcon" size={12} />
          <strong>{middleTruncate(draggingGroup.label, 28)}</strong>
          <small>{draggingGroup.count}</small>
        </div>
      ) : null}

      {draggingAccount && activeAccountDrag?.active && accountDragPreviewStyle ? (
        <div
          aria-hidden="true"
          className="accountDragPreview"
          ref={accountDragPreviewRef}
          style={accountDragPreviewStyle}
        >
          <span className="accountDragPreviewHandle">
            <GripVertical size={14} />
          </span>
          <strong>{middleTruncate(draggingAccount.name, 34)}</strong>
          {draggingAccount.marked ? (
            <span
              className={`accountMark ${draggingAccount.mark_note ? "withNote" : ""}`}
              style={markColorStyle(draggingAccount.mark_color)}
            >
              <span className="markDot" />
              {draggingAccount.mark_note ? (
                <span className="markNote">{middleTruncate(draggingAccount.mark_note, 16)}</span>
              ) : null}
            </span>
          ) : null}
          <code>{formatCreatedDate(draggingAccount.created_at)}</code>
        </div>
      ) : null}
      <span className="visuallyHidden" role="status" aria-live="polite" aria-atomic="true">
        {accountReorderAnnouncement}
      </span>

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
            className="contextMenuItem"
            disabled={busy}
            type="button"
            role="menuitem"
            onClick={() => {
              openDialog({
                kind: "renameGroup",
                groupLabel: groupContextMenu.groupLabel,
                count: groupContextMenu.count,
                value: groupContextMenu.groupLabel,
              }, groupContextMenu.returnFocusElement);
              setGroupContextMenu(null);
            }}
          >
            <Pencil size={14} />
            重命名分组
          </button>
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
              noteAccountFromContextMenu(accountContextMenu.account, accountContextMenu.returnFocusElement)
            }
          >
            <MessageSquareText aria-hidden="true" size={14} />
            <span className="contextMenuItemLabel">{accountContextMenu.account.note ? "编辑备注" : "写备注"}</span>
          </button>
          <button
            className="contextMenuItem"
            disabled={busy}
            type="button"
            role="menuitem"
            onClick={() =>
              markAccountFromContextMenu(accountContextMenu.account, accountContextMenu.returnFocusElement)
            }
          >
            <span
              className="contextMarkDot"
              style={markColorStyle(accountContextMenu.account.mark_color)}
              aria-hidden="true"
            />
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
              <span
                className="contextMarkDot clear"
                style={markColorStyle(accountContextMenu.account.mark_color)}
                aria-hidden="true"
              />
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

      {/* A stale list looks exactly like a current one, so this stays until the
          next successful refresh rather than auto-dismissing like `error`. */}
      {loadError && !dialog ? (
        <div className="toast errorToast" role="alert">
          账号列表加载失败，显示的是上一次结果：{loadError}
          <button className="toastAction" onClick={() => void refresh()}>重试</button>
        </div>
      ) : null}
      {error && !dialog ? <div className="toast errorToast" role="alert">{error}</div> : null}
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
            setDialog(
              dialog.kind === "createGroup" || dialog.kind === "renameGroup" || dialog.kind === "deleteGroup"
                ? dialog.returnToManage
                  ? { kind: "manage", section: "groups" }
                  : null
                : null,
            );
          }}
          onConfirmDelete={confirmDeleteAccount}
          onConfirmDeleteGroup={(groupLabel, returnToManage) => void confirmDeleteGroup(groupLabel, returnToManage)}
          onConfirmPermanentDelete={confirmPermanentDeleteAccount}
          groupOptions={groupOptions}
          managedGroups={managedGroups}
          onCreateGroup={createStandaloneGroup}
          onGroupOrderChange={setGroupOrder}
          onQuickGroup={(account, value) => void assignAccountGroup(account, value || null, true)}
          onQuickMark={(account, value, color) => void saveAccountMark(account, value, color)}
          onSubmit={submitDialog}
        />
      ) : null}
    </main>
  );
}

function AccountDropPlaceholder() {
  return <div aria-hidden="true" className="accountDropPlaceholder" />;
}

function AccountGroupSection({
  accountDropTarget,
  canCollapse,
  chronological,
  collapsed,
  draggingAccountName,
  dropPlaceholderAtEnd,
  dropTarget,
  group,
  locatedName,
  pressedAccountName,
  searching,
  selectedName,
  onFinishAccountDrag,
  onLaunchAccount,
  onMoveAccountDrag,
  onMoveAccountFromKeyboard,
  onOpenAccountContextMenu,
  onSelectAccount,
  onStartAccountDrag,
  onToggleCollapse,
}: {
  accountDropTarget: AccountDropTarget | null;
  canCollapse: boolean;
  chronological: boolean;
  collapsed: boolean;
  draggingAccountName: string;
  dropPlaceholderAtEnd: boolean;
  dropTarget: boolean;
  group: AccountGroup;
  locatedName: string;
  pressedAccountName: string;
  searching: boolean;
  selectedName: string;
  onFinishAccountDrag: (event: PointerEvent<HTMLButtonElement>, cancelled: boolean) => void;
  onLaunchAccount: (account: Account) => Promise<void>;
  onMoveAccountDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onMoveAccountFromKeyboard: (event: KeyboardEvent<HTMLButtonElement>, account: Account) => void;
  onOpenAccountContextMenu: (event: MouseEvent<HTMLButtonElement>, account: Account) => void;
  onSelectAccount: (name: string) => void;
  onStartAccountDrag: (event: PointerEvent<HTMLButtonElement>, account: Account) => void;
  onToggleCollapse: (groupLabel: string) => void;
}) {
  return (
    <section
      className={`accountGroup ${searching ? "searching" : ""} ${chronological ? "chronological" : ""} ${dropTarget ? "dropTarget" : ""} ${collapsed ? "collapsed" : ""}`}
      data-account-group={searching || chronological ? undefined : group.label}
    >
      {searching || chronological ? null : (
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
      )}
      {collapsed ? null : (
        <>
          {group.accounts.map((account) => {
            const isLocated = account.name === locatedName;
            const showPlaceholderBefore = !searching
              && !chronological
              && accountDropTarget?.name === account.name
              && accountDropTarget.edge === "before";
            const showPlaceholderAfter = !searching
              && !chronological
              && accountDropTarget?.name === account.name
              && accountDropTarget.edge === "after";
            return (
              <Fragment key={account.name}>
                {showPlaceholderBefore ? <AccountDropPlaceholder /> : null}
                <button
                  aria-current={isLocated ? "true" : undefined}
                  aria-keyshortcuts={!searching && !account.trashed ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                  className={`accountRow ${searching ? "searchResult" : ""} ${chronological ? "chronological" : ""} ${account.name === selectedName ? "selected" : ""} ${isLocated ? "searchLocated" : ""} ${account.name === pressedAccountName ? "dragPressed" : ""} ${account.name === draggingAccountName ? "dragOrigin" : ""}`}
                  data-account-group={searching ? undefined : accountGroupLabel(account)}
                  data-account-name={searching ? undefined : account.name}
                  hidden={!searching && account.name === draggingAccountName}
                  title={`${account.name}${isLocated ? "｜当前搜索匹配" : ""}${account.marked ? `｜已标记${account.mark_note ? `：${account.mark_note}` : ""}` : ""}${account.note ? `｜备注：${account.note.replace(/\s+/g, " ")}` : ""}${searching || account.trashed ? "" : "｜拖动左侧手柄排序或移动分组；⌥↑ / ⌥↓ 微调"}`}
                  onClick={() => onSelectAccount(account.name)}
                  onContextMenu={(event) => onOpenAccountContextMenu(event, account)}
                  onDoubleClick={(event) => {
                    const target = event.target;
                    if (target instanceof Element && target.closest(".dragHandle")) return;
                    void onLaunchAccount(account);
                  }}
                  onKeyDown={searching ? undefined : (event) => onMoveAccountFromKeyboard(event, account)}
                  onLostPointerCapture={searching ? undefined : (event) => onFinishAccountDrag(event, true)}
                  onPointerCancel={searching ? undefined : (event) => onFinishAccountDrag(event, true)}
                  onPointerDown={searching ? undefined : (event) => onStartAccountDrag(event, account)}
                  onPointerMove={searching ? undefined : onMoveAccountDrag}
                  onPointerUp={searching ? undefined : (event) => onFinishAccountDrag(event, false)}
                >
                  <span className="accountRail" />
                  <span className="accountMain">
                    <span className="accountTitle">
                      {searching ? null : isLocated ? (
                        <Search className="searchMatchIcon" size={14} />
                      ) : account.trashed ? (
                        <Trash2 className="trashRowIcon" size={14} />
                      ) : (
                        <span className="dragHandle" title="拖动调整顺序或移动分组">
                          <GripVertical size={14} />
                        </span>
                      )}
                      <strong title={account.name}>{middleTruncate(account.name, 34)}</strong>
                      {account.note ? (
                        <span className="accountNoteIndicator" title={account.note} aria-label={`备注：${account.note}`}>
                          <MessageSquareText aria-hidden="true" size={13} />
                        </span>
                      ) : null}
                      {searching || chronological ? (
                        <span
                          className={`accountLocationTag ${account.trashed ? "trashed" : "active"}`}
                          title={`${account.trashed ? "回收站" : "活跃"} · ${accountGroupLabel(account)}`}
                        >
                          {account.trashed ? "回收站" : "活跃"} · {accountGroupLabel(account)}
                        </span>
                      ) : null}
                      {account.marked ? (
                        <span
                          className={`accountMark ${account.mark_note ? "withNote" : ""}`}
                          style={markColorStyle(account.mark_color)}
                          title={account.mark_note
                            ? `${account.mark_note}（${markColorLabel(account.mark_color)}）`
                            : `已标记（${markColorLabel(account.mark_color)}）`}
                          aria-label={account.mark_note
                            ? `标记：${account.mark_note}，颜色：${markColorLabel(account.mark_color)}`
                            : `已标记，颜色：${markColorLabel(account.mark_color)}`}
                        >
                          <span className="markDot" aria-hidden="true" />
                          {account.mark_note ? <span className="markNote">{middleTruncate(account.mark_note, 16)}</span> : null}
                        </span>
                      ) : null}
                      <code title={account.trashed ? "删除日期" : "创建日期"}>
                        {formatCreatedDate(account.trashed ? account.deleted_at ?? 0 : account.created_at)}
                      </code>
                    </span>
                  </span>
                </button>
                {showPlaceholderAfter ? <AccountDropPlaceholder /> : null}
              </Fragment>
            );
          })}
          {dropPlaceholderAtEnd && !chronological ? <AccountDropPlaceholder /> : null}
        </>
      )}
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
  managedGroups,
  onCreateGroup,
  onGroupOrderChange,
  onQuickGroup,
  onQuickMark,
  onSubmit,
}: {
  dialog: DialogState;
  busy: boolean;
  error: string;
  returnFocusElement: HTMLElement | null;
  onChange: (next: DialogState | null) => void;
  onClose: () => void;
  onConfirmDelete: (account: Account) => void;
  onConfirmDeleteGroup: (groupLabel: string, returnToManage?: boolean) => void;
  onConfirmPermanentDelete: (account: Account) => void;
  groupOptions: GroupOption[];
  managedGroups: ManagedGroup[];
  onCreateGroup: (value: string) => boolean;
  onGroupOrderChange: (labels: string[]) => void;
  onQuickGroup: (account: Account, value: string) => void;
  onQuickMark: (account: Account, value: string, color: MarkColor) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const modalRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const [creatingGroup, setCreatingGroup] = useState(false);
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

  if (dialog.kind === "manage") {
    return (
      <div className="modalBackdrop">
        <section
          aria-labelledby={dialogTitleId}
          aria-modal="true"
          className="modal manageModal"
          ref={(node) => {
            modalRef.current = node;
          }}
          role="dialog"
          tabIndex={-1}
        >
          <button className="modalClose" type="button" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>
          <div className="manageHeader">
            <h2 id={dialogTitleId}>管理</h2>
            <p>集中维护首页使用的分组和常用标签。</p>
          </div>
          <div className="manageTabs" role="tablist" aria-label="管理类型">
            <button
              aria-controls="cloak-manage-groups"
              aria-selected={dialog.section === "groups"}
              autoFocus={dialog.section === "groups"}
              className={dialog.section === "groups" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => onChange({ kind: "manage", section: "groups" })}
            >
              <Folder aria-hidden="true" size={14} />
              分组
            </button>
            <button
              aria-controls="cloak-manage-marks"
              aria-selected={dialog.section === "marks"}
              autoFocus={dialog.section === "marks"}
              className={dialog.section === "marks" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => onChange({ kind: "manage", section: "marks" })}
            >
              <Tags aria-hidden="true" size={14} />
              标签
            </button>
          </div>
          {dialog.section === "groups" ? (
            <section aria-label="分组管理" className="manageSection" id="cloak-manage-groups" role="tabpanel">
              <div className="manageSectionHeader">
                <div>
                  <strong>分组</strong>
                  <span>重命名会同步更新活跃账号和回收站账号，并保留当前位置。</span>
                </div>
                <button
                  className="primaryButton"
                  disabled={busy}
                  type="button"
                  onClick={() => onChange({ kind: "createGroup", value: "", returnToManage: true })}
                >
                  <Plus aria-hidden="true" size={13} />
                  新建分组
                </button>
              </div>
              <div className="manageList">
                {managedGroups.map((group) => (
                  <div className="manageRow" key={group.label}>
                    <span className="manageRowIcon" aria-hidden="true"><Folder size={14} /></span>
                    <span className="manageRowMain">
                      <strong title={group.label}>{middleTruncate(group.label, 34)}</strong>
                      <small>{group.count > 0 ? `${group.count} 个账号` : "空分组"}</small>
                    </span>
                    <span className="manageRowActions">
                      <button
                        aria-label={`重命名分组 ${group.label}`}
                        className="manageRowAction"
                        disabled={busy}
                        title="重命名"
                        type="button"
                        onClick={() => onChange({
                          kind: "renameGroup",
                          groupLabel: group.label,
                          count: group.count,
                          value: group.label,
                          returnToManage: true,
                        })}
                      >
                        <Pencil aria-hidden="true" size={13} />
                      </button>
                      <button
                        aria-label={`删除分组 ${group.label}`}
                        className="manageRowAction danger"
                        disabled={busy}
                        title="删除分组"
                        type="button"
                        onClick={() => onChange({
                          kind: "deleteGroup",
                          groupLabel: group.label,
                          count: group.count,
                          returnToManage: true,
                        })}
                      >
                        <Trash2 aria-hidden="true" size={13} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <ManageMarkPresets busy={busy} />
          )}
          <div className="modalActions manageModalActions">
            <button className="secondaryButton" type="button" onClick={onClose}>完成</button>
          </div>
        </section>
      </div>
    );
  }

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
            <button
              className="dangerButton"
              disabled={busy}
              type="button"
              onClick={() => onConfirmDeleteGroup(dialog.groupLabel, dialog.returnToManage)}
            >
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
      <SortableGroupPicker
        activeValue={dialog.kind === "create" ? dialog.group.trim() : dialog.value.trim()}
        busy={busy}
        options={groupOptions}
        onOrderChange={onGroupOrderChange}
        onSelect={(option) => {
          if (dialog.kind === "create") {
            setCreatingGroup(false);
            onChange({ ...dialog, group: option.value });
            return;
          }
          onQuickGroup(dialog.account, option.value);
        }}
      >
        {dialog.kind === "create" ? (
          <button
            aria-controls="cloak-new-group-name"
            aria-expanded={creatingGroup}
            className="groupOption groupOptionCreate"
            disabled={busy}
            title="输入一个新的分组名称"
            type="button"
            onClick={() => {
              setCreatingGroup(true);
              if (dialog.group) onChange({ ...dialog, group: "" });
            }}
          >
            <Plus aria-hidden="true" size={13} />
            <span>新建分组</span>
          </button>
        ) : null}
        {dialog.kind === "create" && creatingGroup ? (
          <div className="groupCreateEditor">
            <label htmlFor="cloak-new-group-name">新分组名称</label>
            <div className="groupCreateControls">
              <input
                aria-label="新分组名称"
                autoComplete="off"
                autoFocus
                id="cloak-new-group-name"
                placeholder="例如：client-a"
                value={dialog.group}
                onChange={(event) => onChange({ ...dialog, group: event.currentTarget.value })}
              />
              <button
                className="secondaryButton"
                disabled={!dialog.group.trim()}
                type="button"
                onClick={() => {
                  if (onCreateGroup(dialog.group)) setCreatingGroup(false);
                }}
              >
                创建分组
              </button>
            </div>
            <small>可先创建空分组；创建账号时也会自动保存并选中该分组。</small>
          </div>
        ) : null}
      </SortableGroupPicker>
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
        {dialog.kind === "mark" ? (
          <MarkPresetPicker
            activeValue={dialog.value.trim()}
            activeColor={dialog.color}
            busy={busy}
            onActiveColorChange={(color) => onChange({ ...dialog, color })}
            onApply={(value) => onQuickMark(dialog.account, value, dialog.color)}
          />
        ) : null}
        <label className="field">
          <span>{config.label}</span>
          {dialog.kind === "note" ? (
            <>
              <textarea
                autoFocus
                maxLength={maxNoteLength}
                placeholder={config.placeholder}
                rows={7}
                value={dialog.value}
                onChange={(event) => onChange({ ...dialog, value: event.currentTarget.value })}
              />
              <small className="fieldCounter">{dialog.value.length}/{maxNoteLength}</small>
            </>
          ) : (
            <input
              aria-describedby={
                dialog.kind === "create" && error && !dialog.value.trim()
                  ? "cloak-account-name-error"
                  : undefined
              }
              aria-invalid={dialog.kind === "create" && Boolean(error) && !dialog.value.trim() ? true : undefined}
              aria-required={["create", "createGroup", "renameGroup"].includes(dialog.kind) ? true : undefined}
              autoFocus
              id={dialog.kind === "create" ? "cloak-account-name" : undefined}
              maxLength={dialog.kind === "mark"
                ? maxMarkLength
                : dialog.kind === "createGroup" || dialog.kind === "renameGroup"
                  ? maxGroupLength
                  : undefined}
              value={dialog.value}
              placeholder={config.placeholder}
              onChange={(event) => onChange({ ...dialog, value: event.currentTarget.value })}
            />
          )}
        </label>
        {dialog.kind === "create" ? groupPicker : null}
        {error ? (
          <p
            className="modalError"
            id={dialog.kind === "create" && !dialog.value.trim() ? "cloak-account-name-error" : undefined}
            role="alert"
          >
            {error}
          </p>
        ) : null}
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

function SortableGroupPicker({
  activeValue,
  busy,
  children,
  onOrderChange,
  onSelect,
  options,
}: {
  activeValue: string;
  busy: boolean;
  children?: ReactNode;
  onOrderChange: (labels: string[]) => void;
  onSelect: (option: GroupOption) => void;
  options: GroupOption[];
}) {
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<GroupPointerDrag | null>(null);
  const dropTargetRef = useRef<GroupDropTarget | null>(null);
  const previewOrderRef = useRef<string[] | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const positionsRef = useRef<Map<string, { left: number; top: number }>>(new Map());
  const [draggingLabel, setDraggingLabel] = useState("");
  const [pressedLabel, setPressedLabel] = useState("");
  const [dropTarget, setDropTarget] = useState<GroupDropTarget | null>(null);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const optionsKey = options.map((option) => option.label).join("\u0000");
  const optionsByLabel = useMemo(
    () => new Map(options.map((option) => [option.label, option])),
    [options],
  );
  const displayedOptions = (previewOrder ?? options.map((option) => option.label))
    .map((label) => optionsByLabel.get(label))
    .filter((option): option is GroupOption => Boolean(option));

  function capturePositions() {
    const next = new Map<string, { left: number; top: number }>();
    pickerRef.current
      ?.querySelectorAll<HTMLElement>(".groupOption[data-group-label]")
      .forEach((option) => {
        const label = option.dataset.groupLabel ?? "";
        if (!label) return;
        const bounds = option.getBoundingClientRect();
        next.set(label, { left: bounds.left, top: bounds.top });
      });
    positionsRef.current = next;
  }

  useLayoutEffect(() => {
    const previous = positionsRef.current;
    positionsRef.current = new Map();
    if (previous.size === 0) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    pickerRef.current
      ?.querySelectorAll<HTMLElement>(".groupOption[data-group-label]")
      .forEach((option) => {
        const label = option.dataset.groupLabel ?? "";
        if (!label || label === draggingLabel || typeof option.animate !== "function") return;
        const before = previous.get(label);
        if (!before) return;
        const after = option.getBoundingClientRect();
        const deltaX = before.left - after.left;
        const deltaY = before.top - after.top;
        if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
        option.animate(
          [{ transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
          { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      });
  }, [draggingLabel, optionsKey, previewOrder]);

  function resolveDropTarget(clientX: number, clientY: number, sourceLabel: string): GroupDropTarget | null {
    const candidates = Array.from(
      pickerRef.current?.querySelectorAll<HTMLElement>(".groupOption[data-group-label]") ?? [],
    ).filter((option) => option.dataset.groupLabel !== sourceLabel);
    if (candidates.length === 0) return null;
    const hit = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)
      ?.closest<HTMLElement>(".groupOption[data-group-label]");
    let target = hit && hit.dataset.groupLabel !== sourceLabel && pickerRef.current?.contains(hit) ? hit : null;
    if (!target) {
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        const bounds = candidate.getBoundingClientRect();
        const deltaX = clientX - (bounds.left + bounds.width / 2);
        const deltaY = clientY - (bounds.top + bounds.height / 2);
        const distance = deltaX * deltaX + deltaY * deltaY;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          target = candidate;
        }
      }
    }
    const label = target?.dataset.groupLabel ?? "";
    if (!target || !label) return null;
    const bounds = target.getBoundingClientRect();
    const centerY = bounds.top + bounds.height / 2;
    const verticalOffset = clientY - centerY;
    const edge = Math.abs(verticalOffset) > bounds.height * 0.35
      ? verticalOffset > 0 ? "after" : "before"
      : clientX >= bounds.left + bounds.width / 2 ? "after" : "before";
    return { label, edge };
  }

  function updateDestination(clientX: number, clientY: number, drag: GroupPointerDrag) {
    const target = resolveDropTarget(clientX, clientY, drag.label);
    const currentTarget = dropTargetRef.current;
    if (currentTarget?.label === target?.label && currentTarget?.edge === target?.edge) return;
    dropTargetRef.current = target;
    setDropTarget(target);
    if (!target) return;
    const currentOrder = previewOrderRef.current ?? drag.initialOrder;
    const nextOrder = reorderLabelList(currentOrder, drag.label, target.label, target.edge);
    if (nextOrder.every((label, index) => label === currentOrder[index])) return;
    capturePositions();
    previewOrderRef.current = nextOrder;
    setPreviewOrder(nextOrder);
  }

  function schedulePreview() {
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = null;
      const drag = dragRef.current;
      if (!drag?.active) return;
      updateDestination(drag.latestX, drag.latestY, drag);
      const preview = previewRef.current;
      if (!preview) return;
      const x = Math.round(drag.latestX - drag.grabOffsetX);
      const y = Math.round(drag.latestY - drag.grabOffsetY);
      preview.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.018)`;
    });
  }

  function startPointerDrag(event: PointerEvent<HTMLElement>, option: GroupOption) {
    if (busy || event.button !== 0 || event.isPrimary === false) return;
    const optionElement = event.currentTarget.closest<HTMLButtonElement>(".groupOption[data-group-label]");
    const captureElement = pickerRef.current;
    if (!optionElement || !captureElement) return;
    const bounds = optionElement.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    optionElement.focus({ preventScroll: true });
    captureElement.setPointerCapture(event.pointerId);
    dragRef.current = {
      label: option.label,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      grabOffsetX: event.clientX - bounds.left,
      grabOffsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
      active: false,
      initialOrder: options.map((item) => item.label),
      captureElement,
    };
    dropTargetRef.current = null;
    previewOrderRef.current = null;
    setDropTarget(null);
    setPreviewOrder(null);
    setPressedLabel(option.label);
  }

  function movePointerDrag(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.latestX = event.clientX;
    drag.latestY = event.clientY;
    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < groupDragActivationDistance) return;
      drag.active = true;
      setPressedLabel("");
      setDraggingLabel(drag.label);
      updateDestination(event.clientX, event.clientY, drag);
    }
    event.preventDefault();
    event.stopPropagation();
    schedulePreview();
  }

  function clearPointerDrag() {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    dropTargetRef.current = null;
    previewOrderRef.current = null;
    setPressedLabel("");
    setDraggingLabel("");
    setDropTarget(null);
    setPreviewOrder(null);
  }

  function finishPointerDrag(event: PointerEvent<HTMLElement>, cancelled: boolean) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const releaseMoved = event.clientX !== drag.latestX || event.clientY !== drag.latestY;
    if (drag.active && !cancelled && (releaseMoved || !dropTargetRef.current)) {
      drag.latestX = event.clientX;
      drag.latestY = event.clientY;
      updateDestination(event.clientX, event.clientY, drag);
    }
    const nextOrder = previewOrderRef.current ?? drag.initialOrder;
    dragRef.current = null;
    if (drag.captureElement.hasPointerCapture(event.pointerId)) {
      drag.captureElement.releasePointerCapture(event.pointerId);
    }
    if (drag.active) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (!cancelled && nextOrder.some((label, index) => label !== drag.initialOrder[index])) {
        onOrderChange(nextOrder);
        setAnnouncement(`${drag.label} 分组顺序已调整`);
      }
    }
    clearPointerDrag();
  }

  function cancelPointerDrag() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.captureElement.hasPointerCapture(drag.pointerId)) {
      drag.captureElement.releasePointerCapture(drag.pointerId);
    }
    clearPointerDrag();
  }

  useEffect(() => {
    if (!draggingLabel) return;
    function cancelOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelPointerDrag();
    }
    window.addEventListener("keydown", cancelOnEscape, true);
    return () => window.removeEventListener("keydown", cancelOnEscape, true);
  }, [draggingLabel]);

  useEffect(() => () => {
    if (previewFrameRef.current !== null) window.cancelAnimationFrame(previewFrameRef.current);
    const drag = dragRef.current;
    if (drag?.captureElement.hasPointerCapture(drag.pointerId)) {
      drag.captureElement.releasePointerCapture(drag.pointerId);
    }
  }, []);

  function moveFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, option: GroupOption) {
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const labels = options.map((item) => item.label);
    const sourceIndex = labels.indexOf(option.label);
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const targetIndex = sourceIndex + direction;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= labels.length) {
      setAnnouncement(`${option.label} 分组已在${direction < 0 ? "最前" : "最后"}`);
      return;
    }
    capturePositions();
    const nextOrder = [...labels];
    nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, option.label);
    onOrderChange(nextOrder);
    setAnnouncement(`${option.label} 分组已移至第 ${targetIndex + 1} 位`);
  }

  const activeDrag = dragRef.current;
  const previewStyle: CSSProperties | null = activeDrag?.active
    ? {
        width: activeDrag.width,
        height: activeDrag.height,
        transform: `translate3d(${Math.round(activeDrag.latestX - activeDrag.grabOffsetX)}px, ${Math.round(activeDrag.latestY - activeDrag.grabOffsetY)}px, 0) scale(1.018)`,
      }
    : null;

  return (
    <div
      aria-describedby="cloak-group-order-hint"
      aria-label="可选分组"
      className={`groupPicker ${draggingLabel ? "dragging" : ""}`}
      onLostPointerCapture={(event) => finishPointerDrag(event, true)}
      onPointerCancel={(event) => finishPointerDrag(event, true)}
      onPointerMove={movePointerDrag}
      onPointerUp={(event) => finishPointerDrag(event, false)}
      ref={pickerRef}
      role="group"
    >
      <span className="groupPickerHeader">
        <span className="groupPickerLabel">分组</span>
        <small className="groupPickerHint" id="cloak-group-order-hint">
          <GripVertical aria-hidden="true" size={11} />
          拖动手柄排序
        </small>
      </span>
      {displayedOptions.map((option) => {
        const isActive = option.value === activeValue || (!option.value && !activeValue);
        const reorderEdge = dropTarget?.label === option.label ? dropTarget.edge : undefined;
        return (
          <button
            aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
            aria-pressed={isActive}
            className={`groupOption ${isActive ? "active" : ""} ${pressedLabel === option.label ? "pressed" : ""} ${draggingLabel === option.label ? "dragOrigin" : ""} ${reorderEdge ? "reorderTarget" : ""}`}
            data-drop-edge={reorderEdge}
            data-group-label={option.label}
            disabled={busy}
            key={option.label}
            title="点击选择；拖动左侧手柄排序；⌥← / ⌥→ 微调"
            type="button"
            onClick={(event) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              if ((event.target as HTMLElement).closest(".groupOptionDragHandle")) return;
              onSelect(option);
            }}
            onKeyDown={(event) => moveFromKeyboard(event, option)}
          >
            <span
              aria-hidden="true"
              className="groupOptionDragHandle"
              title="拖动调整分组顺序"
              onPointerDown={(event) => startPointerDrag(event, option)}
            >
              <GripVertical size={11} />
            </span>
            <Folder aria-hidden="true" size={13} />
            <span>{option.label}</span>
          </button>
        );
      })}
      {children}
      {draggingLabel && activeDrag?.active && previewStyle ? (
        <div aria-hidden="true" className="groupPickerDragPreview" ref={previewRef} style={previewStyle}>
          <span className="groupOptionDragHandle"><GripVertical size={11} /></span>
          <Folder size={13} />
          <strong>{middleTruncate(draggingLabel, 28)}</strong>
        </div>
      ) : null}
      <span aria-atomic="true" aria-live="polite" className="visuallyHidden" role="status">
        {announcement}
      </span>
    </div>
  );
}

function ManageMarkPresets({ busy }: { busy: boolean }) {
  const [presets, setPresets] = useState<string[]>(readStoredMarkPresets);
  const [newPreset, setNewPreset] = useState("");
  const [editingPreset, setEditingPreset] = useState("");
  const [editingValue, setEditingValue] = useState("");
  const [presetError, setPresetError] = useState("");
  const builtInLabels = new Set<string>(defaultMarkPresets);

  function persistPresets(next: string[]) {
    setPresets(next);
    writeStoredMarkPresets(next);
  }

  function addPreset() {
    const value = normalizeMarkPreset(newPreset);
    if (!value) {
      setPresetError(`请输入 1–${maxMarkLength} 个字符的标签。`);
      return;
    }
    if (presets.includes(value)) {
      setPresetError(`标签“${value}”已经存在。`);
      return;
    }
    persistPresets([...presets, value]);
    setNewPreset("");
    setPresetError("");
  }

  function beginRenamePreset(value: string) {
    setEditingPreset(value);
    setEditingValue(value);
    setPresetError("");
  }

  function renamePreset() {
    const value = normalizeMarkPreset(editingValue);
    if (!value) {
      setPresetError(`请输入 1–${maxMarkLength} 个字符的标签。`);
      return;
    }
    if (value !== editingPreset && presets.includes(value)) {
      setPresetError(`标签“${value}”已经存在。`);
      return;
    }
    persistPresets(presets.map((preset) => (preset === editingPreset ? value : preset)));
    setEditingPreset("");
    setEditingValue("");
    setPresetError("");
  }

  function removePreset(value: string) {
    persistPresets(presets.filter((preset) => preset !== value));
    if (editingPreset === value) {
      setEditingPreset("");
      setEditingValue("");
    }
    setPresetError("");
  }

  return (
    <section aria-label="标签管理" className="manageSection" id="cloak-manage-marks" role="tabpanel">
      <div className="manageSectionHeader">
        <div>
          <strong>常用标签</strong>
          <span>用于标记账号时的一键快捷项；删除快捷项不会改动账号已有标记。</span>
        </div>
      </div>
      <form
        className="manageAddRow"
        onSubmit={(event) => {
          event.preventDefault();
          addPreset();
        }}
      >
        <input
          aria-label="新标签名称"
          autoComplete="off"
          disabled={busy}
          maxLength={maxMarkLength}
          placeholder="输入常用标签"
          value={newPreset}
          onChange={(event) => {
            setNewPreset(event.currentTarget.value);
            setPresetError("");
          }}
        />
        <button className="primaryButton" disabled={busy || !newPreset.trim()} type="submit">
          <Plus aria-hidden="true" size={13} />
          新增标签
        </button>
      </form>
      {presetError ? <p className="manageInlineError" role="alert">{presetError}</p> : null}
      <div className="manageList">
        {presets.map((preset) => {
          const isBuiltIn = builtInLabels.has(preset);
          const isEditing = editingPreset === preset;
          return (
            <div className={`manageRow ${isEditing ? "editing" : ""}`} key={preset}>
              <span className="manageRowIcon label" aria-hidden="true"><Tag size={14} /></span>
              {isEditing ? (
                <input
                  aria-label={`标签 ${preset} 的新名称`}
                  autoFocus
                  className="manageInlineInput"
                  disabled={busy}
                  maxLength={maxMarkLength}
                  value={editingValue}
                  onChange={(event) => {
                    setEditingValue(event.currentTarget.value);
                    setPresetError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      renamePreset();
                    } else if (event.key === "Escape") {
                      event.stopPropagation();
                      setEditingPreset("");
                      setEditingValue("");
                      setPresetError("");
                    }
                  }}
                />
              ) : (
                <span className="manageRowMain">
                  <strong title={preset}>{middleTruncate(preset, 34)}</strong>
                  <small>{isBuiltIn ? "内置快捷项" : "自定义快捷项"}</small>
                </span>
              )}
              <span className="manageRowActions">
                {isEditing ? (
                  <>
                    <button
                      aria-label={`保存标签 ${preset}`}
                      className="manageRowAction confirm"
                      disabled={busy || !editingValue.trim()}
                      title="保存"
                      type="button"
                      onClick={renamePreset}
                    >
                      <Check aria-hidden="true" size={13} />
                    </button>
                    <button
                      aria-label={`取消重命名标签 ${preset}`}
                      className="manageRowAction"
                      disabled={busy}
                      title="取消"
                      type="button"
                      onClick={() => {
                        setEditingPreset("");
                        setEditingValue("");
                        setPresetError("");
                      }}
                    >
                      <X aria-hidden="true" size={13} />
                    </button>
                  </>
                ) : isBuiltIn ? (
                  <span className="manageBuiltInBadge">内置</span>
                ) : (
                  <>
                    <button
                      aria-label={`重命名标签 ${preset}`}
                      className="manageRowAction"
                      disabled={busy}
                      title="重命名"
                      type="button"
                      onClick={() => beginRenamePreset(preset)}
                    >
                      <Pencil aria-hidden="true" size={13} />
                    </button>
                    <button
                      aria-label={`删除标签 ${preset}`}
                      className="manageRowAction danger"
                      disabled={busy}
                      title="删除快捷项，不改动账号标记"
                      type="button"
                      onClick={() => removePreset(preset)}
                    >
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MarkPresetPicker({
  activeValue,
  activeColor,
  busy,
  onActiveColorChange,
  onApply,
}: {
  activeValue: string;
  activeColor: MarkColor;
  busy: boolean;
  onActiveColorChange: (color: MarkColor) => void;
  onApply: (value: string) => void;
}) {
  const [presets, setPresets] = useState<string[]>(readStoredMarkPresets);
  const [addingPreset, setAddingPreset] = useState(false);
  const [newPreset, setNewPreset] = useState("");
  const newPresetInputRef = useRef<HTMLInputElement | null>(null);
  const normalizedNewPreset = normalizeMarkPreset(newPreset);
  const canAddPreset = Boolean(normalizedNewPreset && !presets.includes(normalizedNewPreset));
  const builtInLabels = new Set<string>(defaultMarkPresets);

  useEffect(() => {
    if (!addingPreset) return;
    newPresetInputRef.current?.focus();
  }, [addingPreset]);

  function addPreset() {
    if (!normalizedNewPreset || presets.includes(normalizedNewPreset)) return;
    const next = [...presets, normalizedNewPreset];
    setPresets(next);
    writeStoredMarkPresets(next);
    setNewPreset("");
    setAddingPreset(false);
  }

  function removePreset(value: string) {
    const next = presets.filter((preset) => preset !== value);
    setPresets(next);
    writeStoredMarkPresets(next);
  }

  return (
    <section className="markPresetPicker" aria-label="快捷标记">
      <div className="markPresetHeader">
        <span className="markPresetLabel">快捷标记</span>
        <span className="markPresetHint">使用下方颜色，点击即保存</span>
      </div>
      <div className="markPresetList">
        {presets.map((preset) => {
          const isCustom = !builtInLabels.has(preset);
          const isActive = activeValue === preset;
          return (
            <span className={`markPresetItem ${isActive ? "active" : ""}`} key={preset}>
              <button
                aria-label={`使用快捷标记 ${preset}，采用当前${markColorLabel(activeColor)}，立即保存`}
                aria-pressed={isActive}
                className="markPresetApply"
                disabled={busy}
                type="button"
                onClick={() => onApply(preset)}
              >
                <span className="markPresetDot" aria-hidden="true" />
                <span>{preset}</span>
              </button>
              {isCustom ? (
                <button
                  aria-label={`删除快捷标记 ${preset}`}
                  className="markPresetRemove"
                  disabled={busy}
                  title="只删除快捷项，不更改账号标记"
                  type="button"
                  onClick={() => removePreset(preset)}
                >
                  <X aria-hidden="true" size={12} />
                </button>
              ) : null}
            </span>
          );
        })}
        <button
          className="markPresetAdd"
          disabled={busy}
          type="button"
          onClick={() => setAddingPreset((current) => !current)}
        >
          <Plus aria-hidden="true" size={13} />
          新增快捷项
        </button>
      </div>
      {addingPreset ? (
        <div className="markPresetEditor">
          <input
            aria-label="新的快捷标记"
            autoComplete="off"
            maxLength={maxMarkLength}
            placeholder="输入常用标记"
            ref={newPresetInputRef}
            value={newPreset}
            onChange={(event) => setNewPreset(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addPreset();
            }}
          />
          <button className="secondaryButton" type="button" onClick={() => setAddingPreset(false)}>
            取消新增
          </button>
          <button className="primaryButton" disabled={!canAddPreset} type="button" onClick={addPreset}>
            添加
          </button>
        </div>
      ) : null}
      <div className="markCurrentColor">
        <div className="markColorEditorHeader">
          <span>当前标记颜色</span>
          <span className="markCurrentColorName" style={markColorStyle(activeColor)}>
            <span aria-hidden="true" />
            {markColorLabel(activeColor)}
          </span>
        </div>
        <MarkColorPicker
          ariaLabel="选择当前标记颜色"
          buttonLabelPrefix="使用"
          busy={busy}
          value={activeColor}
          onChange={onActiveColorChange}
        />
      </div>
    </section>
  );
}

function MarkColorPicker({
  ariaLabel,
  buttonLabelPrefix,
  busy,
  value,
  onChange,
}: {
  ariaLabel: string;
  buttonLabelPrefix: string;
  busy: boolean;
  value: MarkColor;
  onChange: (color: MarkColor) => void;
}) {
  return (
    <div className="markColorPalette" role="radiogroup" aria-label={ariaLabel}>
      {markColorValues.map((color) => {
        const isActive = color === value;
        return (
          <button
            aria-checked={isActive}
            aria-label={`${buttonLabelPrefix}${markColorLabel(color)}`}
            className={`markColorOption ${isActive ? "active" : ""}`}
            disabled={busy}
            key={color}
            role="radio"
            style={markColorStyle(color)}
            type="button"
            onClick={() => onChange(color)}
          >
            <span className="markColorOptionDot" aria-hidden="true" />
            <span>{markColorLabel(color)}</span>
            {isActive ? <Check aria-hidden="true" size={12} /> : null}
          </button>
        );
      })}
    </div>
  );
}

function dialogConfig(
  dialog: Exclude<DialogState, { kind: "delete" } | { kind: "permanentDelete" } | { kind: "deleteGroup" } | { kind: "manage" }>,
): {
  title: string;
  label: string;
  placeholder: string;
  action: string;
  description?: string;
} {
  switch (dialog.kind) {
    case "create":
      return { title: "新建账号", label: "名称（必填）", placeholder: "例如：work_01", action: "创建账号" };
    case "createGroup":
      return {
        title: "新建分组",
        label: "分组名称",
        placeholder: "例如：client-a",
        action: "创建分组",
        description: "新分组会追加到当前分组顺序末尾，之后可直接拖动调整位置。",
      };
    case "rename": {
      const accountName = middleTruncate(dialog.account.name, 28);
      return { title: `重命名「${accountName}」`, label: "新名称", placeholder: dialog.account.name, action: "保存" };
    }
    case "renameGroup": {
      const groupLabel = middleTruncate(dialog.groupLabel, 28);
      return {
        title: `重命名分组「${groupLabel}」`,
        label: "新分组名称",
        placeholder: dialog.groupLabel,
        action: "保存名称",
        description: dialog.count > 0
          ? `会同步更新该分组下 ${dialog.count} 个账号，分组顺序保持不变。`
          : "空分组会原位改名，分组顺序保持不变。",
      };
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
    case "note": {
      const accountName = middleTruncate(dialog.account.name, 28);
      return {
        title: `${dialog.account.note ? "编辑" : "写"}备注「${accountName}」`,
        label: "备注内容",
        placeholder: "记录用途、登录状态、客户偏好或下次要处理的事项…",
        action: !dialog.value.trim() && dialog.account.note ? "清除备注" : "保存备注",
        description: "支持多行，最多 1000 个字符；备注只保存在这个账号的本地目录中。",
      };
    }
    case "mark": {
      const accountName = middleTruncate(dialog.account.name, 28);
      return {
        title: `标记「${accountName}」`,
        label: "标记内容（可选，最多 24 个字符）",
        placeholder: "例如：待处理 / 备用 / 已验证",
        action: "保存标记",
        description: "可选择标记颜色；不输入文字时只显示圆点，输入后会显示彩色标记。",
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
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`actionButton ${danger ? "dangerText" : ""}`}
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
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

function InfoRow({
  icon,
  label,
  value,
  mono,
  multiline,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="infoRow">
      <span className="infoLabel">
        {icon}
        {label}
      </span>
      <span className={`infoValue ${mono ? "mono" : ""} ${multiline ? "multiline" : ""}`} title={value}>
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

function compareAccountsByCreatedAt(left: Account, right: Account) {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
  return left.name.localeCompare(right.name);
}

function compareAccountsByDeletedAt(left: Account, right: Account) {
  const leftDeletedAt = left.deleted_at ?? 0;
  const rightDeletedAt = right.deleted_at ?? 0;
  if (leftDeletedAt !== rightDeletedAt) return leftDeletedAt < rightDeletedAt ? 1 : -1;
  return compareAccountsByCreatedAt(left, right);
}

function normalizeAccountSearch(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function accountSearchRank(account: Account, normalizedSearch: string): number | null {
  const name = normalizeAccountSearch(account.name);
  const metadata = [account.group ?? "", account.mark_note ?? "", account.note ?? ""].map(normalizeAccountSearch);
  if (name === normalizedSearch) return 0;
  if (metadata.some((value) => value === normalizedSearch)) return 1;
  if (name.startsWith(normalizedSearch)) return 2;
  if (metadata.some((value) => value.startsWith(normalizedSearch))) return 3;
  if (name.includes(normalizedSearch)) return 4;
  if (metadata.some((value) => value.includes(normalizedSearch))) return 5;
  return null;
}

function searchAccounts(accounts: Account[], normalizedSearch: string): Account[] {
  return accounts
    .map((account, index) => ({ account, index, rank: accountSearchRank(account, normalizedSearch) }))
    .filter((result): result is { account: Account; index: number; rank: number } => result.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((result) => result.account);
}

function orderAccounts(accounts: Account[], accountOrder: string[]): Account[] {
  const accountsByName = new Map(accounts.map((account) => [account.name, account]));
  return orderedAccountNames(accounts, accountOrder)
    .map((name) => accountsByName.get(name))
    .filter((account): account is Account => Boolean(account));
}

function orderAccountsForView(accounts: Account[], accountOrder: string[], view: AccountView): Account[] {
  return view === "trash"
    ? [...accounts].sort(compareAccountsByDeletedAt)
    : orderAccounts(accounts, accountOrder);
}

/// Order to persist. Unlike orderedAccountNames this keeps entries it does not
/// recognise: callers only ever hold one view's accounts, so dropping unknown
/// names would erase the saved position of every account in the other view —
/// reordering once in the active list wiped the trash's order, and creating an
/// account while viewing the trash wiped the active list's.
function mergedAccountOrder(currentOrder: string[], accounts: Account[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of currentOrder) {
    if (seen.has(name)) continue;
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

/// Order to render: restricted to the accounts actually on screen.
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
  const names = mergedAccountOrder(currentOrder, accounts).filter((name) => name !== source);
  const targetIndex = names.indexOf(target);
  if (targetIndex < 0) return currentOrder;
  names.splice(targetIndex + (edge === "after" ? 1 : 0), 0, source);
  return names;
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

function buildGroupOptions(accounts: Account[], groupOrder: string[], hiddenGroups: string[]): GroupOption[] {
  const labels = [ungroupedLabel];
  const seen = new Set<string>(labels);
  const hidden = new Set(hiddenGroups);
  for (const account of accounts) {
    const label = account.group?.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  for (const rawLabel of groupOrder) {
    const label = rawLabel.trim();
    if (!label || label === allGroupsLabel || label === allGroupsValue || seen.has(label) || hidden.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  for (const label of commonGroups) {
    if (seen.has(label) || hidden.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return orderGroupLabels(labels, groupOrder).map((label) => ({
    label,
    value: label === ungroupedLabel ? "" : label,
  }));
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
  for (const rawLabel of groupOrder) {
    const label = rawLabel.trim();
    if (!label || label === allGroupsLabel || label === allGroupsValue || hidden.has(label)) continue;
    if (!counts.has(label)) counts.set(label, 0);
  }
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

function buildManagedGroups(
  activeAccounts: Account[],
  trashedAccounts: Account[],
  groupOrder: string[],
  hiddenGroups: string[],
): ManagedGroup[] {
  const activeLabels = buildGroupFilters(activeAccounts, groupOrder, hiddenGroups)
    .filter((group) => group.value !== allGroupsValue && group.label !== ungroupedLabel)
    .map((group) => group.label);
  const allGroups = buildGroupFilters([...activeAccounts, ...trashedAccounts], groupOrder, hiddenGroups)
    .filter((group) => group.value !== allGroupsValue && group.label !== ungroupedLabel);
  const counts = new Map(allGroups.map((group) => [group.label, group.count]));
  const labels = orderGroupLabels(
    allGroups.map((group) => group.label),
    [...groupOrder, ...activeLabels],
  );
  return labels.map((label) => ({ label, count: counts.get(label) ?? 0 }));
}

function orderGroupLabels(labels: string[], groupOrder: string[]): string[] {
  const known = new Set(labels);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const label of groupOrder) {
    if (!known.has(label) || seen.has(label)) continue;
    seen.add(label);
    ordered.push(label);
  }
  const remaining = labels.filter((label) => !seen.has(label));
  return [...ordered, ...remaining];
}

function appendNewGroup(currentOrder: string[], filters: GroupFilter[], label: string): string[] {
  const existingLabels = filters
    .filter((group) => group.value !== allGroupsValue)
    .map((group) => group.label);
  if (existingLabels.includes(label)) return currentOrder;
  return [...orderGroupLabels(existingLabels, currentOrder), label];
}

function renameGroupInOrder(
  currentOrder: string[],
  labels: string[],
  source: string,
  target: string,
): string[] {
  const seen = new Set<string>();
  const renamed: string[] = [];
  for (const label of orderGroupLabels(labels, currentOrder)) {
    const nextLabel = label === source ? target : label;
    if (seen.has(nextLabel)) continue;
    seen.add(nextLabel);
    renamed.push(nextLabel);
  }
  return renamed;
}

function reorderGroupLabels(
  currentOrder: string[],
  filters: GroupFilter[],
  source: string,
  target: string,
  edge: GroupDropTarget["edge"],
): string[] {
  if (!source || source === target || target === allGroupsLabel) return currentOrder;
  const effectiveOrder = orderGroupLabels(
    filters.filter((group) => group.value !== allGroupsValue).map((group) => group.label),
    currentOrder,
  );
  const labels = effectiveOrder.filter((label) => label !== source);
  const targetIndex = labels.indexOf(target);
  labels.splice(targetIndex >= 0 ? targetIndex + (edge === "after" ? 1 : 0) : labels.length, 0, source);
  if (labels.every((label, index) => label === effectiveOrder[index])) return currentOrder;
  return labels;
}

function reorderLabelList(
  labels: string[],
  source: string,
  target: string,
  edge: GroupDropTarget["edge"],
): string[] {
  if (!source || source === target) return labels;
  const next = labels.filter((label) => label !== source);
  const targetIndex = next.indexOf(target);
  if (targetIndex < 0) return labels;
  next.splice(targetIndex + (edge === "after" ? 1 : 0), 0, source);
  return next;
}

function toggleStringInArray(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function renameStringInArray(values: string[], source: string, target: string): string[] {
  const seen = new Set<string>();
  const renamed: string[] = [];
  for (const value of values) {
    const nextValue = value === source ? target : value;
    if (seen.has(nextValue)) continue;
    seen.add(nextValue);
    renamed.push(nextValue);
  }
  return renamed;
}

function groupNameError(value: string): string {
  if (!value) return "请输入分组名称。";
  if (value.length > maxGroupLength) return `分组名称不能超过 ${maxGroupLength} 个字符。`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return "分组名称不能包含换行或控制字符。";
  if ([allGroupsLabel, allGroupsValue, ungroupedLabel].includes(value)) {
    return `“${value}”是系统保留名称，请换一个分组名称。`;
  }
  return "";
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

function normalizeMarkPreset(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxMarkLength || /[\r\n]/.test(normalized)) return null;
  return normalized;
}

function readStoredMarkPresets(): string[] {
  const defaults = [...defaultMarkPresets];
  try {
    const raw = window.localStorage.getItem(markPresetsStorageKey);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? normalizeMarkPresets(parsed, defaults) : defaults;
    }

    const colorAwareRaw = window.localStorage.getItem(colorAwareMarkPresetsStorageKey);
    if (colorAwareRaw !== null) {
      const parsed: unknown = JSON.parse(colorAwareRaw);
      return Array.isArray(parsed) ? normalizeMarkPresets(parsed, defaults) : defaults;
    }
  } catch {
    return defaults;
  }

  return normalizeMarkPresets(readStoredStringArray(legacyMarkPresetsStorageKey), defaults);
}

function writeStoredMarkPresets(values: string[]) {
  const safeValues = normalizeMarkPresets(values, defaultMarkPresets);
  const builtInLabels = new Set<string>(defaultMarkPresets);
  writeStoredStringArray(markPresetsStorageKey, safeValues.filter((value) => !builtInLabels.has(value)));
}

function normalizeMarkPresets(values: unknown[], defaults: readonly string[]): string[] {
  const result = [...defaults];
  const seen = new Set<string>(result);
  for (const value of values) {
    const rawLabel = typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as { label?: unknown }).label
        : null;
    if (typeof rawLabel !== "string") continue;
    const label = normalizeMarkPreset(rawLabel);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }
  return result;
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
  return Math.min(accountContextMenuMaxHeight, 70 + optionCount * 32 + 132 + (marked ? 32 : 0));
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
  mockCommandCounts.set(command, (mockCommandCounts.get(command) ?? 0) + 1);
  const requestedName = String(args?.name ?? "");
  if (command === "cancel_launch") {
    if (requestedName) mockCancelledLaunches.add(requestedName);
    return true as T;
  }
  await new Promise((resolve) => window.setTimeout(resolve, 80));
  const failures = mockCommandFailures.get(command) ?? 0;
  if (failures > 0) {
    mockCommandFailures.set(command, failures - 1);
    throw new Error(`mock ${command} failed`);
  }
  const accounts = mockAccounts();
  if (command === "run_challenge_audit") {
    const cancelled = mockChallengeAuditCancelled;
    mockChallengeAuditCancelled = false;
    return {
      passed: !cancelled,
      cancelled,
      duration_ms: 2480,
      browser_sha256: "0".repeat(64),
      error: cancelled ? "审计浏览器已关闭，检查已结束" : null,
      results: [
        {
          name: "version-consistency",
          passed: true,
          details: { issues: [], challenge: { detected: false, blocked: false, kind: null } },
        },
        {
          name: "cloudflare-turnstile-test",
          passed: !cancelled,
          details: {
            apiLoaded: true,
            widgetCompleted: !cancelled,
            serverValidation: { success: !cancelled },
            challenge: { detected: true, blocked: false, kind: "turnstile-widget" },
          },
        },
      ],
    } as T;
  }
  if (command === "list_accounts") return accounts.filter((account) => !account.archived && !account.trashed) as T;
  if (command === "list_trashed_accounts") return accounts.filter((account) => account.trashed || account.archived) as T;
  if (command === "launch_dry_run" || command === "launch_preflight") {
    const name = String(args?.name ?? accounts[0].name);
    const account = accounts.find((item) => item.name === name) ?? accounts[0];
    return mockLaunchPlan(account, command === "launch_preflight") as T;
  }
  if (command === "launch_account" || command === "launch_web_store") {
    const name = String(args?.name ?? accounts[0].name);
    if (mockCancelledLaunches.delete(name)) {
      throw new Error("launch cancelled");
    }
    const account = accounts.find((item) => item.name === name) ?? accounts[0];
    const plan = mockLaunchPlan(account, true);
    return {
      account: account.name,
      profile_path: account.profile_path,
      browser_binary: plan.browser_binary,
      url: command === "launch_web_store" ? "https://chromewebstore.google.com/" : "https://chatgpt.com/",
      pid: 54321,
      launched_at: Date.now() * 1000,
      diagnostics: {
        engine_major: plan.engine_major,
        engine_version: plan.engine_version,
        proxy_mode: plan.proxy.mode,
        proxy_display: plan.proxy.display,
        exit_ip: plan.geo.exit_ip,
        country: plan.geo.country,
        timezone: plan.geo.timezone,
        geo_cache_hit: plan.geo_cache_hit,
        preflight_ms: 420,
        launch_ms: 180,
        capabilities: ["isolated-profile-storage", "stable-seed-fingerprint", "challenge-signal-reporting"],
      },
    } as T;
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
      mark_color: null,
      note: null,
    } as T;
  }
  if (command === "rename_account") return { ...accounts[0], name: String(args?.newName ?? "renamed") } as T;
  if (command === "restore_account") return { ...accounts[0], name: String(args?.name ?? accounts[0].name), archived: false, trashed: false } as T;
  if (command === "permanently_delete_account") return undefined as T;
  if (command === "set_group") {
    const name = String(args?.name ?? accounts[0].name);
    const group = (args?.value as string | null | undefined) ?? null;
    mockGroupOverrides.set(name, group);
    const account = accounts.find((item) => item.name === name) ?? accounts[0];
    return { ...account, name, group } as T;
  }
  if (command === "set_note") {
    const name = String(args?.name ?? accounts[0].name);
    const note = (args?.value as string | null | undefined) ?? null;
    mockNoteOverrides.set(name, note);
    const account = accounts.find((item) => item.name === name) ?? accounts[0];
    return { ...account, name, note } as T;
  }
  if (command === "set_mark") {
    const name = String(args?.name ?? accounts[0].name);
    const marked = Boolean(args?.marked);
    const note = (args?.note as string | null | undefined) ?? null;
    const color = marked ? parseMarkColor(args?.color) ?? "red" : null;
    mockMarkOverrides.set(name, { marked, note, color });
    const account = accounts.find((item) => item.name === name) ?? accounts[0];
    return { ...account, name, marked, mark_note: marked ? note : null, mark_color: color } as T;
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
      deleted_at: null,
      archived: false,
      trashed: false,
      seed: "48366",
      group: "codex",
      marked: true,
      mark_note: null,
      mark_color: null,
      note: "主账号；客户偏好日语。",
      region: null,
      locale_enabled: false,
      proxy_display: "关",
      has_proxy: false,
    },
    {
      name: "demo-beta",
      profile_path: "/Users/example/Library/Application Support/NoTrace Browser/Accounts/demo-beta",
      created_at: 1_700_000_002_000_000,
      deleted_at: null,
      archived: false,
      trashed: false,
      seed: "77296",
      group: "codex",
      marked: false,
      mark_note: null,
      mark_color: null,
      note: null,
      region: "JP",
      locale_enabled: true,
      proxy_display: "关",
      has_proxy: false,
    },
    {
      name: "demo-gamma",
      profile_path: "/Users/example/Library/Application Support/NoTrace Browser/Accounts/demo-gamma",
      created_at: 1_700_000_003_000_000,
      deleted_at: 1_700_100_000_000_000,
      archived: true,
      trashed: true,
      seed: "68098",
      group: "codex",
      marked: true,
      mark_note: "待检查",
      mark_color: "green",
      note: null,
      region: "US",
      locale_enabled: false,
      proxy_display: "socks5://proxy.example.net:1080（经本机 SOCKS5 中继）",
      has_proxy: true,
    },
    {
      name: "demo-gamma-copy",
      profile_path: "/Users/example/Library/Application Support/NoTrace Browser/Accounts/demo-gamma-copy",
      created_at: 1_700_000_003_500_000,
      deleted_at: null,
      archived: false,
      trashed: false,
      seed: "40127",
      group: "antigravity",
      marked: false,
      mark_note: null,
      mark_color: null,
      note: null,
      region: null,
      locale_enabled: false,
      proxy_display: "关",
      has_proxy: false,
    },
    {
      name: "old-lab",
      profile_path: "/Users/example/Library/Application Support/NoTrace Browser/Accounts/old-lab",
      created_at: 1_700_000_004_000_000,
      deleted_at: 1_700_200_000_000_000,
      archived: false,
      trashed: true,
      seed: "51024",
      group: null,
      marked: false,
      mark_note: null,
      mark_color: null,
      note: null,
      region: "NL",
      locale_enabled: false,
      proxy_display: "关",
      has_proxy: false,
    },
  ];
  return accounts.map((account) => {
    const group = mockGroupOverrides.has(account.name)
      ? mockGroupOverrides.get(account.name) ?? null
      : account.group;
    const mark = mockMarkOverrides.get(account.name);
    const withGroup = group === account.group ? account : { ...account, group };
    const withNote = mockNoteOverrides.has(account.name)
      ? { ...withGroup, note: mockNoteOverrides.get(account.name) ?? null }
      : withGroup;
    return mark
      ? {
          ...withNote,
          marked: mark.marked,
          mark_note: mark.marked ? mark.note : null,
          mark_color: mark.marked ? mark.color : null,
        }
      : withNote;
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
    engine_major: "145",
    engine_version: "145.0.7632.109",
    proxy: {
      mode: account.has_proxy ? "relay" : "none",
      display: account.proxy_display,
      browser_arg: account.has_proxy ? "socks5://127.0.0.1:<relay-port>" : null,
      relay_needed: account.has_proxy,
    },
    geo: full
      ? { exit_ip: "45.92.159.246", country: account.region, timezone: account.region === "JP" ? "Asia/Tokyo" : "America/Los_Angeles" }
      : { exit_ip: null, country: null, timezone: null },
    geo_cache_hit: false,
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

function sanitizeLaunchArg(arg: string) {
  if (arg.startsWith("--proxy-server=")) {
    return arg.replace(/(:\/\/)[^/@]+@/g, "$1•••@");
  }
  return arg;
}

function isLaunchCancelledError(message: string) {
  return message.toLocaleLowerCase().includes("launch cancelled")
    || message.includes("启动已取消");
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
  if (raw.includes("account mark color is invalid")) {
    return "标记颜色无效：请从绿、蓝、红中选择。";
  }
  if (raw.includes("account mark is invalid")) {
    return "标记内容无效：请使用不超过 24 个字符的单行文字。";
  }
  if (raw.includes("account note is invalid")) {
    return "备注内容无效：最多 1000 个字符，请移除不可见控制字符。";
  }
  if (raw.toLocaleLowerCase().includes("launch cancelled")) {
    return "启动已取消";
  }
  return raw;
}
