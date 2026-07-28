import { describe, expect, it } from "vitest";
import {
  dedupeGalleryItems,
  errorCodeFromSearchResult,
  parseWallpaperSourceError,
  resolveApplySource,
  type WallpaperGalleryItem,
} from "./wallpaperSource";

function item(
  partial: Partial<WallpaperGalleryItem> & Pick<WallpaperGalleryItem, "id" | "fullUrl">,
): WallpaperGalleryItem {
  return {
    thumbUrl: partial.thumbUrl ?? partial.fullUrl,
    kind: partial.kind ?? "image",
    source: partial.source ?? "x",
    ...partial,
  };
}

describe("wallpaperSource", () => {
  it("parses host error codes", () => {
    expect(parseWallpaperSourceError("auth_required")).toBe("auth_required");
    expect(parseWallpaperSourceError(new Error("download_failed: HTTP 403"))).toBe(
      "download_failed",
    );
    expect(parseWallpaperSourceError("url_blocked")).toBe("url_blocked");
    expect(parseWallpaperSourceError("something else")).toBe("generic");
  });

  it("maps empty search results", () => {
    expect(
      errorCodeFromSearchResult({ items: [], errorCode: "auth_required" }),
    ).toBe("auth_required");
    expect(errorCodeFromSearchResult({ items: [], errorCode: null })).toBe("empty");
    expect(
      errorCodeFromSearchResult({
        items: [item({ id: "1", fullUrl: "https://pbs.twimg.com/a.jpg" })],
        errorCode: "empty",
      }),
    ).toBeNull();
  });

  it("dedupes by url / path", () => {
    const items = dedupeGalleryItems([
      item({ id: "1", fullUrl: "https://a/x.jpg" }),
      item({ id: "2", fullUrl: "https://a/x.jpg" }),
      item({ id: "3", fullUrl: "https://a/y.jpg", localPath: "/tmp/y.jpg" }),
      item({ id: "4", fullUrl: "file:///tmp/y.jpg", localPath: "/tmp/y.jpg" }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("resolves apply source", () => {
    expect(
      resolveApplySource(
        item({ id: "1", fullUrl: "https://a/x.jpg", localPath: "/w/a.jpg" }),
      ),
    ).toEqual({ kind: "path", path: "/w/a.jpg" });
    expect(
      resolveApplySource(item({ id: "2", fullUrl: "file:///Users/me/a.jpg" })),
    ).toEqual({ kind: "path", path: "/Users/me/a.jpg" });
    expect(
      resolveApplySource(item({ id: "3", fullUrl: "https://pbs.twimg.com/a.jpg" })),
    ).toEqual({ kind: "url", url: "https://pbs.twimg.com/a.jpg" });
  });
});
