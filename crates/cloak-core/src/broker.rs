//! One headless refresh authority per OAuth grant. All secrets are encrypted;
//! metadata and access-only projections are the only outputs.
use aes_gcm::{
    aead::{array::Array, Aead, KeyInit, Payload},
    Aes256Gcm,
};
use base64::{
    engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD},
    Engine,
};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use rand::RngCore;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use thiserror::Error;
use zeroize::Zeroizing;

const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const MAX_BYTES: u64 = 256 * 1024;
const MAX_LEAD: u64 = 36 * 3600;
type BrokerResult<T> = std::result::Result<T, BrokerError>;
const PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS.add(b' ').add(b'/').add(b'?').add(b'#');

#[derive(Debug, Error, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrokerError {
    #[error("Broker 配置无效")]
    Config,
    #[error("Broker 账号不存在")]
    AccountMissing,
    #[error("Broker 授权数据无效")]
    InvalidGrant,
    #[error("授权账号身份不匹配")]
    IdentityMismatch,
    #[error("授权已失效，需要重新授权")]
    ReauthRequired,
    #[error("授权服务暂不可用，稍后重试")]
    ServiceUnavailable,
    #[error("未获得新的凭据")]
    Unchanged,
    #[error("账号正在授权或刷新")]
    Busy,
    #[error("Broker 存储错误")]
    Storage,
    #[error("授权数据过大")]
    InputTooLarge,
    #[error("上次刷新结果不确定，需要重新授权；不会重复使用旧刷新凭据")]
    RecoveryRequired,
    #[error("CPA 存在未托管的同名凭据，未覆盖")]
    ConsumerConflict,
}

#[derive(Clone)]
pub struct BrokerConfig {
    pub root: PathBuf,
    pub cpa_auth_dir: Option<PathBuf>,
    pub proxy_url: Option<String>,
    token_url: String,
}
impl BrokerConfig {
    pub fn from_env() -> BrokerResult<Self> {
        let root = std::env::var_os("NOTRACE_BROKER_ROOT")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|p| p.join(".local/state/notrace-broker")))
            .ok_or(BrokerError::Config)?;
        Ok(Self {
            root,
            cpa_auth_dir: std::env::var_os("NOTRACE_BROKER_CPA_AUTH_DIR").map(PathBuf::from),
            proxy_url: std::env::var("NOTRACE_BROKER_PROXY_URL")
                .ok()
                .filter(|s| !s.is_empty()),
            // Production token requests always go to OpenAI. Tests use private constructors.
            token_url: TOKEN_URL.into(),
        })
    }
}

