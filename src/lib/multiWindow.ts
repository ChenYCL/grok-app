/**
 * Multi-window session helpers (desktop Tauri).
 *
 * Minimal product: open a chat in a second webview window via deep link
 * `#/session/<id>`. Secondary windows **participate live** — send / stop /
 * ensureConnected go through the shared process Host (session-targeted).
 *
 * They still skip *passive* warm-connect on open/browse so merely popping a
 * second pane does not demote the main window’s agent until the user acts.
 *
 * Window labels: `main` (primary) · `session-<uuid>` (secondary).
 */

/** Primary workbench window label (matches tauri.conf.json). */
export const MAIN_WINDOW_LABEL = "main";

/** Secondary session window labels are `session-<sessionId>`. */
export const SESSION_WINDOW_LABEL_PREFIX = "session-";

/** Hash route for a focused session (`#/session/<id>`). */
export const SESSION_DEEP_LINK_PREFIX = "session/";

/** True when a Tauri window label is the primary workbench. */
export function isMainWindowLabel(label: string | null | undefined): boolean {
  return (label ?? "").trim() === MAIN_WINDOW_LABEL;
}

/**
 * Sanitize a session id for use in a Tauri window label.
 * Only ASCII alphanumeric, hyphen, underscore (UUID-safe).
 */
export function sanitizeSessionIdForLabel(
  sessionId: string | null | undefined,
): string | null {
  const id = (sessionId ?? "").trim();
  if (!id) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

/** Build `session-<id>` window label, or null if id is invalid. */
export function sessionWindowLabel(
  sessionId: string | null | undefined,
): string | null {
  const id = sanitizeSessionIdForLabel(sessionId);
  if (!id) return null;
  return `${SESSION_WINDOW_LABEL_PREFIX}${id}`;
}

/** Parse session id from a `session-<id>` window label. */
export function parseSessionWindowLabel(
  label: string | null | undefined,
): string | null {
  const raw = (label ?? "").trim();
  if (!raw.startsWith(SESSION_WINDOW_LABEL_PREFIX)) return null;
  const id = raw.slice(SESSION_WINDOW_LABEL_PREFIX.length);
  return sanitizeSessionIdForLabel(id);
}

/** True when the window is a secondary session window. */
export function isSessionWindowLabel(label: string | null | undefined): boolean {
  return parseSessionWindowLabel(label) != null;
}

/**
 * Build hash for deep-link open (`#/session/<id>`).
 * Returns empty string when id is invalid.
 */
export function buildSessionDeepLinkHash(
  sessionId: string | null | undefined,
): string {
  const id = sanitizeSessionIdForLabel(sessionId);
  if (!id) return "";
  return `#/${SESSION_DEEP_LINK_PREFIX}${id}`;
}

/**
 * Parse `#/session/<id>` (with or without leading `#` / `/`).
 * Also accepts bare `session/<id>`.
 */
export function parseSessionDeepLinkHash(
  hash: string | null | undefined,
): string | null {
  if (hash == null) return null;
  const raw = String(hash)
    .replace(/^#\/?/, "")
    .replace(/^\//, "")
    .trim();
  if (!raw.startsWith(SESSION_DEEP_LINK_PREFIX)) return null;
  const rest = raw.slice(SESSION_DEEP_LINK_PREFIX.length);
  // Ignore trailing query-like junk; take first path segment only.
  const id = rest.split(/[/?#]/)[0] ?? "";
  return sanitizeSessionIdForLabel(id);
}

/**
 * Resolve the session this secondary window should focus.
 * Prefer explicit hash deep link; fall back to window label.
 */
export function resolveSecondarySessionId(opts: {
  hash?: string | null;
  windowLabel?: string | null;
}): string | null {
  return (
    parseSessionDeepLinkHash(opts.hash) ??
    parseSessionWindowLabel(opts.windowLabel)
  );
}

/**
 * Whether "Open session in new window" should be offered.
 * Desktop Tauri only; not from a secondary window; valid session id required.
 */
export function canOpenSessionInNewWindow(opts: {
  isDesktopHost: boolean;
  isSecondaryWindow: boolean;
  sessionId: string | null | undefined;
}): boolean {
  if (!opts.isDesktopHost) return false;
  if (opts.isSecondaryWindow) return false;
  return sanitizeSessionIdForLabel(opts.sessionId) != null;
}

/**
 * Skip *passive* warm-connect when opening/browsing a session.
 * Secondary windows stay passive until the user sends (then ensureConnected runs).
 * Host has one live focus slot; auto-connect on open would demote main’s agent.
 */
export function shouldSkipWarmConnect(isSecondaryWindow: boolean): boolean {
  return isSecondaryWindow;
}

/**
 * Whether this window may send / stop / ensureConnected for its focused session.
 * Secondary webviews share the process Host — live participation is allowed
 * (session-targeted invoke). Policy locked here so UI gates stay honest.
 */
export function canLiveParticipate(isSecondaryWindow: boolean): boolean {
  // Secondary is not view-only for send/stop. Argument kept for call-site clarity
  // and future policy tweaks (e.g. mirror/browser).
  void isSecondaryWindow;
  return true;
}

/**
 * @deprecated Prefer `shouldSkipWarmConnect` for browse and `canLiveParticipate`
 * for send/stop. Kept as warm-connect alias so older call sites stay safe.
 */
export function shouldSkipAgentSpawn(isSecondaryWindow: boolean): boolean {
  return shouldSkipWarmConnect(isSecondaryWindow);
}
