import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownUp, Download, FileJson, KeyRound, Link2, Loader2, RefreshCw, Search, UploadCloud } from "lucide-react";
import { authProgressLabels, type ActiveAuth, type AuthCall, type AuthLoginPhase, type AuthStatus } from "./AuthPanel";

export type BrokerMetadata = {
  key: string; email: string; account_id: string; plan_type: string | null;
  expires_at: number; last_refresh_at: number; generation: number;
  refresh_count?: number; automatic_refresh_count?: number;
  next_refresh_at: number; next_retry_at: number | null; error: string | null;
  cpa_enabled: boolean; cpa_synced_generation: number | null; cpa_sync_error: string | null; cpa_sync_suspended?: boolean;
  cockpit_synced_generation: number | null;
};
export type CodexQuotaWindow = {
  name: string; used_percent: number | null; remaining_percent: number | null;
  reset_at: number | null; window_minutes: number | null;
};
export type CodexQuotaSnapshot = {
  account_id: string; email: string; fetched_at: number; generation: number;
  windows: CodexQuotaWindow[]; reset_count: number | null; reset_count_available: boolean;
};
export type BrokerRow = { name: string; profile_id: string; trashed: boolean; local: AuthStatus; remote: BrokerMetadata | null };
export type BrokerOverview = { configured: boolean; endpoint: string | null; connected: boolean; message: string | null; accounts: BrokerRow[]; unmatched: BrokerMetadata[] };
type BrokerJsonFormat = "cockpit_tools" | "auth_json" | "cpa" | "sub2api";
type BrokerJsonTransferSummary = { path: string; format: string; account_count: number; refresh_token_exported: boolean };
type BrokerJsonImportSummary = { email: string; account_id: string; profile_id: string; generation: number };
type BrokerJsonPreviewAccount = { email: string | null; account_id: string | null; has_access_token: boolean; has_id_token: boolean; has_refresh_token: boolean };
type BrokerJsonPreview = { path: string; detected_format: string; account_count: number; accounts: BrokerJsonPreviewAccount[]; contains_refresh_token: boolean; message: string };
export type BrokerAccountFilter = "all" | "authorized" | "unauthorized" | "reauth_required";
export type BrokerAccountSort = "default" | "recent" | "expiry" | "name";
export type BrokerAuthorizationState = "authorized" | "never_authorized" | "reauth_required" | "unknown";
const nativeCall: AuthCall = (command, args) => invoke(command, args);
const jsonFormats: Array<{ value: BrokerJsonFormat; label: string }> = [
  { value: "auth_json", label: "官方 auth.json" },
  { value: "cockpit_tools", label: "Cockpit Tools" },
  { value: "cpa", label: "CPA" },
  { value: "sub2api", label: "Sub2API" },
];
const errors: Record<string, string> = {
  reauth_required: "授权已失效，需要重新授权",
  recovery_required: "上次刷新结果不确定，已停止重用旧凭据",
  service_unavailable: "授权服务暂不可用，按计划重试",
  consumer_conflict: "CPA 有手动凭据，未覆盖",
  identity_mismatch: "账号身份不匹配",
  storage: "服务器文件读写失败，请检查同步服务",
  unchanged: "尚未获得新的凭据",
  consumer_missing: "CPA 托管凭据已被删除，自动同步已暂停",
};
const authorityNames = { no_trace: "NoTrace 本机", codex: "Codex", cockpit: "Cockpit Tools", cpa: "CPA", broker: "NoTrace Broker" };
function time(value: number | null) {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}
function syncLabel(enabled: boolean, synced: number | null, generation: number, error: string | null) {
  if (error === "consumer_missing") return errors.consumer_missing;
  if (!enabled) return synced === generation ? "已暂停自动同步" : "待同步新凭据";
  if (error) return errors[error] ?? "同步未完成";
  return synced === generation ? "已同步" : "等待同步";
}
function refreshCountLabel(count: number | undefined) {
  return count === undefined ? "服务端尚未统计" : `${count} 次`;
}
function quotaPercent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${Math.round(value)}%`;
}
export function authorizationState(row: BrokerRow): BrokerAuthorizationState {
  if (row.remote) {
    return row.remote.error === "reauth_required" || row.remote.error === "recovery_required"
      ? "reauth_required"
      : "authorized";
  }
  if (row.local.authority === "broker") return "unknown";
  if (row.local.state === "missing") return "never_authorized";
  return row.local.state === "reauth_required" ? "reauth_required" : "authorized";
}
function authorizationFailureLabel(remote: BrokerMetadata): string {
  if (remote.error === "reauth_required") return "授权已失效，需要重新授权";
  if (remote.error === "recovery_required") return "授权链状态不确定，需要重新授权";
  return "授权已失效，需要重新授权";
}
export function BrokerPanel({ call = nativeCall, onBusyChange, embedded = false, focusedAccount = "", selectedProfileId, selectedAccount, accountVisible = true, searchControls, workbenchHeader, children, onOverviewChange, onImportedAccount }: {
  call?: AuthCall; onBusyChange?: (busy: boolean) => void; embedded?: boolean; focusedAccount?: string;
  selectedProfileId?: string; selectedAccount?: Pick<BrokerRow, "name" | "trashed">; accountVisible?: boolean; searchControls?: ReactNode; workbenchHeader?: ReactNode;
  children?: ReactNode; onOverviewChange?: (overview: BrokerOverview) => void;
  onImportedAccount?: (profileId: string) => void;
}) {
  const workbench = selectedProfileId !== undefined;
  const [overview, setOverview] = useState<BrokerOverview | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [cpaAction, setCpaAction] = useState<{ profileId: string; enabled: boolean; pending: boolean } | null>(null);
  const [quotaByProfile, setQuotaByProfile] = useState<Record<string, CodexQuotaSnapshot>>({});
  const [quotaLoadingProfile, setQuotaLoadingProfile] = useState<string | null>(null);
  const quotaRequestProfile = useRef<string | null>(null);
  const quotaAttempted = useRef(new Set<string>());
  const [quotaErrors, setQuotaErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [errorTarget, setErrorTarget] = useState("");
  const [activeAuth, setActiveAuth] = useState<ActiveAuth | null>(null);
  const [login, setLogin] = useState<{ name: string; phase: AuthLoginPhase | "handoff"; cancelling: boolean } | null>(null);
  const cancelRequested = useRef(false);
  const [exportRow, setExportRow] = useState<BrokerRow | null>(null);
  const [jsonFormat, setJsonFormat] = useState<BrokerJsonFormat>("auth_json");
  const [importPreview, setImportPreview] = useState<BrokerJsonPreview | null>(null);
  const [importMode, setImportMode] = useState<"manage" | "convert">("manage");
  const [importAccountIndex, setImportAccountIndex] = useState(0);
  const [preserveRefreshToken, setPreserveRefreshToken] = useState(false);
  const [clearImportedRefreshToken, setClearImportedRefreshToken] = useState(false);
  const [accountFilter, setAccountFilter] = useState<BrokerAccountFilter>("all");
  const [accountSearch, setAccountSearch] = useState(focusedAccount);
  const [accountSort, setAccountSort] = useState<BrokerAccountSort>("default");
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const overviewRef = useRef<BrokerOverview | null>(null);
  const overviewCallback = useRef(onOverviewChange);
  overviewCallback.current = onOverviewChange;
  function acceptOverview(next: BrokerOverview) {
    const previous = overviewRef.current;
    // A temporary tunnel outage does not erase the last known managed grant.
    if (next.configured && !next.connected && previous?.endpoint === next.endpoint) {
      const previousRows = new Map(previous.accounts.map(row => [row.profile_id, row]));
      next = { ...next, accounts: next.accounts.map(row => ({ ...row, remote: row.remote ?? previousRows.get(row.profile_id)?.remote ?? null })) };
    }
    if (previous && previous.endpoint !== next.endpoint) {
      setQuotaByProfile({});
      setQuotaErrors({});
      quotaAttempted.current.clear();
    }
    overviewRef.current = next;
    setOverview(next);
    overviewCallback.current?.(next);
  }
  const read = useCallback(async () => {
    const next = await call<BrokerOverview>("broker_overview", {});
    if (mounted.current) { acceptOverview(next); if (next.endpoint) setEndpoint(next.endpoint); }
  }, [call]);
  useEffect(() => {
    mounted.current = true;
    void read().catch(() => { if (mounted.current) setError("无法读取统一授权状态"); });
    const timer = window.setInterval(() => { if (!inFlight.current) void read().catch(() => { if (mounted.current) setError("读取状态失败，当前列表可能已过时"); }); }, 30_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [read]);
  useEffect(() => {
    setAccountSearch(focusedAccount);
    setAccountFilter("all");
  }, [focusedAccount]);
  const readActiveAuth = useCallback(async () => {
    try {
      const next = await call<ActiveAuth | null>("active_account_auth", {});
      if (mounted.current) {
        setActiveAuth(next?.account ? next : null);
        if (next?.account) setLogin(current => current?.name === next.account && current.phase !== "handoff" ? { ...current, phase: next.phase, cancelling: current.cancelling || next.cancelling } : current);
      }
    } catch { /* Other operation errors remain visible; status polling never starts a login. */ }
  }, [call]);
  useEffect(() => {
    void readActiveAuth();
    const timer = window.setInterval(() => void readActiveAuth(), 1500);
    return () => { window.clearInterval(timer); };
  }, [readActiveAuth]);
  useEffect(() => { onBusyChange?.(Boolean(busy || activeAuth)); }, [busy, activeAuth, onBusyChange]);
  async function run(label: string, operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(label); setMessage(""); setError(""); setErrorTarget(label); cancelRequested.current = false;
    try { await operation(); } catch (caught) { if (mounted.current) setError(String(caught)); }
    finally { inFlight.current = false; if (mounted.current) { setBusy(""); setLogin(null); } await readActiveAuth(); }
  }
  async function connect() {
    const next = await call<BrokerOverview>("save_broker_connection", { endpoint, adminKey });
    if (mounted.current) { acceptOverview(next); setAdminKey(""); setEditing(false); setMessage("续期服务已连接"); }
  }
  async function browserLogin(row: BrokerRow) {
    setLogin({ name: row.name, phase: "preparing", cancelling: false });
    await call("login_account_auth", { name: row.name });
    if (cancelRequested.current) throw new Error("授权已取消，未交给 Broker");
    if (mounted.current) setLogin({ name: row.name, phase: "handoff", cancelling: false });
  }
  async function manage(row: BrokerRow) {
    if (row.local.state === "missing" || row.local.state === "reauth_required") await browserLogin(row);
    await call("broker_push_account", { name: row.name });
    await read();
    if (mounted.current) setMessage("授权已交给 Broker；本机已停止刷新这条授权链");
  }
  async function reauthorize(row: BrokerRow) {
    await browserLogin(row);
    await call("broker_push_account", { name: row.name });
    await read();
    if (mounted.current) {
      setCpaAction(current => current?.profileId === row.profile_id ? null : current);
      setMessage("重新授权成功，新凭据已保存；请点击“同步到 CPA”更新凭据");
    }
  }
  async function updateCpa(row: BrokerRow, enabled: boolean) {
    setCpaAction({ profileId: row.profile_id, enabled, pending: true });
    try {
      const result = await call<BrokerMetadata>("broker_set_cpa", { profileId: row.profile_id, enabled });
      await read();
      if (enabled && result.cpa_sync_error) throw new Error(errors[result.cpa_sync_error] ?? "CPA 同步未完成");
      if (enabled && result.cpa_synced_generation !== result.generation) throw new Error("CPA 尚未收到最新凭据，请重试同步");
      if (mounted.current) {
        setCpaAction(null);
        setMessage(enabled ? "最新凭据已同步到 CPA，后续续期将自动同步" : "已暂停 CPA 自动同步");
      }
    } catch (caught) {
      if (mounted.current) setCpaAction(enabled ? { profileId: row.profile_id, enabled, pending: false } : null);
      throw caught;
    }
  }
  const readQuota = useCallback(async (row: BrokerRow) => {
    const remote = row.remote;
    if (!remote || quotaRequestProfile.current) return;
    const endpointAtStart = overviewRef.current?.endpoint;
    quotaAttempted.current.add(`${endpointAtStart}:${row.profile_id}:${remote.generation}`);
    quotaRequestProfile.current = row.profile_id;
    setQuotaLoadingProfile(row.profile_id);
    setQuotaErrors(current => ({ ...current, [row.profile_id]: "" }));
    try {
      const snapshot = await call<CodexQuotaSnapshot>("broker_quota_snapshot", { profileId: row.profile_id });
      const latest = overviewRef.current?.accounts.find(account => account.profile_id === row.profile_id)?.remote;
      if (overviewRef.current?.endpoint !== endpointAtStart || latest?.generation !== remote.generation) return;
      if (snapshot.account_id !== remote.account_id || snapshot.email.toLowerCase() !== remote.email.toLowerCase()
        || snapshot.generation !== remote.generation || !Array.isArray(snapshot.windows)) {
        throw new Error("额度与当前账号授权不一致，请重新读取授权状态后重试");
      }
      if (mounted.current) setQuotaByProfile(current => ({ ...current, [row.profile_id]: snapshot }));
    } catch (caught) {
      if (mounted.current && overviewRef.current?.endpoint === endpointAtStart) {
        setQuotaErrors(current => ({ ...current, [row.profile_id]: String(caught) }));
      }
    } finally {
      if (quotaRequestProfile.current === row.profile_id) quotaRequestProfile.current = null;
      if (mounted.current) setQuotaLoadingProfile(current => current === row.profile_id ? null : current);
    }
  }, [call]);
  async function cancelAuthorization(name: string) {
    cancelRequested.current = true;
    setLogin(current => current && { ...current, cancelling: true });
    try {
      const cancelled = await call<boolean>("cancel_account_auth", { name });
      if (mounted.current) setMessage(cancelled ? `${name}：正在取消授权…` : `${name}：当前没有待取消的浏览器授权`);
      await readActiveAuth();
    } catch (caught) { if (mounted.current) setError(String(caught)); }
  }
  async function importJson() {
    const path = await call<string | null>("choose_broker_json_import_path", {});
    if (!path) return;
    const preview = await call<BrokerJsonPreview>("broker_preview_json", { path });
    if (mounted.current) { setClearImportedRefreshToken(false); setImportMode("manage"); setImportAccountIndex(0); setJsonFormat("auth_json"); setExportRow(null); setImportPreview(preview); }
  }
  async function exportJson(row: BrokerRow) {
    const result = await call<BrokerJsonTransferSummary>("broker_export_json", { profileId: row.profile_id, accountName: row.name, format: jsonFormat, includeRefreshToken: preserveRefreshToken });
    if (mounted.current) { setExportRow(null); setMessage(`${row.name} 的 ${jsonFormats.find((item) => item.value === jsonFormat)?.label ?? "JSON"} 已保存（${result.refresh_token_exported ? "包含 refresh_token" : "access-only"}）`); }
  }
  async function convertImportedJson() {
    if (!importPreview) return;
    const result = await call<BrokerJsonTransferSummary>("broker_convert_json", { path: importPreview.path, format: jsonFormat, includeRefreshToken: !clearImportedRefreshToken });
    if (mounted.current) { setImportPreview(null); setMessage(`已转换为 ${jsonFormats.find((item) => item.value === jsonFormat)?.label ?? "JSON"}（${result.refresh_token_exported ? "包含 refresh_token" : "access-only"}，不会写入 Broker）`); }
  }
  async function importAndManageJson() {
    const account = importPreview?.accounts[importAccountIndex];
    if (!importPreview || !account?.email || !account.account_id) return;
    let result: BrokerJsonImportSummary;
    try {
      result = await call<BrokerJsonImportSummary>("broker_import_json", { path: importPreview.path, email: account.email, accountId: account.account_id });
    } catch (caught) {
      try { await read(); } catch { /* Keep the actionable import error in the dialog. */ }
      throw caught;
    }
    if (mounted.current) {
      setImportPreview(null);
      setAccountFilter("all");
      setAccountSearch(result.email);
      setCpaAction(current => current?.profileId === result.profile_id ? null : current);
      setMessage(`${result.email} 已导入并纳管；请点击“同步到 CPA”更新凭据`);
      onImportedAccount?.(result.profile_id);
    }
    try { await read(); } catch { if (mounted.current) setError("导入并纳管已完成，列表读取失败；请点击“读取状态”重试"); }
  }
  const authorized = useCallback((row: BrokerRow) => authorizationState(row) === "authorized", []);
  const authorizationTime = useCallback((row: BrokerRow) => row.remote?.last_refresh_at ?? row.local.last_refresh_at ?? 0, []);
  const expiryTime = useCallback((row: BrokerRow) => row.remote?.expires_at ?? row.local.expires_at ?? 0, []);
  const accountCounts = useMemo(() => {
    const accounts = overview?.accounts ?? [];
    const authorizedCount = accounts.filter(authorized).length;
    const reauthCount = accounts.filter((row) => authorizationState(row) === "reauth_required").length;
    return {
      all: accounts.length,
      authorized: authorizedCount,
      unauthorized: accounts.filter(row => ["never_authorized", "reauth_required"].includes(authorizationState(row))).length,
      reauth: reauthCount,
      never: accounts.filter(row => authorizationState(row) === "never_authorized").length,
    };
  }, [authorized, overview?.accounts]);
  const visibleAccounts = useMemo(() => {
    if (workbench) return accountVisible ? (overview?.accounts ?? []).filter(row => row.profile_id === selectedProfileId).map(row => selectedAccount ? { ...row, ...selectedAccount } : row) : [];
    const query = accountSearch.trim().toLocaleLowerCase();
    const rows = (overview?.accounts ?? []).filter((row) => {
      if (accountFilter === "authorized" && authorizationState(row) !== "authorized") return false;
      if (accountFilter === "unauthorized" && !["never_authorized", "reauth_required"].includes(authorizationState(row))) return false;
      if (accountFilter === "reauth_required" && authorizationState(row) !== "reauth_required") return false;
      if (!query) return true;
      return [row.name, row.local.email, row.remote?.email].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query));
    });
    if (accountSort === "default") return rows;
    return [...rows].sort((left, right) => {
      if (accountSort === "name") return left.name.localeCompare(right.name, "zh-CN");
      if (accountSort === "expiry") {
        const difference = expiryTime(left) - expiryTime(right);
        return difference || left.name.localeCompare(right.name, "zh-CN");
      }
      const difference = authorizationTime(right) - authorizationTime(left);
      return difference || left.name.localeCompare(right.name, "zh-CN");
    });
  }, [accountFilter, accountSearch, accountSort, authorized, authorizationTime, expiryTime, overview?.accounts, workbench, selectedProfileId, selectedAccount, accountVisible]);
  const brokerConnected = overview?.connected ?? false;
  useEffect(() => {
    // The workbench represents one selected account, so one bounded read is
    // useful after authorization. The all-account list remains opt-in to avoid
    // issuing hundreds of upstream usage requests at once.
    if (!workbench || !accountVisible || !brokerConnected || busy || activeAuth || visibleAccounts.length !== 1) return;
    const row = visibleAccounts[0];
    if (!row.remote || authorizationState(row) === "reauth_required" || quotaRequestProfile.current) return;
    const attemptKey = `${overview?.endpoint}:${row.profile_id}:${row.remote.generation}`;
    if (quotaAttempted.current.has(attemptKey)) return;
    void readQuota(row);
  }, [accountVisible, brokerConnected, busy, activeAuth, overview?.endpoint, quotaLoadingProfile, readQuota, visibleAccounts, workbench]);
  const filterLabels: Array<{ value: BrokerAccountFilter; label: string }> = [
    { value: "all", label: `全部 ${accountCounts.all}` },
    { value: "authorized", label: `已授权 ${accountCounts.authorized}` },
    { value: "unauthorized", label: `未授权 ${accountCounts.unauthorized}` },
  ];
  const disabled = Boolean(busy || activeAuth);
  const visibleLogin = login ?? (activeAuth ? { name: activeAuth.account, phase: activeAuth.phase, cancelling: activeAuth.cancelling } : null);
  const loginLabel = visibleLogin ? visibleLogin.cancelling ? "正在取消授权…" : visibleLogin.phase === "handoff" ? "授权成功，正在交给 Broker…" : authProgressLabels[visibleLogin.phase] : "";
  const activity = visibleLogin && (<div className="brokerRowFeedback" role="status"><strong>{visibleLogin.name}</strong><p><Loader2 className="spin" size={14} /> {loginLabel}</p>{visibleLogin.phase !== "handoff" && <button className="secondaryButton" type="button" disabled={visibleLogin.cancelling} onClick={() => void cancelAuthorization(visibleLogin.name)}>取消授权</button>}</div>);
  const importAccount = importPreview?.accounts[importAccountIndex];
  const importEmail = importAccount?.email?.toLocaleLowerCase() ?? "";
  const importTargets = (overview?.accounts ?? []).filter(row => Boolean(importEmail) && (
    row.name.toLocaleLowerCase() === importEmail
    || row.local.email?.toLocaleLowerCase() === importEmail
    || (row.remote?.account_id === importAccount?.account_id && row.remote?.email.toLocaleLowerCase() === importEmail)
  ));
  const importBlockedReason = !brokerConnected ? "请先连接统一续期服务，再导入并纳管。"
    : !importAccount?.has_refresh_token ? "此账号缺少 refresh_token，不能纳管；可以选择“仅转换文件”保存使用副本。"
    : !importAccount.has_access_token || !importAccount.has_id_token || !importAccount.email || !importAccount.account_id ? "授权文件缺少完整的账号身份或凭据，请使用完整 auth.json。"
    : importTargets.length === 0 ? `NoTrace 中找不到 ${importAccount.email}，请先新建同名账号环境。`
    : importTargets.length > 1 ? "多个 NoTrace 环境使用此邮箱，请先整理账号绑定后再导入。" : "";
  return <section className={`brokerPanel ${workbench ? "brokerPanelWorkbench" : embedded ? "brokerPanelEmbedded" : ""}`} aria-label={workbench ? "账号工作区" : "统一授权续期"}>
    <div className={`brokerPanelHeader ${embedded ? "brokerPanelHeaderEmbedded" : ""}`}>
      {workbench ? searchControls : <div>{embedded ? null : <><span className="eyebrow">授权管理中心</span><h2 id="cloak-editor-dialog-title">统一授权续期</h2><p>查看谁负责刷新，以及各端是否收到最新凭据。</p></>}</div>}
      <div className="brokerPanelHeaderActions">
        <button className="secondaryButton" type="button" disabled={disabled} onClick={() => void run("import-json", importJson)}><UploadCloud size={14} />{workbench ? "导入 JSON" : "导入/转换 JSON"}</button>
        <button className={workbench ? "iconButton" : "secondaryButton"} aria-label="读取授权状态" title="读取授权状态" type="button" disabled={disabled} onClick={() => void run("status", read)}><RefreshCw size={14} />{!workbench && "读取状态"}</button>
        {workbench && <button className={`brokerServiceButton ${brokerConnected ? "connected" : "disconnected"}`} type="button" aria-expanded={editing} disabled={disabled} onClick={() => setEditing(!editing)}><span className="brokerAuthDot" aria-hidden="true" />{!overview ? "连接中" : brokerConnected ? "续期服务" : "服务未连接"}</button>}
      </div>
    </div>
    {workbench && workbenchHeader}
    <div className={workbench ? "workbenchBody" : "brokerPanelBody"}>
    {overview?.configured && !editing ? !workbench && <p className="inspectorHint">{overview.connected ? "续期服务已连接" : "续期服务暂不可用"} · {overview.endpoint} <button className="textButton" type="button" onClick={() => setEditing(true)} disabled={disabled}>更换连接</button></p> : <div className="brokerConnection">
      <input aria-label="Broker 地址" placeholder="续期服务地址" value={endpoint} onChange={event => setEndpoint(event.target.value)} disabled={disabled} />
      <input aria-label="Broker 管理密钥" type="password" autoComplete="off" placeholder="管理密钥" value={adminKey} onChange={event => setAdminKey(event.target.value)} disabled={disabled} />
      <button className="primaryButton" type="button" disabled={!endpoint || !adminKey || disabled} onClick={() => void run("connect", connect)}>{busy === "connect" ? <Loader2 className="spin" size={14} /> : <Link2 size={14} />}连接</button>
    </div>}
    {workbench && overview?.configured && !overview.connected && <p className="brokerJsonNotice warning" role="status">续期服务暂未连接，显示上次读取的授权状态。授权、刷新和同步恢复连接后可用。</p>}
    {overview?.message && <p className="inspectorHint">{overview.message}</p>}
    {error && !importPreview && (workbench || !visibleAccounts.some(row => row.profile_id === errorTarget)) && <div className="brokerRowFeedback error" role="alert"><strong>{overview?.accounts.find(row => row.profile_id === errorTarget)?.name ?? "操作未完成"}</strong><p>{error}</p></div>}
    {message && <p className="inspectorHint" role="status">{message}</p>}
    {!overview && !error && <p className="inspectorHint">正在读取授权状态…</p>}
    {!workbench && <div className="brokerListToolbar" aria-label="授权账号筛选与排序" aria-busy={!overview}>
      <div className="brokerFilterTabs" role="tablist" aria-label="授权状态筛选">
        {filterLabels.map((filter) => {
          const parentActive = accountFilter === "reauth_required" && filter.value === "unauthorized";
          return <button key={filter.value} className={`brokerFilterTab ${accountFilter === filter.value || parentActive ? "active" : ""}`} disabled={!overview} type="button" role="tab" aria-selected={accountFilter === filter.value || parentActive} onClick={() => setAccountFilter(filter.value)}>{filter.label}</button>;
        })}
      </div>
      {overview && <div className="brokerFilterSummary"><span className="brokerFilterSummaryItem"><span className="brokerAuthDot brokerAuthDot-authorized" aria-hidden="true" />可正常续期 {accountCounts.authorized}</span><button className={`brokerFilterSummaryItem brokerFilterSummaryItemDanger brokerIssueFilter ${accountFilter === "reauth_required" ? "active" : ""}`} type="button" aria-pressed={accountFilter === "reauth_required"} disabled={accountCounts.reauth === 0} onClick={() => { setAccountSearch(""); setAccountFilter(accountFilter === "reauth_required" ? "all" : "reauth_required"); }}><span className="brokerAuthDot brokerAuthDot-reauth_required" aria-hidden="true" />曾授权失效 {accountCounts.reauth}</button><span className="brokerFilterSummaryItem"><span className="brokerAuthDot brokerAuthDot-never_authorized" aria-hidden="true" />从未授权 {accountCounts.never}</span></div>}
      <div className="brokerListControls">
        <label className="brokerSearch"><Search aria-hidden="true" size={14} /><span className="visuallyHidden">搜索授权账号</span><input type="search" aria-label="搜索授权账号" placeholder="搜索邮箱后直接授权" value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} /></label>
        <label className="brokerSort"><ArrowDownUp aria-hidden="true" size={14} /><span className="visuallyHidden">排序方式</span><select aria-label="排序方式" value={accountSort} onChange={(event) => setAccountSort(event.target.value as BrokerAccountSort)}><option value="default">默认顺序</option><option value="recent">最近授权/续期</option><option value="expiry">访问凭据到期</option><option value="name">账号名称</option></select></label>
      </div>
      <p className="brokerListSummary">{overview ? `显示 ${visibleAccounts.length} / ${accountCounts.all} 个账号${accountFilter === "reauth_required" ? " · 仅显示曾授权失效账号" : accountSearch.trim() ? ` · 搜索“${accountSearch.trim()}”` : ""}` : error ? "授权状态读取失败，请点击“读取状态”重试" : "正在读取授权状态…"}</p>
    </div>}
    {visibleLogin && (workbench || !visibleAccounts.some(row => row.name === visibleLogin.name)) && activity}
    {workbench && busy && !visibleLogin && <p className="brokerOperationStatus" role="status"><Loader2 size={14} className="spin" />{overview?.accounts.find(row => row.profile_id === busy)?.name} · 正在处理，请稍候…</p>}
    <div className="brokerRows" id={workbench ? "workbench-authorization" : undefined} role={workbench ? "tabpanel" : undefined} aria-labelledby={workbench ? "workbench-broker-tab" : undefined} hidden={workbench && !accountVisible}>{visibleAccounts.map(row => {
      const remote = row.remote;
      const accountState = authorizationState(row);
      const historicalAuthorization = accountState === "reauth_required";
      const canManage = ["no_trace", "broker"].includes(row.local.authority);
      const needsLogin = row.local.state === "missing";
      const needsReauthLocal = row.local.state === "reauth_required";
      // Reconnect through the browser for external owners; do not hand over
      // their live refresh token as if NoTrace already owned it.
      const externalGrant = !canManage && !needsLogin && !needsReauthLocal;
      const grantEmail = remote?.email ?? row.local.email;
      const rowBusy = busy === row.profile_id;
      const cachedQuota = quotaByProfile[row.profile_id];
      const quota = remote && cachedQuota?.generation === remote.generation
        && cachedQuota.account_id === remote.account_id && !historicalAuthorization ? cachedQuota : undefined;
      const quotaLoading = quotaLoadingProfile === row.profile_id;
      const cpaSynced = remote?.cpa_enabled && !remote.cpa_sync_error && remote.cpa_synced_generation === remote.generation;
      const rowCpaAction = cpaAction?.profileId === row.profile_id ? cpaAction : null;
      const cpaButtonLabel = rowCpaAction?.pending
        ? rowCpaAction.enabled ? "同步中…" : "暂停中…"
        : historicalAuthorization
          ? remote?.cpa_enabled ? "暂停 CPA 同步" : "需重新授权"
          : cpaSynced ? "暂停 CPA 同步" : remote?.cpa_sync_error || rowCpaAction ? "重试同步" : "同步到 CPA";
      const localStatus = needsReauthLocal ? "曾授权 · OAuth 已失效，需要重新授权" : needsLogin ? "尚未连接 OAuth" : externalGrant ? `当前凭据由 ${authorityNames[row.local.authority]} 管理` : "本机授权尚未纳管";
      const accountStatusLabel = historicalAuthorization
        ? `未授权 · 曾授权 · ${remote ? authorizationFailureLabel(remote) : "OAuth 已失效，需要重新授权"}`
        : remote
          ? "已授权 · NoTrace Broker 自动续期"
          : row.local.authority === "broker"
            ? "已授权 · 正在确认授权交接"
            : needsLogin
              ? `未授权 · ${localStatus}`
              : `已授权 · ${localStatus}`;
      return <article className={`brokerRow ${historicalAuthorization ? "brokerRowHistorical" : ""}`} key={row.profile_id}>
        <div className="brokerRowTop"><div className="brokerRowMain"><strong>{workbench ? "授权状态" : row.name}</strong><span className={`brokerAuthStatus brokerAuthStatus-${accountState}`}><span className={`brokerAuthDot brokerAuthDot-${accountState}`} aria-hidden="true" />{row.trashed ? "回收站账号" : "浏览器账号"} · {accountState === "unknown" ? "托管状态待确认" : accountStatusLabel}</span>{workbench && (remote?.plan_type || row.local.plan_type) && <span>ChatGPT · {remote?.plan_type ?? row.local.plan_type}{grantEmail && grantEmail !== row.name ? ` · 授权账号：${grantEmail}` : ""}</span>}</div>
          <div className="brokerRowActions">{remote ? <>
            <button className={workbench && historicalAuthorization ? "primaryButton" : "secondaryButton"} type="button" disabled={disabled || !brokerConnected} title="打开此账号的登录环境，重新取得授权凭据" onClick={() => void run(row.profile_id, () => reauthorize(row))}><KeyRound size={14} />重新授权</button>
            {!historicalAuthorization && <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} onClick={() => void run(row.profile_id, async () => { try { await call("broker_refresh_account", { profileId: row.profile_id }); } catch (caught) { await read(); throw caught; } await read(); setMessage("刷新结果已写回 Broker"); })}><RefreshCw size={14} />立即刷新</button>}
            <button className={workbench && !historicalAuthorization && !cpaSynced ? "primaryButton" : "secondaryButton"} type="button" disabled={disabled || !brokerConnected || (historicalAuthorization && !remote.cpa_enabled)} onClick={() => void run(row.profile_id, () => updateCpa(row, historicalAuthorization ? false : !cpaSynced))}>{cpaButtonLabel}</button>
            <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected || quotaLoadingProfile !== null || historicalAuthorization} title="仅读取上游 Codex 额度，不会刷新授权或消耗主动重置次数" onClick={() => void readQuota(row)}>{quotaLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}{quotaLoading ? "读取中…" : "读取额度"}</button>
            <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} onClick={() => { setPreserveRefreshToken(false); setImportPreview(null); setExportRow(row); setJsonFormat("auth_json"); }}><Download size={14} />导出 JSON</button>
          </> : <button className={workbench ? "primaryButton" : "secondaryButton"} type="button" disabled={disabled || !brokerConnected} onClick={() => void run(row.profile_id, () => externalGrant ? reauthorize(row) : manage(row))}>{rowBusy ? <Loader2 className="spin" size={14} /> : needsLogin || needsReauthLocal || externalGrant ? <KeyRound size={14} /> : <UploadCloud size={14} />}{rowBusy ? "授权处理中…" : needsLogin ? "授权并纳管" : needsReauthLocal || externalGrant ? "重新授权并纳管" : "交给 Broker"}</button>}</div>
        </div>
        {!workbench && visibleLogin?.name === row.name && activity}
        {!workbench && error && errorTarget === row.profile_id && <div className="brokerRowFeedback error" role="alert"><strong>操作未完成</strong><p>{error}</p><span>请按上方原因处理后，重新点击此账号的操作按钮。</span></div>}
        {historicalAuthorization && <div className="brokerRowFeedback error" role="status"><strong>{remote?.error === "reauth_required" ? "授权已失效" : "授权链需要重新授权"}</strong><p>{remote?.error === "reauth_required" ? "refresh_token 已失效，当前账号已移入“未授权”。" : "上次刷新结果无法安全确认，当前账号已移入“未授权”。"}</p><span>点击“重新授权”获取新的授权链。</span></div>}
        {externalGrant && <p className="brokerJsonHint">重新授权会打开此账号的浏览器，获取新的授权链后纳入统一续期。</p>}
        {quotaErrors[row.profile_id] && <p className="brokerError" role="alert">额度读取未完成：{quotaErrors[row.profile_id]}{quota ? "（保留上次快照，以查询时间为准）" : ""}</p>}
        {workbench && !remote && row.local.expires_at && <div className="brokerStatus"><span>访问凭据到期<b>{time(row.local.expires_at)}</b></span><span>最近更新<b>{time(row.local.last_refresh_at)}</b></span><span>当前管理工具<b>{authorityNames[row.local.authority]}</b></span></div>}
        {remote && <><div className="brokerStatus"><span>访问凭据到期<b>{time(remote.expires_at)}</b></span><span>最近续期<b>{time(remote.last_refresh_at)}</b></span><span title="从启用统计起累计，只计成功续期；首次授权、重新授权和失败重试不计入。">成功续期<b>{refreshCountLabel(remote.refresh_count)}</b>{remote.refresh_count !== undefined && remote.automatic_refresh_count !== undefined && <small>自动 {remote.automatic_refresh_count} 次 · 手动 {Math.max(0, remote.refresh_count - remote.automatic_refresh_count)} 次</small>}<small>启用统计后累计</small></span><span>{remote.next_retry_at ? "计划重试" : "计划续期"}<b>{time(remote.next_retry_at ?? remote.next_refresh_at)}</b></span><span>CPA<b>{syncLabel(remote.cpa_enabled, remote.cpa_synced_generation, remote.generation, remote.cpa_sync_error)}</b></span><span>Cockpit<b>{remote.cockpit_synced_generation === remote.generation ? "已确认" : "使用导出 JSON 导入"}</b></span></div>{quota && <div className="brokerQuota" aria-label="账号额度"><div><span>5 小时剩余</span><b>{quotaPercent(quota.windows.find(window => window.name === "5 小时")?.remaining_percent)}</b><small>重置 {time(quota.windows.find(window => window.name === "5 小时")?.reset_at ?? null)}</small></div><div><span>周剩余</span><b>{quotaPercent(quota.windows.find(window => window.name === "周")?.remaining_percent)}</b><small>重置 {time(quota.windows.find(window => window.name === "周")?.reset_at ?? null)}</small></div><div><span>主动重置次数</span><b>{quota.reset_count_available ? `${quota.reset_count ?? 0} 次` : "上游未提供"}</b><small>查询于 {time(quota.fetched_at)}</small></div></div>}{remote.error && !historicalAuthorization && <p className="brokerError brokerTransientError">{errors[remote.error] ?? "授权操作未完成"}</p>}</>}
      </article>;
    })}</div>
    {overview && visibleAccounts.length === 0 && (!workbench || accountVisible) && <p className="brokerEmpty">{workbench ? "在左侧选择账号，或在上方搜索邮箱后授权。" : "当前筛选没有匹配账号。可以切换“全部”或清空搜索。"}</p>}
    {!!overview?.unmatched.length && <p className="inspectorHint">服务端还有 {overview.unmatched.length} 条未绑定本机浏览器的授权。它们保留在 Broker，不会被窗口自动删除。</p>}
    {children}
    </div>
    {exportRow && createPortal(<div className="brokerJsonOverlay">
      <div className="brokerJsonCard" role="dialog" aria-modal="true" aria-label="导出 JSON">
      <div className="brokerJsonCardHeader"><div><strong>导出 JSON</strong><span>{exportRow.name}</span></div><button className="iconButton" type="button" aria-label="关闭导出 JSON" onClick={() => setExportRow(null)}>×</button></div>
      <label className="brokerJsonField">导出格式<select value={jsonFormat} onChange={(event) => setJsonFormat(event.target.value as BrokerJsonFormat)} disabled={disabled}>{jsonFormats.map((format) => <option value={format.value} key={format.value}>{format.label}</option>)}</select></label>
      {jsonFormat === "auth_json" && <p className="brokerJsonHint">适用于官方 Codex；上传到 CPA 时，请选择“CPA”格式。</p>}
      <label className="brokerJsonCheckbox"><input type="checkbox" checked={!preserveRefreshToken} onChange={(event) => setPreserveRefreshToken(!event.target.checked)} /><span>清空 refresh_token（推荐）</span></label>
      <p className={`brokerJsonNotice ${preserveRefreshToken ? "warning" : ""}`}>{preserveRefreshToken ? "取消清空后，真实 refresh_token 会写入导出文件；导入 Cockpit/CPA 后可能产生第二个刷新者，仅用于明确迁移或离线备份。" : "默认只导出 access token / id token；refresh_token 为空，由 NoTrace Broker 继续负责续期。"}</p>
      <div className="brokerJsonActions"><button className="secondaryButton" type="button" disabled={disabled} onClick={() => setExportRow(null)}>取消</button><button className="primaryButton" type="button" disabled={disabled} onClick={() => void run("export-json", () => exportJson(exportRow))}><Download size={14} />保存 JSON</button></div>
      </div>
    </div>, document.body)}
    {importPreview && createPortal(<div className="brokerJsonOverlay">
      <div className="brokerJsonCard" role="dialog" aria-modal="true" aria-label="JSON 导入与转换">
      <div className="brokerJsonCardHeader"><div><strong>导入授权 JSON</strong><span>{importPreview.account_count} 个账号 · {importPreview.detected_format}</span></div><button className="iconButton" type="button" disabled={disabled} aria-label="关闭 JSON 导入与转换" onClick={() => setImportPreview(null)}>×</button></div>
      <p className="brokerJsonPath" title={importPreview.path}>{importPreview.path}</p>
      <div className="brokerFilterTabs brokerJsonMode" role="group" aria-label="JSON 处理方式"><button className={`brokerFilterTab ${importMode === "manage" ? "active" : ""}`} type="button" aria-pressed={importMode === "manage"} disabled={disabled} onClick={() => { setImportMode("manage"); setError(""); }}>导入并纳管</button><button className={`brokerFilterTab ${importMode === "convert" ? "active" : ""}`} type="button" aria-pressed={importMode === "convert"} disabled={disabled} onClick={() => { setImportMode("convert"); setError(""); }}>仅转换文件</button></div>
      {importMode === "manage" && <>
        {importPreview.account_count > 1 && <label className="brokerJsonField">选择要纳管的账号<select aria-label="选择要纳管的账号" value={importAccountIndex} disabled={disabled} onChange={event => { setImportAccountIndex(Number(event.target.value)); setError(""); }}>{importPreview.accounts.map((account, index) => <option key={index} value={index}>{account.email ?? account.account_id ?? `账号 ${index + 1}`}</option>)}</select></label>}
        <div className="brokerJsonImportAccount"><strong>{importAccount?.email ?? importAccount?.account_id ?? "无法识别账号"}</strong><span>{importTargets.length === 1 ? `绑定环境：${importTargets[0].name}${importTargets[0].trashed ? "（回收站）" : ""}` : "等待匹配账号环境"}</span></div>
        <p className={`brokerJsonNotice ${importBlockedReason ? "warning" : ""}`}>{importBlockedReason || `完整凭据将保存到统一续期服务，保留 refresh_token。${importTargets[0]?.remote ? "将更新此账号的授权凭据；" : "导入后无需再打开浏览器授权；"}CPA 同步由你手动点击。`}</p>
        {!importBlockedReason && <p className="brokerJsonHint">纳管后由统一续期服务负责刷新，请停用原工具对同一份凭据的自动刷新。</p>}
      </>}
      {importMode === "convert" && <>
      <div className="brokerJsonAccountList">{importPreview.accounts.slice(0, 6).map((account, index) => <span key={`${account.email ?? account.account_id ?? "account"}-${index}`}><FileJson size={13} />{account.email ?? account.account_id ?? `账号 ${index + 1}`}{account.has_refresh_token ? " · 含 refresh_token" : " · access-only"}</span>)}{importPreview.account_count > 6 && <small>还有 {importPreview.account_count - 6} 个账号</small>}</div>
      <label className="brokerJsonField">转换为<select value={jsonFormat} onChange={(event) => setJsonFormat(event.target.value as BrokerJsonFormat)} disabled={disabled}>{jsonFormats.map((format) => <option value={format.value} key={format.value}>{format.label}</option>)}</select></label>
      <label className="brokerJsonCheckbox"><input type="checkbox" checked={clearImportedRefreshToken} onChange={(event) => setClearImportedRefreshToken(event.target.checked)} /><span>清空 refresh_token（生成 access-only 副本）</span></label>
      <p className={`brokerJsonNotice ${!clearImportedRefreshToken && importPreview.contains_refresh_token ? "warning" : ""}`}>{clearImportedRefreshToken ? "已选择清空：保存的目标文件只含 access token / id token；不会写入 Broker。" : importPreview.contains_refresh_token ? "默认保留输入文件中的真实 refresh_token，用于完整凭据导入/转换；这里只保存目标 JSON，不会自动写入 Broker、CPA 或 Cockpit。" : "输入文件不含 refresh_token，将生成 access-only 目标文件；这里只保存目标 JSON。"}</p>
      </>}
      {error && <p className="brokerRowFeedback error" role="alert">{error}</p>}
      <div className="brokerJsonActions"><button className="secondaryButton" type="button" disabled={disabled} onClick={() => setImportPreview(null)}>关闭</button>{importMode === "manage" ? <button className="primaryButton" type="button" disabled={disabled || Boolean(importBlockedReason)} onClick={() => void run("manage-json", importAndManageJson)}>{busy === "manage-json" ? <Loader2 className="spin" size={14} /> : <UploadCloud size={14} />}{busy === "manage-json" ? "正在导入并纳管…" : "确认导入并纳管"}</button> : <button className="primaryButton" type="button" disabled={disabled} onClick={() => void run("convert-json", convertImportedJson)}><Download size={14} />转换并保存</button>}</div>
      </div>
    </div>, document.body)}
  </section>;
}
