# Remote control security

- Phone mirror defaults to **read-only**; enable “Allow phone to send” for writes (in-app confirm + persistent warning banner while write is on).
- Toggling write access writes an audit line to `app.log` (no tokens/URLs).
- **Regenerate link** rotates the token and disconnects old QR sessions.
- IM allow-from and LINE signature checks ship in 0.1.9+.
