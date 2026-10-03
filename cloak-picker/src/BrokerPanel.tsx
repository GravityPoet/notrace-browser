import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, Download, FileJson, KeyRound, Link2, Loader2, RefreshCw, Search, UploadCloud } from "lucide-react";
import { authProgressLabels, type ActiveAuth, type AuthCall, type AuthLoginPhase, type AuthStatus } from "./AuthPanel";

export type BrokerMetadata = {
  key: string; email: string; account_id: string; plan_type: string | null;
  expires_at: number; last_refresh_at: number; generation: number;
  refresh_count?: number; automatic_refresh_count?: number;
  next_refresh_at: number; next_retry_at: number | null; error: string | null;
  cpa_enabled: boolean; cpa_synced_generation: number | null; cpa_sync_error: string | null;
  cockpit_synced_generation: number | null;
};
type BrokerRow = { name: string; profile_id: string; trashed: boolean; local: AuthStatus; remote: BrokerMetadata | null };
export type BrokerOverview = { configured: boolean; endpoint: string | null; connected: boolean; message: string | null; accounts: BrokerRow[]; unmatched: BrokerMetadata[] };
type BrokerJsonFormat = "cockpit_tools" | "auth_json" | "cpa" | "sub2api";
type BrokerJsonTransferSummary = { path: string; format: string; account_count: number; refresh_token_exported: boolean };
type BrokerJsonPreviewAccount = { email: string | null; account_id: string | null; has_access_token: boolean; has_refresh_token: boolean };
type BrokerJsonPreview = { path: string; detected_format: string; account_count: number; accounts: BrokerJsonPreviewAccount[]; contains_refresh_token: boolean; message: string };
type BrokerAccountFilter = "all" | "authorized" | "unauthorized";
type BrokerAccountSort = "default" | "recent" | "expiry" | "name";
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
};
function time(value: number | null) {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}
function syncLabel(enabled: boolean, synced: number | null, generation: number, error: string | null) {
  if (!enabled) return synced === generation ? "已暂停自动同步" : "待同步新凭据";
  if (error) return errors[error] ?? "同步未完成";
  return synced === generation ? "已同步" : "等待同步";
}
function refreshCountLabel(count: number | undefined) {
  return count === undefined ? "服务端尚未统计" : `${count} 次`;
}
export function BrokerPanel({ call = nativeCall, onBusyChange, embedded = false, focusedAccount = "" }: { call?: AuthCall; onBusyChange?: (busy: boolean) => void; embedded?: boolean; focusedAccount?: string }) {
  const [overview, setOverview] = useState<BrokerOverview | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [cpaAction, setCpaAction] = useState<{ profileId: string; enabled: boolean; pending: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [errorTarget, setErrorTarget] = useState("");
  const [activeAuth, setActiveAuth] = useState<ActiveAuth | null>(null);
  const [login, setLogin] = useState<{ name: string; phase: AuthLoginPhase | "handoff"; cancelling: boolean } | null>(null);
  const cancelRequested = useRef(false);
  const [exportRow, setExportRow] = useState<BrokerRow | null>(null);
  const [jsonFormat, setJsonFormat] = useState<BrokerJsonFormat>("auth_json");
  const [importPreview, setImportPreview] = useState<BrokerJsonPreview | null>(null);
  const [preserveRefreshToken, setPreserveRefreshToken] = useState(false);
  const [clearImportedRefreshToken, setClearImportedRefreshToken] = useState(false);
  const [accountFilter, setAccountFilter] = useState<BrokerAccountFilter>("all");
  const [accountSearch, setAccountSearch] = useState(focusedAccount);
  const [accountSort, setAccountSort] = useState<BrokerAccountSort>("default");
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const read = useCallback(async () => {
    const next = await call<BrokerOverview>("broker_overview", {});
    if (mounted.current) { setOverview(next); if (next.endpoint) setEndpoint(next.endpoint); }
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
    if (mounted.current) { setOverview(next); setAdminKey(""); setEditing(false); setMessage("续期服务已连接"); }
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
    if (mounted.current) { setClearImportedRefreshToken(false); setExportRow(null); setImportPreview(preview); }
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
  const authorized = useCallback((row: BrokerRow) => Boolean(row.remote) || row.local.state !== "missing", []);
  const authorizationTime = useCallback((row: BrokerRow) => row.remote?.last_refresh_at ?? row.local.last_refresh_at ?? 0, []);
  const expiryTime = useCallback((row: BrokerRow) => row.remote?.expires_at ?? row.local.expires_at ?? 0, []);
  const accountCounts = useMemo(() => {
    const accounts = overview?.accounts ?? [];
    const authorizedCount = accounts.filter(authorized).length;
    return { all: accounts.length, authorized: authorizedCount, unauthorized: accounts.length - authorizedCount };
  }, [authorized, overview?.accounts]);
  const visibleAccounts = useMemo(() => {
    const query = accountSearch.trim().toLocaleLowerCase();
    const rows = (overview?.accounts ?? []).filter((row) => {
      if (accountFilter === "authorized" && !authorized(row)) return false;
      if (accountFilter === "unauthorized" && authorized(row)) return false;
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
  }, [accountFilter, accountSearch, accountSort, authorized, authorizationTime, expiryTime, overview?.accounts]);
  const filterLabels: Array<{ value: BrokerAccountFilter; label: string }> = [
    { value: "all", label: `全部 ${accountCounts.all}` },
    { value: "authorized", label: `已授权 ${accountCounts.authorized}` },
    { value: "unauthorized", label: `未授权 ${accountCounts.unauthorized}` },
  ];
  const disabled = Boolean(busy || activeAuth);
  const visibleLogin = login ?? (activeAuth ? { name: activeAuth.account, phase: activeAuth.phase, cancelling: activeAuth.cancelling } : null);
  const loginLabel = visibleLogin ? visibleLogin.cancelling ? "正在取消授权…" : visibleLogin.phase === "handoff" ? "授权成功，正在交给 Broker…" : authProgressLabels[visibleLogin.phase] : "";
  const activity = visibleLogin && (<div className="brokerRowFeedback" role="status"><strong>{visibleLogin.name}</strong><p><Loader2 className="spin" size={14} /> {loginLabel}</p>{visibleLogin.phase !== "handoff" && <button className="secondaryButton" type="button" disabled={visibleLogin.cancelling} onClick={() => void cancelAuthorization(visibleLogin.name)}>取消授权</button>}</div>);
  const brokerConnected = overview?.connected ?? false;
  return <section className={`brokerPanel ${embedded ? "brokerPanelEmbedded" : ""}`} aria-label="统一授权续期">
    <div className={`brokerPanelHeader ${embedded ? "brokerPanelHeaderEmbedded" : ""}`}>
      <div>{embedded ? null : <><span className="eyebrow">授权管理中心</span><h2 id="cloak-editor-dialog-title">统一授权续期</h2><p>查看谁负责刷新，以及各端是否收到最新凭据。</p></>}</div>
      <div className="brokerPanelHeaderActions">
        <button className="secondaryButton" type="button" disabled={disabled} onClick={() => void run("import-json", importJson)}><UploadCloud size={14} />导入/转换 JSON</button>
        <button className="secondaryButton" type="button" disabled={disabled} onClick={() => void run("status", read)}><RefreshCw size={14} />读取状态</button>
      </div>
    </div>
    {overview?.configured && !editing ? <p className="inspectorHint">{overview.connected ? "续期服务已连接" : "续期服务暂不可用"} · {overview.endpoint} <button className="textButton" type="button" onClick={() => setEditing(true)} disabled={disabled}>更换连接</button></p> : <div className="brokerConnection">
      <input aria-label="Broker 地址" placeholder="续期服务地址" value={endpoint} onChange={event => setEndpoint(event.target.value)} disabled={disabled} />
      <input aria-label="Broker 管理密钥" type="password" autoComplete="off" placeholder="管理密钥" value={adminKey} onChange={event => setAdminKey(event.target.value)} disabled={disabled} />
      <button className="primaryButton" type="button" disabled={!endpoint || !adminKey || disabled} onClick={() => void run("connect", connect)}>{busy === "connect" ? <Loader2 className="spin" size={14} /> : <Link2 size={14} />}连接</button>
    </div>}
    {overview?.message && <p className="inspectorHint">{overview.message}</p>}
    {error && !overview?.accounts.some(row => row.profile_id === errorTarget) && <p className="brokerError" role="alert">{error}</p>}
    {message && <p className="inspectorHint" role="status">{message}</p>}
    {!overview && !error && <p className="inspectorHint">正在读取授权状态…</p>}
    <div className="brokerListToolbar" aria-label="授权账号筛选与排序" aria-busy={!overview}>
      <div className="brokerFilterTabs" role="tablist" aria-label="授权状态筛选">
        {filterLabels.map((filter) => <button key={filter.value} className={`brokerFilterTab ${accountFilter === filter.value ? "active" : ""}`} disabled={!overview} type="button" role="tab" aria-selected={accountFilter === filter.value} onClick={() => setAccountFilter(filter.value)}>{filter.label}</button>)}
      </div>
      <div className="brokerListControls">
        <label className="brokerSearch"><Search aria-hidden="true" size={14} /><span className="visuallyHidden">搜索授权账号</span><input type="search" aria-label="搜索授权账号" placeholder="搜索邮箱后直接授权" value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} /></label>
        <label className="brokerSort"><ArrowDownUp aria-hidden="true" size={14} /><span className="visuallyHidden">排序方式</span><select aria-label="排序方式" value={accountSort} onChange={(event) => setAccountSort(event.target.value as BrokerAccountSort)}><option value="default">默认顺序</option><option value="recent">最近授权/续期</option><option value="expiry">访问凭据到期</option><option value="name">账号名称</option></select></label>
      </div>
      <p className="brokerListSummary">{overview ? `显示 ${visibleAccounts.length} / ${accountCounts.all} 个账号${accountSearch.trim() ? ` · 搜索“${accountSearch.trim()}”` : ""}` : error ? "授权状态读取失败，请点击“读取状态”重试" : "正在读取授权状态…"}</p>
    </div>
    {visibleLogin && !visibleAccounts.some(row => row.name === visibleLogin.name) && activity}
    <div className="brokerRows">{visibleAccounts.map(row => {
      const remote = row.remote;
      const canManage = ["no_trace", "broker"].includes(row.local.authority);
      const needsLogin = row.local.state === "missing";
      const needsReauthLocal = row.local.state === "reauth_required";
      // A missing or invalid local grant still needs a fresh browser login,
      // even if an old policy record says another client owned the previous
      // grant. The authority guard applies only when handing over a live
      // credential, not when creating a new OAuth grant.
      const canAuthorize = canManage || needsLogin || needsReauthLocal;
      const rowBusy = busy === row.profile_id;
      const cpaSynced = remote?.cpa_enabled && !remote.cpa_sync_error && remote.cpa_synced_generation === remote.generation;
      const rowCpaAction = cpaAction?.profileId === row.profile_id ? cpaAction : null;
      const cpaButtonLabel = rowCpaAction?.pending ? rowCpaAction.enabled ? "同步中…" : "暂停中…" : cpaSynced ? "暂停 CPA 同步" : remote?.cpa_sync_error || rowCpaAction ? "重试同步" : "同步到 CPA";
      const localStatus = needsReauthLocal ? "OAuth 已失效，需要重新授权" : needsLogin ? "尚未连接 OAuth" : "本机授权尚未纳管";
      return <article className="brokerRow" key={row.profile_id}>
        <div className="brokerRowTop"><div className="brokerRowMain"><strong>{row.name}</strong><span>{row.trashed ? "回收站账号" : "浏览器账号"} · {remote ? "已授权 · NoTrace Broker 自动续期" : row.local.authority === "broker" ? "已授权 · 正在确认授权交接" : needsReauthLocal ? localStatus : needsLogin ? `未授权 · ${localStatus}` : `已授权 · ${localStatus}`}</span></div>
          <div className="brokerRowActions">{remote ? <>
            <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} title="打开此账号的登录环境，重新取得授权凭据" onClick={() => void run(row.profile_id, () => reauthorize(row))}><KeyRound size={14} />重新授权</button>
            <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} onClick={() => void run(row.profile_id, async () => { await call("broker_refresh_account", { profileId: row.profile_id }); await read(); setMessage("刷新结果已写回 Broker"); })}><RefreshCw size={14} />立即刷新</button>
            <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} onClick={() => void run(row.profile_id, () => updateCpa(row, !cpaSynced))}>{cpaButtonLabel}</button>
            <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} onClick={() => { setPreserveRefreshToken(false); setImportPreview(null); setExportRow(row); setJsonFormat("auth_json"); }}><Download size={14} />导出 JSON</button>
          </> : <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected || !canAuthorize} onClick={() => void run(row.profile_id, () => manage(row))}>{rowBusy ? <Loader2 className="spin" size={14} /> : needsLogin || needsReauthLocal ? <KeyRound size={14} /> : <UploadCloud size={14} />}{rowBusy ? "授权处理中…" : needsLogin ? "授权并纳管" : needsReauthLocal ? "重新授权并纳管" : "交给 Broker"}</button>}</div>
        </div>
        {visibleLogin?.name === row.name && activity}
        {error && errorTarget === row.profile_id && <div className="brokerRowFeedback error" role="alert"><strong>操作未完成</strong><p>{error}</p><span>请按上方原因处理后，重新点击此账号的操作按钮。</span></div>}
        {remote && <><div className="brokerStatus"><span>访问凭据到期<b>{time(remote.expires_at)}</b></span><span>最近续期<b>{time(remote.last_refresh_at)}</b></span><span title="从启用统计起累计，只计成功续期；首次授权、重新授权和失败重试不计入。">成功续期<b>{refreshCountLabel(remote.refresh_count)}</b>{remote.refresh_count !== undefined && remote.automatic_refresh_count !== undefined && <small>自动 {remote.automatic_refresh_count} 次 · 手动 {Math.max(0, remote.refresh_count - remote.automatic_refresh_count)} 次</small>}<small>启用统计后累计</small></span><span>{remote.next_retry_at ? "计划重试" : "计划续期"}<b>{time(remote.next_retry_at ?? remote.next_refresh_at)}</b></span><span>CPA<b>{syncLabel(remote.cpa_enabled, remote.cpa_synced_generation, remote.generation, remote.cpa_sync_error)}</b></span><span>Cockpit<b>{remote.cockpit_synced_generation === remote.generation ? "已确认" : "尚未完成适配验收"}</b></span></div>{remote.error && <p className="brokerError">{errors[remote.error] ?? "授权操作未完成"}</p>}</>}
      </article>;
    })}</div>
    {overview && visibleAccounts.length === 0 && <p className="brokerEmpty">当前筛选没有匹配账号。可以切换“全部”或清空搜索。</p>}
    {!!overview?.unmatched.length && <p className="inspectorHint">服务端还有 {overview.unmatched.length} 条未绑定本机浏览器的授权。它们保留在 Broker，不会被窗口自动删除。</p>}
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
      <div className="brokerJsonCardHeader"><div><strong>JSON 导入/转换</strong><span>{importPreview.account_count} 个账号 · {importPreview.detected_format}</span></div><button className="iconButton" type="button" aria-label="关闭 JSON 导入与转换" onClick={() => setImportPreview(null)}>×</button></div>
      <p className="brokerJsonPath" title={importPreview.path}>{importPreview.path}</p>
      <p className={`brokerJsonNotice ${importPreview.contains_refresh_token ? "warning" : ""}`}>{importPreview.message}</p>
      <div className="brokerJsonAccountList">{importPreview.accounts.slice(0, 6).map((account, index) => <span key={`${account.email ?? account.account_id ?? "account"}-${index}`}><FileJson size={13} />{account.email ?? account.account_id ?? `账号 ${index + 1}`}{account.has_refresh_token ? " · 含 refresh_token" : " · access-only"}</span>)}{importPreview.account_count > 6 && <small>还有 {importPreview.account_count - 6} 个账号</small>}</div>
      <label className="brokerJsonField">转换为<select value={jsonFormat} onChange={(event) => setJsonFormat(event.target.value as BrokerJsonFormat)} disabled={disabled}>{jsonFormats.map((format) => <option value={format.value} key={format.value}>{format.label}</option>)}</select></label>
      <label className="brokerJsonCheckbox"><input type="checkbox" checked={clearImportedRefreshToken} onChange={(event) => setClearImportedRefreshToken(event.target.checked)} /><span>清空 refresh_token（生成 access-only 副本）</span></label>
      <p className={`brokerJsonNotice ${!clearImportedRefreshToken && importPreview.contains_refresh_token ? "warning" : ""}`}>{clearImportedRefreshToken ? "已选择清空：保存的目标文件只含 access token / id token；不会写入 Broker。" : importPreview.contains_refresh_token ? "默认保留输入文件中的真实 refresh_token，用于完整凭据导入/转换；这里只保存目标 JSON，不会自动写入 Broker、CPA 或 Cockpit。" : "输入文件不含 refresh_token，将生成 access-only 目标文件；这里只保存目标 JSON。"}</p>
      <div className="brokerJsonActions"><button className="secondaryButton" type="button" disabled={disabled} onClick={() => setImportPreview(null)}>关闭</button><button className="primaryButton" type="button" disabled={disabled} onClick={() => void run("convert-json", convertImportedJson)}><Download size={14} />转换并保存</button></div>
      </div>
    </div>, document.body)}
  </section>;
}
