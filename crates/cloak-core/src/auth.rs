//! Per-profile ChatGPT OAuth, using the official Codex app-server over stdio.
//! Tokens stay in a private NoTrace directory. Only expiry/status metadata crosses
//! the UI boundary; browser cookies and other applications' credentials are never imported.

use crate::{read_account, CloakConfig, CloakError, LaunchOptions, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};
use url::Url;
use zeroize::Zeroizing;

const RPC_TIMEOUT: Duration = Duration::from_secs(45);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CHECK_INTERVAL: u64 = 24 * 60 * 60;
const REFRESH_LEAD_TIME: u64 = 36 * 60 * 60;
const MAX_AUTH_BYTES: u64 = 128 * 1024;
const ROOT_NAME: &str = ".notrace-oauth";
const STATE_FILE: &str = "notrace-state.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    Missing,
    Connected,
    Expiring,
    Expired,
    ReauthRequired,
    RefreshFailed,
}

/// The application that is allowed to rotate this OAuth credential chain.
///
/// A ChatGPT email address is not a credential identity: Cockpit, Codex, CPA,
/// and NoTrace may each have separate grants for the same email. When a grant
/// is deliberately handed to another application, NoTrace records that owner
/// and stops rotating the chain locally. This prevents accidental
/// `refresh_token_reused` errors without pretending that the applications share
/// a stable external API.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthAuthority {
    #[default]
    NoTrace,
    Codex,
    Cpa,
    Cockpit,
}

impl AuthAuthority {
    pub fn label(self) -> &'static str {
        match self {
            Self::NoTrace => "NoTrace",
            Self::Codex => "官方 Codex",
            Self::Cpa => "CPA",
            Self::Cockpit => "Cockpit",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub account: String,
    pub state: AuthState,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub expires_at: Option<u64>,
    pub last_refresh_at: Option<u64>,
    pub auto_refresh: bool,
    pub authority: AuthAuthority,
    pub next_retry_at: Option<u64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AuthRefreshSummary {
    pub attempted: u32,
    pub refreshed: u32,
    pub skipped: u32,
    pub failed: u32,
    pub next_check_in_seconds: u64,
}

// Only these controlled messages may be persisted or shown. An app-server error
// can include a response body or authorization URL: never forward its raw text.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Failure {
    Busy,
    Cancelled,
    Timeout,
    Service,
    Credentials,
    Reauth,
    Identity,
    Unchanged,
    Recovery,
    Browser,
}
impl Failure {
    fn message(self) -> &'static str {
        match self {
            Self::Busy => "该账号正在授权或刷新，请等待当前操作完成",
            Self::Cancelled => "授权已取消，原有凭证保持不变",
            Self::Timeout => "官方授权服务响应超时，可稍后重试",
            Self::Service => "官方授权服务暂不可用，请检查网络或 Codex CLI",
            Self::Credentials => "授权文件缺失或格式无效，需要重新连接账号",
            Self::Reauth => "授权已过期、撤销或被其他程序轮换，请重新连接账号",
            Self::Identity => "授权账号与所选账号不匹配，原有凭证保持不变",
            Self::Unchanged => "尚未确认新凭证已写回，未报告刷新成功",
            Self::Recovery => "上次刷新尚未完成保存，已保留恢复副本；请点立即刷新恢复或重新连接",
            Self::Browser => "未能在所选 NoTrace 账号中打开授权页，请先确认该账号可以正常启动",
        }
    }
    fn terminal(self) -> bool {
        matches!(
            self,
            Self::Reauth | Self::Credentials | Self::Identity | Self::Recovery
        )
    }
}
impl From<Failure> for CloakError {
    fn from(value: Failure) -> Self {
        Self::Auth(value.message().to_string())
    }
}
type AuthResult<T> = std::result::Result<T, Failure>;

#[derive(Default, Serialize, Deserialize)]
struct AuthPolicy {
    #[serde(default)]
    authority: AuthAuthority,
    enabled: bool,
    last_refresh_at: Option<u64>,
    next_retry_at: Option<u64>,
    failures: u32,
    error: Option<Failure>,
}

