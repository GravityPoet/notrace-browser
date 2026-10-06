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
