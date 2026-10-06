use super::*;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use tempfile::TempDir;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn jwt(value: Value) -> String {
    format!(
        "header.{}.signature",
        URL_SAFE_NO_PAD.encode(value.to_string())
    )
}

fn grant_body(email: &str, account_id: &str, refresh: &str, expiry: u64) -> String {
    let access = jwt(json!({
        "exp": expiry,
        "https://api.openai.com/profile": {"email": email},
        "https://api.openai.com/auth": {"chatgpt_account_id": account_id, "chatgpt_plan_type": "plus"}
    }));
    let id = jwt(json!({
        "email": email,
        "https://api.openai.com/auth": {"chatgpt_account_id": account_id, "chatgpt_plan_type": "plus"}
    }));
    json!({"auth_mode":"chatgpt","tokens":{
        "access_token": access, "refresh_token": refresh, "id_token": id,
        "account_id": account_id
    }})
    .to_string()
}

fn store() -> (TempDir, BrokerStore) {
    let dir = tempfile::tempdir().unwrap();
    let config = BrokerConfig {
        root: dir.path().into(),
        cpa_auth_dir: None,
        proxy_url: None,
        token_url: "https://127.0.0.1/unused".into(),
    };
    (dir, BrokerStore::new(config, [7; 32]).unwrap())
}

#[test]
fn broker_key_parser_preserves_hex_values_and_rejects_invalid_inputs() {
    assert_eq!(parse_key(&"af".repeat(32)).unwrap(), [0xaf; 32]);
    assert_eq!(parse_key(&"AF".repeat(32)).unwrap(), [0xaf; 32]);
    for input in [
        "0".repeat(63),
        "0".repeat(65),
        "gg".repeat(32),
        "é".repeat(32),
    ] {
        assert!(matches!(parse_key(&input), Err(BrokerError::Config)));
    }
}

#[test]
fn encrypted_store_and_access_projection_never_expose_refresh_token() {
    let (_dir, store) = store();
    let body = grant_body(
        "alpha@example.test",
        "acct-1",
        "secret-refresh",
        now() + 3600,
    );
    let metadata = store.import_grant("alpha@example.test", &body).unwrap();
    assert_eq!(metadata.email, "alpha@example.test");
    assert_eq!(metadata.refresh_count, 0);
    assert_eq!(metadata.automatic_refresh_count, 0);
    let projection = store.access_credential("alpha@example.test").unwrap();
    let serialized = serde_json::to_string(&projection).unwrap();
    assert!(serialized.contains("access_token"));
    assert!(serialized.contains("refresh_token\":\"\""));
    assert!(!serialized.contains("secret-refresh"));
    let path = fs::read_dir(store.config.root.join("accounts"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("grant"))
        .unwrap();
    assert!(!fs::read_to_string(path).unwrap().contains("secret-refresh"));
}

/// Local-only HTTP boundary for the desktop import path. Uses the real
/// encrypted BrokerStore; no OpenAI endpoint or production credential is used.
fn desktop_import_server(
    store: BrokerStore,
    requests: usize,
) -> (String, thread::JoinHandle<Vec<String>>) {
    use std::io::{BufRead, BufReader};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut paths = Vec::new();
        while paths.len() < requests && std::time::Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => panic!("synthetic server accept failed: {error}"),
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let path = line.split_whitespace().nth(1).unwrap().to_owned();
            let mut length = 0;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            drop(reader);
            let value = if path.ends_with("/grant") {
                let key = path
                    .strip_prefix("/v1/admin/accounts/")
                    .unwrap()
                    .strip_suffix("/grant")
                    .unwrap();
                serde_json::to_value(
                    store
                        .import_grant(key, std::str::from_utf8(&body).unwrap())
                        .unwrap(),
                )
                .unwrap()
            } else {
                assert_eq!(path, "/v1/admin/accounts");
                serde_json::to_value(store.list().unwrap()).unwrap()
            };
            paths.push(path);
            let body = value.to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
        assert_eq!(paths.len(), requests);
        paths
    });
    (endpoint, task)
}

