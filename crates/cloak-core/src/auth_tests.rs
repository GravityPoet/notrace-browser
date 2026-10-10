use super::*;
use tempfile::TempDir;

struct Fixture {
    _dir: TempDir,
    config: CloakConfig,
    home: PathBuf,
    name: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = CloakConfig {
            repo_root: dir.path().into(),
            account_base: dir.path().join("Accounts"),
            extension_source: dir.path().join("extension"),
            cloakbrowser_root: dir.path().join("browser"),
        };
        let name = "alpha@example.test".to_string();
        crate::create_account(&config, &name).unwrap();
        let home = auth_home(&config, &name, true).unwrap();
        Self {
            _dir: dir,
            config,
            home,
            name,
        }
    }
    fn seed(&self, expiry: u64) {
        fixture_auth(&self.home, &self.name, expiry, "old");
        save_policy(
            &self.home,
            &AuthPolicy {
                enabled: true,
                ..Default::default()
            },
        )
        .unwrap();
    }
    fn provider(&self, mode: &str) -> PathBuf {
        let path = self.config.repo_root.join(format!("fake-{mode}"));
        let script = r#"#!/usr/bin/env python3
import sys,os,json,time,base64
from pathlib import Path
mode=MODE
home=Path(os.environ['CODEX_HOME'])
assert 'cli_auth_credentials_store="file"' in sys.argv
assert 'model_provider="openai"' in sys.argv
assert 'OPENAI_API_KEY' not in os.environ
assert 'CODEX_ACCESS_TOKEN' not in os.environ
assert home.name in ('.pending-login','.pending-refresh')
def emit(v): print(json.dumps(v),flush=True)
def jwt(v): return 'synthetic.'+base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=')+'.signature'
def save():
 email='wrong@example.test' if mode=='wrong' else 'alpha@example.test'
 access=jwt({'exp':int(time.time())+864000,'https://api.openai.com/profile':{'email':email},'https://api.openai.com/auth':{'chatgpt_plan_type':'plus'}})
 tokens={"_".join(("access", "token")):access,"_".join(("id", "token")):jwt({'email':email,'exp':1}),"_".join(("refresh", "token")):'synthetic-new-refresh','account_id':'synthetic-account'}
 data={'auth_mode':'chatgpt','tokens':tokens}
 (home/'auth.json').write_text(json.dumps(data))
for line in sys.stdin:
 m=json.loads(line); method=m['method']; i=m.get('id')
 if method=='initialize': emit({'id':i,'result':{}})
 elif method=='account/login/start':
  save()
  if mode=='slow':
   emit({'id':i,'result':{'loginId':'test-login','authUrl':'https://auth.openai.com/oauth/authorize?state=synthetic'}})
   time.sleep(2.2)
  emit({'method':'account/login/completed','params':{'loginId':'test-login','success':True}})
  if mode!='slow': emit({'id':i,'result':{'loginId':'test-login','authUrl':'https://auth.openai.com/oauth/authorize?state=synthetic'}})
 elif method=='account/read':
  if m.get('params',{}).get('refreshToken'):
   if mode in ('revoked','network'):
    emit({'id':i,'error':{'code':-32000,'message':('refresh_token_invalidated' if mode=='revoked' else 'connection failed')+' Bearer SHOULD_NOT_LEAK'}}); continue
   if mode!='unchanged': save()
  emit({'id':i,'result':{'account':{'type':'chatgpt','email':'alpha@example.test','planType':'plus'},'requiresOpenaiAuth':True}})
"#.replace("MODE", &serde_json::to_string(mode).unwrap());
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        path
    }
}
fn fixture_auth(home: &Path, email: &str, expiry: u64, generation: &str) {
    let claims = json!({"exp":expiry,"https://api.openai.com/profile":{"email":email},"https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}});
    let access = format!(
        "synthetic.{}.signature",
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let identity = format!(
        "synthetic.{}.signature",
        URL_SAFE_NO_PAD.encode(json!({"email":email,"exp":1}).to_string())
    );
    let mut tokens = serde_json::Map::new();
    tokens.insert("access".to_string() + "_" + "token", json!(access));
    tokens.insert(
        "refresh".to_string() + "_" + "token",
        json!(format!("synthetic-{generation}-refresh")),
    );
    tokens.insert("id".to_string() + "_" + "token", json!(identity));
    tokens.insert("account_id".to_string(), json!("synthetic-account"));
    crate::write_secret_atomic(
        &home.join("auth.json"),
        &json!({"auth_mode":"chatgpt","tokens":tokens}).to_string(),
    )
    .unwrap();
}
#[test]
fn status_does_not_start_a_service_or_create_auth_directories() {
    let f = Fixture::new();
    cleanup_pending(&f.home).unwrap();
    let s = auth_status(&f.config, &f.name).unwrap();
    assert_eq!(s.state, AuthState::Missing);
    assert!(!f.home.exists());
}
#[test]
fn scheduling_uses_access_expiry_and_ignores_old_id_expiry() {
    let f = Fixture::new();
    f.seed(now() + 10 * 86400);
    let s = auth_status(&f.config, &f.name).unwrap();
    assert_eq!(s.state, AuthState::Connected);
    let summary = refresh_all_account_auth(&f.config, &[f.name.clone(), f.name.clone()]);
    assert_eq!(summary.attempted, 0);
    assert_eq!(summary.skipped, 1);
    assert_eq!(summary.next_check_in_seconds, 86400);
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("synthetic-old"));
    assert!(!json.contains("access_token"));
    let clock = 1_000_000;
    assert_eq!(due_at(clock + REFRESH_LEAD_TIME), clock);
    assert!(due_at(clock + REFRESH_LEAD_TIME + 1) > clock);
}

#[test]
fn external_authority_blocks_no_trace_rotation_until_explicit_takeover() {
    let f = Fixture::new();
    f.seed(now() + 60);
    let old = fs::read(f.home.join("auth.json")).unwrap();
    let status = set_auth_authority(&f.config, &f.name, AuthAuthority::Cockpit).unwrap();
    assert_eq!(status.authority, AuthAuthority::Cockpit);
    assert!(!status.auto_refresh);
    assert_eq!(
        status.message.as_deref(),
        Some("Cockpit 负责刷新这条授权链；NoTrace 不会自动轮换它")
    );
    assert_eq!(
        refresh_all_account_auth(&f.config, std::slice::from_ref(&f.name)).attempted,
        0
    );
    let unchanged = refresh_with(&f.config, &f.name, Path::new("/not-a-provider"));
    assert!(unchanged.is_err());
    assert_eq!(old, fs::read(f.home.join("auth.json")).unwrap());

    let status = set_auth_authority(&f.config, &f.name, AuthAuthority::NoTrace).unwrap();
    assert_eq!(status.authority, AuthAuthority::NoTrace);
    assert!(status.auto_refresh);
    let status = refresh_with(&f.config, &f.name, &f.provider("success")).unwrap();
    assert_eq!(status.authority, AuthAuthority::NoTrace);
    assert_ne!(old, fs::read(f.home.join("auth.json")).unwrap());
}

#[test]
fn broker_handoff_freezes_refresh_before_sending_even_if_reply_is_lost() {
    let f = Fixture::new();
    f.seed(now() + 3600);
    let result = with_broker_handoff(&f.config, &f.name, |_profile_id, _body| -> Result<()> {
        assert_eq!(policy(&f.home).unwrap().authority, AuthAuthority::Broker);
        assert!(!policy(&f.home).unwrap().enabled);
        Err(CloakError::Auth("synthetic lost reply".into()))
    });
    assert!(result.is_err());
    assert_eq!(
        auth_status(&f.config, &f.name).unwrap().authority,
        AuthAuthority::Broker
    );
    assert!(set_auth_authority(&f.config, &f.name, AuthAuthority::NoTrace).is_err());
    assert!(refresh_with(&f.config, &f.name, Path::new("/must-not-start")).is_err());
}

#[test]
fn file_import_locks_and_freezes_refresh_without_caching_imported_tokens() {
    let f = Fixture::new();
    f.seed(now() + 3600);
    let original = fs::read(f.home.join("auth.json")).unwrap();
    with_imported_broker_handoff(&f.config, &f.name, || {
        assert_eq!(policy(&f.home).unwrap().authority, AuthAuthority::Broker);
        assert!(!policy(&f.home).unwrap().enabled);
        assert!(lock(&f.home.join(".operation.lock")).is_err());
        Ok(())
    })
    .unwrap();
    assert_eq!(original, fs::read(f.home.join("auth.json")).unwrap());
    assert!(refresh_with(&f.config, &f.name, Path::new("/must-not-start")).is_err());
}

#[test]
fn file_import_keeps_refresh_frozen_when_acceptance_is_uncertain() {
    let f = Fixture::new();
    f.seed(now() + 3600);
    assert!(
        with_imported_broker_handoff(&f.config, &f.name, || -> Result<()> {
            Err(CloakError::Auth("synthetic lost reply".into()))
        })
        .is_err()
    );
    assert_eq!(policy(&f.home).unwrap().authority, AuthAuthority::Broker);
    assert!(!policy(&f.home).unwrap().enabled);
}

#[test]
fn trashed_account_keeps_authorization_binding_and_refresh_policy() {
    let f = Fixture::new();
    f.seed(now() + 60);
    crate::set_account_trashed(&f.config, &f.name, true).unwrap();
    let status = auth_status(&f.config, &f.name).unwrap();
    assert_eq!(status.authority, AuthAuthority::NoTrace);
    assert!(status.auto_refresh);
    let refreshed = refresh_with(&f.config, &f.name, &f.provider("success")).unwrap();
    assert_eq!(refreshed.state, AuthState::Connected);
    assert!(crate::read_account(&f.config, &f.name).unwrap().trashed);
}

#[test]
fn permanent_delete_removes_private_authorization_directory() {
    let f = Fixture::new();
    f.seed(now() + 864000);
    crate::set_account_trashed(&f.config, &f.name, true).unwrap();
    assert!(f.home.exists());
    crate::permanently_delete_account(&f.config, &f.name).unwrap();
    assert!(!f.home.exists());
    assert!(crate::read_account(&f.config, &f.name).is_err());
}

#[test]
fn direct_permanent_delete_removes_active_profile_and_its_private_authorization() {
    let f = Fixture::new();
    f.seed(now() + 864000);
    assert!(!crate::read_account(&f.config, &f.name).unwrap().trashed);
    crate::permanently_delete_account(&f.config, &f.name).unwrap();
    assert!(!f.home.exists());
    assert!(!f.config.profile_dir(&f.name).exists());
}
#[test]
fn refresh_rotates_and_persists_verified_credentials() {
    let f = Fixture::new();
    f.seed(now() + 60);
    let old = Credentials::read(&f.home).unwrap().unwrap().digest;
    let s = refresh_with(&f.config, &f.name, &f.provider("success")).unwrap();
    assert_eq!(s.state, AuthState::Connected);
    assert!(s.last_refresh_at.is_some());
    assert_ne!(old, Credentials::read(&f.home).unwrap().unwrap().digest);
    assert!(!f.home.join(".pending-refresh").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(f.home.join("auth.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[test]
fn network_failure_keeps_credentials_and_backs_off() {
    let f = Fixture::new();
    f.seed(now() + 60);
    let old = fs::read(f.home.join("auth.json")).unwrap();
    let s = refresh_with(&f.config, &f.name, &f.provider("network")).unwrap();
    assert_eq!(s.state, AuthState::RefreshFailed);
    assert!(s.next_retry_at.unwrap() > now());
    assert_eq!(old, fs::read(f.home.join("auth.json")).unwrap());
    assert!(!serde_json::to_string(&s)
        .unwrap()
        .contains("SHOULD_NOT_LEAK"));
    assert_eq!(refresh_all_account_auth(&f.config, &[f.name]).attempted, 0);
}
#[test]
fn revoked_credentials_stop_automatic_retries_without_deletion() {
    let f = Fixture::new();
    f.seed(now() + 60);
    let s = refresh_with(&f.config, &f.name, &f.provider("revoked")).unwrap();
    assert_eq!(s.state, AuthState::ReauthRequired);
    assert!(s.next_retry_at.is_none());
    assert!(f.home.join("auth.json").exists());
    assert_eq!(refresh_all_account_auth(&f.config, &[f.name]).attempted, 0);
}
#[test]
fn rpc_success_without_a_new_token_is_not_refresh_success() {
    let f = Fixture::new();
    f.seed(now() + 60);
    let s = refresh_with(&f.config, &f.name, &f.provider("unchanged")).unwrap();
    assert_eq!(s.state, AuthState::RefreshFailed);
    assert_eq!(policy(&f.home).unwrap().error, Some(Failure::Unchanged));
}
#[test]
fn concurrent_refresh_is_rejected_before_spawning_provider() {
    let f = Fixture::new();
    f.seed(now() + 60);
    let _guard = lock(&f.home.join(".operation.lock")).unwrap();
    assert!(refresh_with(&f.config, &f.name, Path::new("/not-a-provider")).is_err());
    assert!(!f.home.join(".pending-refresh").exists());
}
#[test]
fn interrupted_rotation_is_recovered_without_reusing_old_token() {
    let f = Fixture::new();
    f.seed(now() + 60);
    let pending = prepare_pending(&f.home, ".pending-refresh", None).unwrap();
    fixture_auth(&pending, &f.name, now() + 864000, "recovered");
    let s = refresh_with(&f.config, &f.name, Path::new("/not-a-provider")).unwrap();
    assert_eq!(s.state, AuthState::Connected);
    assert!(!pending.exists());
}
#[test]
fn login_handles_delayed_callback_and_does_not_refresh_new_token() {
    let f = Fixture::new();
    let s = login_with(
        &f.config,
        &f.name,
        &f.provider("slow"),
        &AtomicBool::new(false),
        |url| {
            validate_auth_url(url)?;
            Ok(None)
        },
    )
    .unwrap();
    assert_eq!(s.state, AuthState::Connected);
    assert!(s.auto_refresh);
    assert_eq!(s.email.as_deref(), Some(f.name.as_str()));
    assert!(!f.home.join(".pending-login").exists());
}
#[test]
fn callback_before_login_response_is_not_lost() {
    let f = Fixture::new();
    assert!(login_with(
        &f.config,
        &f.name,
        &f.provider("success"),
        &AtomicBool::new(false),
        |_| Ok(None)
    )
    .is_ok());
}
#[test]
fn wrong_account_does_not_overwrite_existing_auth() {
    let f = Fixture::new();
    f.seed(now() + 864000);
    let old = fs::read(f.home.join("auth.json")).unwrap();
    assert!(login_with(
        &f.config,
        &f.name,
        &f.provider("wrong"),
        &AtomicBool::new(false),
        |_| Ok(None)
    )
    .is_err());
    assert_eq!(old, fs::read(f.home.join("auth.json")).unwrap());
}
#[test]
fn cancellation_keeps_existing_auth_and_cleans_pending_login() {
    let f = Fixture::new();
    f.seed(now() + 864000);
    let old = fs::read(f.home.join("auth.json")).unwrap();
    assert!(login_with(
        &f.config,
        &f.name,
        &f.provider("slow"),
        &AtomicBool::new(true),
        |_| Ok(None)
    )
    .is_err());
    assert_eq!(old, fs::read(f.home.join("auth.json")).unwrap());
    assert!(!f.home.join(".pending-login").exists());
}
#[test]
fn rename_preserves_binding_and_missing_names_are_rejected() {
    let f = Fixture::new();
    f.seed(now() + 864000);
    crate::rename_account(&f.config, &f.name, "renamed").unwrap();
    assert_eq!(auth_home(&f.config, "renamed", false).unwrap(), f.home);
    assert!(auth_home(&f.config, "does-not-exist", true).is_err());
}

fn browser_monitor(pid: u32, binary: PathBuf, profile: PathBuf) -> AuthBrowserMonitor {
    let started = Instant::now();
    AuthBrowserMonitor {
        pid,
        binary,
        profile,
        started,
        next_check: started,
        seen_window: false,
        closed_since: None,
    }
}

#[test]
fn closing_last_auth_window_stops_wait_but_hidden_windows_and_unknown_state_do_not() {
    use crate::browser_processes::AuthBrowserState;
    let mut browser = browser_monitor(10, "/unused".into(), "/unused-profile".into());
    let started = browser.started;
    assert!(browser
        .observe(
            AuthBrowserState {
                running: true,
                has_window: Some(false)
            },
            started
        )
        .is_ok());
    assert!(browser
        .observe(
            AuthBrowserState {
                running: true,
                has_window: Some(true)
            },
            started + Duration::from_secs(1)
        )
        .is_ok());
    assert!(browser
        .observe(
            AuthBrowserState {
                running: true,
                has_window: Some(false)
            },
            started + Duration::from_secs(2)
        )
        .is_ok());
    assert!(browser
        .observe(
            AuthBrowserState {
                running: true,
                has_window: None
            },
            started + Duration::from_secs(3)
        )
        .is_ok());
    assert!(browser
        .observe(
            AuthBrowserState {
                running: true,
                has_window: Some(true)
            },
            started + Duration::from_secs(4)
        )
        .is_ok());
    assert!(browser
        .observe(
            AuthBrowserState {
                running: true,
                has_window: Some(false)
            },
            started + Duration::from_secs(5)
        )
        .is_ok());
    assert_eq!(
        browser.observe(
            AuthBrowserState {
                running: true,
                has_window: Some(false)
            },
            started + Duration::from_secs(6)
        ),
        Err(Failure::BrowserClosed)
    );
}

#[test]
fn closing_auth_browser_preserves_credentials_cleans_pending_and_allows_retry() {
    let f = Fixture::new();
    f.seed(now() + 864000);
    let old = fs::read(f.home.join("auth.json")).unwrap();
    let started = Instant::now();
    let error = login_with(
        &f.config,
        &f.name,
        &f.provider("slow"),
        &AtomicBool::new(false),
        |_| {
            Ok(Some(browser_monitor(
                u32::MAX,
                "/missing".into(),
                f.config.profile_dir(&f.name),
            )))
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("授权浏览器已关闭"));
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(old, fs::read(f.home.join("auth.json")).unwrap());
    assert!(!f.home.join(".pending-login").exists());
    assert!(login_with(
        &f.config,
        &f.name,
        &f.provider("success"),
        &AtomicBool::new(false),
        |_| Ok(None)
    )
    .is_ok());
}

#[test]
fn completed_callback_is_not_lost_when_browser_closes_at_the_same_time() {
    let f = Fixture::new();
    let status = login_with(
        &f.config,
        &f.name,
        &f.provider("success"),
        &AtomicBool::new(false),
        |_| {
            Ok(Some(browser_monitor(
                u32::MAX,
                "/missing".into(),
                f.config.profile_dir(&f.name),
            )))
        },
    )
    .unwrap();
    assert_eq!(status.state, AuthState::Connected);
}
#[test]
fn paused_account_is_not_refreshed() {
    let f = Fixture::new();
    f.seed(now() + 60);
    let s = set_auth_auto_refresh(&f.config, &f.name, false).unwrap();
    assert!(!s.auto_refresh);
    assert_eq!(refresh_all_account_auth(&f.config, &[f.name]).attempted, 0);
}
#[test]
fn rejects_links_malformed_credentials_and_non_official_urls() {
    let f = Fixture::new();
    for url in [
        "http://auth.openai.com/",
        "https://auth.openai.com.evil.test/",
        "https://user@auth.openai.com/",
        "https://auth.openai.com:444/",
    ] {
        assert!(validate_auth_url(url).is_err());
    }
    assert!(validate_auth_url("https://auth.openai.com/oauth/authorize").is_ok());
    fs::write(f.home.join("auth.json"), "not json").unwrap();
    assert_eq!(
        auth_status(&f.config, &f.name).unwrap().state,
        AuthState::ReauthRequired
    );
    #[cfg(unix)]
    {
        fs::remove_file(f.home.join("auth.json")).unwrap();
        std::os::unix::fs::symlink("/missing", f.home.join("auth.json")).unwrap();
        assert!(auth_status(&f.config, &f.name).is_err());
    }
}

#[test]
fn login_reports_global_lock_separately_and_recovers_after_release() {
    let f = Fixture::new();
    let global = lock(&f.home.parent().unwrap().join(".login.lock")).unwrap();
    let error = login_with(
        &f.config,
        &f.name,
        Path::new("/must-not-start"),
        &AtomicBool::new(false),
        |_| panic!("must not open browser"),
    )
    .unwrap_err();
    assert!(error.to_string().contains("另一个账号"));
    assert!(!f.home.join(".pending-login").exists());
    drop(global);
    assert!(login_with(
        &f.config,
        &f.name,
        &f.provider("success"),
        &AtomicBool::new(false),
        |_| Ok(None)
    )
    .is_ok());
}

#[test]
fn oauth_browser_failures_preserve_seat_reason_without_raw_messages() {
    let cases = [
        (CloakError::LicenseSeatInUse, Failure::SeatInUse),
        (CloakError::LicenseSeatStale, Failure::SeatStale),
        (
            CloakError::LicenseDenied {
                code: 77,
                message: "secret".into(),
            },
            Failure::LicenseInvalid,
        ),
        (
            CloakError::LicenseDenied {
                code: 78,
                message: "secret".into(),
            },
            Failure::LicenseNetwork,
        ),
        (CloakError::LaunchCancelled, Failure::Cancelled),
    ];
    for (error, expected) in cases {
        let failure = browser_failure(error);
        assert_eq!(failure, expected);
        assert!(!failure.message().contains("secret"));
    }
    let f = Fixture::new();
    let error = login_with(
        &f.config,
        &f.name,
        &f.provider("success"),
        &AtomicBool::new(false),
        |_| Err(Failure::SeatStale),
    )
    .unwrap_err();
    assert!(error.to_string().contains("席位尚未释放"));
    assert!(!f.home.join("auth.json").exists());
    assert!(!f.home.join(".pending-login").exists());
}
