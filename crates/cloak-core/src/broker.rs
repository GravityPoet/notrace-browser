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
const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
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
    #[error("CPA 托管凭据已被删除，自动同步已暂停")]
    ConsumerMissing,
    #[error("额度暂时无法读取，上游未提供有效数据")]
    QuotaUnavailable,
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
    #[serde(default)]
    pub refresh_count: u64,
    #[serde(default)]
    pub automatic_refresh_count: u64,
    pub generation: u64,
    pub next_refresh_at: u64,
    pub next_retry_at: Option<u64>,
    pub error: Option<BrokerError>,
    pub cpa_enabled: bool,
    pub cpa_synced_generation: Option<u64>,
    pub cpa_sync_error: Option<BrokerError>,
    #[serde(default)]
    pub cpa_sync_suspended: bool,
    pub cockpit_synced_generation: Option<u64>,
}

/// Credentials have no Debug implementation. Consumer routes receive access-only;
/// an explicit local admin export may opt in to the encrypted grant's RT.
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CodexQuotaWindow {
    pub name: String,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub reset_at: Option<u64>,
    pub window_minutes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CodexQuotaSnapshot {
    pub account_id: String,
    pub email: String,
    pub fetched_at: u64,
    pub generation: u64,
    pub windows: Vec<CodexQuotaWindow>,
    pub reset_count: Option<u64>,
    pub reset_count_available: bool,
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
    #[serde(default)]
    refresh_count: u64,
    #[serde(default)]
    automatic_refresh_count: u64,
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
    cpa_sync_suspended: bool,
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
            refresh_count: self.refresh_count,
            automatic_refresh_count: self.automatic_refresh_count,
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
            cpa_sync_error: if self.cpa_sync_suspended {
                Some(BrokerError::ConsumerMissing)
            } else {
                self.cpa_sync_error
            },
            cpa_sync_suspended: self.cpa_sync_suspended,
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
            incoming.refresh_count = current.refresh_count;
            incoming.automatic_refresh_count = current.automatic_refresh_count;
            // A new browser grant waits for explicit CPA synchronization. This
            // is committed under the grant lock, before a scheduler can see it.
            incoming.cpa_enabled = false;
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
        if current.error == Some(BrokerError::ReauthRequired) {
            if current.cpa_enabled || current.next_retry_at.is_some() || current.in_flight {
                current.cpa_enabled = false;
                current.next_retry_at = None;
                current.in_flight = false;
                current.cpa_sync_error = Some(BrokerError::ReauthRequired);
                self.save(&path, &current)?;
            }
            return Err(BrokerError::ReauthRequired);
        }
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
            let error = current.error.unwrap_or(BrokerError::RecoveryRequired);
            if current.cpa_enabled || current.next_retry_at.is_some() {
                current.cpa_enabled = false;
                current.next_retry_at = None;
                current.cpa_sync_error = Some(error);
                self.save(&path, &current)?;
            }
            return Err(error);
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
                if !force {
                    candidate.automatic_refresh_count =
                        current.automatic_refresh_count.saturating_add(1);
                }
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
                if error == BrokerError::ReauthRequired {
                    // A terminal OAuth failure must stop both refresh retries
                    // and CPA projection. Keep the old CPA file untouched for
                    // audit/recovery, but never rewrite or recreate it.
                    current.cpa_enabled = false;
                    current.cpa_sync_error = Some(BrokerError::ReauthRequired);
                    current.next_retry_at = None;
                }
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

    /// Read-only Codex usage query using the current access token. It never
    /// calls refresh(), never persists tokens, and never writes CPA files.
    pub fn quota_snapshot(&self, key: &str) -> BrokerResult<CodexQuotaSnapshot> {
        let grant = self.load(&self.path(key)?)?;
        if grant.expires_at <= crate::current_epoch_secs()
            || grant.error == Some(BrokerError::ReauthRequired)
        {
            return Err(BrokerError::ReauthRequired);
        }
        fetch_codex_quota(&self.config, &grant)
    }
    pub fn export_credential(
        &self,
        key: &str,
        include_refresh_token: bool,
    ) -> BrokerResult<AccessCredential> {
        let value = self.load(&self.path(key)?)?;
        if value.expires_at <= crate::current_epoch_secs() {
            return Err(BrokerError::ReauthRequired);
        }
        if matches!(value.error, Some(BrokerError::ReauthRequired)) {
            return Err(BrokerError::ReauthRequired);
        }
        let mut projection = value.projection();
        if include_refresh_token {
            projection.refresh_token = value.refresh_token;
        }
        Ok(projection)
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
        if enabled && (current.in_flight || matches!(
            current.error,
            Some(BrokerError::ReauthRequired | BrokerError::RecoveryRequired)
        ))
        {
            // A terminal OAuth lineage is deliberately inert. Re-enabling CPA
            // must not resurrect a deleted/stale account; only a fresh grant
            // imported through explicit reauthorization may re-enable it.
            return Err(current.error.unwrap_or(BrokerError::RecoveryRequired));
        }
        if enabled && self.config.cpa_auth_dir.is_none() {
            return Err(BrokerError::Config);
        }
        current.cpa_enabled = enabled;
        current.cpa_sync_suspended = false;
        if enabled {
            current.cpa_synced_generation = None;
            current.cpa_sync_error = None;
        }
        self.save(&path, &current)?;
        Ok(current.metadata())
    }
    pub fn sync_cpa(&self, key: &str) -> BrokerResult<BrokerMetadata> {
        let path = self.path(key)?;
        let _guard = acquire_lock(&path.with_extension("lock"))?;
        let mut grant = self.load(&path)?;
        if grant.in_flight || matches!(
            grant.error,
            Some(BrokerError::ReauthRequired | BrokerError::RecoveryRequired)
        ) {
            if grant.cpa_enabled || grant.next_retry_at.is_some() {
                grant.cpa_enabled = false;
                grant.next_retry_at = None;
                grant.cpa_sync_error = Some(grant.error.unwrap_or(BrokerError::RecoveryRequired));
                self.save(&path, &grant)?;
            }
            return Ok(grant.metadata());
        }
        if !grant.cpa_enabled || grant.cpa_sync_suspended {
            return Ok(grant.metadata());
        }
        let previous_sync = (grant.cpa_synced_generation, grant.cpa_sync_error);
        let directory = self
            .config
            .cpa_auth_dir
            .as_ref()
            .ok_or(BrokerError::Config)?;
        reject_link(directory)?;
        let result = (|| {
            let (destination, existing, legacy) = cpa_destination(directory, key, &grant)?;
            if existing.is_none()
                && legacy.is_none()
                && grant.cpa_synced_generation.is_some()
            {
                return Err(BrokerError::ConsumerMissing);
            }
            if grant.expires_at <= crate::current_epoch_secs() {
                return Err(BrokerError::ReauthRequired);
            }
            let mut projection =
                serde_json::to_value(grant.projection()).map_err(|_| BrokerError::Storage)?;
            // Quota/operator disablement is independent of token updates.
            if let Some(disabled) = existing.as_ref().and_then(|v| v.get("disabled")) {
                projection["disabled"] = disabled.clone();
            }
            if let Some(legacy) = legacy {
                reject_link(&destination)?;
                if destination.exists() {
                    return Err(BrokerError::ConsumerConflict);
                }
                fs::rename(&legacy, &destination).map_err(|_| BrokerError::Storage)?;
                crate::sync_directory(directory).map_err(|_| BrokerError::Storage)?;
            }
            // Avoid generating file-watcher reloads when the consumer already
            // has this exact projection. A missing or changed file is repaired.
            if existing.as_ref() == Some(&projection) {
                return Ok(());
            }
            write_cpa_projection_atomic(&destination, &projection.to_string())
                .map_err(|_| BrokerError::Storage)
        })();
        match result {
            Ok(()) => {
                grant.cpa_synced_generation = Some(grant.generation);
                grant.cpa_sync_error = None;
            }
            Err(BrokerError::ConsumerMissing) => {
                grant.cpa_enabled = false;
                grant.cpa_sync_suspended = true;
                // Keep the encrypted grant readable by the rollback binary,
                // whose enum predates ConsumerMissing. New metadata derives
                // the precise reason from this additive suspension flag.
                grant.cpa_sync_error = Some(BrokerError::ConsumerConflict);
            }
            Err(error) => grant.cpa_sync_error = Some(error),
        }
        if previous_sync != (grant.cpa_synced_generation, grant.cpa_sync_error) {
            self.save(&path, &grant)?;
        }
        Ok(grant.metadata())
    }
    /// Cheap local scan; real OAuth requests are due-only and backoff guarded.
    pub fn run_cycle(&self) -> BrokerResult<()> {
        let entries =
            fs::read_dir(self.config.root.join("accounts")).map_err(|_| BrokerError::Storage)?;
        let mut storage_error = None;
        for entry in entries {
            let path = match entry {
                Ok(entry) => entry.path(),
                Err(_) => {
                    storage_error = Some(BrokerError::Storage);
                    continue;
                }
            };
            if path.extension().and_then(|value| value.to_str()) != Some("grant") {
                continue;
            }
            let grant = match self.load(&path) {
                Ok(grant) => grant,
                Err(error) => {
                    storage_error = Some(error);
                    continue;
                }
            };
            // refresh recovers a durable response before checking terminal
            // failures, and never reuses an ambiguous old refresh token.
            let refresh_result = self.refresh(&grant.key, false);
            if let Err(error @ (BrokerError::Storage | BrokerError::InputTooLarge)) = refresh_result
            {
                storage_error = Some(error);
            }
            // Refresh may have promoted a pending response and changed the
            // generation. Reload before projecting to CPA so this cycle never
            // writes a stale access token back over a newly rotated grant.
            let current = match self.load(&path) {
                Ok(current) => current,
                Err(error) => {
                    storage_error = Some(error);
                    continue;
                }
            };
            if current.cpa_enabled && current.error.is_none() && !current.in_flight {
                match self.sync_cpa(&current.key) {
                    Err(error @ (BrokerError::Storage | BrokerError::InputTooLarge)) => {
                        storage_error = Some(error);
                    }
                    Ok(metadata) if metadata.cpa_sync_error == Some(BrokerError::Storage) => {
                        storage_error = Some(BrokerError::Storage);
                    }
                    _ => {}
                }
            }
        }
        storage_error.map_or(Ok(()), Err)
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

/// Write an access-only projection into an externally managed CPA directory.
/// The regular workspace writer hardens its parent to mode 0700, which would
/// erase the ACL that lets the non-root Broker cooperate with CPA's root-owned
/// auth directory. Stage the protected file in a Broker-owned child directory
/// and rename it into the existing directory without changing the parent's
/// ownership or mode.
fn write_cpa_projection_atomic(path: &Path, value: &str) -> BrokerResult<()> {
    let parent = path.parent().ok_or(BrokerError::Storage)?;
    reject_link(parent)?;
    if !parent.is_dir() {
        return Err(BrokerError::Storage);
    }
    reject_link(path)?;

    let mut nonce = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let suffix = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let staging = parent.join(format!(".notrace-cpa-stage-{suffix}"));
    fs::create_dir(&staging).map_err(|_| BrokerError::Storage)?;
    let staged = staging.join("projection.json");
    let result = (|| {
        crate::write_secret_atomic(&staged, value).map_err(|_| BrokerError::Storage)?;
        reject_link(path)?;
        fs::rename(&staged, path).map_err(|_| BrokerError::Storage)?;
        crate::sync_directory(parent).map_err(|_| BrokerError::Storage)
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

fn cpa_destination(
    directory: &Path,
    key: &str,
    grant: &Grant,
) -> BrokerResult<(PathBuf, Option<Value>, Option<PathBuf>)> {
    let canonical = directory.join(format!("{}.json", cpa_file_stem(&grant.email, key)));
    let legacy_canonical = directory.join(format!("notrace_{}.json", hash_key(key)));
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
            // CPA may create root-owned 0600 files through its management UI.
            // An unrelated unreadable file must not block every Broker account;
            // preserve the safety check for this account's reserved/obvious
            // filename so we never overwrite an unknown credential silently.
            Err(BrokerError::Storage)
                if path != canonical
                    && path != legacy_canonical
                    && !path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .is_some_and(|value| value.contains(&grant.email)) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        let value: Value = match serde_json::from_slice(&raw) {
            Ok(value) => value,
            Err(_) if path == canonical || path == legacy_canonical => {
                return Err(BrokerError::ConsumerConflict);
            }
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
        } else if path == canonical || path == legacy_canonical {
            // Both the email-based name and the previous hash-based name are
            // reserved. An existing file without our ownership marker may
            // belong to an older migration; never overwrite it merely because
            // its identity fields are absent.
            return Err(BrokerError::ConsumerConflict);
        }
    }
    Ok(
        managed.map_or((canonical.clone(), None, None), |(path, value)| {
            if path == canonical {
                (canonical, Some(value), None)
            } else {
                (canonical, Some(value), Some(path))
            }
        }),
    )
}

fn cpa_file_stem(email: &str, key: &str) -> String {
    let stem = email
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '@' | '.' | '+' | '-' | '_')
        })
        .collect::<String>();
    if stem.is_empty() {
        format!("notrace_{}", hash_key(key))
    } else {
        stem
    }
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

/// Decode metadata for a local file import before mutating any refresh policy.
/// This checks consistency, not the provider's acceptance of a refresh token.
pub(crate) fn validate_import_grant(key: &str, body: &str) -> BrokerResult<BrokerMetadata> {
    let grant = parse_grant(key, body)?;
    let access = claims(&grant.access_token).ok_or(BrokerError::InvalidGrant)?;
    let identity = claims(&grant.id_token).ok_or(BrokerError::InvalidGrant)?;
    for claim in [&access, &identity] {
        if claim_email(claim).is_some_and(|email| !email.eq_ignore_ascii_case(&grant.email))
            || claim_account(claim).is_some_and(|account| account != grant.account_id)
        {
            return Err(BrokerError::IdentityMismatch);
        }
    }
    Ok(grant.metadata())
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
        refresh_count: 0,
        automatic_refresh_count: 0,
        in_flight: false,
        error: None,
        failures: 0,
        next_retry_at: None,
        cpa_enabled: false,
        cpa_synced_generation: None,
        cpa_sync_error: None,
        cpa_sync_suspended: false,
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
                    | "token_revoked"
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
    candidate.refresh_count = previous.refresh_count.saturating_add(1);
    Ok(candidate)
}

/// Resolve the usage endpoint without making the production URL configurable.
/// A loopback token URL is used only by unit tests; production always uses the
/// fixed ChatGPT endpoint, which prevents an imported grant from becoming an
/// SSRF primitive.
fn quota_endpoint(config: &BrokerConfig) -> String {
    if let Ok(mut url) = url::Url::parse(&config.token_url) {
        if matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
            url.set_path("/usage");
            url.set_query(None);
            url.set_fragment(None);
            return url.to_string();
        }
    }
    USAGE_URL.to_string()
}

/// Query ChatGPT/Codex usage with the current access token only. This is
/// intentionally separate from `refresh()`: opening the quota panel must not
/// rotate a refresh token, write a grant, or synchronize CPA.
fn fetch_codex_quota(config: &BrokerConfig, grant: &Grant) -> BrokerResult<CodexQuotaSnapshot> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = &config.proxy_url {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| BrokerError::Config)?);
    }
    let client = builder.build().map_err(|_| BrokerError::QuotaUnavailable)?;
    let response = client
        .get(quota_endpoint(config))
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", grant.access_token))
        .header("User-Agent", "Codex Desktop")
        .header("originator", "Codex Desktop")
        .send()
        .map_err(|_| BrokerError::QuotaUnavailable)?;
    let status = response.status();
    let mut body = String::new();
    response
        .take(MAX_BYTES + 1)
        .read_to_string(&mut body)
        .map_err(|_| BrokerError::QuotaUnavailable)?;
    if body.len() as u64 > MAX_BYTES || !status.is_success() {
        // Do not persist or return upstream bodies; they may contain account
        // metadata and are not useful to the Picker.
        return Err(BrokerError::QuotaUnavailable);
    }
    let root: Value = serde_json::from_str(&body).map_err(|_| BrokerError::QuotaUnavailable)?;
    let rate_limit = root.get("rate_limit").and_then(Value::as_object);
    let mut windows = Vec::new();
    for (name, window) in [
        ("5 小时", rate_limit.and_then(|v| v.get("primary_window"))),
        ("周", rate_limit.and_then(|v| v.get("secondary_window"))),
    ] {
        let Some(window) = window.and_then(Value::as_object) else {
            continue;
        };
        let used_percent = number_f64(window.get("used_percent"));
        let remaining_percent = used_percent.map(|value| (100.0 - value).clamp(0.0, 100.0));
        let reset_at = window
            .get("reset_at")
            .and_then(timestamp_seconds)
            .or_else(|| {
                window
                    .get("reset_after_seconds")
                    .and_then(Value::as_i64)
                    .filter(|seconds| *seconds >= 0)
                    .map(|seconds| crate::current_epoch_secs().saturating_add(seconds as u64))
            });
        let window_minutes = window
            .get("limit_window_seconds")
            .and_then(Value::as_i64)
            .filter(|seconds| *seconds > 0)
            .map(|seconds| ((seconds + 59) / 60) as u64);
        windows.push(CodexQuotaWindow {
            name: name.to_string(),
            used_percent,
            remaining_percent,
            reset_at,
            window_minutes,
        });
    }
    let mut reset_count = root
        .get("rate_limit_reset_credits")
        .and_then(|value| value.get("available_count"))
        .and_then(Value::as_u64)
        .or_else(|| root.get("available_count").and_then(Value::as_u64))
        .or_else(|| count_available_reset_credits(&root));
    if reset_count.is_none() {
        reset_count = fetch_reset_credits_count(config, grant);
    }
    Ok(CodexQuotaSnapshot {
        account_id: grant.account_id.clone(),
        email: grant.email.clone(),
        fetched_at: crate::current_epoch_secs(),
        generation: grant.generation,
        windows,
        reset_count,
        reset_count_available: reset_count.is_some(),
    })
}