#[test]
fn desktop_json_import_binds_a_trashed_account_and_preserves_cpa_until_explicit_sync() {
    let (_dir, store) = store();
    let local = tempfile::tempdir().unwrap();
    let config = crate::CloakConfig {
        repo_root: local.path().into(),
        account_base: local.path().join("Accounts"),
        extension_source: local.path().join("extension"),
        cloakbrowser_root: local.path().join("browser"),
    };
    let account = crate::create_account(&config, "alpha@example.test").unwrap();
    crate::set_account_trashed(&config, &account.name, true).unwrap();
    let path = local.path().join("import.json");
    let original = grant_body(
        &account.name,
        "acct-1",
        "synthetic-import-refresh",
        now() + 86400,
    );
    fs::write(&path, &original).unwrap();
    let (endpoint, server) = desktop_import_server(store.clone(), 5);
    crate::write_secret_atomic(
        &local.path().join(".notrace-broker-client.json"),
        &json!({"endpoint": endpoint, "admin_key": "synthetic-import-key-000000000000"})
            .to_string(),
    )
    .unwrap();
    let result = crate::broker_import_json(&config, &path, &account.name, "acct-1").unwrap();
    assert_eq!(result.profile_id, account.profile_id);
    assert_eq!(result.email, account.name);
    let repeated = crate::broker_import_json(&config, &path, &account.name, "acct-1").unwrap();
    assert_eq!(repeated.generation, result.generation);
    let overview = crate::broker_overview(&config).unwrap();
    assert!(overview.unmatched.is_empty());
    assert!(overview.accounts[0].trashed);
    assert!(!overview.accounts[0].remote.as_ref().unwrap().cpa_enabled);
    assert_eq!(
        overview.accounts[0].local.authority,
        crate::AuthAuthority::Broker
    );
    assert!(!overview.accounts[0].local.auto_refresh);
    assert!(!local
        .path()
        .join(".notrace-oauth")
        .join(&account.profile_id)
        .join("auth.json")
        .exists());
    assert_eq!(fs::read_to_string(path).unwrap(), original);
    assert!(crate::refresh_account_auth(&config, &account.name).is_err());
    assert!(store
        .access_credential(&account.profile_id)
        .unwrap()
        .refresh_token
        .is_empty());
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("synthetic-import-refresh"));
    let paths = server.join().unwrap();
    assert!(paths
        .iter()
        .all(|path| !path.ends_with("/cpa") && !path.ends_with("/refresh")));
}

#[test]
fn desktop_file_import_rejects_identity_mismatch_before_any_state_change() {
    let local = tempfile::tempdir().unwrap();
    let config = crate::CloakConfig {
        repo_root: local.path().into(),
        account_base: local.path().join("Accounts"),
        extension_source: local.path().join("extension"),
        cloakbrowser_root: local.path().join("browser"),
    };
    let account = crate::create_account(&config, "alpha@example.test").unwrap();
    let mut value: Value = serde_json::from_str(&grant_body(
        &account.name,
        "acct-1",
        "synthetic-refresh",
        now() + 3600,
    ))
    .unwrap();
    value["tokens"]["id_token"] = Value::String(jwt(
        json!({"email": "wrong@example.test", "https://api.openai.com/auth": {"chatgpt_account_id": "acct-1"}}),
    ));
    let path = local.path().join("import.json");
    fs::write(&path, value.to_string()).unwrap();
    assert!(crate::broker_import_json(&config, &path, "wrong@example.test", "acct-1").is_err());
    assert!(!local.path().join(".notrace-oauth").exists());
    let expiry = grant_body(&account.name, "acct-1", "synthetic-refresh", now() - 1);
    fs::write(&path, expiry).unwrap();
    assert!(crate::broker_import_json(&config, &path, &account.name, "acct-1").is_err());
    assert!(!local.path().join(".notrace-oauth").exists());
}

#[test]
fn export_projection_preserves_refresh_token_only_when_requested() {
    let (_dir, store) = store();
    store
        .import_grant(
            "alpha@example.test",
            &grant_body(
                "alpha@example.test",
                "acct-1",
                "secret-refresh",
                now() + 3600,
            ),
        )
        .unwrap();
    assert!(store
        .export_credential("alpha@example.test", false)
        .unwrap()
        .refresh_token
        .is_empty());
    assert_eq!(
        store
            .export_credential("alpha@example.test", true)
            .unwrap()
            .refresh_token,
        "secret-refresh"
    );
}

