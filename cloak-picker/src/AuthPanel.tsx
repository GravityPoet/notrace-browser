import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, RefreshCw } from "lucide-react";

export type AuthStatus = {
  account: string;
  state: "missing" | "connected" | "expiring" | "expired" | "reauth_required" | "refresh_failed";
  email: string | null;
  plan_type: string | null;
  expires_at: number | null;
  last_refresh_at: number | null;
  auto_refresh: boolean;
  next_retry_at: number | null;
  authority: "no_trace" | "codex" | "cpa" | "cockpit" | "broker";
  message: string | null;
};

type Operation = "login_account_auth" | "refresh_account_auth" | "set_auth_auto_refresh";
export type AuthCall = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
const demoAuth = new Map<string, AuthStatus>();
function missing(name: string): AuthStatus {
  return { account: name, state: "missing", email: null, plan_type: null, expires_at: null,
    last_refresh_at: null, auto_refresh: false, next_retry_at: null, authority: "no_trace", message: null };
}
async function nativeCall<T>(command: string, args: Record<string, unknown>): Promise<T> {
  // Same explicit development-only preview boundary as the rest of Picker.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const name = String(args.name);
    let status = demoAuth.get(name) ?? missing(name);
    if (command === "login_account_auth" || command === "refresh_account_auth") {
      const seconds = Math.floor(Date.now() / 1000);
      status = { ...status, state: "connected", email: name, plan_type: "plus",
        expires_at: seconds + 864000, last_refresh_at: seconds, auto_refresh: true, authority: "no_trace" };
    } else if (command === "set_auth_auto_refresh") {
      status = { ...status, auto_refresh: Boolean(args.enabled) };
    }
    demoAuth.set(name, status);
    return (command === "cancel_account_auth" ? false : status) as T;
  }
  return invoke<T>(command, args);
}
const labels: Record<AuthStatus["state"], string> = {
  missing: "未连接", connected: "已连接", expiring: "即将到期", expired: "已到期",
  reauth_required: "需要重新授权", refresh_failed: "刷新未完成",
};
const authorityLabels: Record<AuthStatus["authority"], string> = {
  no_trace: "NoTrace",
  codex: "官方 Codex",
  cpa: "CPA",
  cockpit: "Cockpit",
  broker: "NoTrace Broker",
};
function time(seconds: number | null) {
  return seconds ? new Date(seconds * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }) : "—";
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="infoRow"><span className="infoLabel">{label}</span><span className="infoValue">{value}</span></div>;
}
export function AuthPanel({ name, call = nativeCall }: { name: string; call?: AuthCall }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef(name);
  current.current = name;
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setStatus(null); setError(""); setNotice("");
    const read = async () => {
      if (inFlight.current) return;
      try {
        const next = await call<AuthStatus>("auth_status", { name });
        if (!cancelled && next.account === name) setStatus(next);
      } catch { if (!cancelled) setError("无法读取授权状态，请重试"); }
    };
    void read();
    // Local metadata only; this never initiates a token refresh.
    const timer = window.setInterval(() => void read(), 30_000);
    return () => { cancelled = true; mounted.current = false; window.clearInterval(timer); };
  }, [name, call]);
  async function run(operation: Operation) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(operation); setError(""); setNotice("");
    const target = name;
    try {
      const next = await call<AuthStatus>(operation, {
        name: target,
        ...(operation === "set_auth_auto_refresh" ? { enabled: !status?.auto_refresh } : {}),
      });
      if (!mounted.current || current.current !== target) return;
      setStatus(next);
      if (operation === "refresh_account_auth" && ["connected", "expiring"].includes(next.state)) setNotice("刷新完成，凭证已保存");
      if (operation === "login_account_auth" && next.state === "connected") setNotice("授权已连接，自动续期已开启");
    } catch (caught) {
      if (mounted.current && current.current === target) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current && current.current === target) setBusy(null);
    }
  }
  async function cancel() {
    try { await call<boolean>("cancel_account_auth", { name }); }
    catch { setError("取消授权失败，请重试"); }
  }
  const visible = status?.account === name ? status : null;
  const connected = visible?.expires_at != null;
  const noTraceOwnsRefresh = visible?.authority === "no_trace";
  return <section className="inspectorGroup authPanel" aria-label="ChatGPT 授权" data-account={name}>
    <h2>ChatGPT 授权</h2>
    <div>
      <Row label="状态" value={busy === "login_account_auth" ? "等待浏览器授权" : busy === "refresh_account_auth" ? "正在刷新" : visible ? labels[visible.state] : "读取中"} />
      {connected && <>
        <Row label="账号" value={visible.email ?? "无邮箱信息"} />
        <Row label="订阅" value={visible.plan_type ?? "未知"} />
        <Row label="凭证到期" value={time(visible.expires_at)} />
        <Row label="最近更新" value={time(visible.last_refresh_at)} />
        <Row label="刷新权威" value={authorityLabels[visible.authority]} />
        <Row label="自动续期" value={visible.auto_refresh ? "已开启 · 到期前 36 小时续期" : "已暂停"} />
      </>}
      <p className="inspectorHint">{connected ? (noTraceOwnsRefresh ? "每天检查，到期前才刷新。回收站账号同样适用。" : `${authorityLabels[visible.authority]}负责刷新，NoTrace 不会并发轮换这条授权链。`) : "连接一次官方授权，即可为这个账号自动续期。已有网页登录可用于完成授权。"}</p>
      {busy === "login_account_auth" && <p className="inspectorHint" role="status">请在此账号的浏览器中完成 OpenAI 授权；最多等待 10 分钟。</p>}
      {visible?.message && <p className="inspectorHint">{visible.message}</p>}
      {visible?.next_retry_at && <p className="inspectorHint">下次重试：{time(visible.next_retry_at)}</p>}
      {error && <p className="inspectorHint authError" role="alert">{error}</p>}
      {notice && <p className="inspectorHint" role="status">{notice}</p>}
      <div className="authActions">
        <button className="secondaryButton" type="button" disabled={Boolean(busy)} onClick={() => void run("login_account_auth")}>
          {busy === "login_account_auth" ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}
          {connected ? "重新连接" : "连接官方账号"}
        </button>
        {connected && <>
          {noTraceOwnsRefresh && <button className="secondaryButton" type="button" disabled={Boolean(busy)} onClick={() => void run("refresh_account_auth")}><RefreshCw size={14} />立即刷新</button>}
          {noTraceOwnsRefresh && <button className="secondaryButton" type="button" disabled={Boolean(busy)} onClick={() => void run("set_auth_auto_refresh")}>{visible?.auto_refresh ? "暂停续期" : "开启续期"}</button>}
        </>}
        {busy === "login_account_auth" && <button className="secondaryButton" type="button" onClick={() => void cancel()}>取消授权</button>}
      </div>
    </div>
  </section>;
}
