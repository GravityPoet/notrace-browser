# NoTrace Browser License and Release Contract

This contract defines what may enter a NoTrace macOS release. It does not grant
rights beyond [LICENSE](../LICENSE).

## Distribution boundaries

- NoTrace source and original assets are source-available and all rights
  reserved.
- The pinned `cloakbrowser` wrapper is a separate MIT-licensed dependency. Its
  exact version and registry integrity must match
  [`packaging/cloakbrowser-compatibility.json`](../packaging/cloakbrowser-compatibility.json).
- The CloakBrowser Chromium binary is obtained separately from CloakHQ and is
  never committed, bundled, uploaded, or redistributed by this repository.
  CloakHQ's binary license remains authoritative for that binary.
- A `-notrace` bundle is a machine-local TCC runtime copy. It must stay outside
  release artifacts and must not be represented as an upstream source cache.

## Promotion contract

An engine version may become `current` only when all of the following are true:

1. The wrapper pin, lockfile version, npm integrity, updater constant, and
   compatibility matrix agree.
2. The exact macOS engine version has status `approved` in the compatibility
   matrix. Unknown, `review-required`, and `blocked` builds stop before staging.
3. The wrapper-managed source cache remains unchanged and passes its signature
   checks.
4. The local runtime copy contains the required TCC usage descriptions and is
   signed with the configured persistent identity.
5. Staging has room for the complete app bundle plus the larger of 5% or 256 MiB.
6. The previous runtime is retained for rollback, and the `current` switch is
   atomic.
7. `current.sha256` is written after promotion and matches the selected binary.
   Picker and `cloak self-check` block a managed launch when this provenance is
   missing, invalid, or mismatched.
8. The local contract and headed live challenge gates pass for the exact
   runtime.

Separately, every NoTrace application release must pass the native macOS Picker
E2E gate against the signed `.app`. The gate proves that a real macOS window and
release WebView can load an account, report managed-runtime provenance, preserve
the complete value behind truncated path rows, and complete the account and
workspace-tab keyboard flows. CI treats this check as part of the
`macOS release gate` job.

The exact macOS build `150.0.7871.114.3` remains blocked for its confirmed
`browserTampering` regression. Wrapper `0.5.9` resolves the newer macOS Stable
line, but a wrapper update alone does not authorize an engine promotion.

## Audit commands

```bash
node packaging/audit-cloakbrowser-compatibility.mjs
node packaging/audit-cloakbrowser-compatibility.mjs --check-upstream
./packaging/test-picker-native-e2e.sh
```

The scheduled CI audit reports wrapper drift. Candidate engine drift is checked
again inside `packaging/update-chromium.sh` before any runtime staging copy.

Upstream references reviewed on 2026-08-30:

- [CloakBrowser 0.5.9 changelog](https://github.com/CloakHQ/CloakBrowser/blob/0811704e7f5a5f67b5cc0b4a1f9b38810c7eb4d5/CHANGELOG.md)
- [CloakBrowser 151.0.7922.108.3 release](https://github.com/CloakHQ/CloakBrowser/releases/tag/v151.0.7922.108.3)
- [CloakBrowser binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)