#[test]
fn quota_snapshot_reads_usage_without_refreshing_or_writing_cpa() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let provider = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 4096];
        let bytes = stream.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..bytes]);
        assert!(request.starts_with("GET /usage HTTP/1.1"));
        assert!(request.to_ascii_lowercase().contains("authorization: bearer "));
        assert!(request.to_ascii_lowercase().contains("originator: codex desktop"));
        let body = json!({
            "rate_limit": {
                "primary_window": {"used_percent": 25, "limit_window_seconds": 18000, "reset_at": now() + 3600},
                "secondary_window": {"used_percent": 60, "limit_window_seconds": 604800, "reset_after_seconds": 7200}
            },
            "rate_limit_reset_credits": {"available_count": 2}
        }).to_string();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let config = BrokerConfig {
        root: dir.path().into(),
        cpa_auth_dir: None,
        proxy_url: None,
        token_url: format!("http://{address}"),
    };
    let store = BrokerStore::new(config, [21; 32]).unwrap();
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "refresh-a", now() + 3600),
        )
        .unwrap();
    let snapshot = store.quota_snapshot("alpha").unwrap();
    assert_eq!(snapshot.windows.len(), 2);
    assert_eq!(snapshot.windows[0].remaining_percent, Some(75.0));
    assert_eq!(snapshot.windows[0].window_minutes, Some(300));
    assert_eq!(snapshot.windows[1].remaining_percent, Some(40.0));
    assert_eq!(snapshot.windows[1].window_minutes, Some(10080));
    assert_eq!(snapshot.reset_count, Some(2));
    assert!(snapshot.reset_count_available);
    assert_eq!(store.list().unwrap()[0].refresh_count, 0);
    provider.join().unwrap();
}

#[test]
fn quota_snapshot_counts_available_reset_credit_details_when_count_is_omitted() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let provider = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 4096];
        let bytes = stream.read(&mut request).unwrap();
        assert!(String::from_utf8_lossy(&request[..bytes]).starts_with("GET /usage HTTP/1.1"));
        let body = json!({
            "rate_limit": {},
            "rate_limit_reset_credits": {"credits": [
                {"status": "available"},
                {"status": "redeemed"},
                {"status": "available", "expires_at": now() - 1}
            ]}
        }).to_string();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let store = BrokerStore::new(BrokerConfig {
        root: dir.path().into(), cpa_auth_dir: None, proxy_url: None,
        token_url: format!("http://{address}"),
    }, [23; 32]).unwrap();
    store.import_grant("alpha", &grant_body("alpha@example.test", "acct-1", "refresh-a", now() + 3600)).unwrap();
    let snapshot = store.quota_snapshot("alpha").unwrap();
    assert_eq!(snapshot.reset_count, Some(1));
    assert!(snapshot.reset_count_available);
    provider.join().unwrap();
}

#[test]
fn terminal_grant_cannot_be_reenabled_for_cpa_until_reauthorization() {
    let dir = tempfile::tempdir().unwrap();
    let cpa = tempfile::tempdir().unwrap();
    let store = BrokerStore::new(
        BrokerConfig {
            root: dir.path().into(),
            cpa_auth_dir: Some(cpa.path().into()),
            proxy_url: None,
            token_url: TOKEN_URL.into(),
        },
        [22; 32],
    )
    .unwrap();
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "refresh-a", now() + 3600),
        )
        .unwrap();
    let path = store.path("alpha").unwrap();
    let mut grant = store.load(&path).unwrap();
    grant.error = Some(BrokerError::ReauthRequired);
    grant.cpa_enabled = false;
    store.save(&path, &grant).unwrap();
    assert!(matches!(
        store.set_cpa_enabled("alpha", true),
        Err(BrokerError::ReauthRequired)
    ));
    assert!(!store.list().unwrap()[0].cpa_enabled);
}