// Raw token contents are never Debug/Serialize and never leave this module.
struct Credentials {
    body: Zeroizing<String>,
    digest: String,
    expires_at: u64,
    email: Option<String>,
    plan_type: Option<String>,
    account_id: Option<String>,
}
impl Credentials {
    fn read(home: &Path) -> AuthResult<Option<Self>> {
        let path = home.join("auth.json");
        reject_symlink(&path).map_err(|_| Failure::Credentials)?;
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Failure::Credentials),
        };
        let mut body = Zeroizing::new(String::new());
        file.take(MAX_AUTH_BYTES + 1)
            .read_to_string(&mut body)
            .map_err(|_| Failure::Credentials)?;
        if body.len() as u64 > MAX_AUTH_BYTES {
            return Err(Failure::Credentials);
        }
        let root: Value = serde_json::from_str(&body).map_err(|_| Failure::Credentials)?;
        if root
            .get("OPENAI_API_KEY")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.is_empty())
        {
            return Err(Failure::Credentials);
        }
        let access = root
            .pointer("/tokens/access_token")
            .and_then(Value::as_str)
            .ok_or(Failure::Credentials)?;
        let refresh = root
            .pointer("/tokens/refresh_token")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or(Failure::Credentials)?;
        let claims = jwt_claims(access)?;
        let expires_at = claims
            .get("exp")
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .ok_or(Failure::Credentials)?;
        let identity = root
            .pointer("/tokens/id_token")
            .and_then(Value::as_str)
            .and_then(|v| jwt_claims(v).ok())
            .unwrap_or(Value::Null);
        let email = claims
            .pointer("/https:~1~1api.openai.com~1profile/email")
            .and_then(Value::as_str)
            .or_else(|| identity.get("email").and_then(Value::as_str))
            .map(ToOwned::to_owned);
        let plan_type = claims
            .pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let account_id = root
            .pointer("/tokens/account_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let mut hash = Sha256::new();
        hash.update(access.as_bytes());
        hash.update([0]);
        hash.update(refresh.as_bytes());
        let digest = format!("{:x}", hash.finalize());
        Ok(Some(Self {
            body,
            digest,
            expires_at,
            email,
            plan_type,
            account_id,
        }))
    }
}

// Decoding is only for scheduling and identity comparison after official login;
// it does not replace token validation by OpenAI.
fn jwt_claims(token: &str) -> AuthResult<Value> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(Failure::Credentials);
    }
    let payload = URL_SAFE_NO_PAD
        .decode(parts[1].trim_end_matches('='))
        .map_err(|_| Failure::Credentials)?;
    serde_json::from_slice(&payload).map_err(|_| Failure::Credentials)
}
fn now() -> u64 {
    crate::current_epoch_secs()
}
fn due_at(expiry: u64) -> u64 {
    expiry.saturating_sub(REFRESH_LEAD_TIME)
}

fn reject_symlink(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(Failure::Credentials.into()),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}
fn auth_home(config: &CloakConfig, name: &str, create: bool) -> Result<PathBuf> {
    reject_symlink(&config.account_base)?;
    reject_symlink(&config.profile_dir(name))?;
    let account = read_account(config, name)?;
    if !account
        .profile_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Failure::Credentials.into());
    }
    // Stable profile ID preserves the binding across account renames. Hidden
    // storage is intentionally excluded from portable browser-profile archives.
    let root = config
        .account_base
        .parent()
        .unwrap_or(&config.account_base)
        .join(ROOT_NAME);
    let home = root.join(account.profile_id);
    for path in [&root, &home] {
        reject_symlink(path)?;
        if create {
            fs::create_dir_all(path)?;
            crate::secure_dir(path)?;
        }
    }
    for file in [
        "auth.json",
        STATE_FILE,
        ".operation.lock",
        ".pending-refresh",
        ".pending-login",
    ] {
        reject_symlink(&home.join(file))?;
    }
    Ok(home)
}
fn lock(path: &Path) -> Result<File> {
    reject_symlink(path)?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    fs4::FileExt::try_lock(&file).map_err(|_| Failure::Busy)?;
    Ok(file)
}
fn policy(home: &Path) -> Result<AuthPolicy> {
    let path = home.join(STATE_FILE);
    reject_symlink(&path)?;
    if !path.exists() {
        return Ok(AuthPolicy::default());
    }
    let file = File::open(path)?;
    serde_json::from_reader(file.take(16 * 1024)).map_err(|_| Failure::Credentials.into())
}
fn save_policy(home: &Path, value: &AuthPolicy) -> Result<()> {
    crate::write_secret_atomic(&home.join(STATE_FILE), &serde_json::to_string(value)?)
}
fn failed_policy(home: &Path, failure: Failure) -> Result<()> {
    if matches!(failure, Failure::Busy | Failure::Cancelled) {
        return Ok(());
    }
    let mut p = policy(home)?;
    p.failures = p.failures.saturating_add(1);
    p.error = Some(failure);
    p.next_retry_at = if failure.terminal() {
        None
    } else {
        Some(
            now()
                + match p.failures {
                    1 => 15 * 60,
                    2 => 60 * 60,
                    _ => 6 * 60 * 60,
                },
        )
    };
    save_policy(home, &p)
}
fn successful_policy(home: &Path, enable: bool) -> Result<()> {
    let mut p = policy(home)?;
    if enable {
        p.enabled = true;
    }
    p.last_refresh_at = Some(now());
    p.error = None;
    p.failures = 0;
    p.next_retry_at = None;
    save_policy(home, &p)
}

