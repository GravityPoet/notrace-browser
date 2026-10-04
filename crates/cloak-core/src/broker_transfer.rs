//! Safe JSON exchange formats for Broker-managed access-only credentials.
//!
//! This module defaults to access-only output. An explicit caller choice can
//! preserve a refresh token in a local export. An explicit Broker import path
//! can promote a selected complete credential to Broker ownership.
use crate::broker::{claim_account, claim_email, claim_plan, claims, iso_time};
use crate::{AccessCredential, CloakError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{io::Read, path::Path};
use zeroize::Zeroizing;

const MAX_IMPORT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrokerJsonFormat {
    CockpitTools,
    AuthJson,
    Cpa,
    Sub2Api,
}

impl BrokerJsonFormat {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "cockpit_tools" => Ok(Self::CockpitTools),
            "auth_json" => Ok(Self::AuthJson),
            "cpa" => Ok(Self::Cpa),
            "sub2api" => Ok(Self::Sub2Api),
            _ => Err(CloakError::Auth("JSON 导出格式无效".into())),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::CockpitTools => "Cockpit Tools",
            Self::AuthJson => "官方 auth.json",
            Self::Cpa => "CPA",
            Self::Sub2Api => "Sub2API",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BrokerJsonAccountPreview {
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub has_access_token: bool,
    pub has_id_token: bool,
    pub has_refresh_token: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrokerJsonImportPreview {
    pub path: String,
    pub detected_format: String,
    pub account_count: usize,
    pub accounts: Vec<BrokerJsonAccountPreview>,
    pub contains_refresh_token: bool,
    pub message: String,
}

#[derive(Clone)]
pub(crate) struct JsonCredentialRecord {
    pub access_token: String,
    pub id_token: String,
    pub account_id: String,
    pub email: String,
    pub expired: String,
    pub expires_at: Option<u64>,
    pub last_refresh: String,
    pub plan_type: Option<String>,
    pub refresh_token: String,
    pub has_refresh_token: bool,
}

/// Parse a local credential file without exposing token contents to the UI.
pub(crate) fn import_records(path: &Path) -> Result<Vec<JsonCredentialRecord>> {
    read_detected_records(path).map(|(_, records)| records)
}

/// Repackage one complete Codex credential into the Broker grant envelope.
/// The caller sends this body directly to the configured Broker.
pub(crate) fn broker_grant_body(record: &JsonCredentialRecord) -> Result<Zeroizing<String>> {
    if record.access_token.is_empty()
        || record.id_token.is_empty()
        || record.refresh_token.is_empty()
        || record.account_id.is_empty()
    {
        return Err(CloakError::Auth(
            "JSON 缺少完整授权链，至少需要 access_token、id_token、refresh_token 和 account_id"
                .into(),
        ));
    }
    serde_json::to_string(&json!({
        "auth_mode": "chatgpt",
        "tokens": {
            "access_token": record.access_token,
            "id_token": record.id_token,
            "refresh_token": record.refresh_token,
            "account_id": record.account_id,
        }
    }))
    .map(Zeroizing::new)
    .map_err(|_| CloakError::Auth("授权 JSON 生成失败".into()))
}

pub fn preview_file(path: &Path) -> Result<BrokerJsonImportPreview> {
    let (format, records) = read_detected_records(path)?;
    let contains_refresh_token = records.iter().any(|record| record.has_refresh_token);
    let accounts = records
        .iter()
        .map(|record| BrokerJsonAccountPreview {
            email: non_empty(&record.email),
            account_id: non_empty(&record.account_id),
            has_access_token: !record.access_token.is_empty(),
            has_id_token: !record.id_token.is_empty(),
            has_refresh_token: record.has_refresh_token,
        })
        .collect::<Vec<_>>();
    let message = if contains_refresh_token {
        "检测到 refresh_token；选择“导入并纳管”交给统一续期服务，或选择“仅转换文件”保存 JSON".into()
    } else {
        "这是 access-only JSON，只能转换为下游格式，缺少 refresh_token 不能导入并纳管".into()
    };
    Ok(BrokerJsonImportPreview {
        path: path.to_string_lossy().into_owned(),
        detected_format: format.label().into(),
        account_count: accounts.len(),
        accounts,
        contains_refresh_token,
        message,
    })
}

pub fn convert_file(
    path: &Path,
    format: BrokerJsonFormat,
    include_refresh_token: bool,
) -> Result<Vec<u8>> {
    let records = import_records(path)?;
    if records.is_empty() || records.iter().any(|record| record.access_token.is_empty()) {
        return Err(CloakError::Auth("JSON 中没有可转换的 access_token".into()));
    }
    let value = format_records(&records, format, include_refresh_token)?;
    serde_json::to_vec_pretty(&value)
        .map(|mut bytes| {
            bytes.push(b'\n');
            bytes
        })
        .map_err(|_| CloakError::Auth("JSON 转换失败".into()))
}

pub fn format_access_credentials(
    credentials: &[AccessCredential],
    format: BrokerJsonFormat,
    include_refresh_token: bool,
) -> Result<Vec<u8>> {
    if credentials.is_empty() {
        return Err(CloakError::Auth("没有可导出的授权".into()));
    }
    let records = credentials
        .iter()
        .map(|credential| JsonCredentialRecord {
            access_token: credential.access_token.clone(),
            id_token: credential.id_token.clone(),
            account_id: credential.account_id.clone(),
            email: credential.email.clone(),
            expired: credential.expired.clone(),
            expires_at: Some(credential.expires_at),
            last_refresh: credential.last_refresh.clone(),
            plan_type: credential.plan_type.clone(),
            refresh_token: if include_refresh_token {
                credential.refresh_token.clone()
            } else {
                String::new()
            },
            has_refresh_token: include_refresh_token && !credential.refresh_token.is_empty(),
        })
        .collect::<Vec<_>>();
    let value = format_records(&records, format, include_refresh_token)?;
    serde_json::to_vec_pretty(&value)
        .map(|mut bytes| {
            bytes.push(b'\n');
            bytes
        })
        .map_err(|_| CloakError::Auth("JSON 导出失败".into()))
}

fn format_records(
    records: &[JsonCredentialRecord],
    format: BrokerJsonFormat,
    include_refresh_token: bool,
) -> Result<Value> {
    Ok(match format {
        BrokerJsonFormat::Cpa => match records {
            [record] => portable_record(record, include_refresh_token),
            _ => {
                return Err(CloakError::Auth(
                    "CPA 每个 JSON 文件只能包含一个账号，请分别导出".into(),
                ))
            }
        },
        BrokerJsonFormat::CockpitTools => Value::Array(
            records
                .iter()
                .map(|record| portable_record(record, include_refresh_token))
                .collect(),
        ),
        BrokerJsonFormat::AuthJson => {
            let values = records
                .iter()
                .map(|record| auth_record(record, include_refresh_token))
                .collect::<Vec<_>>();
            if values.len() == 1 {
                values.into_iter().next().unwrap_or(Value::Null)
            } else {
                Value::Array(values)
            }
        }
        BrokerJsonFormat::Sub2Api => json!({
            "exported_at": iso_now(),
            "proxies": [],
            "accounts": records
                .iter()
                .map(|record| sub2api_record(record, include_refresh_token))
                .collect::<Vec<_>>(),
            "type": "sub2api-data",
            "version": 1,
        }),
    })
}

fn portable_record(record: &JsonCredentialRecord, include_refresh_token: bool) -> Value {
    json!({
        "name": record.email,
        "id_token": record.id_token,
        "access_token": record.access_token,
        "refresh_token": if include_refresh_token { &record.refresh_token } else { "" },
        "account_id": record.account_id,
        "last_refresh": record.last_refresh,
        "email": record.email,
        "type": "codex",
        "expired": record.expired,
        "refresh_owner": "notrace_broker",
    })
}

fn auth_record(record: &JsonCredentialRecord, include_refresh_token: bool) -> Value {
    json!({
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": record.id_token,
            "access_token": record.access_token,
            "refresh_token": if include_refresh_token { &record.refresh_token } else { "" },
            "account_id": record.account_id,
        },
        "last_refresh": record.last_refresh,
        "type": "codex",
    })
}

fn sub2api_record(record: &JsonCredentialRecord, include_refresh_token: bool) -> Value {
    let mut credentials = Map::new();
    credentials.insert(
        "access_token".into(),
        Value::String(record.access_token.clone()),
    );
    credentials.insert("id_token".into(), Value::String(record.id_token.clone()));
    credentials.insert(
        "refresh_token".into(),
        Value::String(if include_refresh_token {
            record.refresh_token.clone()
        } else {
            String::new()
        }),
    );
    if include_refresh_token && !record.refresh_token.is_empty() {
        credentials.insert(
            "client_id".into(),
            Value::String("app_EMoamEEZ73f0CkXaXp7hrann".into()),
        );
    }
    credentials.insert("email".into(), Value::String(record.email.clone()));
    credentials.insert(
        "chatgpt_account_id".into(),
        Value::String(record.account_id.clone()),
    );
    if let Some(plan_type) = &record.plan_type {
        credentials.insert("plan_type".into(), Value::String(plan_type.clone()));
    }
    let mut item = json!({
        "name": record.email,
        "platform": "openai",
        "type": "oauth",
        "credentials": credentials,
        "concurrency": 3,
        "priority": 50,
        "auto_pause_on_expired": true,
    });
    if let Some(expires_at) = record.expires_at {
        item["expires_at"] = Value::Number(expires_at.into());
    }
    item
}

fn parse_records(raw: &str) -> Result<(BrokerJsonFormat, Vec<JsonCredentialRecord>)> {
    let root: Value =
        serde_json::from_str(raw).map_err(|_| CloakError::Auth("无法解析 JSON 文件".into()))?;
    let detected = detect_format(&root);
    let values = if root.get("type").and_then(Value::as_str) == Some("sub2api-data") {
        root.get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else if let Some(accounts) = root.get("accounts").and_then(Value::as_array) {
        accounts.clone()
    } else if let Some(values) = root.as_array() {
        values.clone()
    } else {
        vec![root]
    };
    let records = values.iter().filter_map(parse_record).collect::<Vec<_>>();
    if records.is_empty() {
        return Err(CloakError::Auth("JSON 中没有可识别的 Codex 授权".into()));
    }
    Ok((detected, records))
}

fn read_detected_records(path: &Path) -> Result<(BrokerJsonFormat, Vec<JsonCredentialRecord>)> {
    reject_input_link(path)?;
    let metadata =
        std::fs::metadata(path).map_err(|_| CloakError::Auth("无法读取 JSON 文件".into()))?;
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(CloakError::Auth("JSON 文件过大，已拒绝读取".into()));
    }
    let mut raw = Zeroizing::new(String::new());
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_IMPORT_BYTES + 1).read_to_string(&mut raw))
        .map_err(|_| CloakError::Auth("JSON 文件不是有效文本".into()))?;
    if raw.len() as u64 > MAX_IMPORT_BYTES {
        return Err(CloakError::Auth("JSON 文件过大，已拒绝读取".into()));
    }
    parse_records(&raw)
}

