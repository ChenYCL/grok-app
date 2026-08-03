# Media delivery (local files)

## Model

| Layer | Responsibility |
|-------|----------------|
| **Resolve** | Token in chat / attachments → verified absolute path (session + project + grants) |
| **Deliver** | Absolute path → viewable URL for `<img>` / `<video>` / `fetch` |

## Delivery: loopback HTTP (primary)

Host starts a process-local axum server on `127.0.0.1:0` at app boot (`media_server.rs`).

```
GET http://127.0.0.1:{port}/v1/media?t={token}&p={urlencode(absPath)}
```

- **Token**: random per process; frontend loads via `media_server_endpoint` / `ensureMediaEndpoint()`.
- **path_scope**: same allowlist as fs absolute APIs (trusted projects, app data, agent home, grants).
- **Images**: no-Range GET returns **full 200 body** (up to 40 MiB). `<img>` cannot reassemble Range/206 — truncating at 2 MiB breaks chat thumbs and composer drops.
- **Range**: 206 + max 2 MiB chunk for video/audio/PDF (and Range requests on any type).
- **CORS**: main-window origins only (for `fetch` / copy / office reassembly); never `*`.
- **CSP**: `img-src` / `media-src` / `connect-src` allow `http://127.0.0.1:*`.

Frontend entry: `src/lib/imageSrc.ts` (`localPathToMediaHttpUrl`, `resolveImageSrc*`).  
Preview/office: `src/lib/filePreviewSrc.ts` (reassembles multi-Range for full-file readers).

## Fallback

`media://` custom protocol remains registered for cold-start races only. Steady-state UI should use HTTP URLs.

## Security notes

- Bind **only** loopback.
- Never put filesystem paths in the path segment without token.
- Embedded browser webviews do **not** receive the token; they cannot read local media via this server.
- Do not reintroduce `Access-Control-Allow-Origin: *` for media.

## Path citation (agent + UI)

| Kind | Agent should write | UI |
|------|--------------------|-----|
| Local media to preview | Real absolute path in backticks (real spaces, no shell `\ `) | ImageUi / VideoUi via loopback media |
| Project code/docs | Project-relative (`apps/web/foo.ts`) | FilePathCard (basename); Host smart open |
| Web/CMS assets | Full `https://…` | URL card — never treat `/images/…` as local FS |

Host injects a short **path citation** block into session `--rules` (`path_citation_session_rules` in `official_aux.rs`). Soft guidance only.

Frontend normalize (`src/lib/pathNormalize.ts`):

- Shell-unescape POSIX paths (`file\ \(1\).png` → `file (1).png`)
- Reject site-root absolutes (`/images/…`) for media HTTP
- Fail soft: unresolved relative media → FilePathCard (or plain code for bare media basenames), not broken ImageUi
- **FilePathCard open**: resolve first; if missing → mark card, do **not** open an empty resource tab
- Bare media basenames (`manycore.png`) stay as inline code unless pathMap maps them to a real local abs

## Related

- Path resolution: `session_resolve_relative_media`, `attachments.ts`, `sessionPathMap.ts`, `pathNormalize.ts`
- Allowlist: `path_scope.rs`