#[test]
fn repeated_handoff_is_idempotent_and_identity_change_is_rejected() {
    let (_dir, store) = store();
    let first = grant_body("alpha@example.test", "acct-1", "refresh-a", now() + 3600);
    let first_status = store.import_grant("alpha@example.test", &first).unwrap();
    let retry = store.import_grant("alpha@example.test", &first).unwrap();
    assert_eq!(first_status.generation, retry.generation);
    assert_eq!(first_status.refresh_count, retry.refresh_count);
    assert_eq!(
        first_status.automatic_refresh_count,
        retry.automatic_refresh_count
    );
    let wrong = grant_body("other@example.test", "acct-2", "refresh-b", now() + 3600);
    assert!(matches!(
        store.import_grant("alpha@example.test", &wrong),
        Err(BrokerError::IdentityMismatch)
    ));
}

#[test]
fn refresh_rotates_and_preserves_omitted_refresh_token() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 2048];
        let _ = stream.read(&mut request);
        let access = jwt(json!({
            "exp": now() + 7200,
            "https://api.openai.com/profile": {"email":"alpha@example.test"},
            "https://api.openai.com/auth": {"chatgpt_account_id":"acct-1"}
        }));
        let id = jwt(
            json!({"email":"alpha@example.test","https://api.openai.com/auth":{"chatgpt_account_id":"acct-1"}}),
        );
        let body = json!({"access_token":access,"id_token":id}).to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let config = BrokerConfig {
        root: dir.path().into(),
        cpa_auth_dir: None,
        proxy_url: None,
        token_url: format!("http://{address}"),
    };
    let store = BrokerStore::new(config, [8; 32]).unwrap();
    store
        .import_grant(
            "alpha@example.test",
            &grant_body("alpha@example.test", "acct-1", "refresh-a", now() + 60),
        )
        .unwrap();
    let metadata = store.refresh("alpha@example.test", true).unwrap();
    assert_eq!(metadata.generation, 2);
    assert_eq!(metadata.refresh_count, 1);
    assert_eq!(metadata.automatic_refresh_count, 0);
    assert_eq!(
        store
            .access_credential("alpha@example.test")
            .unwrap()
            .refresh_token,
        ""
    );
}

#[test]
fn ambiguous_refresh_is_journaled_and_does_not_retry_old_token() {
    let (_dir, store) = store();
    let body = grant_body("alpha@example.test", "acct-1", "refresh-a", now() + 60);
    store.import_grant("alpha@example.test", &body).unwrap();
    let path = store.path("alpha@example.test").unwrap();
    let mut grant = store.load(&path).unwrap();
    grant.in_flight = true;
    store.save(&path, &grant).unwrap();
    assert!(matches!(
        store.refresh("alpha@example.test", true),
        Err(BrokerError::RecoveryRequired)
    ));
    assert_eq!(store.load(&path).unwrap().refresh_count, 0);
}

#[test]
fn cpa_sync_refuses_unmanaged_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let cpa = tempfile::tempdir().unwrap();
    let config = BrokerConfig {
        root: dir.path().into(),
        cpa_auth_dir: Some(cpa.path().into()),
        proxy_url: None,
        token_url: "https://127.0.0.1/unused".into(),
    };
    let store = BrokerStore::new(config, [9; 32]).unwrap();
    let key = "alpha@example.test";
    store
        .import_grant(key, &grant_body(key, "acct-1", "refresh-a", now() + 3600))
        .unwrap();
    store.set_cpa_enabled(key, true).unwrap();
    fs::write(
        cpa.path().join(format!("notrace_{}.json", hash_key(key))),
        json!({"refresh_token":"old"}).to_string(),
    )
    .unwrap();
    let metadata = store.sync_cpa(key).unwrap();
    assert_eq!(metadata.cpa_sync_error, Some(BrokerError::ConsumerConflict));
}

#[cfg(unix)]
#[test]
fn cpa_sync_skips_unreadable_unrelated_files() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let cpa = tempfile::tempdir().unwrap();
    let config = BrokerConfig {
        root: dir.path().into(),
        cpa_auth_dir: Some(cpa.path().into()),
        proxy_url: None,
        token_url: "https://127.0.0.1/unused".into(),
    };
    let store = BrokerStore::new(config, [15; 32]).unwrap();
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "refresh-a", now() + 3600),
        )
        .unwrap();
    store.set_cpa_enabled("alpha", true).unwrap();
    let unrelated = cpa.path().join("manual-other@example.test.json");
    fs::write(&unrelated, "{\"type\":\"codex\"}").unwrap();
    fs::set_permissions(&unrelated, fs::Permissions::from_mode(0o000)).unwrap();

    let metadata = store.sync_cpa("alpha").unwrap();

    assert_eq!(metadata.cpa_sync_error, None);
    assert!(cpa.path().join("alpha@example.test.json").exists());
}

