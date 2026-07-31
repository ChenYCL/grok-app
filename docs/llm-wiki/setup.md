# First-run setup gate

Product rules for the **full-screen initialization wizard** before the workbench home.

## Goals

1. **Hard gate:** Grok Build CLI must be found and runnable before entering home.
2. **Soft gate:** Official login / API key / custom relay may be **skipped**.
3. Match app chrome (tokens, logo, dark/light); **no scrollbars** on the gate page.
4. Install uses **multi-mirror** download with retries (same bases as official `install.sh`).

## Flow

```
boot → probe CLI
  ├─ no CLI → SetupWizard step Runtime (install required)
  ├─ CLI ok + !setupWizardCompleted → Account step (skippable)
  └─ CLI ok + setupWizardCompleted → home
```

### Step 1 — Runtime (cannot skip)

| Action | Host |
|--------|------|
| Detect | `probe_cli` — mac + Windows (see below) |
| Auto install | `cli_install_latest` + event `setup://cli-install-progress` |
| Manual path | `pick_cli_binary` → `manualCliPath` |
| Fallback | Copy official install command / open docs |

Mirrors (order):

1. `https://storage.googleapis.com/grok-build-public-artifacts/cli` (preferred — more reliable in CN)
2. `https://x.ai/cli`

Each mirror is tried multiple times before failing over.

**Checksum trust:** download is HTTPS-allowlisted; streamed SHA-256 is always computed. If the mirror publishes a sidecar, **mismatch aborts**. Official mirrors currently omit sidecars (same as `install.sh` / `install.ps1`), so **missing checksum is allowed by default** and stored as `checksum_verified: false`. Strict fail-closed: `GROK_CLI_REQUIRE_CHECKSUM=1` (override with Settings → Runtime “Allow unverified CLI install” or `GROK_CLI_ALLOW_UNVERIFIED=1`).

### Step 2 — Account (skippable)

OAuth, official key, relay, import CLI / grok-go. No `window.prompt`.

### Step 3 — Ready → Enter

Persists `setupWizardCompleted: true`. If account skipped: `authSetupDeferred: true`.

## Settings fields

| Field | Role |
|-------|------|
| `setupWizardCompleted` | Wizard finished with CLI ready |
| `authSetupDeferred` | User skipped account step |
| `onboardingDone` / `setupSkipped` | Legacy; migrated when CLI present |

## UI

- Component: `src/components/SetupWizard.tsx`
- Styles: `src/styles/setup-wizard.css` (overflow hidden, no scrollbars)
- i18n: `setup.*` keys in `src/i18n/messages.ts`

## CLI probe (mac + Windows)

`cli_probe::probe_cli` must work when the app is launched from Dock / Explorer (sparse PATH):

| Source | macOS | Windows |
|--------|-------|---------|
| Official install | `~/.grok/bin/grok` (+ downloads) | `%USERPROFILE%\.grok\bin\grok.exe` (+ downloads) |
| Package managers | Homebrew `/opt/homebrew`, `/usr/local` | WinGet Links, Scoop shims, Chocolatey |
| PATH | process PATH + enriched PATH scan | same; names `grok.exe` / `.cmd` / `.bat` |
| Manual | `~` expansion | `~` / `%USERPROFILE%` / auto-append `.exe` |
| Home dir | `$HOME` | **`USERPROFILE` first** (not MSYS `$HOME`) |

`--version` is preferred; a runnable binary without version still counts as found.

## Commands

| Command | Role |
|---------|------|
| `probe_cli` | Detect binary (cross-platform) |
| `cli_install_latest` | Download + link into `~/.grok` |
| `cli_install_commands` | Platform shell command + docs URL |
| `pick_cli_binary` | File picker |
| `open_external_url` | Open install docs |

## Managed configuration (enterprise, optional)

Settings → Runtime → **Managed setup** (`ManagedSetupPanel`):

1. **CLI ready** (hard dependency; same as first-run Runtime).
2. **Team login / `GROK_DEPLOYMENT_KEY`** (or `[endpoints].deployment_key`).
3. **Preview** — `grok setup --json` (writes nothing; secrets redacted).
4. **Install** — `grok setup` with in-app confirm (no `window.confirm`); soft-respawns agent.
5. **Verify local status** — host `managed_setup_status` soft-probes:
   - `managed_config.toml` / `requirements.toml` / `managed_config.sig.json` / `managed_identity.sig.json` under active `GROK_HOME`
   - system `/etc/grok/managed_config.toml` when present (Unix)
   - `grok inspect` flags `managedSettingsActive` / `Exists` / `Path` when CLI works

The App **does not re-verify cryptographic signatures**; it only shows artifact presence + inspect flags. CLI rejects bad signatures before writing. Soft-fail when CLI/inspect is missing.

## Non-goals

- Embedding the CLI binary in the app package (B04).
- Silent download without multi-mirror retry.
- Forcing project selection before home.
- App-side re-implementation of managed-config crypto verification.
