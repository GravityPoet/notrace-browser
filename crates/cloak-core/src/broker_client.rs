//! Desktop-facing Broker operations. Service keys and credential bodies never
//! cross the frontend IPC boundary; all returns are metadata only.
use crate::{
    format_access_credentials, AccessCredential, AuthStatus, BrokerJsonFormat,
    BrokerJsonImportPreview, BrokerMetadata, CloakConfig, CloakError, CodexQuotaSnapshot, Result,
};
use rand::RngCore;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::{
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
struct Connection {
    endpoint: String,
    admin_key: String,
}
#[derive(Serialize)]
pub struct BrokerAccountRow {
    pub name: String,
    pub profile_id: String,
    pub trashed: bool,
    pub local: AuthStatus,
    pub remote: Option<BrokerMetadata>,
}
#[derive(Serialize)]
pub struct BrokerOverview {
    pub configured: bool,
    pub endpoint: Option<String>,
    pub connected: bool,
    pub message: Option<String>,
    pub accounts: Vec<BrokerAccountRow>,
    pub unmatched: Vec<BrokerMetadata>,
}
#[derive(Serialize)]
pub struct BrokerJsonTransferSummary {
    pub path: String,
    pub format: String,
    pub account_count: usize,
    pub refresh_token_exported: bool,
}
#[derive(Serialize)]
pub struct BrokerJsonImportSummary {
    pub email: String,
    pub account_id: String,
    pub profile_id: String,
    pub generation: u64,
}

#[derive(Serialize)]
pub struct BrokerCockpitImportSummary {
    pub email: String,
    pub account_id: String,
    pub generation: u64,
    pub expires_at: u64,
    pub handed_off: bool,
    pub background_requested: bool,
}
fn connection_path(config: &CloakConfig) -> PathBuf {
    config
        .account_base
        .parent()
        .unwrap_or(&config.account_base)
        .join(".notrace-broker-client.json")
}
fn load(config: &CloakConfig) -> Result<Option<Connection>> {
    let path = connection_path(config);
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(CloakError::Auth("Broker 配置路径无效".into()));
    }
    if !path.exists() {
        return Ok(None);
    }
    let mut raw = Zeroizing::new(String::new());
    fs::File::open(path)?
        .take(16 * 1024)
        .read_to_string(&mut raw)?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|_| CloakError::Auth("Broker 配置无效".into()))
}
pub fn save_broker_connection(
    config: &CloakConfig,
    endpoint: &str,
    key: &str,
) -> Result<BrokerOverview> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    validate_endpoint(endpoint)?;
    if key.len() < 32 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(CloakError::Auth("管理密钥格式无效".into()));
    }
    // Do not replace a working configuration with one that cannot authenticate.
    let connection = Connection {
        endpoint: endpoint.into(),
        admin_key: key.into(),
    };
    let _: Vec<BrokerMetadata> = request(&connection, "GET", "/v1/admin/accounts", None)?;
    let body = Zeroizing::new(serde_json::to_string(&connection)?);
    crate::write_secret_atomic(&connection_path(config), &body)?;
    broker_overview(config)
}
pub fn broker_overview(config: &CloakConfig) -> Result<BrokerOverview> {
    let connection = load(config)?;
    let mut accounts = crate::list_accounts(config)?;
    accounts.extend(crate::list_trashed_accounts(config)?);
    let (connected, message, mut remote) = match connection.as_ref() {
        None => (false, Some("尚未连接统一续期服务".into()), Vec::new()),
        Some(c) => match request::<Vec<BrokerMetadata>>(c, "GET", "/v1/admin/accounts", None) {
            Ok(v) => (true, None, v),
            Err(_) => (
                false,
                Some("无法连接续期服务；本机授权状态仍可查看".into()),
                Vec::new(),
            ),
        },
    };
    let mut rows = Vec::new();
    for account in accounts {
        let local = crate::auth_status(config, &account.name)?;
        let remote_account = remote
            .iter()
            .position(|m| m.key == account.profile_id)
            .map(|i| remote.remove(i));
        rows.push(BrokerAccountRow {
            name: account.name,
            profile_id: account.profile_id,
            trashed: account.trashed,
            local,
            remote: remote_account,
        });
    }
    Ok(BrokerOverview {
        configured: connection.is_some(),
        endpoint: connection.map(|v| v.endpoint),
        connected,
        message,
        accounts: rows,
        unmatched: remote,
    })
}
pub fn broker_push_account(config: &CloakConfig, name: &str) -> Result<BrokerMetadata> {
    let connection = load(config)?.ok_or_else(|| CloakError::Auth("请先连接 Broker".into()))?;
    crate::push_local_grant(config, name, &connection.endpoint, &connection.admin_key)
}
pub fn broker_refresh_account(config: &CloakConfig, profile_id: &str) -> Result<BrokerMetadata> {
    let connection = load(config)?.ok_or_else(|| CloakError::Auth("请先连接 Broker".into()))?;
    request(
        &connection,
        "POST",
        &format!(
            "/v1/admin/accounts/{}/refresh?force=1",
            segment(profile_id)?
        ),
        Some(json!({})),
    )
}