#[cfg(unix)]
#[test]
fn cpa_projection_write_preserves_external_directory_permissions() {
    let dir = tempfile::tempdir().unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o750)).unwrap();
    let destination = dir.path().join("notrace_projection.json");
    write_cpa_projection_atomic(&destination, "{\"access_token\":\"only\"}").unwrap();
    assert_eq!(
        fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
        0o750
    );
    assert_eq!(
        fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::read_to_string(destination).unwrap(),
        "{\"access_token\":\"only\"}\n"
    );
}

fn now() -> u64 {
    crate::current_epoch_secs()
}

#[test]
fn old_handoff_retry_cannot_replace_a_rotated_grant() {
    let (_dir, store) = store();
    let body = grant_body("alpha@example.test", "acct-1", "initial", now() + 3600);
    store.import_grant("alpha", &body).unwrap();
    let path = store.path("alpha").unwrap();
    let mut rotated = store.load(&path).unwrap();
    rotated.refresh_token = "rotated".into();
    rotated.generation = 2;
    store.save(&path, &rotated).unwrap();
    let metadata = store.import_grant("alpha", &body).unwrap();
    assert_eq!(metadata.generation, 2);
    assert_eq!(store.load(&path).unwrap().refresh_token, "rotated");
}

#[test]
fn reauthorization_preserves_refresh_count_without_incrementing_it() {
    let (_dir, store) = store();
    let first = grant_body("alpha@example.test", "acct-1", "initial", now() + 3600);
    store.import_grant("alpha", &first).unwrap();
    let path = store.path("alpha").unwrap();
    let mut current = store.load(&path).unwrap();
    current.refresh_count = 4;
    current.automatic_refresh_count = 3;
    store.save(&path, &current).unwrap();
    let replacement = grant_body("alpha@example.test", "acct-1", "replacement", now() + 3600);
    let metadata = store.import_grant("alpha", &replacement).unwrap();
    assert_eq!(metadata.generation, 2);
    assert_eq!(metadata.refresh_count, 4);
    assert_eq!(metadata.automatic_refresh_count, 3);
}

#[test]
fn reauthorization_waits_for_explicit_cpa_sync() {
    let dir = tempfile::tempdir().unwrap();
    let cpa = tempfile::tempdir().unwrap();
    let store = BrokerStore::new(
        BrokerConfig {
            root: dir.path().into(),
            cpa_auth_dir: Some(cpa.path().into()),
            proxy_url: None,
            token_url: "https://127.0.0.1/unused".into(),
        },
        [19; 32],
    )
    .unwrap();
    let initial = grant_body("alpha@example.test", "acct-1", "initial", now() + 3600);
    store.import_grant("alpha", &initial).unwrap();
    store.set_cpa_enabled("alpha", true).unwrap();
    store.sync_cpa("alpha").unwrap();
    let destination = cpa.path().join("alpha@example.test.json");
    let original = fs::read(&destination).unwrap();

    let replacement = grant_body("alpha@example.test", "acct-1", "replacement", now() + 7200);
    let metadata = store.import_grant("alpha", &replacement).unwrap();
    assert!(!metadata.cpa_enabled);
    assert_eq!(metadata.cpa_synced_generation, Some(1));
    assert_eq!(metadata.generation, 2);
    store.run_cycle().unwrap();
    assert_eq!(fs::read(&destination).unwrap(), original);

    store.set_cpa_enabled("alpha", true).unwrap();
    let synced = store.sync_cpa("alpha").unwrap();
    assert_eq!(synced.cpa_synced_generation, Some(2));
    let projection: Value = serde_json::from_slice(&fs::read(&destination).unwrap()).unwrap();
    assert_eq!(projection["notrace_generation"], 2);
    assert_eq!(projection["refresh_token"], "");
    assert_ne!(fs::read(&destination).unwrap(), original);

    // A lost handoff response retried after synchronization must not pause it again.
    let retry = store.import_grant("alpha", &replacement).unwrap();
    assert!(retry.cpa_enabled);
    assert_eq!(retry.cpa_synced_generation, Some(2));
}

