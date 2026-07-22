# Custom providers & agent profile

Product rules for **OpenAI-compatible relays** (CPA / sub2api / OneAPI / self-hosted) and how they reach Grok Build.

## Agent transport (shared with Grok Desktop)

Both Grok App and community **Grok Desktop** drive intelligence the same way:

| Layer | Implementation |
|-------|----------------|
| Runtime | **Grok Build CLI** binary (`grok`) |
| Entry | `grok agent stdio` |
| Protocol | **ACP** (Agent Client Protocol) JSON-RPC over stdio |
| Client | Desktop Host (`AcpClient`) — **not** a reimplemented agent brain |

Desktop never reimplements tools/sampling. It is an ACP client + UI shell.

## Agent profile (`GROK_HOME`)

| Session data mode | `GROK_HOME` for spawned agent |
|-------------------|-------------------------------|
| `independent` (default) | `~/.grok-app/agent-home` (or `$GROK_APP_HOME/agent-home`) |
| `shared` | `~/.grok` (CLI default) |

Custom providers are written to **`$GROK_HOME/config.toml`** as `[model.<id>]` sections so the agent can use `base_url` + `api_key` without OAuth fallback.

## Provider model (L2)

| Field | Role |
|-------|------|
| `id` | Config section slug (`[model.<id>]`) |
| `name` | Display label |
| `baseUrl` | OpenAI-compatible root, usually ends with `/v1` |
| `apiKey` | Required for custom relay; never returned plaintext to UI |
| `model` | Request body model id |
| `apiBackend` | `chat_completions` \| `responses` \| `messages` |
| `isDefault` | Maps to `[models].default` |

CPA / sub2api / grok-go are **not special-cased** — any compatible base URL works.

## Host commands

| Command | Role |
|---------|------|
| `providers_list` | Providers + default (no raw keys) |
| `providers_upsert` | Create/update; empty key keeps previous |
| `providers_remove` | Delete section |
| `providers_set_default` | Set default model id |
| `providers_ping` | `GET {base}/models` RTT |
| `providers_list_models` | Fetch remote model ids |
| `editors_list` | Detected local IDEs |
| `open_in_editor` | Open path in chosen editor |

## Security

- UI only sees `hasApiKey`.
- Logs must redact keys (existing redact paths).
- Official OAuth (`auth.json`) stays separate from relay keys.

## Sponsorship (L3, future)

Recommended catalog / paid naming sits **above** L2 as templates only. Keys always user-owned. See `docs/分析-Grok-Desktop对照报告.md` §7.