/// Hand the current Broker access-only projection to the official Cockpit Tools
/// app. This action deliberately does not refresh or rotate the Broker grant:
/// the official Cockpit import flow refreshes its quota view after saving the
/// access-only account, while Broker remains the sole refresh-token owner.
pub fn broker_import_cockpit_access(
    config: &CloakConfig,
    profile_id: &str,
    background_window: impl FnOnce() -> bool,
) -> Result<BrokerCockpitImportSummary> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (config, profile_id, background_window);
        Err(CloakError::Auth("一键导入 Cockpit 目前仅支持 macOS".into()))
    }
    #[cfg(target_os = "macos")]
    {
        let app = Path::new("/Applications/Cockpit Tools.app");
        if !app.join("Contents/MacOS/cockpit-tools").is_file() {
            return Err(CloakError::Auth("请先安装官方 Cockpit Tools".into()));
        }
        let did_open = std::cell::Cell::new(false);
        let result =
            import_cockpit_access(config, profile_id, Duration::from_secs(45), |deep_link| {
                let opened = Command::new("/usr/bin/open")
                    .arg("-g")
                    .arg("-j")
                    .arg("-a")
                    .arg(app)
                    .arg(deep_link)
                    .output()
                    .map_err(|_| CloakError::Auth("无法唤起官方 Cockpit Tools".into()))?;
                if !opened.status.success() {
                    return Err(CloakError::Auth("官方 Cockpit Tools 未接受导入请求".into()));
                }
                did_open.set(true);
                Ok(())
            });
        // No focus watcher: restore once, and only if Cockpit is still active.
        // A user who has switched to another app must not be interrupted.
        let background_requested = !did_open.get() || background_window();
        let mut result = result?;
        result.background_requested = background_requested;
        Ok(result)
    }
}

fn import_cockpit_access(
    config: &CloakConfig,
    profile_id: &str,
    timeout: Duration,
    open: impl FnOnce(&str) -> Result<()>,
) -> Result<BrokerCockpitImportSummary> {
    let connection = load(config)?.ok_or_else(|| CloakError::Auth("请先连接 Broker".into()))?;
    let key = segment(profile_id)?;
    let accounts: Vec<BrokerMetadata> = request(&connection, "GET", "/v1/admin/accounts", None)?;
    let metadata = accounts
        .into_iter()
        .find(|value| value.key == profile_id)
        .ok_or_else(|| CloakError::Auth("Broker 中找不到此账号".into()))?;
    if matches!(
        metadata.error,
        Some(crate::BrokerError::ReauthRequired | crate::BrokerError::RecoveryRequired)
    ) {
        return Err(CloakError::Auth("授权已失效，需要重新授权".into()));
    }
    let credential: AccessCredential = request(
        &connection,
        "GET",
        &format!("/v1/admin/accounts/{key}/credential"),
        None,
    )?;
    if !credential.refresh_token.is_empty() {
        return Err(CloakError::Auth(
            "Cockpit 导入边界异常：拒绝发送 refresh_token".into(),
        ));
    }
    if credential.notrace_key != profile_id
        || credential.notrace_generation != metadata.generation
        || credential.account_id != metadata.account_id
        || !credential.email.eq_ignore_ascii_case(&metadata.email)
        || credential.expires_at != metadata.expires_at
        || credential.expires_at <= crate::current_epoch_secs()
        || credential.access_token.is_empty()
        || credential.id_token.is_empty()
        || credential.refresh_owner != "notrace_broker"
    {
        return Err(CloakError::Auth(
            "当前授权代次与账号不一致，未交给 Cockpit".into(),
        ));
    }
    let payload = Zeroizing::new(format_access_credentials(
        std::slice::from_ref(&credential),
        BrokerJsonFormat::CockpitTools,
        false,
    )?);
    let handed_off = serve_cockpit_import(payload, timeout, open)?;
    if !handed_off {
        return Err(CloakError::Auth(
            "Cockpit 未在有效期内读取导入包，未确认导入".into(),
        ));
    }
    Ok(BrokerCockpitImportSummary {
        email: metadata.email,
        account_id: metadata.account_id,
        generation: metadata.generation,
        expires_at: metadata.expires_at,
        handed_off,
        background_requested: false,
    })
}