#[test]
fn durable_pending_rotation_is_recovered_without_an_oauth_request() {
    let (_dir, store) = store();
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    let path = store.path("alpha").unwrap();
    let mut current = store.load(&path).unwrap();
    current.in_flight = true;
    store.save(&path, &current).unwrap();
    let mut candidate = current.clone();
    candidate.refresh_token = "newest".into();
    candidate.generation = 2;
    candidate.refresh_count = 1;
    candidate.automatic_refresh_count = 1;
    candidate.in_flight = false;
    store
        .save(&path.with_extension("pending"), &candidate)
        .unwrap();
    let recovered = store.refresh("alpha", true).unwrap();
    assert_eq!(recovered.generation, 2);
    assert_eq!(recovered.refresh_count, 1);
    assert_eq!(recovered.automatic_refresh_count, 1);
    assert_eq!(store.load(&path).unwrap().refresh_token, "newest");
    assert!(!path.with_extension("pending").exists());
    let reopened = BrokerStore::new(store.config.clone(), [7; 32]).unwrap();
    let unchanged = reopened.refresh("alpha", false).unwrap();
    assert_eq!(unchanged.refresh_count, 1);
    assert_eq!(unchanged.automatic_refresh_count, 1);
}

#[test]
fn automatic_renewal_is_counted_once_and_failed_or_skipped_requests_are_not() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let provider = thread::spawn(move || {
        for status in [200, 503] {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request);
            let body = if status == 200 {
                json!({"access_token":jwt(json!({
                    "exp":now() + 7200,
                    "https://api.openai.com/profile":{"email":"alpha@example.test"},
                    "https://api.openai.com/auth":{"chatgpt_account_id":"acct-1"}
                })),"refresh_token":"rotated"})
                .to_string()
            } else {
                json!({"error":"temporarily_unavailable"}).to_string()
            };
            stream.write_all(format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n{body}", body.len()
            ).as_bytes()).unwrap();
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let config = BrokerConfig {
        root: dir.path().into(),
        cpa_auth_dir: None,
        proxy_url: None,
        token_url: format!("http://{address}"),
    };
    let store = BrokerStore::new(config.clone(), [8; 32]).unwrap();
    let key = "alpha";
    store
        .import_grant(
            key,
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    let path = store.path(key).unwrap();
    let mut due = store.load(&path).unwrap();
    due.expires_at = now() + 60;
    due.issued_at = now() - 3600;
    store.save(&path, &due).unwrap();
    let automatic = store.refresh(key, false).unwrap();
    assert_eq!(automatic.refresh_count, 1);
    assert_eq!(automatic.automatic_refresh_count, 1);
    assert_eq!(store.refresh(key, false).unwrap().refresh_count, 1);
    assert!(matches!(
        store.refresh(key, true),
        Err(BrokerError::ServiceUnavailable)
    ));
    provider.join().unwrap();
    let reopened = BrokerStore::new(config, [8; 32]).unwrap();
    let metadata = reopened.list().unwrap().pop().unwrap();
    assert_eq!(metadata.refresh_count, 1);
    assert_eq!(metadata.automatic_refresh_count, 1);
}

#[test]
fn legacy_grants_do_not_infer_renewal_counts_from_generation() {
    let mut legacy = serde_json::to_value(
        parse_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap(),
    )
    .unwrap();
    legacy["generation"] = json!(9);
    let object = legacy.as_object_mut().unwrap();
    object.remove("refresh_count");
    object.remove("automatic_refresh_count");
    let grant: Grant = serde_json::from_value(legacy).unwrap();
    assert_eq!(grant.refresh_count, 0);
    assert_eq!(grant.automatic_refresh_count, 0);
}

#[test]
fn short_lived_grants_use_a_proportional_refresh_margin() {
    let (_dir, store) = store();
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "short", now() + 3600),
        )
        .unwrap();
    let meta = store.list().unwrap().pop().unwrap();
    assert!(meta.next_refresh_at > now() + 2800);
    assert!(meta.next_refresh_at < now() + 3000);
}

