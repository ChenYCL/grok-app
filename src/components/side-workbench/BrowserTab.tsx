/**
 * Multi-instance browser tab — embedded Tauri Webview only.
 * URL chrome only (no engine status row). Automation uses webview label
 * `resource-browser-<tabId>` via host `side_browser_*` commands.
 */

import { useMemo, useState } from "react";
import { createT, type Locale } from "@/i18n";
import {
  EmbeddedBrowser,
  sideBrowserWebviewLabel,
} from "@/components/EmbeddedBrowser";
import { IconExternalLink, IconRefresh } from "@/components/icons";
import { Tip } from "@/components/ui/tooltip";
import * as api from "@/lib/api";

export type BrowserTabProps = {
  locale: Locale | string;
  tabId: string;
  url?: string;
  title?: string;
  active?: boolean;
  onUrlChange?: (url: string) => void;
};

export function BrowserTab({
  locale,
  tabId,
  url: initialUrl,
  title,
  active = true,
}: BrowserTabProps) {
  const tr = useMemo(() => createT(locale as Locale), [locale]);
  const [url, setUrl] = useState(
    () => (initialUrl || "").trim() || "https://www.google.com",
  );
  const [draft, setDraft] = useState(url);
  const webviewLabel = sideBrowserWebviewLabel(tabId);

  const go = () => {
    const next = draft.trim() || "https://www.google.com";
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(next)
      ? next
      : `https://${next}`;
    setUrl(withScheme);
    setDraft(withScheme);
  };

  return (
    <div
      className="sw-browser embedded-browser"
      data-testid="side-browser-tab"
      data-tab-id={tabId}
      data-webview-label={webviewLabel}
      data-browser-engine="system"
    >
      <div className="embedded-browser__bar">
        <div className="rp-tree-search sw-browser__url-wrap">
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
            }}
            aria-label={tr("side.browser.urlAria")}
            data-testid="side-browser-url"
          />
        </div>
        <Tip label={tr("resources.browserReload")}>
          <button
            type="button"
            className="chrome-btn"
            onClick={go}
            aria-label={tr("resources.browserReload")}
          >
            <IconRefresh size={14} />
          </button>
        </Tip>
        <Tip label={tr("resources.openExternal")}>
          <button
            type="button"
            className="chrome-btn"
            onClick={() => {
              void api
                .openExternalUrl(url)
                .catch(() =>
                  window.open(url, "_blank", "noopener,noreferrer"),
                );
            }}
            aria-label={tr("resources.openExternal")}
          >
            <IconExternalLink size={14} />
          </button>
        </Tip>
      </div>
      <div className="embedded-browser__host sw-browser__host">
        <EmbeddedBrowser
          url={url}
          title={title}
          locale={locale as Locale}
          active={active}
          instanceId={tabId}
          className="sw-browser__embed"
        />
      </div>
    </div>
  );
}