pub fn auth_status(config: &CloakConfig, name: &str) -> Result<AuthStatus> {
    let home = auth_home(config, name, false)?;
    status_at(&home, name)
}
fn status_at(home: &Path, name: &str) -> Result<AuthStatus> {
    let p = policy(home)?;
    let creds = Credentials::read(home);
    let (mut state, data) = match creds {
        Ok(None) => (AuthState::Missing, None),
        Ok(Some(c)) => {
            let state = if c.expires_at <= now() {
                AuthState::Expired
            } else if due_at(c.expires_at) <= now() {
                AuthState::Expiring
            } else {
                AuthState::Connected
            };
            (state, Some(c))
        }
        Err(_) => (AuthState::ReauthRequired, None),
    };
    if let Some(error) = p.error {
        state = if error.terminal() {
            AuthState::ReauthRequired
        } else {
            AuthState::RefreshFailed
        };
    }
    let message = p
        .error
        .map(|v| v.message().to_string())
        .or_else(|| {
            (p.authority != AuthAuthority::NoTrace).then(|| {
                format!(
                    "{} 负责刷新这条授权链；NoTrace 不会自动轮换它",
                    p.authority.label()
                )
            })
        })
        .or_else(|| match state {
            AuthState::Missing => {
                Some("连接一次后，NoTrace 会按到期时间自动续期此授权".to_string())
            }
            AuthState::ReauthRequired => Some(Failure::Credentials.message().to_string()),
            _ => None,
        });
    Ok(AuthStatus {
        account: name.to_string(),
        state,
        email: data.as_ref().and_then(|c| c.email.clone()),
        plan_type: data.as_ref().and_then(|c| c.plan_type.clone()),
        expires_at: data.as_ref().map(|c| c.expires_at),
        last_refresh_at: p.last_refresh_at,
        auto_refresh: p.enabled,
        authority: p.authority,
        next_retry_at: p.next_retry_at,
        message,
    })
}
pub fn set_auth_auto_refresh(
    config: &CloakConfig,
    name: &str,
    enabled: bool,
) -> Result<AuthStatus> {
    let home = auth_home(config, name, false)?;
    if !home.exists() {
        return status_at(&home, name);
    }
    let _lock = lock(&home.join(".operation.lock"))?;
    let mut p = policy(&home)?;
    if enabled && p.authority != AuthAuthority::NoTrace {
        return Err(CloakError::Auth(format!(
            "{} 已登记为这条授权链的刷新权威，请先切回 NoTrace",
            p.authority.label()
        )));
    }
    p.enabled = enabled;
    save_policy(&home, &p)?;
    status_at(&home, name)
}

