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
- **Range**: 206 + max 2 MiB chunk (video/audio/PDF).
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

## Related

- Path resolution: `session_resolve_relative_media`, `attachments.ts`, `sessionPathMap.ts`
- Allowlist: `path_scope.rs`