fn serve_cockpit_import(
    payload: Zeroizing<Vec<u8>>,
    timeout: Duration,
    open: impl FnOnce(&str) -> Result<()>,
) -> Result<bool> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| CloakError::Auth("无法启动 Cockpit 本地导入服务".into()))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| CloakError::Auth("无法配置 Cockpit 本地导入服务".into()))?;
    let port = listener
        .local_addr()
        .map_err(|_| CloakError::Auth("无法读取 Cockpit 本地导入端口".into()))?
        .port();
    let mut random = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let token = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = format!("/notrace-cockpit-import/{token}");
    let import_url = format!("http://127.0.0.1:{port}{path}");
    let deep_link = cockpit_deep_link(&import_url);
    open(&deep_link)?;
    let deadline = std::time::Instant::now() + timeout;
    let host = format!("127.0.0.1:{port}");
    while std::time::Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if import_request_matches(&mut stream, &path, &host, deadline) {
                    write_import_response(&mut stream, &payload)?;
                    return Ok(true);
                }
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err(CloakError::Auth("Cockpit 导入连接失败".into())),
        }
    }
    Ok(false)
}

fn cockpit_deep_link(import_url: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("provider", "codex")
        .append_pair("import_url", import_url)
        .append_pair("auto_import", "true")
        .finish();
    format!("cockpit-tools://import?{query}")
}

fn import_request_matches(
    stream: &mut TcpStream,
    expected_path: &str,
    expected_host: &str,
    deadline: std::time::Instant,
) -> bool {
    let deadline = deadline.min(std::time::Instant::now() + Duration::from_secs(2));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let mut request = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() || stream.set_read_timeout(Some(remaining)).is_err() {
            return false;
        }
        let Ok(size) = stream.read(&mut chunk) else {
            return false;
        };
        if size == 0 || request.len() + size > 8192 {
            return false;
        }
        request.extend_from_slice(&chunk[..size]);
        if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            break;
        }
    }
    let Ok(header) = std::str::from_utf8(&request) else {
        return false;
    };
    let mut lines = header.lines();
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split_ascii_whitespace();
    if parts.next() != Some("GET")
        || parts.next() != Some(expected_path)
        || !matches!(parts.next(), Some("HTTP/1.1" | "HTTP/1.0"))
        || parts.next().is_some()
    {
        return false;
    }
    let mut host = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        if name.eq_ignore_ascii_case("origin") || name.eq_ignore_ascii_case("transfer-encoding") {
            return false;
        }
        if name.eq_ignore_ascii_case("content-length") && value.trim() != "0" {
            return false;
        }
        if name.eq_ignore_ascii_case("host") && host.replace(value.trim()).is_some() {
            return false;
        }
    }
    host == Some(expected_host) && std::time::Instant::now() < deadline
}

fn write_import_response(stream: &mut TcpStream, payload: &[u8]) -> Result<()> {
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(payload))
        .map_err(|_| CloakError::Auth("Cockpit 导入响应失败".into()))
}