#[derive(Clone)]
pub struct BrokerStore {
    config: BrokerConfig,
    key: Zeroizing<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrokerMetadata {
    pub key: String,
    pub email: String,
    pub account_id: String,
    pub plan_type: Option<String>,
    pub expires_at: u64,
    pub last_refresh_at: u64,
    pub generation: u64,
    pub next_refresh_at: u64,
    pub next_retry_at: Option<u64>,
    pub error: Option<BrokerError>,
    pub cpa_enabled: bool,
    pub cpa_synced_generation: Option<u64>,
    pub cpa_sync_error: Option<BrokerError>,
    pub cockpit_synced_generation: Option<u64>,
}

/// Credentials have no Debug implementation. Consumers never receive RT.
#[derive(Clone, Serialize, Deserialize)]
pub struct AccessCredential {
    #[serde(rename = "type")]
    pub auth_type: String,
    pub access_token: String,
    pub id_token: String,
    pub account_id: String,
    pub email: String,
    pub expired: String,
    pub expires_at: u64,
    pub last_refresh: String,
    pub plan_type: Option<String>,
    pub refresh_token: String,
    pub refresh_owner: String,
    pub notrace_key: String,
    pub notrace_generation: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Grant {
    key: String,
    email: String,
    account_id: String,
    plan_type: Option<String>,
    access_token: String,
    id_token: String,
    refresh_token: String,
    expires_at: u64,
    issued_at: u64,
    last_refresh_at: u64,
    generation: u64,
    handoff_id: String,
    #[serde(default)]
    in_flight: bool,
    #[serde(default)]
    error: Option<BrokerError>,
    #[serde(default)]
    failures: u32,
    #[serde(default)]
    next_retry_at: Option<u64>,
    #[serde(default)]
    cpa_enabled: bool,
    #[serde(default)]
    cpa_synced_generation: Option<u64>,
    #[serde(default)]
    cpa_sync_error: Option<BrokerError>,
    #[serde(default)]
    cockpit_synced_generation: Option<u64>,
}
impl Grant {
    fn due_at(&self) -> u64 {
        let lifetime = self.expires_at.saturating_sub(self.issued_at).max(60);
        self.expires_at
            .saturating_sub((lifetime / 5).clamp(10, MAX_LEAD))
    }
    fn metadata(&self) -> BrokerMetadata {
        BrokerMetadata {
            key: self.key.clone(),
            email: self.email.clone(),
            account_id: self.account_id.clone(),
            plan_type: self.plan_type.clone(),
            expires_at: self.expires_at,
            last_refresh_at: self.last_refresh_at,
            generation: self.generation,
            next_refresh_at: self.due_at(),
            next_retry_at: self.next_retry_at,
            error: if self.in_flight {
                Some(BrokerError::RecoveryRequired)
            } else {
                self.error
            },
            cpa_enabled: self.cpa_enabled,
            cpa_synced_generation: self.cpa_synced_generation,
            cpa_sync_error: self.cpa_sync_error,
            cockpit_synced_generation: self.cockpit_synced_generation,
        }
    }
    fn projection(&self) -> AccessCredential {
        AccessCredential {
            auth_type: "codex".into(),
            access_token: self.access_token.clone(),
            id_token: self.id_token.clone(),
            account_id: self.account_id.clone(),
            email: self.email.clone(),
            expired: iso_time(self.expires_at),
            expires_at: self.expires_at,
            last_refresh: iso_time(self.last_refresh_at),
            plan_type: self.plan_type.clone(),
            refresh_token: String::new(),
            refresh_owner: "notrace_broker".into(),
            notrace_key: self.key.clone(),
            notrace_generation: self.generation,
        }
    }
}
#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u32,
    nonce: String,
    ciphertext: String,
}

impl BrokerStore {
    pub fn from_env() -> BrokerResult<Self> {
        let config = BrokerConfig::from_env()?;
        let raw =
            Zeroizing::new(std::env::var("NOTRACE_BROKER_KEY").map_err(|_| BrokerError::Config)?);
        Self::new(config, parse_key(&raw)?)
    }
    pub fn new(config: BrokerConfig, key: [u8; 32]) -> BrokerResult<Self> {
        ensure_dir(&config.root)?;
        ensure_dir(&config.root.join("accounts"))?;
        Ok(Self {
            config,
            key: Zeroizing::new(key),
        })
    }
    pub fn list(&self) -> BrokerResult<Vec<BrokerMetadata>> {
        let mut result = Vec::new();
        for entry in
            fs::read_dir(self.config.root.join("accounts")).map_err(|_| BrokerError::Storage)?
        {
            let path = entry.map_err(|_| BrokerError::Storage)?.path();
            if path.extension().and_then(|v| v.to_str()) == Some("grant") {
                result.push(self.load(&path)?.metadata());
            }
        }
        result.sort_by(|a, b| a.email.cmp(&b.email));
        Ok(result)
    }
    pub fn import_grant(&self, key: &str, body: &str) -> BrokerResult<BrokerMetadata> {
        let path = self.path(key)?;
        let _guard = acquire_lock(&path.with_extension("lock"))?;
        let mut incoming = parse_grant(key, body)?;
        if path.exists() {
            let current = self.load(&path)?;
            identity_matches(&current, &incoming)?;
            // The same handoff may be retried after a lost HTTP reply. Never
            // overwrite its already rotated canonical grant with the old RT.
            if current.handoff_id == incoming.handoff_id {
                return Ok(current.metadata());
            }
            // A new grant needs a new interactive authorization. Importing a
            // previously copied snapshot must not reset an existing lineage.
            if incoming.refresh_token == current.refresh_token {
                return Err(BrokerError::InvalidGrant);
            }
            incoming.generation = current.generation + 1;
            incoming.cpa_enabled = current.cpa_enabled;
            incoming.cpa_synced_generation = current.cpa_synced_generation;
            incoming.cockpit_synced_generation = current.cockpit_synced_generation;
        }
        self.save(&path, &incoming)?;
        // A new authorization explicitly supersedes a stranded response journal.
        let pending = path.with_extension("pending");
        if pending.exists() {
            reject_link(&pending)?;
            fs::remove_file(pending).map_err(|_| BrokerError::Storage)?;
        }
        Ok(incoming.metadata())
    }
    pub fn refresh(&self, key: &str, force: bool) -> BrokerResult<BrokerMetadata> {
        let path = self.path(key)?;
        let _guard = acquire_lock(&path.with_extension("lock"))?;
        let mut current = self.load(&path)?;
        let pending = path.with_extension("pending");
        if pending.exists() {
            let mut candidate = self.load(&pending)?;
            identity_matches(&current, &candidate)?;
            if candidate.generation < current.generation {
                return Err(BrokerError::RecoveryRequired);
            }
            candidate.in_flight = false;
            self.save(&path, &candidate)?;
            fs::remove_file(&pending).map_err(|_| BrokerError::Storage)?;
            return Ok(candidate.metadata());
        }
        if current.in_flight
            || matches!(
                current.error,
                Some(BrokerError::ReauthRequired | BrokerError::RecoveryRequired)
            )
        {
            return Err(current.error.unwrap_or(BrokerError::RecoveryRequired));
        }
        let now = crate::current_epoch_secs();
        if !force && (now < current.due_at() || current.next_retry_at.is_some_and(|t| t > now)) {
            return Ok(current.metadata());
        }
        // Persist intent before talking to the rotation endpoint. A crash or an
        // ambiguous timeout will stop retries of the potentially consumed RT.
        current.in_flight = true;
        self.save(&path, &current)?;
        match request_refresh(&self.config, &current) {
            Ok(mut candidate) => {
                candidate.in_flight = false;
                candidate.error = None;
                candidate.failures = 0;
                candidate.next_retry_at = None;
                // Response journal is durable before canonical promotion.
                self.save(&pending, &candidate)?;
                identity_matches(&current, &candidate)?;
                self.save(&path, &candidate)?;
                fs::remove_file(pending).map_err(|_| BrokerError::Storage)?;
                Ok(candidate.metadata())
            }
            Err(error) => {
                current.in_flight = false;
                current.error = Some(error);
                current.failures = current.failures.saturating_add(1);
                current.next_retry_at = if matches!(
                    error,
                    BrokerError::ServiceUnavailable | BrokerError::Unchanged
                ) {
                    Some(
                        now + match current.failures {
                            1 => 900,
                            2 => 3600,
                            _ => 21600,
                        },
                    )
                } else {
                    None
                };
                self.save(&path, &current)?;
                Err(error)
            }
        }
    }
    pub fn access_credential(&self, key: &str) -> BrokerResult<AccessCredential> {
        let value = self.load(&self.path(key)?)?;
        if value.expires_at <= crate::current_epoch_secs() {
            return Err(BrokerError::ReauthRequired);
        }
        if matches!(value.error, Some(BrokerError::ReauthRequired)) {
            return Err(BrokerError::ReauthRequired);
        }
        Ok(value.projection())
    }
    pub fn acknowledge_cockpit(&self, key: &str, generation: u64) -> BrokerResult<BrokerMetadata> {
        let path = self.path(key)?;
        let _guard = acquire_lock(&path.with_extension("lock"))?;
        let mut current = self.load(&path)?;
        if generation != current.generation {
            return Err(BrokerError::ConsumerConflict);
        }
        current.cockpit_synced_generation = Some(generation);
        self.save(&path, &current)?;
        Ok(current.metadata())
    }
    pub fn set_cpa_enabled(&self, key: &str, enabled: bool) -> BrokerResult<BrokerMetadata> {
        let path = self.path(key)?;
        let _guard = acquire_lock(&path.with_extension("lock"))?;
        let mut current = self.load(&path)?;
        if enabled && self.config.cpa_auth_dir.is_none() {
            return Err(BrokerError::Config);
        }
        current.cpa_enabled = enabled;
        self.save(&path, &current)?;
        Ok(current.metadata())
    }
    pub fn sync_cpa(&self, key: &str) -> BrokerResult<BrokerMetadata> {
        let path = self.path(key)?;
        let _guard = acquire_lock(&path.with_extension("lock"))?;
        let mut grant = self.load(&path)?;
        if !grant.cpa_enabled {
            return Ok(grant.metadata());
        }
        let directory = self
            .config
            .cpa_auth_dir
            .as_ref()
            .ok_or(BrokerError::Config)?;
        reject_link(directory)?;
        let result = (|| {
            let (destination, existing) = cpa_destination(directory, key, &grant)?;
            if grant.expires_at <= crate::current_epoch_secs() {
                return Err(BrokerError::ReauthRequired);
            }
            let mut projection =
                serde_json::to_value(grant.projection()).map_err(|_| BrokerError::Storage)?;
            // Quota/operator disablement is independent of token updates.
            if let Some(disabled) = existing.as_ref().and_then(|v| v.get("disabled")) {
                projection["disabled"] = disabled.clone();
            }
            crate::write_secret_atomic(&destination, &projection.to_string())
                .map_err(|_| BrokerError::Storage)
        })();
        match result {
            Ok(()) => {
                grant.cpa_synced_generation = Some(grant.generation);
                grant.cpa_sync_error = None;
            }
            Err(error) => grant.cpa_sync_error = Some(error),
        }
        self.save(&path, &grant)?;
        Ok(grant.metadata())
    }
    /// Cheap local scan; real OAuth requests are due-only and backoff guarded.
    pub fn run_cycle(&self) -> BrokerResult<()> {
        for meta in self.list()? {
            if meta.error != Some(BrokerError::ReauthRequired)
                && meta.error != Some(BrokerError::RecoveryRequired)
            {
                let _ = self.refresh(&meta.key, false);
            }
            if meta.cpa_enabled {
                let _ = self.sync_cpa(&meta.key);
            }
        }
        Ok(())
    }
    fn path(&self, key: &str) -> BrokerResult<PathBuf> {
        validate_key(key)?;
        Ok(self
            .config
            .root
            .join("accounts")
            .join(format!("{}.grant", hash_key(key))))
    }
    fn load(&self, path: &Path) -> BrokerResult<Grant> {
        let encrypted = read_bounded(path, MAX_BYTES * 2)?;
        let envelope: Envelope =
            serde_json::from_slice(&encrypted).map_err(|_| BrokerError::Storage)?;
        if envelope.version != 1 {
            return Err(BrokerError::Storage);
        }
        let nonce: [u8; 12] = STANDARD_NO_PAD
            .decode(envelope.nonce)
            .map_err(|_| BrokerError::Storage)?
            .try_into()
            .map_err(|_| BrokerError::Storage)?;
        let ciphertext = STANDARD_NO_PAD
            .decode(envelope.ciphertext)
            .map_err(|_| BrokerError::Storage)?;
        // Bind ciphertext to account identity (same AAD for canonical/journal).
        let stem = path
            .file_stem()
            .and_then(|p| p.to_str())
            .ok_or(BrokerError::Storage)?;
        let cipher = Aes256Gcm::new(&Array(*self.key));
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    &Array(nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: stem.as_bytes(),
                    },
                )
                .map_err(|_| BrokerError::Storage)?,
        );
        let grant: Grant = serde_json::from_slice(&plaintext).map_err(|_| BrokerError::Storage)?;
        if hash_key(&grant.key) != stem {
            return Err(BrokerError::Storage);
        }
        Ok(grant)
    }
    fn save(&self, path: &Path, grant: &Grant) -> BrokerResult<()> {
        reject_link(path)?;
        let plaintext =
            Zeroizing::new(serde_json::to_vec(grant).map_err(|_| BrokerError::Storage)?);
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new(&Array(*self.key));
        let aad = hash_key(&grant.key);
        let ciphertext = cipher
            .encrypt(
                &Array(nonce),
                Payload {
                    msg: &plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| BrokerError::Storage)?;
        let encrypted = serde_json::to_string(&Envelope {
            version: 1,
            nonce: STANDARD_NO_PAD.encode(nonce),
            ciphertext: STANDARD_NO_PAD.encode(ciphertext),
        })
        .map_err(|_| BrokerError::Storage)?;
        crate::write_secret_atomic(path, &encrypted).map_err(|_| BrokerError::Storage)
    }
}

