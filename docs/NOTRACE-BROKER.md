# NoTrace Broker

`notrace-broker` is the headless refresh authority for one Codex/ChatGPT OAuth
grant. It keeps the rotating `refresh_token` encrypted at rest and only returns
metadata or an access-only projection to consumers.

The browser is still used for the first authorization or a reauthorization.
The Broker does not run Chromium, Codex, or a model process.

## Storage and startup

The service requires these environment variables:

```text
NOTRACE_BROKER_ROOT=/var/lib/notrace-broker
NOTRACE_BROKER_KEY=<64 hex characters>
NOTRACE_BROKER_ADMIN_KEY=<random service key>
NOTRACE_BROKER_CPA_KEY=<different random service key>
NOTRACE_BROKER_COCKPIT_KEY=<different random service key>
NOTRACE_BROKER_CPA_AUTH_DIR=/opt/cliproxyapi/auths
NOTRACE_BROKER_CYCLE_SECONDS=900
```

Generate keys outside the repository and place the environment file with mode
`0600`. The account directory is created with mode `0700`; grant files contain
AES-GCM ciphertext and are written atomically.
The cycle interval accepts 15–86400 seconds; invalid or missing values fall
back to 60 seconds.

The server defaults to `127.0.0.1:18455`. A remote NoTrace management client
must use an HTTPS reverse proxy or a private WireGuard/Tailscale path. Do not
expose the plain HTTP listener to the public internet.

### macOS tunnel recovery

Install or upgrade the existing local tunnel with
`python3 packaging/install-broker-tunnel.py --host <primary-ssh-alias> --host
<fallback-ssh-alias>` from the repository root. Repeat `--host` for each
private SSH alias in preference order. The aliases remain in the private
LaunchAgent plist; the public checkout contains no host or credentials. Later
canonical Picker installs upgrade an already configured tunnel using that saved
list.

The Chinese-named `后台统一授权续期隧道.sh` supervises its own SSH child. Each
connection/handshake is limited to 15 seconds with one attempt. SSH heartbeats
remain 30 seconds / 3 misses. The supervisor checks the complete forwarding
path at `http://127.0.0.1:18555/healthz` every 15 seconds, with a 3-second HTTP
deadline, bypassing proxy environment variables and requiring JSON `ok: true`
and `api_version: 1`. After 3 consecutive failures it terminates only its own
child, waits for it, and immediately tries the next configured SSH alias. Only
after every alias fails does it use 5/10/20/40/60-second backoff. Successful
health checks reset both the failover round and the backoff. A healthy fallback
stays connected; if it fails later, the next alias is tried before any backoff.
It does not refresh OAuth or write CPA files.
The listener is restricted to IPv4 loopback. No additional scheduled job or
third-party tunnel package is installed.

The Picker deduplicates metadata reads, limits each HTTP read to 5 seconds,
polls every 5 seconds while disconnected (30 seconds while connected), and
immediately rechecks on window focus, visibility restoration or network-online
events. It retains the last snapshot, displays automatic reconnection and an
immediate retry action, and reenables authorization after connection recovery.
It never queues or automatically retries an authorization or token rotation.

The installer verifies backups, writes atomically, checks the actual launchctl
program/arguments and Broker health, and restores the previous files/job on
failure. It waits for the old launchd job to disappear before reloading, and
allows 60 seconds per configured alias for startup health verification. It
retains the newest two valid backups under the local
`Recovery/BrokerTunnel` directory. Restore one with
`python3 packaging/install-broker-tunnel.py --rollback <verified-backup-dir>`.
`python3 packaging/test_broker_tunnel.py -v` exercises a live but unusable child,
bidirectional failover, recovery after all aliases fail, bounded retries,
shutdown isolation, the real HTTP deadline and backup retention
using isolated fixtures with verified Trash recovery receipts.

Build the Cargo package `cloak-broker` to produce the `notrace-broker` binary.
The current Ubuntu VPS uses glibc 2.35; use a compatible build base such as the
cached `rust:1.94.0-bullseye`, not the moving `rust:latest` base. Before replacing
the service, run the candidate's `--version` on the VPS itself. Back up the old
binary, replace atomically, and roll back the binary if `/healthz` fails. Do not
restore an old credential snapshot as part of a binary rollback.

## API roles

The admin key can list metadata, import an initial grant, and request a due or
forced refresh. Consumer keys can fetch an access-only Codex credential:

