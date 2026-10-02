use anyhow::{Context, Result};
use clap::Parser;
use cloak_core::{BrokerError, BrokerStore};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use std::{io::Read, net::SocketAddr, sync::Arc, time::Duration};
use tiny_http::{Header, Request, Response, Server};

const MAX_BODY: usize = 256 * 1024;
#[derive(Parser)]
#[command(name = "notrace-broker", version)]
struct Args {
    #[arg(long, env = "NOTRACE_BROKER_BIND", default_value = "127.0.0.1:18455")]
    bind: SocketAddr,
}
struct Keys {
    admin: String,
    cpa: String,
    cockpit: String,
}
impl Keys {
    fn from_env() -> Result<Self> {
        let keys = Self {
            admin: read_key("NOTRACE_BROKER_ADMIN_KEY")?,
            cpa: read_key("NOTRACE_BROKER_CPA_KEY")?,
            cockpit: read_key("NOTRACE_BROKER_COCKPIT_KEY")?,
        };
        if keys.admin == keys.cpa || keys.admin == keys.cockpit || keys.cpa == keys.cockpit {
            anyhow::bail!("service keys must be distinct");
        }
        Ok(keys)
    }
}
fn read_key(name: &str) -> Result<String> {
    let v = std::env::var(name).with_context(|| format!("missing {name}"))?;
    if v.len() < 32 || !v.bytes().all(|b| b.is_ascii_graphic()) {
        anyhow::bail!("invalid service key configuration");
    }
    Ok(v)
}
fn main() -> Result<()> {
    let args = Args::parse();
    if !args.bind.ip().is_loopback() {
        anyhow::bail!("plain HTTP must bind to loopback; use SSH tunneling or a TLS reverse proxy");
    }
    let store = BrokerStore::from_env()?;
    let keys = Arc::new(Keys::from_env()?);
    let server = Arc::new(
        Server::http(args.bind).map_err(|_| anyhow::anyhow!("cannot bind Broker listener"))?,
    );
    let schedule_store = store.clone();
    let cycle_seconds = cycle_seconds();
    std::thread::spawn(move || loop {
        if schedule_store.run_cycle().is_err() {
            eprintln!("Broker scan encountered a storage error");
        }
        std::thread::sleep(Duration::from_secs(cycle_seconds));
    });
    eprintln!("NoTrace Broker listening on {}", server.server_addr());
    // Bound worker count: neither requests nor OAuth calls create unlimited threads.
    let mut workers = Vec::new();
    for _ in 0..4 {
        let server = Arc::clone(&server);
        let keys = Arc::clone(&keys);
        let store = store.clone();
        workers.push(std::thread::spawn(move || {
            for request in server.incoming_requests() {
                handle(request, &store, &keys);
            }
        }));
    }
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

fn cycle_seconds() -> u64 {
    std::env::var("NOTRACE_BROKER_CYCLE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (15..=86_400).contains(value))
        .unwrap_or(60)
}
fn handle(mut request: Request, store: &BrokerStore, keys: &Keys) {
    let method = request.method().as_str().to_string();
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("");
    if method == "GET" && path == "/healthz" {
        respond(request, 200, json!({"ok":true,"api_version":1}));
        return;
    }
    let supplied = request
        .headers()
        .iter()
        .filter(|h| h.field.equiv("Authorization"))
        .collect::<Vec<_>>();
    if supplied.len() != 1 {
        respond(request, 401, json!({"error":"authorization required"}));
        return;
    }
    let Some(bearer) = supplied[0].value.as_str().strip_prefix("Bearer ") else {
        respond(request, 401, json!({"error":"authorization required"}));
        return;
    };
    let admin = path.starts_with("/v1/admin/");
    let consumer = path
        .strip_prefix("/v1/consumers/")
        .and_then(|r| r.split('/').next());
    let expected = match consumer {
        Some("cpa") => &keys.cpa,
        Some("cockpit") => &keys.cockpit,
        _ if admin => &keys.admin,
        _ => {
            respond(request, 404, json!({"error":"not found"}));
            return;
        }
    };
    if !constant_eq(bearer, expected) {
        respond(request, 403, json!({"error":"forbidden"}));
        return;
    }
    if request.headers().iter().any(|h| h.field.equiv("Origin")) {
        respond(
            request,
            403,
            json!({"error":"browser-origin requests are not supported"}),
        );
        return;
    }
    if request.body_length().is_some_and(|n| n > MAX_BODY) {
        respond(request, 413, json!({"error":"input too large"}));
        return;
    }
    let mut body = Vec::new();
    if request
        .as_reader()
        .take((MAX_BODY + 1) as u64)
        .read_to_end(&mut body)
        .is_err()
        || body.len() > MAX_BODY
    {
        respond(request, 400, json!({"error":"invalid request body"}));
        return;
    }
    let result = route(&method, &url, &body, store);
    match result {
        Ok(value) => respond(request, 200, value),
        Err(error) => {
            let status = match error {
                BrokerError::AccountMissing => 404,
                BrokerError::Busy => 423,
                BrokerError::Config
                | BrokerError::InvalidGrant
                | BrokerError::IdentityMismatch
                | BrokerError::InputTooLarge => 400,
                BrokerError::ReauthRequired
                | BrokerError::RecoveryRequired
                | BrokerError::ConsumerConflict => 409,
                _ => 503,
            };
            respond(
                request,
                status,
                json!({"error":error,"message":error.to_string()}),
            );
        }
    }
}
fn route(
    method: &str,
    url: &str,
    body: &[u8],
    store: &BrokerStore,
) -> std::result::Result<Value, BrokerError> {
    let path = url.split('?').next().unwrap_or("");
    if method == "GET" && path == "/v1/admin/accounts" {
        return serde_json::to_value(store.list()?).map_err(|_| BrokerError::Storage);
    }
    if let Some(rest) = path.strip_prefix("/v1/admin/accounts/") {
        let (encoded, action) = rest.rsplit_once('/').ok_or(BrokerError::Config)?;
        if encoded.contains('/') {
            return Err(BrokerError::Config);
        }
        let key = percent_decode_str(encoded)
            .decode_utf8()
            .map_err(|_| BrokerError::Config)?;
        if method == "GET" && action == "credential" {
            let _ = store.refresh(&key, false);
            let include_refresh_token = url.split('?').nth(1).is_some_and(|query| {
                query
                    .split('&')
                    .any(|item| item == "include_refresh_token=1")
            });
            return serde_json::to_value(store.export_credential(&key, include_refresh_token)?)
                .map_err(|_| BrokerError::Storage);
        }
        let metadata = match (method, action) {
            ("POST", "grant") => store.import_grant(
                &key,
                std::str::from_utf8(body).map_err(|_| BrokerError::InvalidGrant)?,
            )?,
            ("POST", "refresh") => {
                let force = url
                    .split('?')
                    .nth(1)
                    .is_some_and(|q| q.split('&').any(|v| v == "force=1"));
                let value = store.refresh(&key, force)?;
                let _ = store.sync_cpa(&key);
                value
            }
            ("POST", "cpa") => {
                let settings: Value =
                    serde_json::from_slice(body).map_err(|_| BrokerError::Config)?;
                let enabled = settings
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or(BrokerError::Config)?;
                store.set_cpa_enabled(&key, enabled)?;
                store.sync_cpa(&key)?
            }
            _ => return Err(BrokerError::AccountMissing),
        };
        return serde_json::to_value(metadata).map_err(|_| BrokerError::Storage);
    }
    if let Some(rest) = path.strip_prefix("/v1/consumers/") {
        let parts = rest.split('/').collect::<Vec<_>>();
        if parts.len() != 4 || parts[1] != "accounts" {
            return Err(BrokerError::AccountMissing);
        }
        let key = percent_decode_str(parts[2])
            .decode_utf8()
            .map_err(|_| BrokerError::Config)?;
        if method == "GET" && parts[3] == "credential" {
            let _ = store.refresh(&key, false);
            return serde_json::to_value(store.access_credential(&key)?)
                .map_err(|_| BrokerError::Storage);
        }
        if method == "POST" && parts[0] == "cockpit" && parts[3] == "ack" {
            let value: Value = serde_json::from_slice(body).map_err(|_| BrokerError::Config)?;
            let generation = value
                .get("generation")
                .and_then(Value::as_u64)
                .ok_or(BrokerError::Config)?;
            return serde_json::to_value(store.acknowledge_cockpit(&key, generation)?)
                .map_err(|_| BrokerError::Storage);
        }
    }
    Err(BrokerError::AccountMissing)
}
fn constant_eq(a: &str, b: &str) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= usize::from(
            a.as_bytes().get(i).copied().unwrap_or(0) ^ b.as_bytes().get(i).copied().unwrap_or(0),
        );
    }
    diff == 0
}
fn respond(request: Request, status: u16, value: Value) {
    let response = Response::from_string(value.to_string())
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
        .with_header(Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap());
    let _ = request.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bearer_comparison_rejects_prefixes_and_suffixes() {
        assert!(constant_eq("synthetic-key", "synthetic-key"));
        assert!(!constant_eq("synthetic-key", "synthetic-key-more"));
        assert!(!constant_eq("synthetic", "synthetic-key"));
    }

    #[test]
    fn cycle_interval_rejects_invalid_values_without_panicking() {
        std::env::remove_var("NOTRACE_BROKER_CYCLE_SECONDS");
        assert_eq!(cycle_seconds(), 60);
        std::env::set_var("NOTRACE_BROKER_CYCLE_SECONDS", "900");
        assert_eq!(cycle_seconds(), 900);
        std::env::set_var("NOTRACE_BROKER_CYCLE_SECONDS", "5");
        assert_eq!(cycle_seconds(), 60);
        std::env::set_var("NOTRACE_BROKER_CYCLE_SECONDS", "bad");
        assert_eq!(cycle_seconds(), 60);
        std::env::remove_var("NOTRACE_BROKER_CYCLE_SECONDS");
    }
}
