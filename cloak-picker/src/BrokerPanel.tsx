import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Link2, Loader2, RefreshCw, UploadCloud } from "lucide-react";
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
const nativeCall: AuthCall = (command, args) => invoke(command, args);
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
  const disabled = Boolean(busy);
  return <section className="brokerPanel" aria-label="统一授权续期">
    <div className="brokerPanelHeader">
      <div><span className="eyebrow">授权管理中心</span><h2 id="cloak-editor-dialog-title">统一授权续期</h2><p>查看谁负责刷新，以及各端是否收到最新凭据。</p></div>
      <button className="secondaryButton" type="button" disabled={disabled} onClick={() => void run("status", read)}><RefreshCw size={14} />读取状态</button>
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
    <div className="brokerRows">{overview?.accounts.map(row => {
      const remote = row.remote;
      const canManage = ["no_trace", "broker"].includes(row.local.authority);
      const needsLogin = ["missing", "reauth_required"].includes(row.local.state);
      return <article className="brokerRow" key={row.profile_id}>
        <div className="brokerRowTop"><div className="brokerRowMain"><strong>{row.name}</strong><span>{row.trashed ? "回收站账号" : "浏览器账号"} · {remote ? `NoTrace Broker 负责刷新 · 第 ${remote.generation} 代` : row.local.authority === "broker" ? "正在确认授权交接" : needsLogin ? "尚未连接 OAuth" : "本机授权尚未纳管"}</span></div>
          <div className="brokerRowActions">{remote ? <>
            <button className="secondaryButton" type="button" disabled={disabled || !overview.connected || Boolean(remote.error && ["reauth_required", "recovery_required"].includes(remote.error))} onClick={() => void run(row.profile_id, async () => { await call("broker_refresh_account", { profileId: row.profile_id }); await read(); setMessage("刷新结果已写回 Broker"); })}><RefreshCw size={14} />立即刷新</button>
            <button className="secondaryButton" type="button" disabled={disabled || !overview.connected} onClick={() => void run(row.profile_id, async () => { await call("broker_set_cpa", { profileId: row.profile_id, enabled: !remote.cpa_enabled }); await read(); })}>{remote.cpa_enabled ? "暂停 CPA 同步" : "同步到 CPA"}</button>
          </> : <button className="secondaryButton" type="button" disabled={disabled || !overview.connected || !canManage} onClick={() => void run(row.profile_id, () => manage(row))}>{needsLogin ? <KeyRound size={14} /> : <UploadCloud size={14} />}{needsLogin ? "授权并纳管" : "交给 Broker"}</button>}</div>
        </div>
        {remote && <><div className="brokerStatus"><span>访问凭据到期<b>{time(remote.expires_at)}</b></span><span>最近续期<b>{time(remote.last_refresh_at)}</b></span><span>{remote.next_retry_at ? "计划重试" : "计划续期"}<b>{time(remote.next_retry_at ?? remote.next_refresh_at)}</b></span><span>CPA<b>{syncLabel(remote.cpa_enabled, remote.cpa_synced_generation, remote.generation, remote.cpa_sync_error)}</b></span><span>Cockpit<b>{remote.cockpit_synced_generation === remote.generation ? `已确认 · 第 ${remote.generation} 代` : "尚未完成适配验收"}</b></span></div>{remote.error && <p className="brokerError">{errors[remote.error] ?? "授权操作未完成"}</p>}</>}
      </article>;
    })}</div>
    {!!overview?.unmatched.length && <p className="inspectorHint">服务端还有 {overview.unmatched.length} 条未绑定本机浏览器的授权。它们保留在 Broker，不会被窗口自动删除。</p>}
  </section>;
}