fn cpa_destination(
    directory: &Path,
    key: &str,
    grant: &Grant,
) -> BrokerResult<(PathBuf, Option<Value>)> {
    let canonical = directory.join(format!("notrace_{}.json", hash_key(key)));
    let mut managed: Option<(PathBuf, Value)> = None;
    for entry in fs::read_dir(directory).map_err(|_| BrokerError::Storage)? {
        let path = entry.map_err(|_| BrokerError::Storage)?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        reject_link(&path)?;
        let raw = match read_bounded(&path, MAX_BYTES) {
            Ok(value) => value,
            Err(BrokerError::AccountMissing) => continue,
            Err(error) => return Err(error),
        };
        let value: Value = match serde_json::from_slice(&raw) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let same_identity = cpa_identity_matches(&value, grant);
        let is_managed = value.get("refresh_owner").and_then(Value::as_str)
            == Some("notrace_broker")
            && value.get("notrace_key").and_then(Value::as_str) == Some(key);
        if is_managed {
            if value
                .get("refresh_token")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
            {
                return Err(BrokerError::ConsumerConflict);
            }
            if managed.is_some() {
                return Err(BrokerError::ConsumerConflict);
            }
            managed = Some((path, value));
        } else if same_identity {
            // An existing CPA credential for this ChatGPT identity still owns
            // an unknown refresh lineage. Never create a duplicate access-only
            // account beside it; the operator must explicitly migrate it.
            return Err(BrokerError::ConsumerConflict);
        } else if path == canonical {
            // The canonical NoTrace filename is reserved. An existing file
            // without our ownership marker may belong to an older migration;
            // never overwrite it merely because its identity fields are absent.
            return Err(BrokerError::ConsumerConflict);
        }
    }
    Ok(managed.map_or((canonical, None), |(path, value)| (path, Some(value))))
}

