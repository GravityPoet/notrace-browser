import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, Download, FileJson, KeyRound, Link2, Loader2, RefreshCw, Search, UploadCloud } from "lucide-react";
import type { AuthCall, AuthStatus } from "./AuthPanel";

export type BrokerMetadata = {
  key: string; email: string; account_id: string; plan_type: string | null;
  expires_at: number; last_refresh_at: number; generation: number;
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
  { value: "cockpit_tools", label: "Cockpit Tools" },
  { value: "auth_json", label: "官方 auth.json" },
  { value: "cpa", label: "CPA" },
  { value: "sub2api", label: "Sub2API" },
];
const errors: Record<string, string> = {
  reauth_required: "授权已失效，需要重新授权",
  recovery_required: "上次刷新结果不确定，已停止重用旧凭据",
  service_unavailable: "授权服务暂不可用，按计划重试",
  consumer_conflict: "接收端存在未托管凭据，未覆盖",
  identity_mismatch: "账号身份不匹配",
  storage: "凭据保存未完成，需要检查",
  unchanged: "尚未获得新的凭据",
};
function time(value: number | null) {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}
function syncLabel(enabled: boolean, synced: number | null, generation: number, error: string | null) {
  if (!enabled) return "未启用同步";
  if (error) return errors[error] ?? "同步未完成";
  return synced === generation ? `已同步 · 第 ${generation} 代` : "等待同步";
}
export function BrokerPanel({ call = nativeCall, onBusyChange }: { call?: AuthCall; onBusyChange?: (busy: boolean) => void }) {
  const [overview, setOverview] = useState<BrokerOverview | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [exportRow, setExportRow] = useState<BrokerRow | null>(null);
  const [jsonFormat, setJsonFormat] = useState<BrokerJsonFormat>("cockpit_tools");
  const [importPreview, setImportPreview] = useState<BrokerJsonPreview | null>(null);
  const [preserveRefreshToken, setPreserveRefreshToken] = useState(false);
  const [accountFilter, setAccountFilter] = useState<BrokerAccountFilter>("all");
  const [accountSearch, setAccountSearch] = useState("");
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
  async function run(label: string, operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(label); setMessage(""); setError(""); onBusyChange?.(true);
    try { await operation(); } catch (caught) { if (mounted.current) setError(String(caught)); }
    finally { inFlight.current = false; if (mounted.current) setBusy(""); onBusyChange?.(false); }
  }
  async function connect() {
    const next = await call<BrokerOverview>("save_broker_connection", { endpoint, adminKey });
    if (mounted.current) { setOverview(next); setAdminKey(""); setEditing(false); setMessage("续期服务已连接"); }
  }
  async function manage(row: BrokerRow) {
    if (row.local.state === "missing" || row.local.state === "reauth_required") await call("login_account_auth", { name: row.name });
    await call("broker_push_account", { name: row.name });
    await read();
    if (mounted.current) setMessage("授权已交给 Broker；本机已停止刷新这条授权链");
  }
  async function reauthorize(row: BrokerRow) {
    await call("login_account_auth", { name: row.name });
    await call("broker_push_account", { name: row.name });
    await read();
    if (mounted.current) setMessage("新授权已交给 Broker；下游会在下一代凭据同步后恢复");
  }
  async function importJson() {
    const path = await call<string | null>("choose_broker_json_import_path", {});
    if (!path) return;
    const preview = await call<BrokerJsonPreview>("broker_preview_json", { path });
    if (mounted.current) { setPreserveRefreshToken(false); setExportRow(null); setImportPreview(preview); }
  }
  async function exportJson(row: BrokerRow) {
    const result = await call<BrokerJsonTransferSummary>("broker_export_json", { profileId: row.profile_id, format: jsonFormat, includeRefreshToken: preserveRefreshToken });
    if (mounted.current) { setExportRow(null); setMessage(`${row.name} 的 ${jsonFormats.find((item) => item.value === jsonFormat)?.label ?? "JSON"} 已保存（${result.refresh_token_exported ? "包含 refresh_token" : "access-only"}）`); }
  }
  async function convertImportedJson() {
    if (!importPreview) return;
    const result = await call<BrokerJsonTransferSummary>("broker_convert_json", { path: importPreview.path, format: jsonFormat, includeRefreshToken: preserveRefreshToken });
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
  const disabled = Boolean(busy);
  const brokerConnected = overview?.connected ?? false;
  return <section className="brokerPanel" aria-label="统一授权续期">
    <div className="brokerPanelHeader">
      <div><span className="eyebrow">授权管理中心</span><h2 id="cloak-editor-dialog-title">统一授权续期</h2><p>查看谁负责刷新，以及各端是否收到最新凭据。</p></div>
      <div className="brokerPanelHeaderActions">
        <button className="secondaryButton" type="button" disabled={disabled} onClick={() => void run("import-json", importJson)}><UploadCloud size={14} />导入 JSON</button>
        <button className="secondaryButton" type="button" disabled={disabled} onClick={() => void run("status", read)}><RefreshCw size={14} />读取状态</button>
      </div>
    </div>
    {overview?.configured && !editing ? <p className="inspectorHint">{overview.connected ? "续期服务已连接" : "续期服务暂不可用"} · {overview.endpoint} <button className="textButton" type="button" onClick={() => setEditing(true)} disabled={disabled}>更换连接</button></p> : <div className="brokerConnection">
      <input aria-label="Broker 地址" placeholder="续期服务地址" value={endpoint} onChange={event => setEndpoint(event.target.value)} disabled={disabled} />
      <input aria-label="Broker 管理密钥" type="password" autoComplete="off" placeholder="管理密钥" value={adminKey} onChange={event => setAdminKey(event.target.value)} disabled={disabled} />
      <button className="primaryButton" type="button" disabled={!endpoint || !adminKey || disabled} onClick={() => void run("connect", connect)}>{busy === "connect" ? <Loader2 className="spin" size={14} /> : <Link2 size={14} />}连接</button>
    </div>}
    {overview?.message && <p className="inspectorHint">{overview.message}</p>}
    {error && <p className="brokerError" role="alert">{error}</p>}
    {message && <p className="inspectorHint" role="status">{message}</p>}
    {!overview && !error && <p className="inspectorHint">正在读取授权状态…</p>}
    {overview && <div className="brokerListToolbar" aria-label="授权账号筛选与排序">
      <div className="brokerFilterTabs" role="tablist" aria-label="授权状态筛选">
        {filterLabels.map((filter) => <button key={filter.value} className={`brokerFilterTab ${accountFilter === filter.value ? "active" : ""}`} type="button" role="tab" aria-selected={accountFilter === filter.value} onClick={() => setAccountFilter(filter.value)}>{filter.label}</button>)}
      </div>
      <div className="brokerListControls">
        <label className="brokerSearch"><Search aria-hidden="true" size={14} /><span className="visuallyHidden">搜索账号</span><input aria-label="搜索账号" placeholder="搜索邮箱或账号" value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} /></label>
        <label className="brokerSort"><ArrowDownUp aria-hidden="true" size={14} /><span className="visuallyHidden">排序方式</span><select aria-label="排序方式" value={accountSort} onChange={(event) => setAccountSort(event.target.value as BrokerAccountSort)}><option value="default">默认顺序</option><option value="recent">最近授权/续期</option><option value="expiry">访问凭据到期</option><option value="name">账号名称</option></select></label>
      </div>
      <p className="brokerListSummary">显示 {visibleAccounts.length} / {accountCounts.all} 个账号{accountSearch.trim() ? ` · 搜索“${accountSearch.trim()}”` : ""}</p>
    </div>}
    <div className="brokerRows">{visibleAccounts.map(row => {
      const remote = row.remote;
      const canManage = ["no_trace", "broker"].includes(row.local.authority);
      const needsLogin = row.local.state === "missing";
      const needsReauthLocal = row.local.state === "reauth_required";
      const needsReauth = Boolean(remote?.error && ["reauth_required", "recovery_required"].includes(remote.error));
      const localStatus = needsReauthLocal ? "OAuth 已失效，需要重新授权" : needsLogin ? "尚未连接 OAuth" : "本机授权尚未纳管";
      return <article className="brokerRow" key={row.profile_id}>
        <div className="brokerRowTop"><div className="brokerRowMain"><strong>{row.name}</strong><span>{row.trashed ? "回收站账号" : "浏览器账号"} · {remote ? `已授权 · NoTrace Broker 负责刷新 · 第 ${remote.generation} 代` : row.local.authority === "broker" ? "已授权 · 正在确认授权交接" : needsReauthLocal ? localStatus : needsLogin ? `未授权 · ${localStatus}` : `已授权 · ${localStatus}`}</span></div>
          <div className="brokerRowActions">{remote ? needsReauth ? <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} onClick={() => void run(row.profile_id, () => reauthorize(row))}><KeyRound size={14} />重新授权并纳管</button> : <>
            <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} onClick={() => void run(row.profile_id, async () => { await call("broker_refresh_account", { profileId: row.profile_id }); await read(); setMessage("刷新结果已写回 Broker"); })}><RefreshCw size={14} />立即刷新</button>
            <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} onClick={() => void run(row.profile_id, async () => { await call("broker_set_cpa", { profileId: row.profile_id, enabled: !remote.cpa_enabled }); await read(); })}>{remote.cpa_enabled ? "暂停 CPA 同步" : "同步到 CPA"}</button>
            <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected} onClick={() => { setPreserveRefreshToken(false); setImportPreview(null); setExportRow(row); setJsonFormat("cockpit_tools"); }}><Download size={14} />导出 JSON</button>
          </> : <button className="secondaryButton" type="button" disabled={disabled || !brokerConnected || !canManage} onClick={() => void run(row.profile_id, () => manage(row))}>{needsLogin || needsReauthLocal ? <KeyRound size={14} /> : <UploadCloud size={14} />}{needsLogin ? "授权并纳管" : needsReauthLocal ? "重新授权并纳管" : "交给 Broker"}</button>}</div>
        </div>
        {remote && <><div className="brokerStatus"><span>访问凭据到期<b>{time(remote.expires_at)}</b></span><span>最近续期<b>{time(remote.last_refresh_at)}</b></span><span>{remote.next_retry_at ? "计划重试" : "计划续期"}<b>{time(remote.next_retry_at ?? remote.next_refresh_at)}</b></span><span>CPA<b>{syncLabel(remote.cpa_enabled, remote.cpa_synced_generation, remote.generation, remote.cpa_sync_error)}</b></span><span>Cockpit<b>{remote.cockpit_synced_generation === remote.generation ? `已确认 · 第 ${remote.generation} 代` : "尚未完成适配验收"}</b></span></div>{remote.error && <p className="brokerError">{errors[remote.error] ?? "授权操作未完成"}</p>}</>}
      </article>;
    })}</div>
    {overview && visibleAccounts.length === 0 && <p className="brokerEmpty">当前筛选没有匹配账号。可以切换“全部”或清空搜索。</p>}
    {!!overview?.unmatched.length && <p className="inspectorHint">服务端还有 {overview.unmatched.length} 条未绑定本机浏览器的授权。它们保留在 Broker，不会被窗口自动删除。</p>}
    {exportRow && <div className="brokerJsonOverlay">
      <div className="brokerJsonCard" role="dialog" aria-modal="true" aria-label="导出 JSON">
      <div className="brokerJsonCardHeader"><div><strong>导出 JSON</strong><span>{exportRow.name}</span></div><button className="iconButton" type="button" aria-label="关闭导出 JSON" onClick={() => setExportRow(null)}>×</button></div>
      <label className="brokerJsonField">导出格式<select value={jsonFormat} onChange={(event) => setJsonFormat(event.target.value as BrokerJsonFormat)} disabled={disabled}>{jsonFormats.map((format) => <option value={format.value} key={format.value}>{format.label}</option>)}</select></label>
      <label className="brokerJsonCheckbox"><input type="checkbox" checked={!preserveRefreshToken} onChange={(event) => setPreserveRefreshToken(!event.target.checked)} /><span>清空 refresh_token（推荐）</span></label>
      <p className={`brokerJsonNotice ${preserveRefreshToken ? "warning" : ""}`}>{preserveRefreshToken ? "取消清空后，真实 refresh_token 会写入导出文件；导入 Cockpit/CPA 后可能产生第二个刷新者，仅用于明确迁移或离线备份。" : "默认只导出 access token / id token；refresh_token 为空，由 NoTrace Broker 继续负责续期。"}</p>
      <div className="brokerJsonActions"><button className="secondaryButton" type="button" disabled={disabled} onClick={() => setExportRow(null)}>取消</button><button className="primaryButton" type="button" disabled={disabled} onClick={() => void run("export-json", () => exportJson(exportRow))}><Download size={14} />保存 JSON</button></div>
      </div>
    </div>}
    {importPreview && <div className="brokerJsonOverlay">
      <div className="brokerJsonCard" role="dialog" aria-modal="true" aria-label="导入 JSON">
      <div className="brokerJsonCardHeader"><div><strong>导入 JSON</strong><span>{importPreview.account_count} 个账号 · {importPreview.detected_format}</span></div><button className="iconButton" type="button" aria-label="关闭导入 JSON" onClick={() => setImportPreview(null)}>×</button></div>
      <p className="brokerJsonPath" title={importPreview.path}>{importPreview.path}</p>
      <p className={`brokerJsonNotice ${importPreview.contains_refresh_token ? "warning" : ""}`}>{importPreview.message}</p>
      <div className="brokerJsonAccountList">{importPreview.accounts.slice(0, 6).map((account, index) => <span key={`${account.email ?? account.account_id ?? "account"}-${index}`}><FileJson size={13} />{account.email ?? account.account_id ?? `账号 ${index + 1}`}{account.has_refresh_token ? " · 含 refresh_token" : " · access-only"}</span>)}{importPreview.account_count > 6 && <small>还有 {importPreview.account_count - 6} 个账号</small>}</div>
      <label className="brokerJsonField">转换为<select value={jsonFormat} onChange={(event) => setJsonFormat(event.target.value as BrokerJsonFormat)} disabled={disabled}>{jsonFormats.map((format) => <option value={format.value} key={format.value}>{format.label}</option>)}</select></label>
      <label className="brokerJsonCheckbox"><input type="checkbox" checked={!preserveRefreshToken} onChange={(event) => setPreserveRefreshToken(!event.target.checked)} /><span>清空 refresh_token（推荐）</span></label>
      {preserveRefreshToken && <p className="brokerJsonNotice warning">取消清空后，输入文件中的真实 refresh_token 会写入转换结果；这可能让下游客户端独立续期。</p>}
      <div className="brokerJsonActions"><button className="secondaryButton" type="button" disabled={disabled} onClick={() => setImportPreview(null)}>关闭</button><button className="primaryButton" type="button" disabled={disabled} onClick={() => void run("convert-json", convertImportedJson)}><Download size={14} />转换并保存</button></div>
      </div>
    </div>}
  </section>;
}