/// Explicitly assign the refresh authority for an already-authorized grant.
/// Assigning an external authority disables both scheduled and manual NoTrace
/// refreshes. Switching back is an explicit takeover: callers must stop the
/// external application's refresh first.
pub fn set_auth_authority(
    config: &CloakConfig,
    name: &str,
    authority: AuthAuthority,
) -> Result<AuthStatus> {
    let home = auth_home(config, name, false)?;
    if !home.exists() {
        return status_at(&home, name);
    }
    let _lock = lock(&home.join(".operation.lock"))?;
    if Credentials::read(&home)
        .map_err(|_| CloakError::Auth("授权文件无效，需要先重新连接账号".to_string()))?
        .is_none()
    {
        return Err(CloakError::Auth(
            "账号尚未连接 OAuth，不能登记刷新权威".to_string(),
        ));
    }
    let mut p = policy(&home)?;
    p.authority = authority;
    p.enabled = authority == AuthAuthority::NoTrace;
    p.next_retry_at = None;
    p.error = None;
    p.failures = 0;
    save_policy(&home, &p)?;
    status_at(&home, name)
}

/// Remove the private OAuth grant when an account is permanently purged.
/// Soft-deleting an account intentionally leaves this directory untouched so
/// recycle-bin accounts remain refreshable.
pub fn remove_account_auth(config: &CloakConfig, name: &str) -> Result<()> {
    let home = auth_home(config, name, false)?;
    if !home.exists() {
        return Ok(());
    }
    let root = home
        .parent()
        .ok_or_else(|| CloakError::Auth("授权目录层级无效".to_string()))?;
    reject_symlink(root)?;
    fs::remove_dir_all(&home)?;
    crate::sync_directory(root)?;
    Ok(())
}

fn ensure_identity(name: &str, old: Option<&Credentials>, new: &Credentials) -> AuthResult<()> {
    let expected = old
        .and_then(|c| c.email.as_deref())
        .or_else(|| name.contains('@').then_some(name));
    if let Some(expected) = expected {
        if !new
            .email
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case(expected))
        {
            return Err(Failure::Identity);
        }
    }
    if let Some(id) = old.and_then(|c| c.account_id.as_deref()) {
        if new.account_id.as_deref() != Some(id) {
            return Err(Failure::Identity);
        }
    }
    Ok(())
}
fn promote(home: &Path, candidate: &Credentials) -> Result<()> {
    // The pending directory remains intact until the canonical file is durable.
    // Never roll back to an old refresh token after the server has rotated it.
    crate::write_secret_atomic(&home.join("auth.json"), &candidate.body)
}
fn prepare_pending(home: &Path, kind: &str, previous: Option<&Credentials>) -> Result<PathBuf> {
    let pending = home.join(kind);
    reject_symlink(&pending)?;
    if pending.exists() {
        return Err(Failure::Recovery.into());
    }
    fs::create_dir(&pending)?;
    crate::secure_dir(&pending)?;
    if let Some(previous) = previous {
        crate::write_secret_atomic(&pending.join("auth.json"), &previous.body)?;
    }
    Ok(pending)
}
fn cleanup_pending(path: &Path) -> Result<()> {
    fs::remove_dir_all(path).map_err(Into::into)
}