fn cpa_identity_matches(value: &Value, grant: &Grant) -> bool {
    let tokens = value.get("tokens").unwrap_or(value);
    let email = value
        .get("email")
        .and_then(Value::as_str)
        .or_else(|| tokens.get("email").and_then(Value::as_str));
    let account_id = value
        .get("account_id")
        .and_then(Value::as_str)
        .or_else(|| tokens.get("account_id").and_then(Value::as_str));
    email.is_some_and(|candidate| candidate.eq_ignore_ascii_case(&grant.email))
        || account_id.is_some_and(|candidate| candidate == grant.account_id)
}

/// Transfer one locally authorized grant to the Broker, then mark local policy
/// Broker-owned so the Mac scheduler cannot rotate the same lineage.
pub fn push_local_grant(
    config: &crate::CloakConfig,
    name: &str,
    endpoint: &str,
    admin_key: &str,
) -> crate::Result<BrokerMetadata> {
    let parsed = url::Url::parse(endpoint)
        .map_err(|_| crate::CloakError::Auth("Broker 地址无效".to_string()))?;
    let host = parsed.host_str().unwrap_or_default();
    let private_http =
        parsed.scheme() == "http" && matches!(host, "localhost" | "127.0.0.1" | "::1");
    if parsed.scheme() != "https" && !private_http {
        return Err(crate::CloakError::Auth(
            "远程 Broker 必须使用 HTTPS".to_string(),
        ));
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(crate::CloakError::Auth("Broker 地址参数无效".to_string()));
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| crate::CloakError::Auth("无法创建 Broker 客户端".to_string()))?;
    // Check endpoint/role before freezing the local grant. This is read-only.
    let preflight = client
        .get(format!(
            "{}/v1/admin/accounts",
            endpoint.trim_end_matches('/')
        ))
        .bearer_auth(admin_key)
        .send()
        .map_err(|_| crate::CloakError::Auth("无法连接 NoTrace Broker".to_string()))?;
    if !preflight.status().is_success() {
        return Err(crate::CloakError::Auth(
            "Broker 连接或管理密钥无效".to_string(),
        ));
    }
    crate::auth::with_broker_handoff(config, name, |profile_id, body| {
        let key = utf8_percent_encode(profile_id, PATH_SEGMENT_ENCODE_SET);
        let target = format!(
            "{}/v1/admin/accounts/{key}/grant",
            endpoint.trim_end_matches('/')
        );
        let response = client
            .post(target)
            .header("Authorization", format!("Bearer {admin_key}"))
            .header("Content-Type", "application/json")
            .body(body.as_bytes().to_vec())
            .send()
            .map_err(|_| crate::CloakError::Auth("无法连接 NoTrace Broker".to_string()))?;
        if !response.status().is_success() {
            return Err(crate::CloakError::Auth(match response.status().as_u16() {
                400 => "Broker 拒绝了授权数据".to_string(),
                401 | 403 => "Broker 管理密钥无效".to_string(),
                409 => "Broker 认为账号授权已失效，需要重新授权".to_string(),
                _ => "Broker 导入授权失败".to_string(),
            }));
        }
        let metadata: BrokerMetadata = response
            .json()
            .map_err(|_| crate::CloakError::Auth("Broker 返回的数据无效".to_string()))?;
        if metadata.key != profile_id {
            return Err(crate::CloakError::Auth(
                "Broker 返回了错误的授权链".to_string(),
            ));
        }
        Ok(metadata)
    })
}