/// Read-only usage/quota query. The Broker uses the current access token and
/// never refreshes or synchronizes CPA as part of this request.
pub fn broker_quota_snapshot(config: &CloakConfig, profile_id: &str) -> Result<CodexQuotaSnapshot> {
    let connection = load(config)?.ok_or_else(|| CloakError::Auth("请先连接 Broker".into()))?;
    request(
        &connection,
        "GET",
        &format!("/v1/admin/accounts/{}/quota", segment(profile_id)?),
        None,
    )
}
pub fn broker_set_cpa(
    config: &CloakConfig,
    profile_id: &str,
    enabled: bool,
) -> Result<BrokerMetadata> {
    let connection = load(config)?.ok_or_else(|| CloakError::Auth("请先连接 Broker".into()))?;
    request(
        &connection,
        "POST",
        &format!("/v1/admin/accounts/{}/cpa", segment(profile_id)?),
        Some(json!({"enabled":enabled})),
    )
}
pub fn broker_export_json(
    config: &CloakConfig,
    profile_id: &str,
    format: &str,
    path: &Path,
    include_refresh_token: bool,
) -> Result<BrokerJsonTransferSummary> {
    let connection = load(config)?.ok_or_else(|| CloakError::Auth("请先连接 Broker".into()))?;
    let format = BrokerJsonFormat::parse(format)?;
    let credential: AccessCredential = request(
        &connection,
        "GET",
        &format!(
            "/v1/admin/accounts/{}/credential{}",
            segment(profile_id)?,
            if include_refresh_token {
                "?include_refresh_token=1"
            } else {
                ""
            }
        ),
        None,
    )?;
    let refresh_token_exported = include_refresh_token && !credential.refresh_token.is_empty();
    let bytes = format_access_credentials(&[credential], format, include_refresh_token)?;
    write_user_export_atomic(path, &bytes)?;
    Ok(BrokerJsonTransferSummary {
        path: path.to_string_lossy().into_owned(),
        format: format.label().into(),
        account_count: 1,
        refresh_token_exported,
    })
}
pub fn broker_preview_json(path: &Path) -> Result<BrokerJsonImportPreview> {
    crate::broker_preview_json_file(path)
}
pub fn broker_convert_json(
    path: &Path,
    format: &str,
    output_path: &Path,
    include_refresh_token: bool,
) -> Result<BrokerJsonTransferSummary> {
    let format = BrokerJsonFormat::parse(format)?;
    let preview = crate::broker_preview_json_file(path)?;
    let bytes = crate::convert_broker_json_file(path, format, include_refresh_token)?;
    write_user_export_atomic(output_path, &bytes)?;
    Ok(BrokerJsonTransferSummary {
        path: output_path.to_string_lossy().into_owned(),
        format: format.label().into(),
        account_count: preview.account_count,
        refresh_token_exported: include_refresh_token && preview.contains_refresh_token,
    })
}

/// Import one complete credential from a local JSON file and make Broker the
/// sole refresh owner for the matching NoTrace account.
pub fn broker_import_json(
    config: &CloakConfig,
    path: &Path,
    email: &str,
    account_id: &str,
) -> Result<BrokerJsonImportSummary> {
    let records = crate::broker_transfer::import_records(path)?;
    let requested_email = email.trim();
    let matches = records
        .iter()
        .filter(|record| {
            (!requested_email.is_empty() && record.email.eq_ignore_ascii_case(requested_email))
                && record.account_id == account_id
        })
        .collect::<Vec<_>>();
    let record = match matches.as_slice() {
        [record] => *record,
        [] => {
            return Err(CloakError::Auth(
                "导入文件与预览账号不一致，请重新选择 JSON".into(),
            ))
        }
        _ => {
            return Err(CloakError::Auth(
                "JSON 中该账号有多份凭据，请只保留要导入的一份".into(),
            ))
        }
    };
    let body = crate::broker_transfer::broker_grant_body(record)?;
    let identity = crate::broker::validate_import_grant("file-import", &body)
        .map_err(|error| CloakError::Auth(error.to_string()))?;
    if !identity.email.eq_ignore_ascii_case(&record.email)
        || identity.account_id != record.account_id
    {
        return Err(CloakError::Auth(
            "JSON 账号信息与凭据身份不匹配，未导入".into(),
        ));
    }
    let connection = load(config)?.ok_or_else(|| CloakError::Auth("请先连接 Broker".into()))?;
    let remote: Vec<BrokerMetadata> = request(&connection, "GET", "/v1/admin/accounts", None)?;
    let mut accounts = crate::list_accounts(config)?;
    accounts.extend(crate::list_trashed_accounts(config)?);
    let mut candidates = Vec::new();
    for account in &accounts {
        let local = crate::auth_status(config, &account.name)?;
        let grant = remote.iter().find(|value| value.key == account.profile_id);
        if account.name.eq_ignore_ascii_case(&identity.email)
            || local
                .email
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case(&identity.email))
            || grant.is_some_and(|value| {
                value.account_id == identity.account_id
                    && value.email.eq_ignore_ascii_case(&identity.email)
            })
        {
            candidates.push(account);
        }
    }
    let account = match candidates.as_slice() {
        [account] => *account,
        [] => {
            return Err(CloakError::Auth(format!(
                "NoTrace 中找不到 {}，请先创建同名账号环境",
                identity.email
            )))
        }
        _ => {
            return Err(CloakError::Auth(
                "多个 NoTrace 环境使用此邮箱，请先整理账号绑定后再导入".into(),
            ))
        }
    };
    if remote.iter().any(|value| {
        value.key == account.profile_id
            && (value.account_id != identity.account_id
                || !value.email.eq_ignore_ascii_case(&identity.email))
    }) {
        return Err(CloakError::Auth(
            "此环境已绑定另一个授权账号，未覆盖".into(),
        ));
    }
    let target = format!("/v1/admin/accounts/{}/grant", segment(&account.profile_id)?);
    let metadata: BrokerMetadata =
        crate::auth::with_imported_broker_handoff(config, &account.name, || {
            let metadata: BrokerMetadata = request(
                &connection,
                "POST",
                &target,
                Some(
                    serde_json::from_str(&body)
                        .map_err(|_| CloakError::Auth("授权 JSON 无效".into()))?,
                ),
            )?;
            if metadata.key != account.profile_id
                || metadata.account_id != identity.account_id
                || !metadata.email.eq_ignore_ascii_case(&identity.email)
            {
                return Err(CloakError::Auth(
                    "Broker 未确认对应账号的授权，刷新保持暂停，请重新读取状态".into(),
                ));
            }
            if let Some(error) = metadata.error.filter(|error| {
                matches!(
                    error,
                    crate::BrokerError::ReauthRequired | crate::BrokerError::RecoveryRequired
                )
            }) {
                return Err(CloakError::Auth(error.to_string()));
            }
            Ok(metadata)
        })?;
    Ok(BrokerJsonImportSummary {
        email: metadata.email,
        account_id: metadata.account_id,
        profile_id: account.profile_id.clone(),
        generation: metadata.generation,
    })
}
fn segment(value: &str) -> Result<String> {
    if !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(value.into())
    } else {
        Err(CloakError::Auth("授权链编号无效".into()))
    }
}
fn validate_endpoint(endpoint: &str) -> Result<()> {
    let url = url::Url::parse(endpoint).map_err(|_| CloakError::Auth("续期服务地址无效".into()))?;
    let local = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !(url.scheme() == "https" || local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path().is_empty() || url.path() == "/")
    {
        return Err(CloakError::Auth(
            "请使用 HTTPS 地址或本机 SSH 隧道地址".into(),
        ));
    }
    Ok(())
}

