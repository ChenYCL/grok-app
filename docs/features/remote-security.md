# Remote control security

- Phone mirror defaults to **read-only**; enable “Allow phone to send” for writes (in-app confirm + persistent warning banner while write is on).
- While write is on, the Connect panel lists **allowlisted write RPC categories** and shows a **broad-surface** warning (full allowlist is open; filesystem / desktop-only commands stay blocked).
- Optional **max phone clients** (1–16, default 4): extra WebSocket upgrades get HTTP 503.
- Toggling write access writes an audit line to `app.log` (no tokens/URLs). Local write-ACL audit ring (localStorage) also records enable/disable, rotate, host start/stop — never secrets.
- **Regenerate link** requires in-app confirm (mentions connected client count), rotates the token, disconnects old QR sessions; host logs `token_tail` only.
- Auth rejection and host start logs **redact** path tokens / public URLs (`/t/<redacted>/…`, `token_tail`).
- IM allow-from and LINE signature checks ship in 0.1.9+.