fn parse_grant(key: &str, body: &str) -> BrokerResult<Grant> {
    if body.len() as u64 > MAX_BYTES {
        return Err(BrokerError::InputTooLarge);
    }
    let root: Value = serde_json::from_str(body).map_err(|_| BrokerError::InvalidGrant)?;
    let tokens = root.get("tokens").unwrap_or(&root);
    let access_token = field(tokens, "access_token").ok_or(BrokerError::InvalidGrant)?;
    let refresh_token = field(tokens, "refresh_token").ok_or(BrokerError::InvalidGrant)?;
    let id_token = field(tokens, "id_token").ok_or(BrokerError::InvalidGrant)?;
    let at = claims(&access_token).ok_or(BrokerError::InvalidGrant)?;
    let id = claims(&id_token).ok_or(BrokerError::InvalidGrant)?;
    let email = claim_email(&id)
        .or_else(|| claim_email(&at))
        .ok_or(BrokerError::InvalidGrant)?;
    let account_id = claim_account(&at)
        .or_else(|| claim_account(&id))
        .or_else(|| field(tokens, "account_id"))
        .ok_or(BrokerError::InvalidGrant)?;
    if let Some(declared) = field(tokens, "account_id") {
        if declared != account_id {
            return Err(BrokerError::IdentityMismatch);
        }
    }
    let now = crate::current_epoch_secs();
    let expires_at = at
        .get("exp")
        .and_then(Value::as_u64)
        .filter(|t| *t > now)
        .ok_or(BrokerError::InvalidGrant)?;
    // The grant digest serves as the idempotent handoff ID. It is never a token.
    let handoff_id = format!("{:x}", Sha256::digest(refresh_token.as_bytes()));
    Ok(Grant {
        key: key.into(),
        email,
        account_id,
        plan_type: claim_plan(&at).or_else(|| claim_plan(&id)),
        access_token,
        id_token,
        refresh_token,
        expires_at,
        issued_at: at.get("iat").and_then(Value::as_u64).unwrap_or(now),
        last_refresh_at: now,
        handoff_id,
        generation: 1,
        in_flight: false,
        error: None,
        failures: 0,
        next_retry_at: None,
        cpa_enabled: false,
        cpa_synced_generation: None,
        cpa_sync_error: None,
        cockpit_synced_generation: None,
    })
}