pub fn refresh_account_auth(config: &CloakConfig, name: &str) -> Result<AuthStatus> {
    refresh_with(config, name, &resolve_codex_binary()?)
}
fn refresh_with(config: &CloakConfig, name: &str, binary: &Path) -> Result<AuthStatus> {
    let home = auth_home(config, name, false)?;
    if !home.exists() {
        return status_at(&home, name);
    }
    let _lock = lock(&home.join(".operation.lock"))?;
    let authority = policy(&home)?.authority;
    if authority != AuthAuthority::NoTrace {
        return Err(CloakError::Auth(format!(
            "{} 负责刷新这条授权链，NoTrace 不会并发轮换",
            authority.label()
        )));
    }
    let previous = match Credentials::read(&home) {
        Ok(Some(c)) => c,
        Ok(None) => return status_at(&home, name),
        Err(e) => {
            failed_policy(&home, e)?;
            return status_at(&home, name);
        }
    };
    let pending = home.join(".pending-refresh");
    if pending.exists() {
        // Recover a completed rotation interrupted before the canonical save.
        if let Ok(Some(candidate)) = Credentials::read(&pending) {
            if candidate.digest != previous.digest
                && candidate.expires_at > now()
                && ensure_identity(name, Some(&previous), &candidate).is_ok()
            {
                promote(&home, &candidate)?;
                successful_policy(&home, false)?;
                cleanup_pending(&pending)?;
                return status_at(&home, name);
            }
            if candidate.digest == previous.digest {
                cleanup_pending(&pending)?;
            } else {
                failed_policy(&home, Failure::Recovery)?;
                return status_at(&home, name);
            }
        } else {
            failed_policy(&home, Failure::Recovery)?;
            return status_at(&home, name);
        }
    }
    if policy(&home)?.error.is_some_and(|e| e.terminal()) {
        return status_at(&home, name);
    }
    let pending = prepare_pending(&home, ".pending-refresh", Some(&previous))?;
    let cancel = AtomicBool::new(false);
    let operation = (|| {
        let mut rpc = RpcSession::start(binary, &pending, proxy(config, name)?, &cancel)?;
        let response = rpc.request(
            2,
            "account/read",
            json!({"refreshToken": true}),
            RPC_TIMEOUT,
            &cancel,
        )?;
        if response.pointer("/account/type").and_then(Value::as_str) != Some("chatgpt") {
            return Err(Failure::Reauth);
        }
        Ok(())
    })();
    let candidate = Credentials::read(&pending);
    // Save rotated credentials even when a subsequent account-info request fails.
    // This is the recovery path; returning to the previous token would lose the rotation.
    if let Ok(Some(candidate)) = candidate.as_ref() {
        if candidate.digest != previous.digest && candidate.expires_at > now().saturating_add(60) {
            if let Err(e) = ensure_identity(name, Some(&previous), candidate) {
                failed_policy(&home, e)?;
                return status_at(&home, name);
            }
            promote(&home, candidate)?;
            successful_policy(&home, false)?;
            cleanup_pending(&pending)?;
            return status_at(&home, name);
        }
    }
    let failure = operation.err().unwrap_or(Failure::Unchanged);
    if candidate
        .as_ref()
        .ok()
        .and_then(Option::as_ref)
        .is_some_and(|c| c.digest == previous.digest)
    {
        cleanup_pending(&pending)?;
        failed_policy(&home, failure)?;
    } else {
        failed_policy(&home, Failure::Recovery)?;
    }
    status_at(&home, name)
}

pub fn login_account_auth(config: &CloakConfig, name: &str) -> Result<AuthStatus> {
    login_account_auth_with_cancellation(config, name, &AtomicBool::new(false))
}
pub fn login_account_auth_with_cancellation(
    config: &CloakConfig,
    name: &str,
    cancel: &AtomicBool,
) -> Result<AuthStatus> {
    login_with(config, name, &resolve_codex_binary()?, cancel, |raw| {
        validate_auth_url(raw)?;
        let mut options = LaunchOptions::from_env(false);
        options.preflight = crate::PreflightMode::Off;
        let start = Instant::now();
        let plan = crate::build_launch_plan_for_url(config, name, &options, raw)
            .map_err(|_| Failure::Browser)?;
        crate::launch_plan(config, plan, &options, start).map_err(|_| Failure::Browser)?;
        Ok(())
    })
}
fn login_with(
    config: &CloakConfig,
    name: &str,
    binary: &Path,
    cancel: &AtomicBool,
    open: impl FnOnce(&str) -> AuthResult<()>,
) -> Result<AuthStatus> {
    let home = auth_home(config, name, true)?;
    let _login_lock = lock(
        &home
            .parent()
            .ok_or(Failure::Credentials)?
            .join(".login.lock"),
    )?;
    let _lock = lock(&home.join(".operation.lock"))?;
    let previous = Credentials::read(&home).ok().flatten();
    let pending = home.join(".pending-login");
    if pending.exists() {
        cleanup_pending(&pending)?;
    }
    let pending = prepare_pending(&home, ".pending-login", None)?;
    let result = (|| -> AuthResult<Credentials> {
        let mut rpc = RpcSession::start(binary, &pending, proxy(config, name)?, cancel)?;
        let response = rpc.request(
            2,
            "account/login/start",
            json!({"type":"chatgpt", "useHostedLoginSuccessPage":false}),
            RPC_TIMEOUT,
            cancel,
        )?;
        let url = response
            .get("authUrl")
            .and_then(Value::as_str)
            .ok_or(Failure::Service)?;
        validate_auth_url(url)?;
        let login_id = response
            .get("loginId")
            .and_then(Value::as_str)
            .ok_or(Failure::Service)?;
        open(url)?;
        rpc.wait_login(login_id, cancel, LOGIN_TIMEOUT)?;
        let response = rpc.request(
            3,
            "account/read",
            json!({"refreshToken":false}),
            RPC_TIMEOUT,
            cancel,
        )?;
        if response.pointer("/account/type").and_then(Value::as_str) != Some("chatgpt") {
            return Err(Failure::Reauth);
        }
        drop(rpc);
        let candidate = Credentials::read(&pending)?.ok_or(Failure::Credentials)?;
        ensure_identity(name, previous.as_ref(), &candidate)?;
        if candidate.expires_at <= now() {
            return Err(Failure::Credentials);
        }
        Ok(candidate)
    })();
    match result {
        Ok(candidate) => {
            promote(&home, &candidate)?;
            let mut p = policy(&home)?;
            p.authority = AuthAuthority::NoTrace;
            save_policy(&home, &p)?;
            successful_policy(&home, true)?;
            // A successful new authorization supersedes a recoverable interrupted refresh.
            let stale = home.join(".pending-refresh");
            if stale.exists() {
                cleanup_pending(&stale)?;
            }
            cleanup_pending(&pending)?;
            status_at(&home, name)
        }
        Err(error) => {
            cleanup_pending(&pending)?;
            Err(error.into())
        }
    }
}

