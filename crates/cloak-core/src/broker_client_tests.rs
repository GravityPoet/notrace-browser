use super::*;
use std::{
    io::{BufRead, BufReader},
    sync::mpsc,
    time::Instant,
};

fn credential() -> Value {
    json!({
        "type": "codex", "access_token": "fixture_value_a", "id_token": "fixture_value_b",
        "refresh_token": "", "account_id": "synthetic-account", "email": "synthetic@example.test",
        "expired": "2030-03-17T00:00:00Z", "expires_at": crate::current_epoch_secs() + 7200,
        "last_refresh": "2026-10-14T00:00:00Z", "plan_type": "plus",
        "refresh_owner": "notrace_broker", "notrace_key": "synthetic-profile", "notrace_generation": 8
    })
}

fn metadata(credential: &Value) -> Value {
    json!({
        "key": "synthetic-profile", "account_id": "synthetic-account", "email": "synthetic@example.test",
        "plan_type": "plus", "expires_at": credential["expires_at"], "last_refresh_at": crate::current_epoch_secs(),
        "generation": 8, "next_refresh_at": 1900000000, "next_retry_at": null, "error": null,
        "cpa_enabled": false, "cpa_synced_generation": null, "cpa_sync_error": null, "cockpit_synced_generation": null
    })
}

