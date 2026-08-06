import { describe, expect, it, beforeEach } from "vitest";
import {
  flushImageAspectCache,
  getImageAspect,
  imageAspectCacheKey,
  resetImageAspectCacheForTests,
  setImageAspect,
  type ImageAspectStorage,
} from "./imageAspectCache";

function memStorage(): ImageAspectStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

beforeEach(() => {
  resetImageAspectCacheForTests();
});

describe("imageAspectCacheKey", () => {
  it("prefers absolute path over media URL", () => {
    const path = "/Users/me/out/shot.png";
    const url =
      "http://127.0.0.1:54321/v1/media?t=abc&p=" +
      encodeURIComponent(path);
    expect(imageAspectCacheKey(url, path)).toBe(path);
  });

  it("extracts path from loopback media query", () => {
    const path = "/Users/me/a.jpg";
    const url =
      "http://127.0.0.1:9/v1/media?t=tok&p=" + encodeURIComponent(path);
    expect(imageAspectCacheKey(url)).toBe(path);
  });

  it("normalizes windows backslashes", () => {
    expect(imageAspectCacheKey("C:\\Users\\x\\a.png")).toBe(
      "C:/Users/x/a.png",
    );
  });
});

describe("get/setImageAspect", () => {
  it("returns null when empty", () => {
    const s = memStorage();
    expect(getImageAspect("/nope.png", undefined, s)).toBeNull();
  });

  it("stores and reads by path; media URL hits same entry", () => {
    const s = memStorage();
    const path = "/Users/me/img.png";
    setImageAspect(path, path, 1.5, [], s);
    flushImageAspectCache(s);
    expect(getImageAspect(path, path, s)).toBeCloseTo(1.5);
    const url =
      "http://127.0.0.1:1/v1/media?t=x&p=" + encodeURIComponent(path);
    expect(getImageAspect(url, undefined, s)).toBeCloseTo(1.5);
  });

  it("survives rehydrate from storage", () => {
    const s = memStorage();
    const path = "/tmp/x.webp";
    setImageAspect(path, path, 0.75, [], s);
    flushImageAspectCache(s);
    resetImageAspectCacheForTests();
    expect(getImageAspect(path, path, s)).toBeCloseTo(0.75);
  });

  it("ignores invalid ratios", () => {
    const s = memStorage();
    setImageAspect("/a.png", "/a.png", 0, [], s);
    setImageAspect("/a.png", "/a.png", NaN, [], s);
    expect(getImageAspect("/a.png", "/a.png", s)).toBeNull();
  });
});