fn detect_format(root: &Value) -> BrokerJsonFormat {
    if root.get("type").and_then(Value::as_str) == Some("sub2api-data") {
        BrokerJsonFormat::Sub2Api
    } else if root.get("tokens").is_some() || root.get("OPENAI_API_KEY").is_some() {
        BrokerJsonFormat::AuthJson
    } else if root.is_array() {
        BrokerJsonFormat::CockpitTools
    } else {
        BrokerJsonFormat::Cpa
    }
}

fn parse_record(value: &Value) -> Option<JsonCredentialRecord> {
    let root = value.get("credentials").unwrap_or(value);
    let tokens = root.get("tokens").unwrap_or(root);
    let access_token = string_field(tokens, "access_token")?;
    let id_token = string_field(tokens, "id_token").unwrap_or_default();
    let access_claims = claims(&access_token);
    let id_claims = claims(&id_token);
    let account_id = string_field(tokens, "account_id")
        .or_else(|| string_field(tokens, "chatgpt_account_id"))
        .or_else(|| access_claims.as_ref().and_then(claim_account))
        .or_else(|| id_claims.as_ref().and_then(claim_account))
        .unwrap_or_default();
    let email = id_claims
        .as_ref()
        .and_then(claim_email)
        .or_else(|| access_claims.as_ref().and_then(claim_email))
        .or_else(|| string_field(tokens, "email"))
        .or_else(|| string_field(value, "email"))
        .unwrap_or_default();
    let expired = string_field(tokens, "expired")
        .or_else(|| string_field(tokens, "expires_at"))
        .unwrap_or_default();
    let expires_at = tokens
        .get("expires_at")
        .and_then(Value::as_u64)
        .or_else(|| tokens.get("expired").and_then(Value::as_u64))
        .or_else(|| {
            access_claims
                .as_ref()
                .and_then(|claims| claims.get("exp").and_then(Value::as_u64))
        });
    let last_refresh = string_field(tokens, "last_refresh")
        .or_else(|| string_field(value, "last_refresh"))
        .unwrap_or_else(iso_now);
    let plan_type = string_field(tokens, "plan_type")
        .or_else(|| access_claims.as_ref().and_then(claim_plan))
        .or_else(|| id_claims.as_ref().and_then(claim_plan));
    let refresh_token = string_field(tokens, "refresh_token").unwrap_or_default();
    let has_refresh_token = !refresh_token.is_empty();
    Some(JsonCredentialRecord {
        access_token,
        id_token,
        account_id,
        email,
        expired,
        expires_at,
        last_refresh,
        plan_type,
        refresh_token,
        has_refresh_token,
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

fn iso_now() -> String {
    let seconds = crate::current_epoch_secs();
    iso_time(seconds)
}

fn reject_input_link(path: &Path) -> Result<()> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| CloakError::Auth("JSON 文件不存在".into()))?;
    if !metadata.file_type().is_file() {
        return Err(CloakError::Auth(
            "请选择普通 JSON 文件，不接受符号链接或目录".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use tempfile::tempdir;

    fn credential() -> AccessCredential {
        AccessCredential {
            auth_type: "codex".into(),
            access_token: "access-only".into(),
            id_token: "id-only".into(),
            account_id: "acct-1".into(),
            email: "alpha@example.test".into(),
            expired: "2026-10-08T00:00:00Z".into(),
            expires_at: 1_800_000_000,
            last_refresh: "2026-10-02T00:00:00Z".into(),
            plan_type: Some("plus".into()),
            refresh_token: String::new(),
            refresh_owner: "notrace_broker".into(),
            notrace_key: "profile-1".into(),
            notrace_generation: 1,
        }
    }

    #[test]
    fn exports_access_only_formats_without_refresh_token() {
        let credential = credential();
        let bytes = format_access_credentials(&[credential], BrokerJsonFormat::Cpa, false).unwrap();
        // CPA decodes each uploaded file as a metadata object, not an array.
        let metadata: serde_json::Map<String, Value> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(metadata.get("type").and_then(Value::as_str), Some("codex"));
        assert_eq!(
            metadata.get("access_token").and_then(Value::as_str),
            Some("access-only")
        );
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("\"name\": \"alpha@example.test\""));
        assert!(text.contains("access-only"));
        assert!(text.contains("\"refresh_token\": \"\""));
        assert!(text.contains("notrace_broker"));
    }

    #[test]
    fn cpa_export_rejects_multiple_accounts_in_one_auth_file() {
        let credentials = [credential(), credential()];
        let error =
            format_access_credentials(&credentials, BrokerJsonFormat::Cpa, false).unwrap_err();
        assert!(error.to_string().contains("每个 JSON 文件只能包含一个账号"));
    }

    #[test]
    fn previews_sub2api_and_reports_refresh_token_without_exposing_it() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("input.json");
        std::fs::write(
            &path,
            r#"{"type":"sub2api-data","accounts":[{"credentials":{"access_token":"access","refresh_token":"secret","email":"alpha@example.test","chatgpt_account_id":"acct-1"}}]}"#,
        )
        .unwrap();
        let preview = preview_file(&path).unwrap();
        assert_eq!(preview.detected_format, "Sub2API");
        assert_eq!(preview.account_count, 1);
        assert!(preview.contains_refresh_token);
        assert!(!preview.message.contains("secret"));
    }

    #[test]
    fn official_auth_preview_recovers_email_and_account_from_token_claims() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let jwt = |claims: Value| {
            format!(
                "synthetic.{}.signature",
                URL_SAFE_NO_PAD.encode(claims.to_string())
            )
        };
        let access = jwt(
            json!({"exp": 1_900_000_000, "https://api.openai.com/profile": {"email": "alpha@example.test"}, "https://api.openai.com/auth": {"chatgpt_account_id": "acct-1", "chatgpt_plan_type": "plus"}}),
        );
        let id = jwt(
            json!({"email": "alpha@example.test", "https://api.openai.com/auth": {"chatgpt_account_id": "acct-1"}}),
        );
        std::fs::write(&path, json!({"tokens": {"access_token": access, "id_token": id, "refresh_token": "synthetic-refresh"}}).to_string()).unwrap();
        let preview = preview_file(&path).unwrap();
        assert_eq!(
            preview.accounts[0].email.as_deref(),
            Some("alpha@example.test")
        );
        assert_eq!(preview.accounts[0].account_id.as_deref(), Some("acct-1"));
        assert!(preview.accounts[0].has_id_token);
        assert!(!serde_json::to_string(&preview)
            .unwrap()
            .contains("synthetic-refresh"));
        let records = import_records(&path).unwrap();
        let body = broker_grant_body(&records[0]).unwrap();
        assert!(crate::broker::validate_import_grant("profile-1", &body).is_ok());
    }

    #[test]
    fn incomplete_credential_can_convert_but_cannot_become_a_broker_grant() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("input.json");
        std::fs::write(
            &path,
            r#"{"access_token":"synthetic-access","email":"alpha@example.test"}"#,
        )
        .unwrap();
        assert!(convert_file(&path, BrokerJsonFormat::Cpa, false).is_ok());
        let records = import_records(&path).unwrap();
        assert!(broker_grant_body(&records[0]).is_err());
    }

    #[test]
    fn converts_imported_json_to_access_only_output() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("input.json");
        std::fs::write(
            &path,
            r#"[{"type":"codex","access_token":"access","refresh_token":"secret","email":"alpha@example.test","account_id":"acct-1"}]"#,
        )
        .unwrap();
        let bytes = convert_file(&path, BrokerJsonFormat::AuthJson, false).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("\"access_token\": \"access\""));
        assert!(text.contains("\"refresh_token\": \"\""));
        assert!(!text.contains("secret"));
    }

    #[test]
    fn preserves_refresh_token_only_when_explicitly_requested() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("input.json");
        std::fs::write(
            &path,
            r#"[{"type":"codex","access_token":"access","refresh_token":"secret","email":"alpha@example.test","account_id":"acct-1"}]"#,
        )
        .unwrap();
        let bytes = convert_file(&path, BrokerJsonFormat::Cpa, true).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("\"refresh_token\": \"secret\""));
    }
}