#[test]
fn cpa_updates_preserve_operator_disabled_state_and_never_write_rt() {
    let dir = tempfile::tempdir().unwrap();
    let cpa = tempfile::tempdir().unwrap();
    let config = BrokerConfig {
        root: dir.path().into(),
        cpa_auth_dir: Some(cpa.path().into()),
        proxy_url: None,
        token_url: TOKEN_URL.into(),
    };
    let store = BrokerStore::new(config, [10; 32]).unwrap();
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    store.set_cpa_enabled("alpha", true).unwrap();
    let metadata = store.sync_cpa("alpha").unwrap();
    assert_eq!(metadata.cpa_synced_generation, Some(1));
    let destination = cpa.path().join("alpha@example.test.json");
    let mut projection: Value =
        serde_json::from_str(&fs::read_to_string(&destination).unwrap()).unwrap();
    projection["disabled"] = json!(true);
    fs::write(&destination, projection.to_string()).unwrap();
    let path = store.path("alpha").unwrap();
    let mut grant = store.load(&path).unwrap();
    grant.generation = 2;
    store.save(&path, &grant).unwrap();
    store.sync_cpa("alpha").unwrap();
    let projection: Value =
        serde_json::from_str(&fs::read_to_string(destination).unwrap()).unwrap();
    assert_eq!(projection["disabled"], true);
    assert_eq!(projection["refresh_token"], "");
    assert_eq!(projection["notrace_generation"], 2);
}

