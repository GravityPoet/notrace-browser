//! Desktop-facing Broker operations. Service keys and credential bodies never
//! cross the frontend IPC boundary; all returns are metadata only.
use crate::{AuthStatus, BrokerMetadata, CloakConfig, CloakError, Result};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Read, path::PathBuf, time::Duration};
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
        return Err(CloakError::Auth(
            match response.status().as_u16() {
                401 | 403 => "Broker 管理密钥无效",
                409 => "授权或同步状态需要检查，请查看账号详情",
                423 => "账号正在授权或刷新",
                _ => "Broker 操作未完成",
            }
            .into(),
        ));
    }
    let mut body = String::new();
    response
        .take(2 * 1024 * 1024)
        .read_to_string(&mut body)
        .map_err(|_| CloakError::Auth("读取 Broker 状态失败".into()))?;
    serde_json::from_str(&body).map_err(|_| CloakError::Auth("Broker 状态数据无效".into()))
}
