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
fn repeated_handoff_is_idempotent_and_identity_change_is_rejected() {
    let (_dir, store) = store();
    let first = grant_body("alpha@example.test", "acct-1", "refresh-a", now() + 3600);
    let first_status = store.import_grant("alpha@example.test", &first).unwrap();
    let retry = store.import_grant("alpha@example.test", &first).unwrap();
    assert_eq!(first_status.generation, retry.generation);
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
    candidate.in_flight = false;
    store
        .save(&path.with_extension("pending"), &candidate)
        .unwrap();
    assert_eq!(store.refresh("alpha", true).unwrap().generation, 2);
    assert_eq!(store.load(&path).unwrap().refresh_token, "newest");
    assert!(!path.with_extension("pending").exists());
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
    let destination = cpa
        .path()
        .join(format!("notrace_{}.json", hash_key("alpha")));
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