fn write_user_export_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| CloakError::Auth("导出路径无效".into()))?;
    if fs::symlink_metadata(parent)
        .map_err(|_| CloakError::Auth("导出目录不可用".into()))?
        .file_type()
        .is_symlink()
    {
        return Err(CloakError::Auth("导出目录不能是符号链接".into()));
    }
    if fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(CloakError::Auth("导出文件不能是符号链接".into()));
    }
    let tmp = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        rand::random::<u128>()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        std::io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(&tmp, path)?;
        Ok::<(), std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|_| CloakError::Auth("导出 JSON 保存失败".into()))
}
fn request<T: serde::de::DeserializeOwned>(
    c: &Connection,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<T> {
    validate_endpoint(&c.endpoint)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(40))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| CloakError::Auth("Broker 客户端不可用".into()))?;
    let url = format!("{}{}", c.endpoint.trim_end_matches('/'), path);
    let mut request = if method == "POST" {
        client.post(url)
    } else {
        client.get(url)
    };
    request = request.bearer_auth(&c.admin_key);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .map_err(|_| CloakError::Auth("无法连接 Broker".into()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut upstream = String::new();
        let _ = response.take(16 * 1024).read_to_string(&mut upstream);
        let code = serde_json::from_str::<Value>(&upstream)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        return Err(CloakError::Auth(
            match (status, code.as_deref()) {
                (400, Some("identity_mismatch")) => "授权账号身份不匹配，未导入",
                (400, Some("invalid_grant")) => "授权文件无效或访问凭据已过期，请重新授权",
                (401, _) | (403, _) => "Broker 管理密钥无效",
                (409, Some("reauth_required")) => "授权已失效，需要重新授权",
                (409, Some("recovery_required")) => "授权链状态不确定，需要重新授权",
                (409, Some("service_unavailable")) => "授权服务暂不可用，稍后重试",
                (409, Some("consumer_conflict")) => "CPA 存在未托管凭据，未覆盖",
                (503, Some("quota_unavailable")) => "上游额度暂时无法读取，请稍后重试",
                (409, _) => "授权或同步状态需要检查，请查看账号详情",
                (423, _) => "账号正在授权或刷新",
                _ => "Broker 操作未完成",
            }
            .into(),
        ));
    }
    let mut body = Zeroizing::new(String::new());
    response
        .take(2 * 1024 * 1024)
        .read_to_string(&mut body)
        .map_err(|_| CloakError::Auth("读取 Broker 状态失败".into()))?;
    serde_json::from_str(&body).map_err(|_| CloakError::Auth("Broker 状态数据无效".into()))
}

#[cfg(test)]
#[path = "broker_client_tests.rs"]
mod tests;