pub fn refresh_all_account_auth(config: &CloakConfig, accounts: &[String]) -> AuthRefreshSummary {
    let mut summary = AuthRefreshSummary {
        next_check_in_seconds: CHECK_INTERVAL,
        ..Default::default()
    };
    let mut seen = HashSet::new();
    for name in accounts {
        if !seen.insert(name) {
            continue;
        }
        let snapshot = auth_status(config, name);
        let Ok(status) = snapshot else {
            summary.failed += 1;
            continue;
        };
        if status.authority != AuthAuthority::NoTrace
            || !status.auto_refresh
            || matches!(status.state, AuthState::Missing | AuthState::ReauthRequired)
        {
            summary.skipped += 1;
            continue;
        }
        let Some(expiry) = status.expires_at else {
            summary.skipped += 1;
            continue;
        };
        let due = due_at(expiry).max(status.next_retry_at.unwrap_or(0));
        if due > now() {
            summary.next_check_in_seconds = summary
                .next_check_in_seconds
                .min(due.saturating_sub(now()).max(30));
            summary.skipped += 1;
            continue;
        }
        summary.attempted += 1;
        match refresh_account_auth(config, name) {
            Ok(status) if matches!(status.state, AuthState::Connected | AuthState::Expiring) => {
                summary.refreshed += 1
            }
            Ok(status) => {
                summary.failed += 1;
                if let Some(retry) = status.next_retry_at {
                    summary.next_check_in_seconds = summary
                        .next_check_in_seconds
                        .min(retry.saturating_sub(now()).max(30));
                }
            }
            Err(_) => {
                summary.failed += 1;
                summary.next_check_in_seconds = summary.next_check_in_seconds.min(15 * 60);
            }
        }
    }
    summary
}

fn proxy(config: &CloakConfig, name: &str) -> AuthResult<Option<String>> {
    crate::read_first_line(&config.profile_dir(name).join(".cloak-proxy"))
        .map_err(|_| Failure::Service)
}
fn resolve_codex_binary() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("CLOAK_CODEX_BINARY") {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err(CloakError::Auth(
            "配置的官方 Codex CLI 路径无效".to_string(),
        ));
    }
    [
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
    .ok_or_else(|| CloakError::Auth("未找到官方 Codex CLI，请先安装 Codex".to_string()))
}
fn classify_error(value: &Value) -> Failure {
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if [
        "refresh_token_invalidated",
        "refresh_token_reused",
        "refresh_token_expired",
        "refresh_token_revoked",
        "invalid_grant",
        "sign in again",
    ]
    .iter()
    .any(|v| message.contains(v))
    {
        Failure::Reauth
    } else {
        Failure::Service
    }
}
fn validate_auth_url(raw: &str) -> AuthResult<()> {
    let url = Url::parse(raw).map_err(|_| Failure::Service)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port(), None | Some(443))
        || !matches!(url.host_str(), Some("auth.openai.com" | "chatgpt.com"))
    {
        return Err(Failure::Service);
    }
    Ok(())
}