#[test]
fn cpa_sync_renames_existing_managed_hash_file_to_email_name() {
    let dir = tempfile::tempdir().unwrap();
    let cpa = tempfile::tempdir().unwrap();
    let config = BrokerConfig {
        root: dir.path().into(),
        cpa_auth_dir: Some(cpa.path().into()),
        proxy_url: None,
        token_url: TOKEN_URL.into(),
    };
    let store = BrokerStore::new(config, [13; 32]).unwrap();
    let key = "alpha";
    store
        .import_grant(
            key,
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    store.set_cpa_enabled(key, true).unwrap();
    store.sync_cpa(key).unwrap();
    let email_path = cpa.path().join("alpha@example.test.json");
    let legacy_path = cpa.path().join(format!("notrace_{}.json", hash_key(key)));
    fs::rename(&email_path, &legacy_path).unwrap();

    let metadata = store.sync_cpa(key).unwrap();

    assert_eq!(metadata.cpa_synced_generation, Some(1));
    assert!(email_path.exists());
    assert!(!legacy_path.exists());
}

#[test]
fn cpa_sync_refuses_duplicate_same_identity_with_unmanaged_filename() {
    let dir = tempfile::tempdir().unwrap();
    let cpa = tempfile::tempdir().unwrap();
    let config = BrokerConfig {
        root: dir.path().into(),
        cpa_auth_dir: Some(cpa.path().into()),
        proxy_url: None,
        token_url: TOKEN_URL.into(),
    };
    let store = BrokerStore::new(config, [12; 32]).unwrap();
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    store.set_cpa_enabled("alpha", true).unwrap();
    fs::write(
        cpa.path().join("old-cpa-name.json"),
        json!({"email":"alpha@example.test","account_id":"acct-1","refresh_token":"old"})
            .to_string(),
    )
    .unwrap();
    let metadata = store.sync_cpa("alpha").unwrap();
    assert_eq!(metadata.cpa_sync_error, Some(BrokerError::ConsumerConflict));
    assert!(!cpa
        .path()
        .join(format!("notrace_{}.json", hash_key("alpha")))
        .exists());
}

#[test]
fn scheduled_cycle_recovers_a_durable_rotation_without_reusing_the_token() {
    let (_dir, store) = store();
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    let path = store.path("alpha").unwrap();
    let mut current = store.load(&path).unwrap();
    current.in_flight = true;
    store.save(&path, &current).unwrap();
    let mut candidate = current.clone();
    candidate.refresh_token = "rotated".into();
    candidate.generation += 1;
    candidate.refresh_count = 1;
    candidate.in_flight = false;
    store
        .save(&path.with_extension("pending"), &candidate)
        .unwrap();

    store.run_cycle().unwrap();

    let recovered = store.load(&path).unwrap();
    assert_eq!(recovered.generation, 2);
    assert_eq!(recovered.refresh_count, 1);
    assert_eq!(recovered.refresh_token, "rotated");
    assert!(!path.with_extension("pending").exists());
}

#[test]
fn scheduled_cycle_projects_a_recovered_rotation_to_cpa() {
    let (_dir, mut store) = store();
    let cpa = tempfile::tempdir().unwrap();
    store.config.cpa_auth_dir = Some(cpa.path().into());
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    store.set_cpa_enabled("alpha", true).unwrap();
    store.sync_cpa("alpha").unwrap();
    let path = store.path("alpha").unwrap();
    let mut current = store.load(&path).unwrap();
    current.in_flight = true;
    store.save(&path, &current).unwrap();
    let mut candidate = current.clone();
    candidate.access_token = jwt(json!({
        "exp": now() + 7200,
        "https://api.openai.com/profile": {"email": "alpha@example.test"},
        "https://api.openai.com/auth": {"chatgpt_account_id": "acct-1"}
    }));
    candidate.refresh_token = "rotated".into();
    candidate.generation += 1;
    candidate.refresh_count = 1;
    candidate.in_flight = false;
    store
        .save(&path.with_extension("pending"), &candidate)
        .unwrap();

    store.run_cycle().unwrap();

    let projection: Value = serde_json::from_str(
        &fs::read_to_string(cpa.path().join("alpha@example.test.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(projection["notrace_generation"], 2);
    assert_eq!(projection["access_token"], candidate.access_token);
    assert!(projection["refresh_token"].as_str().unwrap().is_empty());
}

#[test]
fn scheduled_cycle_keeps_healthy_accounts_running_after_storage_damage() {
    let (_dir, store) = store();
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    let path = store.path("alpha").unwrap();
    let mut candidate = store.load(&path).unwrap();
    candidate.generation += 1;
    candidate.refresh_token = "rotated".into();
    store
        .save(&path.with_extension("pending"), &candidate)
        .unwrap();
    fs::write(store.path("damaged").unwrap(), "damaged encrypted grant").unwrap();

    assert!(matches!(store.run_cycle(), Err(BrokerError::Storage)));

    assert_eq!(store.load(&path).unwrap().generation, 2);
    assert!(!path.with_extension("pending").exists());
}

#[test]
fn scheduled_cycle_does_not_rewrite_unchanged_cpa_credentials() {
    let (_dir, mut store) = store();
    let cpa = tempfile::tempdir().unwrap();
    store.config.cpa_auth_dir = Some(cpa.path().into());
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    store.set_cpa_enabled("alpha", true).unwrap();
    store.sync_cpa("alpha").unwrap();
    let grant_path = store.path("alpha").unwrap();
    let destination = cpa.path().join("alpha@example.test.json");
    let original_grant = fs::read(&grant_path).unwrap();
    let before = fs::metadata(&destination).unwrap().modified().unwrap();
    thread::sleep(Duration::from_millis(20));

    store.run_cycle().unwrap();

    assert_eq!(
        fs::metadata(&destination).unwrap().modified().unwrap(),
        before
    );
    assert_eq!(fs::read(&grant_path).unwrap(), original_grant);
    fs::remove_file(&destination).unwrap();
    store.run_cycle().unwrap();
    assert!(destination.exists());
}

#[test]
fn cpa_sync_preserves_malformed_reserved_files() {
    let (_dir, mut store) = store();
    let cpa = tempfile::tempdir().unwrap();
    store.config.cpa_auth_dir = Some(cpa.path().into());
    store
        .import_grant(
            "alpha",
            &grant_body("alpha@example.test", "acct-1", "initial", now() + 3600),
        )
        .unwrap();
    store.set_cpa_enabled("alpha", true).unwrap();
    let destination = cpa.path().join("alpha@example.test.json");
    fs::write(&destination, "incomplete CPA file").unwrap();

    let metadata = store.sync_cpa("alpha").unwrap();

    assert_eq!(metadata.cpa_sync_error, Some(BrokerError::ConsumerConflict));
    assert_eq!(
        fs::read_to_string(destination).unwrap(),
        "incomplete CPA file"
    );
}