fn count_available_reset_credits(root: &Value) -> Option<u64> {
    let credits = root
        .get("rate_limit_reset_credits")
        .and_then(|value| value.get("credits"))
        .or_else(|| root.get("credits"))
        .or_else(|| root.get("data").and_then(|value| value.get("credits")))
        .and_then(Value::as_array)?;
    let now = crate::current_epoch_secs();
    Some(
        credits
            .iter()
            .filter(|credit| {
                let status = credit
                    .get("status")
                    .or_else(|| credit.get("state"))
                    .and_then(Value::as_str)
                    .unwrap_or("available")
                    .to_ascii_lowercase();
                if matches!(status.as_str(), "redeemed" | "used" | "consumed" | "expired") {
                    return false;
                }
                credit
                    .get("expires_at")
                    .or_else(|| credit.get("expire_at"))
                    .and_then(timestamp_seconds)
                    .is_none_or(|expires_at| expires_at > now)
            })
            .count() as u64,
    )
}

fn fetch_reset_credits_count(config: &BrokerConfig, grant: &Grant) -> Option<u64> {
    let endpoint = if let Ok(mut url) = url::Url::parse(&config.token_url) {
        if matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
            url.set_path("/reset-credits");
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        } else {
            RESET_CREDITS_URL.to_string()
        }
    } else {
        RESET_CREDITS_URL.to_string()
    };
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = &config.proxy_url {
        builder = builder.proxy(reqwest::Proxy::all(proxy).ok()?);
    }
    let client = builder.build().ok()?;
    let response = client
        .get(endpoint)
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", grant.access_token))
        .header("User-Agent", "Codex Desktop")
        .header("originator", "Codex Desktop")
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut body = String::new();
    response.take(MAX_BYTES).read_to_string(&mut body).ok()?;
    let root: Value = serde_json::from_str(&body).ok()?;
    root.get("available_count")
        .or_else(|| root.get("data").and_then(|data| data.get("available_count")))
        .and_then(Value::as_u64)
        .or_else(|| count_available_reset_credits(&root))
}

fn number_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| value.as_f64().or_else(|| value.as_i64().map(|v| v as f64)))
}

fn timestamp_seconds(value: &Value) -> Option<u64> {
    let value = value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|v| u64::try_from(v).ok()))?;
    Some(if value > 1_000_000_000_000 {
        value / 1000
    } else {
        value
    })
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
    for (i, part) in raw.as_bytes().as_chunks::<2>().0.iter().enumerate() {
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
pub(crate) fn claims(t: &str) -> Option<Value> {
    let mut p = t.split('.');
    p.next()?;
    let payload = p.next()?;
    p.next()?;
    if p.next().is_some() {
        return None;
    }
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()
}
pub(crate) fn claim_email(v: &Value) -> Option<String> {
    v.pointer("/https:~1~1api.openai.com~1profile/email")
        .and_then(Value::as_str)
        .or_else(|| v.get("email").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}
pub(crate) fn claim_account(v: &Value) -> Option<String> {
    v.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
pub(crate) fn claim_plan(v: &Value) -> Option<String> {
    v.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
pub(crate) fn iso_time(t: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(t as i64, 0)
        .map(|t| t.to_rfc3339())
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "broker_tests.rs"]
mod tests;
