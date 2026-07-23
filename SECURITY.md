# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security issue in Grok App (for example token leakage, unsafe
agent process spawning, or local secrets exposure), please report it privately:

- Open a GitHub Security Advisory on [RongleCat/grok-app](https://github.com/RongleCat/grok-app), or
- Contact the maintainer on X: [@cgnot996](https://x.com/cgnot996)

Please include:
- A clear description of the issue
- Steps to reproduce
- Impact assessment if known

Do **not** open a public issue for sensitive vulnerabilities until a fix is available.

## Local security notes

- App secrets live under the app data root (`secrets.json`, mode `0600` when possible) — keep that directory private.
- Custom provider keys may also be written to the independent agent home (`agent-home/config.toml`); do not commit them.
- Prefer official Grok login / local CLI auth over pasting long-lived keys into chats.
- Automations and YOLO permission mode can run agent actions without per-step prompts — enable only if you trust the session.