```text
GET /v1/consumers/cpa/accounts/<account>/credential
GET /v1/consumers/cockpit/accounts/<account>/credential
```

These projections intentionally contain an empty `refresh_token` and identify
`refresh_owner: notrace_broker`. A consumer must never receive the Broker's
master refresh token.

The Picker also provides JSON exchange for a Broker-owned account. It can
write files in Cockpit Tools, official `auth.json`, CPA, and Sub2API-compatible
shapes. The checkbox defaults to clearing `refresh_token`, so the normal export
is access-only and NoTrace remains the only refresh owner. An explicit opt-out
can preserve the real `refresh_token` for a deliberate migration or offline
backup; the resulting file is local mode `0600` and must be treated as a second
refresh-capable credential. The format marker identifies `notrace_broker`
ownership where the consumer supports it.

### One-click official Cockpit import (macOS)

**导入 Cockpit** reads the current Broker access-only projection without
forcing a Broker refresh. It refuses expired credentials, unexpected refresh
tokens, and mismatched account or generation metadata. It does not enable or
disable CPA synchronization, and it does not rotate the Broker grant.

The Picker opens `/Applications/Cockpit Tools.app` with the official
`cockpit-tools://import?provider=codex&import_url=...&auto_import=true` protocol.
It requests background/hidden launch (`open -g -j`). Cockpit 1.3.68 itself
forcibly activates its main window, so a brief foreground flash remains possible.
After the handoff (including a failed or timed-out handoff), the Picker uses
`NSRunningApplication.hide()` once on the Picker's main event thread, restoring the former application only if
Cockpit is still active. It never runs a repeated focus watcher or activates
the Picker over an unrelated foreground app. An already-hidden app is a no-op.
The native result reports accepted dispatch, not synchronous hide completion
(AppKit's time-varying properties are run-loop cached). An unconfirmed window
request is shown separately from delivery; it never triggers another import.
If a hide request is refused while the cached state still says visible, the
Picker performs at most three later read-only main-loop observations. An
already-hidden result is accepted; otherwise the specific window failure is
shown without changing the successful credential delivery result.
The JSON bundle stays in memory and is served once from `127.0.0.1` on a random
port and a 192-bit random path, for at most 45 seconds. Invalid paths, browser
origins, unexpected Host headers and non-GET requests cannot consume it. No
temporary credential file, raw-token URL, clipboard copy, private Cockpit
database edit or Broker consumer acknowledgement is used.

Cockpit Tools 1.3.68 (official source `af5e90bc12151945e0f9c2058f849471c4ed529a`)
supports this protocol and automatically reads imported account quota once
after saving the account.
It receives `access_token` and identity metadata, with `refresh_token` empty;
Broker remains the renewal owner. Later Broker renewals are not automatically
pushed to Cockpit: click the action again to replace its access-only copy.
NoTrace shows **已接收 · 保存待确认** for the delivered generation, not final
success. The official protocol has no save/quota completion callback; these
results remain in Cockpit's own import dialog, which the user can open manually.
The delivery indicator expires when the Broker endpoint or generation changes,
or when the panel is reopened. It does not acknowledge a Broker consumer sync.
A timeout or ambiguous handoff failure must not be retried automatically.

For the original CPA upload endpoint, select the CPA format: one JSON metadata
object per account, with `access_token` at the top level. Cockpit's array export
and official Codex's nested `tokens` shape are different formats. Multi-account
input cannot be saved as one CPA auth file; export each account separately.

JSON import defaults to **导入并纳管**. A complete credential must include
`access_token`, `id_token`, and `refresh_token`. Email and account identity are
also extracted from the JWT claims so official `auth.json` files can be matched
to an existing NoTrace account, including an account in the recycle bin. For a
multi-account file, select one account to import at a time. Account identity and
Broker connectivity are checked before freezing local refresh; the operation
lock remains held through the handoff. Tokens are sent directly to Broker for
encrypted storage and are never returned to the frontend or copied into the
local OAuth cache. Import closes the dialog and locates the managed account.
Account details show the registered Broker owner and route all authorization
actions to unified renewal; an absent or expired local cache is not presented
as the current Broker grant's authorization state.
An uncertain reply keeps local refresh frozen and permits an idempotent retry
of the same file. Import does not test or rotate the refresh token; use
“立即刷新” to check provider acceptance separately.

**仅转换文件** retains the existing format-conversion flow. It preserves an
input `refresh_token` by default; checking the clear option creates an
access-only copy. Only this mode has the clearing option and a save dialog.
Conversion never writes to Broker, CPA, or Cockpit. Importing into Broker also
leaves consumer credentials untouched until explicit synchronization.

`POST /v1/admin/accounts/<account>/grant` is the one-time handoff from a local
NoTrace account. The `cloak auth broker-push` command sends the protected local
grant and then marks the local copy as Broker-owned, preventing the Mac-side
NoTrace scheduler from rotating the same lineage.

If a refresh request has an ambiguous transport failure after the request may
have reached OpenAI, the Broker journals the in-flight state and stops retrying
the old refresh token. An operator must reauthorize that account or recover the
pending result; this is deliberate protection against `refresh_token_reused`.

The Broker stores renewal counters alongside the encrypted grant. `refresh_count`
counts successful OAuth renewals, and `automatic_refresh_count` counts the subset
triggered by due checks. A forced refresh from “立即刷新” counts toward the total
but not the automatic subset. First authorization, reauthorization, failed
requests, status checks and CPA synchronization do not increment either counter.
Reauthorization preserves the totals, and journal recovery promotes the saved
counts without adding them twice. Legacy grants start at zero; earlier history
is not inferred from `generation`. The Picker labels the counts as accumulated
since statistics were enabled.

### Read-only Codex quota

The Picker's **读取额度** action calls the Broker admin endpoint
`GET /v1/admin/accounts/<account>/quota`. It uses the current access token to
query ChatGPT's usage service and never calls `POST /refresh`, persists a token,
or writes a CPA projection. The response contains the primary five-hour window,
the secondary weekly window, each reset time, and the active banked reset count
when the upstream returns either `available_count` or a `credits[]` detail list.
Expired, redeemed, or consumed detail entries are not counted. If neither form
is returned, the UI says **上游未提供**; Broker refresh counts are never shown as
quota reset counts.

The read is deliberately on demand for the all-account list and bounded to the
currently selected workbench account. A 401/403 or malformed upstream response
is surfaced as an unavailable quota read and does not change the grant's
reauthorization state.

## Current migration boundary

CPA synchronization is opt-in per account and refuses to overwrite an existing
unmanaged auth file. Cockpit still requires its external-managed account mode
before it can consume these projections safely; the Broker does not modify
Cockpit's account database automatically.

Each new authorization, including a file import, pauses that account's CPA synchronization in
the same locked write that saves the grant. The previous CPA file remains in
place until the user clicks "同步到 CPA". A successful sync enables automatic
projection of later renewals. Failed or pending synchronization offers an
explicit retry instead of showing a pause button solely because the switch
is enabled. An idempotent retry of the same handoff preserves its current
settings, and normal OAuth renewals preserve the enabled sync policy.

### CPA file ACL compatibility

CPA's Codex atomic writer creates a root-owned `0600` replacement. This masks
the inherited `notrace-broker` ACL even though the directory ACL is correct,
causing `cpa_sync_error: storage` for previously synchronized accounts.

Deploy `packaging/cpa-broker-acl.py` as the root-owned executable
`/usr/local/libexec/notrace-cpa-acl.py`, and the matching `.service` and
`.path` units under `/etc/systemd/system/`. Create the root-owned `0700`
`/var/lib/notrace-cpa-acl` directory first. Both directories must have root-owned
ancestors; do not place this privileged helper under the Broker-owned `/opt/notrace-broker`.
The Linux-root installer `packaging/install-cpa-broker-acl.sh` performs these
checks, enables the path unit and runs the service once for existing files.
The path unit reacts to CPA directory
changes and survives CPA container upgrades without changing the vendor image.

The helper never reads credential bodies. It changes only ACL xattrs on
root-owned regular `.json` files with a single existing Broker ACL and no
group/other access. It restores read access only, refuses links and other named
principals, and retains at most two ACL-only rollback records. File contents,
owners and Broker sync policies are unchanged. To revoke Broker access, remove
the named ACL instead of only masking it, or stop the path unit.

For rollback, stop and disable `notrace-cpa-acl.path`, then run
`python3 /usr/local/libexec/notrace-cpa-acl.py --rollback` to inspect the
latest snapshot and add `--repair` to apply it. Inodes replaced since the
snapshot are skipped. Validate with the pure Python tests and the isolated
Linux `--linux-fixture` test before deployment; neither test uses real accounts.