fn broker_fixture(
    replies: Vec<(u16, Value)>,
) -> (
    tempfile::TempDir,
    CloakConfig,
    thread::JoinHandle<Vec<String>>,
) {
    let dir = tempfile::tempdir().unwrap();
    let config = CloakConfig {
        repo_root: dir.path().into(),
        account_base: dir.path().join("accounts"),
        extension_source: dir.path().join("extension"),
        cloakbrowser_root: dir.path().join("browser"),
    };
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    crate::write_secret_atomic(
        &connection_path(&config),
        &json!({"endpoint": endpoint, "admin_key": "synthetic-test-key-0000000000000000"})
            .to_string(),
    )
    .unwrap();
    let task = thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, reply) in replies {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(
                    Instant::now() < deadline,
                    "synthetic Broker request did not arrive"
                );
                thread::sleep(Duration::from_millis(5));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            requests.push(first.trim().to_string());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            reader.read_exact(&mut vec![0; length]).unwrap();
            drop(reader);
            let body = reply.to_string();
            write!(stream, "HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    });
    (dir, config, task)
}

fn import_url(link: &str) -> String {
    let link = url::Url::parse(link).unwrap();
    assert_eq!(link.scheme(), "cockpit-tools");
    assert_eq!(link.host_str(), Some("import"));
    assert!(link
        .query_pairs()
        .any(|(k, v)| k == "provider" && v == "codex"));
    assert!(link
        .query_pairs()
        .any(|(k, v)| k == "auto_import" && v == "true"));
    assert!(!link
        .query_pairs()
        .any(|(k, _)| k == "token" || k == "payload" || k == "activate"));
    link.query_pairs()
        .find(|(k, _)| k == "import_url")
        .unwrap()
        .1
        .into_owned()
}

#[test]
fn cockpit_import_reads_current_access_without_refreshing_broker_and_returns_metadata() {
    let credential = credential();
    let (_dir, config, broker) = broker_fixture(vec![
        (200, json!([metadata(&credential)])),
        (200, credential),
    ]);
    let (tx, rx) = mpsc::channel();
    let receiver = thread::spawn(move || {
        let url: String = rx.recv().unwrap();
        let response = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap()
            .get(url)
            .send()
            .unwrap();
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        response.json::<Value>().unwrap()
    });
    let summary = import_cockpit_access(
        &config,
        "synthetic-profile",
        Duration::from_secs(3),
        |link| {
            tx.send(import_url(link)).unwrap();
            Ok(())
        },
    )
    .unwrap();
    let payload = receiver.join().unwrap();
    assert_eq!(payload[0]["access_token"], "fixture_value_a");
    assert_eq!(payload[0]["refresh_token"], "");
    assert_eq!(payload[0]["refresh_owner"], "notrace_broker");
    assert_eq!(payload.as_array().unwrap().len(), 1);
    assert_eq!(summary.generation, 8);
    assert!(summary.handed_off);
    assert!(!serde_json::to_string(&summary)
        .unwrap()
        .contains("fixture_value_a"));
    assert_eq!(
        broker.join().unwrap(),
        vec![
            "GET /v1/admin/accounts HTTP/1.1",
            "GET /v1/admin/accounts/synthetic-profile/credential HTTP/1.1",
        ]
    );
    assert_eq!(
        fs::read_dir(config.repo_root).unwrap().count(),
        1,
        "no credential export file may remain"
    );
}

#[test]
fn cockpit_invalidated_or_recovery_grant_never_reads_credentials_or_opens_app() {
    for state in ["reauth_required", "recovery_required"] {
        let mut metadata = metadata(&credential());
        metadata["error"] = json!(state);
        let (_dir, config, broker) = broker_fixture(vec![(200, json!([metadata]))]);
        let error =
            import_cockpit_access(&config, "synthetic-profile", Duration::from_secs(1), |_| {
                panic!("must not open Cockpit")
            });
        assert!(error.err().unwrap().to_string().contains("重新授权"));
        assert_eq!(
            broker.join().unwrap(),
            vec!["GET /v1/admin/accounts HTTP/1.1"]
        );
    }
}

#[test]
fn cockpit_rejects_mismatched_expired_or_refresh_capable_projection() {
    for (field, value) in [
        ("notrace_key", json!("another-profile")),
        ("notrace_generation", json!(7)),
        ("email", json!("other@example.test")),
        ("account_id", json!("other-account")),
        ("expires_at", json!(1)),
        ("access_token", json!("")),
        ("id_token", json!("")),
        ("refresh_owner", json!("cockpit")),
        ("refresh_token", json!("fixture_forbidden_value")),
    ] {
        let mut projection = credential();
        let metadata = metadata(&projection);
        projection[field] = value;
        let (_dir, config, broker) =
            broker_fixture(vec![(200, json!([metadata])), (200, projection)]);
        assert!(
            import_cockpit_access(
                &config,
                "synthetic-profile",
                Duration::from_secs(1),
                |_| panic!("must not open Cockpit")
            )
            .is_err(),
            "invalid field {field}"
        );
        assert_eq!(broker.join().unwrap().len(), 2);
    }
}

#[test]
fn cockpit_import_link_expires_and_opener_failure_closes_listener() {
    for failed_open in [false, true] {
        let mut url = String::new();
        let start = Instant::now();
        let result = serve_cockpit_import(
            Zeroizing::new(b"[]".to_vec()),
            Duration::from_millis(60),
            |link| {
                url = import_url(link);
                if failed_open {
                    Err(CloakError::Auth("synthetic opener failure".into()))
                } else {
                    Ok(())
                }
            },
        );
        if failed_open {
            assert!(result.is_err());
        } else {
            assert!(!result.unwrap());
        }
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap()
            .get(url)
            .send()
            .is_err());
    }
}

#[test]
fn cockpit_loopback_rejects_wrong_path_origin_host_and_method_then_is_single_use() {
    let (tx, rx) = mpsc::channel();
    let receiver = thread::spawn(move || {
        let url: String = rx.recv().unwrap();
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(
            client.get(format!("{url}-wrong")).send().unwrap().status(),
            404
        );
        assert_eq!(
            client
                .get(&url)
                .header("Origin", "https://example.test")
                .send()
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            client
                .get(&url)
                .header("Host", "example.test")
                .send()
                .unwrap()
                .status(),
            404
        );
        assert_eq!(client.post(&url).send().unwrap().status(), 404);
        assert_eq!(client.get(&url).send().unwrap().text().unwrap(), "[{}]");
        url
    });
    assert!(serve_cockpit_import(
        Zeroizing::new(b"[{}]".to_vec()),
        Duration::from_secs(3),
        |link| {
            tx.send(import_url(link)).unwrap();
            Ok(())
        }
    )
    .unwrap());
    let url = receiver.join().unwrap();
    assert!(Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap()
        .get(url)
        .send()
        .is_err());
}
