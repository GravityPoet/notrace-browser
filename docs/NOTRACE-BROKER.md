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

JSON import is a validation/conversion flow. It previews recognized accounts
and can convert them to one of the supported formats. For an import, the default
is to preserve an input `refresh_token`; checking the clear option creates an
access-only copy. The saved conversion result never promotes an imported token
to Broker ownership and never overwrites a production consumer automatically.
A browser authorization or an explicitly approved Broker handoff remains the
source of truth for a rotating grant.

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

## Current migration boundary

CPA synchronization is opt-in per account and refuses to overwrite an existing
unmanaged auth file. Cockpit still requires its external-managed account mode
before it can consume these projections safely; the Broker does not modify
Cockpit's account database automatically.

Each new browser authorization pauses that account's CPA synchronization in
the same locked write that saves the grant. The previous CPA file remains in
place until the user clicks "同步到 CPA". A successful sync enables automatic
projection of later renewals. Failed or pending synchronization offers an
explicit retry instead of showing a pause button solely because the switch
is enabled. An idempotent retry of the same handoff preserves its current
settings, and normal OAuth renewals preserve the enabled sync policy.
