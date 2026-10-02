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
```

Generate keys outside the repository and place the environment file with mode
`0600`. The account directory is created with mode `0700`; grant files contain
AES-GCM ciphertext and are written atomically.

The server defaults to `127.0.0.1:18455`. A remote NoTrace management client
must use an HTTPS reverse proxy or a private WireGuard/Tailscale path. Do not
expose the plain HTTP listener to the public internet.

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
write access-only files in Cockpit Tools, official `auth.json`, CPA, and
Sub2API-compatible shapes. Exported files always contain an empty
`refresh_token`; the format marker identifies `notrace_broker` ownership where
the consumer supports it.

JSON import is a validation/conversion flow. It previews recognized accounts
and can convert them to one of the supported access-only formats, but it never
promotes an imported refresh token to Broker ownership and never overwrites a
production consumer automatically. A browser authorization or an explicitly
approved Broker handoff remains the source of truth for a rotating grant.

`POST /v1/admin/accounts/<account>/grant` is the one-time handoff from a local
NoTrace account. The `cloak auth broker-push` command sends the protected local
grant and then marks the local copy as Broker-owned, preventing the Mac-side
NoTrace scheduler from rotating the same lineage.

If a refresh request has an ambiguous transport failure after the request may
have reached OpenAI, the Broker journals the in-flight state and stops retrying
the old refresh token. An operator must reauthorize that account or recover the
pending result; this is deliberate protection against `refresh_token_reused`.

## Current migration boundary

CPA synchronization is opt-in per account and refuses to overwrite an existing
unmanaged auth file. Cockpit still requires its external-managed account mode
before it can consume these projections safely; the Broker does not modify
Cockpit's account database automatically.