struct RpcSession {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    messages: Receiver<Value>,
    pending: VecDeque<Value>,
}
impl Drop for RpcSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl RpcSession {
    fn start(
        binary: &Path,
        home: &Path,
        proxy: Option<String>,
        cancel: &AtomicBool,
    ) -> AuthResult<Self> {
        let mut command = Command::new(binary);
        command
            .args([
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "cli_auth_credentials_store=\"file\"",
                "-c",
                "model_provider=\"openai\"",
                "-c",
                "analytics.enabled=false",
            ])
            .env("CODEX_HOME", home)
            .current_dir(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (key, _) in std::env::vars_os() {
            let label = key.to_string_lossy();
            if (label.starts_with("OPENAI_") || label.starts_with("CODEX_"))
                && label != "CODEX_HOME"
                && label != "CODEX_CA_CERTIFICATE"
            {
                command.env_remove(key);
            }
        }
        if let Some(proxy) = proxy {
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                command.env(key, &proxy);
            }
        }
        command
            .env("NO_PROXY", "localhost,127.0.0.1,::1")
            .env("no_proxy", "localhost,127.0.0.1,::1");
        let mut child = command.spawn().map_err(|_| Failure::Service)?;
        let stdin = child.stdin.take().ok_or(Failure::Service)?;
        let stdout = child.stdout.take().ok_or(Failure::Service)?;
        let (sender, messages) = mpsc::sync_channel(32);
        let mut rpc = Self {
            child,
            stdin: BufWriter::new(stdin),
            messages,
            pending: VecDeque::new(),
        };
        std::thread::Builder::new()
            .name("notrace-auth-reader".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let mut line = Vec::new();
                    let count = (&mut reader)
                        .take(256 * 1024 + 1)
                        .read_until(b'\n', &mut line);
                    if count.is_err() || line.is_empty() || line.len() > 256 * 1024 {
                        break;
                    }
                    if let Ok(value) = serde_json::from_slice(&line) {
                        if sender.send(value).is_err() {
                            break;
                        }
                    }
                }
            })
            .map_err(|_| Failure::Service)?;
        rpc.request(1, "initialize", json!({"clientInfo":{"name":"notrace_browser","title":"NoTrace Browser","version":env!("CARGO_PKG_VERSION")}}), RPC_TIMEOUT, cancel)?;
        rpc.send(json!({"method":"initialized"}))?;
        Ok(rpc)
    }
    fn send(&mut self, value: Value) -> AuthResult<()> {
        serde_json::to_writer(&mut self.stdin, &value).map_err(|_| Failure::Service)?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| Failure::Service)
    }
    fn receive(&self, deadline: Instant, cancel: &AtomicBool) -> AuthResult<Value> {
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(Failure::Cancelled);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Failure::Timeout);
            }
            match self
                .messages
                .recv_timeout(remaining.min(Duration::from_millis(200)))
            {
                Ok(value) => return Ok(value),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Err(Failure::Service),
            }
        }
    }
    fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &AtomicBool,
    ) -> AuthResult<Value> {
        self.send(json!({"id":id,"method":method,"params":params}))?;
        let deadline = Instant::now() + timeout;
        loop {
            let value = self.receive(deadline, cancel)?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(classify_error(error));
                }
                return value.get("result").cloned().ok_or(Failure::Service);
            }
            if value.get("method").and_then(Value::as_str) == Some("account/login/completed") {
                if self.pending.len() >= 16 {
                    return Err(Failure::Service);
                }
                self.pending.push_back(value);
            }
        }
    }
    fn wait_login(&mut self, id: &str, cancel: &AtomicBool, timeout: Duration) -> AuthResult<()> {
        let deadline = Instant::now() + timeout;
        loop {
            let event = match self.pending.pop_front() {
                Some(event) => event,
                None => self.receive(deadline, cancel)?,
            };
            if event.get("method").and_then(Value::as_str) != Some("account/login/completed") {
                continue;
            }
            let params = &event["params"];
            if params.get("loginId").and_then(Value::as_str) != Some(id) {
                continue;
            }
            return if params.get("success").and_then(Value::as_bool) == Some(true) {
                Ok(())
            } else {
                Err(classify_error(&json!({"message":params["error"]})))
            };
        }
    }
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