fn request_refresh(config: &BrokerConfig, previous: &Grant) -> BrokerResult<Grant> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = &config.proxy_url {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| BrokerError::Config)?);
    }
    let client = builder.build().map_err(|_| BrokerError::Config)?;
    let response = client
        .post(&config.token_url)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", previous.refresh_token.as_str()),
            ("scope", "openid profile email"),
        ])
        .send()
        .map_err(|e| {
            if e.is_connect() {
                BrokerError::ServiceUnavailable
            } else {
                BrokerError::RecoveryRequired
            }
        })?;
    let status = response.status();
    // HTTP rejections have not issued a replacement grant. Parsing messages is
    // classification-only; upstream bodies must never escape into errors/logs.
    if !status.is_success() {
        let mut body = String::new();
        let _ = response.take(MAX_BYTES).read_to_string(&mut body);
        let error = serde_json::from_str::<Value>(&body).ok();
        let code = error
            .as_ref()
            .and_then(|v| v.get("error"))
            .and_then(|v| v.as_str().or_else(|| v.get("code").and_then(Value::as_str)))
            .unwrap_or("");
        return Err(
            if matches!(
                code,
                "invalid_grant"
                    | "invalid_token"
                    | "refresh_token_expired"
                    | "refresh_token_invalidated"
                    | "refresh_token_reused"
            ) || status.as_u16() == 401
            {
                BrokerError::ReauthRequired
            } else {
                BrokerError::ServiceUnavailable
            },
        );
    }
    let mut body = Zeroizing::new(String::new());
    response
        .take(MAX_BYTES + 1)
        .read_to_string(&mut body)
        .map_err(|_| BrokerError::RecoveryRequired)?;
    if body.len() as u64 > MAX_BYTES {
        return Err(BrokerError::RecoveryRequired);
    }
    let result: Value = serde_json::from_str(&body).map_err(|_| BrokerError::RecoveryRequired)?;
    let mut candidate = previous.clone();
    candidate.access_token = field(&result, "access_token").ok_or(BrokerError::RecoveryRequired)?;
    candidate.refresh_token =
        field(&result, "refresh_token").unwrap_or_else(|| previous.refresh_token.clone());
    candidate.id_token = field(&result, "id_token").unwrap_or_else(|| previous.id_token.clone());
    let at = claims(&candidate.access_token).ok_or(BrokerError::RecoveryRequired)?;
    let id = claims(&candidate.id_token).ok_or(BrokerError::RecoveryRequired)?;
    candidate.email = claim_email(&at)
        .or_else(|| claim_email(&id))
        .ok_or(BrokerError::RecoveryRequired)?;
    candidate.account_id = claim_account(&at)
        .or_else(|| claim_account(&id))
        .ok_or(BrokerError::RecoveryRequired)?;
    candidate.plan_type = claim_plan(&at).or_else(|| claim_plan(&id));
    let now = crate::current_epoch_secs();
    candidate.expires_at = at
        .get("exp")
        .and_then(Value::as_u64)
        .filter(|t| *t > now + 60)
        .ok_or(BrokerError::RecoveryRequired)?;
    candidate.issued_at = at.get("iat").and_then(Value::as_u64).unwrap_or(now);
    candidate.last_refresh_at = now;
    if previous.access_token == candidate.access_token
        && previous.refresh_token == candidate.refresh_token
    {
        return Err(BrokerError::Unchanged);
    }
    candidate.generation = previous.generation + 1;
    Ok(candidate)
}
fn identity_matches(a: &Grant, b: &Grant) -> BrokerResult<()> {
    if !a.email.eq_ignore_ascii_case(&b.email) || a.account_id != b.account_id {
        Err(BrokerError::IdentityMismatch)
    } else {
        Ok(())
    }
}
fn validate_key(key: &str) -> BrokerResult<()> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'@' | b'+'))
    {
        Err(BrokerError::Config)
    } else {
        Ok(())
    }
}
fn hash_key(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}
fn parse_key(raw: &str) -> BrokerResult<[u8; 32]> {
    if raw.len() != 64 {
        return Err(BrokerError::Config);
    }
    let mut key = [0u8; 32];
    for (i, part) in raw.as_bytes().chunks_exact(2).enumerate() {
        key[i] = u8::from_str_radix(
            std::str::from_utf8(part).map_err(|_| BrokerError::Config)?,
            16,
        )
        .map_err(|_| BrokerError::Config)?;
    }
    Ok(key)
}
fn ensure_dir(path: &Path) -> BrokerResult<()> {
    reject_link(path)?;
    fs::create_dir_all(path).map_err(|_| BrokerError::Storage)?;
    crate::secure_dir(path).map_err(|_| BrokerError::Storage)
}
fn reject_link(path: &Path) -> BrokerResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(BrokerError::Storage),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(BrokerError::Storage),
    }
}
fn acquire_lock(path: &Path) -> BrokerResult<File> {
    reject_link(path)?;
    let mut opts = OpenOptions::new();
    opts.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(path).map_err(|_| BrokerError::Storage)?;
    fs4::FileExt::try_lock(&file).map_err(|_| BrokerError::Busy)?;
    Ok(file)
}
fn read_bounded(path: &Path, limit: u64) -> BrokerResult<Zeroizing<Vec<u8>>> {
    reject_link(path)?;
    let file = File::open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            BrokerError::AccountMissing
        } else {
            BrokerError::Storage
        }
    })?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| BrokerError::Storage)?;
    if bytes.len() as u64 > limit {
        Err(BrokerError::InputTooLarge)
    } else {
        Ok(bytes)
    }
}
fn field(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(ToOwned::to_owned)
}
fn claims(t: &str) -> Option<Value> {
    let mut p = t.split('.');
    p.next()?;
    let payload = p.next()?;
    p.next()?;
    if p.next().is_some() {
        return None;
    }
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()
}
fn claim_email(v: &Value) -> Option<String> {
    v.pointer("/https:~1~1api.openai.com~1profile/email")
        .and_then(Value::as_str)
        .or_else(|| v.get("email").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}
fn claim_account(v: &Value) -> Option<String> {
    v.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
fn claim_plan(v: &Value) -> Option<String> {
    v.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
fn iso_time(t: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(t as i64, 0)
        .map(|t| t.to_rfc3339())
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "broker_tests.rs"]
mod tests;
